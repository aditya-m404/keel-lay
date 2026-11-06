import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { databaseUrl, loadEnv } from "./env.ts";

const { Client } = pg;

function migrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, "migrations"), path.resolve(here, "../../migrations"), path.resolve(here, "../migrations")];
  for (const dir of candidates) {
    if (existsSync(dir) && readdirSync(dir).some((name) => name.endsWith(".sql"))) return dir;
  }
  throw new Error("migrations not found");
}

export async function migrate(client: pg.Client): Promise<string[]> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const applied = await client.query<{ id: string }>("SELECT id FROM schema_migrations");
  const done = new Set(applied.rows.map((row) => row.id));
  const files = readdirSync(migrationsDir())
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const ran: string[] = [];
  for (const name of files) {
    if (done.has(name)) continue;
    const sql = readFileSync(path.join(migrationsDir(), name), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [name]);
    ran.push(name);
  }
  return ran;
}

async function main(): Promise<void> {
  loadEnv();
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    const ran = await migrate(client);
    console.log(ran.length === 0 ? "migrations up to date" : `migrated ${ran.join(", ")}`);
  } finally {
    await client.end();
  }
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry.endsWith(`${path.sep}migrate.ts`)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
