import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { defineConfig, normalizePath } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const localesEntry = normalizePath(
  realpathSync(fileURLToPath(import.meta.resolve("zod/v4/locales"))),
);

export default defineConfig({
  root: appRoot,
  resolve: {
    alias: {
      "chumbo/app": fileURLToPath(
        new URL("../../../../src/app.ts", import.meta.url),
      ),
    },
  },
  plugins: [
    {
      name: "review-queue-english-errors",
      // The SDK retains Zod's locale namespace. This app is English-only;
      // keep its validation messages without shipping every translation.
      transform(_code, id) {
        if (id === localesEntry) {
          return 'export { default as en } from "zod/v4/locales/en.js";';
        }
      },
    },
    viteSingleFile(),
    {
      name: "review-queue-size-budget",
      enforce: "post",
      generateBundle(_options, bundle) {
        for (const asset of Object.values(bundle)) {
          if (asset.type !== "asset" || !asset.fileName.endsWith(".html"))
            continue;
          const bytes = Buffer.byteLength(asset.source);
          if (bytes >= 400_000) {
            this.error(
              `Review queue HTML is ${bytes} bytes; budget is <400000.`,
            );
          }
        }
      },
    },
  ],
  build: {
    outDir: fileURLToPath(new URL("../dist", import.meta.url)),
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: fileURLToPath(new URL("./review-queue.html", import.meta.url)),
    },
  },
});
