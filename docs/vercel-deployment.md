# Vercel deployment

## Runtime and source

Vercel hosts the Next.js workspace at `apps/web-dashboard`. The Vercel project is `smart-solar-monitor` in `shakils-projects-439f6ed3`. Root-directory access to the rest of the repository is enabled so npm can install the workspace lockfile.

- Node.js: 24.x.
- Framework: Next.js.
- Install: `cd ../.. && npm ci`.
- Build: `npm run build` from the web workspace.
- Function region: Singapore (`sin1`), near the private Blob store.
- Configuration: `apps/web-dashboard/vercel.json`.

The initial deployment uploads reviewed source files through the Vercel connector. Git linking was unavailable because the Vercel Git integration could not access the repository. Pushing a Git commit does not automatically deploy this project until that integration is connected. A linked, authenticated Vercel CLI can also deploy from the web workspace.

## Environment

| Variable                | Purpose                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| `SOLAR_BACKEND=cloud`   | Select the serverless API and disable the localhost ASP.NET rewrites         |
| `SOLAR_SESSION_SECRET`  | Random secret of at least 32 characters for signed session cookies           |
| `BLOB_READ_WRITE_TOKEN` | Private storage credential provisioned by the project's connected Blob store |

Set variables for each environment before building. Keep secrets in Vercel environment settings. Do not expose them with a `NEXT_PUBLIC_` prefix. Cloud mode fails closed if session or storage configuration is unavailable. Omitting `SOLAR_BACKEND=cloud` keeps the original ASP.NET proxy behavior.

## Persistence and behavior

Vercel functions are stateless. Cloud mode runs no background daemon and writes no local database. Its deterministic simulator reconstructs history on request, using a persisted per-visitor scenario timeline. The latest sample uses five-second time slots. Offline timelines freeze the sample timestamp; clients mark values stale after 15 seconds and stop flow animation immediately on disconnection.

Each visitor receives an HTTP-only, SameSite Strict, signed cookie with an eight-hour expiry. HTTPS cookies are Secure. A random 192-bit identifier selects a private Blob record containing the scenario timeline, acknowledgment state, expiry and bounded audit history. All state reads bypass the Blob cache. Updates use the Blob ETag as a conditional-write precondition; conflicting tab writes return 409 rather than silently overwriting state. Logout deletes the record; Blob TTL removes abandoned records after one day.

History uses reconstructed one-minute samples, aggregated into five-minute or hourly buckets. Offline buckets contain nulls. Daily energy uses trapezoidal integration and excludes offline intervals. CSV exports provide five-minute reconstructed samples with the source `RECONSTRUCTED_SIMULATION`. These are synthetic evaluation results, not retained device readings, measured tariffs or validated equipment forecasts.

Cloud sessions are isolated between visitors. Local ASP.NET demo sessions continue to share the database's site scenarios and alert history. The browser discovers its runtime from the authenticated session response and uses either cloud polling or SignalR with polling fallback.

## Verification

```sh
npm ci
npm run test:cloud
npm run typecheck
SOLAR_BACKEND=cloud npm run build
PLAYWRIGHT_BASE_URL=https://your-deployment.vercel.app npm run test:e2e
```

The remote test flag prevents Playwright from starting local servers. For protected deployments, use authorized short-lived access and provide a storage-state file through `SOLAR_TEST_STORAGE_STATE`; never commit that file. `SOLAR_TEST_PROXY` is available for managed testing environments requiring an outbound HTTPS inspection proxy. It applies only to test clients, not the deployed application.

Browser tests cover the complete operator journey, the filtered battery metric, stale/offline/recovery behavior, CSV, mobile layout, and keyboard navigation. A cloud-specific test checks separate visitor state, unauthorized requests, signed-cookie tampering, cross-site writes and cross-session alert access. Pure model tests check all-day power balance, frozen timestamps, offline energy/history, recovery and rapid scenario changes. The original ASP.NET tests continue to run independently.

Inspect build logs and runtime error logs after each release. `/api/health` is process liveness, not a database readiness or freshness assertion. The public production domain is `https://smart-solar-monitor-ashy.vercel.app`. Preview/deployment URL authentication remains enabled; temporary test share links are revoked after verification.
