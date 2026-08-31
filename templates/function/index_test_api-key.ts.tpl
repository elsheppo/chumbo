Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "{{LOCAL_ORIGIN}}",
);
Deno.env.set("MCP_API_KEY", "generated-test-key");
Deno.env.set(
  "SUPABASE_PUBLISHABLE_KEY",
  Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "generated-publishable-key",
);
{{STATE_TEST_SETUP}}const { default: app } = await import("./index.ts");

function mcpRequest(
  method: string,
  params: Record<string, unknown> = {},
  token?: string,
): Request {
  const headers = new Headers({
    "content-type": "application/json",
    "mcp-method": method,
    "mcp-protocol-version": "2026-07-28",
  });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (typeof params.name === "string") headers.set("mcp-name", params.name);
  return new Request(
    "{{LOCAL_ENDPOINT}}",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        params: {
          ...params,
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

const toolsList = (token?: string) => mcpRequest("tools/list", {}, token);

Deno.test("api-key mode rejects missing and incorrect keys", async () => {
  for (const token of [undefined, "wrong-key"]) {
    const response = await app.fetch(toolsList(token));
    if (response.status !== 401) {
      throw new Error(`Expected HTTP 401, received ${response.status}`);
    }
  }
});

Deno.test("the configured key discovers and invokes the starter", async () => {
  const discovery = await app.fetch(toolsList("generated-test-key"));
  const discoveryBody = await discovery.json();
  const names = discoveryBody?.result?.tools?.map(
    (tool: { name: string }) => tool.name,
  );
  if (!discovery.ok || JSON.stringify(names) !== JSON.stringify(["whoami"])) {
    throw new Error(
      `Expected only the whoami starter, received ${JSON.stringify(names)}`,
    );
  }

  const response = await app.fetch(
    mcpRequest(
      "tools/call",
      { name: "whoami", arguments: {} },
      "generated-test-key",
    ),
  );
  const body = await response.json();
  const text = body?.result?.content?.[0]?.text;
  if (
    !response.ok ||
    body.error ||
    typeof text !== "string" ||
    !text.includes("Connected as api-key.") ||
    !text.includes("→ Next:") ||
    body.result.structuredContent !== undefined
  ) {
    throw new Error(`Starter invocation failed: ${JSON.stringify(body)}`);
  }
});
