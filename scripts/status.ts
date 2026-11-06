import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readFile(name: string): Map<string, string> {
  const values = new Map<string, string>();
  const file = path.join(root, name);
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    values.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return values;
}

async function probe(url: string, anyResponse = false): Promise<string> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (response.ok || anyResponse) return "up";
    return `http ${response.status}`;
  } catch {
    return "down";
  }
}

const example = readFile(".env.example");
const env = readFile(".env");
if (env.size === 0 && !existsSync(path.join(root, ".env"))) {
  console.log(".env missing. Run pnpm env:sync");
}

const vendor = env.get("KEEL_COLLECTOR_VENDOR")?.trim() || "debug";
const keelEnv = env.get("KEEL_ENV")?.trim() || "local";
console.log(`env ${keelEnv}`);
console.log(`vendor ${vendor}`);

const checks: [string, string, boolean][] = [
  ["web", `${(env.get("KEEL_WEB_ORIGIN") ?? "http://127.0.0.1:4100").replace(/\/$/, "")}/`, false],
  ["api", `${(env.get("KEEL_API_ORIGIN") ?? "http://127.0.0.1:4101").replace(/\/$/, "")}/health`, false],
  ["studio", `${(env.get("KEEL_STUDIO_ORIGIN") ?? "http://127.0.0.1:4102").replace(/\/$/, "")}/targets`, false],
  ["collector", "http://127.0.0.1:4418/v1/logs", true],
];
for (const [name, url, anyResponse] of checks) {
  console.log(`${name} ${await probe(url, anyResponse)}`);
}

const keys = new Set([...example.keys(), ...env.keys()]);
for (const key of [...keys].sort()) {
  const value = env.get(key);
  console.log(`${key} ${value === undefined ? "missing" : value.trim() === "" ? "empty" : "set"}`);
}

const compose = spawnSync(
  "docker",
  ["compose", "-f", "infra/compose.yaml", "ps", "--format", "{{.Service}} {{.Status}}"],
  { cwd: root, encoding: "utf8" },
);
if (compose.status !== 0) {
  console.log("docker down");
} else {
  const rows = (compose.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  console.log(rows.length === 0 ? "containers none" : rows.map((row) => `container ${row}`).join("\n"));
}
