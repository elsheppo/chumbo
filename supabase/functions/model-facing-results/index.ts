import { acceptedContent, inputRequired } from "@modelcontextprotocol/server";
import {
  createSupabaseMcp,
  collectionInputSchema,
  collectionOutputSchema,
  collectionResult,
  errorResult,
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

  const exampleSchema = z.object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
  });
  const examples = [
    {
      id: "1",
      name: "Authenticated tools",
      status: "tested",
      internalNotes: "Never expose source-only fields.",
    },
    {
      id: "2",
      name: "Many MCPs from one function",
      status: "tested",
      internalNotes: "Never expose source-only fields.",
    },
  ];
  server.registerTool(
    "list_examples",
    {
      title: "List result examples",
      description:
        "Browse compact examples one page at a time; use open_result_guide for full design guidance.",
      inputSchema: collectionInputSchema({
        defaultLimit: 1,
        maxLimit: 2,
        cursorSchema: z.string().regex(/^[12]$/),
      }),
      outputSchema: collectionOutputSchema(exampleSchema),
    },
    async ({ limit, cursor }) =>
      collectionResult({
        items: examples
          .filter((item) => !cursor || item.id > cursor)
          .slice(0, limit + 1),
        limit,
        maxLimit: 2,
        hasMore: false,
        itemSchema: exampleSchema,
        project: ({ id, name, status }) => ({ id, name, status }),
        cursorFor: ({ id }) => id,
        tool: "list_examples",
        arguments: cursor ? { cursor } : {},
        mode: "hybrid",
        maxBytes: 2000,
        render: ({ items }) =>
          items.length
            ? items
                .map(
                  (item) => `- **${item.name}** – ${item.status} (${item.id})`,
                )
                .join("\n")
            : "No examples remain. Call open_result_guide for complete design guidance.",
        onOversizedItem: () =>
          "call open_result_guide for complete design guidance.",
      }),
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
  server: { name: "Model-facing result examples", version: "0.11.0" },
  resourceUrl,
  auth: { mode: "public", rateLimit: true },
  register,
  resultMiddleware({ tool, result }) {
    if (tool.name !== "list_examples") return;
    return {
      append: [
        {
          type: "text",
          text: (result.structuredContent as { has_more: boolean }).has_more
            ? "Optional follow-up: use the exact next call above to see another example. Stop once you have a suitable pattern; call open_result_guide for full guidance."
            : "Optional follow-up: all examples have been shown. Call open_result_guide for full guidance, or show_empty_state and show_recoverable_error to inspect those branches.",
        },
      ],
    };
  },
});

if (import.meta.main) Deno.serve(app.fetch);
export default app;
