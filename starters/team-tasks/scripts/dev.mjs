// Serves the MCP Edge Function and the web app together. Stop with Ctrl+C.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { localStack } from "./local.mjs";

const { url } = localStack();
if (!existsSync(new URL("../web/.env.local", import.meta.url))) {
  await import("./env.mjs");
}

const children = [
  spawn("supabase", ["functions", "serve", "mcp"], { stdio: "inherit" }),
  spawn("npm", ["--prefix", "web", "run", "dev"], { stdio: "inherit" }),
];
console.log(
  `\nWeb app:  http://127.0.0.1:5173\nMCP URL:  ${url}/functions/v1/mcp\n`,
);

const stop = () => children.forEach((child) => child.kill("SIGTERM"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) child.on("exit", (code) => code && stop());
