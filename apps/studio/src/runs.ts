import { newId } from "./ids.ts";
import { playPerson } from "./person.ts";
import { loadJourney, planSteps, profileFor, type Pace, type PlannedStep } from "./plan.ts";

export type RunEvent = {
  at: string;
  actor: string;
  step: string;
  status: number;
  errorCount: number;
};

export type RunStatus = "running" | "paused" | "stopped";

export type Run = {
  id: string;
  target: string;
  mode: "computer" | "person";
  journey: string;
  pace: Pace;
  seed: string;
  scale: number;
  actors: number;
  minutes: number;
  status: RunStatus;
  api: string;
  web: string;
  headed: boolean;
  navigations: number;
  reloaded: boolean;
  closeBrowser: (() => Promise<void>) | null;
  steps: PlannedStep[];
  events: RunEvent[];
  errorCount: number;
  cookies: Map<string, string>;
};

const runs = new Map<string, Run>();

export function getRun(id: string): Run | undefined {
  return runs.get(id);
}

export function publicRun(run: Run) {
  return {
    id: run.id,
    target: run.target,
    mode: run.mode,
    journey: run.journey,
    pace: run.pace,
    seed: run.seed,
    scale: run.scale,
    actors: run.actors,
    minutes: run.minutes,
    status: run.status,
    errorCount: run.errorCount,
    navigations: run.navigations,
    reloaded: run.reloaded,
    steps: run.steps.map(({ actor, step, thinkMs }) => ({ actor, step, thinkMs })),
    events: run.events,
  };
}

export function createRun(input: {
  target: string;
  journey: string;
  pace: Pace;
  seed: string;
  api: string;
  web: string;
  mode: "computer" | "person";
  headed: boolean;
}): Run | null {
  const journey = loadJourney(input.journey);
  if (!journey) return null;
  const profile = profileFor(input.pace, input.target);
  const run: Run = {
    id: newId("run_"),
    target: input.target,
    mode: input.mode,
    journey: input.journey,
    pace: input.pace,
    seed: input.seed,
    scale: profile.scale,
    actors: input.mode === "person" ? 1 : profile.actors,
    minutes: profile.minutes,
    status: "running",
    api: input.api.replace(/\/$/, ""),
    web: input.web.replace(/\/$/, ""),
    headed: input.headed,
    navigations: 0,
    reloaded: false,
    closeBrowser: null,
    steps: planSteps(journey, input.pace, input.seed),
    events: [],
    errorCount: 0,
    cookies: new Map(),
  };
  runs.set(run.id, run);
  void execute(run);
  return run;
}

export function pauseRun(id: string): Run | undefined {
  const run = runs.get(id);
  if (!run || run.status === "stopped") return run;
  run.status = "paused";
  return run;
}

export function stopRun(id: string): Run | undefined {
  const run = runs.get(id);
  if (!run) return undefined;
  run.status = "stopped";
  run.cookies.clear();
  const close = run.closeBrowser;
  run.closeBrowser = null;
  void close?.();
  return run;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitTurn(run: Run, ms: number): Promise<boolean> {
  let left = ms;
  while (left > 0) {
    if (run.status === "stopped") return false;
    if (run.status === "paused") {
      await delay(40);
      continue;
    }
    const slice = Math.min(40, left);
    await delay(slice);
    left -= slice;
  }
  return run.status !== "stopped";
}

function cookieHeader(run: Run): string | undefined {
  if (run.cookies.size === 0) return undefined;
  return [...run.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function rememberCookies(run: Run, response: Response): void {
  for (const header of response.headers.getSetCookie?.() ?? []) {
    const pair = header.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq > 0) run.cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}

function versionFor(body: unknown, cardId: string): string | null {
  if (!body || typeof body !== "object") return null;
  const cards = (body as { cards?: { id?: string; version?: number }[] }).cards;
  const card = cards?.find((item) => item.id === cardId);
  return card?.version === undefined ? null : String(card.version);
}

async function playStep(run: Run, step: PlannedStep, versions: Map<string, string>): Promise<void> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "x-keel-run-id": run.id,
    "x-keel-actor": step.actor,
    "x-keel-journey": run.journey,
    "x-keel-step": step.step,
    "x-keel-pace": run.pace,
  };
  const cookie = cookieHeader(run);
  if (cookie) headers.cookie = cookie;
  let body: string | undefined;
  if (step.api.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(step.api.body);
  }
  if (step.api.method === "POST" && (step.api.path === "/cards" || step.api.path.endsWith("/comments"))) {
    headers["idempotency-key"] = newId("idem_");
  }
  if (step.api.ifMatch) {
    const version = versions.get(step.api.ifMatch);
    if (version) headers["if-match"] = version;
  }
  let status = 0;
  let json: unknown = null;
  try {
    const response = await fetch(`${run.api}${step.api.path}`, {
      method: step.api.method,
      headers,
      body,
      signal: AbortSignal.timeout(4000),
    });
    status = response.status;
    rememberCookies(run, response);
    const text = await response.text();
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
  } catch {
    status = 0;
  }
  if (step.api.ifMatch === undefined && json) {
    const cards = (json as { cards?: { id?: string; version?: number }[] }).cards ?? [];
    for (const card of cards) {
      if (card.id && card.version !== undefined) versions.set(card.id, String(card.version));
    }
  }
  if (status >= 400 || status === 0) run.errorCount += 1;
  run.events.push({
    at: new Date().toISOString(),
    actor: step.actor,
    step: step.step,
    status,
    errorCount: run.errorCount,
  });
}

async function execute(run: Run): Promise<void> {
  try {
    if (run.mode === "person") {
      await playPerson(run);
    } else {
      const versions = new Map<string, string>();
      for (const step of run.steps) {
        const ready = await waitTurn(run, Math.max(0, Math.round(step.thinkMs / run.scale)));
        if (!ready) break;
        await playStep(run, step, versions);
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    run.errorCount += 1;
    run.events.push({
      at: new Date().toISOString(),
      actor: run.steps[0]?.actor ?? "",
      step: "runner",
      status: 0,
      errorCount: run.errorCount,
    });
  }
  if (run.status !== "stopped") run.status = "stopped";
  run.cookies.clear();
}
