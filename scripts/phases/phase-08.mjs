import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const pg = require("pg");
const studioOrigin = "http://127.0.0.1:4102";
const journeys = path.join(root, "packages/journeys");
const badFile = path.join(journeys, "phase8-no-api.yaml");
const missingFile = path.join(journeys, "phase8-missing.yaml");

function miss(message) {
  throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadEnv(target) {
  const file = path.join(root, ".env");
  if (!existsSync(file)) miss("missing .env. Run ./scripts/init and ./scripts/up.");
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    target[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
}

function runSeed(env) {
  const result = spawnSync(process.execPath, ["apps/api/src/db/seed.ts"], { cwd: root, env, encoding: "utf8" });
  if (result.status !== 0) miss(result.stderr || result.stdout || "seed failed");
}

async function resetBoard(env) {
  const db = new pg.Client({ connectionString: env.DATABASE_URL });
  await db.connect();
  try {
    await db.query("DELETE FROM comments");
    await db.query("DELETE FROM idempotency_keys");
    await db.query("DELETE FROM cards");
    await db.query("UPDATE boards SET revision = 1 WHERE id = 'board_launch'");
    runSeed(env);
  } finally {
    await db.end();
  }
}

function removeFixtures() {
  rmSync(badFile, { force: true });
  rmSync(missingFile, { force: true });
}

function collectorLog() {
  const result = spawnSync("docker", ["compose", "-f", "infra/compose.yaml", "logs", "--since", "3m", "--no-color", "collector"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function spansFor(log, runId) {
  const found = { web: false, api: false };
  let from = 0;
  while (from < log.length) {
    const at = log.indexOf(runId, from);
    if (at < 0) break;
    const window = log.slice(Math.max(0, at - 50000), at + 4000);
    const app = window.includes("Str(app)");
    if (app && window.includes("keel-web")) found.web = true;
    if (app && window.includes("keel-api")) found.api = true;
    from = at + runId.length;
  }
  return found;
}

async function postRun(body) {
  const response = await fetch(`${studioOrigin}/runs`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, json };
}

async function untilStopped(id) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const response = await fetch(`${studioOrigin}/runs/${id}`);
    const body = await response.json();
    if (body.run?.status === "stopped") return body.run;
    await sleep(500);
  }
  miss(`run ${id} did not stop`);
}

const userEnv = { ...process.env };
loadEnv(userEnv);

let code = 0;
try {
  if (!userEnv.DATABASE_URL || !userEnv.KEEL_API_ORIGIN) miss("DATABASE_URL or KEEL_API_ORIGIN is empty.");
  const health = await fetch(`${userEnv.KEEL_API_ORIGIN}/health`);
  if (!health.ok) miss("API is not up. Run ./scripts/up.");
  const studio = await fetch(`${studioOrigin}/targets`);
  if (!studio.ok) miss("Studio is not up. Run ./scripts/up.");

  writeFileSync(
    badFile,
    `id: phase8-no-api
title: Missing api
actor: grace
actors: [member]
steps:
  - id: look
    ui:
      - { see: Sign in }
    thinkMs: { min: 100, max: 200 }
`,
  );
  const rejected = spawnSync("pnpm", ["journeys:check"], { cwd: root, env: userEnv, encoding: "utf8" });
  if (rejected.status === 0) miss("journeys:check accepted a step with no api block");
  if (!`${rejected.stdout}\n${rejected.stderr}`.includes("api")) miss(rejected.stderr || rejected.stdout || "check failed without naming api");
  removeFixtures();
  const accepted = spawnSync("pnpm", ["journeys:check"], { cwd: root, env: userEnv, encoding: "utf8" });
  if (accepted.status !== 0) miss(accepted.stderr || accepted.stdout || "journeys:check failed on the shipped journeys");

  writeFileSync(
    missingFile,
    `id: phase8-missing
title: Missing label
actor: grace
actors: [member]
steps:
  - id: missing
    ui:
      - { goto: /sign-in }
      - { see: This label is not here }
    api:
      method: GET
      path: /health
      expect: 200
    thinkMs: { min: 100, max: 200 }
`,
  );
  const broken = await postRun({
    target: "local",
    mode: "person",
    journey: "phase8-missing",
    pace: "demo",
    seed: "phase8-missing",
    confirm: "",
  });
  if (broken.status !== 201) miss(`missing-label start ${broken.status} ${JSON.stringify(broken.json)}`);
  const failed = await untilStopped(broken.json.run.id);
  const shots = path.join(root, "generated/person", failed.id);
  const pngs = existsSync(shots) ? readdirSync(shots).filter((name) => name.endsWith(".png")) : [];
  if (failed.errorCount < 1 || pngs.length === 0) {
    miss(`missing label did not fail with a screenshot ${failed.errorCount} ${pngs.join(",")}`);
  }
  removeFixtures();

  const started = await postRun({
    target: "local",
    mode: "person",
    journey: "create-card",
    pace: "demo",
    seed: "phase8-seed",
    confirm: "",
  });
  if (started.status !== 201) miss(`create-card start ${started.status} ${JSON.stringify(started.json)}`);
  const run = await untilStopped(started.json.run.id);
  if (run.errorCount !== 0) miss(`create-card errors ${run.errorCount} ${JSON.stringify(run.events)}`);
  if (run.navigations !== 1 || run.reloaded) miss(`document load navigations=${run.navigations} reloaded=${run.reloaded}`);

  const signed = await fetch(`${userEnv.KEEL_API_ORIGIN}/session`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ email: "ada@keel.test", password: "keel-local-only" }),
  });
  const cookie = signed.headers.getSetCookie?.().map((header) => header.split(";")[0]).join("; ");
  const board = await fetch(`${userEnv.KEEL_API_ORIGIN}/boards/launch`, {
    headers: { accept: "application/json", cookie },
  });
  const body = await board.json();
  if (!body.cards?.some((card) => card.title === "Check the collector")) {
    miss("Check the collector is not on the board");
  }

  let found = { web: false, api: false };
  let log = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    log = collectorLog();
    found = spansFor(log, run.id);
    if (found.web && found.api) break;
    await sleep(500);
  }
  if (!found.web || !found.api) {
    const at = log.lastIndexOf(run.id);
    const slice = at < 0 ? log.slice(-2000) : log.slice(Math.max(0, at - 1500), at + 1500);
    miss(`collector log missing browser=${found.web} server=${found.api} for ${run.id}\n${slice}`);
  }
  console.log("phase 8 ok");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  code = 1;
} finally {
  removeFixtures();
  try {
    await resetBoard(userEnv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    code = 1;
  }
}
process.exit(code);
