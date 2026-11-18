import { expect, test } from "@playwright/test";

test("cloud sessions isolate persistent scenarios, alerts, and signed cookies", async ({
  page,
  playwright,
  baseURL,
}) => {
  const login = await page.request.post("/api/auth/demo");
  expect(login.status()).toBe(200);
  const identity = await login.json();
  if (identity.backend !== "cloud") {
    await page.request.post("/api/auth/logout");
    test.skip(true, "Cloud-only persistence and session isolation test");
  }
  const other = await playwright.request.newContext({
    baseURL,
    storageState: process.env.SOLAR_TEST_STORAGE_STATE,
    proxy: process.env.SOLAR_TEST_PROXY
      ? { server: process.env.SOLAR_TEST_PROXY }
      : undefined,
    ignoreHTTPSErrors: !!process.env.SOLAR_TEST_PROXY,
  });
  try {
    expect((await other.get("/api/v1/sites")).status()).toBe(401);
    expect((await other.post("/api/auth/demo")).status()).toBe(200);
    expect(
      (await page.request.get("/api/v1/sites/unknown/overview")).status(),
    ).toBe(403);
    expect(
      (
        await page.request.get("/api/v1/sites/factory-01/telemetry?range=999y")
      ).status(),
    ).toBe(400);
    expect(
      (await page.request.post("/api/v1/commands", { data: {} })).status(),
    ).toBe(403);
    expect(
      (
        await page.request.post("/api/v1/sites/factory-01/simulation", {
          data: { scenario: "bad" },
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await page.request.post("/api/auth/demo", {
          headers: { "sec-fetch-site": "cross-site" },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await page.request.post("/api/v1/sites/factory-01/simulation", {
          data: { scenario: "battery-hot" },
        })
      ).status(),
    ).toBe(200);
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get("/api/v1/alerts?siteId=factory-01")
            ).json()
          ).length,
      )
      .toBe(1);
    const alerts = await (
      await page.request.get("/api/v1/alerts?siteId=factory-01")
    ).json();
    expect(
      (await other.post(`/api/v1/alerts/${alerts[0].id}/acknowledge`)).status(),
    ).toBe(404);
    const otherSite = await (
      await other.get("/api/v1/sites/factory-01/overview")
    ).json();
    expect(otherSite.scenario).toBe("sunny");
    expect(otherSite.alerts).toHaveLength(0);
    const saved = await (
      await page.request.get("/api/v1/sites/factory-01/overview")
    ).json();
    expect(saved.scenario).toBe("battery-hot");
    const cookie = (await page.context().cookies()).find(
      (c) => c.name === "solar-cloud-session",
    )!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Strict");
    if (baseURL?.startsWith("https:")) expect(cookie.secure).toBe(true);
    await page
      .context()
      .addCookies([
        {
          ...cookie,
          value:
            cookie.value.slice(0, -1) +
            (cookie.value.endsWith("a") ? "b" : "a"),
        },
      ]);
    expect((await page.request.get("/api/v1/sites")).status()).toBe(401);
    await page.context().addCookies([cookie]);
  } finally {
    await page.request.post("/api/auth/logout");
    await other.post("/api/auth/logout");
    await other.dispose();
  }
});
