import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const pg = require("pg");
const yaml = createRequire(new URL("../../packages/otel/package.json", import.meta.url))("yaml");

const appOrigin = "http://127.0.0.1:15081";
const auth = `Basic ${Buffer.from("ada@keel.test:keel-local-only").toString("base64")}`;
const runId = `run_phase6_${randomUUID().slice(0, 8)}`;

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
  const result = spawnSync(process.execPath, ["apps/api/src/db/seed.ts"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
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

function spawn(command, args, env) {
  return spawnSync(command, args, { cwd: root, env, encoding: "utf8" });
}

function render(env) {
  const result = spawn(process.execPath, ["scripts/render-collector.ts"], env);
  if (result.status !== 0) miss(result.stderr || result.stdout || "render failed");
  return result;
}

function compose(args, env) {
  const result = spawn("docker", ["compose", "-f", "infra/compose.yaml", ...args], env);
  if (result.status !== 0) miss(`${args.join(" ")}\n${result.stderr || result.stdout}`);
  return result;
}

function collectorLog() {
  const result = spawn("docker", ["compose", "-f", "infra/compose.yaml", "logs", "--no-color", "collector"], process.env);
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

async function waitCollector() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await fetch("http://127.0.0.1:4418/v1/logs", { method: "POST" });
      return;
    } catch {
      await sleep(250);
    }
  }
  miss(`collector did not answer 127.0.0.1:4418\n${collectorLog().slice(-2000)}`);
}

async function waitOpenObserve() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(`${appOrigin}/healthz`);
      if (response.ok) return;
    } catch {
      // container still booting
    }
    await sleep(1000);
  }
  miss("openobserve did not answer 127.0.0.1:15081");
}

async function ensureOrg(name) {
  const response = await fetch(`${appOrigin}/api/organizations`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ identifier: name, name, label: name }),
  });
  const text = await response.text();
  if (response.ok || response.status === 409 || /already|exist/i.test(text)) return;
  miss(`create org ${name} ${response.status} ${text.slice(0, 300)}`);
}

async function streamNames(org, type) {
  const response = await fetch(`${appOrigin}/api/${org}/streams?type=${type}`, {
    headers: { authorization: auth },
  });
  if (!response.ok) return [];
  const text = await response.text();
  const names = new Set();
  try {
    const parsed = JSON.parse(text);
    for (const item of parsed.list ?? []) if (item.name) names.add(item.name);
  } catch {
    // fall through to the text scan
  }
  for (const match of text.matchAll(/"name"\s*:\s*"([^"]+)"/g)) names.add(match[1]);
  return [...names];
}

async function search(org, type, sql) {
  const now = Date.now();
  const response = await fetch(`${appOrigin}/api/${org}/_search?type=${type}`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({
      query: {
        sql,
        start_time: (now - 30 * 60 * 1000) * 1000,
        end_time: (now + 5 * 60 * 1000) * 1000,
        from: 0,
        size: 50,
      },
    }),
  });
  return { status: response.status, text: await response.text() };
}

function hitsHaveRun(text, id) {
  try {
    const parsed = JSON.parse(text);
    return (parsed.hits ?? []).some((hit) => JSON.stringify(hit).includes(id));
  } catch {
    return false;
  }
}

async function orgHas(org, type, id) {
  const names = await streamNames(org, type);
  const streams = names.length > 0 ? names : ["default"];
  for (const name of streams) {
    const quoted = `"${name.replaceAll('"', "")}"`;
    for (const sql of [`SELECT * FROM ${quoted} WHERE keel_run_id = '${id}'`, `SELECT * FROM ${quoted}`]) {
      const result = await search(org, type, sql);
      if (result.status === 200 && hitsHaveRun(result.text, id)) return true;
    }
  }
  return false;
}

const jar = new Map();

