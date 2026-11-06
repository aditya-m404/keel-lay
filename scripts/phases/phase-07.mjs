import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const pg = require("pg");
const studioOrigin = "http://127.0.0.1:4102";

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

async function studioUp(env) {
  try {
    const ready = await fetch(`${studioOrigin}/targets`);
    if (ready.ok) return;
  } catch {
    // start it below
  }
  mkdirSync(path.join(root, "generated"), { recursive: true });
  const log = openSync(path.join(root, "generated/studio.log"), "a");
  const child = spawn(process.execPath, ["apps/studio/src/server.ts"], {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  writeFileSync(path.join(root, "generated/studio.pid"), String(child.pid));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const ready = await fetch(`${studioOrigin}/targets`);
      if (ready.ok) return;
    } catch {
      // still booting
    }
    await sleep(200);
  }
  miss("studio did not answer /targets");
}

const demo = {
  target: "local",
  mode: "computer",
  journey: "create-card",
  pace: "demo",
  seed: "phase7-seed",
  confirm: "",
};

async function postRun(body) {
  const response = await fetch(`${studioOrigin}/runs`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, json };
}

const jar = new Map();

function storeCookies(response) {
  for (const header of response.headers.getSetCookie?.() ?? []) {
    const pair = header.split(";")[0];
    const eq = pair.indexOf("=");
    jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}

async function api(env, method, pathname) {
  const headers = { accept: "application/json" };
  if (jar.size > 0) headers.cookie = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  const response = await fetch(`${env.KEEL_API_ORIGIN}${pathname}`, { method, headers });
  storeCookies(response);
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

const userEnv = { ...process.env };
loadEnv(userEnv);

let code = 0;
try {
  if (!userEnv.DATABASE_URL || !userEnv.KEEL_API_ORIGIN) miss("DATABASE_URL or KEEL_API_ORIGIN is empty.");
  const health = await fetch(`${userEnv.KEEL_API_ORIGIN}/health`);
  if (!health.ok) miss("API is not up. Run ./scripts/up.");
  await studioUp(userEnv);

  const first = await postRun(demo);
  const second = await postRun(demo);
  if (first.status !== 201 || second.status !== 201) miss(`start ${first.status} ${second.status}`);
  const left = JSON.stringify(first.json.run.steps);
  const right = JSON.stringify(second.json.run.steps);
  if (left !== right) miss(`step lists differ\n${left}\n${right}`);
  if (!first.json.run.steps.some((step) => step.step === "add-card")) miss("create-card plan has no add-card step");

  const hits = [];
  const probe = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.end("hit");
  });
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const refused = await postRun({ ...demo, api: `http://localhost:${port}` });
  await sleep(400);
  probe.close();
  if (refused.status !== 400 || refused.json.error?.code !== "invalid_body") {
    miss(`host mismatch ${refused.status} ${JSON.stringify(refused.json)}`);
  }
  if (hits.length !== 0) miss(`refused run reached the other host ${hits.join(",")}`);

  const blocked = await postRun({ ...demo, target: "production", confirm: "" });
  if (blocked.status !== 400) miss(`production without confirm ${blocked.status}`);
  const allowed = await postRun({ ...demo, target: "production", confirm: "production" });
  if (allowed.status !== 201 || allowed.json.run.actors !== 1) {
    miss(`production actors ${allowed.status} ${JSON.stringify(allowed.json)}`);
  }

  const playwright = spawnSync("pnpm", ["exec", "playwright", "test"], {
    cwd: path.join(root, "apps/studio"),
    env: userEnv,
    encoding: "utf8",
  });
  if (playwright.status !== 0) miss(playwright.stdout || playwright.stderr || "studio e2e failed");

  jar.clear();
  const signed = await fetch(`${userEnv.KEEL_API_ORIGIN}/session`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ email: "ada@keel.test", password: "keel-local-only" }),
  });
  storeCookies(signed);
  const before = await api(userEnv, "GET", "/boards/launch");
  const card = before.json.cards.find((item) => item.id === "card_01");
  if (!card) miss("card_01 missing");
  const moved = await postRun({ ...demo, journey: "forbidden-move" });
  if (moved.status !== 201) miss(`forbidden-move start ${moved.status}`);
  let saw = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = await fetch(`${studioOrigin}/runs/${moved.json.run.id}`);
    const body = await current.json();
    saw = body.run.events.find((event) => event.step === "move-card") ?? null;
    if (saw || body.run.status === "stopped") break;
    await sleep(200);
  }
  if (!saw || saw.status !== 403) miss(`forbidden-move status ${saw ? saw.status : "missing"}`);
  const after = await api(userEnv, "GET", "/boards/launch");
  const still = after.json.cards.find((item) => item.id === "card_01");
  if (!still || still.column !== card.column) miss(`card_01 moved from ${card.column} to ${still?.column}`);
  console.log("phase 7 ok");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  code = 1;
} finally {
  try {
    await resetBoard(userEnv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    code = 1;
  }
}
process.exit(code);
