import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { BlobPreconditionFailedError, del, get, put } from "@vercel/blob";
import { NextRequest, NextResponse } from "next/server";
import {
  alertsFor,
  changeScenario,
  devicesFor,
  energyFor,
  historyFor,
  initialState,
  liveFor,
  sample,
  scenarioAt,
  scenarios,
  sites,
  tick,
  type CloudState,
  type Scenario,
} from "./simulation";

const cookieName = "solar-cloud-session";
const sessionInfo = {
  name: "Demo operator",
  role: "Viewer",
  mode: "simulation",
  backend: "cloud",
  transport: "polling",
};
const json = (value: unknown, status = 200) =>
  NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
const problem = (detail: string, status: number) =>
  json(
    {
      type: "about:blank",
      title: status >= 500 ? "Service unavailable" : "Request rejected",
      detail,
      status,
    },
    status,
  );
function secret() {
  const value = process.env.SOLAR_SESSION_SECRET;
  if (!value || value.length < 32)
    throw new Error("Cloud session secret missing");
  return value;
}
function sign(value: string) {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}
function readSession(request: NextRequest) {
  const token = request.cookies.get(cookieName)?.value;
  if (!token) return null;
  const [id, expiry, signature, extra] = token.split(".");
  if (
    extra ||
    !/^[a-f0-9]{48}$/.test(id ?? "") ||
    !/^\d{13}$/.test(expiry ?? "") ||
    !signature ||
    Number(expiry) <= Date.now()
  )
    return null;
  const actual = Buffer.from(signature);
  const expected = Buffer.from(sign(`${id}.${expiry}`));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return null;
  return { id, path: `solar-sessions/${id}.json` };
}
async function load(path: string) {
  const result = await get(path, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200) return null;
  const state = (await new Response(result.stream).json()) as CloudState;
  if (
    state.version !== 1 ||
    !state.sites ||
    !state.audit ||
    state.expiresAt <= Date.now()
  )
    return null;
  return { state, etag: result.blob.etag };
}
async function save(path: string, state: CloudState, etag?: string) {
  await put(path, JSON.stringify(state), {
    access: "private",
    addRandomSuffix: false,
    contentType: "application/json",
    ttlDays: 1,
    ...(etag ? { ifMatch: etag } : {}),
  });
}

