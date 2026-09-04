import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deployment = JSON.parse(
  await readFile(
    path.join(root, "docs", "deployment", "hosted-reference.json"),
    "utf8",
  ),
);
const expectedRuntimeName = deployment.packageName;
const expectedRuntimeVersion = deployment.packageVersion;
const projectUrl = (
  process.env.SUPA_MCP_REFERENCE_URL ??
  "https://dxrpeagddrpbezbkgvdv.supabase.co"
).replace(/\/$/, "");
const functionsUrl = `${projectUrl}/functions/v1`;
const publishableKey =
  process.env.SUPA_MCP_REFERENCE_PUBLISHABLE_KEY ??
  process.env.SUPA_MCP_REFERENCE_ANON_KEY;
const serviceRoleKey = process.env.SUPA_MCP_REFERENCE_SERVICE_ROLE_KEY;

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolute)));
    else files.push(absolute);
  }
  return files;
}

async function expectedDocuments() {
  const metadataFiles = [
    ...(await walk(path.join(root, "docs"))),
    ...(await walk(path.join(root, "examples"))),
  ].filter((file) => /\/(document|pattern|example)\.json$/.test(file));
  const expected = [];
  for (const metadataFile of metadataFiles) {
    const metadataText = await readFile(metadataFile, "utf8");
    const metadata = JSON.parse(metadataText);
    const body = await readFile(
      path.join(path.dirname(metadataFile), "README.md"),
      "utf8",
    );
    expected.push({
      ...metadata,
      body,
      contentHash: createHash("sha256")
        .update(JSON.stringify(metadata))
        .update("\n")
        .update(body)
        .digest("hex"),
    });
  }
  return expected;
}

