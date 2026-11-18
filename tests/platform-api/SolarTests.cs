using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using System.Security.Claims;
using System.Text.Encodings.Web;
using Solar;
using Xunit;

public class SolarTests
{
    [Fact]
    public void FiveSecondsAt180KwIsQuarterKwh()
    {
        var now = DateTime.UtcNow;
        Frame[] samples = [new() { MeasuredAt = now, Solar = 180 }, new() { MeasuredAt = now.AddSeconds(5), Solar = 180 }];
        Assert.Equal(.25, Energy.Integrate(samples, f => f.Solar));
    }
    [Fact]
    public void EnergyExcludesMissingIntervalsAndBadQuality()
    {
        var now = DateTime.UtcNow;
        Frame[] samples = [new() { MeasuredAt = now, Solar = 180 }, new() { MeasuredAt = now.AddHours(1), Solar = 180 }];
        Assert.Equal(0, Energy.Integrate(samples, f => f.Solar));
        samples[1].MeasuredAt = now.AddSeconds(5); samples[1].Quality = "BAD";
        Assert.Equal(0, Energy.Integrate(samples, f => f.Solar));
    }
    [Theory]
    [InlineData("sunny")]
    [InlineData("cloudy")]
    [InlineData("night")]
    [InlineData("battery-hot")]
    public void SimulatorIsDeterministicAndBalancesAllDay(string scenario)
    {
        for (var i = 0; i < 288; i++)
        {
            var at = new DateTime(2026, 11, 18, 0, 0, 0, DateTimeKind.Utc).AddMinutes(5 * i);
            var frame = Simulator.Sample(Registry.Sites[0], at, scenario);
            Assert.Null(Ingestion.Validate(frame, at));
            Assert.Equal(frame.Solar, Simulator.Sample(Registry.Sites[0], at, scenario).Solar);
            Assert.InRange(Math.Abs(frame.Solar + frame.Battery + frame.Grid - frame.Load), 0, .11);
        }
    }
    [Fact]
    public void HistoryMarksGapsWithNullInsteadOfInventingZeroes()
    {
        var at = new DateTime(2026, 11, 18, 0, 0, 0, DateTimeKind.Utc);
        Frame[] samples = [Simulator.Sample(Registry.Sites[0], at), Simulator.Sample(Registry.Sites[0], at.AddMinutes(10))];
        var points = Energy.Aggregate(samples, 5).ToArray();
        Assert.Equal(3, points.Length);
        Assert.Null(points[1].Solar);
        Assert.Equal(0, points[1].Samples);
    }
    [Fact]
    public async Task DuplicateDelayedAndInvalidSamplesAreHandled()
    {
        await using var db = new SolarDb(new DbContextOptionsBuilder<SolarDb>().UseSqlite("Data Source=:memory:").Options);
        await db.Database.OpenConnectionAsync(); await db.Database.EnsureCreatedAsync();
        var ingestion = new Ingestion(db); var now = DateTime.UtcNow;
        var frame = Simulator.Sample(Registry.Sites[0], now);
        Assert.Equal("accepted", await ingestion.Accept(frame, now));
        Assert.Equal("duplicate", await ingestion.Accept(Simulator.Sample(Registry.Sites[0], now), now));
        Assert.Equal("accepted", await ingestion.Accept(Simulator.Sample(Registry.Sites[0], now.AddMinutes(-10)), now));
        Assert.Equal(now, (await db.Frames.OrderByDescending(x => x.MeasuredAt).FirstAsync()).MeasuredAt);
        var invalid = Simulator.Sample(Registry.Sites[0], now.AddSeconds(1)); invalid.Soc = 101;
        Assert.Equal("quarantined", await ingestion.Accept(invalid, now));
        Assert.Equal(2, await db.Frames.CountAsync()); Assert.Equal(1, await db.Quarantine.CountAsync());
    }
    [Fact]
    public void InvalidUnitsTimeAndBalanceCannotReachLiveState()
    {
        var now = DateTime.UtcNow;
        var f = Simulator.Sample(Registry.Sites[0], now);
        f.Solar = double.NaN; Assert.NotNull(Ingestion.Validate(f, now));
        f = Simulator.Sample(Registry.Sites[0], now.AddHours(1)); Assert.NotNull(Ingestion.Validate(f, now));
        f = Simulator.Sample(Registry.Sites[0], now); f.Grid += 100; Assert.NotNull(Ingestion.Validate(f, now));
        f = Simulator.Sample(Registry.Sites[0], now); f.Source = "physical-device"; Assert.NotNull(Ingestion.Validate(f, now));
    }
}

