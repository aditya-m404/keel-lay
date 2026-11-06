import { spawnSync } from "node:child_process";
import { scrypt, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const scryptAsync = promisify(scrypt);
const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const pg = require("pg");

function miss(message) {
  console.error(message);
  process.exit(1);
}

function loadEnv() {
  const file = path.join(root, ".env");
  if (!existsSync(file)) miss("missing .env. Run ./scripts/init and ./scripts/up.");
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    process.env[key] = trimmed.slice(eq + 1);
  }
  if (!process.env.DATABASE_URL) miss("DATABASE_URL is empty.");
}

async function verifies(password, stored) {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  const actual = await scryptAsync(password, salt, expected.length, {
    N: Number(parts[1]),
    r: Number(parts[2]),
    p: Number(parts[3]),
  });
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function runSeed() {
  const result = spawnSync(process.execPath, ["apps/api/src/db/seed.ts"], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    miss(result.stderr || result.stdout || "seed failed");
  }
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    miss(`seed did not return JSON: ${result.stdout}`);
  }
  return parsed;
}

loadEnv();
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  const migrations = await client.query("SELECT id FROM schema_migrations WHERE id = $1", [
    "001_init.sql",
  ]);
  if (migrations.rowCount !== 1) miss("schema_migrations is missing 001_init.sql");

  const users = await client.query("SELECT id, role, email FROM users ORDER BY id");
  const expectedUsers = [
    ["user_ada", "owner", "ada@keel.test"],
    ["user_grace", "member", "grace@keel.test"],
    ["user_linus", "viewer", "linus@keel.test"],
  ];
  const gotUsers = users.rows.map((row) => [row.id, row.role, row.email]);
  if (JSON.stringify(gotUsers) !== JSON.stringify(expectedUsers)) {
    miss(`users are ${JSON.stringify(gotUsers)}`);
  }

  const board = await client.query("SELECT name, revision FROM boards WHERE id = 'board_launch'");
  if (board.rowCount !== 1 || board.rows[0].name !== "Launch" || Number(board.rows[0].revision) !== 1) {
    miss("board_launch is missing or revision is not 1");
  }

  const cards = await client.query("SELECT id FROM cards ORDER BY id");
  const ids = cards.rows.map((row) => row.id);
  const expectedIds = Array.from({ length: 12 }, (_, i) => `card_${String(i + 1).padStart(2, "0")}`);
  if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) miss(`cards are ${JSON.stringify(ids)}`);

  const second = runSeed();
  if (second.cards !== 12 || second.revision !== 1) {
    miss(`second seed returned ${JSON.stringify(second)}`);
  }
  const after = await client.query(
    "SELECT count(*)::int AS cards, (SELECT revision FROM boards WHERE id = 'board_launch') AS revision FROM cards",
  );
  if (after.rows[0].cards !== 12 || Number(after.rows[0].revision) !== 1) {
    miss(`after second seed: ${JSON.stringify(after.rows[0])}`);
  }

  const grace = await client.query("SELECT password_hash FROM users WHERE id = 'user_grace'");
  const hash = grace.rows[0]?.password_hash;
  if (!hash) miss("Grace has no password hash");
  if (!(await verifies("keel-local-only", hash))) miss("Grace's hash rejected keel-local-only");
  if (await verifies("wrong", hash)) miss("Grace's hash accepted 'wrong'");

  const columns = await client.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND data_type IN ('text', 'character varying', 'json', 'jsonb')`,
  );
  for (const column of columns.rows) {
    const found = await client.query(
      `SELECT 1 FROM ${quoteIdent(column.table_name)} WHERE ${quoteIdent(column.column_name)}::text LIKE $1 LIMIT 1`,
      ["%keel-local-only%"],
    );
    if (found.rowCount > 0) {
      miss(`plaintext password is in ${column.table_name}.${column.column_name}`);
    }
  }
} finally {
  await client.end();
}

console.log("phase 1 ok");

function quoteIdent(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) miss(`unexpected identifier ${name}`);
  return `"${name}"`;
}
