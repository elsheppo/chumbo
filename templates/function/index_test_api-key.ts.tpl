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
  if (typeof params.uri === "string") headers.set("mcp-name", params.uri);
  return new Request(
    "http://127.0.0.1:54321/functions/v1/{{FUNCTION_NAME}}",
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

async function call(name: string) {
  const response = await app.fetch(
    mcpRequest(
      "tools/call",
      { name, arguments: {} },
      "generated-test-key",
    ),
  );
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(JSON.stringify(body));
  return body.result;
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
  const tools = body.result.tools;
  for (const name of ["whoami", "identity_snapshot"]) {
    const tool = tools.find((candidate: { name: string }) => candidate.name === name);
    if (!tool?.outputSchema) throw new Error(`${name} has no outputSchema`);
  }
});

Deno.test("generated result contracts stay distinct", async () => {
  const text = await call("connection_help");
  if (!text.content[0]?.text || text.structuredContent !== undefined) {
    throw new Error("connection_help did not return text only");
  }

  const hybrid = await call("whoami");
  if (!hybrid.content[0]?.text || !hybrid.structuredContent) {
    throw new Error("whoami did not return an intentional hybrid");
  }

  const structured = await call("identity_snapshot");
  if (structured.content.length !== 0 || !structured.structuredContent) {
    throw new Error("identity_snapshot duplicated its structured result");
  }

  const linked = await call("open_connected_user");
  if (!linked.content.some((item: { type: string }) => item.type === "resource_link")) {
    throw new Error("open_connected_user did not return a resource link");
  }

  const read = await app.fetch(
    mcpRequest(
      "resources/read",
      { uri: "app://connected-user" },
      "generated-test-key",
    ),
  );
  const readBody = await read.json();
  if (!read.ok || !readBody.result?.contents?.[0]?.text) {
    throw new Error("connected-user resource could not be read");
  }
});
