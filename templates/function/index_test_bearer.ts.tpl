Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "{{LOCAL_ORIGIN}}",
);
{{STATE_TEST_SETUP}}const { default: app } = await import("./index.ts");

Deno.test("bearer mode rejects a missing access token", async () => {
  const response = await app.fetch(
    new Request(
      "{{LOCAL_ENDPOINT}}",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-method": "tools/list",
          "mcp-protocol-version": "2026-07-28",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "bearer-test",
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
    ),
  );

  if (response.status !== 401) {
    throw new Error(`Expected HTTP 401, received ${response.status}`);
  }
});
