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
    const key = trimmed.slice(0, eq);
    if (process.env[key] === undefined) process.env[key] = trimmed.slice(eq + 1);
  }
}

loadEnv();
const origin = process.env.KEEL_API_ORIGIN;
if (!origin || !process.env.DATABASE_URL) miss("KEEL_API_ORIGIN or DATABASE_URL is empty.");

const jar = new Map();

function storeCookies(response) {
  for (const header of response.headers.getSetCookie?.() ?? []) {
    const [pair, ...attrs] = header.split(";").map((part) => part.trim());
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const maxAge = attrs.find((attr) => attr.toLowerCase().startsWith("max-age="));
    if (maxAge && Number(maxAge.split("=")[1]) === 0) jar.delete(name);
    else jar.set(name, value);
  }
}

async function request(method, pathname, { body, auth = true, headers = {} } = {}) {
  const sent = { ...headers };
  if (body !== undefined) sent["content-type"] = "application/json";
  if (auth && jar.size > 0) sent.cookie = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: sent,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  storeCookies(response);
  const text = await response.text();
  let json = null;
  if (text) json = JSON.parse(text);
  return { status: response.status, json, replay: response.headers.get("x-keel-idempotent") };
}

async function signIn(email) {
  jar.clear();
  const signed = await request("POST", "/session", {
    auth: false,
    body: { email, password: "keel-local-only" },
  });
  if (signed.status !== 201) miss(`sign in ${email} ${signed.status}`);
}

