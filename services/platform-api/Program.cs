using System.Globalization;
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.EntityFrameworkCore;
using Solar;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();
builder.Services.AddSignalR();
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme).AddCookie(o =>
{
    o.Cookie.Name = "solar-session";
    o.Cookie.HttpOnly = true;
    o.Cookie.SameSite = SameSiteMode.Strict;
    o.ExpireTimeSpan = TimeSpan.FromHours(8);
    o.Events.OnRedirectToLogin = c => { c.Response.StatusCode = 401; return Task.CompletedTask; };
    o.Events.OnRedirectToAccessDenied = c => { c.Response.StatusCode = 403; return Task.CompletedTask; };
});
builder.Services.AddAuthorization();
Directory.CreateDirectory("data");
builder.Services.AddDbContext<SolarDb>(o =>
{
    var sql = builder.Configuration.GetConnectionString("SqlServer");
    if (!string.IsNullOrEmpty(sql)) o.UseSqlServer(sql);
    else o.UseSqlite(builder.Configuration.GetConnectionString("Sqlite") ?? "Data Source=data/solar.db");
});
builder.Services.AddScoped<Ingestion>();
if (!string.IsNullOrWhiteSpace(builder.Configuration["MqttHost"]))
{
    builder.Services.AddSingleton<MqttTransport>();
    builder.Services.AddSingleton<IFrameTransport>(sp => sp.GetRequiredService<MqttTransport>());
    builder.Services.AddHostedService(sp => sp.GetRequiredService<MqttTransport>());
}
else builder.Services.AddSingleton<IFrameTransport, DirectTransport>();
if (builder.Configuration["DisableSimulator"] != "true") builder.Services.AddHostedService<TelemetryWorker>();
var app = builder.Build();
app.UseExceptionHandler();
app.UseAuthentication();
app.UseAuthorization();
// Reject cross-origin writes; all browser traffic goes through the same-origin Next proxy.
app.Use(async (ctx, next) =>
{
    if (ctx.Request.Method != "GET" && ctx.Request.Headers["Sec-Fetch-Site"] == "cross-site") { ctx.Response.StatusCode = 403; return; }
    await next();
});
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<SolarDb>();
    await db.Database.EnsureCreatedAsync();
    foreach (var site in Registry.Sites)
    {
        if (!await db.Simulations.AnyAsync(x => x.SiteId == site.Id)) db.Simulations.Add(new() { SiteId = site.Id });
        if (!await db.Frames.AnyAsync(x => x.SiteId == site.Id))
        {
            var now = DateTime.UtcNow;
            // Exactly spaced deterministic seed; timestamps are current, values are synthetic.
            now = new DateTime(now.Ticks - now.Ticks % TimeSpan.FromMinutes(5).Ticks, DateTimeKind.Utc);
            for (var t = now.AddHours(-24); t <= now; t = t.AddMinutes(5)) db.Frames.Add(Simulator.Sample(site, t));
        }
    }
    await db.SaveChangesAsync();
}

app.MapGet("/health", () => Results.Ok(new { status = "ok", mode = "simulation", controlEnabled = false }));
app.MapPost("/api/auth/demo", async (HttpContext ctx) =>
{
    if (!app.Environment.IsDevelopment() && app.Configuration["ALLOW_DEMO_LOGIN"] != "true") return Results.NotFound();
    var claims = new List<Claim> { new(ClaimTypes.Name, "Demo operator"), new("tenant", "demo-tenant"), new(ClaimTypes.Role, "Viewer") };
    claims.AddRange(Registry.Sites.Select(x => new Claim("site", x.Id)));
    await ctx.SignInAsync(new ClaimsPrincipal(new ClaimsIdentity(claims, CookieAuthenticationDefaults.AuthenticationScheme)));
    return Results.Ok(new { name = "Demo operator", role = "Viewer" });
});
app.MapPost("/api/auth/logout", async (HttpContext ctx) => { await ctx.SignOutAsync(); return Results.NoContent(); });
app.MapGet("/api/auth/me", (HttpContext ctx) => Results.Ok(new { name = ctx.User.Identity?.Name, role = "Viewer", mode = "simulation" })).RequireAuthorization();
var api = app.MapGroup("/api/v1").RequireAuthorization();
api.MapGet("/sites", (HttpContext ctx) => Registry.Sites.Where(s => Allowed(ctx, s.Id)));

