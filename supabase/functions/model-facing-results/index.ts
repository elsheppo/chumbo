import {
  createSupabaseMcp,
  errorResult,
  renderResult,
  type SupabaseMcpServer,
} from "supa-mcp";
import { z } from "zod";

const projectUrl = Deno.env.get("SUPABASE_URL");
if (!projectUrl) throw new Error("SUPABASE_URL is not configured");
const resourceUrl = new URL(
  Deno.env.get("MODEL_RESULTS_PUBLIC_URL") ??
    `${projectUrl}/functions/v1/model-facing-results`,
);

function register(server: SupabaseMcpServer) {
  server.registerTool(
    "list_examples",
    {
      title: "List result examples",
      description:
        "Return a populated result whose model-facing text remains useful without structuredContent.",
      inputSchema: z.object({}),
    },
    async () => {
      const examples = [
        { name: "Authenticated tools", status: "tested" },
        { name: "Many MCPs from one function", status: "tested" },
      ];
      return renderResult({ examples }, ({ examples }) =>
        [
          `## Tested examples — ${examples.length}`,
          "",
          ...examples.map(
            (example) => `- **${example.name}** — ${example.status}`,
          ),
          "",
          "→ Next: call show_empty_state or show_recoverable_error to inspect the other branches.",
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "show_empty_state",
    {
      title: "Show an empty result",
      description:
        "Return an explicit empty state with a productive next action.",
      inputSchema: z.object({}),
    },
    async () =>
      renderResult(
        { examples: [] as unknown[] },
        () =>
          "No examples matched this demonstration filter.\n\n→ Next: call list_examples to retrieve the populated case.",
      ),
  );

  server.registerTool(
    "show_recoverable_error",
    {
      title: "Show a recoverable error",
      description:
        "Return a deliberate MCP error that tells the model how to recover.",
      inputSchema: z.object({}),
    },
    async () =>
      errorResult(
        "The demonstration record does not exist.",
        "call list_examples and choose one of the returned records.",
      ),
  );
}

const app = createSupabaseMcp({
  server: { name: "Model-facing result examples", version: "0.3.0" },
  resourceUrl,
  auth: { mode: "public", rateLimit: true },
  register,
});

if (import.meta.main) Deno.serve(app.fetch);
export default app;
