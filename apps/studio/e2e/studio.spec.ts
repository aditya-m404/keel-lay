import { expect, test, type Page } from "@playwright/test";

async function navigationCount(page: Page): Promise<number> {
  return page.evaluate(() => performance.getEntriesByType("navigation").length);
}

test("starting a run keeps the document and shows the scale", async ({ page }) => {
  const targets: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/targets") targets.push(request.url());
  });
  await page.goto("/");
  expect(await navigationCount(page)).toBe(1);
  await page.getByLabel("Seed").fill("phase7-seed");
  await page.getByLabel("Journey").selectOption("create-card");
  await page.getByLabel("Pace").selectOption("demo");
  await page.getByLabel("Target").selectOption("local");
  await page.getByRole("button", { name: "Start" }).click();
  const run = page.locator("[data-run]");
  const scale = page.locator("[data-scale]");
  await expect(run).toContainText("run_");
  await expect(scale).toHaveText("10");
  await expect(scale).toBeVisible();
  expect(await scale.getAttribute("title")).toBeNull();
  expect(await navigationCount(page)).toBe(1);
  const loaded = targets.length;
  await expect(page.locator(".strip")).toContainText(/sign-in|open-board|add-card/);
  expect(loaded).toBeGreaterThan(0);
  expect(targets).toHaveLength(loaded);
});
