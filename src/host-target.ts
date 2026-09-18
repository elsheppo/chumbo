import { PACKAGE_VERSION, type SetupTarget } from "./project.js";
import {
  SUPA_MCP_DOCUMENTATION_SERVER_URL,
  normalizePublicUrl,
  type ApiKeyStrategy,
  type RemoteVerificationEvidence,
  type SetupAuthMode,
  type SetupReport,
  type SetupStep,
} from "./setup.js";

export type HostTarget = Exclude<SetupTarget, "edge-function">;

export interface BuildHostTargetReportOptions {
  command: "setup" | "status";
  projectRoot: string;
  functionName: string;
  target: HostTarget;
  auth: SetupAuthMode;
  localEndpoint: string;
  files: SetupReport["files"];
  applied: boolean;
  planned: boolean;
  needsConfirmation?: boolean;
  /** Whether package.json already lists chumbo as a dependency. */
  runtimeInstalled?: boolean;
  /** Lockfile-matched install prefix, such as `pnpm add`. */
  installCommand: string;
  durableState?: boolean;
  publicUrl?: string;
  endpoint?: string;
  remoteVerified?: boolean;
  remoteAttempted?: boolean;
  remoteReady?: boolean;
  verification?: RemoteVerificationEvidence;
  verifyDetail?: string;
  apiKeyStrategy?: ApiKeyStrategy;
}

