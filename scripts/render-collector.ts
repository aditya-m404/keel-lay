import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(new URL("../packages/otel/package.json", import.meta.url));
const yaml = require("yaml") as {
  parse: (text: string) => unknown;
  stringify: (value: unknown) => string;
};

const vendors = new Set(["debug", "openobserve", "datadog", "sentry"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function merge(base: unknown, extra: unknown): unknown {
  if (Array.isArray(extra) || !isObject(base) || !isObject(extra)) return extra;
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(extra)) out[key] = key in out ? merge(out[key], extra[key]) : extra[key];
  return out;
}

function slot(name: "APP" | "INFRA"): { key: string; endpoint: string } {
  return {
    key: process.env[`KEEL_VENDOR_${name}_API_KEY`]?.trim() ?? "",
    endpoint: process.env[`KEEL_VENDOR_${name}_ENDPOINT`]?.trim() ?? "",
  };
}

const appSlot = slot("APP");
const infraSlot = slot("INFRA");
if (appSlot.key && infraSlot.key && appSlot.key === infraSlot.key) {
  console.error("refusing export: duplicate key in app and infra");
  process.exit(1);
}

const vendor = process.env.KEEL_COLLECTOR_VENDOR || "debug";
if (!vendors.has(vendor)) {
  console.error(`unknown collector vendor ${vendor}`);
  process.exit(1);
}
const fragment = path.join(root, "collector/vendors", `${vendor}.yaml`);
if (!existsSync(fragment)) {
  console.error(`missing collector fragment ${fragment}`);
  process.exit(1);
}
const base = yaml.parse(readFileSync(path.join(root, "collector/base.yaml"), "utf8"));
const extra = yaml.parse(readFileSync(fragment, "utf8"));
const merged = merge(base, extra) as {
  exporters: Record<string, unknown>;
  service: { pipelines: Record<string, { exporters?: string[] }> };
};

if (vendor !== "debug") {
  const slots = [
    ["app", appSlot],
    ["infra", infraSlot],
  ] as const;
  for (const [name, current] of slots) {
    const filled = current.key.length > 0 && current.endpoint.length > 0;
    for (const signal of ["logs", "traces", "metrics"]) {
      const pipeline = merged.service.pipelines[`${signal}/${name}`];
      if (pipeline) pipeline.exporters = [filled ? `otlphttp/${name}` : `debug/${name}`];
    }
    if (!filled) delete merged.exporters[`otlphttp/${name}`];
    else delete merged.exporters[`debug/${name}`];
  }
  const slotDebug = ["debug/app", "debug/infra"].filter((name) => name in merged.exporters);
  if (slotDebug.length === 1) {
    merged.service.pipelines["metrics/unlabeled"].exporters = [slotDebug[0]];
    delete merged.exporters["debug/unlabeled"];
  }
}

const rendered = yaml.stringify(merged);
mkdirSync(path.join(root, "generated"), { recursive: true });
writeFileSync(path.join(root, "generated/collector.yaml"), rendered);
console.log(`collector ${vendor}`);
