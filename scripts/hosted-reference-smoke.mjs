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

const tools = await mcp("docs-mcp", "tools/list");
assert(
  JSON.stringify(tools.tools.map((tool) => tool.name).sort()) ===
    JSON.stringify([
      "get_example",
      "get_pattern",
      "get_setup_steps",
      "search_docs",
    ]),
  "The hosted documentation tool surface drifted.",
);

for (const expected of await expectedDocuments()) {
  let document;
  if (expected.kind === "pattern") {
    document = (
      await mcp("docs-mcp", "tools/call", {
        name: "get_pattern",
        arguments: { slug: expected.slug },
      })
    ).structuredContent;
  } else if (expected.kind === "example") {
    document = (
      await mcp("docs-mcp", "tools/call", {
        name: "get_example",
        arguments: { slug: expected.slug },
      })
    ).structuredContent;
  } else if (expected.slug === "getting-started") {
    document = (
      await mcp("docs-mcp", "tools/call", {
        name: "get_setup_steps",
        arguments: {},
      })
    ).structuredContent.gettingStarted;
  }
  assert(document, `Hosted document ${expected.slug} is missing.`);
  assert(
    document.content_hash === expected.contentHash,
    `Hosted document ${expected.slug} does not match Git.`,
  );
}

const modelResult = await mcp("model-facing-results", "tools/call", {
  name: "list_examples",
  arguments: {},
});
assert(
  modelResult.content[0].text.includes("→ Next:"),
  "Hosted result text has no next step.",
);

const directory = await mcp("many-mcps/directory", "tools/list");
const invoices = await mcp("many-mcps/invoices", "tools/list");
assert(
  directory.tools[0]?.name === "list_businesses",
  "Directory MCP drifted.",
);
assert(invoices.tools[0]?.name === "list_invoices", "Invoices MCP drifted.");

console.log(
  JSON.stringify(
    {
      status: "ok",
      projectUrl,
      documents: 7,
      patterns: 3,
      endpoints: 4,
    },
    null,
    2,
  ),
);
