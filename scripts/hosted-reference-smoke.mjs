import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectUrl = (
  process.env.SUPA_MCP_REFERENCE_URL ??
  "https://dxrpeagddrpbezbkgvdv.supabase.co"
).replace(/\/$/, "");
const functionsUrl = `${projectUrl}/functions/v1`;

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

async function mcp(endpoint, method, params = {}) {
  const headers = {
    "content-type": "application/json",
    "mcp-method": method,
    "mcp-protocol-version": "2026-07-28",
  };
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
            name: "supa-mcp-hosted-smoke",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
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

const expected = await expectedDocuments();
const verifiedFunctions = new Set(["docs-mcp"]);
const verifiedSurfaces = new Set(["docs-mcp"]);

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
  search.content.some((item) => item.type === "resource_link"),
  "Hosted documentation search returned no linked resources.",
);
assert(
  JSON.stringify(search).length < 4_000,
  "Hosted documentation search exceeded the compact response budget.",
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
  modelResult.content[0].text.includes("→ Next:"),
  "Hosted result text has no next step.",
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
    },
    null,
    2,
  ),
);
