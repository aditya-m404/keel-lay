import path from "node:path";
import pg from "pg";
import { databaseUrl, loadEnv } from "./env.ts";
import { hashPassword } from "./password.ts";

const { Client } = pg;

const SEED_AT = "2026-11-06T00:00:00.000Z";

const USERS = [
  { id: "user_ada", name: "Ada", role: "owner", email: "ada@keel.test" },
  { id: "user_grace", name: "Grace", role: "member", email: "grace@keel.test" },
  { id: "user_linus", name: "Linus", role: "viewer", email: "linus@keel.test" },
] as const;

const TITLES = [
  "Draft the README",
  "Pin the ports",
  "Seed the cast",
  "Session cookie",
  "Board layout",
  "Refuse a viewer",
  "Search titles",
  "Comment on a card",
  "Warm start budget",
  "Doctor script",
  "Two pipelines",
  "Local password",
] as const;

const COLUMNS = ["todo", "doing", "done"] as const;

export type SeedResult = { cards: number; revision: number };

export async function seed(client: pg.Client, password: string): Promise<SeedResult> {
  const hashes = {
    user_ada: hashPassword(password),
    user_grace: hashPassword(password),
    user_linus: hashPassword(password),
  };

  await client.query("BEGIN");
  try {
    for (const user of USERS) {
      await client.query(
        `INSERT INTO users (id, email, name, role, password_hash)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [user.id, user.email, user.name, user.role, hashes[user.id]],
      );
    }

    await client.query(
      `INSERT INTO boards (id, name, revision)
       VALUES ('board_launch', 'Launch', 1)
       ON CONFLICT (id) DO NOTHING`,
    );

    const columnCount = { todo: 0, doing: 0, done: 0 };
    for (let i = 0; i < TITLES.length; i++) {
      const column = COLUMNS[i % 3];
      columnCount[column] += 1;
      const position = columnCount[column] * 1024;
      const authorId = i % 2 === 0 ? "user_ada" : "user_grace";
      const id = `card_${String(i + 1).padStart(2, "0")}`;
      await client.query(
        `INSERT INTO cards
           (id, board_id, title, "column", position, author_id, version, created_at, updated_at)
         VALUES ($1, 'board_launch', $2, $3, $4, $5, 1, $6, $6)
         ON CONFLICT (id) DO NOTHING`,
        [id, TITLES[i], column, position, authorId, SEED_AT],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  const cards = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM cards");
  const board = await client.query<{ revision: string }>(
    "SELECT revision::text AS revision FROM boards WHERE id = 'board_launch'",
  );
  return {
    cards: Number(cards.rows[0]?.count ?? 0),
    revision: Number(board.rows[0]?.revision ?? 0),
  };
}

async function main(): Promise<void> {
  loadEnv();
  if (process.env.KEEL_SEED !== "1") {
    console.log(JSON.stringify({ skipped: true }));
    return;
  }
  const password = process.env.KEEL_SEED_PASSWORD;
  if (!password) throw new Error("KEEL_SEED_PASSWORD is empty.");
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    const result = await seed(client, password);
    console.log(JSON.stringify(result));
  } finally {
    await client.end();
  }
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry.endsWith(`${path.sep}seed.ts`)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
