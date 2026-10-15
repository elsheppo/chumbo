// Static verification for every starter (starters/SPEC.md §6, steps 1–4):
// packed catalog and create, generated-file drift, Deno check and contract
// test against the packed runtime, and the web app's typecheck and build.
// Needs Node, pnpm, Deno, and npm registry access; no Supabase stack.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFromPackage,
  packChumbo,
  repository,
  run,
  useLocalRuntime,
} from "./starter-lib.mjs";

const GENERATED = ["index.ts", "deno.json", "index_test.ts"];
const fixture = await mkdtemp(join(tmpdir(), "chumbo-starters-"));

try {
  const packageRoot = await packChumbo(fixture);
  const catalog = JSON.parse(
    run(process.execPath, [
      join(packageRoot, "dist", "cli.js"),
      "create",
      "--list",
      "--json",
    ]),
  );

  for (const starter of catalog.starters) {
    const label = `[${starter.id}]`;
    const source = join(repository, "starters", starter.id);
    const functionDir = (root) =>
      join(root, "supabase", "functions", starter.function);

    const { version } = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8"),
    );
    const starterPackage = JSON.parse(
      await readFile(join(source, "package.json"), "utf8"),
    );
    if (starterPackage.devDependencies?.chumbo !== version) {
      throw new Error(
        `${label} package.json must pin chumbo ${version}, found ${starterPackage.devDependencies?.chumbo}`,
      );
    }

    // Drift: the committed MCP wiring must be what `chumbo init` generates.
    const regenerated = join(fixture, `${starter.id}-regenerated`);
    await mkdir(join(regenerated, "supabase"), { recursive: true });
    const sourceConfig = await readFile(
      join(source, "supabase", "config.toml"),
      "utf8",
    );
    await writeFile(join(regenerated, "supabase", "config.toml"), sourceConfig);
    run(
      process.execPath,
      [
        join(packageRoot, "dist", "cli.js"),
        "init",
        "--yes",
        "--skip-checks",
        "--function",
        starter.function,
        "--server-name",
        starter.serverName,
        "--auth",
        starter.auth,
      ],
      { cwd: regenerated },
    );
    const drifted = [];
    for (const file of GENERATED) {
      const [expected, actual] = await Promise.all([
        readFile(join(functionDir(regenerated), file), "utf8"),
        readFile(join(functionDir(source), file), "utf8"),
      ]);
      if (expected !== actual) drifted.push(file);
    }
    if (
      (await readFile(join(regenerated, "supabase", "config.toml"), "utf8")) !==
      sourceConfig
    ) {
      drifted.push("supabase/config.toml");
    }
    if (drifted.length > 0) {
      throw new Error(
        `${label} generated files drifted from \`chumbo init\`: ${drifted.join(", ")}. Regenerate them (see starters/README.md).`,
      );
    }
    console.log(`${label} generated MCP wiring matches chumbo init`);

    // Create through the packed CLI, then check against the packed runtime.
    const app = join(fixture, starter.id);
    const receipt = createFromPackage(packageRoot, starter.id, app);
    if (
      receipt.files.includes("_gitignore") ||
      !receipt.files.includes(".gitignore")
    ) {
      throw new Error(`${label} create did not restore .gitignore`);
    }
    await useLocalRuntime(app, packageRoot, starter.function);
    run("deno", ["task", "check"], { cwd: functionDir(app), stdio: "inherit" });
    run("deno", ["task", "test"], { cwd: functionDir(app), stdio: "inherit" });
    run(
      "deno",
      [
        "check",
        "--config",
        join("supabase", "functions", starter.function, "deno.json"),
        join("supabase", "tests"),
      ],
      { cwd: app, stdio: "inherit" },
    );
    console.log(
      `${label} MCP function type-checks and passes its contract test`,
    );

    const web = join(app, "web");
    run("npm", ["install", "--no-audit", "--no-fund"], { cwd: web });
    run("npm", ["run", "build"], { cwd: web, stdio: "inherit" });
    console.log(`${label} web app type-checks and builds`);
  }
  console.log(`Verified ${catalog.starters.length} starter(s).`);
} finally {
  await rm(fixture, { recursive: true, force: true });
}
