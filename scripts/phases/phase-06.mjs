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
const composeFile = "infra/compose.local.yaml";

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

function exporters() {
  const doc = yaml.parse(readFileSync(path.join(root, "generated/collector.yaml"), "utf8"));
  return doc;
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
  miss("collector did not answer 127.0.0.1:4418");
}

const userEnv = { ...process.env };
loadEnv(userEnv);

let code = 0;
try {
  if (!userEnv.DATABASE_URL || !userEnv.KEEL_API_ORIGIN) miss("DATABASE_URL or KEEL_API_ORIGIN is empty.");
  const health = await fetch(`${userEnv.KEEL_API_ORIGIN}/health`);
  if (!health.ok) miss("API is not up. Run ./scripts/up.");

  const appKey = "Basic c2FtZS1hY2NvdW50";
  const shared = {
    ...userEnv,
    KEEL_COLLECTOR_VENDOR: "openobserve",
    KEEL_VENDOR_APP_ENDPOINT: "https://api.openobserve.ai/api/keel",
    KEEL_VENDOR_APP_API_KEY: appKey,
    KEEL_VENDOR_INFRA_ENDPOINT: "",
    KEEL_VENDOR_INFRA_API_KEY: "",
  };
  render(shared);
  const doc = exporters();
  const names = Object.keys(doc.exporters);
  if (!names.includes("otlphttp/app") || names.includes("otlphttp/infra")) miss(`exporters ${names.join(", ")}`);
  for (const signal of ["logs", "traces", "metrics"]) {
    const appPipe = doc.service.pipelines[`${signal}/app`].exporters.join(",");
    const infraPipe = doc.service.pipelines[`${signal}/infra`].exporters.join(",");
    if (appPipe !== "otlphttp/app" || infraPipe !== "otlphttp/app") miss(`${signal} app=${appPipe} infra=${infraPipe}`);
  }
  const rendered = readFileSync(path.join(root, "generated/collector.yaml"), "utf8");
  if (rendered.includes(appKey)) miss("rendered config contains the api key");

  const same = spawn(process.execPath, ["scripts/render-collector.ts"], {
    ...shared,
    KEEL_VENDOR_INFRA_API_KEY: appKey,
    KEEL_VENDOR_INFRA_ENDPOINT: "https://api.openobserve.ai/api/keel",
  });
  if (same.status !== 0) miss(same.stderr || same.stdout || "same account render failed");
  const both = exporters();
  const bothNames = Object.keys(both.exporters);
  if (!bothNames.includes("otlphttp/app") || !bothNames.includes("otlphttp/infra")) {
    miss(`same account exporters ${bothNames.join(", ")}`);
  }
  const afterSame = readFileSync(path.join(root, "generated/collector.yaml"), "utf8");
  if (afterSame.includes(appKey)) miss("same account render wrote the api key");

  const split = spawn(process.execPath, ["scripts/render-collector.ts"], {
    ...shared,
    KEEL_VENDOR_INFRA_API_KEY: "Basic aW5mcmEtYWNjb3VudA==",
    KEEL_VENDOR_INFRA_ENDPOINT: "https://api.openobserve.ai/api/keel-infra",
  });
  if (split.status !== 0) miss(split.stderr || split.stdout || "split account render failed");
  const splitDoc = exporters();
  const appExport = splitDoc.service.pipelines["logs/app"].exporters.join(",");
  const infraExport = splitDoc.service.pipelines["logs/infra"].exporters.join(",");
  if (appExport !== "otlphttp/app" || infraExport !== "otlphttp/infra") miss(`split app=${appExport} infra=${infraExport}`);

  const fresh = `run_phase6_fresh_${randomUUID()}`;
  const proved = spawn("pnpm", ["prove", "--run", fresh], { ...userEnv, KEEL_COLLECTOR_VENDOR: "debug" });
  if (proved.status !== 0) miss(proved.stderr || proved.stdout || "debug prove failed");
  const proveOut = `${proved.stdout ?? ""}\n${proved.stderr ?? ""}`;
  if (!proveOut.includes("not exported")) miss(`debug prove output\n${proveOut}`);

  const vendor = (userEnv.KEEL_COLLECTOR_VENDOR || "debug").trim();
  const userApp = (userEnv.KEEL_VENDOR_APP_API_KEY || "").trim();
  const userInfra = (userEnv.KEEL_VENDOR_INFRA_API_KEY || "").trim();
  if (vendor === "openobserve" && userApp && (userInfra || userApp)) {
    console.log("skipped: a canned run id is not an export from this check");
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
      ["compose", "-f", composeFile, "up", "-d", "--force-recreate", "--no-deps", "collector"],
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
}
process.exit(code);