function overallStatus(
  options: BuildHostTargetReportOptions,
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

function environmentNames(options: BuildHostTargetReportOptions): string[] {
  const names = ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"];
  if (options.auth === "api-key") names.push("MCP_API_KEY");
  if (options.auth === "public" || options.durableState) {
    names.push("SUPABASE_SECRET_KEY");
  }
  if (options.durableState) names.push("CHUMBO_STATE_HMAC_KEY");
  names.push("MCP_PUBLIC_URL (production)");
  return names;
}

function devCommand(options: BuildHostTargetReportOptions): string {
  if (options.target === "node") {
    return `node --experimental-strip-types ${options.functionName}/index.ts`;
  }
  const manager = options.installCommand.split(" ")[0];
  return manager === "npm" ? "npm run dev" : `${manager} dev`;
}

export function buildHostTargetReport(
  options: BuildHostTargetReportOptions,
): SetupReport {
  const publicUrl = options.publicUrl
    ? normalizePublicUrl(options.publicUrl)
    : undefined;
  const endpoint = options.endpoint ?? publicUrl;
  const apiKeyStrategy = options.apiKeyStrategy ?? "static";
  const localCredential =
    options.auth === "api-key"
      ? ` --token <${apiKeyStrategy === "static" ? "MCP_API_KEY" : "APPLICATION_API_KEY"}>`
      : options.auth === "bearer" || options.auth === "oauth"
        ? " --token <LOCAL_USER_JWT>"
        : "";
  const endpointVerified =
    options.remoteVerified ||
    (options.auth === "oauth" &&
      Boolean(options.verification?.authGateObserved) &&
      Boolean(options.verification?.resourceUrlVerified));
  const scaffoldLabel =
    options.target === "next"
      ? "Generate the MCP route handler"
      : "Generate the MCP server";

  const steps: SetupStep[] = [
    {
      id: "scaffold",
      title: scaffoldLabel,
      status: options.applied ? "complete" : "ready",
      detail: options.applied
        ? options.target === "next"
          ? "The App Router route handler and capability scaffold are in place."
          : "The standalone server entry and capability scaffold are in place."
        : "Review and apply the generated file plan.",
      command: options.applied
        ? undefined
        : `npx chumbo setup --target ${options.target} --function ${options.functionName} --auth ${options.auth} --yes --json`,
    },
    {
      id: "install_runtime",
      title: "Install the Chumbo runtime",
      status: options.runtimeInstalled ? "complete" : "ready",
      detail: options.runtimeInstalled
        ? "package.json lists the chumbo dependency."
        : "Add chumbo as an application dependency so the generated code resolves.",
      command: options.runtimeInstalled
        ? undefined
        : `${options.installCommand} chumbo@${PACKAGE_VERSION}`,
    },
    {
      id: "configure_env",
      title: "Configure the server environment",
      status: options.remoteVerified ? "complete" : "needs_user_action",
      detail: `Provide ${environmentNames(options).join(", ")} ${
        options.target === "next"
          ? "in .env.local for development and in your hosting platform for production."
          : "in the local shell for development and in your deployment platform for production."
      }`,
    },
  ];

  if (options.auth === "public") {
    steps.push({
      id: "apply_rate_limit_migration",
      title: "Apply the public rate-limit migration",
      status: options.remoteVerified ? "complete" : "needs_user_action",
      detail:
        "The public endpoint returns 503 until the generated Postgres limiter migration is applied to your Supabase project.",
    });
  }

  if (options.durableState) {
    steps.push({
      id: "apply_durable_state_migration",
      title: "Apply the durable-state migration",
      status: options.remoteVerified ? "complete" : "needs_user_action",
      detail:
        "The state API remains unavailable until its private table and service-role RPCs are installed in your Supabase project.",
    });
  }

  if (!options.remoteVerified) {
    steps.push(
      {
        id: "serve_local",
        title: "Run the application server",
        status: "ready",
        detail:
          options.target === "next"
            ? "Start your app's ordinary dev server; the MCP route serves alongside the rest of the application."
            : "Run the generated server directly. Node 22.18+ executes TypeScript natively.",
        command: devCommand(options),
        url: options.localEndpoint,
      },
      {
        id: "verify_local",
        title: "Call the generated tool locally",
        status: "ready",
        detail:
          "Initialize MCP, discover tools, and explicitly invoke the generated whoami starter.",
        command: `npx chumbo doctor --function ${options.functionName} --url ${options.localEndpoint}${localCredential} --call-tool whoami --json`,
        url: options.localEndpoint,
      },
    );
  }

  steps.push({
    id: "deploy",
    title: "Deploy with your application pipeline",
    status:
      options.remoteVerified || options.verification?.runtimeReached
        ? "complete"
        : "needs_user_action",
    detail:
      options.target === "next"
        ? `Deploy the application as usual (Vercel, Cloud Run, or any Node host) with the same environment variables, including MCP_PUBLIC_URL${publicUrl ? `=${publicUrl}` : ""}.`
        : `Ship the server with your container or Node pipeline (Cloud Run, Fly, Railway) with the same environment variables, including MCP_PUBLIC_URL${publicUrl ? `=${publicUrl}` : ""}. The server listens on PORT.`,
    ...(publicUrl ? { url: publicUrl } : {}),
  });

  if (options.auth === "oauth") {
    steps.push({
      id: "configure_oauth",
      title: "Enable Supabase OAuth Server",
      status:
        options.verification?.authGateObserved &&
        options.verification.resourceUrlVerified
          ? "complete"
          : "needs_user_action",
      detail:
        "Enable OAuth Server, set the authorization path to your application consent UI, and enable dynamic client registration when your MCP clients require it.",
      url: "https://supabase.com/dashboard",
    });
  }

  steps.push({
    id: "verify_remote",
    title: "Verify the deployed MCP endpoint",
    status: endpointVerified
      ? "complete"
      : options.remoteAttempted && !options.remoteReady
        ? "blocked"
        : "ready",
    detail:
      options.verifyDetail ??
      (endpoint
        ? "Probe the deployed endpoint and its authentication contract."
        : "Pass --url or --public-url so doctor can probe the deployed endpoint."),
    command: endpoint
      ? `npx chumbo doctor --function ${options.functionName} --url ${endpoint}${options.auth === "api-key" ? ` --token <${apiKeyStrategy === "static" ? "MCP_API_KEY" : "APPLICATION_API_KEY"}>` : options.auth === "bearer" ? " --token <USER_JWT>" : ""} --json`
      : `npx chumbo doctor --function ${options.functionName} --url <MCP_URL> --json`,
  });

  if (endpointVerified) {
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
    target: options.target,
    auth: options.auth,
    localEndpoint: options.localEndpoint,
    ...(options.auth === "api-key" ? { authStrategy: apiKeyStrategy } : {}),
    ...(endpoint ? { endpoint } : {}),
    files: options.files,
    steps,
    nextActions,
    resumeCommand: `npx chumbo setup --resume --target ${options.target} --function ${options.functionName} --auth ${options.auth} --yes --json`,
    agentHandoff: {
      documentationServerUrl: SUPA_MCP_DOCUMENTATION_SERVER_URL,
      prompt:
        "Inspect this project and implement the authenticated-tools pattern.",
      skillInstallCommand: "npx chumbo skill install --yes --json",
    },
    ...(options.verification ? { verification: options.verification } : {}),
  };
}
