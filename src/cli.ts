#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { runDoctor, type DoctorCheck } from "./doctor.js";
import {
  applyPlan,
  displayPlan,
  findSupabaseProject,
  planInit,
  type PlannedFile,
} from "./project.js";
import {
  buildSetupReport,
  detectGeneratedAuth,
  detectLinkedProjectRef,
  endpointFor,
  formatSetupReport,
  normalizePublicUrl,
  type SetupAuthMode,
  type SetupReport,
} from "./setup.js";

const HELP = `supa-mcp 0.2.0

Usage:
  supa-mcp setup [options]   Guided, resumable installation
  supa-mcp status [options]  Read-only setup status
  supa-mcp init [options]    Generate files only
  supa-mcp doctor [options]  Check local or deployed setup
  supa-mcp dev [options]     Serve the function locally

Setup options:
  --function <name>       Edge Function name (default: mcp)
  --server-name <name>    MCP display name (default: repository name)
  --auth <mode>           oauth, api-key, bearer, or public (guided interactively)
  --consent <mode>        none or minimal (default: none)
  --project-ref <ref>     Supabase project ref for deploy and endpoint discovery
  --public-url <url>      Clean URL clients will use, such as https://app.com/mcp
  --apply-migrations      Apply the generated public limiter migration
  --deploy                Deploy after generation and local checks
  --skip-checks           Do not run generated Deno checks
  --resume                Re-observe the current setup and continue safely
  --plan                  Print the complete setup plan without writing

Shared options:
  --url <url>             Deployed MCP URL for status or doctor
  --token <token>         User token or API key for doctor's tools/list probe
  --dry-run               Print init's file plan without writing
  --yes                   Never prompt; accept the selected/default choices
  --json                  Stable machine-readable output; never prompts
  --no-config             Do not patch supabase/config.toml
  --help                  Show this help

Agent quickstart:
  supa-mcp setup --auth oauth --yes --json
  supa-mcp status --json
`;

interface CommandResult {
  ok: boolean;
  detail: string;
}

function parse(commandArgs: string[]) {
  return parseArgs({
    args: commandArgs,
    allowPositionals: true,
    strict: true,
    options: {
      "apply-migrations": { type: "boolean" },
      auth: { type: "string" },
      consent: { type: "string" },
      deploy: { type: "boolean" },
      "dry-run": { type: "boolean" },
      function: { type: "string" },
      help: { type: "boolean" },
      json: { type: "boolean" },
      "no-config": { type: "boolean" },
      plan: { type: "boolean" },
      "project-ref": { type: "string" },
      "public-url": { type: "string" },
      resume: { type: "boolean" },
      "server-name": { type: "string" },
      "skip-checks": { type: "boolean" },
      token: { type: "string" },
      url: { type: "string" },
      yes: { type: "boolean", short: "y" },
    },
  });
}

function choice<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
  label: string,
): T {
  const selected = value ?? fallback;
  if (!allowed.includes(selected as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return selected as T;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const reader = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await reader.question(`${question} [y/N] `);
  reader.close();
  return /^y(?:es)?$/i.test(answer.trim());
}

async function guidedAuth(): Promise<SetupAuthMode> {
  const reader = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  console.log("\nWho should be able to connect?");
  console.log("  1. App users sign in with Supabase (recommended)");
  console.log("  2. Trusted clients use an application API key");
  console.log("  3. Clients bring an existing Supabase user token");
  console.log("  4. Anyone can call it (public, rate limited)");
  const answer = (await reader.question("Choose access [1]: ")).trim();
  reader.close();
  if (answer === "" || answer === "1") return "oauth";
  if (answer === "2") return "api-key";
  if (answer === "3") return "bearer";
  if (answer === "4") return "public";
  throw new Error("Choose 1, 2, 3, or 4 for MCP access.");
}

async function guidedConsent(): Promise<"none" | "minimal"> {
  const reader = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  console.log("\nWhere will users approve the connection?");
  console.log("  1. My app's existing signed-in UI (recommended)");
  console.log("  2. Generate a minimal fallback consent function");
  const answer = (await reader.question("Choose consent UI [1]: ")).trim();
  reader.close();
  if (answer === "" || answer === "1") return "none";
  if (answer === "2") return "minimal";
  throw new Error("Choose 1 or 2 for the OAuth consent UI.");
}

async function guidedPublicUrl(): Promise<string | undefined> {
  const reader = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  console.log("\nWhat URL should people connect to?");
  console.log("  1. The Supabase function URL (fastest; no extra setup)");
  console.log("  2. A clean URL on my app or domain");
  const answer = (await reader.question("Choose public URL [1]: ")).trim();
  if (answer === "" || answer === "1") {
    reader.close();
    return undefined;
  }
  if (answer !== "2") {
    reader.close();
    throw new Error("Choose 1 or 2 for the public MCP URL.");
  }
  const value = (await reader.question("Public MCP URL: ")).trim();
  reader.close();
  if (!value) throw new Error("Enter the complete public MCP URL.");
  return normalizePublicUrl(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function compactOutput(value: string): string {
  const lines = value.trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-3).join(" | ").slice(0, 500);
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  machine: boolean,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: machine ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", (error) => {
      resolve({ ok: false, detail: error.message });
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve({ ok: true, detail: "completed successfully" });
        return;
      }
      const output = compactOutput(stderr || stdout);
      resolve({
        ok: false,
        detail:
          output ||
          (signal ? `exited on ${signal}` : `exited with code ${code}`),
      });
    });
  });
}