public class ApiTests : IClassFixture<SolarFactory>
{
    private readonly SolarFactory factory;
    public ApiTests(SolarFactory factory) { this.factory = factory; }
    [Theory]
    [InlineData("demo-tenant", "campus-02")]
    [InlineData("other-tenant", "factory-01")]
    public async Task RejectsKnownSitesOutsideUserSiteOrTenantScope(string tenant, string requestedSite)
    {
        using var scoped = factory.WithWebHostBuilder(b => b.ConfigureTestServices(services => services.AddAuthentication(o =>
        {
            o.DefaultAuthenticateScheme = "ScopedTest"; o.DefaultChallengeScheme = "ScopedTest";
        }).AddScheme<ScopeOptions, ScopedHandler>("ScopedTest", o => o.Tenant = tenant)));
        using var client = scoped.CreateClient();
        foreach (var path in new[] { "overview", "live", "energy-flow", "devices", "telemetry" })
            Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync($"/api/v1/sites/{requestedSite}/{path}")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync($"/api/v1/alerts?siteId={requestedSite}")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync($"/api/v1/reports/energy?siteId={requestedSite}")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync($"/api/v1/sites/{requestedSite}/simulation", new { scenario = "night" })).StatusCode);
    }
    [Fact]
    public async Task RequiresSessionAndRejectsUnknownSiteAndCommands()
    {
        using var client = factory.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/v1/sites")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync("/api/auth/demo", null)).StatusCode);
        var sites = await client.GetFromJsonAsync<JsonElement>("/api/v1/sites"); Assert.Equal(2, sites.GetArrayLength());
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/v1/sites/other-tenant-site/overview")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/v1/commands", new { })).StatusCode);
        var overview = await client.GetFromJsonAsync<JsonElement>("/api/v1/sites/factory-01/overview");
        Assert.False(overview.GetProperty("controlEnabled").GetBoolean());
        Assert.EndsWith("Z", overview.GetProperty("live").GetProperty("measuredAt").GetString());
        var telemetry = await client.GetFromJsonAsync<JsonElement>("/api/v1/sites/factory-01/telemetry?range=24h");
        Assert.InRange(telemetry.GetProperty("points").GetArrayLength(), 280, 300);
        Assert.EndsWith("Z", telemetry.GetProperty("points")[0].GetProperty("measuredAt").GetString());
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync("/api/v1/sites/factory-01/telemetry?range=100y")).StatusCode);
        Assert.Contains("SIMULATED,factory-01", await client.GetStringAsync("/api/v1/reports/energy?siteId=factory-01"));
        await client.PostAsync("/api/auth/logout", null);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/v1/sites")).StatusCode);
    }
    [Fact]
    public async Task SimulationValidatesInputsAndPersistsSiteScopedScenario()
    {
        using var client = factory.CreateClient(); await client.PostAsync("/api/auth/demo", null);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/v1/sites/factory-01/simulation", new { scenario = "unsafe" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/v1/sites/unknown/simulation", new { scenario = "night" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/v1/sites/factory-01/simulation", new { scenario = "night" })).StatusCode);
        var overview = await client.GetFromJsonAsync<JsonElement>("/api/v1/sites/factory-01/overview");
        Assert.Equal("night", overview.GetProperty("scenario").GetString());
        var other = await client.GetFromJsonAsync<JsonElement>("/api/v1/sites/campus-02/overview");
        Assert.Equal("sunny", other.GetProperty("scenario").GetString());
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/auth/demo"); request.Headers.Add("Sec-Fetch-Site", "cross-site");
        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(request)).StatusCode);
    }
}
public class ScopeOptions : AuthenticationSchemeOptions { public string Tenant { get; set; } = ""; }
public class ScopedHandler(IOptionsMonitor<ScopeOptions> options, ILoggerFactory logger, UrlEncoder encoder) : AuthenticationHandler<ScopeOptions>(options, logger, encoder)
{
    protected override Task<AuthenticateResult> HandleAuthenticateAsync() => Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("tenant", Options.Tenant), new Claim("site", "factory-01"), new Claim(ClaimTypes.Name, "Scoped test viewer") }, Scheme.Name)), Scheme.Name)));
}
public class SolarFactory : WebApplicationFactory<Program>
{
    private readonly string dbPath = Path.Combine(Path.GetTempPath(), $"solar-tests-{Guid.NewGuid()}.db");
    protected override void ConfigureWebHost(IWebHostBuilder builder) => builder.UseEnvironment("Development").ConfigureAppConfiguration((_, c) => c.AddInMemoryCollection(new Dictionary<string, string?> { ["ConnectionStrings:Sqlite"] = $"Data Source={dbPath}", ["DisableSimulator"] = "true" }));
    protected override void Dispose(bool disposing) { base.Dispose(disposing); if (File.Exists(dbPath)) File.Delete(dbPath); }
}
