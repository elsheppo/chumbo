import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderBrandedCliPackage } from "../dist/cli-package.js";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await mkdtemp(join(tmpdir(), "chumbo-branded-cli-"));
const version = JSON.parse(
  await readFile(join(repository, "package.json"), "utf8"),
).version;

try {
  const files = renderBrandedCliPackage(
    {
      packageName: "@acme/ops-cli",
      binaryName: "acme",
      displayName: "Acme Ops",
      version: "1.0.0",
      endpoint: "https://api.acme.example/mcp",
      supportUrl: "https://acme.example/support",
      poweredBy: "Chumbo Cloud",
    },
    { chumboVersion: version },
  );
  for (const [path, source] of Object.entries(files)) {
    const target = join(fixture, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  await chmod(join(fixture, "bin", "cli.js"), 0o755);
  await mkdir(join(fixture, "node_modules"));
  await symlink(repository, join(fixture, "node_modules", "chumbo"), "dir");

  const help = execFileSync(
    process.execPath,
    [join(fixture, "bin", "cli.js"), "--help"],
    { cwd: fixture, encoding: "utf8" },
  );
  if (
    !help.includes("Acme Ops CLI") ||
    !help.includes("acme login") ||
    !help.includes("Support: https://acme.example/support")
  ) {
    throw new Error(`Generated CLI did not retain project identity:\n${help}`);
  }

  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", fixture],
      { cwd: fixture, encoding: "utf8" },
    ),
  )[0];
  if (packed.name !== "@acme/ops-cli") {
    throw new Error(`Generated package identity drifted: ${packed.name}`);
  }
  const names = new Set(packed.files.map((file) => file.path));
  for (const required of ["bin/cli.js", "README.md", "package.json"]) {
    if (!names.has(required))
      throw new Error(`Generated package omitted ${required}`);
  }
  console.log(
    "Project-branded CLI package renders, executes, and packs with project identity.",
  );
} finally {
  await rm(fixture, { recursive: true, force: true });
}
