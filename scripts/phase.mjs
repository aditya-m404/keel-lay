import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const raw = process.argv[2] ?? "";
const id = raw.replace(/^phase-?/, "").padStart(2, "0");
const file = path.join(root, "scripts/phases", `phase-${id}.mjs`);

if (!/^\d{2}$/.test(id) || !existsSync(file)) {
  console.error("usage: pnpm phase -- <01-12>");
  process.exit(1);
}

const result = spawnSync(process.execPath, [file], { cwd: root, stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
