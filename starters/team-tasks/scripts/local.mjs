import { execFileSync } from "node:child_process";

/** Reads the running local Supabase stack's URL and publishable key. */
export function localStack() {
  let status;
  try {
    status = JSON.parse(
      execFileSync("supabase", ["status", "--output", "json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    console.error(
      "The local Supabase stack is not running. Run `supabase start` first.",
    );
    process.exit(1);
  }
  return {
    url: status.API_URL,
    publishableKey: status.PUBLISHABLE_KEY ?? status.ANON_KEY,
  };
}
