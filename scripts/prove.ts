import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile() {
  const file = path.join(root, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    if (process.env[key] === undefined) process.env[key] = trimmed.slice(eq + 1);
  }
}

function runId(): string {
  const args = process.argv.slice(2);
  const flag = args.indexOf("--run");
  if (flag >= 0 && args[flag + 1]) return args[flag + 1];
  const positional = args.find((arg) => !arg.startsWith("-"));
  if (!positional) {
    console.error("usage: pnpm prove --run <id>");
    process.exit(1);
  }
  return positional;
}

function notExported(id: string): void {
  const result = spawnSync(
    "docker",
    ["compose", "-f", "infra/compose.yaml", "logs", "--since", "5m", "--no-color", "collector"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const log = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  let from = 0;
  while (from < log.length) {
    const at = log.indexOf(id, from);
    if (at < 0) break;
    const window = log.slice(Math.max(0, at - 80000), at + 4000);
    const match = window.match(/deployment\.environment: Str\(([^)]+)\)/);
    if (match) {
      console.log(`found ${id}`);
      console.log(`deployment.environment=${match[1]}`);
      break;
    }
    from = at + id.length;
  }
  console.log("not exported");
  process.exit(0);
}

function orgFrom(endpoint: string, site: string | undefined): { origin: string; org: string } {
  const url = new URL(endpoint);
  if (url.hostname === "openobserve") {
    url.hostname = "127.0.0.1";
    url.port = "15081";
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const api = parts.indexOf("api");
  const org = (api >= 0 ? parts[api + 1] : "") || site?.trim() || "";
  if (!org) throw new Error(`endpoint ${endpoint} has no org`);
  return { origin: url.origin, org };
}

async function search(origin: string, org: string, key: string, type: string, sql: string): Promise<string> {
  const now = Date.now();
  const response = await fetch(`${origin}/api/${encodeURIComponent(org)}/_search?type=${type}`, {
    method: "POST",
    headers: { authorization: key, "content-type": "application/json" },
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
  const text = await response.text();
  if (!response.ok) throw new Error(`${type} ${response.status} ${text.slice(0, 240)}`);
  return text;
}

async function streamNames(origin: string, org: string, key: string, type: string): Promise<string[]> {
  const response = await fetch(`${origin}/api/${encodeURIComponent(org)}/streams?type=${type}`, {
    headers: { authorization: key },
  });
  const text = await response.text();
  if (!response.ok) return [];
  const names = new Set<string>();
  const parsed = JSON.parse(text) as { list?: { name?: string }[] };
  for (const item of parsed.list ?? []) {
    if (item.name) names.add(item.name);
  }
  if (names.size === 0) {
    for (const match of text.matchAll(/"name"\s*:\s*"([^"]+)"/g)) names.add(match[1]);
  }
  return [...names];
}

function quoteStream(name: string): string {
  return `"${name.replaceAll('"', "")}"`;
}

function hitsHaveRun(text: string, id: string): boolean {
  try {
    const parsed = JSON.parse(text) as { hits?: unknown[] };
    return (parsed.hits ?? []).some((hit) => JSON.stringify(hit).includes(id));
  } catch {
    return false;
  }
}

async function containsRun(origin: string, org: string, key: string, type: string, id: string): Promise<boolean> {
  const names = await streamNames(origin, org, key, type);
  const streams = names.length > 0 ? names : ["default"];
  for (const name of streams) {
    const quoted = quoteStream(name);
    for (const query of [`SELECT * FROM ${quoted} WHERE keel_run_id = '${id}'`, `SELECT * FROM ${quoted}`]) {
      try {
        const text = await search(origin, org, key, type, query);
        if (hitsHaveRun(text, id)) return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

async function durationQueryable(origin: string, org: string, key: string): Promise<boolean> {
  const names = await streamNames(origin, org, key, "metrics");
  const match = names.find((name) => name.toLowerCase().replaceAll(".", "_") === "http_server_request_duration");
  if (!match) return false;
  await search(origin, org, key, "metrics", `SELECT * FROM ${quoteStream(match)}`);
  return true;
}

loadEnvFile();
const id = runId();
const vendor = (process.env.KEEL_COLLECTOR_VENDOR || "debug").trim();
const appKey = process.env.KEEL_VENDOR_APP_API_KEY?.trim() ?? "";
const infraKey = process.env.KEEL_VENDOR_INFRA_API_KEY?.trim() ?? "";
const appEndpoint = process.env.KEEL_VENDOR_APP_ENDPOINT?.trim() ?? "";
const infraEndpoint = process.env.KEEL_VENDOR_INFRA_ENDPOINT?.trim() ?? "";

if (vendor !== "openobserve" || !appKey || !infraKey || !appEndpoint || !infraEndpoint) notExported(id);

const app = orgFrom(appEndpoint, process.env.KEEL_VENDOR_APP_SITE);
const infra = orgFrom(infraEndpoint, process.env.KEEL_VENDOR_INFRA_SITE);

const [appLog, appSpan, infraLog, duration] = await Promise.all([
  containsRun(app.origin, app.org, appKey, "logs", id),
  containsRun(app.origin, app.org, appKey, "traces", id),
  containsRun(infra.origin, infra.org, infraKey, "logs", id),
  durationQueryable(app.origin, app.org, appKey),
]);

if (appLog && appSpan && !infraLog && duration) process.exit(0);

console.error(
  `prove failed for ${id}: app log ${appLog}, app span ${appSpan}, infra log ${infraLog}, duration ${duration}`,
);
process.exit(1);