async function commandAvailable(command: string): Promise<boolean> {
  const result = await runCommand(command, ["--version"], process.cwd(), true);
  return result.ok;
}

function fileSummary(files: readonly PlannedFile[], root: string) {
  return files.map((file) => ({
    path: relative(root, file.path),
    status: file.status,
  }));
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function init(args: string[]): Promise<void> {
  const parsed = parse(args);
  const machine = parsed.values.json ?? false;
  const root = await findSupabaseProject(process.cwd());
  const functionName = parsed.values.function ?? "mcp";
  const auth = choice(
    parsed.values.auth,
    ["oauth", "api-key", "bearer", "public"] as const,
    "oauth",
    "--auth",
  );
  if (auth === "public" && parsed.values.auth !== "public") {
    throw new Error(
      "Public mode must be selected explicitly with --auth public",
    );
  }
  const consent = choice(
    parsed.values.consent,
    ["none", "minimal"] as const,
    "none",
    "--consent",
  );
  const files = await planInit({
    cwd: root,
    functionName,
    serverName: parsed.values["server-name"] ?? basename(root),
    auth,
    consent,
    patchConfig: !parsed.values["no-config"],
  });
  const conflicts = files.filter((file) => file.status === "conflict");
  if (conflicts.length > 0) {
    throw new Error("Resolve the listed file conflicts, then run init again.");
  }
  const planOnly = Boolean(parsed.values["dry-run"]);
  const needsConfirmation = machine && !parsed.values.yes && !planOnly;
  if (machine && (planOnly || needsConfirmation)) {
    printJson({
      schemaVersion: 1,
      command: "init",
      status: needsConfirmation ? "needs_confirmation" : "planned",
      projectRoot: root,
      functionName,
      auth,
      files: fileSummary(files, root),
      nextCommand: needsConfirmation
        ? `npx supa-mcp init --function ${functionName} --auth ${auth} --yes --json`
        : undefined,
    });
    return;
  }
  if (!machine) console.log(`\nFile plan:\n${displayPlan(files, root)}\n`);
  if (planOnly) return;
  if (!parsed.values.yes && !(await confirm("Apply this plan?"))) {
    throw new Error(
      "No files changed. Re-run with --yes for non-interactive use.",
    );
  }
  await applyPlan(files);
  if (machine) {
    printJson({
      schemaVersion: 1,
      command: "init",
      status: "complete",
      projectRoot: root,
      functionName,
      auth,
      files: fileSummary(files, root),
      nextCommand: `npx supa-mcp setup --resume --function ${functionName} --auth ${auth} --yes --json`,
    });
    return;
  }
  console.log(`Created Supa MCP function '${functionName}'.`);
  console.log(
    `\nContinue with:\n  supa-mcp setup --resume --function ${functionName}`,
  );
}

function allChecksPass(checks: readonly DoctorCheck[]): boolean {
  return checks.length > 0 && checks.every((check) => check.ok);
}

async function setup(args: string[]): Promise<void> {
  const parsed = parse(args);
  const machine = parsed.values.json ?? false;
  const root = await findSupabaseProject(process.cwd());
  const functionName = parsed.values.function ?? "mcp";
  const existingAuth = await detectGeneratedAuth(root, functionName);
  if (
    existingAuth &&
    parsed.values.auth &&
    existingAuth !== parsed.values.auth
  ) {
    throw new Error(
      `The existing '${functionName}' scaffold uses ${existingAuth}, not ${parsed.values.auth}.`,
    );
  }
  const auth = existingAuth
    ? existingAuth
    : parsed.values.auth
      ? choice(
          parsed.values.auth,
          ["oauth", "api-key", "bearer", "public"] as const,
          "oauth",
          "--auth",
        )
      : process.stdin.isTTY && !machine && !parsed.values.yes
        ? await guidedAuth()
        : "oauth";
  const detectedConsent = await pathExists(
    join(root, "supabase", "functions", `${functionName}-consent`, "index.ts"),
  );
  const consent = parsed.values.consent
    ? choice(
        parsed.values.consent,
        ["none", "minimal"] as const,
        "none",
        "--consent",
      )
    : detectedConsent
      ? "minimal"
      : auth === "oauth" &&
          !existingAuth &&
          process.stdin.isTTY &&
          !machine &&
          !parsed.values.yes
        ? await guidedConsent()
        : "none";
  const projectRef =
    parsed.values["project-ref"] ?? (await detectLinkedProjectRef(root));
  const publicUrl = parsed.values["public-url"]
    ? normalizePublicUrl(parsed.values["public-url"])
    : !existingAuth && process.stdin.isTTY && !machine && !parsed.values.yes
      ? await guidedPublicUrl()
      : undefined;
  const endpoint =
    parsed.values.url ?? publicUrl ?? endpointFor(projectRef, functionName);
  const planOnly = Boolean(parsed.values.plan);
  let files: PlannedFile[] = [];
  const addConsent = Boolean(
    existingAuth && consent === "minimal" && !detectedConsent,
  );
  let applied = Boolean(existingAuth) && !addConsent;

  if (!existingAuth || addConsent) {
    const fullPlan = await planInit({
      cwd: root,
      functionName,
      serverName: parsed.values["server-name"] ?? basename(root),
      auth,
      consent,
      patchConfig: !parsed.values["no-config"],
    });
    files = addConsent
      ? fullPlan.filter(
          (file) =>
            file.path.includes(`${functionName}-consent`) ||
            file.path.endsWith(join("supabase", "config.toml")),
        )
      : fullPlan;
    const conflicts = files.filter((file) => file.status === "conflict");
    if (conflicts.length > 0) {
      throw new Error(
        "Resolve the listed file conflicts, then run setup again.",
      );
    }
  }

  const hasChanges = files.some((file) =>
    ["create", "update"].includes(file.status),
  );
  const needsConfirmation =
    hasChanges &&
    machine &&
    !parsed.values.yes &&
    !parsed.values.resume &&
    !planOnly;
  if (planOnly || needsConfirmation) {
    const report = buildSetupReport({
      command: "setup",
      projectRoot: root,
      functionName,
      auth,
      consent,
      files: fileSummary(files, root),
      applied,
      planned: true,
      needsConfirmation,
      projectRef,
      endpoint,
      publicUrl,
      localChecks: "ready",
      migrations: auth === "public" ? "ready" : "skipped",
    });
    if (machine) printJson(report);
    else {
      console.log(`\nFile plan:\n${displayPlan(files, root)}\n`);
      console.log(formatSetupReport(report));
    }
    return;
  }

  if (hasChanges) {
    if (!machine) console.log(`\nFile plan:\n${displayPlan(files, root)}\n`);
    if (
      !parsed.values.yes &&
      !parsed.values.resume &&
      !(await confirm("Create this MCP server?"))
    ) {
      throw new Error(
        "No files changed. Re-run with --yes for non-interactive use.",
      );
    }
    await applyPlan(files);
    applied = true;
  }

  let localChecks: "complete" | "ready" | "blocked" | "skipped" = parsed.values[
    "skip-checks"
  ]
    ? "skipped"
    : "ready";
  let checkDetail: string | undefined;
  if (!parsed.values["skip-checks"] && (await commandAvailable("deno"))) {
    if (!machine) console.log("\nChecking the generated Edge Function...");
    const functionDir = join(root, "supabase", "functions", functionName);
    const check = await runCommand(
      "deno",
      ["task", "check"],
      functionDir,
      machine,
    );
    const test = check.ok
      ? await runCommand("deno", ["task", "test"], functionDir, machine)
      : { ok: false, detail: "tests skipped because type-check failed" };
    localChecks = check.ok && test.ok ? "complete" : "blocked";
    checkDetail =
      localChecks === "complete"
        ? "Type-check and generated test passed."
        : `${check.detail}; ${test.detail}`;
  } else if (!parsed.values["skip-checks"]) {
    checkDetail =
      "Deno is not installed; run the printed check command when available.";
  }

  let migrations: "complete" | "ready" | "blocked" | "skipped" =
    auth === "public" ? "ready" : "skipped";
  let migrationDetail: string | undefined;
  if (auth === "public" && parsed.values["apply-migrations"]) {
    if (!machine) console.log("\nApplying pending Supabase migrations...");
    const result = await runCommand(
      "supabase",
      ["db", "push", "--yes"],
      root,
      machine,
    );
    migrations = result.ok ? "complete" : "blocked";
    migrationDetail = result.ok
      ? "The public rate-limit migration was applied."
      : result.detail;
  }

  let deployed = false;
  let deployDetail: string | undefined;
  let deploymentAllowed =
    parsed.values.deploy &&
    localChecks !== "blocked" &&
    (auth !== "public" || migrations === "complete");
  if (parsed.values.deploy && !deploymentAllowed) {
    deployDetail =
      auth === "public" && migrations !== "complete"
        ? "Deployment paused: public mode requires --apply-migrations so the endpoint does not start in a 503 state."
        : "Deployment paused until local checks pass.";
  }
  let publicUrlConfigured = !publicUrl;
  if (deploymentAllowed && publicUrl) {
    if (!machine) console.log("\nConfiguring the public MCP URL...");
    const result = await runCommand(
      "supabase",
      [
        "secrets",
        "set",
        `MCP_PUBLIC_URL=${publicUrl}`,
        "--yes",
        ...(projectRef ? ["--project-ref", projectRef] : []),
      ],
      root,
      machine,
    );
    publicUrlConfigured = result.ok;
    if (!result.ok) {
      deploymentAllowed = false;
      deployDetail = `Public URL configuration failed: ${result.detail}`;
    }
  }
  if (deploymentAllowed) {
    if (!machine) console.log("\nDeploying the MCP Edge Function...");
    const deployArgs = [
      "functions",
      "deploy",
      functionName,
      "--no-verify-jwt",
      "--yes",
      ...(projectRef ? ["--project-ref", projectRef] : []),
    ];
    const result = await runCommand("supabase", deployArgs, root, machine);
    deployed = result.ok;
    deployDetail = result.ok
      ? "The MCP Edge Function was deployed."
      : result.detail;
    if (deployed && consent === "minimal") {
      const consentResult = await runCommand(
        "supabase",
        [
          "functions",
          "deploy",
          `${functionName}-consent`,
          "--no-verify-jwt",
          "--yes",
          ...(projectRef ? ["--project-ref", projectRef] : []),
        ],
        root,
        machine,
      );
      deployed = consentResult.ok;
      if (!consentResult.ok) deployDetail = consentResult.detail;
    }
  }

  const shouldVerify = Boolean(
    parsed.values.url ||
    (parsed.values.resume && endpoint) ||
    (deployed && endpoint),
  );
  let remoteVerified = false;
  let verifyDetail: string | undefined;
  if (shouldVerify && endpoint) {
    try {
      const remoteChecks = await runDoctor({
        cwd: root,
        functionName,
        auth,
        url: endpoint,
        token: parsed.values.token,
      });
      const networkChecks = remoteChecks.filter((check) =>
        [
          "oauth-challenge",
          "protected-resource-metadata",
          "advertised-resource-url",
          "bearer-gate",
          "authenticated-tools-list",
          "public-tools-list",
          "public-rate-limit",
        ].includes(check.name),
      );
      remoteVerified = allChecksPass(networkChecks);
      verifyDetail = remoteVerified
        ? "Remote authentication and MCP discovery checks passed."
        : networkChecks
            .filter((check) => !check.ok)
            .map((check) => `${check.name}: ${check.detail}`)
            .join("; ");
    } catch (error) {
      verifyDetail =
        error instanceof Error ? error.message : "Remote verification failed.";
    }
  }

  const report = buildSetupReport({
    command: "setup",
    projectRoot: root,
    functionName,
    auth,
    consent,
    files: fileSummary(files, root),
    applied,
    planned: false,
    localChecks,
    migrations,
    deployed,
    remoteVerified,
    remoteAttempted: shouldVerify,
    endpoint,
    publicUrl,
    publicUrlConfigured,
    projectRef,
    checkDetail,
    migrationDetail,
    deployDetail,
    verifyDetail,
  });
  if (machine) printJson(report);
  else console.log(formatSetupReport(report));
  if (report.status === "blocked") process.exitCode = 1;
}

async function status(args: string[]): Promise<void> {
  const parsed = parse(args);
  const machine = parsed.values.json ?? false;
  const root = await findSupabaseProject(process.cwd());
  const functionName = parsed.values.function ?? "mcp";
  const detectedAuth = await detectGeneratedAuth(root, functionName);
  const auth = choice(
    parsed.values.auth ?? detectedAuth,
    ["oauth", "api-key", "bearer", "public"] as const,
    "oauth",
    "--auth",
  );
  const consent = (await pathExists(
    join(root, "supabase", "functions", `${functionName}-consent`, "index.ts"),
  ))
    ? "minimal"
    : "none";
  const projectRef =
    parsed.values["project-ref"] ?? (await detectLinkedProjectRef(root));
  const publicUrl = parsed.values["public-url"]
    ? normalizePublicUrl(parsed.values["public-url"])
    : undefined;
  const endpoint =
    parsed.values.url ?? publicUrl ?? endpointFor(projectRef, functionName);
  const localChecks = await runDoctor({
    cwd: root,
    functionName,
    auth,
  });
  let remote: DoctorCheck[] = [];
  let remoteError: string | undefined;
  if (endpoint) {
    try {
      const checks = await runDoctor({
        cwd: root,
        functionName,
        auth,
        url: endpoint,
        token: parsed.values.token,
      });
      remote = checks.filter(
        (check) =>
          !["gateway", "dependencies"].includes(check.name) &&
          !check.name.startsWith("file:"),
      );
    } catch (error) {
      remoteError =
        error instanceof Error ? error.message : "Remote verification failed.";
    }
  }
  const remoteAttempted = Boolean(endpoint);
  const remoteVerified =
    remoteAttempted && !remoteError && allChecksPass(remote);
  const report = buildSetupReport({
    command: "status",
    projectRoot: root,
    functionName,
    auth,
    consent,
    files: [],
    applied: allChecksPass(localChecks),
    planned: false,
    localChecks: allChecksPass(localChecks) ? "complete" : "blocked",
    migrations:
      auth === "public" && remoteVerified
        ? "complete"
        : auth === "public"
          ? "ready"
          : "skipped",
    remoteVerified,
    remoteAttempted,
    endpoint,
    publicUrl,
    projectRef,
    checkDetail: allChecksPass(localChecks)
      ? "Generated files and gateway configuration are present."
      : localChecks
          .filter((check) => !check.ok)
          .map((check) => check.detail)
          .join("; "),
    verifyDetail: remoteVerified
      ? "Remote authentication and MCP discovery checks passed."
      : (remoteError ??
        remote
          .filter((check) => !check.ok)
          .map((check) => `${check.name}: ${check.detail}`)
          .join("; ")),
  });
  if (machine) printJson(report);
  else console.log(formatSetupReport(report));
  if (report.status === "blocked") process.exitCode = 1;
}

async function doctor(args: string[]): Promise<void> {
  const parsed = parse(args);
  const checks = await runDoctor({
    cwd: process.cwd(),
    functionName: parsed.values.function ?? "mcp",
    url: parsed.values.url,
    token: parsed.values.token,
    auth: parsed.values.auth
      ? choice(
          parsed.values.auth,
          ["oauth", "api-key", "bearer", "public"] as const,
          "oauth",
          "--auth",
        )
      : undefined,
  });
  if (parsed.values.json) {
    printJson({
      schemaVersion: 1,
      command: "doctor",
      status: checks.every((check) => check.ok) ? "complete" : "blocked",
      checks,
    });
  } else {
    for (const check of checks) {
      console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
    }
  }
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

async function dev(args: string[]): Promise<void> {
  const parsed = parse(args);
  if (parsed.values.json) {
    throw new Error(
      "dev streams Supabase CLI output and does not support --json.",
    );
  }
  const functionName = parsed.values.function ?? "mcp";
  const root = await findSupabaseProject(process.cwd());
  console.log(`Serving http://127.0.0.1:54321/functions/v1/${functionName}`);
  const result = await runCommand(
    "supabase",
    ["functions", "serve", functionName],
    root,
    false,
  );
  if (!result.ok) throw new Error(`Supabase CLI ${result.detail}`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }
  if (args.includes("--help")) {
    console.log(HELP);
    return;
  }
  if (command === "setup") return setup(args);
  if (command === "status") return status(args);
  if (command === "init") return init(args);
  if (command === "doctor") return doctor(args);
  if (command === "dev") return dev(args);
  throw new Error(`Unknown command '${command}'.\n\n${HELP}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes("--json")) {
    printJson({
      schemaVersion: 1,
      command: process.argv[2] ?? "unknown",
      status: "error",
      error: { code: "command_failed", message },
    });
  } else {
    console.error(message);
  }
  process.exitCode = 1;
});
