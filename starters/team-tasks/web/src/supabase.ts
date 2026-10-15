import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../supabase/functions/_shared/database.types.ts";

const url = import.meta.env.VITE_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !publishableKey) {
  throw new Error(
    "Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in web/.env.local (run `npm run env`).",
  );
}

export const supabaseUrl: string = url;
export const supabase = createClient<Database>(url, publishableKey);

/** The MCP endpoint served by supabase/functions/mcp. */
export const mcpUrl: string =
  import.meta.env.VITE_MCP_URL ?? `${url.replace(/\/$/, "")}/functions/v1/mcp`;
