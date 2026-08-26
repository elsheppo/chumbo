import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

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
    source_url: `https://github.com/elsheppo/chumbo/blob/main/${sourcePath}`,
    package_version: manifest.version,
    metadata,
    content_hash: contentHash,
    updated_at: new Date().toISOString(),
  });
}

const admin = createClient(projectUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

async function upsertDocument(document) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const { error } = await admin
      .from("reference_documents")
      .upsert(document, { onConflict: "slug" });
    if (!error) return;
    lastError = error;
    if (
      !error.message.includes("canceling statement due to statement timeout") ||
      attempt === 3
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 250));
  }
  throw new Error(`Could not sync ${document.slug}: ${lastError.message}`);
}

if (process.env.SUPA_MCP_REFERENCE_USE_LINKED_DB === "1") {
  const payload = JSON.stringify(documents).replaceAll("'", "''");
  const sql = `
    with incoming as (
      select *
      from jsonb_to_recordset('${payload}'::jsonb) as document(
        slug text,
        kind text,
        title text,
        summary text,
        body_markdown text,
        source_path text,
        source_url text,
        package_version text,
        metadata jsonb,
        content_hash text,
        updated_at timestamptz
      )
    ), upserted as (
      insert into public.reference_documents (
        slug, kind, title, summary, body_markdown, source_path, source_url,
        package_version, metadata, content_hash, updated_at
      )
      select
        slug, kind, title, summary, body_markdown, source_path, source_url,
        package_version, metadata, content_hash, updated_at
      from incoming
      on conflict (slug) do update set
        kind = excluded.kind,
        title = excluded.title,
        summary = excluded.summary,
        body_markdown = excluded.body_markdown,
        source_path = excluded.source_path,
        source_url = excluded.source_url,
        package_version = excluded.package_version,
        metadata = excluded.metadata,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at
      returning slug
    )
    delete from public.reference_documents
    where slug not in (select slug from incoming);
  `;
  execFileSync(
    path.join(root, "scripts", "supabase-reference"),
    ["db", "query", "--linked", sql],
    { cwd: root, stdio: "inherit" },
  );
  console.log(
    JSON.stringify(
      {
        synced: documents.length,
        removed: "reconciled",
        packageVersion: manifest.version,
        source: "Git",
        transport: "linked-database",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

for (const document of documents) {
  await upsertDocument(document);
}

const { data: current, error: currentError } = await admin
  .from("reference_documents")
  .select("slug");
if (currentError) {
  throw new Error(`Could not inspect synced content: ${currentError.message}`);
}
const wanted = new Set(documents.map((document) => document.slug));
const stale = (current ?? []).filter((row) => !wanted.has(row.slug));
for (const row of stale) {
  const { error } = await admin
    .from("reference_documents")
    .delete()
    .eq("slug", row.slug);
  if (error) throw new Error(`Could not remove ${row.slug}: ${error.message}`);
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
