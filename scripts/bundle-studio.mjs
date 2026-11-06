import { build } from "esbuild";

await build({
  entryPoints: ["apps/studio/src/server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "apps/studio/build/server.js",
  packages: "external",
  banner: {
    js: "import { createRequire as keelCreateRequire } from 'node:module'; const require = keelCreateRequire(import.meta.url);",
  },
});
