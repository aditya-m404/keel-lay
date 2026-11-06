import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const pg = require("pg");
const stamp = path.join(root, "apps/web/src/build-stamp.ts");
const originalStamp = readFileSync(stamp, "utf8");

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

function run(command, args, env = process.env, timeout = 600000) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", timeout });
  if (result.status !== 0) miss(result.stderr || result.stdout || `${command} failed`);
  return result;
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

async function bundleHash() {
  const response = await fetch("http://127.0.0.1:4100/", { headers: { accept: "text/html" } });
  const html = await response.text();
  const match = html.match(/\/assets\/[^"]+/);
  if (!match) miss(`served page has no hashed bundle\n${html.slice(0, 400)}`);
  return match[0];
}

const userEnv = { ...process.env };
loadEnv(userEnv);

let code = 0;
let rebuilt = false;
try {
  run("./scripts/up", ["prodlike"], userEnv);
  const started = Date.now();
  run("./scripts/up", ["prodlike"], userEnv, 40000);
  const warm = Date.now() - started;
  if (warm > 30000) miss(`warm start took ${warm}ms`);
  console.log(`warm ${warm}ms`);
  const ready = await fetch(`${userEnv.KEEL_API_ORIGIN}/ready`);
  if (!ready.ok) miss(`ready ${ready.status}`);

  run(process.execPath, ["scripts/phases/phase-02.mjs"], userEnv);
  run(process.execPath, ["scripts/phases/phase-03.mjs"], userEnv);
  const playwright = spawnSync("pnpm", ["exec", "playwright", "test"], {
    cwd: path.join(root, "apps/web"),
    env: userEnv,
    encoding: "utf8",
    timeout: 120000,
  });
  if (playwright.status !== 0) miss(playwright.stdout || playwright.stderr || "web e2e failed");

  const before = await bundleHash();
  writeFileSync(stamp, originalStamp.replace('export const buildStamp = "keel";', 'export const buildStamp = "keel-rebuild";'));
  await sleep(5000);
  const during = await bundleHash();
  if (during !== before) miss(`bundle changed without a rebuild ${before} -> ${during}`);
  run("./scripts/up", ["prodlike"], { ...userEnv, KEEL_REBUILD: "1" });
  rebuilt = true;
  const after = await bundleHash();
  if (after === before) miss(`rebuild left the bundle hash at ${before}`);

  const runId = `run_phase10_${randomUUID()}`;
  const signed = await fetch(`${userEnv.KEEL_API_ORIGIN}/session`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ email: "grace@keel.test", password: "keel-local-only" }),
  });
  const cookie = signed.headers.getSetCookie?.().map((header) => header.split(";")[0]).join("; ");
  const created = await fetch(`${userEnv.KEEL_API_ORIGIN}/cards`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      cookie,
      "idempotency-key": randomUUID(),
      "x-keel-run-id": runId,
    },
    body: JSON.stringify({ boardId: "launch", title: "Local prod card", column: "todo" }),
  });
  if (created.status !== 201) miss(`create ${created.status}`);
  let proved = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = spawnSync("pnpm", ["prove", "--run", runId], { cwd: root, env: userEnv, encoding: "utf8" });
    proved = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (result.status === 0 && proved.includes("not exported") && proved.includes("deployment.environment=local-prod")) break;
    await sleep(500);
  }
  if (!proved.includes("not exported") || !proved.includes("deployment.environment=local-prod")) {
    miss(`prove did not find the local-prod run\n${proved}`);
  }
  console.log("phase 10 ok");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  code = 1;
} finally {
  writeFileSync(stamp, originalStamp);
  try {
    if (rebuilt) run("./scripts/up", ["prodlike"], { ...userEnv, KEEL_REBUILD: "1" }, 600000);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    code = 1;
  }
  try {
    await resetBoard(userEnv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    code = 1;
  }
  const local = spawnSync("./scripts/up", { cwd: root, env: userEnv, encoding: "utf8", timeout: 120000 });
  if (local.status !== 0) {
    console.error(local.stderr || local.stdout || "local up failed");
    code = 1;
  }
}
process.exit(code);
