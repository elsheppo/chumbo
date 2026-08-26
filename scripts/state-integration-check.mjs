import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let local;
try {
  local = JSON.parse(
    execFileSync("supabase", ["status", "--output", "json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
} catch {
  throw new Error(
    "Local Supabase is not running. Run `supabase start`, then retry.",
  );
}

const result = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "test/state.integration.test.ts"],
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
      SUPABASE_INTEGRATION_DB_URL: local.DB_URL,
    },
  },
);

if (result.status !== 0) process.exit(result.status ?? 1);
