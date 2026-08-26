import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const expected = manifest.version;
const failures = [];

function fail(surface, actual) {
  failures.push(
    `${surface}: expected ${expected}, found ${actual ?? "missing"}`,
  );
}

const sourceVersion = await readFile(
  path.join(root, "src", "version.ts"),
  "utf8",
);
if (!sourceVersion.includes(`PACKAGE_VERSION = "${expected}"`)) {
  fail("src/version.ts", "a different PACKAGE_VERSION");
}

const spec = await readFile(path.join(root, "SPEC.md"), "utf8");
if (!spec.includes(`Current package version: \`${expected}\``)) {
  fail("SPEC.md", "a different current package version");
}

const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
if (!changelog.includes(`## ${expected} —`)) {
  fail("CHANGELOG.md", "no matching release heading");
}

const importMaps = [path.join(root, "supabase", "deno.json")];
const functionsRoot = path.join(root, "supabase", "functions");
for (const entry of await readdir(functionsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const importMap = path.join(functionsRoot, entry.name, "deno.json");
  try {
    await readFile(importMap, "utf8");
    importMaps.push(importMap);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

for (const importMap of importMaps) {
  const deno = JSON.parse(await readFile(importMap, "utf8"));
  const actual = deno.imports?.["supa-mcp"];
  if (actual !== `npm:supa-mcp@${expected}`) {
    fail(path.relative(root, importMap), actual);
  }
  const lockFile = path.join(path.dirname(importMap), "deno.lock");
  const lock = await readFile(lockFile, "utf8");
  const lockedVersions = [
    ...lock.matchAll(/npm:supa-mcp@(\d+\.\d+\.\d+)/g),
  ].map((match) => match[1]);
  if (
    lockedVersions.length === 0 ||
    lockedVersions.some((version) => version !== expected)
  ) {
    fail(
      path.relative(root, lockFile),
      [...new Set(lockedVersions)].join(", "),
    );
  }
}

const deployment = JSON.parse(
  await readFile(
    path.join(root, "docs", "deployment", "hosted-reference.json"),
    "utf8",
  ),
);
if (
  typeof deployment.packageVersion !== "string" ||
  !/^\d+\.\d+\.\d+$/.test(deployment.packageVersion)
) {
  fail(
    "docs/deployment/hosted-reference.json",
    deployment.packageVersion ?? "an invalid deployed package version",
  );
}

if (failures.length) {
  console.error(
    ["Release alignment failed:", ...failures.map((item) => `- ${item}`)].join(
      "\n",
    ),
  );
  process.exit(1);
}

console.log(
  `Release-candidate surfaces align with supa-mcp ${expected}; hosted reference truth remains ${deployment.packageVersion}.`,
);
