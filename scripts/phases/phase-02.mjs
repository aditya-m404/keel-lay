import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

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
    process.env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
}

loadEnv();
const origin = process.env.KEEL_API_ORIGIN;
if (!origin) miss("KEEL_API_ORIGIN is empty.");

const jar = new Map();

function storeCookies(response) {
  const headers = response.headers.getSetCookie?.() ?? [];
  for (const header of headers) {
    const [pair, ...attrs] = header.split(";").map((part) => part.trim());
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const maxAge = attrs.find((attr) => attr.toLowerCase().startsWith("max-age="));
    if (maxAge && Number(maxAge.split("=")[1]) === 0) jar.delete(name);
    else jar.set(name, value);
  }
  return headers.join("\n");
}

function cookieHeader() {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function request(method, pathname, { body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth && jar.size > 0) headers.cookie = cookieHeader();
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = storeCookies(response);
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      miss(`${method} ${pathname} returned non-JSON: ${text}`);
    }
  }
  return { status: response.status, json, text, setCookie };
}

const health = await request("GET", "/health", { auth: false });
if (health.status !== 200 || health.json?.ok !== true) miss(`GET /health ${health.status}`);
const ready = await request("GET", "/ready", { auth: false });
if (ready.status !== 200 || ready.json?.ok !== true) miss(`GET /ready ${ready.status}`);

const grace = await request("POST", "/session", {
  auth: false,
  body: { email: "grace@keel.test", password: "keel-local-only" },
});
if (grace.status !== 201 || grace.json?.user?.role !== "member" || grace.json?.user?.id !== "user_grace") {
  miss(`POST /session ${grace.status} ${JSON.stringify(grace.json)}`);
}
if (!/httponly/i.test(grace.setCookie) || !/samesite=lax/i.test(grace.setCookie)) {
  miss(`Set-Cookie missing HttpOnly or SameSite=Lax: ${grace.setCookie}`);
}

const wrong = await request("POST", "/session", {
  auth: false,
  body: { email: "grace@keel.test", password: "wrong" },
});
const nobody = await request("POST", "/session", {
  auth: false,
  body: { email: "nobody@keel.test", password: "keel-local-only" },
});
if (wrong.status !== 401 || nobody.status !== 401) miss(`credential status ${wrong.status} ${nobody.status}`);
if (JSON.stringify(wrong.json) !== JSON.stringify(nobody.json)) {
  miss(`credential bodies differ ${JSON.stringify(wrong.json)} vs ${JSON.stringify(nobody.json)}`);
}
if (wrong.json?.error?.code !== "invalid_credentials" || wrong.json?.error?.message !== "Email or password is wrong.") {
  miss(`credential error ${JSON.stringify(wrong.json)}`);
}

const me = await request("GET", "/session");
if (me.status !== 200 || me.json?.user?.id !== "user_grace" || me.json?.user?.name !== "Grace") {
  miss(`GET /session ${me.status} ${JSON.stringify(me.json)}`);
}
const anon = await request("GET", "/session", { auth: false });
if (anon.status !== 401 || anon.json?.error?.code !== "unauthenticated") {
  miss(`GET /session without cookie ${anon.status} ${JSON.stringify(anon.json)}`);
}

const board = await request("GET", "/boards/launch");
if (board.status !== 200 || board.json?.board?.revision !== 1 || board.json?.cards?.length !== 12) {
  miss(`GET /boards/launch ${board.status} ${JSON.stringify(board.json?.board)} cards=${board.json?.cards?.length}`);
}
const byColumn = { todo: [], doing: [], done: [] };
for (const card of board.json.cards) byColumn[card.column].push(card);
for (const column of ["todo", "doing", "done"]) {
  if (byColumn[column].length !== 4) miss(`${column} has ${byColumn[column].length} cards`);
}
if (byColumn.todo[0].id !== "card_01") miss(`first todo card is ${byColumn.todo[0]?.id}`);

const missing = await request("GET", "/boards/missing");
if (missing.status !== 404) miss(`GET /boards/missing ${missing.status}`);
const hidden = await request("GET", "/boards/launch", { auth: false });
if (hidden.status !== 401) miss(`GET /boards/launch without cookie ${hidden.status}`);

const saved = cookieHeader();
const deleted = await request("DELETE", "/session");
if (deleted.status !== 204 || deleted.text !== "") miss(`DELETE /session ${deleted.status} body=${deleted.text}`);
const after = await fetch(`${origin}/session`, { headers: { cookie: saved } });
if (after.status !== 401) miss(`GET /session after delete ${after.status}`);

console.log("phase 2 ok");
