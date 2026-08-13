import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = await mkdtemp(join(tmpdir(), "create-supabase-mcp-smoke-"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: fixture,
    encoding: "utf8",
    env: process.env,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`,
    );
  }
}

try {
  await mkdir(join(fixture, "supabase"), { recursive: true });
  await writeFile(
    join(fixture, "supabase", "config.toml"),
    'project_id = "generated-smoke"\n',
  );
  run("node", [
    join(repository, "dist", "cli.js"),
    "init",
    "--yes",
    "--function",
    "mcp",
    "--server-name",
    "Generated smoke",
    "--consent",
    "minimal",
  ]);
  run("node", [
    join(repository, "dist", "cli.js"),
    "doctor",
    "--function",
    "mcp",
  ]);

  const functionDirectory = join(fixture, "supabase", "functions", "mcp");
  const denoPath = join(functionDirectory, "deno.json");
  const runtimeWrapper = join(fixture, "local-runtime.ts");
  const entryTypes = await readFile(
    join(repository, "dist", "index.d.ts"),
    "utf8",
  );
  const runtimeChunk = /from "\.\/(runtime-[^"]+)\.js"/.exec(entryTypes)?.[1];
  if (!runtimeChunk)
    throw new Error("Could not resolve runtime declaration chunk");
  const localTypes = join(fixture, "local-runtime.d.ts");
  await writeFile(
    localTypes,
    entryTypes.replace(
      `from "./${runtimeChunk}.js"`,
      `from "${pathToFileURL(join(repository, "dist", `${runtimeChunk}.d.ts`)).href}"`,
    ),
  );
  await writeFile(
    runtimeWrapper,
    `// @deno-types="${pathToFileURL(localTypes).href}"\nexport * from "${pathToFileURL(join(repository, "dist", "index.js")).href}";\n`,
  );
  const denoConfig = JSON.parse(await readFile(denoPath, "utf8"));
  denoConfig.imports["create-supabase-mcp"] =
    pathToFileURL(runtimeWrapper).href;
  await writeFile(denoPath, `${JSON.stringify(denoConfig, null, 2)}\n`);

  run("deno", ["task", "check"], { cwd: functionDirectory });
  run("deno", ["task", "test"], { cwd: functionDirectory });
  run("deno", [
    "check",
    join(fixture, "supabase", "functions", "mcp-consent", "index.ts"),
  ]);
  console.log("Generated project type-check, test, and doctor passed.");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