export async function handleCloud(request: NextRequest, path: string[]) {
  if (process.env.SOLAR_BACKEND !== "cloud")
    return problem("Cloud demo is not enabled.", 404);
  const route = path.join("/");
  const method = request.method;
  if (
    method !== "GET" &&
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return problem("Cross-site writes are not allowed.", 403);
  try {
    if (route === "health" && method === "GET")
      return json({
        status: "ok",
        mode: "cloud-simulation",
        controlEnabled: false,
      });
    if (route === "auth/demo" && method === "POST") {
      const state = initialState(Date.now());
      const id = randomBytes(24).toString("hex");
      await save(`solar-sessions/${id}.json`, state);
      const value = `${id}.${state.expiresAt}`;
      const response = json(sessionInfo);
      response.cookies.set(cookieName, `${value}.${sign(value)}`, {
        path: "/",
        httpOnly: true,
        sameSite: "strict",
        secure: request.nextUrl.protocol === "https:",
        maxAge: 28800,
      });
      return response;
    }
    const session = readSession(request);
    if (route === "auth/logout" && method === "POST") {
      if (session) {
        try {
          await del(session.path);
        } catch {
          console.error(
            "Cloud logout storage cleanup failed; TTL will expire the session record",
          );
        }
      }
      const response = new NextResponse(null, {
        status: 204,
        headers: { "Cache-Control": "no-store" },
      });
      response.cookies.set(cookieName, "", {
        path: "/",
        maxAge: 0,
        httpOnly: true,
        sameSite: "strict",
        secure: request.nextUrl.protocol === "https:",
      });
      return response;
    }
    if (!session)
      return problem("Your demo session expired. Sign in again.", 401);
    const stored = await load(session.path);
    if (!stored)
      return problem("Your demo session expired. Sign in again.", 401);
    const { state, etag } = stored;
    const now = Date.now();
    if (route === "auth/me" && method === "GET") return json(sessionInfo);
    if (route === "v1/sites" && method === "GET") return json(sites);
    if (route === "v1/commands")
      return problem(
        "Equipment control is disabled in the read-only simulation MVP.",
        403,
      );
    const siteId =
      path[1] === "sites"
        ? path[2]
        : request.nextUrl.searchParams.get("siteId");
    if (
      route.startsWith("v1/sites/") ||
      route === "v1/alerts" ||
      route === "v1/reports/energy"
    ) {
      if (!sites.some((s) => s.id === siteId))
        return problem("Site access denied.", 403);
    }
    if (
      path[0] === "v1" &&
      path[1] === "sites" &&
      path.length === 4 &&
      siteId
    ) {
      const operation = path[3];
      const range = request.nextUrl.searchParams.get("range") ?? "24h";
      if (
        (operation === "telemetry" || operation === "overview") &&
        !["1h", "6h", "24h", "7d"].includes(range)
      )
        return problem("Choose 1h, 6h, 24h or 7d.", 400);
      if (method === "GET") {
        if (["live", "energy-flow"].includes(operation))
          return json(liveFor(state, siteId, now));
        if (operation === "devices") return json(devicesFor(siteId));
        if (operation === "telemetry")
          return json(historyFor(state, siteId, now, range));
        if (operation === "overview") {
          const alertHistory = alertsFor(state, siteId, now);
          return json({
            site: sites.find((s) => s.id === siteId),
            live: liveFor(state, siteId, now),
            scenario: state.sites[siteId].at(-1)?.scenario ?? "sunny",
            devices: devicesFor(siteId),
            energy: energyFor(state, siteId, now),
            alerts: alertHistory.filter((a) => !a.resolvedAt),
            alertHistory,
            history: historyFor(state, siteId, now, range),
            mode: "simulation",
            backend: "cloud",
            controlEnabled: false,
          });
        }
      }
      if (method === "POST" && operation === "simulation") {
        const text = await request.text();
        if (text.length > 1024)
          return problem("Request body is too large.", 413);
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          return problem("Expected JSON scenario request.", 400);
        }
        if (!body || !scenarios.includes(body.scenario))
          return problem("Unknown simulation scenario.", 400);
        if (state.sites[siteId].length >= 200)
          return problem(
            "Scenario limit reached. Open a new demo session.",
            409,
          );
        changeScenario(state, siteId, body.scenario as Scenario, now);
        await save(session.path, state, etag);
        return json({
          scenario: body.scenario,
          effectiveWithinSeconds: 5,
          hardwareConnected: false,
        });
      }
    }
    if (method === "GET" && route === "v1/alerts" && siteId)
      return json(alertsFor(state, siteId, now));
    if (method === "POST" && /^v1\/alerts\/\d+\/acknowledge$/.test(route)) {
      const id = Number(path[2]);
      const alert = sites
        .flatMap((s) => alertsFor(state, s.id, now))
        .find((a) => a.id === id);
      if (!alert) return problem("Alert not found in your session.", 404);
      if (!state.acknowledgments[String(id)]) {
        state.acknowledgments[String(id)] = new Date(now).toISOString();
        state.audit.push({
          at: now,
          siteId: alert.siteId,
          action: `acknowledge-alert:${id}`,
        });
        state.audit = state.audit.slice(-400);
        await save(session.path, state, etag);
      }
      return json({
        ...alert,
        acknowledgedAt: state.acknowledgments[String(id)],
        acknowledgedBy: "Demo operator",
      });
    }
    if (method === "GET" && route === "v1/reports/energy" && siteId) {
      const rows = [
        "source,site_id,measured_at_utc,solar_kw,load_kw,battery_kw,grid_kw,soc_percent,quality",
      ];
      for (
        let at = Math.ceil((now - 86400000) / 300000) * 300000;
        at <= tick(now);
        at += 300000
      ) {
        const f = sample(siteId, at, scenarioAt(state.sites[siteId], at));
        if (f)
          rows.push(
            [
              "RECONSTRUCTED_SIMULATION",
              siteId,
              f.measuredAt,
              f.solar,
              f.load,
              f.battery,
              f.grid,
              f.soc,
              "GOOD",
            ].join(","),
          );
      }
      return new NextResponse(rows.join("\n"), {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="solar-${siteId}-24h.csv"`,
          "Cache-Control": "private, no-store",
        },
      });
    }
    return problem("Endpoint not found or method not allowed.", 404);
  } catch (error) {
    if (error instanceof BlobPreconditionFailedError)
      return problem(
        "The session changed in another tab. Refresh and retry.",
        409,
      );
    console.error("Solar cloud API failed", {
      route,
      method,
      errorType: error instanceof Error ? error.name : "unknown",
    });
    return problem(
      "The demo service is temporarily unavailable. Please retry.",
      503,
    );
  }
}
