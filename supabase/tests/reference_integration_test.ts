import { createClient } from "@supabase/supabase-js";
import authenticatedApp from "../functions/authenticated-tools/index.ts";
import docsApp from "../functions/docs-mcp/index.ts";
import manyMcpsApp from "../functions/many-mcps/index.ts";
import modelResultsApp from "../functions/model-facing-results/index.ts";

const projectUrl = Deno.env.get("SUPABASE_URL");
const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!projectUrl || !anonKey || !serviceRoleKey) {
  throw new Error(
    "Reference integration tests require local Supabase credentials.",
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, label: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    throw new Error(`${label}: expected ${right}, received ${left}`);
  }
}

function mcpRequest(
  url: string,
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
  return new Request(url, {
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
            name: "supa-mcp-reference-test",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

async function json(response: Response): Promise<any> {
  const text = await response.text();
  assert(response.ok, `HTTP ${response.status}: ${text}`);
  return JSON.parse(text);
}

Deno.test("documentation MCP retrieves the three tested patterns", async () => {
  const url = `${projectUrl}/functions/v1/docs-mcp`;
  const tools = await json(await docsApp.fetch(mcpRequest(url, "tools/list")));
  equal(
    tools.result.tools.map((tool: { name: string }) => tool.name).sort(),
    ["get_example", "get_pattern", "get_setup_steps", "search_docs"],
    "documentation tool surface",
  );

  for (const slug of [
    "authenticated-tools",
    "model-facing-results",
    "many-mcps-one-function",
  ]) {
    const response = await json(
      await docsApp.fetch(
        mcpRequest(url, "tools/call", {
          name: "get_pattern",
          arguments: { slug },
        }),
      ),
    );
    equal(response.result.structuredContent.slug, slug, `pattern ${slug}`);
    assert(
      response.result.content[0].text.includes("Source:"),
      `${slug} has source`,
    );
    assert(
      response.result.content[0].text.includes("→ Next:"),
      `${slug} has next step`,
    );
  }

  const search = await json(
    await docsApp.fetch(
      mcpRequest(url, "tools/call", {
        name: "search_docs",
        arguments: { query: "many MCPs one function" },
      }),
    ),
  );
  assert(
    search.result.structuredContent.matches.length > 0,
    "search returns a match",
  );
});

Deno.test(
  "authenticated tools preserve caller identity through RLS",
  async () => {
    const admin = createClient(projectUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const credentials = [
      { email: "alice@supa-mcp.test", password: "reference-alice-password" },
      { email: "bob@supa-mcp.test", password: "reference-bob-password" },
    ];
    for (const credential of credentials) {
      const { error } = await admin.auth.admin.createUser({
        ...credential,
        email_confirm: true,
      });
      if (error && !error.message.includes("already been registered")) {
        throw error;
      }
    }

    const tokens: string[] = [];
    for (const credential of credentials) {
      const client = createClient(projectUrl, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await client.auth.signInWithPassword(credential);
      if (error) throw error;
      assert(data.session?.access_token, `token for ${credential.email}`);
      tokens.push(data.session.access_token);
    }

    const url = `${projectUrl}/functions/v1/authenticated-tools`;
    const unauthenticated = await authenticatedApp.fetch(
      mcpRequest(url, "tools/list"),
    );
    equal(unauthenticated.status, 401, "unauthenticated status");

    for (const [index, token] of tokens.entries()) {
      const created = await json(
        await authenticatedApp.fetch(
          mcpRequest(
            url,
            "tools/call",
            {
              name: "create_project",
              arguments: {
                name: index === 0 ? "Alice Project" : "Bob Project",
              },
            },
            token,
          ),
        ),
      );
      assert(created.result.structuredContent.project.id, "created project ID");
    }

    const [alice, bob] = await Promise.all(
      tokens.map((token) =>
        authenticatedApp
          .fetch(
            mcpRequest(
              url,
              "tools/call",
              {
                name: "list_projects",
                arguments: {},
              },
              token,
            ),
          )
          .then(json),
      ),
    );
    equal(
      alice.result.structuredContent.projects.map(
        (project: { name: string }) => project.name,
      ),
      ["Alice Project"],
      "Alice RLS slice",
    );
    equal(
      bob.result.structuredContent.projects.map(
        (project: { name: string }) => project.name,
      ),
      ["Bob Project"],
      "Bob RLS slice",
    );
  },
);

Deno.test(
  "model-facing results stay legible in populated, empty, and error branches",
  async () => {
    const url = `${projectUrl}/functions/v1/model-facing-results`;
    for (const name of [
      "list_examples",
      "show_empty_state",
      "show_recoverable_error",
    ]) {
      const body = await json(
        await modelResultsApp.fetch(
          mcpRequest(url, "tools/call", { name, arguments: {} }),
        ),
      );
      const text = body.result.content[0].text;
      assert(text.includes("→ Next:"), `${name} has a next step`);
      assert(!text.trimStart().startsWith("{"), `${name} is not a JSON dump`);
    }
  },
);

Deno.test(
  "one function resolves two live row-defined MCP surfaces",
  async () => {
    const directoryUrl = `${projectUrl}/functions/v1/many-mcps/directory`;
    const invoiceUrl = `${projectUrl}/functions/v1/many-mcps/invoices`;
    const [directory, invoices] = await Promise.all([
      manyMcpsApp.fetch(mcpRequest(directoryUrl, "tools/list")).then(json),
      manyMcpsApp.fetch(mcpRequest(invoiceUrl, "tools/list")).then(json),
    ]);
    equal(
      directory.result.tools.map((tool: { name: string }) => tool.name),
      ["list_businesses"],
      "directory tools",
    );
    equal(
      invoices.result.tools.map((tool: { name: string }) => tool.name),
      ["list_invoices"],
      "invoice tools",
    );

    const admin = createClient(projectUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await admin
      .from("reference_tools")
      .update({
        response: {
          businesses: [{ name: "Live Row Update", category: "proof" }],
        },
      })
      .eq("server_slug", "directory")
      .eq("name", "list_businesses");
    if (error) throw error;

    const updated = await json(
      await manyMcpsApp.fetch(
        mcpRequest(directoryUrl, "tools/call", {
          name: "list_businesses",
          arguments: {},
        }),
      ),
    );
    assert(
      updated.result.content[0].text.includes("Live Row Update"),
      "row update is live",
    );

    const missing = await manyMcpsApp.fetch(
      mcpRequest(`${projectUrl}/functions/v1/many-mcps/missing`, "tools/list"),
    );
    equal(missing.status, 404, "unknown MCP status");
  },
);