function runSeed() {
  const result = spawnSync(process.execPath, ["apps/api/src/db/seed.ts"], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
  if (result.status !== 0) miss(result.stderr || result.stdout || "seed failed");
}

async function resetBoard(client) {
  await client.query("DELETE FROM comments");
  await client.query("DELETE FROM idempotency_keys");
  await client.query("DELETE FROM cards");
  await client.query("UPDATE boards SET revision = 1 WHERE id = 'board_launch'");
  runSeed();
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

try {
  await resetBoard(db);
  await signIn("grace@keel.test");

  const key = randomUUID();
  const created = await request("POST", "/cards", {
    headers: { "idempotency-key": key },
    body: { boardId: "launch", title: "Check the collector", column: "todo" },
  });
  if (created.status !== 201 || created.json?.card?.title !== "Check the collector") {
    miss(`create ${created.status} ${JSON.stringify(created.json)}`);
  }
  const board = await request("GET", "/boards/launch");
  if (board.json?.board?.revision !== 2 || board.json?.cards?.length !== 13) {
    miss(`after create revision=${board.json?.board?.revision} cards=${board.json?.cards?.length}`);
  }
  const replay = await request("POST", "/cards", {
    headers: { "idempotency-key": key },
    body: { boardId: "launch", title: "Check the collector", column: "todo" },
  });
  if (replay.status !== 201 || replay.json?.card?.id !== created.json.card.id || replay.replay !== "replay") {
    miss(`replay ${replay.status} header=${replay.replay} id=${replay.json?.card?.id}`);
  }
  const afterReplay = await request("GET", "/boards/launch");
  if (afterReplay.json.cards.length !== 13 || afterReplay.json.board.revision !== 2) {
    miss(`replay wrote a second card: ${afterReplay.json.cards.length}`);
  }
  const reused = await request("POST", "/cards", {
    headers: { "idempotency-key": key },
    body: { boardId: "launch", title: "A different title", column: "todo" },
  });
  if (reused.status !== 409 || reused.json?.error?.code !== "conflict") {
    miss(`reused key ${reused.status} ${JSON.stringify(reused.json)}`);
  }

  const blank = await request("POST", "/cards", {
    headers: { "idempotency-key": randomUUID() },
    body: { boardId: "launch", title: "  ", column: "todo" },
  });
  const still = await request("GET", "/boards/launch");
  if (blank.status !== 400 || blank.json?.error?.code !== "invalid_title" || still.json.board.revision !== 2) {
    miss(`blank title ${blank.status} ${JSON.stringify(blank.json)} revision=${still.json.board.revision}`);
  }

  await signIn("linus@keel.test");
  const viewerCreate = await request("POST", "/cards", {
    headers: { "idempotency-key": randomUUID() },
    body: { boardId: "launch", title: "Linus card", column: "todo" },
  });
  const viewerMove = await request("PATCH", "/cards/card_01", {
    headers: { "if-match": "1" },
    body: { column: "doing" },
  });
  const untouched = await request("GET", "/cards/card_01");
  if (viewerCreate.status !== 403 || viewerCreate.json?.error?.code !== "forbidden") {
    miss(`linus create ${viewerCreate.status} ${JSON.stringify(viewerCreate.json)}`);
  }
  if (viewerMove.status !== 403 || viewerMove.json?.error?.code !== "forbidden") {
    miss(`linus move ${viewerMove.status}`);
  }
  if (untouched.json?.card?.column !== "todo" || untouched.json?.card?.version !== 1) {
    miss(`card_01 changed ${JSON.stringify(untouched.json?.card)}`);
  }

  await signIn("grace@keel.test");
  const graceMove = await request("PATCH", "/cards/card_01", {
    headers: { "if-match": "1" },
    body: { column: "doing" },
  });
  if (graceMove.status !== 403 || graceMove.json?.error?.code !== "forbidden") {
    miss(`grace move ${graceMove.status} ${JSON.stringify(graceMove.json)}`);
  }

  await signIn("ada@keel.test");
  const adaMove = await request("PATCH", "/cards/card_01", {
    headers: { "if-match": "1" },
    body: { column: "doing" },
  });
  if (adaMove.status !== 200 || adaMove.json?.card?.column !== "doing" || !adaMove.json?.card?.title) {
    miss(`ada move ${adaMove.status} ${JSON.stringify(adaMove.json)}`);
  }
  const stale = await request("PATCH", "/cards/card_01", {
    headers: { "if-match": "1" },
    body: { column: "done" },
  });
  if (stale.status !== 409 || stale.json?.error?.code !== "conflict") {
    miss(`stale move ${stale.status} ${JSON.stringify(stale.json)}`);
  }
  if (stale.json.error.card.version !== adaMove.json.card.version || stale.json.error.card.column !== "doing") {
    miss(`conflict card ${JSON.stringify(stale.json.error.card)}`);
  }

  const comment = await request("POST", "/cards/card_01/comments", {
    headers: { "idempotency-key": randomUUID() },
    body: { body: "Queue is draining." },
  });
  if (comment.status !== 201 || comment.json?.comment?.body !== "Queue is draining." || !comment.json?.card?.title) {
    miss(`comment ${comment.status} ${JSON.stringify(comment.json)}`);
  }
  const detail = await request("GET", "/cards/card_01");
  const foundComment = detail.json?.comments?.find((item) => item.body === "Queue is draining.");
  if (detail.status !== 200 || !foundComment || foundComment.authorId !== "user_ada") {
    miss(`card detail ${detail.status} ${JSON.stringify(detail.json?.comments)}`);
  }

  const search = await request("GET", "/search?q=readme");
  const titles = (search.json?.cards ?? []).map((card) => card.title);
  if (search.status !== 200 || search.json?.query !== "readme") miss(`search ${search.status}`);
  if (!titles.includes("Draft the README") || titles.includes("Pin the ports")) {
    miss(`search titles ${JSON.stringify(titles)}`);
  }

  const before = await request("GET", "/boards/launch");
  const since = before.json.board.revision;
  const extra = await request("POST", "/cards", {
    headers: { "idempotency-key": randomUUID() },
    body: { boardId: "launch", title: "Changes feed card", column: "todo" },
  });
  if (extra.status !== 201) miss(`changes create ${extra.status}`);
  const delta = await request("GET", `/boards/launch/changes?since=${since}`);
  if (delta.status !== 200 || delta.json.cards.length !== 1 || delta.json.cards[0].id !== extra.json.card.id) {
    miss(`delta ${JSON.stringify(delta.json)}`);
  }
  if (delta.json.comments.length !== 0 || delta.json.removedCardIds.length !== 0) {
    miss(`delta was not card-only ${JSON.stringify(delta.json)}`);
  }
  const quiet = await request("GET", `/boards/launch/changes?since=${delta.json.revision}`);
  if (quiet.json.cards.length !== 0 || quiet.json.comments.length !== 0) {
    miss(`quiet delta ${JSON.stringify(quiet.json)}`);
  }
  const missingSince = await request("GET", "/boards/launch/changes");
  const ahead = await request("GET", `/boards/launch/changes?since=${delta.json.revision + 1}`);
  if (missingSince.status !== 400 || ahead.status !== 400) {
    miss(`bad since ${missingSince.status} ${ahead.status}`);
  }

  console.log("phase 3 ok");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await resetBoard(db);
  await db.end();
}
