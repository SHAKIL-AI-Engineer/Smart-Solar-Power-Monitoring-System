using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using MQTTnet;
using MQTTnet.Formatter;
using MQTTnet.Protocol;

namespace Solar;

public interface IFrameTransport { Task Send(Frame frame, CancellationToken ct); }
public class DirectTransport(IServiceScopeFactory scopes) : IFrameTransport
{
    public async Task Send(Frame frame, CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        await scope.ServiceProvider.GetRequiredService<Ingestion>().Accept(frame, DateTime.UtcNow);
    }
}

// Optional development MQTT path. No broker ports or credentials are exposed to browsers.
public class MqttTransport(IServiceScopeFactory scopes, IConfiguration config, IHubContext<SolarHub> hub, ILogger<MqttTransport> logger) : BackgroundService, IFrameTransport
{
    public async Task Send(Frame frame, CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<SolarDb>();
        if (await db.Outbox.CountAsync(ct) >= 250000) throw new InvalidOperationException("Simulator outbox capacity exceeded; refusing new samples until delivery recovers.");
        db.Outbox.Add(new() { Topic = $"solar/demo-tenant/{frame.SiteId}/frame", Payload = JsonSerializer.Serialize(frame), CreatedAt = DateTime.UtcNow });
        await db.SaveChangesAsync(ct);
    }
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var factory = new MqttClientFactory();
        using var client = factory.CreateMqttClient();
        client.ApplicationMessageReceivedAsync += async args =>
        {
            args.AutoAcknowledge = false;
            try
            {
                using var scope = scopes.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<SolarDb>();
                Frame? frame = null;
                try { frame = JsonSerializer.Deserialize<Frame>(args.ApplicationMessage.ConvertPayloadToString()); }
                catch (JsonException) { /* Persist a quarantine record before acknowledging poison messages. */ }
                if (frame == null || args.ApplicationMessage.Topic != $"solar/demo-tenant/{frame.SiteId}/frame")
                {
                    db.Quarantine.Add(new() { SiteId = frame?.SiteId ?? "unknown", EventId = frame?.EventId ?? "invalid-json", Reason = "Malformed MQTT payload or topic/site mismatch", ReceivedAt = DateTime.UtcNow });
                    await db.SaveChangesAsync(ct);
                }
                else
                {
                    frame.Id = 0;
                    await scope.ServiceProvider.GetRequiredService<Ingestion>().Accept(frame, DateTime.UtcNow);
                    await hub.Clients.Group(frame.SiteId).SendAsync("telemetry", new { siteId = frame.SiteId }, ct);
                }
                // Durable accepted/quarantined/duplicate decision precedes subscriber PUBACK.
                await args.AcknowledgeAsync(ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                args.ProcessingFailed = true;
                logger.LogError(ex, "MQTT persistence failed; message not acknowledged");
            }
        };
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(2));
        do
        {
            try
            {
                if (!client.IsConnected)
                {
                    var options = new MqttClientOptionsBuilder().WithTcpServer(config["MqttHost"]!, int.Parse(config["MqttPort"] ?? "1883"))
                        .WithClientId("solar-demo-ingestion").WithProtocolVersion(MqttProtocolVersion.V500).WithCleanSession(false).WithSessionExpiryInterval(86400).Build();
                    await client.ConnectAsync(options, ct);
                    await client.SubscribeAsync(factory.CreateSubscribeOptionsBuilder().WithTopicFilter(f => f.WithTopic("solar/demo-tenant/+/frame").WithQualityOfServiceLevel(MqttQualityOfServiceLevel.AtLeastOnce)).Build(), ct);
                }
                using var scope = scopes.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<SolarDb>();
                var messages = await db.Outbox.OrderBy(x => x.Id).Take(50).ToListAsync(ct);
                foreach (var message in messages)
                {
                    await client.PublishAsync(new MqttApplicationMessageBuilder().WithTopic(message.Topic).WithPayload(message.Payload).WithQualityOfServiceLevel(MqttQualityOfServiceLevel.AtLeastOnce).Build(), ct);
                    db.Outbox.Remove(message);
                    await db.SaveChangesAsync(ct);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogWarning(ex, "MQTT delivery unavailable; samples retained in database outbox"); }
        } while (await timer.WaitForNextTickAsync(ct));
    }
}