api.MapGet("/sites/{id}/overview", async (string id, HttpContext ctx, SolarDb db) =>
{
    if (!Allowed(ctx, id)) return Denied();
    var site = Registry.Sites.First(s => s.Id == id);
    var latest = await db.Frames.Where(x => x.SiteId == id).OrderByDescending(x => x.MeasuredAt).FirstOrDefaultAsync();
    var zone = TimeZoneInfo.FindSystemTimeZoneById(site.TimeZone);
    var local = TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, zone);
    var start = TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(local.Date, DateTimeKind.Unspecified), zone);
    var today = await db.Frames.Where(x => x.SiteId == id && x.MeasuredAt >= start).OrderBy(x => x.MeasuredAt).ToListAsync();
    var solar = Energy.Integrate(today, f => f.Solar);
    var demand = Energy.Integrate(today, f => f.Load);
    var imports = Energy.Integrate(today, f => Math.Max(0, f.Grid));
    var exports = Energy.Integrate(today, f => Math.Max(0, -f.Grid));
    var importedCost = Math.Round(imports * 12, 2);
    return Results.Ok(new
    {
        site,
        live = Live(latest),
        scenario = (await db.Simulations.FindAsync(id))?.Scenario,
        energy = new { solarKwh = solar, demandKwh = demand, importKwh = imports, exportKwh = exports, importedCost, currency = "BDT", tariffPerKwh = 12, tariffSource = "Illustrative flat import tariff; no export credit or demand charges", method = "Trapezoidal integration; gaps > 6 minutes excluded", periodStart = start },
        devices = Registry.Devices(id),
        alerts = await db.Alerts.Where(x => x.SiteId == id && x.ResolvedAt == null).OrderByDescending(x => x.FirstSeen).ToListAsync(),
        mode = "simulation",
        controlEnabled = false
    });
});
api.MapGet("/sites/{id}/live", async (string id, HttpContext ctx, SolarDb db) => !Allowed(ctx, id) ? Denied() : Results.Ok(Live(await db.Frames.Where(f => f.SiteId == id).OrderByDescending(f => f.MeasuredAt).FirstOrDefaultAsync())));
api.MapGet("/sites/{id}/energy-flow", async (string id, HttpContext ctx, SolarDb db) => !Allowed(ctx, id) ? Denied() : Results.Ok(Live(await db.Frames.Where(f => f.SiteId == id).OrderByDescending(f => f.MeasuredAt).FirstOrDefaultAsync())));
api.MapGet("/sites/{id}/devices", (string id, HttpContext ctx) => !Allowed(ctx, id) ? Denied() : Results.Ok(Registry.Devices(id)));
api.MapGet("/sites/{id}/telemetry", async (string id, string? range, HttpContext ctx, SolarDb db) =>
{
    if (!Allowed(ctx, id)) return Denied();
    if (range is not (null or "1h" or "6h" or "24h" or "7d")) return Results.Problem("Choose 1h, 6h, 24h or 7d.", statusCode: 400);
    var (hours, bucketMinutes) = range switch { "1h" => (1, 5), "6h" => (6, 5), "7d" => (168, 60), _ => (24, 5) };
    var cutoff = DateTime.UtcNow.AddHours(-hours);
    var frames = await db.Frames.AsNoTracking().Where(f => f.SiteId == id && f.MeasuredAt >= cutoff).OrderBy(f => f.MeasuredAt).ToListAsync();
    var points = Energy.Aggregate(frames, bucketMinutes);
    return Results.Ok(new { unit = "kW", socUnit = "%", bucketMinutes, range = range ?? "24h", source = "deterministic-simulator", points });
});
api.MapGet("/alerts", async (string siteId, HttpContext ctx, SolarDb db) => !Allowed(ctx, siteId) ? Denied() : Results.Ok(await db.Alerts.Where(x => x.SiteId == siteId).OrderByDescending(x => x.FirstSeen).Take(100).ToListAsync()));
api.MapPost("/alerts/{alertId:long}/acknowledge", async (long alertId, HttpContext ctx, SolarDb db) =>
{
    var alert = await db.Alerts.FindAsync(alertId);
    if (alert == null) return Results.NotFound();
    if (!Allowed(ctx, alert.SiteId)) return Denied();
    if (alert.AcknowledgedAt == null)
    {
        alert.AcknowledgedAt = DateTime.UtcNow;
        alert.AcknowledgedBy = ctx.User.Identity!.Name;
        db.Audit.Add(new() { Actor = alert.AcknowledgedBy!, SiteId = alert.SiteId, At = DateTime.UtcNow, Action = $"acknowledge-alert:{alert.Id}" });
        await db.SaveChangesAsync();
    }
    return Results.Ok(alert);
});
api.MapPost("/sites/{id}/simulation", async (string id, ScenarioRequest request, HttpContext ctx, SolarDb db) =>
{
    if (!Allowed(ctx, id)) return Denied();
    if (!Simulator.Scenarios.Contains(request.Scenario)) return Results.Problem("Unknown simulation scenario.", statusCode: 400);
    var state = await db.Simulations.FindAsync(id);
    state!.Scenario = request.Scenario;
    db.Audit.Add(new() { Actor = ctx.User.Identity!.Name!, SiteId = id, At = DateTime.UtcNow, Action = $"simulation:{request.Scenario}" });
    await db.SaveChangesAsync();
    return Results.Ok(new { scenario = state.Scenario, effectiveWithinSeconds = 5, hardwareConnected = false });
});
api.MapGet("/reports/energy", async (string siteId, HttpContext ctx, SolarDb db) =>
{
    if (!Allowed(ctx, siteId)) return Denied();
    var cutoff = DateTime.UtcNow.AddHours(-24);
    var frames = await db.Frames.AsNoTracking().Where(x => x.SiteId == siteId && x.MeasuredAt >= cutoff).OrderBy(x => x.MeasuredAt).ToListAsync();
    var rows = new List<string> { "source,site_id,measured_at_utc,received_at_utc,solar_kw,load_kw,battery_kw,grid_kw,soc_percent,quality" };
    rows.AddRange(frames.Select(f => string.Join(',', new[] { "SIMULATED", f.SiteId, f.MeasuredAt.ToString("O"), f.ReceivedAt.ToString("O"), f.Solar.ToString(CultureInfo.InvariantCulture), f.Load.ToString(CultureInfo.InvariantCulture), f.Battery.ToString(CultureInfo.InvariantCulture), f.Grid.ToString(CultureInfo.InvariantCulture), f.Soc.ToString(CultureInfo.InvariantCulture), f.Quality })));
    return Results.File(System.Text.Encoding.UTF8.GetBytes(string.Join('\n', rows)), "text/csv", $"solar-{siteId}-24h.csv");
});
api.MapPost("/commands", () => Results.Problem("Equipment control is disabled in the read-only simulation MVP.", statusCode: 403));
app.MapHub<SolarHub>("/hubs/telemetry");
app.Run();

static bool Allowed(HttpContext ctx, string id) => Registry.Sites.Any(s => s.Id == id && ctx.User.HasClaim("site", id) && ctx.User.HasClaim("tenant", s.TenantId));
static IResult Denied() => Results.Problem("Site access denied.", statusCode: 403);
static object? Live(Frame? f) => f == null ? null : new
{
    f.Solar,
    f.Load,
    f.Battery,
    f.Grid,
    f.Soc,
    f.Temperature,
    measuredAt = DateTime.SpecifyKind(f.MeasuredAt, DateTimeKind.Utc),
    receivedAt = DateTime.SpecifyKind(f.ReceivedAt, DateTimeKind.Utc),
    f.Quality,
    f.Source,
    unit = "kW",
    socUnit = "%",
    temperatureUnit = "°C",
    isStale = DateTime.UtcNow - f.MeasuredAt > TimeSpan.FromSeconds(15),
    ageSeconds = Math.Max(0, (DateTime.UtcNow - f.MeasuredAt).TotalSeconds),
    balanceResidualKw = Math.Round(f.Solar + f.Battery + f.Grid - f.Load, 2)
};
public record ScenarioRequest(string Scenario);
public partial class Program { }
