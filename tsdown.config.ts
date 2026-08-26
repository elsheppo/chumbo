import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/app.ts", "src/testing.ts", "src/cli.ts"],
  format: "esm",
  dts: true,
  hash: false,
  clean: true,
  sourcemap: true,
  target: "es2022",
  platform: "neutral",
  external: [
    "node:child_process",
    "node:crypto",
    "node:fs/promises",
    "node:path",
    "node:readline/promises",
    "node:url",
    "node:util",
    "@modelcontextprotocol/server",
    "@modelcontextprotocol/ext-apps",
    "@supabase/server",
    "@supabase/server/core",
    "@supabase/supabase-js",
    "zod",
  ],
});
