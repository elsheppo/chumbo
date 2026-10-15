// Writes web/.env.local from the running local Supabase stack.
import { writeFileSync } from "node:fs";
import { localStack } from "./local.mjs";

const { url, publishableKey } = localStack();
writeFileSync(
  new URL("../web/.env.local", import.meta.url),
  `VITE_SUPABASE_URL=${url}\nVITE_SUPABASE_PUBLISHABLE_KEY=${publishableKey}\n`,
);
console.log(`Wrote web/.env.local for ${url}`);
