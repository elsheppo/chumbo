import { createSupabaseMcp } from "chumbo";
import { registerCapabilities } from "./capabilities.ts";

const projectUrl = Deno.env.get("SUPABASE_URL");
if (!projectUrl) throw new Error("SUPABASE_URL is not configured");

const internalUrl = new URL(`${projectUrl}/functions/v1/mcp`);
const publicUrl = new URL(Deno.env.get("MCP_PUBLIC_URL") ?? internalUrl);

const app = createSupabaseMcp({
  server: { name: "Team Tasks", version: "1.0.0" },
  // Server-level guidance shown to the model at connection time. Keep it
  // capability-name-agnostic so it stays accurate as capabilities.ts evolves.
  instructions:
    "Team Tasks exposes application capabilities for the connected " +
    "caller. Use the available capabilities according to their descriptions.",
  resourceUrl: publicUrl,
  auth: { mode: "oauth", issuer: new URL(`${projectUrl}/auth/v1`) },
  register: registerCapabilities,
  onError({ error, phase, traceId }) {
    console.error(JSON.stringify({
      level: "error",
      phase,
      traceId,
      message: error.message,
    }));
  },
});

if (import.meta.main) Deno.serve(app.fetch);

export default app;
