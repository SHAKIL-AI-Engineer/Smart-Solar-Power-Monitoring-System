# Enterprise roadmap

| Phase                               | Status                     | Exit gate                                                                                                            |
| ----------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Read-only simulator                 | Implemented                | Dashboard → API → persisted data; fault/recovery tests                                                               |
| MQTT and SQL Server option          | Development implementation | Replay and provider startup checks; production sizing required                                                       |
| Identity and transactional registry | Planned                    | OIDC/MFA, tenant/site/device/signal tables, assignments, migrations, isolation tests                                 |
| Physical edge integration           | Planned                    | Confirmed register maps, reconciled meters, tested offline operation                                                 |
| Enterprise telemetry                | Planned                    | TimescaleDB, Redis, broker hardening, aggregation/retention, observability, backup/restore and measured load targets |
| Forecasting and optimization        | Planned                    | Forecast evaluation, baseline comparison, constraint validation and shadow mode                                      |
| Supervised operations               | Planned                    | Audited approvals, local interlocks, hardware-in-loop and site acceptance                                            |

The initial backend keeps module boundaries within one ASP.NET process. Scale ingestion, analytics and optimization independently when measured workloads justify additional deployment complexity.

RabbitMQ workflows, mobile applications, maintenance work orders, tariff administration, report jobs, Kubernetes and disaster recovery remain separate deliverables. There are no placeholder controls claiming these features work.

The supplied enterprise performance figures are targets, not benchmarks. Five-second cloud freshness at p95, sub-300 ms cached API p95 and 99.9% cloud availability require representative devices, networks, storage and concurrency testing. Protection timing remains an equipment engineering requirement independent of web performance.
