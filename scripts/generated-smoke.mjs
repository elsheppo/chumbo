import {
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = await mkdtemp(join(tmpdir(), "chumbo-smoke-"));
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
    'project_id = "generated-smoke"\n\n[api]\nport = 57321\n',
  );
  const help = run("node", [join(repository, "dist", "cli.js"), "--help"]);
  for (const option of ["--call-tool", "--call-args", "--env-file"]) {
    if (!help.stdout.includes(option)) {
      throw new Error(`CLI help is missing ${option}: ${help.stdout}`);
    }
  }
  const privateArgument = "generated-smoke-private-argument";
  const rejectedCallArgs = spawnSync(
    "node",
    [
      join(repository, "dist", "cli.js"),
      "doctor",
      "--json",
      "--call-args",
      JSON.stringify({ privateArgument }),
    ],
    { cwd: fixture, encoding: "utf8", env: process.env },
  );
  if (
    rejectedCallArgs.status === 0 ||
    !rejectedCallArgs.stdout.includes("--call-args requires --call-tool") ||
    rejectedCallArgs.stdout.includes(privateArgument)
  ) {
    throw new Error(
      `Doctor did not safely reject unscoped call arguments: ${rejectedCallArgs.stdout}`,
    );
  }
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
  await readFile(join(fixture, "skills", "chumbo", "SKILL.md")).then(
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
    !installedAgents.includes("skills/chumbo/SKILL.md")
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
    "npx chumbo skill install --yes --json"
  ) {
    throw new Error(
      `Setup omitted the recommended agent skill: ${setup.stdout}`,
    );
  }
  const capabilityPath = join(
    fixture,
    "supabase",
    "functions",
    "mcp",
    "capabilities.ts",
  );
  const generatedCapabilities = await readFile(capabilityPath, "utf8");
  if (
    (generatedCapabilities.match(/server\.registerTool\(/g) ?? []).length !==
      1 ||
    !generatedCapabilities.includes('"whoami"') ||
    !generatedCapabilities.includes("ctx.supabase") ||
    generatedCapabilities.includes("registerResource") ||
    generatedCapabilities.includes("registerPrompt")
  ) {
    throw new Error("Generated capabilities did not keep one compact starter");
  }
  const generatedReadme = await readFile(
    join(fixture, "supabase", "functions", "mcp", "README.md"),
    "utf8",
  );
  if (
    !generatedReadme.includes("generated `whoami` tool") ||
    !generatedReadme.includes("executable capability showcase") ||
    !generatedReadme.includes("carries that user's Supabase access token") ||
    !generatedReadme.includes(
      "`ctx.supabase` is request-scoped. Its database authority follows",
    ) ||
    !generatedReadme.includes("npx chumbo skill install") ||
    generatedReadme.includes("authenticated MCP boundary")
  ) {
    throw new Error("Generated README omitted the starter or advanced path");
  }
  const fakeBin = join(fixture, "fake-bin");
  const fakeSupabase = join(fakeBin, "supabase");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(
    fakeSupabase,
    '#!/usr/bin/env node\nconsole.log(`fake supabase ${process.argv.slice(2).join(" ")}`);\n',
  );
  await chmod(fakeSupabase, 0o755);
  const dev = run(
    "node",
    [join(repository, "dist", "cli.js"), "dev", "--function", "mcp"],
    {
      env: {
        ...process.env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
      },
    },
  );
  if (
    !dev.stdout.includes(
      "Local MCP URL: http://127.0.0.1:57321/functions/v1/mcp",
    ) ||
    !dev.stdout.includes("--url http://127.0.0.1:57321/functions/v1/mcp") ||
    !dev.stdout.includes("fake supabase functions serve mcp")
  ) {
    throw new Error(`Dev ignored the configured local API port: ${dev.stdout}`);
  }
  const customizedCapabilities = `// builder-owned\n${generatedCapabilities}`;
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
  if (
    statusReport.localEndpoint !== "http://127.0.0.1:57321/functions/v1/mcp"
  ) {
    throw new Error(
      `Status JSON ignored the configured local API port: ${status.stdout}`,
    );
  }
  if (!Array.isArray(statusReport.nextActions)) {
    throw new Error(`Status JSON is missing next actions: ${status.stdout}`);
  }

  const localPackage = join(fixture, "node_modules", "chumbo");
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
      { type: "module", dependencies: { chumbo: packageVersion } },
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
    delete denoConfig.imports["chumbo"];
    denoConfig.nodeModulesDir = "manual";
    await writeFile(denoPath, `${JSON.stringify(denoConfig, null, 2)}\n`);
    run("deno", ["task", "check"], { cwd: functionDirectory });
    run("deno", ["task", "test"], { cwd: functionDirectory });
  }
  run("deno", [
    "check",
    join(fixture, "supabase", "functions", "mcp-consent", "index.ts"),
  ]);

  await smokeHostTargets();
  console.log("Generated project type-check, test, and doctor passed.");
} finally {
  await rm(fixture, { recursive: true, force: true });
}

async function linkRuntimeModules(root) {
  await mkdir(join(root, "node_modules"), { recursive: true });
  const localPackage = join(root, "node_modules", "chumbo");
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
    "@types/node",
  ]) {
    const destination = join(root, "node_modules", dependency);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(
      join(repository, "node_modules", dependency),
      destination,
      "dir",
    );
  }
}

function typecheckFixture(root) {
  run(
    "node",
    [
      join(repository, "node_modules", "typescript", "bin", "tsc"),
      "--noEmit",
      "-p",
      ".",
    ],
    { cwd: root },
  );
}

