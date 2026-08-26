#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { runDoctor, type DoctorCheck } from "./doctor.js";
import {
  applyPlan,
  displayPlan,
  findSupabaseProject,
  PACKAGE_VERSION,
  planInit,
  type PlannedFile,
} from "./project.js";
import {
  buildSetupReport,
  detectLinkedProjectRef,
  endpointFor,
  formatSetupReport,
  inspectGeneratedAuth,
  normalizePublicUrl,
  type ApiKeyStrategy,
  type RemoteVerificationEvidence,
  type SetupAuthMode,
  type SetupReport,
} from "./setup.js";
import {
  applySkillPlan,
  loadBundledSkill,
  planSkill,
  SKILL_RELATIVE_DIRECTORY,
  skillPlanSummary,
  type SkillAction,
  type SkillPlan,
} from "./skill.js";

const HELP = `supa-mcp ${PACKAGE_VERSION}

Usage:
  supa-mcp setup [options]   Guided, resumable installation
  supa-mcp status [options]  Read-only setup status
  supa-mcp init [options]    Generate files only
  supa-mcp doctor [options]  Check local or deployed setup
  supa-mcp dev [options]     Serve the function locally
  supa-mcp skill <action>    Install, inspect, or update the project agent skill

Skill actions:
  skill install           Install the versioned skill into this project
  skill status            Inspect the managed installation without writing
  skill update            Safely update unmodified managed skill files

Setup options:
  --function <name>       Edge Function name (default: mcp)
  --server-name <name>    MCP display name (default: repository name)
  --auth <mode>           oauth, api-key, bearer, or public (guided interactively)
  --consent <mode>        none or minimal (default: none)
  --project-ref <ref>     Supabase project ref for deploy and endpoint discovery
  --public-url <url>      Clean URL clients will use, such as https://app.com/mcp
  --state-namespace <id>  Opt into credential-partitioned Postgres state
  --apply-migrations      Apply explicitly generated database support
  --deploy                Deploy after generation and local checks
  --skip-checks           Do not run generated Deno checks
  --resume                Re-observe the current setup and continue safely
  --plan                  Print the complete setup plan without writing

Shared options:
  --url <url>             Deployed MCP URL for status or doctor
  --token <token>         User token or application API key for an MCP probe
  --dry-run               Print init's file plan without writing
  --yes                   Never prompt; accept the selected/default choices
  --json                  Stable machine-readable output; never prompts
  --no-config             Do not patch supabase/config.toml
  --help                  Show this help

Agent quickstart:
  supa-mcp setup --auth oauth --yes --json
  supa-mcp status --json
  supa-mcp skill install --yes --json
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
      "state-namespace": { type: "string" },
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

async function localCheckCommand(
  root: string,
  functionName: string,
): Promise<string> {
  const denoConfigPath = join(
    root,
    "supabase",
    "functions",
    functionName,
    "deno.json",
  );
  const denoConfig = (await pathExists(denoConfigPath))
    ? await readFile(denoConfigPath, "utf8")
    : "";
  const hasCheckTask = /["']check["']\s*:/.test(denoConfig);
  const hasTestTask = /["']test["']\s*:/.test(denoConfig);
  return hasCheckTask && hasTestTask
    ? `deno task --config supabase/functions/${functionName}/deno.json check && deno task --config supabase/functions/${functionName}/deno.json test`
    : `deno check supabase/functions/${functionName}/index.ts`;
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

type SkillCommandStatus =
  | "planned"
  | "needs_confirmation"
  | "complete"
  | "current"
  | "update_available"
  | "not_installed"
  | "modified"
  | "blocked";

function skillNextCommand(
  action: SkillAction,
  state: SkillPlan["state"],
): string | undefined {
  if (state === "not_installed") {
    return "npx supa-mcp skill install --yes --json";
  }
  if (
    state === "update_available" ||
    (action === "install" && state === "current")
  ) {
    return state === "update_available"
      ? "npx supa-mcp skill update --yes --json"
      : undefined;
  }
  return undefined;
}

function skillReport(
  plan: SkillPlan,
  status: SkillCommandStatus,
  message = plan.message,
) {
  return {
    schemaVersion: 1 as const,
    command: "skill" as const,
    action: plan.action,
    status,
    projectRoot: plan.projectRoot,
    skillPath: `${SKILL_RELATIVE_DIRECTORY}/SKILL.md`,
    ...(plan.installedVersion
      ? { installedVersion: plan.installedVersion }
      : {}),
    availableVersion: plan.availableVersion,
    files: skillPlanSummary(plan),
    ...(message ? { message } : {}),
    ...(skillNextCommand(plan.action, plan.state)
      ? { nextCommand: skillNextCommand(plan.action, plan.state) }
      : {}),
  };
}

function formatSkillPlan(plan: SkillPlan): string {
  return plan.files
    .map(
      (file) =>
        `${file.status.padEnd(9)} ${file.relativePath}${file.reason ? ` — ${file.reason}` : ""}`,
    )
    .join("\n");
}

function printSkillReport(
  plan: SkillPlan,
  status: SkillCommandStatus,
  message?: string,
): void {
  if (status === "complete") {
    console.log(`Supa MCP skill ${plan.availableVersion} is installed.`);
    console.log(`Agent entrypoint: ${SKILL_RELATIVE_DIRECTORY}/SKILL.md`);
    return;
  }
  if (status === "current") {
    console.log(`Supa MCP skill ${plan.availableVersion} is current.`);
    return;
  }
  if (status === "update_available") {
    console.log(
      `Supa MCP skill ${plan.installedVersion ?? "unknown"} can update to ${plan.availableVersion}.`,
    );
    console.log("Run: npx supa-mcp skill update");
    return;
  }
  if (status === "not_installed") {
    console.log("The Supa MCP project skill is not installed.");
    console.log("Run: npx supa-mcp skill install");
    return;
  }
  if (plan.files.length > 0) {
    console.log(`\nSkill file plan:\n${formatSkillPlan(plan)}\n`);
  }
  console.log(
    message ??
      (status === "planned"
        ? "No files changed."
        : (plan.message ?? "The skill command needs attention.")),
  );
}

async function skill(args: string[]): Promise<void> {
  const parsed = parse(args);
  const [actionValue, ...extra] = parsed.positionals;
  if (
    !actionValue ||
    !["install", "status", "update"].includes(actionValue) ||
    extra.length > 0
  ) {
    throw new Error(
      "Use `supa-mcp skill install`, `supa-mcp skill status`, or `supa-mcp skill update`.",
    );
  }
  const action = actionValue as SkillAction;
  const machine = parsed.values.json ?? false;
  const root = await findSupabaseProject(process.cwd());
  const bundle = await loadBundledSkill();
  let plan = await planSkill(action, root, bundle);

  const terminalStatus: SkillCommandStatus | undefined =
    plan.state === "blocked"
      ? "blocked"
      : plan.state === "modified"
        ? "modified"
        : plan.state === "not_installed"
          ? "not_installed"
          : action === "install" && plan.state === "update_available"
            ? "update_available"
            : action === "status"
              ? plan.state === "ready"
                ? "not_installed"
                : plan.state
              : plan.state === "current"
                ? "current"
                : undefined;
  if (terminalStatus) {
    if (machine) printJson(skillReport(plan, terminalStatus));
    else printSkillReport(plan, terminalStatus);
    if (["blocked", "modified"].includes(terminalStatus)) process.exitCode = 1;
    return;
  }

  const planOnly = Boolean(parsed.values.plan);
  const needsConfirmation = machine && !parsed.values.yes && !planOnly;
  if (planOnly || needsConfirmation) {
    const status = needsConfirmation ? "needs_confirmation" : "planned";
    const message = needsConfirmation
      ? "Review the file plan, then rerun with --yes."
      : "No files changed.";
    if (machine) printJson(skillReport(plan, status, message));
    else printSkillReport(plan, status, message);
    return;
  }

  if (!machine) console.log(`\nSkill file plan:\n${formatSkillPlan(plan)}\n`);
  if (!parsed.values.yes && !(await confirm("Apply this skill plan?"))) {
    throw new Error(
      "No files changed. Re-run with --yes for non-interactive use.",
    );
  }
  await applySkillPlan(plan);
  plan = await planSkill("status", root, bundle);
  if (plan.state !== "current") {
    throw new Error(
      "The skill files were written but verification did not pass.",
    );
  }
  const reportPlan = { ...plan, action };
  if (machine) printJson(skillReport(reportPlan, "complete"));
  else printSkillReport(reportPlan, "complete");
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
    stateNamespace: parsed.values["state-namespace"],
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
  return (
    checks.length > 0 &&
    checks.every((check) => check.ok || check.blocking === false)
  );
}

function remoteEvidence(
  checks: readonly DoctorCheck[],
  auth: SetupAuthMode,
  credentialSupplied: boolean,
  attempted: boolean,
): RemoteVerificationEvidence {
  const passed = (name: string) =>
    checks.some((check) => check.name === name && check.ok);
  const runtimeReached =
    passed("runtime-reached") ||
    passed("authenticated-tools-list") ||
    passed("public-tools-list") ||
    passed("protected-resource-metadata");
  const gateName =
    auth === "oauth"
      ? "oauth-challenge"
      : auth === "api-key"
        ? "api-key-gate"
        : auth === "bearer"
          ? "bearer-gate"
          : undefined;
  const credentialAccepted = credentialSupplied
    ? passed("authenticated-tools-list")
    : undefined;
  const runtimeCheck = checks.find(
    (check) => check.name === "runtime-reached" && check.ok,
  );
  const strategyCheck = checks.find(
    (check) => check.name === "runtime-auth-strategy" && check.ok,
  );
  const observedStrategy = ["static", "verifier", "unknown"].includes(
    strategyCheck?.detail ?? "",
  )
    ? (strategyCheck?.detail as ApiKeyStrategy)
    : undefined;
  return {
    attempted,
    reachable: passed("endpoint-reachable"),
    runtimeReached,
    authGateObserved: gateName ? runtimeReached && passed(gateName) : false,
    credentialSupplied,
    ...(credentialAccepted === undefined ? {} : { credentialAccepted }),
    mcpDiscoveryVerified:
      passed("public-tools-list") || passed("authenticated-tools-list"),
    resourceUrlVerified:
      passed("runtime-resource-url") || passed("advertised-resource-url"),
    ...(runtimeCheck
      ? { runtimeVersion: runtimeCheck.detail.replace(/^supa-mcp\s+/, "") }
      : {}),
    ...(runtimeReached ? { authMode: auth } : {}),
    ...(observedStrategy ? { apiKeyStrategy: observedStrategy } : {}),
  };
}

function verificationDetail(
  evidence: RemoteVerificationEvidence,
  auth: SetupAuthMode,
  remoteVerified: boolean,
  failedChecks: readonly DoctorCheck[],
): string {
  if (remoteVerified) {
    return "The deployed endpoint accepted a credential and returned MCP capabilities.";
  }
  if (!evidence.runtimeReached) {
    return "The endpoint answered, but the Supa MCP runtime was not confirmed. Check the deployed function and verify_jwt setting, then retry.";
  }
  if (
    auth !== "public" &&
    evidence.authGateObserved &&
    !evidence.credentialSupplied
  ) {
    if (auth === "oauth") {
      return "OAuth discovery and access protection are ready. Sign in from an MCP client to test authenticated tool access.";
    }
    return "The endpoint is responding and access protection is active. Supply a credential to test a complete MCP connection.";
  }
  return failedChecks.length > 0
    ? failedChecks.map((check) => `${check.name}: ${check.detail}`).join("; ")
    : "The endpoint responded, but MCP capability discovery was not completed.";
}

async function setup(args: string[]): Promise<void> {
  const parsed = parse(args);
  const machine = parsed.values.json ?? false;
  const root = await findSupabaseProject(process.cwd());
  const functionName = parsed.values.function ?? "mcp";
  const existingInspection = await inspectGeneratedAuth(root, functionName);
  const existingAuth = existingInspection?.mode;
  const requestedStateNamespace = parsed.values["state-namespace"];
  if (
    existingAuth &&
    requestedStateNamespace &&
    requestedStateNamespace !== existingInspection.stateNamespace
  ) {
    throw new Error(
      "--state-namespace does not match the existing function configuration.",
    );
  }
  const stateNamespace =
    requestedStateNamespace ?? existingInspection?.stateNamespace;
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
  const apiKeyStrategy: ApiKeyStrategy | undefined =
    auth === "api-key"
      ? (existingInspection?.apiKeyStrategy ?? "static")
      : undefined;
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
  const existingLocalCheckCommand = existingAuth
    ? await localCheckCommand(root, functionName)
    : undefined;
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
      stateNamespace,
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
      migrations: auth === "public" || stateNamespace ? "ready" : "skipped",
      durableState: Boolean(stateNamespace),
      apiKeyStrategy,
      localCheckCommand: existingLocalCheckCommand,
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
    const denoConfigPath = join(functionDir, "deno.json");
    const denoConfig = (await pathExists(denoConfigPath))
      ? await readFile(denoConfigPath, "utf8")
      : "";
    const hasCheckTask = /["']check["']\s*:/.test(denoConfig);
    const hasTestTask = /["']test["']\s*:/.test(denoConfig);
    const check = await runCommand(
      "deno",
      hasCheckTask ? ["task", "check"] : ["check", "index.ts"],
      functionDir,
      machine,
    );
    const test =
      check.ok && hasTestTask
        ? await runCommand("deno", ["task", "test"], functionDir, machine)
        : check.ok
          ? { ok: true, detail: "no standard test task was found" }
          : { ok: false, detail: "tests skipped because type-check failed" };
    localChecks = check.ok && test.ok ? "complete" : "blocked";
    checkDetail =
      localChecks === "complete"
        ? hasTestTask
          ? "Type-check and contract test passed."
          : "Type-check passed; no standard test task was found."
        : `${check.detail}; ${test.detail}`;
  } else if (!parsed.values["skip-checks"]) {
    checkDetail =
      "Deno is not installed; run the printed check command when available.";
  }

  let migrations: "complete" | "ready" | "blocked" | "skipped" =
    auth === "public" || stateNamespace ? "ready" : "skipped";
  let migrationDetail: string | undefined;
  if (
    (auth === "public" || stateNamespace) &&
    parsed.values["apply-migrations"]
  ) {
    if (!machine) console.log("\nApplying pending Supabase migrations...");
    const result = await runCommand(
      "supabase",
      ["db", "push", "--yes"],
      root,
      machine,
    );
    migrations = result.ok ? "complete" : "blocked";
    migrationDetail = result.ok
      ? stateNamespace && auth === "public"
        ? "The public rate-limit and durable-state migrations were applied."
        : stateNamespace
          ? "The durable-state migration was applied."
          : "The public rate-limit migration was applied."
      : result.detail;
  }

  let deployed = false;
  let deployDetail: string | undefined;
  let deploymentAllowed =
    parsed.values.deploy &&
    localChecks !== "blocked" &&
    (!(auth === "public" || stateNamespace) || migrations === "complete");
  if (parsed.values.deploy && !deploymentAllowed) {
    deployDetail =
      (auth === "public" || stateNamespace) && migrations !== "complete"
        ? "Deployment paused: the generated database support requires --apply-migrations before the endpoint starts."
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
  let remoteReady = !shouldVerify;
  let verification: RemoteVerificationEvidence | undefined;
  let verifyDetail: string | undefined;
  if (shouldVerify && endpoint) {
    try {
      const remoteChecks = await runDoctor({
        cwd: root,
        functionName,
        auth,
        apiKeyStrategy,
        url: endpoint,
        token: parsed.values.token,
      });
      const networkChecks = remoteChecks.filter((check) =>
        [
          "oauth-challenge",
          "protected-resource-metadata",
          "advertised-resource-url",
          "bearer-gate",
          "api-key-gate",
          "authenticated-tools-list",
          "public-tools-list",
          "public-rate-limit",
          "endpoint-reachable",
          "runtime-reached",
          "runtime-version",
          "runtime-auth-mode",
          "runtime-auth-strategy",
          "runtime-resource-url",
        ].includes(check.name),
      );
      verification = remoteEvidence(
        networkChecks,
        auth,
        Boolean(parsed.values.token),
        true,
      );
      remoteReady = allChecksPass(networkChecks);
      remoteVerified = remoteReady && verification.mcpDiscoveryVerified;
      verifyDetail = verificationDetail(
        verification,
        auth,
        remoteVerified,
        networkChecks.filter((check) => !check.ok && check.blocking !== false),
      );
    } catch (error) {
      remoteReady = false;
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
    remoteReady,
    verification,
    endpoint,
    publicUrl,
    publicUrlConfigured,
    projectRef,
    checkDetail,
    migrationDetail,
    durableState: Boolean(stateNamespace),
    deployDetail,
    verifyDetail,
    apiKeyStrategy,
    localCheckCommand: existingLocalCheckCommand,
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
  const inspection = await inspectGeneratedAuth(root, functionName);
  const configuredAuth = parsed.values.auth
    ? choice(
        parsed.values.auth,
        ["oauth", "api-key", "bearer", "public"] as const,
        "oauth",
        "--auth",
      )
    : inspection?.mode;
  let auth = configuredAuth ?? "oauth";
  let apiKeyStrategy: ApiKeyStrategy | undefined =
    auth === "api-key" ? (inspection?.apiKeyStrategy ?? "unknown") : undefined;
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
  const statusLocalCheckCommand = await localCheckCommand(root, functionName);
  const localChecks = await runDoctor({
    cwd: root,
    functionName,
    auth: configuredAuth,
  });
  const localReady = allChecksPass(localChecks);
  const localAdvisories = localChecks.filter(
    (check) => !check.ok && check.blocking === false,
  );
  let remote: DoctorCheck[] = [];
  let remoteError: string | undefined;
  if (endpoint) {
    try {
      const checks = await runDoctor({
        cwd: root,
        functionName,
        auth: configuredAuth,
        apiKeyStrategy,
        url: endpoint,
        token: parsed.values.token,
      });
      remote = checks.filter(
        (check) =>
          !["gateway", "dependencies"].includes(check.name) &&
          !check.name.startsWith("file:"),
      );
      if (!configuredAuth) {
        const observedAuth = remote.find(
          (check) => check.name === "runtime-auth-mode" && check.ok,
        )?.detail;
        if (
          ["oauth", "api-key", "bearer", "public"].includes(observedAuth ?? "")
        ) {
          auth = observedAuth as SetupAuthMode;
          if (auth === "api-key" && apiKeyStrategy === undefined) {
            apiKeyStrategy = "unknown";
          }
        }
      }
    } catch (error) {
      remoteError =
        error instanceof Error ? error.message : "Remote verification failed.";
    }
  }
  const remoteAttempted = Boolean(endpoint);
  const evidence = remoteEvidence(
    remote,
    auth,
    Boolean(parsed.values.token),
    remoteAttempted,
  );
  const remoteReady = remoteAttempted && !remoteError && allChecksPass(remote);
  const remoteVerified = remoteReady && evidence.mcpDiscoveryVerified;
  const report = buildSetupReport({
    command: "status",
    projectRoot: root,
    functionName,
    auth,
    consent,
    files: [],
    applied: localReady,
    planned: false,
    localChecks: localReady ? "complete" : "blocked",
    // A public request necessarily exercises its database limiter. A stateful
    // tools/list proves the HMAC/admin setup, but it need not call a state RPC,
    // so remote discovery alone must not claim that migration is installed.
    migrations:
      auth === "public" && remoteVerified
        ? "complete"
        : auth === "public" || inspection?.stateNamespace
          ? "ready"
          : "skipped",
    durableState: Boolean(inspection?.stateNamespace),
    remoteVerified,
    remoteAttempted,
    remoteReady,
    verification: evidence,
    endpoint,
    publicUrl,
    projectRef,
    checkDetail: localReady
      ? localAdvisories.length > 0
        ? `The function can run. Optional scaffold checks: ${localAdvisories.map((check) => `${check.name} ${check.detail}`).join("; ")}.`
        : "The function, pinned runtime, and gateway configuration are present."
      : localChecks
          .filter((check) => !check.ok && check.blocking !== false)
          .map((check) => check.detail)
          .join("; "),
    verifyDetail: remoteAttempted
      ? (remoteError ??
        verificationDetail(
          evidence,
          auth,
          remoteVerified,
          remote.filter((check) => !check.ok && check.blocking !== false),
        ))
      : undefined,
    apiKeyStrategy,
    localCheckCommand: statusLocalCheckCommand,
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
      status: allChecksPass(checks) ? "complete" : "blocked",
      checks,
    });
  } else {
    for (const check of checks) {
      const marker = check.ok ? "✓" : check.blocking === false ? "!" : "✗";
      console.log(`${marker} ${check.name}: ${check.detail}`);
    }
  }
  if (checks.some((check) => !check.ok && check.blocking !== false)) {
    process.exitCode = 1;
  }
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
  if (command === "skill") return skill(args);
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
