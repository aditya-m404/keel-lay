import { mkdirSync } from "node:fs";
import path from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { repoRoot, type PlannedStep } from "./plan.ts";
import type { Run } from "./runs.ts";

const CHAR_DELAY_MS = 60;

type UiAction =
  | { goto: string }
  | { see: string }
  | { click: string }
  | { fill: { label: string; text: string } };

function actions(ui: unknown): UiAction[] {
  return Array.isArray(ui) ? (ui as UiAction[]) : [];
}

async function waitTurn(run: Run, ms: number): Promise<boolean> {
  let left = Math.min(200, Math.max(0, ms));
  while (left > 0) {
    if (run.status === "stopped") return false;
    if (run.status === "paused") {
      await new Promise((resolve) => setTimeout(resolve, 40));
      continue;
    }
    const slice = Math.min(40, left);
    await new Promise((resolve) => setTimeout(resolve, slice));
    left -= slice;
  }
  return run.status !== "stopped";
}

async function documentInfo(page: Page): Promise<{ navigations: number; origin: number }> {
  return page.evaluate(() => {
    const perf = (globalThis as { performance: { getEntriesByType: (type: string) => unknown[]; timeOrigin: number } }).performance;
    return { navigations: perf.getEntriesByType("navigation").length, origin: perf.timeOrigin };
  });
}

async function headers(context: BrowserContext, run: Run, step: PlannedStep): Promise<void> {
  await context.setExtraHTTPHeaders({
    "x-keel-run-id": run.id,
    "x-keel-actor": step.actor,
    "x-keel-journey": run.journey,
    "x-keel-step": step.step,
    "x-keel-pace": run.pace,
  });
}

async function remember(page: Page, run: Run, step: PlannedStep): Promise<void> {
  await page.evaluate((meta) => {
    (globalThis as { __KEEL_RUN__?: typeof meta }).__KEEL_RUN__ = meta;
  }, { id: run.id, actor: step.actor, journey: run.journey, pace: run.pace, step: step.step });
}

async function noteDocument(run: Run, page: Page, baseline: { origin: number }): Promise<void> {
  const info = await documentInfo(page);
  if (baseline.origin === 0) baseline.origin = info.origin;
  else if (info.origin !== baseline.origin) run.reloaded = true;
  run.navigations = info.navigations;
}

async function fail(run: Run, page: Page, step: PlannedStep): Promise<void> {
  const dir = path.join(repoRoot(), "generated", "person", run.id);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${step.step}.png`) }).catch(() => {});
  run.errorCount += 1;
  run.events.push({
    at: new Date().toISOString(),
    actor: step.actor,
    step: step.step,
    status: 0,
    errorCount: run.errorCount,
  });
}

async function playAction(page: Page, web: string, action: UiAction): Promise<void> {
  if ("goto" in action) {
    const target = new URL(action.goto, web);
    const current = page.url();
    if (current === "about:blank" || new URL(current).origin !== target.origin) {
      await page.goto(target.href, { waitUntil: "domcontentloaded" });
      return;
    }
    if (new URL(current).pathname === target.pathname) return;
    await page.evaluate((href) => {
      const view = globalThis as {
        history: { pushState: (data: object, unused: string, url?: string) => void };
        dispatchEvent: (event: object) => boolean;
        PopStateEvent: new (type: string) => object;
      };
      view.history.pushState({}, "", href);
      view.dispatchEvent(new view.PopStateEvent("popstate"));
    }, `${target.pathname}${target.search}`);
    return;
  }
  if ("see" in action) {
    await page.getByText(action.see, { exact: true }).first().waitFor({ state: "visible", timeout: 10000 });
    return;
  }
  if ("click" in action) {
    await page.getByRole("button", { name: action.click, exact: true }).click({ timeout: 10000 });
    return;
  }
  await page.getByLabel(action.fill.label).pressSequentially(action.fill.text, { delay: CHAR_DELAY_MS, timeout: 15000 });
}

export async function playPerson(run: Run): Promise<void> {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: !run.headed });
  run.closeBrowser = async () => {
    await browser.close().catch(() => {});
  };
  const context = await browser.newContext();
  const page = await context.newPage();
  const baseline = { origin: 0 };
  await context.addInitScript((meta) => {
    (globalThis as { __KEEL_RUN__?: typeof meta }).__KEEL_RUN__ = meta;
  }, { id: run.id, actor: run.steps[0]?.actor ?? "", journey: run.journey, pace: run.pace, step: "" });
  try {
    for (const step of run.steps) {
      if (!(await waitTurn(run, Math.round(step.thinkMs / run.scale)))) return;
      await headers(context, run, step);
      try {
        for (const action of actions(step.ui)) {
          if (page.url() !== "about:blank") await remember(page, run, step);
          await playAction(page, run.web, action);
          if (page.url() !== "about:blank") {
            await page
              .waitForFunction(() => {
                const tracker = (globalThis as { __KEEL_OTEL__?: { pending: number } }).__KEEL_OTEL__;
                return !tracker || tracker.pending === 0;
              }, undefined, { timeout: 5000 })
              .catch(() => {});
            await noteDocument(run, page, baseline);
          }
        }
        if (page.url() !== "about:blank") await remember(page, run, step);
        run.events.push({
          at: new Date().toISOString(),
          actor: step.actor,
          step: step.step,
          status: 200,
          errorCount: run.errorCount,
        });
      } catch {
        if (run.status === "stopped") return;
        await fail(run, page, step);
        return;
      }
    }
  } finally {
    const close = run.closeBrowser;
    run.closeBrowser = null;
    await close?.();
  }
}