async function smokeNextTarget() {
  const root = await mkdtemp(join(tmpdir(), "chumbo-smoke-next-"));
  try {
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify(
        {
          name: "next-smoke",
          type: "module",
          dependencies: { next: "15.5.0", chumbo: packageVersion },
        },
        null,
        2,
      )}\n`,
    );
    await mkdir(join(root, "src", "app"), { recursive: true });

    const hinted = spawnSync(
      "node",
      [join(repository, "dist", "cli.js"), "setup", "--yes", "--json"],
      { cwd: root, encoding: "utf8", env: process.env },
    );
    if (hinted.status === 0 || !hinted.stdout.includes("--target next")) {
      throw new Error(
        `Setup without a Supabase directory did not hint the next target: ${hinted.stdout}${hinted.stderr}`,
      );
    }

    const setupNext = run(
      "node",
      [
        join(repository, "dist", "cli.js"),
        "setup",
        "--target",
        "next",
        "--auth",
        "bearer",
        "--yes",
        "--json",
      ],
      { cwd: root },
    );
    const report = JSON.parse(setupNext.stdout);
    if (
      report.target !== "next" ||
      report.status !== "needs_user_action" ||
      !report.steps.some((step) => step.id === "configure_env")
    ) {
      throw new Error(`Unexpected next-target report: ${setupNext.stdout}`);
    }
    const routePath = join(
      root,
      "src",
      "app",
      "mcp",
      "[[...path]]",
      "route.ts",
    );
    const route = await readFile(routePath, "utf8");
    if (!route.includes("export const dynamic") || route.includes("Deno.")) {
      throw new Error("Generated next route is not a portable route handler");
    }

    const capabilitiesPath = join(root, "src", "app", "mcp", "capabilities.ts");
    const customized = `// builder-owned\n${await readFile(capabilitiesPath, "utf8")}`;
    await writeFile(capabilitiesPath, customized);
    const resumed = run(
      "node",
      [
        join(repository, "dist", "cli.js"),
        "setup",
        "--resume",
        "--target",
        "next",
        "--yes",
        "--json",
      ],
      { cwd: root },
    );
    if (JSON.parse(resumed.stdout).status !== "needs_user_action") {
      throw new Error(`Resumed next setup lost its actions: ${resumed.stdout}`);
    }
    if ((await readFile(capabilitiesPath, "utf8")) !== customized) {
      throw new Error(
        "next-target resume overwrote builder-owned capabilities",
      );
    }

    await linkRuntimeModules(root);
    await writeFile(
      join(root, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            module: "esnext",
            moduleResolution: "bundler",
            target: "es2022",
            lib: ["es2023", "dom"],
            types: ["node"],
          },
          include: ["src/app/mcp/**/*.ts"],
        },
        null,
        2,
      )}\n`,
    );
    typecheckFixture(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function smokeNodeTarget() {
  const root = await mkdtemp(join(tmpdir(), "chumbo-smoke-node-"));
  let server;
  try {
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify(
        {
          name: "node-smoke",
          type: "module",
          dependencies: { chumbo: packageVersion },
        },
        null,
        2,
      )}\n`,
    );
    run(
      "node",
      [
        join(repository, "dist", "cli.js"),
        "setup",
        "--target",
        "node",
        "--auth",
        "api-key",
        "--yes",
        "--json",
      ],
      { cwd: root },
    );

    await linkRuntimeModules(root);
    await writeFile(
      join(root, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            module: "esnext",
            moduleResolution: "bundler",
            allowImportingTsExtensions: true,
            target: "es2022",
            lib: ["es2023", "dom"],
            types: ["node"],
          },
          include: ["mcp/**/*.ts"],
        },
        null,
        2,
      )}\n`,
    );
    typecheckFixture(root);

    const port = 8321;
    server = spawn(
      "node",
      ["--experimental-strip-types", join("mcp", "index.ts")],
      {
        cwd: root,
        env: {
          ...process.env,
          SUPABASE_URL: "https://smoke.supabase.co",
          SUPABASE_PUBLISHABLE_KEY: "smoke-publishable-key",
          MCP_API_KEY: "smoke-api-key",
          PORT: String(port),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let serverOutput = "";
    server.stdout.on("data", (chunk) => (serverOutput += String(chunk)));
    server.stderr.on("data", (chunk) => (serverOutput += String(chunk)));

    const endpoint = `http://127.0.0.1:${port}/mcp`;
    let reachable = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await fetch(endpoint, { method: "POST" });
        reachable = true;
        break;
      } catch {
        await delay(100);
      }
    }
    if (!reachable) {
      throw new Error(`Generated node server did not start:\n${serverOutput}`);
    }

    const doctor = run(
      "node",
      [
        join(repository, "dist", "cli.js"),
        "doctor",
        "--json",
        "--url",
        endpoint,
        "--token",
        "smoke-api-key",
        "--call-tool",
        "whoami",
      ],
      { cwd: root },
    );
    const doctorReport = JSON.parse(doctor.stdout);
    const called = doctorReport.checks?.some(
      (check) => check.name === "tool-call" && check.ok,
    );
    if (doctorReport.status !== "complete" || !called) {
      throw new Error(
        `Node-target doctor did not prove the MCP round trip: ${doctor.stdout}`,
      );
    }
  } finally {
    server?.kill();
    await rm(root, { recursive: true, force: true });
  }
}

async function smokeHostTargets() {
  await smokeNextTarget();
  await smokeNodeTarget();
  console.log("Host-target scaffolds type-checked and served a live MCP.");
}
