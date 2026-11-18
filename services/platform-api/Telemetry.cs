using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

namespace Solar;

public static class Simulator
{
    public static Frame Sample(Site site, DateTime utc, string scenario = "sunny")
    {
        utc = DateTime.SpecifyKind(utc, DateTimeKind.Utc);
        var local = TimeZoneInfo.ConvertTimeFromUtc(utc, TimeZoneInfo.FindSystemTimeZoneById(site.TimeZone));
        var hour = local.TimeOfDay.TotalHours;
        var scale = site.CapacityKw / 300;
        var sun = Math.Max(0, Math.Sin((hour - 6) / 12 * Math.PI));
        var cloud = scenario == "cloudy" ? .36 : 1;
        var solar = scenario == "night" ? 0 : Math.Round(270 * sun * cloud * scale, 1);
        var load = Math.Round((175 + 45 * Math.Sin((hour - 6) / 24 * Math.PI * 2) + 12 * Math.Sin(hour * 2)) * scale, 1);
        var battery = Math.Round(Math.Clamp(load - solar - 20 * scale, -45 * scale, 30 * scale), 1);
        if (scenario == "battery-hot") battery = 0;
        return new Frame
        {
            SiteId = site.Id,
            EventId = $"sim:{utc.Ticks}:{scenario}",
            MeasuredAt = utc,
            ReceivedAt = utc,
            Solar = solar,
            Load = load,
            Battery = battery,
            Grid = Math.Round(load - solar - battery, 1),
            Soc = Math.Round(65 + 13 * Math.Sin((hour - 10) / 24 * Math.PI * 2), 1),
            Temperature = scenario == "battery-hot" ? 48 : Math.Round(29 + 5 * sun, 1)
        };
    }
    public static readonly string[] Scenarios = ["sunny", "cloudy", "night", "offline", "battery-hot"];
}

public class Ingestion(SolarDb db)
{
    public async Task<string> Accept(Frame frame, DateTime now)
    {
        var reason = Validate(frame, now);
        if (reason != null)
        {
            db.Quarantine.Add(new() { SiteId = frame.SiteId, EventId = frame.EventId, ReceivedAt = now, Reason = reason });
            await db.SaveChangesAsync();
            return "quarantined";
        }
        if (await db.Frames.AnyAsync(x => x.SiteId == frame.SiteId && x.EventId == frame.EventId)) return "duplicate";
        frame.ReceivedAt = now;
        db.Frames.Add(frame);
        // Commit before publishing: SignalR is a convenience, persisted history is authoritative.
        await db.SaveChangesAsync();
        return "accepted";
    }
    public static string? Validate(Frame f, DateTime now)
    {
        if (!Registry.Sites.Any(x => x.Id == f.SiteId)) return "Unknown site";
        if (string.IsNullOrWhiteSpace(f.EventId) || f.EventId.Length > 128) return "Invalid event identity";
        if (f.Source != "deterministic-simulator") return "Unsupported source in simulation MVP";
        if (f.Quality != "GOOD") return "Bad measurement quality";
        if (f.MeasuredAt.Kind != DateTimeKind.Utc || f.MeasuredAt > now.AddSeconds(30)) return "Invalid UTC timestamp";
        if (new[] { f.Solar, f.Load, f.Battery, f.Grid, f.Soc, f.Temperature }.Any(x => !double.IsFinite(x))) return "Non-finite value";
        if (f.Solar < 0 || f.Load < 0 || f.Soc is < 0 or > 100 || f.Temperature is < -40 or > 100) return "Out-of-range value";
        if (Math.Abs(f.Solar + f.Battery + f.Grid - f.Load) > .5) return "Power balance mismatch";
        return null;
    }
}

