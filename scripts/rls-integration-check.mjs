import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exampleRoot = path.join(root, "examples", "multi-tenant");

let local;
try {
  local = JSON.parse(
    execFileSync("supabase", ["status", "--output", "json"], {
      cwd: exampleRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
} catch {
  throw new Error(
    "The multi-tenant example Supabase stack is not running. Run `supabase start --workdir examples/multi-tenant`, then retry.",
  );
}

const result = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "test/rls.integration.test.ts"],
  {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
    env: {
      ...process.env,
      SUPABASE_INTEGRATION_URL: local.API_URL,
      SUPABASE_INTEGRATION_PUBLISHABLE_KEY:
        local.PUBLISHABLE_KEY ?? local.ANON_KEY,
      SUPABASE_INTEGRATION_SECRET_KEY:
        local.SECRET_KEY ?? local.SERVICE_ROLE_KEY,
    },
  },
);

if (result.status !== 0) process.exit(result.status ?? 1);
