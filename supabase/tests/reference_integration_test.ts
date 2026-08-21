import { createClient } from "@supabase/supabase-js";
import authenticatedApp from "../functions/authenticated-tools/index.ts";
import docsApp from "../functions/docs-mcp/index.ts";
import manyMcpsApp from "../functions/many-mcps/index.ts";
import modelResultsApp from "../functions/model-facing-results/index.ts";
import privilegedApp from "../functions/privileged-capabilities/index.ts";
import reviewQueueApp from "../functions/review-queue-app/index.ts";

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
  if (typeof params.uri === "string") headers.set("mcp-name", params.uri);
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

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

Deno.test("documentation MCP retrieves the tested patterns", async () => {
  const url = `${projectUrl}/functions/v1/docs-mcp`;
  const tools = await json(await docsApp.fetch(mcpRequest(url, "tools/list")));
  equal(
    tools.result.tools.map((tool: { name: string }) => tool.name).sort(),
    [
      "get_example",
      "get_pattern",
      "get_reference",
      "get_setup_steps",
      "search_docs",
    ],
    "documentation tool surface",
  );

  for (const slug of [
    "authenticated-tools",
    "model-facing-results",
    "many-mcps-one-function",
    "privileged-capabilities",
    "mcp-apps-on-supabase",
  ]) {
    const response = await json(
      await docsApp.fetch(
        mcpRequest(url, "tools/call", {
          name: "get_pattern",
          arguments: { slug },
        }),
      ),
    );
    const link = response.result.content.find(
      (item: { type: string }) => item.type === "resource_link",
    );
    assert(link, `${slug} has a resource link`);
    equal(link.uri, `supa-mcp://docs/pattern/${slug}`, `pattern ${slug}`);
    assert(
      response.result.content[0].text.includes("Source:"),
      `${slug} has source`,
    );
    assert(
      response.result.content[0].text.includes("→ Next:"),
      `${slug} has next step`,
    );
    assert(
      JSON.stringify(response.result).length < 2_000,
      `${slug} is compact`,
    );
  }

  for (const slug of ["auth-modes", "connect-clients", "getting-started"]) {
    const response = await json(
      await docsApp.fetch(
        mcpRequest(url, "tools/call", {
          name: "get_reference",
          arguments: { slug },
        }),
      ),
    );
    const link = response.result.content.find(
      (item: { type: string }) => item.type === "resource_link",
    );
    assert(link, `${slug} has a resource link`);
    equal(link.uri, `supa-mcp://docs/reference/${slug}`, `reference ${slug}`);
    assert(
      response.result.content[0].text.includes("→ Next:"),
      `${slug} has next step`,
    );
    assert(
      JSON.stringify(response.result).length < 2_000,
      `${slug} is compact`,
    );
  }

  const templates = await json(
    await docsApp.fetch(mcpRequest(url, "resources/templates/list")),
  );
  assert(
    templates.result.resourceTemplates.some(
      (template: { uriTemplate: string }) =>
        template.uriTemplate === "supa-mcp://docs/{kind}/{slug}",
    ),
    "documentation resource template is discoverable",
  );

  const resources = await json(
    await docsApp.fetch(mcpRequest(url, "resources/list")),
  );
  assert(
    resources.result.resources.some(
      (resource: { uri: string }) =>
        resource.uri === "supa-mcp://docs/reference/getting-started",
    ),
    "documentation resources are enumerable",
  );

  const fullDocument = await json(
    await docsApp.fetch(
      mcpRequest(url, "resources/read", {
        uri: "supa-mcp://docs/reference/getting-started",
      }),
    ),
  );
  assert(
    fullDocument.result.contents[0].text.includes("# Start a Supa MCP server"),
    "complete markdown is served only through resources/read",
  );
  assert(
    typeof fullDocument.result.contents[0]._meta.contentHash === "string",
    "resource preserves source metadata",
  );

  const search = await json(
    await docsApp.fetch(
      mcpRequest(url, "tools/call", {
        name: "search_docs",
        arguments: { query: "many MCPs one function" },
      }),
    ),
  );
  assert(
    search.result.content.some(
      (item: { type: string }) => item.type === "resource_link",
    ),
    "search returns linked resources",
  );
  assert(
    JSON.stringify(search.result).length < 4_000,
    "search result is bounded",
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

    const structured = await json(
      await modelResultsApp.fetch(
        mcpRequest(url, "tools/call", {
          name: "get_result_contract",
          arguments: {},
        }),
      ),
    );
    equal(structured.result.content, [], "structured result has no text copy");
    equal(
      structured.result.structuredContent.modes,
      ["text", "structured", "hybrid", "resource"],
      "structured result value",
    );

    const linked = await json(
      await modelResultsApp.fetch(
        mcpRequest(url, "tools/call", {
          name: "open_result_guide",
          arguments: {},
        }),
      ),
    );
    assert(
      linked.result.content.some(
        (item: { type: string }) => item.type === "resource_link",
      ),
      "large result returns a resource link",
    );
    assert(
      !JSON.stringify(linked.result).includes("Choose text, structured data"),
      "large result does not embed its resource body",
    );
  },
);

Deno.test(
  "MCP App review actions preserve host metadata and caller RLS",
  async () => {
    const admin = createClient(projectUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const credentials = [
      {
        email: "app-alice@supa-mcp.test",
        password: "reference-app-alice-password",
      },
      {
        email: "app-bob@supa-mcp.test",
        password: "reference-app-bob-password",
      },
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

    const identities: Array<{ id: string; token: string }> = [];
    for (const credential of credentials) {
      const client = createClient(projectUrl, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await client.auth.signInWithPassword(credential);
      if (error) throw error;
      assert(data.user?.id, `user ID for ${credential.email}`);
      assert(data.session?.access_token, `token for ${credential.email}`);
      identities.push({
        id: data.user.id,
        token: data.session.access_token,
      });
    }

    const [aliceIdentity, bobIdentity] = identities;
    await admin
      .from("review_items")
      .delete()
      .in("owner_id", [aliceIdentity.id, bobIdentity.id]);
    const { data: inserted, error: insertError } = await admin
      .from("review_items")
      .insert([
        {
          owner_id: aliceIdentity.id,
          title: "Approve the neighborhood guide",
          summary: "A concise local guide is ready for editorial review.",
        },
        {
          owner_id: bobIdentity.id,
          title: "Review the seasonal menu",
          summary: "A draft menu is waiting for the business owner.",
        },
      ])
      .select("id, owner_id, title");
    if (insertError) throw insertError;
    assert(inserted?.length === 2, "two review fixtures inserted");
    const aliceItem = inserted.find(
      (item) => item.owner_id === aliceIdentity.id,
    );
    const bobItem = inserted.find((item) => item.owner_id === bobIdentity.id);
    assert(aliceItem && bobItem, "both review fixtures are addressable");

    const url = `${projectUrl}/functions/v1/review-queue-app`;
    const unauthenticated = await reviewQueueApp.fetch(
      mcpRequest(url, "tools/list"),
    );
    equal(unauthenticated.status, 401, "review app requires authentication");

    const tools = await json(
      await reviewQueueApp.fetch(
        mcpRequest(url, "tools/list", {}, aliceIdentity.token),
      ),
    );
    const openTool = tools.result.tools.find(
      (tool: { name: string }) => tool.name === "open_review_queue",
    );
    const refreshTool = tools.result.tools.find(
      (tool: { name: string }) => tool.name === "refresh_review_queue",
    );
    const decideTool = tools.result.tools.find(
      (tool: { name: string }) => tool.name === "decide_review_item",
    );
    equal(
      openTool?._meta?.ui,
      {
        resourceUri: "ui://supa-mcp/review-queue.html",
        visibility: ["model"],
      },
      "model-visible app metadata",
    );
    equal(refreshTool?._meta?.ui?.visibility, ["app"], "refresh is app-only");
    equal(decideTool?._meta?.ui?.visibility, ["app"], "decision is app-only");
    equal(
      openTool?._meta?.["ui/resourceUri"],
      "ui://supa-mcp/review-queue.html",
      "legacy host metadata remains available",
    );

    const resources = await json(
      await reviewQueueApp.fetch(
        mcpRequest(url, "resources/list", {}, aliceIdentity.token),
      ),
    );
    equal(
      resources.result.resources.map(
        (resource: { uri: string }) => resource.uri,
      ),
      ["ui://supa-mcp/review-queue.html"],
      "app resource is discoverable",
    );
    const appResource = await json(
      await reviewQueueApp.fetch(
        mcpRequest(
          url,
          "resources/read",
          { uri: "ui://supa-mcp/review-queue.html" },
          aliceIdentity.token,
        ),
      ),
    );
    const appContent = appResource.result.contents[0];
    equal(
      appContent.mimeType,
      "text/html;profile=mcp-app",
      "MCP App MIME type",
    );
    assert(
      appContent.text.includes("Supa MCP Review Queue"),
      "single-file app contains its compiled browser client",
    );
    assert(
      new TextEncoder().encode(appContent.text).byteLength < 400_000,
      "single-file app stays within its initial size budget",
    );

    const aliceQueue = await json(
      await reviewQueueApp.fetch(
        mcpRequest(
          url,
          "tools/call",
          { name: "open_review_queue", arguments: {} },
          aliceIdentity.token,
        ),
      ),
    );
    equal(
      aliceQueue.result.structuredContent.items.map(
        (item: { title: string }) => item.title,
      ),
      ["Approve the neighborhood guide"],
      "Alice sees only Alice's queue",
    );
    assert(
      aliceQueue.result.content[0].text.includes("→ Next:"),
      "non-App hosts receive a useful text fallback",
    );

    const crossUserDecision = await json(
      await reviewQueueApp.fetch(
        mcpRequest(
          url,
          "tools/call",
          {
            name: "decide_review_item",
            arguments: { id: bobItem.id, decision: "approved" },
          },
          aliceIdentity.token,
        ),
      ),
    );
    assert(crossUserDecision.result.isError, "Alice cannot decide Bob's item");

    const aliceDecision = await json(
      await reviewQueueApp.fetch(
        mcpRequest(
          url,
          "tools/call",
          {
            name: "decide_review_item",
            arguments: { id: aliceItem.id, decision: "approved" },
          },
          aliceIdentity.token,
        ),
      ),
    );
    equal(
      aliceDecision.result.structuredContent.pendingCount,
      0,
      "Alice's decision persists",
    );

    const bobQueue = await json(
      await reviewQueueApp.fetch(
        mcpRequest(
          url,
          "tools/call",
          { name: "refresh_review_queue", arguments: {} },
          bobIdentity.token,
        ),
      ),
    );
    equal(
      bobQueue.result.structuredContent.items.map(
        (item: { title: string; status: string }) => [item.title, item.status],
      ),
      [["Review the seasonal menu", "pending"]],
      "Bob's queue remains isolated",
    );
  },
);

Deno.test(
  "one endpoint gives normal and privileged identities different surfaces",
  async () => {
    const admin = createClient(projectUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const credential = {
      email: "capability-user@supa-mcp.test",
      password: "reference-capability-password",
    };
    const { error: createError } = await admin.auth.admin.createUser({
      ...credential,
      email_confirm: true,
    });
    if (
      createError &&
      !createError.message.includes("already been registered")
    ) {
      throw createError;
    }
    const userClient = createClient(projectUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: signIn, error: signInError } =
      await userClient.auth.signInWithPassword(credential);
    if (signInError) throw signInError;
    const userToken = signIn.session?.access_token;
    assert(userToken, "normal user token");

    const ownerToken = `supa_ref_${crypto.randomUUID()}`;
    const { error: keyError } = await admin.from("reference_api_keys").insert({
      token_hash: await sha256(ownerToken),
      subject: "reference-owner",
      scopes: ["catalog:publish"],
    });
    if (keyError) throw keyError;

    const url = `${projectUrl}/functions/v1/privileged-capabilities`;
    const list = async (method: string, token: string) => {
      const body = await json(
        await privilegedApp.fetch(mcpRequest(url, method, {}, token)),
      );
      const key = method.split("/")[0];
      return body.result[key] ?? [];
    };

    const [userTools, userResources, userPrompts] = await Promise.all([
      list("tools/list", userToken),
      list("resources/list", userToken),
      list("prompts/list", userToken),
    ]);
    equal(
      userTools.map((item: { name: string }) => item.name),
      ["list_catalog"],
      "normal user tools",
    );
    equal(
      userResources.map((item: { name: string }) => item.name),
      ["catalog-guide"],
      "normal user resources",
    );
    equal(userPrompts, [], "normal user prompts");

    const [ownerTools, ownerResources, ownerPrompts] = await Promise.all([
      list("tools/list", ownerToken),
      list("resources/list", ownerToken),
      list("prompts/list", ownerToken),
    ]);
    equal(
      ownerTools.map((item: { name: string }) => item.name),
      ["preview_publication"],
      "owner tools",
    );
    equal(ownerResources, [], "owner resources");
    equal(
      ownerPrompts.map((item: { name: string }) => item.name),
      ["plan_publication"],
      "owner prompts",
    );

    const bypass = await privilegedApp.fetch(
      mcpRequest(
        url,
        "tools/call",
        { name: "preview_publication", arguments: { title: "Denied" } },
        userToken,
      ),
    );
    const bypassBody = await bypass.json();
    assert(bypassBody.error, "normal user cannot invoke privileged tool");

    const invalid = await privilegedApp.fetch(
      mcpRequest(url, "tools/list", {}, "supa_ref_invalid"),
    );
    equal(invalid.status, 401, "invalid application key status");
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
      updated.result.content.length === 0 &&
        updated.result.structuredContent.businesses[0].name ===
          "Live Row Update",
      "row update is live without a duplicate text lane",
    );

    const missing = await manyMcpsApp.fetch(
      mcpRequest(`${projectUrl}/functions/v1/many-mcps/missing`, "tools/list"),
    );
    equal(missing.status, 404, "unknown MCP status");
  },
);
