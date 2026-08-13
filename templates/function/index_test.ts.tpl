import app from "./index.ts";

Deno.test("unauthenticated MCP calls receive an OAuth challenge", async () => {
  const response = await app.fetch(
    new Request(
      "http://127.0.0.1:54321/functions/v1/{{FUNCTION_NAME}}",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-method": "tools/list",
          "mcp-protocol-version": "2026-07-28",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "challenge-test",
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": {
                name: "generated-test",
                version: "1.0.0",
              },
              "io.modelcontextprotocol/clientCapabilities": {
                elicitation: { form: {} },
              },
            },
          },
        }),
      },
    ),
  );

  if (response.status !== 401) {
    throw new Error(`Expected HTTP 401, received ${response.status}`);
  }
  if (!/resource_metadata=/.test(response.headers.get("www-authenticate") ?? "")) {
    throw new Error("OAuth challenge did not include resource_metadata");
  }
});
