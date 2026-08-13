import { createSupabaseMcp } from "create-supabase-mcp";
import { registerCapabilities } from "./capabilities.ts";

const projectUrl = Deno.env.get("SUPABASE_URL");
if (!projectUrl) throw new Error("SUPABASE_URL is not configured");

const app = createSupabaseMcp({
  server: { name: "{{SERVER_NAME}}", version: "1.0.0" },
  resourceUrl: new URL(`${projectUrl}/functions/v1/{{FUNCTION_NAME}}`),
  auth: { mode: "{{AUTH_MODE}}" },
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
