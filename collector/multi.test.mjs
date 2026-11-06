// The multi vendor: every filled KEEL_FANOUT_* pair receives the application pipelines at once.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, cpSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(new URL("../packages/otel/package.json", import.meta.url));
const yaml = require("yaml");

// Render into a scratch copy so the test never touches generated/collector.yaml of a running stack.
const scratch = mkdtempSync(path.join(tmpdir(), "keel-multi-"));
cpSync(path.join(root, "collector"), path.join(scratch, "collector"), { recursive: true });
cpSync(path.join(root, "scripts/render-collector.ts"), path.join(scratch, "scripts/render-collector.ts"));
cpSync(path.join(root, "packages/otel/package.json"), path.join(scratch, "packages/otel/package.json"));
cpSync(path.join(root, "packages/otel/node_modules"), path.join(scratch, "packages/otel/node_modules"), { recursive: true, dereference: true });

function render(env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^KEEL_(VENDOR|FANOUT|COLLECTOR)_/.test(key)));
  const result = spawnSync(process.execPath, ["scripts/render-collector.ts"], {
    cwd: scratch,
    env: { ...clean, KEEL_COLLECTOR_VENDOR: "multi", ...env },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const raw = readFileSync(path.join(scratch, "generated/collector.yaml"), "utf8");
  return { raw, doc: yaml.parse(raw) };
}

const openobserve = {
  KEEL_FANOUT_OPENOBSERVE_ENDPOINT: "https://api.openobserve.ai/api/lay",
  KEEL_FANOUT_OPENOBSERVE_API_KEY: "Basic c2VjcmV0LWFwcA==",
};
const sentry = {
  KEEL_FANOUT_SENTRY_ENDPOINT: "https://o1.ingest.us.sentry.io/api/2/integration/otlp",
  KEEL_FANOUT_SENTRY_API_KEY: "sentry sentry_key=secret-sentry",
};

test("no filled pair keeps both pipelines in the collector log", () => {
  const { doc } = render({});
  for (const signal of ["logs", "traces", "metrics"]) {
    assert.deepEqual(doc.service.pipelines[`${signal}/app`].exporters, ["debug/app"]);
    assert.deepEqual(doc.service.pipelines[`${signal}/infra`].exporters, ["debug/infra"]);
  }
  assert.ok(!("otlphttp/openobserve" in doc.exporters));
  assert.ok(!("otlphttp/infra" in doc.exporters));
});

test("two filled pairs both receive the application pipelines", () => {
  const { doc, raw } = render({ ...openobserve, ...sentry });
  for (const signal of ["logs", "traces", "metrics"]) {
    assert.deepEqual(doc.service.pipelines[`${signal}/app`].exporters, ["otlphttp/openobserve", "otlphttp/sentry"]);
    assert.deepEqual(doc.service.pipelines[`${signal}/infra`].exporters, ["debug/infra"]);
  }
  assert.ok(!("debug/app" in doc.exporters));
  assert.ok(!("otlphttp/datadog" in doc.exporters));
  assert.ok(!raw.includes("c2VjcmV0") && !raw.includes("secret-sentry"), "the rendered file must reference the key through env");
});

test("a vendor narrowed by SIGNALS is left out of the other pipelines", () => {
  const { doc } = render({ ...openobserve, ...sentry, KEEL_FANOUT_SENTRY_SIGNALS: "traces,logs" });
  assert.deepEqual(doc.service.pipelines["metrics/app"].exporters, ["otlphttp/openobserve"]);
  assert.deepEqual(doc.service.pipelines["traces/app"].exporters, ["otlphttp/openobserve", "otlphttp/sentry"]);
});

test("a filled infrastructure pair gets its own exporter and never the application set", () => {
  const { doc } = render({
    ...openobserve,
    KEEL_VENDOR_INFRA_ENDPOINT: "https://api.openobserve.ai/api/lay-infra",
    KEEL_VENDOR_INFRA_API_KEY: "Basic aW5mcmE=",
  });
  for (const signal of ["logs", "traces", "metrics"]) {
    assert.deepEqual(doc.service.pipelines[`${signal}/infra`].exporters, ["otlphttp/infra"]);
  }
  assert.ok(!("debug/infra" in doc.exporters));
  assert.deepEqual(doc.service.pipelines["metrics/unlabeled"].exporters, ["debug/unlabeled"]);
});
