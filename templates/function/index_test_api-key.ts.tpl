Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321",
);
Deno.env.set("MCP_API_KEY", "generated-test-key");
Deno.env.set(
  "SUPABASE_PUBLISHABLE_KEY",
  Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "generated-publishable-key",
);
const { default: app } = await import("./index.ts");

function toolsList(token?: string): Request {
  const headers = new Headers({
    "content-type": "application/json",
    "mcp-method": "tools/list",
    "mcp-protocol-version": "2026-07-28",
  });
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request(
    "http://127.0.0.1:54321/functions/v1/{{FUNCTION_NAME}}",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "api-key-test",
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "generated-test",
              version: "1.0.0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    },
  );
}

Deno.test("api-key mode rejects missing and incorrect keys", async () => {
  for (const token of [undefined, "wrong-key"]) {
    const response = await app.fetch(toolsList(token));
    if (response.status !== 401) {
      throw new Error(`Expected HTTP 401, received ${response.status}`);
    }
  }
});

Deno.test("api-key mode accepts the configured key", async () => {
  const response = await app.fetch(toolsList("generated-test-key"));
  const body = await response.json();
  if (!response.ok || !Array.isArray(body?.result?.tools)) {
    throw new Error(`Expected tools/list success, received ${response.status}`);
  }
});
