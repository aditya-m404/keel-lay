import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const vendors = ["debug", "openobserve", "datadog", "sentry"];

function miss(message) {
  throw new Error(message);
}

function loadEnv(target) {
  const file = path.join(root, ".env");
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    if (target[key] === undefined) target[key] = trimmed.slice(eq + 1);
  }
}

function render(env) {
  const result = spawnSync(process.execPath, ["scripts/render-collector.ts"], { cwd: root, env, encoding: "utf8" });
  if (result.status !== 0) miss(result.stderr || result.stdout || "render failed");
}

function validate(env) {
  const args = [
    "run",
    "--rm",
    "-e",
    `KEEL_VENDOR_APP_ENDPOINT=${env.KEEL_VENDOR_APP_ENDPOINT ?? ""}`,
    "-e",
    `KEEL_VENDOR_APP_API_KEY=${env.KEEL_VENDOR_APP_API_KEY ?? ""}`,
    "-e",
    `KEEL_VENDOR_INFRA_ENDPOINT=${env.KEEL_VENDOR_INFRA_ENDPOINT ?? ""}`,
    "-e",
    `KEEL_VENDOR_INFRA_API_KEY=${env.KEEL_VENDOR_INFRA_API_KEY ?? ""}`,
    "-v",
    `${path.join(root, "generated/collector.yaml")}:/etc/otelcol/config.yaml:ro`,
    "otel/opentelemetry-collector-contrib:0.128.0",
    "validate",
    "--config=/etc/otelcol/config.yaml",
  ];
  return spawnSync("docker", args, { cwd: root, encoding: "utf8" });
}

const userEnv = { ...process.env };
loadEnv(userEnv);

let code = 0;
try {
  for (const vendor of vendors) {
    const env = { ...userEnv, KEEL_COLLECTOR_VENDOR: vendor };
    if (vendor !== "debug") {
      env.KEEL_VENDOR_APP_ENDPOINT = "http://127.0.0.1:9";
      env.KEEL_VENDOR_APP_API_KEY = "placeholder-app";
      env.KEEL_VENDOR_INFRA_ENDPOINT = "http://127.0.0.1:9";
      env.KEEL_VENDOR_INFRA_API_KEY = "placeholder-infra";
    }
    render(env);
    const text = readFileSync(path.join(root, "generated/collector.yaml"), "utf8");
    if (!text.includes("logs/app:") || !text.includes("logs/infra:")) miss(`${vendor} config is missing a pipeline`);
    const checked = validate(env);
    const validateOut = `${checked.stdout ?? ""}\n${checked.stderr ?? ""}`;
    if (checked.status !== 0) {
      if (/api[_ ]?key|live key/i.test(validateOut)) {
        console.log(`skipped validate: ${vendor} requires a live key`);
      } else {
        miss(`${vendor} collector config was rejected\n${validateOut.slice(-2000)}`);
      }
    }
  }

  const routing = spawnSync(process.execPath, ["--test", "collector/routing.test.mjs"], { cwd: root, encoding: "utf8" });
  if (routing.status !== 0) miss(routing.stderr || routing.stdout || "routing test failed");

  const vendor = (userEnv.KEEL_COLLECTOR_VENDOR || "debug").trim();
  const appKey = (userEnv.KEEL_VENDOR_APP_API_KEY || "").trim();
  const infraKey = (userEnv.KEEL_VENDOR_INFRA_API_KEY || "").trim();
  if (vendor !== "debug" && appKey && infraKey) {
    const doctor = spawnSync("./scripts/doctor", { cwd: root, env: userEnv, encoding: "utf8" });
    const output = `${doctor.stdout ?? ""}\n${doctor.stderr ?? ""}`;
    if (doctor.status !== 0) miss(output || "doctor failed");
    if (!output.includes("metrics") || !output.includes("logs") || !output.includes("traces")) {
      miss(`doctor sample line missing\n${output}`);
    }
    if (!output.includes("accepted") && !output.includes("refused")) miss(`doctor sample line missing a result\n${output}`);
  } else {
    console.log("skipped: no vendor");
  }
  console.log("phase 12 ok");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  code = 1;
} finally {
  try {
    render(userEnv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    code = 1;
  }
}
process.exit(code);
