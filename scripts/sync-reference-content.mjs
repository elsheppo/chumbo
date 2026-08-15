import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);

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

function localSupabase() {
  try {
    const output = execFileSync("supabase", ["status", "--output", "json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(output);
  } catch {
    return {};
  }
}

const local = localSupabase();
const projectUrl =
  process.env.SUPA_MCP_REFERENCE_URL ??
  process.env.SUPABASE_URL ??
  local.API_URL;
const serviceRoleKey =
  process.env.SUPA_MCP_REFERENCE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  local.SERVICE_ROLE_KEY;

if (!projectUrl || !serviceRoleKey) {
  throw new Error(
    "No reference Supabase is available. Run `supabase start` or set SUPA_MCP_REFERENCE_URL and SUPA_MCP_REFERENCE_SERVICE_ROLE_KEY.",
  );
}

const metadataFiles = [
  ...(await walk(path.join(root, "docs"))),
  ...(await walk(path.join(root, "examples"))),
].filter((file) => /\/(document|pattern|example)\.json$/.test(file));

const documents = [];
for (const metadataFile of metadataFiles) {
  const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
  const bodyFile = path.join(path.dirname(metadataFile), "README.md");
  const bodyMarkdown = await readFile(bodyFile, "utf8");
  const sourcePath = path.relative(root, bodyFile).split(path.sep).join("/");
  const contentHash = createHash("sha256")
    .update(JSON.stringify(metadata))
    .update("\n")
    .update(bodyMarkdown)
    .digest("hex");
  documents.push({
    slug: metadata.slug,
    kind: metadata.kind,
    title: metadata.title,
    summary: metadata.summary,
    body_markdown: bodyMarkdown,
    source_path: sourcePath,
    source_url: `https://github.com/elsheppo/supa-mcp/blob/main/${sourcePath}`,
    package_version: manifest.version,
    metadata,
    content_hash: contentHash,
    updated_at: new Date().toISOString(),
  });
}

const headers = {
  apikey: serviceRoleKey,
  authorization: `Bearer ${serviceRoleKey}`,
  "content-type": "application/json",
};
const endpoint = `${projectUrl.replace(/\/$/, "")}/rest/v1/reference_documents`;

const upsert = await fetch(`${endpoint}?on_conflict=slug`, {
  method: "POST",
  headers: { ...headers, prefer: "resolution=merge-duplicates,return=minimal" },
  body: JSON.stringify(documents),
});
if (!upsert.ok) {
  throw new Error(
    `Content upsert failed (${upsert.status}): ${await upsert.text()}`,
  );
}

const currentResponse = await fetch(`${endpoint}?select=slug`, { headers });
if (!currentResponse.ok) {
  throw new Error(
    `Could not inspect synced content (${currentResponse.status}): ${await currentResponse.text()}`,
  );
}
const wanted = new Set(documents.map((document) => document.slug));
const stale = (await currentResponse.json()).filter(
  (row) => !wanted.has(row.slug),
);
for (const row of stale) {
  const response = await fetch(
    `${endpoint}?slug=eq.${encodeURIComponent(row.slug)}`,
    {
      method: "DELETE",
      headers,
    },
  );
  if (!response.ok) {
    throw new Error(
      `Could not remove stale document ${row.slug}: ${await response.text()}`,
    );
  }
}

console.log(
  JSON.stringify(
    {
      synced: documents.length,
      removed: stale.length,
      packageVersion: manifest.version,
      source: "Git",
    },
    null,
    2,
  ),
);
