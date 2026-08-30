import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function status() {
  try {
    return JSON.parse(
      execFileSync("supabase", ["status", "--output", "json"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return null;
  }
}

if (!status()) {
  // The CLI's success table includes deterministic local development keys.
  // Keep those out of public CI logs while preserving startup errors.
  run("supabase", ["start"], { stdio: ["ignore", "ignore", "inherit"] });
}
run("pnpm", ["run", "build"]);
run("pnpm", ["run", "reference:app"]);
run("supabase", ["db", "reset", "--local"]);

const local = status();
if (!local) throw new Error("Local Supabase did not report a running status.");
const env = {
  ...process.env,
  SUPABASE_URL: local.API_URL,
  SUPABASE_ANON_KEY: local.ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY,
  SUPABASE_PUBLISHABLE_KEY: local.PUBLISHABLE_KEY,
  SUPABASE_SECRET_KEY: local.SECRET_KEY,
  SUPABASE_JWKS_URL: `${local.API_URL}/auth/v1/.well-known/jwks.json`,
  SUPA_MCP_STATE_HMAC_KEY:
    "local-reference-observation-state-key-at-least-32-bytes",
};

run("node", ["scripts/generated-rls-smoke.mjs"], { env });
run("node", ["scripts/sync-reference-content.mjs"], { env });
for (const name of [
  "docs-mcp",
  "authenticated-tools",
  "model-facing-results",
  "many-mcps",
  "observation-before-action",
  "privileged-capabilities",
  "review-queue-app",
]) {
  run(
    "deno",
    [
      "check",
      "--no-lock",
      "--unstable-sloppy-imports",
      "--config",
      "supabase/deno.reference.json",
      `supabase/functions/${name}/index.ts`,
    ],
    { env },
  );
}
run(
  "deno",
  [
    "test",
    "--no-lock",
    "--unstable-sloppy-imports",
    "--config",
    "supabase/deno.reference.json",
    "--allow-env",
    "--allow-net=127.0.0.1,localhost",
    "--allow-read=supabase/functions/review-queue-app/dist/review-queue.html",
    "supabase/tests/reference_integration_test.ts",
  ],
  { env },
);

console.log(
  "\nLiving reference project verified from migrations, seed, Git content, and the local source package.",
);
