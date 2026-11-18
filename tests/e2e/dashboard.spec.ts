import { expect, test } from "@playwright/test";

test("complete read-only operator journey", async ({ page }) => {
  const crashes: string[] = [];
  page.on("pageerror", (e) => crashes.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /A clearer view/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open demo workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Energy overview" }),
  ).toBeVisible();
  await expect(page.getByText("Live energy flow")).toBeVisible();
  await expect(page.locator(".data-footer")).toContainText("Connected");
  const overview = await (
    await page.request.get("/api/v1/sites/factory-01/overview")
  ).json();
  expect(overview.controlEnabled).toBe(false);
  expect(overview.live.balanceResidualKw).toBeCloseTo(0);
  await page.screenshot({
    path: "artifacts/dashboard-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "6h", exact: true }).click();
  await expect
    .poll(async () =>
      (
        await page.request.get("/api/v1/sites/factory-01/telemetry?range=6h")
      ).status(),
    )
    .toBe(200);
  await page.getByRole("button", { name: "Devices", exact: true }).click();
  await page.getByRole("textbox", { name: "Search devices" }).fill("Battery");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page
    .getByRole("combobox", { name: "Select site" })
    .selectOption("campus-02");
  await expect(page.getByText("180 kWp installed capacity")).toBeVisible();
  await page
    .getByRole("combobox", { name: "Select site" })
    .selectOption("factory-01");
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Simulator", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Simulation scenario" })
    .selectOption("battery-hot");
  await page.getByRole("button", { name: "Alerts", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /Battery temperature exceeds/ }).first(),
  ).toBeVisible();
  const active = page
    .locator(".alert-row")
    .filter({ hasText: "Active" })
    .filter({ hasText: "Battery temperature" })
    .first();
  await expect(active).toBeVisible();
  await active
    .getByRole("button", { name: "Acknowledge", exact: true })
    .click();
  await expect(
    active.getByRole("button", { name: "Acknowledged", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("combobox", { name: "Simulation scenario" })
    .selectOption("offline");
  await expect(page.getByText("Data stale", { exact: true })).toBeVisible({
    timeout: 25000,
  });
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(page.locator(".energy-flow")).toHaveClass(/stopped/);
  await page
    .getByRole("combobox", { name: "Simulation scenario" })
    .selectOption("sunny");
  await expect(
    page.getByText("Simulation online", { exact: true }),
  ).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export data" }).click();
  expect((await downloaded).suggestedFilename()).toBe(
    "solar-factory-01-24h.csv",
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Energy overview" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Workspace guide" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("button", { name: "Open demo workspace" }),
  ).toBeVisible();
  expect(crashes).toEqual([]);
});

test("mobile navigation and responsive dashboard", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Open demo workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Energy overview" }),
  ).toBeVisible();
  await expect(page.getByText("Live energy flow")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "artifacts/dashboard-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Analytics", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Energy analytics" }),
  ).toBeVisible();
  await expect(page.getByText("Today’s energy breakdown")).toBeVisible();
});
