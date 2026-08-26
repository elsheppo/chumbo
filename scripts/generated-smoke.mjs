import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = await mkdtemp(join(tmpdir(), "supa-mcp-smoke-"));
const packageVersion = JSON.parse(
  await readFile(join(repository, "package.json"), "utf8"),
).version;

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
  const existingAgents = "# Existing project guidance\n\nKeep this content.\n";
  await writeFile(join(fixture, "AGENTS.md"), existingAgents);

  const skillPlan = run("node", [
    join(repository, "dist", "cli.js"),
    "skill",
    "install",
    "--plan",
    "--json",
  ]);
  const skillPlanReport = JSON.parse(skillPlan.stdout);
  if (
    skillPlanReport.command !== "skill" ||
    skillPlanReport.action !== "install" ||
    skillPlanReport.status !== "planned"
  ) {
    throw new Error(`Unexpected skill plan: ${skillPlan.stdout}`);
  }
  await readFile(join(fixture, "skills", "supa-mcp", "SKILL.md")).then(
    () => {
      throw new Error("skill install --plan wrote files");
    },
    () => undefined,
  );

  const skillConfirmation = run("node", [
    join(repository, "dist", "cli.js"),
    "skill",
    "install",
    "--json",
  ]);
  if (JSON.parse(skillConfirmation.stdout).status !== "needs_confirmation") {
    throw new Error(
      `Skill JSON did not request confirmation: ${skillConfirmation.stdout}`,
    );
  }
  const skillInstall = run("node", [
    join(repository, "dist", "cli.js"),
    "skill",
    "install",
    "--yes",
    "--json",
  ]);
  if (JSON.parse(skillInstall.stdout).status !== "complete") {
    throw new Error(`Skill install did not complete: ${skillInstall.stdout}`);
  }
  const installedAgents = await readFile(join(fixture, "AGENTS.md"), "utf8");
  if (
    !installedAgents.startsWith(existingAgents) ||
    !installedAgents.includes("skills/supa-mcp/SKILL.md")
  ) {
    throw new Error("Skill install did not preserve AGENTS.md content");
  }
  const repeatedSkillInstall = run("node", [
    join(repository, "dist", "cli.js"),
    "skill",
    "install",
    "--yes",
    "--json",
  ]);
  if (JSON.parse(repeatedSkillInstall.stdout).status !== "current") {
    throw new Error(
      `Repeated skill install was not idempotent: ${repeatedSkillInstall.stdout}`,
    );
  }
  const skillStatus = run("node", [
    join(repository, "dist", "cli.js"),
    "skill",
    "status",
    "--json",
  ]);
  if (JSON.parse(skillStatus.stdout).status !== "current") {
    throw new Error(`Skill status was not current: ${skillStatus.stdout}`);
  }

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
  if (
    setupReport.agentHandoff?.skillInstallCommand !==
    "npx supa-mcp skill install --yes --json"
  ) {
    throw new Error(`Setup omitted the optional agent skill: ${setup.stdout}`);
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
  run("node", [
    join(repository, "dist", "cli.js"),
    "init",
    "--yes",
    "--function",
    "api-key-mcp",
    "--server-name",
    "Generated API key smoke",
    "--auth",
    "api-key",
  ]);
  run("node", [
    join(repository, "dist", "cli.js"),
    "init",
    "--yes",
    "--function",
    "state-mcp",
    "--server-name",
    "Generated state smoke",
    "--auth",
    "api-key",
    "--state-namespace",
    "observations",
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

  const localPackage = join(fixture, "node_modules", "supa-mcp");
  await mkdir(localPackage, { recursive: true });
  await cp(join(repository, "dist"), join(localPackage, "dist"), {
    recursive: true,
  });
  await cp(
    join(repository, "package.json"),
    join(localPackage, "package.json"),
  );
  for (const dependency of [
    "@modelcontextprotocol/server",
    "@supabase/server",
    "@supabase/supabase-js",
    "zod",
  ]) {
    const destination = join(fixture, "node_modules", dependency);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(
      join(repository, "node_modules", dependency),
      destination,
      "dir",
    );
  }
  await writeFile(
    join(fixture, "package.json"),
    `${JSON.stringify(
      { type: "module", dependencies: { "supa-mcp": packageVersion } },
      null,
      2,
    )}\n`,
  );
  for (const functionName of [
    "mcp",
    "public-mcp",
    "api-key-mcp",
    "state-mcp",
  ]) {
    const functionDirectory = join(
      fixture,
      "supabase",
      "functions",
      functionName,
    );
    const denoPath = join(functionDirectory, "deno.json");
    const denoConfig = JSON.parse(await readFile(denoPath, "utf8"));
    delete denoConfig.imports["supa-mcp"];
    denoConfig.nodeModulesDir = "manual";
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