function storeCookies(response) {
  for (const header of response.headers.getSetCookie?.() ?? []) {
    const pair = header.split(";")[0];
    const eq = pair.indexOf("=");
    jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}

async function request(method, pathname, env, { body, headers = {} } = {}) {
  const sent = { accept: "application/json", ...headers };
  if (body !== undefined) sent["content-type"] = "application/json";
  if (jar.size > 0) sent.cookie = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  const response = await fetch(`${env.KEEL_API_ORIGIN}${pathname}`, {
    method,
    headers: sent,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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

  const appKey = auth;
  const filled = {
    ...userEnv,
    KEEL_COLLECTOR_VENDOR: "openobserve",
    KEEL_VENDOR_APP_ENDPOINT: "http://openobserve:5080/api/keel-app",
    KEEL_VENDOR_APP_API_KEY: appKey,
    KEEL_VENDOR_INFRA_ENDPOINT: "",
    KEEL_VENDOR_INFRA_API_KEY: "",
  };
  render(filled);
  const doc = yaml.parse(readFileSync(path.join(root, "generated/collector.yaml"), "utf8"));
  const names = Object.keys(doc.exporters);
  const otlp = names.filter((name) => name.startsWith("otlphttp/"));
  const debug = names.filter((name) => name.startsWith("debug/"));
  if (otlp.length !== 1 || debug.length !== 1) miss(`exporters ${names.join(", ")}`);
  if (otlp[0] !== "otlphttp/app" || debug[0] !== "debug/infra") miss(`exporters ${names.join(", ")}`);
  for (const signal of ["logs", "traces", "metrics"]) {
    const appPipe = doc.service.pipelines[`${signal}/app`].exporters.join(",");
    const infraPipe = doc.service.pipelines[`${signal}/infra`].exporters.join(",");
    if (appPipe !== "otlphttp/app" || infraPipe !== "debug/infra") miss(`${signal} app=${appPipe} infra=${infraPipe}`);
  }
  const rendered = readFileSync(path.join(root, "generated/collector.yaml"), "utf8");
  if (rendered.includes(appKey)) miss("rendered config contains the api key");

  compose(["--profile", "openobserve", "up", "-d", "openobserve"], filled);
  await waitOpenObserve();
  await ensureOrg("keel-app");
  await ensureOrg("keel-infra");
  compose(["up", "-d", "--force-recreate", "--no-deps", "collector"], filled);
  await waitCollector();

  jar.clear();
  const signed = await request("POST", "/session", userEnv, {
    body: { email: "grace@keel.test", password: "keel-local-only" },
  });
  if (signed.status !== 201) miss(`sign in ${signed.status}`);
  const created = await request("POST", "/cards", userEnv, {
    headers: { "idempotency-key": randomUUID(), "x-keel-run-id": runId },
    body: { boardId: "launch", title: "Run phase six", column: "todo" },
  });
  if (created.status !== 201) miss(`create ${created.status} ${JSON.stringify(created.json)}`);

  let inApp = false;
  let cpuOnDebug = false;
  let lastLog = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!inApp) {
      const logs = await orgHas("keel-app", "logs", runId);
      const spans = await orgHas("keel-app", "traces", runId);
      inApp = logs && spans;
    }
    if (!cpuOnDebug) {
      lastLog = collectorLog();
      const at = lastLog.toLowerCase().lastIndexOf("system.cpu");
      if (at >= 0) {
        const window = lastLog.slice(Math.max(0, at - 8000), at + 8000);
        if (window.includes("debug/infra")) cpuOnDebug = true;
      }
    }
    if (inApp && cpuOnDebug) break;
    await sleep(1000);
  }
  if (!inApp) miss(`run id ${runId} was not in the app org`);
  if (!cpuOnDebug) miss(`cpu sample was not on the debug log\n${lastLog.slice(-2500)}`);

  const kept = readFileSync(path.join(root, "generated/collector.yaml"), "utf8");
  const duplicate = spawn(process.execPath, ["scripts/render-collector.ts"], {
    ...filled,
    KEEL_VENDOR_APP_API_KEY: "same-slot-key",
    KEEL_VENDOR_INFRA_API_KEY: "same-slot-key",
    KEEL_VENDOR_INFRA_ENDPOINT: "http://openobserve:5080/api/keel-infra",
  });
  if (duplicate.status === 0) miss("duplicate key render exited 0");
  const named = `${duplicate.stderr ?? ""}\n${duplicate.stdout ?? ""}`;
  if (!named.includes("duplicate") || !named.includes("app") || !named.includes("infra")) {
    miss(`duplicate render did not name the slots\n${named}`);
  }
  const after = readFileSync(path.join(root, "generated/collector.yaml"), "utf8");
  if (after !== kept) miss("duplicate render wrote the collector file");

  const fresh = `run_phase6_fresh_${randomUUID()}`;
  const proved = spawn("pnpm", ["prove", "--run", fresh], userEnv);
  if (proved.status !== 0) miss(proved.stderr || proved.stdout || "debug prove failed");
  const proveOut = `${proved.stdout ?? ""}\n${proved.stderr ?? ""}`;
  if (!proveOut.includes("not exported")) miss(`debug prove output\n${proveOut}`);

  const vendor = (userEnv.KEEL_COLLECTOR_VENDOR || "debug").trim();
  const userApp = (userEnv.KEEL_VENDOR_APP_API_KEY || "").trim();
  const userInfra = (userEnv.KEEL_VENDOR_INFRA_API_KEY || "").trim();
  if (vendor === "openobserve" && userApp && userInfra) {
    const live = spawn("pnpm", ["prove", "--run", "run_demo"], userEnv);
    if (live.status !== 0) miss(live.stderr || live.stdout || "prove failed");
  } else {
    console.log("skipped: no vendor");
  }
  console.log("phase 6 ok");
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
  const restored = spawn(process.execPath, ["scripts/render-collector.ts"], userEnv);
  if (restored.status !== 0) {
    console.error(restored.stderr || restored.stdout || "restore render failed");
    code = 1;
  } else {
    const collector = spawn(
      "docker",
      ["compose", "-f", "infra/compose.yaml", "up", "-d", "--force-recreate", "--no-deps", "collector"],
      userEnv,
    );
    if (collector.status !== 0) {
      console.error(collector.stderr || collector.stdout || "restore collector failed");
      code = 1;
    } else {
      try {
        await waitCollector();
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        code = 1;
      }
    }
  }
  spawn("docker", ["compose", "-f", "infra/compose.yaml", "--profile", "openobserve", "stop", "openobserve"], userEnv);
}
process.exit(code);
