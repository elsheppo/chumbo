import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const appRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: appRoot,
  resolve: {
    alias: {
      "supa-mcp/app": fileURLToPath(
        new URL("../../../../src/app.ts", import.meta.url),
      ),
    },
  },
  plugins: [viteSingleFile()],
  build: {
    outDir: fileURLToPath(new URL("../dist", import.meta.url)),
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: fileURLToPath(new URL("./review-queue.html", import.meta.url)),
    },
  },
});
