import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const pg = require("pg");
const dup = path.join(root, "packages/journeys/phase9-duplicate.yaml");

function miss(message) {
  throw new Error(message);
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

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

const userEnv = { ...process.env };
loadEnv(userEnv);

let code = 0;
try {
  if (!userEnv.KEEL_API_ORIGIN) miss("KEEL_API_ORIGIN is empty.");
  const health = await fetch(`${userEnv.KEEL_API_ORIGIN}/health`);
  if (!health.ok) miss("API is not up. Run ./scripts/up.");

  const checked = spawnSync("pnpm", ["journeys:check"], { cwd: root, env: userEnv, encoding: "utf8" });
  const output = `${checked.stdout ?? ""}\n${checked.stderr ?? ""}`;
  if (checked.status !== 0) miss(output || "journeys:check failed");
  if (!output.includes("executed comment POST /cards/card_01/comments 201")) miss(`comment did not return 201\n${output}`);
  if (!output.includes("executed search GET /search?q=readme 200 card_01")) miss(`search did not return card_01\n${output}`);

  writeFileSync(
    dup,
    `id: create-card
title: Duplicate
actor: grace
actors: [member]
steps:
  - id: sign-in
    ui:
      - { see: Sign in }
    api:
      method: GET
      path: /health
      expect: 200
    thinkMs: { min: 100, max: 200 }
`,
  );
  const rejected = spawnSync("pnpm", ["journeys:check"], { cwd: root, env: userEnv, encoding: "utf8" });
  const rejectedOut = `${rejected.stdout ?? ""}\n${rejected.stderr ?? ""}`;
  if (rejected.status === 0 || !rejectedOut.includes("duplicate")) miss(rejectedOut || "duplicate journey was accepted");
  rmSync(dup, { force: true });

  const skill = walk(path.join(root, "skills/keel-journey")).map((file) => readFileSync(file, "utf8")).join("\n");
  if (skill.includes("POST /runs")) miss("the skill starts a run");
  if (/KEEL_VENDOR_|api[_-]?key\s*[:=]\s*['"][^'"]+/i.test(skill)) miss("the skill holds a vendor key");
  console.log("phase 9 ok");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  code = 1;
} finally {
  rmSync(dup, { force: true });
  try {
    await resetBoard(userEnv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    code = 1;
  }
}
process.exit(code);
