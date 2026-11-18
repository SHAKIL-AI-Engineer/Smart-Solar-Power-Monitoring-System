// Pure deterministic model shared by the serverless demo and its tests.
export const sites = [
  {
    id: "factory-01",
    name: "Dhaka Manufacturing",
    location: "Dhaka, Bangladesh",
    timeZone: "Asia/Dhaka",
    capacityKw: 300,
    batteryKwh: 400,
  },
  {
    id: "campus-02",
    name: "Chattogram Campus",
    location: "Chattogram, Bangladesh",
    timeZone: "Asia/Dhaka",
    capacityKw: 180,
    batteryKwh: 240,
  },
];
export const scenarios = [
  "sunny",
  "cloudy",
  "night",
  "offline",
  "battery-hot",
] as const;
export type Scenario = (typeof scenarios)[number];
export type ScenarioEvent = { at: number; scenario: Scenario };
export type CloudState = {
  version: 1;
  createdAt: number;
  expiresAt: number;
  sites: Record<string, ScenarioEvent[]>;
  acknowledgments: Record<string, string>;
  audit: { at: number; siteId: string; action: string }[];
};
export const round = (n: number, digits = 1) => Number(n.toFixed(digits));
export const tick = (now: number) => Math.floor(now / 5000) * 5000;
export function initialState(now: number): CloudState {
  return {
    version: 1,
    createdAt: now,
    expiresAt: now + 8 * 3600000,
    sites: Object.fromEntries(sites.map((s) => [s.id, []])),
    acknowledgments: {},
    audit: [],
  };
}
export function scenarioAt(events: ScenarioEvent[], at: number): Scenario {
  return events.findLast((e) => e.at <= at)?.scenario ?? "sunny";
}
export function sample(
  siteId: string,
  at: number,
  scenario: Scenario = "sunny",
) {
  if (scenario === "offline") return null;
  const site = sites.find((s) => s.id === siteId);
  if (!site) throw new Error("Unknown site");
  // Both supported demo sites use UTC+06:00, without daylight saving.
  const hour = (at / 3600000 + 6) % 24;
  const scale = site.capacityKw / 300;
  const sun = Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI));
  const solar =
    scenario === "night"
      ? 0
      : round(270 * sun * (scenario === "cloudy" ? 0.36 : 1) * scale);
  const load = round(
    (175 +
      45 * Math.sin(((hour - 6) / 24) * Math.PI * 2) +
      12 * Math.sin(hour * 2)) *
      scale,
  );
  const battery =
    scenario === "battery-hot"
      ? 0
      : round(
          Math.max(
            -45 * scale,
            Math.min(30 * scale, load - solar - 20 * scale),
          ),
        );
  return {
    solar,
    load,
    battery,
    grid: round(load - solar - battery),
    soc: round(65 + 13 * Math.sin(((hour - 10) / 24) * Math.PI * 2)),
    temperature: scenario === "battery-hot" ? 48 : round(29 + 5 * sun),
    measuredAt: new Date(at).toISOString(),
  };
}
export function liveFor(state: CloudState, siteId: string, now: number) {
  const events = state.sites[siteId];
  let at = tick(now);
  const current = events.findLast((e) => e.at <= at);
  if (current?.scenario === "offline") at = current.at - 5000;
  const frame = sample(siteId, at, scenarioAt(events, at));
  if (!frame) throw new Error("No last known simulator frame");
  const ageSeconds = Math.max(0, (now - at) / 1000);
  return {
    ...frame,
    receivedAt: frame.measuredAt,
    quality: "GOOD",
    source: "serverless-simulator",
    unit: "kW",
    socUnit: "%",
    temperatureUnit: "°C",
    isStale: ageSeconds > 15,
    ageSeconds,
    balanceResidualKw: round(
      frame.solar + frame.battery + frame.grid - frame.load,
      2,
    ),
  };
}
export function devicesFor(siteId: string) {
  return [
    {
      suffix: "pv",
      name: "Solar inverter 01",
      type: "Inverter",
      protocol: "Simulated SunSpec",
    },
    {
      suffix: "bms",
      name: "Battery storage",
      type: "Battery / PCS",
      protocol: "Simulated BMS",
    },
    {
      suffix: "grid",
      name: "Grid connection",
      type: "Grid meter",
      protocol: "Simulated Modbus",
    },
    {
      suffix: "load",
      name: "Facility demand",
      type: "Load meter",
      protocol: "Simulated Modbus",
    },
  ].map((d) => ({
    id: `${siteId}-${d.suffix}`,
    siteId,
    name: d.name,
    type: d.type,
    protocol: d.protocol,
    serial: `SIM-${siteId}-${d.suffix.toUpperCase()}`,
  }));
}
export function historyFor(
  state: CloudState,
  siteId: string,
  now: number,
  range: string,
) {
  const hours = (
    { "1h": 1, "6h": 6, "24h": 24, "7d": 168 } as Record<string, number>
  )[range];
  if (!hours) throw new Error("Invalid range");
  const bucketMinutes = range === "7d" ? 60 : 5;
  const bucketMs = bucketMinutes * 60000;
  const points = [];
  const keys = ["solar", "load", "battery", "grid", "soc"] as const;
  // Reconstruct one-minute synthetic samples; do not claim an ingestion archive.
  for (
    let t = Math.floor((now - hours * 3600000) / bucketMs) * bucketMs;
    t <= tick(now);
    t += bucketMs
  ) {
    const frames: NonNullable<ReturnType<typeof sample>>[] = [];
    for (
      let s = Math.max(t, now - hours * 3600000);
      s < t + bucketMs && s <= tick(now);
      s += 60000
    ) {
      const f = sample(siteId, s, scenarioAt(state.sites[siteId], s));
      if (f) frames.push(f);
    }
    points.push({
      measuredAt: new Date(t).toISOString(),
      ...Object.fromEntries(
        keys.map((k) => [
          k,
          frames.length
            ? round(frames.reduce((sum, f) => sum + f[k], 0) / frames.length)
            : null,
        ]),
      ),
      samples: frames.length,
    });
  }
  return {
    points,
    bucketMinutes,
    range,
    unit: "kW",
    socUnit: "%",
    source: "serverless-simulator",
    method: "Reconstructed one-minute simulator samples, bucketed by mean",
  };
}
export function energyFor(state: CloudState, siteId: string, now: number) {
  const midnight =
    Math.floor((now + 6 * 3600000) / 86400000) * 86400000 - 6 * 3600000;
  const energy = { solarKwh: 0, demandKwh: 0, importKwh: 0, exportKwh: 0 };
  for (let t = midnight; t < tick(now); t += 60000) {
    const end = Math.min(t + 60000, tick(now));
    // Exclude any interval intersecting a disconnected period, including brief faults.
    const transitions = state.sites[siteId].filter(
      (e) => e.at > t && e.at <= end,
    );
    if (
      scenarioAt(state.sites[siteId], t) === "offline" ||
      transitions.some((e) => e.scenario === "offline")
    )
      continue;
    const a = sample(siteId, t, scenarioAt(state.sites[siteId], t));
    const b = sample(siteId, end, scenarioAt(state.sites[siteId], end));
    if (!a || !b) continue;
    const dt = (end - t) / 3600000 / 2;
    energy.solarKwh += (a.solar + b.solar) * dt;
    energy.demandKwh += (a.load + b.load) * dt;
    energy.importKwh += (Math.max(0, a.grid) + Math.max(0, b.grid)) * dt;
    energy.exportKwh += (Math.max(0, -a.grid) + Math.max(0, -b.grid)) * dt;
  }
  const rounded = Object.fromEntries(
    Object.entries(energy).map(([k, v]) => [k, round(v, 2)]),
  );
  return {
    ...rounded,
    importedCost: round(energy.importKwh * 12, 2),
    currency: "BDT",
    tariffPerKwh: 12,
    method:
      "Reconstructed simulator energy; trapezoidal integration; offline intervals excluded",
    periodStart: new Date(midnight).toISOString(),
  };
}
export function alertsFor(state: CloudState, siteId: string, now: number) {
  const events = state.sites[siteId];
  return events
    .flatMap((event, index) => {
      if (
        event.at > tick(now) ||
        !["offline", "battery-hot"].includes(event.scenario)
      )
        return [];
      const resolved = events[index + 1]?.at;
      const id = event.at + sites.findIndex((s) => s.id === siteId);
      return [
        {
          id,
          siteId,
          deviceId: `${siteId}-${event.scenario === "offline" ? "grid" : "bms"}`,
          rule:
            event.scenario === "offline"
              ? "gateway-offline"
              : "battery-temperature",
          severity: event.scenario === "offline" ? "critical" : "warning",
          message:
            event.scenario === "offline"
              ? "Gateway disconnected. Displaying last accepted readings."
              : "Battery temperature exceeds 45°C. Inspect cooling and BMS status.",
          firstSeen: new Date(event.at).toISOString(),
          lastSeen: new Date(
            Math.min(resolved ?? tick(now), tick(now)),
          ).toISOString(),
          resolvedAt:
            resolved && resolved <= tick(now)
              ? new Date(resolved).toISOString()
              : null,
          acknowledgedAt: state.acknowledgments[String(id)] ?? null,
          acknowledgedBy: state.acknowledgments[String(id)]
            ? "Demo operator"
            : null,
        },
      ];
    })
    .reverse()
    .slice(0, 100);
}
export function changeScenario(
  state: CloudState,
  siteId: string,
  scenario: Scenario,
  now: number,
) {
  const events = state.sites[siteId];
  if (events.length >= 200)
    throw new Error("Scenario history limit reached. Open a new demo session.");
  if ((events.at(-1)?.scenario ?? "sunny") === scenario) return;
  const at = tick(now) + 5000;
  if (events.at(-1)?.at === at) events.pop();
  events.push({ at, scenario });
  state.audit.push({ at: now, siteId, action: `simulation:${scenario}` });
  state.audit = state.audit.slice(-400);
}