public static class Energy
{
    public static IEnumerable<HistoryPoint> Aggregate(IReadOnlyList<Frame> frames, int minutes)
    {
        var ticks = TimeSpan.FromMinutes(minutes).Ticks;
        var groups = frames.GroupBy(f => f.MeasuredAt.Ticks / ticks).ToDictionary(g => g.Key, g => g.ToArray());
        if (groups.Count == 0) yield break;
        for (var key = groups.Keys.Min(); key <= groups.Keys.Max(); key++)
        {
            var at = new DateTime(key * ticks, DateTimeKind.Utc);
            if (!groups.TryGetValue(key, out var values)) { yield return new(at, null, null, null, null, null, 0); continue; }
            yield return new(at, Math.Round(values.Average(x => x.Solar), 1), Math.Round(values.Average(x => x.Load), 1), Math.Round(values.Average(x => x.Battery), 1), Math.Round(values.Average(x => x.Grid), 1), Math.Round(values.Average(x => x.Soc), 1), values.Length);
        }
    }
    // Trapezoidal integration; don't integrate gaps exceeding the sampling budget.
    public static double Integrate(IReadOnlyList<Frame> frames, Func<Frame, double> value, double maxGapSeconds = 360)
    {
        double total = 0;
        for (int i = 1; i < frames.Count; i++)
        {
            var dt = (frames[i].MeasuredAt - frames[i - 1].MeasuredAt).TotalSeconds;
            if (dt > 0 && dt <= maxGapSeconds && frames[i].Quality == "GOOD" && frames[i - 1].Quality == "GOOD")
                total += (value(frames[i]) + value(frames[i - 1])) / 2 * dt / 3600;
        }
        return Math.Round(total, 2);
    }
}
public record HistoryPoint(DateTime MeasuredAt, double? Solar, double? Load, double? Battery, double? Grid, double? Soc, int Samples);

public class TelemetryWorker(IServiceScopeFactory scopes, IHubContext<SolarHub> hub, IFrameTransport transport, ILogger<TelemetryWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                using var scope = scopes.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<SolarDb>();
                var now = DateTime.UtcNow;
                foreach (var site in Registry.Sites)
                {
                    var state = await db.Simulations.FindAsync([site.Id], stoppingToken);
                    var offline = state?.Scenario == "offline";
                    if (!offline) await transport.Send(Simulator.Sample(site, now, state?.Scenario ?? "sunny"), stoppingToken);
                    await UpdateAlert(db, site, "gateway-offline", offline, "critical", "Gateway disconnected. Displaying last accepted readings.", now);
                    await UpdateAlert(db, site, "battery-temperature", state?.Scenario == "battery-hot", "warning", "Battery temperature exceeds 45°C. Inspect cooling and BMS status.", now);
                    await hub.Clients.Group(site.Id).SendAsync("telemetry", new { siteId = site.Id, measuredAt = now }, stoppingToken);
                }
                var cutoff = now.AddDays(-7);
                await db.Frames.Where(x => x.MeasuredAt < cutoff).ExecuteDeleteAsync(stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogError(ex, "Telemetry cycle failed; retaining last accepted data"); }
        }
    }
    private static async Task UpdateAlert(SolarDb db, Site site, string rule, bool active, string severity, string message, DateTime now)
    {
        var alert = await db.Alerts.FirstOrDefaultAsync(x => x.SiteId == site.Id && x.Rule == rule && x.ResolvedAt == null);
        if (active && alert == null) db.Alerts.Add(new() { SiteId = site.Id, DeviceId = $"{site.Id}-{(rule == "gateway-offline" ? "grid" : "bms")}", Rule = rule, Severity = severity, Message = message, FirstSeen = now, LastSeen = now });
        else if (alert != null) { alert.LastSeen = now; if (!active) alert.ResolvedAt = now; }
        await db.SaveChangesAsync();
    }
}

[Microsoft.AspNetCore.Authorization.Authorize]
public class SolarHub : Hub
{
    public async Task Subscribe(string siteId)
    {
        if (!Registry.Sites.Any(s => s.Id == siteId && Context.User!.HasClaim("site", siteId) && Context.User.HasClaim("tenant", s.TenantId))) throw new HubException("Site access denied");
        // A connection follows one selected site, bounding server fan-out on repeated changes.
        if (Context.Items.TryGetValue("site", out var previous)) await Groups.RemoveFromGroupAsync(Context.ConnectionId, (string)previous!);
        await Groups.AddToGroupAsync(Context.ConnectionId, siteId);
        Context.Items["site"] = siteId;
    }
}
