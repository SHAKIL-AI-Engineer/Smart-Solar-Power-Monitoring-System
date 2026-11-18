# Read-only MVP architecture

The sections below describe the ASP.NET container/local runtime. The Vercel cloud demo uses a stateless Next.js API and isolated private Blob state; see [cloud deployment architecture](vercel-deployment.md). Its historical values are reconstructed simulation rather than accepted MQTT telemetry.

## High-level design

The supplied enterprise design is implemented as its first read-only simulator deliverable. Two application processes run a Next.js dashboard and an ASP.NET Core modular API. A database persists accepted telemetry, simulator configuration, alerts, quarantine decisions, audit events, and an optional MQTT outbox.

| Boundary              | Implementation                                                            |
| --------------------- | ------------------------------------------------------------------------- |
| Browser → application | Same-origin proxy for REST and SignalR; HTTP-only cookie                  |
| Identity → site       | Cookie authentication; tenant and allowed-site claims checked server-side |
| Simulator → ingestion | Direct delivery by default; optional MQTT 5/QoS 1                         |
| Ingestion → storage   | Validation and deduplication before a committed EF write                  |
| Storage → browser     | Latest accepted timestamp, aggregate history, alerts, and energy summary  |
| Live notification     | Authorized SignalR groups; clients re-fetch authoritative API data        |
| Connectivity loss     | Polling fallback, timestamp-based stale state, MQTT outbox replay         |

The simulator is the only source. It uses deterministic site-scaled curves and a five-second acquisition cycle. Seed data is synthetic history. Site/device metadata lives in the typed `Registry`; scenarios live in the database. SQL Server and SQLite share an EF model. This is a single-API-instance design.

## Low-level processing

1. Calculate a site frame at a UTC timestamp. Solar and demand follow local-time profiles. Grid power reconciles the power balance. SOC is an independent illustrative waveform.
2. In direct mode, validate and commit. In MQTT mode, first commit JSON to the outbox, then publish to `solar/demo-tenant/{siteId}/frame` at QoS 1.
3. The subscriber validates topic/site agreement and the frame. Invalid messages produce a persisted quarantine reason. Subscriber acknowledgment follows a durable accepted, duplicate, or quarantine decision.
4. Accepted frames contain measurement/receipt timestamps, a stable event ID, source and quality. Event identity is unique within a site. Delayed frames enter history; latest state is ordered by measurement time.
5. The worker evaluates offline and temperature conditions. Faults create alerts, repeated observations update last-seen time, and recovery resolves them. Acknowledgment is separate and auditable.
6. Notify the site's SignalR group. Ten-second polling covers notification loss.

Validation checks known site, stable identity, simulator source, GOOD quality, UTC/future timestamps, finite values, SOC/temperature ranges, nonnegative solar/load and power balance. Vendor decoding, calibration and per-signal unit conversion need physical equipment contracts before integration.

Accepted frames retain seven days. Responses aggregate to five minutes for up to 24 hours and one hour for seven days, at most about 289 buckets. Missing buckets contain nulls. Energy integration excludes intervals over six minutes. Daily calculations begin at site-local midnight.

## Persistence and relationships

| Entity           | Key / association                               | Information                                                 |
| ---------------- | ----------------------------------------------- | ----------------------------------------------------------- |
| Registry site    | Typed ID, tenant-scoped                         | Location, timezone, capacity                                |
| Registry device  | Typed ID → site                                 | Type, simulated protocol, serial                            |
| Frame            | ID; unique `(SiteId, EventId)`; site/time index | Power, SOC, temperature, timestamps, source, quality        |
| SimulationState  | Site ID                                         | Scenario                                                    |
| Alert            | ID → site/device                                | Rule, severity, first/last seen, resolution, acknowledgment |
| AuditEvent       | ID → site                                       | Actor, action, UTC time                                     |
| QuarantinedFrame | ID                                              | Site/event identity, reason, receipt time                   |
| OutboxMessage    | ID                                              | Topic, JSON frame, enqueue time                             |