async function mcp(endpoint, method, params = {}, bearer) {
  const headers = {
    "content-type": "application/json",
    "mcp-method": method,
    "mcp-protocol-version": "2026-07-28",
  };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (typeof params.name === "string") headers["mcp-name"] = params.name;
  if (typeof params.uri === "string") headers["mcp-name"] = params.uri;
  const response = await fetch(`${functionsUrl}/${endpoint}`, {
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
            name: "chumbo-hosted-smoke",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  assertRuntimeVersion(response, endpoint);
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${endpoint} returned HTTP ${response.status}: ${text}`);
  const body = JSON.parse(text);
  if (body.error)
    throw new Error(
      `${endpoint} returned MCP error: ${JSON.stringify(body.error)}`,
    );
  return body.result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertRuntimeVersion(response, endpoint) {
  const configured = deployment.functions?.[endpoint.split("/")[0]];
  const expectedRuntimeName = configured?.packageName ?? deployment.packageName;
  const expectedRuntimeVersion =
    configured?.packageVersion ?? deployment.packageVersion;
  const canonicalHeader =
    expectedRuntimeName === "chumbo"
      ? "x-chumbo-version"
      : "x-supa-mcp-version";
  const actual = response.headers.get(canonicalHeader);
  assert(
    actual === expectedRuntimeVersion,
    `Hosted ${endpoint} runs ${expectedRuntimeName} ${actual ?? "unknown"}; expected ${expectedRuntimeVersion}.`,
  );
  if (expectedRuntimeName === "chumbo") {
    assert(
      response.headers.get("x-supa-mcp-version") === expectedRuntimeVersion,
      `Hosted ${endpoint} is missing the matching legacy x-supa-mcp-version compatibility header.`,
    );
  }
}

const expected = await expectedDocuments();
const verifiedFunctions = new Set(["docs-mcp"]);
const verifiedSurfaces = new Set(["docs-mcp"]);

const claudePreflight = await fetch(`${functionsUrl}/review-queue-app`, {
  method: "OPTIONS",
  headers: {
    origin: "https://claude.ai",
    "access-control-request-method": "POST",
    "access-control-request-headers":
      "authorization, content-type, mcp-protocol-version",
  },
});
assert(
  claudePreflight.status === 204,
  `Hosted Claude preflight returned HTTP ${claudePreflight.status}.`,
);
assert(
  claudePreflight.headers.get("access-control-allow-origin") ===
    "https://claude.ai",
  "Hosted review app did not admit Claude's exact browser origin.",
);
assert(
  claudePreflight.headers
    .get("access-control-allow-headers")
    ?.includes("mcp-protocol-version"),
  "Hosted review app preflight omitted MCP transport headers.",
);

const unknownPreflight = await fetch(`${functionsUrl}/review-queue-app`, {
  method: "OPTIONS",
  headers: {
    origin: "https://not-a-configured-host.example",
    "access-control-request-method": "POST",
  },
});
assert(
  unknownPreflight.headers.get("access-control-allow-origin") === null,
  "Hosted review app admitted an unknown browser origin.",
);

const tools = await mcp("docs-mcp", "tools/list");
assert(
  JSON.stringify(tools.tools.map((tool) => tool.name).sort()) ===
    JSON.stringify([
      "get_example",
      "get_pattern",
      "get_reference",
      "get_setup_steps",
      "search_docs",
    ]),
  "The hosted documentation tool surface drifted.",
);

const search = await mcp("docs-mcp", "tools/call", {
  name: "search_docs",
  arguments: { query: "many MCPs one function" },
});
assert(
  search.structuredContent?.items.length > 0,
  "Hosted search returned no compact matches.",
);
assert(
  search.structuredContent.items.every((item) =>
    item.uri.startsWith("supa-mcp://docs/"),
  ),
  "Hosted search omitted resource paths.",
);
assert(
  new TextEncoder().encode(JSON.stringify(search)).byteLength <= 8000,
  "Hosted search exceeded its complete response budget.",
);
const firstDocsPage = await mcp("docs-mcp", "tools/call", {
  name: "search_docs",
  arguments: { query: "Chumbo", limit: 1 },
});
assert(
  firstDocsPage.structuredContent.has_more,
  "Hosted docs did not offer another page.",
);
const nextDocsCall = firstDocsPage.structuredContent.next_call;
assert(
  nextDocsCall.arguments.query === "Chumbo",
  "Hosted docs continuation lost its query.",
);
const nextDocsPage = await mcp("docs-mcp", "tools/call", nextDocsCall);
assert(
  nextDocsPage.structuredContent.items[0].slug !==
    firstDocsPage.structuredContent.items[0].slug,
  "Hosted docs continuation repeated its first record.",
);

const templates = await mcp("docs-mcp", "resources/templates/list");
assert(
  templates.resourceTemplates.some(
    (template) => template.uriTemplate === "supa-mcp://docs/{kind}/{slug}",
  ),
  "Hosted documentation resource template is missing.",
);

const resources = await mcp("docs-mcp", "resources/list");
assert(
  resources.resources.length === expected.length,
  "Hosted documentation resource catalog drifted.",
);

for (const expectedDocument of expected) {
  let result;
  if (expectedDocument.kind === "pattern") {
    result = await mcp("docs-mcp", "tools/call", {
      name: "get_pattern",
      arguments: { slug: expectedDocument.slug },
    });
  } else if (expectedDocument.kind === "example") {
    result = await mcp("docs-mcp", "tools/call", {
      name: "get_example",
      arguments: { slug: expectedDocument.slug },
    });
  } else if (expectedDocument.kind === "reference") {
    result = await mcp("docs-mcp", "tools/call", {
      name: "get_reference",
      arguments: { slug: expectedDocument.slug },
    });
  }
  const link = result?.content.find((item) => item.type === "resource_link");
  assert(
    link,
    `Hosted document ${expectedDocument.slug} has no resource link.`,
  );
  assert(
    link._meta.contentHash === expectedDocument.contentHash,
    `Hosted document ${expectedDocument.slug} does not match Git.`,
  );
  assert(
    JSON.stringify(result).length < 2_000,
    `Hosted document ${expectedDocument.slug} exceeded the compact response budget.`,
  );
  const read = await mcp("docs-mcp", "resources/read", { uri: link.uri });
  assert(
    read.contents[0].text === expectedDocument.body,
    `Hosted resource ${expectedDocument.slug} does not match Git.`,
  );
}

const unauthenticated = await fetch(`${functionsUrl}/authenticated-tools`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "mcp-method": "tools/list",
    "mcp-protocol-version": "2026-07-28",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/list",
    params: {},
  }),
});
assertRuntimeVersion(unauthenticated, "authenticated-tools");
assert(
  unauthenticated.status === 401,
  `Hosted authenticated-tools returned HTTP ${unauthenticated.status} without a bearer token.`,
);
assert(
  unauthenticated.headers.get("www-authenticate")?.startsWith("Bearer "),
  "Hosted authenticated-tools did not return a Bearer challenge.",
);
verifiedFunctions.add("authenticated-tools");
verifiedSurfaces.add("authenticated-tools");

const privilegedUnauthenticated = await fetch(
  `${functionsUrl}/privileged-capabilities`,
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-method": "tools/list",
      "mcp-protocol-version": "2026-07-28",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/list",
      params: {},
    }),
  },
);
assertRuntimeVersion(privilegedUnauthenticated, "privileged-capabilities");
assert(
  privilegedUnauthenticated.status === 401,
  `Hosted privileged-capabilities returned HTTP ${privilegedUnauthenticated.status} without credentials.`,
);
verifiedFunctions.add("privileged-capabilities");
verifiedSurfaces.add("privileged-capabilities");

const modelResult = await mcp("model-facing-results", "tools/call", {
  name: "list_examples",
  arguments: {},
});
assert(
  modelResult.structuredContent.items.length === 1 &&
    modelResult.structuredContent.has_more,
  "Hosted example must return one bounded first page.",
);
assert(
  modelResult.content.some((item) => item.text?.includes("exact next call")),
  "Hosted middleware omitted navigation guidance.",
);
const nextExample = await mcp(
  "model-facing-results",
  "tools/call",
  modelResult.structuredContent.next_call,
);
assert(
  nextExample.structuredContent.items[0].id === "2" &&
    !nextExample.structuredContent.has_more,
  "Hosted exact continuation failed or did not terminate.",
);
assert(
  !JSON.stringify(modelResult).includes("internalNotes"),
  "Hosted projection leaked source fields.",
);
verifiedFunctions.add("model-facing-results");
verifiedSurfaces.add("model-facing-results");

const directory = await mcp("many-mcps/directory", "tools/list");
const invoices = await mcp("many-mcps/invoices", "tools/list");
assert(
  directory.tools[0]?.name === "list_businesses",
  "Directory MCP drifted.",
);
assert(invoices.tools[0]?.name === "list_invoices", "Invoices MCP drifted.");
verifiedFunctions.add("many-mcps");
verifiedSurfaces.add("many-mcps/directory");
verifiedSurfaces.add("many-mcps/invoices");

let authenticatedApp = "skipped";
if (Boolean(publishableKey) !== Boolean(serviceRoleKey)) {
  throw new Error(
    "Set both SUPA_MCP_REFERENCE_PUBLISHABLE_KEY (or the legacy anon key) and SUPA_MCP_REFERENCE_SERVICE_ROLE_KEY to verify the authenticated MCP App.",
  );
}

if (publishableKey && serviceRoleKey) {
  const admin = createClient(projectUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const credentials = ["alice", "bob"].map((name) => ({
    email: `hosted-app-${name}-${suffix}@chumbo.test`,
    password: `Chumbo-${crypto.randomUUID()}-aA1!`,
  }));
  const users = [];

  try {
    for (const credential of credentials) {
      const { data, error } = await admin.auth.admin.createUser({
        ...credential,
        email_confirm: true,
      });
      if (error) throw error;
      users.push(data.user);
    }

    const identities = [];
    for (const credential of credentials) {
      const client = createClient(projectUrl, publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data, error } = await client.auth.signInWithPassword(credential);
      if (error) throw error;
      assert(
        data.user && data.session,
        `Hosted sign-in failed for ${credential.email}.`,
      );
      identities.push({ id: data.user.id, token: data.session.access_token });
    }

    const [alice, bob] = identities;
    const { data: inserted, error: insertError } = await admin
      .from("review_items")
      .insert([
        {
          owner_id: alice.id,
          title: "Approve the hosted neighborhood guide",
          summary: "A production-shaped hosted item is ready for Alice.",
        },
        {
          owner_id: bob.id,
          title: "Review the hosted seasonal menu",
          summary: "A separate hosted item is waiting for Bob.",
        },
      ])
      .select("id, owner_id, title");
    if (insertError) throw insertError;
    const aliceItem = inserted.find((item) => item.owner_id === alice.id);
    const bobItem = inserted.find((item) => item.owner_id === bob.id);
    assert(aliceItem && bobItem, "Hosted review fixtures were not created.");

    const unauthenticatedApp = await fetch(`${functionsUrl}/review-queue-app`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-method": "tools/list",
        "mcp-protocol-version": "2026-07-28",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/list",
        params: {},
      }),
    });
    assertRuntimeVersion(unauthenticatedApp, "review-queue-app");
    assert(
      unauthenticatedApp.status === 401,
      `Hosted review app returned HTTP ${unauthenticatedApp.status} without credentials.`,
    );

    const appTools = await mcp(
      "review-queue-app",
      "tools/list",
      {},
      alice.token,
    );
    const toolByName = Object.fromEntries(
      appTools.tools.map((tool) => [tool.name, tool]),
    );
    assert(
      toolByName.open_review_queue?._meta?.ui?.visibility?.[0] === "model",
      "Hosted opener is not model-visible.",
    );
    for (const name of ["refresh_review_queue", "decide_review_item"]) {
      assert(
        toolByName[name]?._meta?.ui?.visibility?.[0] === "app",
        `Hosted ${name} is not app-only.`,
      );
    }

    const appResources = await mcp(
      "review-queue-app",
      "resources/list",
      {},
      alice.token,
    );
    assert(
      appResources.resources.some(
        (resource) => resource.uri === "ui://supa-mcp/review-queue.html",
      ),
      "Hosted review app resource is missing.",
    );
    const appResource = await mcp(
      "review-queue-app",
      "resources/read",
      { uri: "ui://supa-mcp/review-queue.html" },
      alice.token,
    );
    const appHtml = appResource.contents[0];
    assert(
      appHtml.mimeType === "text/html;profile=mcp-app",
      "Hosted review app has the wrong MIME type.",
    );
    assert(
      new TextEncoder().encode(appHtml.text).byteLength < 400_000,
      "Hosted review app bundle exceeded its size budget.",
    );
    assert(
      !appHtml.text.includes(publishableKey) &&
        !appHtml.text.includes(serviceRoleKey),
      "Hosted review app bundle contains a Supabase credential.",
    );

    const aliceQueue = await mcp(
      "review-queue-app",
      "tools/call",
      { name: "open_review_queue", arguments: {} },
      alice.token,
    );
    assert(
      aliceQueue.content[0]?.text.includes("→ Next:"),
      "Hosted review opener has no text fallback.",
    );
    assert(
      JSON.stringify(
        aliceQueue.structuredContent.items.map((item) => item.title),
      ) === JSON.stringify([aliceItem.title]),
      "Hosted Alice queue crossed the RLS boundary.",
    );

    const crossUserDecision = await mcp(
      "review-queue-app",
      "tools/call",
      {
        name: "decide_review_item",
        arguments: { id: bobItem.id, decision: "approved" },
      },
      alice.token,
    );
    assert(crossUserDecision.isError, "Hosted Alice could decide Bob's item.");

    const ownDecision = await mcp(
      "review-queue-app",
      "tools/call",
      {
        name: "decide_review_item",
        arguments: { id: aliceItem.id, decision: "approved" },
      },
      alice.token,
    );
    assert(
      ownDecision.structuredContent.pendingCount === 0,
      "Hosted Alice decision did not persist.",
    );
    const bobQueue = await mcp(
      "review-queue-app",
      "tools/call",
      { name: "refresh_review_queue", arguments: {} },
      bob.token,
    );
    assert(
      bobQueue.structuredContent.items.length === 1 &&
        bobQueue.structuredContent.items[0].id === bobItem.id &&
        bobQueue.structuredContent.items[0].status === "pending",
      "Hosted Bob queue did not remain isolated.",
    );

    verifiedFunctions.add("review-queue-app");
    verifiedSurfaces.add("review-queue-app");
    authenticatedApp = "verified";
  } finally {
    if (users.length) {
      await admin
        .from("review_items")
        .delete()
        .in(
          "owner_id",
          users.map((user) => user.id),
        );
      for (const user of users) await admin.auth.admin.deleteUser(user.id);
    }
  }
}

console.log(
  JSON.stringify(
    {
      status: "ok",
      projectUrl,
      documents: expected.length,
      patterns: expected.filter((document) => document.kind === "pattern")
        .length,
      functions: verifiedFunctions.size,
      surfaces: verifiedSurfaces.size,
      authenticatedApp,
      oauthConsent: "not-a-hosted-mcp-gate",
    },
    null,
    2,
  ),
);
