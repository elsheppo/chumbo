import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = await mkdtemp(join(tmpdir(), "supa-mcp-smoke-"));

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
  return result;
}

try {
  await mkdir(join(fixture, "supabase"), { recursive: true });
  await writeFile(
    join(fixture, "supabase", "config.toml"),
    'project_id = "generated-smoke"\n',
  );
  const setup = run("node", [
    join(repository, "dist", "cli.js"),
    "setup",
    "--yes",
    "--json",
    "--skip-checks",
    "--function",
    "mcp",
    "--server-name",
    "Generated smoke",
    "--project-ref",
    "generated-project",
    "--public-url",
    "https://directory.example/mcp/",
  ]);
  const setupReport = JSON.parse(setup.stdout);
  if (setupReport.schemaVersion !== 1 || setupReport.command !== "setup") {
    throw new Error(`Unexpected setup report: ${setup.stdout}`);
  }
  if (setupReport.status !== "needs_user_action") {
    throw new Error(
      `OAuth setup should name its dashboard action: ${setup.stdout}`,
    );
  }
  if (setupReport.endpoint !== "https://directory.example/mcp") {
    throw new Error(
      `Setup did not preserve the clean public URL: ${setup.stdout}`,
    );
  }
  if (
    setupReport.upstreamEndpoint !==
    "https://generated-project.supabase.co/functions/v1/mcp"
  ) {
    throw new Error(
      `Setup did not report its Supabase upstream: ${setup.stdout}`,
    );
  }
  const capabilityPath = join(
    fixture,
    "supabase",
    "functions",
    "mcp",
    "capabilities.ts",
  );
  const customizedCapabilities = `// builder-owned\n${await readFile(capabilityPath, "utf8")}`;
  await writeFile(capabilityPath, customizedCapabilities);
  const resumed = run("node", [
    join(repository, "dist", "cli.js"),
    "setup",
    "--resume",
    "--consent",
    "minimal",
    "--yes",
    "--json",
    "--skip-checks",
  ]);
  if (JSON.parse(resumed.stdout).status !== "needs_user_action") {
    throw new Error(
      `Resumed OAuth setup lost its dashboard action: ${resumed.stdout}`,
    );
  }
  if ((await readFile(capabilityPath, "utf8")) !== customizedCapabilities) {
    throw new Error("setup --resume overwrote builder-owned capabilities");
  }
  run("node", [
    join(repository, "dist", "cli.js"),
    "init",
    "--yes",
    "--function",
    "public-mcp",
    "--server-name",
    "Generated public smoke",
    "--auth",
    "public",
  ]);
  const doctor = run("node", [
    join(repository, "dist", "cli.js"),
    "doctor",
    "--json",
    "--function",
    "mcp",
  ]);
  if (JSON.parse(doctor.stdout).status !== "complete") {
    throw new Error(`Doctor JSON did not report completion: ${doctor.stdout}`);
  }
  const status = run("node", [
    join(repository, "dist", "cli.js"),
    "status",
    "--json",
    "--function",
    "mcp",
  ]);
  const statusReport = JSON.parse(status.stdout);
  if (!Array.isArray(statusReport.nextActions)) {
    throw new Error(`Status JSON is missing next actions: ${status.stdout}`);
  }

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
  for (const functionName of ["mcp", "public-mcp"]) {
    const functionDirectory = join(
      fixture,
      "supabase",
      "functions",
      functionName,
    );
    const denoPath = join(functionDirectory, "deno.json");
    const denoConfig = JSON.parse(await readFile(denoPath, "utf8"));
    denoConfig.imports["supa-mcp"] = pathToFileURL(runtimeWrapper).href;
    await writeFile(denoPath, `${JSON.stringify(denoConfig, null, 2)}\n`);
    run("deno", ["task", "check"], { cwd: functionDirectory });
    run("deno", ["task", "test"], { cwd: functionDirectory });
  }
  run("deno", [
    "check",
    join(fixture, "supabase", "functions", "mcp-consent", "index.ts"),
  ]);
  console.log("Generated project type-check, test, and doctor passed.");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
