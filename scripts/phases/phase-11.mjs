import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = path.join(root, "generated/doctor-production.env");

function miss(message) {
  throw new Error(message);
}

function loadEnv(target) {
  const file = path.join(root, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    if (target[key] === undefined) target[key] = trimmed.slice(eq + 1);
  }
}

const userEnv = { ...process.env };
loadEnv(userEnv);

let code = 0;
try {
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  const deploy = readFileSync(path.join(root, ".github/workflows/deploy.yml"), "utf8");
  if (!ci.includes("pnpm check") || !ci.includes("compose") || ci.includes("docker push")) {
    miss("ci.yml does not check and build without pushing");
  }
  if (!deploy.includes("known_hosts") || !deploy.includes("curl") || !deploy.includes("/ready")) {
    miss("deploy.yml is missing the pinned host key or the ready check");
  }
  if (deploy.includes("POST /runs")) miss("deploy.yml starts a run");
  if (!deploy.includes("image_tag")) miss("deploy.yml has no image_tag input");

  writeFileSync(fixture, "KEEL_ENV=production\nKEEL_SEED_PASSWORD=keel-local-only\nKEEL_COLLECTOR_VENDOR=debug\n");
  const doctor = spawnSync("./scripts/doctor", { cwd: root, env: { ...userEnv, DOCTOR_ENV_FILE: fixture }, encoding: "utf8" });
  if (doctor.status === 0) miss(`doctor accepted the local password in production\n${doctor.stdout}\n${doctor.stderr}`);

  if (userEnv.KEEL_ENV === "production") {
    const origin = userEnv.KEEL_WEB_ORIGIN;
    const api = userEnv.KEEL_API_ORIGIN;
    if (!origin || !api) miss("production origins are empty");
    const ready = await fetch(`${api}/ready`);
    if (ready.status !== 200) miss(`ready ${ready.status}`);
    const session = await fetch(`${api}/session`);
    if (session.status !== 401) miss(`session ${session.status}`);
    const page = await fetch(`${origin}/boards/launch`, { headers: { accept: "text/html" } });
    const type = page.headers.get("content-type") ?? "";
    if (!type.includes("text/html")) miss(`board content type ${type}`);
  } else {
    console.log("skipped: not production");
  }
  console.log("phase 11 ok");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  code = 1;
} finally {
  rmSync(fixture, { force: true });
}
process.exit(code);