Registry associations are application-enforced because metadata is code-defined. Transactional tenant/site/device/signal tables with foreign keys belong to the production migration. This is a smaller implementation than the full enterprise ERD.

## API contracts

All `/api/v1` routes require a session. Site routes check tenant and site claims; hub subscriptions check site claims. Unknown/inaccessible sites return 403. Invalid requests use standard problem responses.

| Method | Route                                    | Result                                                    |
| ------ | ---------------------------------------- | --------------------------------------------------------- |
| POST   | `/api/auth/demo`                         | Eight-hour fixed demo viewer session                      |
| GET    | `/api/auth/me`                           | Authenticated identity                                    |
| POST   | `/api/auth/logout`                       | Clear session                                             |
| GET    | `/api/v1/sites`                          | Accessible sites                                          |
| GET    | `/api/v1/sites/{id}/overview`            | Latest frame, local-day energy, devices, alerts, scenario |
| GET    | `/api/v1/sites/{id}/live`                | Values and freshness                                      |
| GET    | `/api/v1/sites/{id}/energy-flow`         | Latest signed power values                                |
| GET    | `/api/v1/sites/{id}/devices`             | Equipment registry                                        |
| GET    | `/api/v1/sites/{id}/telemetry?range=24h` | History; ranges `1h`, `6h`, `24h`, `7d`                   |
| POST   | `/api/v1/sites/{id}/simulation`          | `{ "scenario": "sunny" }`; synthetic conditions only      |
| GET    | `/api/v1/alerts?siteId=...`              | Latest 100 events                                         |
| POST   | `/api/v1/alerts/{id}/acknowledge`        | Idempotent review marker and audit                        |
| GET    | `/api/v1/reports/energy?siteId=...`      | CSV of the preceding 24 hours                             |
| POST   | `/api/v1/commands`                       | 403; control disabled                                     |
| GET    | `/health`                                | Process liveness and simulation/control mode              |

`/hubs/telemetry` exposes authenticated `Subscribe(siteId)`. Each connection joins one allowed site. A `telemetry` event invalidates client data; clients retrieve API snapshots.

## Fault behavior

- Gateway disconnected: stop new samples; raise an offline alert. After 15 seconds, readings are stale and motion stops. Last source timestamp stays visible.
- Hot battery: report 48°C and zero battery power; raise a warning. Connectivity/quality remain distinct from equipment alarms.
- Cloudy/night: reduce PV or set it to zero and reconcile the modeled balance.
- Broker down: keep committing to the outbox. Reconnect and replay in order. Deduplication protects repeated delivery. At 250,000 queued entries, refuse new samples and log the capacity error.
- Database failure: log the error, retain last accepted readings and withhold subscriber acknowledgment. Broker durability depends on its volume/configuration; arbitrary power-loss durability is not asserted.
- API unavailable: display the error and label previous values stale; allow retry/sign-in.

`/health` is liveness, not proof of data freshness or database readiness. Check timestamps and logs. No production latency or availability benchmark is claimed.

## Security and operating boundary

The fixed demo viewer can inspect both synthetic sites, change simulator scenarios and acknowledge demo alerts. Demo login exists in Development or when `ALLOW_DEMO_LOGIN=true`; otherwise it returns 404. Cookies are HTTP-only and SameSite Strict. Cross-site browser writes are rejected. No physical devices or credentials are connected.

The MQTT overlay allows anonymous access on its private compose network for development. Production needs broker authentication, TLS/mTLS, ACLs and distinct gateway identities. Do not publish its port to an untrusted network.

Docker persists data and Data Protection keys. `EnsureCreated` creates a fresh schema; it does not upgrade an existing database. Add versioned migrations, backup/restore procedures and representative load tests before production deployment. SQLite is the evaluation default.

Real user access needs OIDC/MFA and tenant/site administration. Real equipment needs validated adapters, edge buffering, OT network boundaries, synchronized clocks and commissioning. Physical protection continues independently at the edge/BMS/inverter.
