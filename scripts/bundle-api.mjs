import { build } from "esbuild";

await build({
  entryPoints: ["apps/api/src/app.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "apps/api/dist/server.js",
  banner: {
    js: "import { createRequire as keelCreateRequire } from 'node:module'; const require = keelCreateRequire(import.meta.url);",
  },
});
