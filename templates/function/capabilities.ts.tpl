import {
  acceptedContent,
  inputRequired,
} from "@modelcontextprotocol/server";
import {
  renderResult,
  resourceResult,
  structuredResult,
  textResult,
  type SupabaseMcpContext,
  type SupabaseMcpServer,
} from "chumbo";
import { z } from "zod";

export function registerCapabilities(
  server: SupabaseMcpServer,
  ctx: SupabaseMcpContext,
): void {
  server.registerTool(
    "whoami",
    {
      description: "Explain which application identity is connected.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        subject: z.string().nullable(),
        oauthClientId: z.string().nullable(),
      }),
    },
    async () => {
      const identity = {
        subject: ctx.subject ?? null,
        oauthClientId: ctx.clientId ?? null,
      };
      return renderResult(identity, ({ subject }) =>
        subject
          ? `Connected as ${subject}.`
          : "This public connection has no signed-in user.",
      );
    },
  );

  server.registerTool(
    "identity_snapshot",
    {
      description:
        "Return the connected identity as typed data for a programmatic client.",
      inputSchema: z.object({}),
      outputSchema: z.object({ subject: z.string().nullable() }),
    },
    async () => structuredResult({ subject: ctx.subject ?? null }),
  );

  server.registerTool(
    "open_connected_user",
    {
      description:
        "Open the complete connected-user document through MCP resources.",
      inputSchema: z.object({}),
    },
    async () =>
      resourceResult(
        "Connected-user details are available as an MCP resource.",
        {
          type: "resource_link",
          uri: "app://connected-user",
          name: "connected-user",
          title: "Connected user",
          description: "Complete identity associated with this MCP request.",
          mimeType: "application/json",
        },
      ),
  );

  server.registerTool(
    "connection_help",
    {
      description: "Explain the next useful action for this connection.",
      inputSchema: z.object({}),
    },
    async () =>
      textResult(
        "The MCP connection is ready.\n\n→ Next: replace these starter capabilities with your application operations.",
      ),
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
        ? textResult(
            ctx.subject
              ? `Connected as ${ctx.subject}.`
              : "This public connection has no signed-in user.",
          )
        : textResult("Identity confirmation declined.");
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
        text: JSON.stringify({
          subject: ctx.subject,
          user: ctx.user,
          clientId: ctx.clientId,
        }),
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
