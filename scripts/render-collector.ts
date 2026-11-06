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

const vendors = new Set(["debug", "openobserve", "datadog", "sentry", "multi"]);

// multi: every vendor below with a filled KEEL_FANOUT_<NAME>_ENDPOINT and _API_KEY pair receives the
// application pipelines at once. KEEL_FANOUT_<NAME>_SIGNALS narrows a vendor to some of logs, traces,
// and metrics, for an endpoint that refuses one of them.
const FANOUT = ["openobserve", "sentry", "datadog"] as const;
const SIGNALS = ["logs", "traces", "metrics"] as const;

function fanout(name: (typeof FANOUT)[number]): { live: boolean; signals: Set<string> } {
  const upper = name.toUpperCase();
  const endpoint = process.env[`KEEL_FANOUT_${upper}_ENDPOINT`]?.trim() ?? "";
  const key = process.env[`KEEL_FANOUT_${upper}_API_KEY`]?.trim() ?? "";
  const listed = (process.env[`KEEL_FANOUT_${upper}_SIGNALS`]?.trim() ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is (typeof SIGNALS)[number] => (SIGNALS as readonly string[]).includes(item));
  return { live: endpoint.length > 0 && key.length > 0, signals: new Set(listed.length ? listed : SIGNALS) };
}

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

if (vendor === "multi") {
  const infraFilled = infraSlot.key.length > 0 && infraSlot.endpoint.length > 0;
  const live = FANOUT.filter((name) => fanout(name).live);
  for (const signal of SIGNALS) {
    const exporters = live.filter((name) => fanout(name).signals.has(signal)).map((name) => `otlphttp/${name}`);
    merged.service.pipelines[`${signal}/app`].exporters = exporters.length ? exporters : ["debug/app"];
    merged.service.pipelines[`${signal}/infra`].exporters = [infraFilled ? "otlphttp/infra" : "debug/infra"];
  }
  for (const name of FANOUT) if (!fanout(name).live) delete merged.exporters[`otlphttp/${name}`];
  const appDebug = SIGNALS.some((signal) => merged.service.pipelines[`${signal}/app`].exporters?.includes("debug/app"));
  if (!appDebug) delete merged.exporters["debug/app"];
  if (infraFilled) delete merged.exporters["debug/infra"];
  else delete merged.exporters["otlphttp/infra"];
  const slotDebug = ["debug/app", "debug/infra"].filter((name) => name in merged.exporters);
  if (slotDebug.length === 1) {
    merged.service.pipelines["metrics/unlabeled"].exporters = [slotDebug[0]];
    delete merged.exporters["debug/unlabeled"];
  }
} else if (vendor !== "debug") {
  const filled = (current: { key: string; endpoint: string }) => current.key.length > 0 && current.endpoint.length > 0;
  const appFilled = filled(appSlot);
  const infraFilled = filled(infraSlot);
  const slots = [
    ["app", appFilled, "app"],
    ["infra", infraFilled || appFilled, infraFilled ? "infra" : "app"],
  ] as const;
  for (const [name, live, exporter] of slots) {
    for (const signal of ["logs", "traces", "metrics"]) {
      const pipeline = merged.service.pipelines[`${signal}/${name}`];
      if (pipeline) pipeline.exporters = [live ? `otlphttp/${exporter}` : `debug/${name}`];
    }
    if (name === "infra" && live && exporter === "app") {
      delete merged.exporters["otlphttp/infra"];
      delete merged.exporters["debug/infra"];
    } else if (!live) delete merged.exporters[`otlphttp/${name}`];
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
