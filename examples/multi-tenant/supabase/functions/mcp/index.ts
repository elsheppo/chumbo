import { createSupabaseMcp } from "supa-mcp";
import { registerCapabilities } from "./capabilities.ts";

const projectUrl = Deno.env.get("SUPABASE_URL");
if (!projectUrl) throw new Error("SUPABASE_URL is not configured");
const internalUrl = new URL(`${projectUrl}/functions/v1/mcp`);
const publicUrl = new URL(Deno.env.get("MCP_PUBLIC_URL") ?? internalUrl);

const app = createSupabaseMcp({
  server: { name: "Multi-tenant documents", version: "1.0.0" },
  resourceUrl: publicUrl,
  auth: { mode: "oauth", issuer: new URL(`${projectUrl}/auth/v1`) },
  register: registerCapabilities,
});

if (import.meta.main) Deno.serve(app.fetch);

export default app;
