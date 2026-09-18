import { createSupabaseMcp } from "chumbo";
import { registerCapabilities } from "../capabilities";

const projectUrl =
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!projectUrl) throw new Error("SUPABASE_URL is not configured");
const publishableKey =
  process.env.SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.SUPABASE_ANON_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!publishableKey) {
  throw new Error("SUPABASE_PUBLISHABLE_KEY is not configured");
}
{{AUTH_SETUP}}{{STATE_SETUP}}
// The URL MCP clients connect to. Set MCP_PUBLIC_URL in production.
const publicUrl = new URL(
  process.env.MCP_PUBLIC_URL ?? "http://localhost:3000/{{FUNCTION_NAME}}",
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

// The MCP endpoint is a live protocol surface and must never be
// statically rendered or cached.
export const dynamic = "force-dynamic";

const handle = (request: Request) => app.fetch(request);
export { handle as GET, handle as POST, handle as DELETE, handle as OPTIONS };
