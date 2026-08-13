import {
  McpServer,
  acceptedContent,
  inputRequired,
} from "@modelcontextprotocol/server";
import {
  jsonResult,
  type SupabaseMcpContext,
} from "create-supabase-mcp";
import { z } from "zod";

export function registerCapabilities(
  server: McpServer,
  ctx: SupabaseMcpContext,
): void {
  server.registerTool(
    "whoami",
    {
      description: "Return the connected application user's identity.",
      inputSchema: z.object({}),
    },
    async () => jsonResult({
      user: ctx.user,
      oauthClientId: ctx.clientId,
      traceId: ctx.traceId,
    }),
  );

  server.registerTool(
    "confirm_identity",
    {
      description: "Demonstrate MCP multi-round-trip confirmation.",
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
              message: "Return the connected user's identity?",
              requestedSchema: z.object({ confirm: z.boolean() }),
            }),
          },
        });
      }
      return response.confirm
        ? jsonResult({ user: ctx.user })
        : jsonResult({ declined: true });
    },
  );

  server.registerResource(
    "connected-user",
    "app://connected-user",
    {
      title: "Connected user",
      description: "Identity associated with this MCP request.",
      mimeType: "application/json",
      cacheHint: { cacheScope: "private", ttlMs: 0 },
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({ user: ctx.user, clientId: ctx.clientId }),
      }],
    }),
  );

  server.registerPrompt(
    "summarize-account",
    {
      description: "Create a prompt for summarizing the connected account.",
      argsSchema: z.object({ focus: z.string().optional() }),
    },
    ({ focus }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Summarize the connected account${focus ? `, focusing on ${focus}` : ""}.`,
        },
      }],
    }),
  );
}
