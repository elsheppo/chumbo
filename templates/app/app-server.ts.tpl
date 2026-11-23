import {
  defineMcpApp,
  registerMcpApp,
  renderResult,
  structuredResult,
  type McpAppPresentation,
  type SupabaseMcpContext,
  type SupabaseMcpServer,
} from "chumbo";
import { z } from "zod";
import { APP_HTML } from "{{HTML_IMPORT_SPECIFIER}}";

const payloadSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
    }),
  ),
});

export const {{APP_CAMEL}}App = defineMcpApp({
  name: "{{APP_NAME}}",
  uri: "{{APP_URI}}",
  title: (presentation) =>
    presentation.productName
      ? `${presentation.productName} {{APP_TITLE}}`
      : "{{APP_TITLE}}",
  description: "Interactive {{APP_TITLE}} view.",
  html: APP_HTML,
});

export function register{{APP_PASCAL}}App(
  server: SupabaseMcpServer,
  _ctx: SupabaseMcpContext,
  options?: { readonly presentation?: McpAppPresentation },
) {
  const ui = registerMcpApp(server, {{APP_CAMEL}}App, options);

  ui.openTool(
    "open_{{APP_SNAKE}}",
    {
      title: "Open {{APP_TITLE}}",
      description: "Open the interactive {{APP_TITLE}} view.",
      inputSchema: z.object({}).strict(),
      outputSchema: payloadSchema,
    },
    async () =>
      renderResult(
        { items: [] },
        (data) => `Opened {{APP_TITLE}} (${data.items.length} items).`,
      ),
  );

  ui.appTool(
    "refresh_{{APP_SNAKE}}",
    {
      title: "Refresh {{APP_TITLE}}",
      description: "App-only refresh for the {{APP_TITLE}} view.",
      risk: "read",
      inputSchema: z.object({}).strict(),
      outputSchema: payloadSchema,
    },
    async () => structuredResult({ items: [] }),
  );

  return ui;
}
