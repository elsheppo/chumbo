// Shared helpers for the starter checks. Starters are always exercised the way
// a builder receives them: created by the packed CLI, then wired to the packed
// runtime so unpublished changes are what get tested.
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repository = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repository,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    stdio: options.stdio ?? "pipe",
  });
}

/** Packs the current checkout and returns the extracted package root. */
export async function packChumbo(fixture) {
  run("pnpm", ["run", "build"]);
  const packed = JSON.parse(
    run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", fixture],
      { env: { npm_config_dry_run: "false" } },
    ),
  )[0];
  const starterFiles = packed.files
    .map(({ path }) => path)
    .filter((path) => path.startsWith("starters/"));
  if (!starterFiles.some((path) => path.endsWith("starter.json"))) {
    throw new Error("The packed package does not contain any starters");
  }
  const leaked = starterFiles.filter((path) =>
    /(^|\/)(node_modules|dist|\.temp|\.branches)\/|(^|\/)\.env(?!\.example$)/.test(
      path,
    ),
  );
  if (leaked.length > 0) {
    throw new Error(
      `Local starter state would be published: ${leaked.join(", ")}`,
    );
  }
  run("tar", ["-xzf", join(fixture, packed.filename), "-C", fixture]);
  return join(fixture, "package");
}

/** Runs the packed CLI's `create`, exactly as `npx chumbo create` would. */
export function createFromPackage(packageRoot, starter, directory) {
  const receipt = JSON.parse(
    run(process.execPath, [
      join(packageRoot, "dist", "cli.js"),
      "create",
      starter,
      directory,
      "--json",
    ]),
  );
  if (receipt.status !== "created") {
    throw new Error(`create returned ${JSON.stringify(receipt)}`);
  }
  return receipt;
}

/**
 * Points the created app's Deno config at the packed runtime instead of the
 * published npm version, so checks exercise this checkout.
 */
export async function useLocalRuntime(app, packageRoot, functionName) {
  const nodeModules = join(app, "node_modules");
  await mkdir(nodeModules, { recursive: true });
  await cp(packageRoot, join(nodeModules, "chumbo"), { recursive: true });
  for (const dependency of [
    "@modelcontextprotocol/server",
    "@supabase/server",
    "@supabase/supabase-js",
    "zod",
  ]) {
    const destination = join(nodeModules, dependency);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(
      join(repository, "node_modules", dependency),
      destination,
      "dir",
    );
  }
  const denoPath = join(
    app,
    "supabase",
    "functions",
    functionName,
    "deno.json",
  );
  const config = JSON.parse(await readFile(denoPath, "utf8"));
  delete config.imports.chumbo;
  config.nodeModulesDir = "manual";
  await writeFile(denoPath, `${JSON.stringify(config, null, 2)}\n`);
}
