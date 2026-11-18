import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alertsFor,
  changeScenario,
  energyFor,
  historyFor,
  initialState,
  liveFor,
  sample,
  sites,
  tick,
} from "../../apps/web-dashboard/server/simulation.ts";

const noon = Date.parse("2026-11-18T06:00:00Z");
test("all supported scenarios conserve signed power at both sites all day", () => {
  for (const site of sites)
    for (const scenario of ["sunny", "cloudy", "night", "battery-hot"] as const)
      for (let i = 0; i < 288; i++) {
        const f = sample(site.id, noon + i * 300000, scenario)!;
        assert.ok(Math.abs(f.solar + f.battery + f.grid - f.load) < 0.11);
        assert.ok(f.soc >= 0 && f.soc <= 100);
        if (scenario === "night") assert.equal(f.solar, 0);
        if (scenario === "battery-hot") assert.equal(f.battery, 0);
      }
});
test("disconnected samples retain their source timestamp and become stale", () => {
  const state = initialState(noon);
  changeScenario(state, "factory-01", "offline", noon);
  const a = liveFor(state, "factory-01", noon + 10000);
  const b = liveFor(state, "factory-01", noon + 60000);
  assert.equal(a.measuredAt, b.measuredAt);
  assert.equal(a.isStale, false);
  assert.equal(b.isStale, true);
  assert.equal(b.ageSeconds, 60);
});
test("cloud state and faults are isolated across sites and visitor sessions", () => {
  const a = initialState(noon),
    b = initialState(noon);
  changeScenario(a, "factory-01", "battery-hot", noon);
  assert.equal(alertsFor(a, "factory-01", noon + 10000).length, 1);
  assert.equal(alertsFor(a, "campus-02", noon + 10000).length, 0);
  assert.equal(alertsFor(b, "factory-01", noon + 10000).length, 0);
});
test("fault acknowledgment survives recovery and timeline replay", () => {
  const state = initialState(noon);
  changeScenario(state, "factory-01", "battery-hot", noon);
  const id = alertsFor(state, "factory-01", noon + 10000)[0].id;
  state.acknowledgments[String(id)] = new Date(noon + 10000).toISOString();
  changeScenario(state, "factory-01", "sunny", noon + 15000);
  const a = alertsFor(
    JSON.parse(JSON.stringify(state)),
    "factory-01",
    noon + 25000,
  )[0];
  assert.equal(a.id, id);
  assert.ok(a.resolvedAt);
  assert.ok(a.acknowledgedAt);
});
test("offline history has null buckets and bounded response sizes", () => {
  const state = initialState(noon);
  changeScenario(state, "factory-01", "offline", noon);
  const history = historyFor(state, "factory-01", noon + 3600000, "1h");
  assert.ok(history.points.some((p) => p.samples === 0 && p.solar === null));
  for (const range of ["1h", "6h", "24h", "7d"])
    assert.ok(
      historyFor(state, "factory-01", noon + 3600000, range).points.length <=
        290,
    );
});
test("offline periods are excluded from local-day energy", () => {
  const state = initialState(noon);
  changeScenario(state, "factory-01", "offline", noon);
  const earlier = energyFor(state, "factory-01", noon + 60000);
  const later = energyFor(state, "factory-01", noon + 3600000);
  assert.equal(earlier.solarKwh, later.solarKwh);
  assert.equal(later.periodStart, "2026-11-17T18:00:00.000Z");
});
test("rapid changes before acquisition only apply the last requested scenario", () => {
  const state = initialState(noon);
  changeScenario(state, "factory-01", "offline", noon);
  changeScenario(state, "factory-01", "cloudy", noon + 1000);
  assert.equal(state.sites["factory-01"].length, 1);
  assert.equal(alertsFor(state, "factory-01", noon + 10000).length, 0);
  assert.equal(tick(noon + 1234), noon);
});
