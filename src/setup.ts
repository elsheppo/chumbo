import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

export type SetupAuthMode = "oauth" | "bearer" | "public";
export type SetupStepStatus =
  | "complete"
  | "ready"
  | "needs_user_action"
  | "blocked"
  | "skipped";

export interface SetupStep {
  id: string;
  title: string;
  status: SetupStepStatus;
  detail: string;
  command?: string;
  url?: string;
}

export interface SetupReport {
  schemaVersion: 1;
  command: "setup" | "status";
  status:
    | "planned"
    | "ready"
    | "needs_confirmation"
    | "needs_user_action"
    | "blocked"
    | "complete";
  projectRoot: string;
  functionName: string;
  auth: SetupAuthMode;
  endpoint?: string;
  files: Array<{
    path: string;
    status: "create" | "unchanged" | "update" | "conflict";
  }>;
  steps: SetupStep[];
  nextActions: SetupStep[];
  resumeCommand: string;
}

export interface BuildSetupReportOptions {
  command: "setup" | "status";
  projectRoot: string;
  functionName: string;
  auth: SetupAuthMode;
  consent: "none" | "minimal";
  files: SetupReport["files"];
  applied: boolean;
  planned: boolean;
  needsConfirmation?: boolean;
  localChecks?: "complete" | "ready" | "blocked" | "skipped";
  migrations?: "complete" | "ready" | "blocked" | "skipped";
  deployed?: boolean;
  remoteVerified?: boolean;
  remoteAttempted?: boolean;
  endpoint?: string;
  projectRef?: string;
  checkDetail?: string;
  migrationDetail?: string;
  deployDetail?: string;
  verifyDetail?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function detectGeneratedAuth(
  root: string,
  functionName: string,
): Promise<SetupAuthMode | undefined> {
  const path = join(root, "supabase", "functions", functionName, "index.ts");
  if (!(await exists(path))) return undefined;
  const source = await readFile(path, "utf8");
  return /mode:\s*["']public["']/.test(source)
    ? "public"
    : /mode:\s*["']bearer["']/.test(source)
      ? "bearer"
      : /mode:\s*["']oauth["']/.test(source)
        ? "oauth"
        : undefined;
}

export async function detectLinkedProjectRef(
  root: string,
): Promise<string | undefined> {
  for (const path of [
    join(root, "supabase", ".temp", "project-ref"),
    join(root, ".supabase", "project-ref"),
  ]) {
    if (!(await exists(path))) continue;
    const value = (await readFile(path, "utf8")).trim();
    if (/^[a-z0-9-]+$/i.test(value)) return value;
  }
  return undefined;
}

export function endpointFor(
  projectRef: string | undefined,
  functionName: string,
): string | undefined {
  return projectRef
    ? `https://${projectRef}.supabase.co/functions/v1/${functionName}`
    : undefined;
}

function overallStatus(
  options: BuildSetupReportOptions,
  steps: readonly SetupStep[],
): SetupReport["status"] {
  if (options.planned) {
    return options.needsConfirmation ? "needs_confirmation" : "planned";
  }
  if (steps.some((step) => step.status === "blocked")) return "blocked";
  if (options.remoteVerified) return "complete";
  if (steps.some((step) => step.status === "needs_user_action")) {
    return "needs_user_action";
  }
  return "ready";
}

export function buildSetupReport(
  options: BuildSetupReportOptions,
): SetupReport {
  const endpoint =
    options.endpoint ?? endpointFor(options.projectRef, options.functionName);
  const steps: SetupStep[] = [
    {
      id: "scaffold",
      title: "Generate the MCP Edge Function",
      status: options.applied ? "complete" : "ready",
      detail: options.applied
        ? "Generated files and Supabase gateway configuration are in place."
        : "Review and apply the generated file plan.",
      command: options.applied
        ? undefined
        : `npx create-supabase-mcp setup --function ${options.functionName} --auth ${options.auth} --yes --json`,
    },
    {
      id: "local_checks",
      title: "Check the generated function",
      status: options.localChecks ?? "ready",
      detail:
        options.checkDetail ??
        "Type-check and run the generated contract test.",
      command: `deno task --config supabase/functions/${options.functionName}/deno.json check && deno task --config supabase/functions/${options.functionName}/deno.json test`,
    },
  ];

  if (options.auth === "public") {
    steps.push({
      id: "apply_rate_limit_migration",
      title: "Apply the public rate-limit migration",
      status: options.migrations ?? "ready",
      detail:
        options.migrationDetail ??
        "The public endpoint returns 503 until its Postgres limiter migration is applied.",
      command: "supabase db push --yes",
    });
  }

  steps.push({
    id: "deploy",
    title: "Deploy the Edge Function",
    status: options.deployed || options.remoteVerified ? "complete" : "ready",
    detail:
      options.deployDetail ??
      (options.projectRef
        ? `Deploy to Supabase project ${options.projectRef}.`
        : "Link the Supabase project or pass --project-ref, then deploy."),
    command: `supabase functions deploy ${options.functionName} --no-verify-jwt${options.projectRef ? ` --project-ref ${options.projectRef}` : ""}`,
  });

  if (options.consent === "minimal") {
    steps.push({
      id: "deploy_consent",
      title: "Deploy the fallback consent function",
      status: options.deployed || options.remoteVerified ? "complete" : "ready",
      detail:
        "Deploy the generated fallback only if the application has no consent UI.",
      command: `supabase functions deploy ${options.functionName}-consent --no-verify-jwt${options.projectRef ? ` --project-ref ${options.projectRef}` : ""}`,
    });
  }

  if (options.auth === "oauth") {
    steps.push({
      id: "configure_oauth",
      title: "Enable Supabase OAuth Server",
      status: options.remoteVerified ? "complete" : "needs_user_action",
      detail:
        "Enable OAuth Server, set the authorization path to your application consent UI, and enable dynamic client registration when your MCP clients require it.",
      url: options.projectRef
        ? `https://supabase.com/dashboard/project/${options.projectRef}/auth/oauth-server`
        : "https://supabase.com/dashboard",
    });
  }

  steps.push({
    id: "verify_remote",
    title: "Verify the deployed MCP endpoint",
    status: options.remoteVerified
      ? "complete"
      : options.remoteAttempted
        ? "blocked"
        : "ready",
    detail:
      options.verifyDetail ??
      (endpoint
        ? "Probe the deployed endpoint and its authentication contract."
        : "Pass --url or --project-ref so doctor can probe the deployed endpoint."),
    command: endpoint
      ? `npx create-supabase-mcp doctor --function ${options.functionName} --url ${endpoint} --json`
      : `npx create-supabase-mcp doctor --function ${options.functionName} --url <MCP_URL> --json`,
  });

  if (options.remoteVerified) {
    steps.push({
      id: "connect_client",
      title: "Connect an MCP client",
      status: "ready",
      detail: "Use the endpoint as the remote MCP server URL.",
      ...(endpoint ? { url: endpoint } : {}),
    });
  }

  const nextActions = steps.filter((step) =>
    ["ready", "needs_user_action", "blocked", "skipped"].includes(step.status),
  );

  return {
    schemaVersion: 1,
    command: options.command,
    status: overallStatus(options, steps),
    projectRoot: options.projectRoot,
    functionName: options.functionName,
    auth: options.auth,
    ...(endpoint ? { endpoint } : {}),
    files: options.files,
    steps,
    nextActions,
    resumeCommand: `npx create-supabase-mcp setup --resume --function ${options.functionName} --auth ${options.auth} --yes --json`,
  };
}

function humanCommand(command: string): string {
  return command.replace(" --yes --json", "").replace(" --json", "");
}

export function formatSetupReport(report: SetupReport): string {
  const completed = report.steps.filter((step) => step.status === "complete");
  const lines = [
    "",
    report.status === "complete"
      ? "Your Supabase MCP is live and verified."
      : report.status === "planned" || report.status === "needs_confirmation"
        ? "Setup plan ready."
        : "Your Supabase MCP scaffold is ready.",
  ];
  if (completed.length > 0) {
    lines.push("", "Done:");
    for (const step of completed) lines.push(`  ✓ ${step.title}`);
  }
  if (report.nextActions.length > 0) {
    lines.push("", "Next:");
    report.nextActions.forEach((step, index) => {
      lines.push(`  ${index + 1}. ${step.title}`);
      lines.push(`     ${step.detail}`);
      if (step.command) lines.push(`     ${humanCommand(step.command)}`);
      if (step.url) lines.push(`     ${step.url}`);
    });
  }
  if (report.endpoint) lines.push("", `MCP URL: ${report.endpoint}`);
  lines.push("", `Resume anytime: ${humanCommand(report.resumeCommand)}`);
  lines.push(
    "Agent mode: add --json for stable machine-readable steps and next actions.",
  );
  return lines.join("\n");
}
