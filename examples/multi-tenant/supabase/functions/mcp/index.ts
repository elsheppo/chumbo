import { createSupabaseMcp } from "create-supabase-mcp";
import { registerCapabilities } from "./capabilities.ts";

const projectUrl = Deno.env.get("SUPABASE_URL");
if (!projectUrl) throw new Error("SUPABASE_URL is not configured");

const app = createSupabaseMcp({
  server: { name: "Multi-tenant documents", version: "1.0.0" },
  resourceUrl: new URL(`${projectUrl}/functions/v1/mcp`),
  auth: { mode: "oauth" },
  register: registerCapabilities,
});

if (import.meta.main) Deno.serve(app.fetch);

export default app;
