import assert from "node:assert/strict";
import { z } from "zod";
import {
  collectionInputSchema,
  collectionOutputSchema,
  collectionResult,
  createSupabaseMcp,
} from "chumbo";

const item = z.object({ id: z.string(), label: z.string() });
const input = collectionInputSchema({
  cursorSchema: z.string().regex(/^item-/),
}).extend({ category: z.enum(["open", "closed"]) });
const output = collectionOutputSchema(item);
assert.equal(input.parse({ category: "open" }).limit, 20);
assert.equal(input.safeParse({ category: "unknown" }).success, false);

const url = "https://example.test/mcp";
const app = createSupabaseMcp({
  server: { name: "zod consumer", version: "1.0.0" },
  resourceUrl: url,
  auth: { mode: "api-key", key: "fixture-key" },
  supabase: {
    env: {
      url: "https://example.test",
      publishableKeys: { default: "fixture" },
    },
  },
  register(server) {
    server.registerTool(
      "list_items",
      { inputSchema: input, outputSchema: output },
      async ({ limit, category }) => {
        const inferred: "open" | "closed" = category;
        // @ts-expect-error Schema inference must reject unrelated values.
        const invalid: "other" = category;
        void invalid;
        return collectionResult({
          items: [{ id: "item-1", label: inferred }],
          limit,
          hasMore: false,
          project: (row) => row,
          itemSchema: item,
          cursorFor: (row) => row.id,
          tool: "list_items",
          mode: "structured",
        });
      },
    );
  },
});

async function call(method: string, params: Record<string, unknown>) {
  const response = await app.fetch(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer fixture-key",
        "mcp-method": method,
        ...(method === "tools/call" ? { "mcp-name": "list_items" } : {}),
        "mcp-protocol-version": "2026-07-28",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "zod-consumer",
              version: "1",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }),
  );
  assert.equal(response.status, 200);
  return response.json();
}
const listed = await call("tools/list", {});
assert.equal(
  listed.result.tools[0].inputSchema.properties.category.enum[0],
  "open",
);
const result = await call("tools/call", {
  name: "list_items",
  arguments: { category: "open" },
});
assert.equal(result.result.isError, undefined);
assert.deepEqual(output.parse(result.result.structuredContent).items, [
  { id: "item-1", label: "open" },
]);
const rejected = await call("tools/call", {
  name: "list_items",
  arguments: { category: "unknown" },
});
assert.ok(rejected.error || rejected.result?.isError);
console.log(
  "Consumer schema inference, composition, discovery, invocation, and rejection passed.",
);
