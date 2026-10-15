// Runs supabase/tests/isolation_test.ts against the running local stack.
import { spawnSync } from "node:child_process";
import { localStack } from "./local.mjs";

const { url, publishableKey } = localStack();
const result = spawnSync(
  "deno",
  [
    "test",
    "--config",
    "supabase/functions/mcp/deno.json",
    "--allow-env",
    "--allow-net",
    "supabase/tests/isolation_test.ts",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      SUPABASE_URL: url,
      SUPABASE_PUBLISHABLE_KEY: publishableKey,
    },
  },
);
process.exit(result.status ?? 1);
