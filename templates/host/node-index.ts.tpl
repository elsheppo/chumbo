import { createSupabaseMcp } from "chumbo";
import { serve } from "chumbo/node";
import { registerCapabilities } from "./capabilities.ts";

const projectUrl = process.env.SUPABASE_URL;
if (!projectUrl) throw new Error("SUPABASE_URL is not configured");
const publishableKey =
  process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
if (!publishableKey) {
  throw new Error("SUPABASE_PUBLISHABLE_KEY is not configured");
}
{{AUTH_SETUP}}{{STATE_SETUP}}
const port = Number(process.env.PORT ?? 8080);
// The URL MCP clients connect to. Set MCP_PUBLIC_URL in production.
const publicUrl = new URL(
  process.env.MCP_PUBLIC_URL ?? `http://127.0.0.1:${port}/{{FUNCTION_NAME}}`,
);

const app = createSupabaseMcp({
  server: { name: "{{SERVER_NAME}}", version: "1.0.0" },
  // Server-level guidance shown to the model at connection time. Keep it
  // capability-name-agnostic so it stays accurate as capabilities.ts evolves.
  instructions:
    "{{SERVER_NAME}} exposes application capabilities for the connected " +
    "caller. Use the available capabilities according to their descriptions.",
  resourceUrl: publicUrl,
  auth: {{AUTH_CONFIG}},
{{STATE_CONFIG}}  supabase: {
    env: {
      url: projectUrl,
      publishableKeys: { default: publishableKey },
    },
  },
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

const running = await serve(app, { port });
console.log(
  JSON.stringify({
    level: "info",
    message: "{{SERVER_NAME}} MCP server listening",
    url: `${running.url}/{{FUNCTION_NAME}}`,
  }),
);
