import { acceptedContent, inputRequired } from "@modelcontextprotocol/server";
import {
  createSupabaseMcp,
  errorResult,
  renderResult,
  resourceResult,
  structuredResult,
  textResult,
  type SupabaseMcpServer,
} from "chumbo";
import { z } from "zod";

const projectUrl = Deno.env.get("SUPABASE_URL");
if (!projectUrl) throw new Error("SUPABASE_URL is not configured");
const resourceUrl = new URL(
  Deno.env.get("MODEL_RESULTS_PUBLIC_URL") ??
    `${projectUrl}/functions/v1/model-facing-results`,
);

function register(server: SupabaseMcpServer) {
  const guideUri = "supa-mcp://examples/result-contract-guide";
  server.registerResource(
    "result-contract-guide",
    guideUri,
    {
      title: "Result contract guide",
      description: "Complete guide used by the large-resource example.",
      mimeType: "text/markdown",
      cacheHint: { cacheScope: "public", ttlMs: 60_000 },
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: "# Result contracts\n\nChoose text, structured data, a deliberate hybrid, or a Resource according to the real consumer.",
        },
      ],
    }),
  );

  server.registerPrompt(
    "summarize-result-contract",
    {
      description: "Create a prompt for reviewing one MCP result contract.",
      argsSchema: z.object({ tool: z.string().min(1) }),
    },
    ({ tool }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Review the result contract for ${tool}. Explain who consumes it and the next useful action.`,
          },
        },
      ],
    }),
  );

  server.registerTool(
    "list_examples",
    {
      title: "List result examples",
      description:
        "Return a populated result whose model-facing text remains useful without structuredContent.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        examples: z.array(z.object({ name: z.string(), status: z.string() })),
      }),
    },
    async () => {
      const examples = [
        { name: "Authenticated tools", status: "tested" },
        { name: "Many MCPs from one function", status: "tested" },
      ];
      return renderResult({ examples }, ({ examples }) =>
        [
          `## Tested examples – ${examples.length}`,
          "",
          ...examples.map(
            (example) => `- **${example.name}** – ${example.status}`,
          ),
          "",
          "→ Next: call show_empty_state or show_recoverable_error to inspect the other branches.",
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "get_result_contract",
    {
      title: "Get a typed result contract",
      description:
        "Return exact typed data without manufacturing model-facing text.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        modes: z.array(z.enum(["text", "structured", "hybrid", "resource"])),
      }),
    },
    async () =>
      structuredResult({
        modes: ["text", "structured", "hybrid", "resource"] as const,
      }),
  );

  server.registerTool(
    "open_result_guide",
    {
      title: "Open the complete result guide",
      description:
        "Return a concise reading card and link instead of embedding a large document.",
      inputSchema: z.object({}),
    },
    async () =>
      resourceResult("The complete result-contract guide is linked.", {
        type: "resource_link",
        uri: guideUri,
        name: "result-contract-guide",
        title: "Result contract guide",
        description: "Complete guide to choosing a result contract.",
        mimeType: "text/markdown",
      }),
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
      textResult(
        "No examples matched this demonstration filter.\n\n→ Next: call list_examples to retrieve the populated case.",
      ),
  );

  server.registerTool(
    "confirm_result_contract",
    {
      title: "Confirm a result contract",
      description:
        "Demonstrate an MCP elicitation round trip before accepting a result contract.",
      inputSchema: z.object({}),
    },
    async (_args, request) => {
      const response = acceptedContent<{ confirm: boolean }>(
        request.mcpReq.inputResponses,
        "confirmation",
      );
      if (!response) {
        return inputRequired({
          inputRequests: {
            confirmation: inputRequired.elicit({
              message: "Accept this demonstration result contract?",
              requestedSchema: z.object({ confirm: z.boolean() }),
            }),
          },
        });
      }
      return textResult(
        response.confirm
          ? "Result contract accepted.\n\n→ Next: call list_examples to inspect a populated hybrid result."
          : "Result contract declined.\n\n→ Next: call get_result_contract to review the available result modes.",
      );
    },
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
  server: { name: "Model-facing result examples", version: "0.8.0" },
  resourceUrl,
  auth: { mode: "public", rateLimit: true },
  register,
});

if (import.meta.main) Deno.serve(app.fetch);
export default app;
