import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRef = "dxrpeagddrpbezbkgvdv";
const projectUrl = `https://${projectRef}.supabase.co`;
const publicUrl = "https://elsheppo.github.io/supa-mcp/oauth/consent.html";
const wrapper = path.join(root, "scripts", "supabase-reference");

const keys = JSON.parse(
  execFileSync(
    wrapper,
    ["projects", "api-keys", "--project-ref", projectRef, "--output", "json"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  ),
);
const publishableKey = keys.find((key) => key.type === "publishable")?.api_key;
if (!publishableKey) {
  throw new Error("The reference project has no publishable API key");
}

const template = await readFile(
  path.join(
    root,
    "supabase",
    "reference-site",
    "oauth",
    "consent.template.html",
  ),
  "utf8",
);
const rendered = template
  .replaceAll("__SUPABASE_PROJECT_URL__", projectUrl)
  .replaceAll("__SUPABASE_PUBLISHABLE_KEY__", publishableKey);
if (rendered.includes("__SUPABASE_")) {
  throw new Error("The consent page still contains an unresolved placeholder");
}

const outputDirectory = path.join(root, "docs", "oauth");
const renderedFile = path.join(outputDirectory, "consent.html");
await mkdir(outputDirectory, { recursive: true });
await writeFile(renderedFile, rendered);

console.log(JSON.stringify({ status: "built", publicUrl }, null, 2));
