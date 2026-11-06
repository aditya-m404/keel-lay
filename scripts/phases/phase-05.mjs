import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const pg = require("pg");

function miss(message) {
  throw new Error(message);
}

function loadEnv() {
  const file = path.join(root, ".env");
  if (!existsSync(file)) miss("missing .env. Run ./scripts/init and ./scripts/up.");
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    process.env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
}

function runSeed() {
  const result = spawnSync(process.execPath, ["apps/api/src/db/seed.ts"], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
  if (result.status !== 0) miss(result.stderr || result.stdout || "seed failed");
}

async function resetBoard() {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query("DELETE FROM comments");
    await db.query("DELETE FROM idempotency_keys");
    await db.query("DELETE FROM cards");
    await db.query("UPDATE boards SET revision = 1 WHERE id = 'board_launch'");
    runSeed();
  } finally {
    await db.end();
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.status !== 0) miss(`${command} ${args.join(" ")} failed`);
}

function collectorLog() {
  const result = spawnSync("docker", ["compose", "-f", "infra/compose.yaml", "logs", "--no-color", "collector"], {
    cwd: root,
    encoding: "utf8",
  });
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

loadEnv();
if (!process.env.DATABASE_URL || !process.env.KEEL_API_ORIGIN) miss("DATABASE_URL or KEEL_API_ORIGIN is empty.");

const jar = new Map();

function storeCookies(response) {
  for (const header of response.headers.getSetCookie?.() ?? []) {
    const pair = header.split(";")[0];
    const eq = pair.indexOf("=");
    jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}

async function request(method, pathname, { body, headers = {} } = {}) {
  const sent = { accept: "application/json", ...headers };
  if (body !== undefined) sent["content-type"] = "application/json";
  if (jar.size > 0) sent.cookie = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  const response = await fetch(`${process.env.KEEL_API_ORIGIN}${pathname}`, {
    method,
    headers: sent,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  storeCookies(response);
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

let code = 0;
try {
  const health = await fetch(`${process.env.KEEL_API_ORIGIN}/health`);
  if (!health.ok) miss("API is not up. Run ./scripts/up.");
  run("pnpm", ["--filter", "@keel/api", "exec", "vitest", "run", "src/telemetry.test.ts"]);

  jar.clear();
  const signed = await request("POST", "/session", { body: { email: "grace@keel.test", password: "keel-local-only" } });
  if (signed.status !== 201) miss(`sign in ${signed.status}`);
  const created = await request("POST", "/cards", {
    headers: { "idempotency-key": randomUUID(), "x-keel-run-id": "run_phase5" },
    body: { boardId: "launch", title: "Run phase five", column: "todo" },
  });
  if (created.status !== 201) miss(`create ${created.status} ${JSON.stringify(created.json)}`);

  let seen = false;
  let log = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    log = collectorLog();
    const at = log.lastIndexOf("run_phase5");
    if (at >= 0) {
      const window = log.slice(Math.max(0, at - 5000), at + 5000);
      if (window.includes("debug/app")) {
        seen = true;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!seen) miss(`collector log did not show run_phase5 on the app pipeline\n${log.slice(-4000)}`);

  const doctor = spawnSync("./scripts/doctor", { cwd: root, encoding: "utf8", env: process.env });
  if (doctor.status !== 0) miss(doctor.stderr || doctor.stdout || "doctor failed");
  const printed = `${doctor.stdout}\n${doctor.stderr}`;
  if (!printed.includes("pipeline app") || !printed.includes("pipeline infra")) miss(`doctor output\n${printed}`);
  console.log("phase 5 ok");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  code = 1;
} finally {
  await resetBoard();
}
process.exit(code);
