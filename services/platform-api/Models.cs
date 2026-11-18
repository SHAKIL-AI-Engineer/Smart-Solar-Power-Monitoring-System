using Microsoft.EntityFrameworkCore;

namespace Solar;

public record Site(string Id, string Name, string Location, string TimeZone, double CapacityKw, double BatteryKwh, string TenantId);
public record Device(string Id, string SiteId, string Name, string Type, string Protocol, string Serial);
public class Frame
{
    public long Id { get; set; }
    public string SiteId { get; set; } = "";
    public string EventId { get; set; } = "";
    public DateTime MeasuredAt { get; set; }
    public DateTime ReceivedAt { get; set; }
    public double Solar { get; set; }
    public double Load { get; set; }
    public double Battery { get; set; }
    public double Grid { get; set; }
    public double Soc { get; set; }
    public double Temperature { get; set; }
    public string Quality { get; set; } = "GOOD";
    public string Source { get; set; } = "deterministic-simulator";
}
public class Alert
{
    public long Id { get; set; }
    public string SiteId { get; set; } = "";
    public string DeviceId { get; set; } = "";
    public string Rule { get; set; } = "";
    public string Severity { get; set; } = "warning";
    public string Message { get; set; } = "";
    public DateTime FirstSeen { get; set; }
    public DateTime LastSeen { get; set; }
    public DateTime? ResolvedAt { get; set; }
    public DateTime? AcknowledgedAt { get; set; }
    public string? AcknowledgedBy { get; set; }
}
public class SimulationState
{
    public string SiteId { get; set; } = "";
    public string Scenario { get; set; } = "sunny";
}
public class QuarantinedFrame
{
    public long Id { get; set; }
    public string SiteId { get; set; } = "";
    public string EventId { get; set; } = "";
    public string Reason { get; set; } = "";
    public DateTime ReceivedAt { get; set; }
}
public class AuditEvent
{
    public long Id { get; set; }
    public string Actor { get; set; } = "";
    public string Action { get; set; } = "";
    public string SiteId { get; set; } = "";
    public DateTime At { get; set; }
}
public class OutboxMessage
{
    public long Id { get; set; }
    public string Topic { get; set; } = "";
    public string Payload { get; set; } = "";
    public DateTime CreatedAt { get; set; }
}
public class SolarDb(DbContextOptions<SolarDb> options) : DbContext(options)
{
    public DbSet<Frame> Frames => Set<Frame>();
    public DbSet<Alert> Alerts => Set<Alert>();
    public DbSet<SimulationState> Simulations => Set<SimulationState>();
    public DbSet<QuarantinedFrame> Quarantine => Set<QuarantinedFrame>();
    public DbSet<AuditEvent> Audit => Set<AuditEvent>();
    public DbSet<OutboxMessage> Outbox => Set<OutboxMessage>();
    protected override void OnModelCreating(ModelBuilder b)
    {
        // Both supported databases store UTC. Restore Kind on materialization so JSON emits Z.
        foreach (var entity in b.Model.GetEntityTypes())
            foreach (var property in entity.GetProperties())
                if (property.ClrType == typeof(DateTime) || property.ClrType == typeof(DateTime?))
                    property.SetValueConverter(new Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<DateTime, DateTime>(v => v, v => DateTime.SpecifyKind(v, DateTimeKind.Utc)));
        b.Entity<Frame>().HasIndex(x => new { x.SiteId, x.EventId }).IsUnique();
        b.Entity<Frame>().HasIndex(x => new { x.SiteId, x.MeasuredAt });
        b.Entity<Frame>().Property(x => x.SiteId).HasMaxLength(64);
        b.Entity<Frame>().Property(x => x.EventId).HasMaxLength(128);
        b.Entity<SimulationState>().HasKey(x => x.SiteId);
        b.Entity<SimulationState>().Property(x => x.SiteId).HasMaxLength(64);
        b.Entity<Alert>().Property(x => x.SiteId).HasMaxLength(64);
        b.Entity<Alert>().Property(x => x.Rule).HasMaxLength(64);
        b.Entity<Alert>().HasIndex(x => new { x.SiteId, x.Rule, x.ResolvedAt });
    }
}
public static class Registry
{
    public static readonly Site[] Sites = [
        new("factory-01", "Dhaka Manufacturing", "Dhaka, Bangladesh", "Asia/Dhaka", 300, 400, "demo-tenant"),
        new("campus-02", "Chattogram Campus", "Chattogram, Bangladesh", "Asia/Dhaka", 180, 240, "demo-tenant")
    ];
    public static IEnumerable<Device> Devices(string site) => new[] {
        new Device($"{site}-pv", site, "Solar inverter 01", "Inverter", "Simulated SunSpec", $"SIM-{site}-PV"),
        new Device($"{site}-bms", site, "Battery storage", "Battery / PCS", "Simulated BMS", $"SIM-{site}-BMS"),
        new Device($"{site}-grid", site, "Grid connection", "Grid meter", "Simulated Modbus", $"SIM-{site}-GRID"),
        new Device($"{site}-load", site, "Facility demand", "Load meter", "Simulated Modbus", $"SIM-{site}-LOAD")
    };
}
