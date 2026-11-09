import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  findPackageProject,
  findSupabaseProject,
  PACKAGE_VERSION,
  type SetupTarget,
} from "./project.js";
import {
  comparableResult,
  dataApiGrantsCheck,
  isolationCandidates,
  jwtSubject,
  toolSurfaceCheck,
  type ProbeTool,
  type ToolResultRecord,
} from "./doctor-checks.js";
import {
  authorizationServerChecks,
  discoverProtectedResource,
  protectedResourceChecks,
} from "./doctor-discovery.js";
import {
  detectGeneratedScaffold,
  inspectGeneratedAuthAt,
  type ApiKeyStrategy,
  type GeneratedScaffold,
  type SetupAuthMode,
} from "./setup.js";

export interface DoctorOptions {
  cwd: string;
  functionName: string;
  url?: string;
  token?: string;
  /**
   * Run the checks that work against any Supabase MCP server: authorization
   * server discovery, tool surface lint, and the advisory result checks. The
   * `chumbo doctor` command sets it; setup and status leave it off.
   */
  deep?: boolean;
  /** A second user's token, for the user-isolation check. Needs `token`. */
  secondToken?: string;
  auth?: SetupAuthMode;
  apiKeyStrategy?: ApiKeyStrategy;
  target?: SetupTarget;
  callTool?: string;
  callArgs?: Record<string, unknown>;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** Advisory checks inform without blocking setup or doctor completion. */
  blocking?: boolean;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function modernRequest(
  method: string,
  params: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": {
          name: "chumbo-doctor",
          version: PACKAGE_VERSION,
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
}

function initializeRequest(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: {
        name: "chumbo-doctor",
        version: PACKAGE_VERSION,
      },
    },
  });
}

function requestHeaders(
  method: string,
  token?: string,
  name?: string,
): Headers {
  const headers = new Headers({
    "content-type": "application/json",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
  });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (name) headers.set("mcp-name", name);
  return headers;
}

interface ProtocolBody {
  result?: Record<string, unknown>;
  error?: { code?: unknown };
}

function endpointUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function responseBody(response: Response): Promise<ProtocolBody | null> {
  const text = await response.text();
  const payload = response.headers
    .get("content-type")
    ?.includes("text/event-stream")
    ? text
        .split(/\r?\n/)
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length)
    : text;
  if (!payload) return null;
  try {
    return JSON.parse(payload) as ProtocolBody;
  } catch {
    return null;
  }
}

function protocolDetail(response: Response, body: ProtocolBody | null): string {
  const suffix =
    body?.error?.code === undefined
      ? ""
      : `; MCP error ${String(body.error.code)}`;
  return `HTTP ${response.status}${suffix}`;
}

function isLocalEndpoint(value: string): boolean {
  const hostname = endpointUrl(value)?.hostname;
  return hostname === "127.0.0.1" || hostname === "localhost";
}

function localServeGuidance(functionName: string, target: SetupTarget): string {
  if (target === "next") return "Start your app's dev server";
  if (target === "node") {
    return `Run node --experimental-strip-types ${functionName}/index.ts`;
  }
  return `Run npx chumbo dev --function ${functionName}`;
}

async function unreachableCheck(
  url: string,
  functionName: string,
  target: SetupTarget,
): Promise<DoctorCheck> {
  if (!isLocalEndpoint(url)) {
    return {
      name: "endpoint-reachable",
      ok: false,
      detail:
        "The endpoint did not respond. Check the URL and deployment, then retry doctor.",
    };
  }
  if (target !== "edge-function") {
    return {
      name: "local-server-running",
      ok: false,
      detail: `The local server did not respond. ${localServeGuidance(functionName, target)}, then retry doctor.`,
    };
  }
  const origin = endpointUrl(url)!.origin;
  try {
    await fetch(origin, { method: "GET" });
    return {
      name: "function-reachable",
      ok: false,
      detail: `Local Supabase responded, but '${functionName}' did not. Run npx chumbo dev --function ${functionName}, then retry doctor.`,
    };
  } catch {
    return {
      name: "local-stack-running",
      ok: false,
      detail:
        "Local Supabase did not respond. Run supabase start, then run npx chumbo dev in another terminal.",
    };
  }
}

interface ProbeOutcome {
  tools?: ProbeTool[];
  results: ToolResultRecord[];
}

function errorMessage(body: ProtocolBody | null): string | undefined {
  const message = (body?.error as { message?: unknown } | undefined)?.message;
  return typeof message === "string" ? message : undefined;
}

async function mcpProbe(
  options: DoctorOptions,
  target: SetupTarget,
  checks: DoctorCheck[],
  token?: string,
): Promise<ProbeOutcome> {
  const outcome: ProbeOutcome = { results: [] };
  let initializeResponse: Response;
  try {
    initializeResponse = await fetch(options.url!, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
      body: initializeRequest(),
    });
  } catch {
    checks.push(
      await unreachableCheck(options.url!, options.functionName, target),
    );
    return outcome;
  }
  const initializeBody = await responseBody(initializeResponse);
  if (initializeResponse.status === 401 || initializeResponse.status === 403) {
    checks.push({
      name: "credential-accepted",
      ok: false,
      detail: `HTTP ${initializeResponse.status}; the supplied credential was rejected. Check the credential and auth mode, then retry without placing the credential in the URL.`,
    });
    return outcome;
  }
  const initialized =
    initializeResponse.ok &&
    Boolean(initializeBody?.result) &&
    !initializeBody?.error;
  checks.push({
    name: "mcp-initialize",
    ok: initialized,
    detail: initialized
      ? `HTTP ${initializeResponse.status}`
      : `${protocolDetail(initializeResponse, initializeBody)}; MCP initialization failed. Check the function logs and retry.`,
  });
  if (!initialized) return outcome;

  let discoveryResponse: Response;
  try {
    discoveryResponse = await fetch(options.url!, {
      method: "POST",
      headers: requestHeaders("tools/list", token),
      body: modernRequest("tools/list"),
    });
  } catch {
    checks.push({
      name: "mcp-tools-list",
      ok: false,
      detail:
        "MCP initialization succeeded, but tools/list did not respond. Check the function logs and retry.",
    });
    return outcome;
  }
  const discoveryBody = await responseBody(discoveryResponse);
  const tools = Array.isArray(discoveryBody?.result?.tools)
    ? (discoveryBody.result.tools as Array<{ name?: unknown }>)
    : undefined;
  const discovered =
    discoveryResponse.ok && Boolean(tools) && !discoveryBody?.error;
  checks.push({
    name: token ? "authenticated-tools-list" : "public-tools-list",
    ok: discovered,
    detail: discovered
      ? `HTTP ${discoveryResponse.status}; ${tools?.length ?? 0} tool${tools?.length === 1 ? "" : "s"}`
      : `${protocolDetail(discoveryResponse, discoveryBody)}; tools/list failed. Check capability registration and function logs.`,
  });
  if (discovered) outcome.tools = (tools ?? []) as ProbeTool[];
  if (!discovered || !options.callTool) return outcome;

  if (!tools?.some((tool) => tool.name === options.callTool)) {
    checks.push({
      name: "tool-call",
      ok: false,
      detail: `Tool '${options.callTool}' was not discovered. Run doctor without --call-tool to verify discovery, then choose an advertised tool.`,
    });
    return outcome;
  }
  let callResponse: Response;
  try {
    callResponse = await fetch(options.url!, {
      method: "POST",
      headers: requestHeaders("tools/call", token, options.callTool),
      body: modernRequest("tools/call", {
        name: options.callTool,
        arguments: options.callArgs ?? {},
      }),
    });
  } catch {
    checks.push({
      name: "tool-call",
      ok: false,
      detail: `Tool '${options.callTool}' did not return a response. Check the function logs and retry.`,
    });
    return outcome;
  }
  const callBody = await responseBody(callResponse);
  outcome.results.push({
    tool: options.callTool,
    caller: "doctor",
    result: callBody?.result,
    errorMessage: errorMessage(callBody),
  });
  const capabilityErrored = callBody?.result?.isError === true;
  const called =
    callResponse.ok &&
    Boolean(callBody?.result) &&
    !callBody?.error &&
    !capabilityErrored;
  checks.push({
    name: "tool-call",
    ok: called,
    detail: called
      ? `Tool '${options.callTool}' completed with HTTP ${callResponse.status}.`
      : capabilityErrored
        ? `Tool '${options.callTool}' returned an MCP error result with HTTP ${callResponse.status}. Check its inputs and capability logs, then retry.`
        : `${protocolDetail(callResponse, callBody)}; tool '${options.callTool}' failed. Check its inputs and function logs.`,
  });
  return outcome;
}

async function callToolAs(
  url: string,
  token: string,
  name: string,
  caller: string,
): Promise<ToolResultRecord & { rejected?: boolean }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: requestHeaders("tools/call", token, name),
      body: modernRequest("tools/call", { name, arguments: {} }),
    });
    const body = await responseBody(response);
    return {
      tool: name,
      caller,
      result: response.ok ? body?.result : undefined,
      errorMessage: errorMessage(body),
      rejected: response.status === 401 || response.status === 403,
    };
  } catch {
    return { tool: name, caller };
  }
}

function plainCount(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Calls read-only, no-argument tools as two different users and compares the
 * results. The comparison is a heuristic and never claims to prove isolation.
 */
async function userIsolationCheck(
  url: string,
  token: string,
  secondToken: string,
  tools: readonly ProbeTool[],
  results: ToolResultRecord[],
): Promise<DoctorCheck> {
  const first = jwtSubject(token);
  const second = jwtSubject(secondToken);
  if (first && second && first === second) {
    return {
      name: "user-isolation",
      ok: false,
      detail:
        "--token and --second-token belong to the same user, so there is nothing to compare. Sign in as a different user for --second-token, then retry.",
    };
  }
  const note =
    first && second
      ? ""
      : " Doctor could not tell whether the two tokens belong to different users, because a token is not a JWT; make sure they do.";
  const { selected, skipped } = isolationCandidates(tools);
  if (selected.length === 0) {
    return {
      name: "user-isolation",
      ok: false,
      detail: `Isolation could not be checked: no tool is marked read-only with no required inputs. Mark read-only tools with readOnlyHint: true so doctor can compare what each user sees.${note}`,
      blocking: false,
    };
  }
  const identical: string[] = [];
  let different = 0;
  let notComparable = 0;
  for (const name of selected) {
    const a = await callToolAs(url, token, name, "first user");
    const b = await callToolAs(url, secondToken, name, "second user");
    results.push(a, b);
    if (b.rejected) {
      return {
        name: "user-isolation",
        ok: false,
        detail:
          "The server rejected --second-token. Check that it is a current access token for a second user of this project, then retry.",
      };
    }
    const left = comparableResult(a);
    const right = comparableResult(b);
    if (left === undefined || right === undefined) notComparable += 1;
    else if (left === right) identical.push(name);
    else different += 1;
  }
  const scope = `${plainCount(selected.length, "read-only tool")} called as both users${skipped > 0 ? `; ${plainCount(skipped, "more tool")} skipped (limit 10)` : ""}`;
  if (identical.length > 0) {
    return {
      name: "user-isolation",
      ok: false,
      detail: `${identical.map((name) => `Tool '${name}'`).join(", ")} returned the same result for both users; confirm this data is meant to be shared. (${scope}.)${note}`,
      blocking: false,
    };
  }
  if (different === 0) {
    return {
      name: "user-isolation",
      ok: false,
      detail: `Isolation could not be checked: no tool returned a result for both users to compare (${scope}). Give the tools data for both users, or check their inputs.${note}`,
      blocking: false,
    };
  }
  return {
    name: "user-isolation",
    ok: true,
    detail: `${plainCount(different, "tool")} returned different results for the two users (${scope}${notComparable > 0 ? `; ${plainCount(notComparable, "tool")} had no result to compare` : ""}). This is a heuristic check, not proof of isolation.${note}`,
    blocking: false,
  };
}

/** Advisory checks that read what the probe discovered and returned. */
async function analyzeProbe(
  options: DoctorOptions,
  checks: DoctorCheck[],
  outcome: ProbeOutcome,
  token?: string,
): Promise<void> {
  if (!options.deep || !outcome.tools) return;
  if (options.secondToken && token) {
    checks.push(
      await userIsolationCheck(
        options.url!,
        token,
        options.secondToken,
        outcome.tools,
        outcome.results,
      ),
    );
  }
  const grants = dataApiGrantsCheck(outcome.results);
  if (grants) checks.push(grants);
  checks.push(toolSurfaceCheck(outcome.tools, outcome.results));
}

function challengeMetadataUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  return /resource_metadata=(?:"([^"]+)"|([^,\s]+))/
    .exec(value)
    ?.slice(1)
    .find(Boolean);
}

function pinnedRuntimeSources(sources: readonly string[]): boolean {
  return sources.some(
    (source) =>
      /(?:chumbo|supa-mcp)@\d+\.\d+\.\d+/.test(source) ||
      /["'](?:chumbo|supa-mcp)["']\s*:\s*["'](?:npm:)?(?:chumbo@|supa-mcp@)?\d+\.\d+\.\d+["']/.test(
        source,
      ),
  );
}

export async function runDoctor(
  options: DoctorOptions,
): Promise<DoctorCheck[]> {
  let supabaseRoot: string | undefined;
  try {
    supabaseRoot = await findSupabaseProject(options.cwd);
  } catch {
    supabaseRoot = undefined;
  }
  let packageRoot: string | undefined;
  try {
    packageRoot = await findPackageProject(options.cwd);
  } catch {
    packageRoot = undefined;
  }
  let root = supabaseRoot;
  let scaffold: GeneratedScaffold | undefined = supabaseRoot
    ? await detectGeneratedScaffold(supabaseRoot, options.functionName)
    : undefined;
  if (!scaffold && packageRoot && packageRoot !== supabaseRoot) {
    const detected = await detectGeneratedScaffold(
      packageRoot,
      options.functionName,
    );
    if (detected) {
      root = packageRoot;
      scaffold = detected;
    }
  }
  if (options.secondToken && !options.token) {
    throw new Error("--second-token requires --token");
  }
  if (!supabaseRoot && !scaffold && !options.url) {
    throw new Error(
      "No Chumbo scaffold was found. Run this command inside a project with a generated MCP, or pass --url to probe a deployed endpoint.",
    );
  }
  const target: SetupTarget =
    scaffold?.target ??
    options.target ??
    (supabaseRoot ? "edge-function" : "edge-function");
  const inspection = scaffold
    ? await inspectGeneratedAuthAt(scaffold.entryPath)
    : undefined;
  const configuredAuth = options.auth ?? inspection?.mode;
  let auth: SetupAuthMode | "multi" = configuredAuth ?? "oauth";
  let apiKeyStrategy =
    options.apiKeyStrategy ?? inspection?.apiKeyStrategy ?? "unknown";
  const checks: DoctorCheck[] = [];

  // A Supabase project without this Chumbo function is probing some other MCP
  // server; Chumbo's local file checks do not apply to it.
  const functionDirExists = supabaseRoot
    ? await fileExists(
        join(supabaseRoot, "supabase", "functions", options.functionName),
      )
    : false;
  const chumboLocalChecks =
    !options.deep || !options.url || Boolean(scaffold) || functionDirExists;

  if (target === "edge-function" && supabaseRoot && chumboLocalChecks) {
    const config = await readFile(
      join(supabaseRoot, "supabase", "config.toml"),
      "utf8",
    );
    const escaped = options.functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const section = new RegExp(
      `\\[functions\\.${escaped}\\][\\s\\S]*?(?=\\n\\[|$)`,
    ).exec(config)?.[0];
    const gatewayConfigured = Boolean(
      section && /verify_jwt\s*=\s*false/.test(section),
    );
    checks.push({
      name: "gateway",
      ok: gatewayConfigured,
      detail: gatewayConfigured
        ? "function handles authentication and MCP challenges"
        : section
          ? `set verify_jwt = false in [functions.${options.functionName}] so requests reach Chumbo`
          : `missing [functions.${options.functionName}] configuration`,
    });

    const functionDir = join(
      supabaseRoot,
      "supabase",
      "functions",
      options.functionName,
    );
    for (const name of [
      "index.ts",
      "capabilities.ts",
      "deno.json",
      "index_test.ts",
    ]) {
      const ok = await fileExists(join(functionDir, name));
      checks.push({
        name: `file:${name}`,
        ok,
        detail: ok ? "present" : "missing",
        ...(name === "index.ts" ? {} : { blocking: false }),
      });
    }

    const indexPath = join(functionDir, "index.ts");
    const denoPath = join(functionDir, "deno.json");
    const packagePath = join(supabaseRoot, "package.json");
    const dependencySources = await Promise.all(
      [indexPath, denoPath, packagePath].map(async (path) =>
        (await fileExists(path)) ? readFile(path, "utf8") : "",
      ),
    );
    const pinnedRuntime = pinnedRuntimeSources(dependencySources);
    checks.push({
      name: "dependencies",
      ok: pinnedRuntime,
      detail: pinnedRuntime
        ? "runtime import is pinned"
        : "pin chumbo to an exact version in index.ts, deno.json, or package.json",
    });
  } else if (scaffold && root) {
    const scaffoldDirectory =
      target === "next"
        ? dirname(dirname(scaffold.entryPath))
        : dirname(scaffold.entryPath);
    const entryName = target === "next" ? "route.ts" : "index.ts";
    checks.push({
      name: `file:${entryName}`,
      ok: true,
      detail: "present",
    });
    const capabilitiesPresent = await fileExists(
      join(scaffoldDirectory, "capabilities.ts"),
    );
    checks.push({
      name: "file:capabilities.ts",
      ok: capabilitiesPresent,
      detail: capabilitiesPresent ? "present" : "missing",
      blocking: false,
    });
    const packageSource = (await fileExists(join(root, "package.json")))
      ? await readFile(join(root, "package.json"), "utf8")
      : "";
    const pinnedRuntime = pinnedRuntimeSources([packageSource]);
    checks.push({
      name: "dependencies",
      ok: pinnedRuntime,
      detail: pinnedRuntime
        ? "runtime dependency is pinned"
        : "pin chumbo to an exact version in package.json",
    });
  }

  if (!options.url) return checks;
  if (!endpointUrl(options.url)) {
    checks.push({
      name: "endpoint-url",
      ok: false,
      detail:
        "The MCP endpoint must be a valid http or https URL. Pass --url with the local or deployed function endpoint.",
    });
    return checks;
  }
  let response: Response;
  try {
    response = await fetch(options.url, {
      method: "POST",
      headers: requestHeaders("tools/list"),
      body: modernRequest("tools/list"),
    });
  } catch {
    checks.push(
      await unreachableCheck(options.url, options.functionName, target),
    );
    return checks;
  }
  const runtimeVersion =
    response.headers.get("x-chumbo-version") ??
    response.headers.get("x-supa-mcp-version");
  const runtimeAuth =
    response.headers.get("x-chumbo-auth-mode") ??
    response.headers.get("x-supa-mcp-auth-mode");
  const runtimeStrategy =
    response.headers.get("x-chumbo-auth-strategy") ??
    response.headers.get("x-supa-mcp-auth-strategy");
  const runtimeResourceUrl =
    response.headers.get("x-chumbo-resource-url") ??
    response.headers.get("x-supa-mcp-resource-url");
  const observedAuth = [
    "oauth",
    "api-key",
    "bearer",
    "public",
    "multi",
  ].includes(runtimeAuth ?? "")
    ? (runtimeAuth as SetupAuthMode | "multi")
    : undefined;
  if (!configuredAuth && observedAuth) auth = observedAuth;
  if (
    auth === "api-key" &&
    apiKeyStrategy === "unknown" &&
    ["static", "verifier"].includes(runtimeStrategy ?? "")
  ) {
    apiKeyStrategy = runtimeStrategy as ApiKeyStrategy;
  }
  checks.push({
    name: "endpoint-reachable",
    ok: true,
    detail: `HTTP ${response.status}`,
  });
  if (response.status === 404) {
    checks.push({
      name: "function-reachable",
      ok: false,
      detail: isLocalEndpoint(options.url)
        ? `The local endpoint '${options.functionName}' returned HTTP 404. ${localServeGuidance(options.functionName, target)}, then retry doctor.`
        : `The endpoint returned HTTP 404. Check --url and deploy '${options.functionName}', then retry doctor.`,
    });
    return checks;
  }
  if (response.status >= 500 && !runtimeVersion) {
    checks.push({
      name: "function-reachable",
      ok: false,
      detail: isLocalEndpoint(options.url)
        ? `The local function returned HTTP ${response.status} before Chumbo started. Check the chumbo dev logs, fix the function startup error, and retry doctor.`
        : `The function returned HTTP ${response.status} before Chumbo started. Check the Edge Function logs and retry doctor.`,
    });
    return checks;
  }
  const chumboRuntime = Boolean(runtimeVersion);
  checks.push({
    name: "runtime-reached",
    ok: Boolean(runtimeVersion),
    detail: runtimeVersion
      ? `chumbo ${runtimeVersion}`
      : "not a Chumbo runtime; Chumbo-only checks were skipped",
    blocking: false,
  });
  if (runtimeVersion) {
    checks.push({
      name: "runtime-version",
      ok: runtimeVersion === PACKAGE_VERSION,
      detail:
        runtimeVersion === PACKAGE_VERSION
          ? `matches CLI ${PACKAGE_VERSION}`
          : `deployed ${runtimeVersion}; CLI ${PACKAGE_VERSION}`,
      blocking: false,
    });
  }
  if (observedAuth) {
    checks.push({
      name: "runtime-auth-mode",
      ok: observedAuth === auth,
      detail:
        observedAuth === auth
          ? observedAuth
          : `deployed ${observedAuth}; expected ${auth}`,
    });
  }
  if (runtimeStrategy && auth === "api-key") {
    checks.push({
      name: "runtime-auth-strategy",
      ok: apiKeyStrategy === "unknown" || runtimeStrategy === apiKeyStrategy,
      detail:
        apiKeyStrategy === "unknown" || runtimeStrategy === apiKeyStrategy
          ? runtimeStrategy
          : `deployed ${runtimeStrategy}; expected ${apiKeyStrategy}`,
    });
  }
  if (runtimeResourceUrl) {
    const requested = new URL(options.url);
    requested.hash = "";
    requested.search = "";
    requested.pathname = requested.pathname.replace(/\/+$/, "");
    checks.push({
      name: "runtime-resource-url",
      ok:
        runtimeResourceUrl.replace(/\/+$/, "") ===
        requested.href.replace(/\/+$/, ""),
      detail: runtimeResourceUrl,
      blocking: false,
    });
  }

  if (auth === "public") {
    // The rate limit is Chumbo's generated guardrail; other servers have none.
    if (!options.deep || chumboRuntime || scaffold) {
      checks.push({
        name: "public-rate-limit",
        ok: response.ok && response.headers.has("x-ratelimit-limit"),
        detail: response.headers.has("x-ratelimit-limit")
          ? `${response.headers.get("x-ratelimit-limit")} requests per window`
          : "missing rate-limit response headers; apply the generated public rate-limit migration to the local database, then retry",
      });
    }
    await analyzeProbe(
      options,
      checks,
      await mcpProbe(options, target, checks),
    );
    return checks;
  }

  if (auth === "bearer" || auth === "api-key") {
    checks.push({
      name: auth === "api-key" ? "api-key-gate" : "bearer-gate",
      ok: response.status === 401,
      detail: runtimeVersion
        ? `HTTP ${response.status} from Chumbo`
        : `HTTP ${response.status}; responding layer is unconfirmed`,
    });
    if (!options.token) return checks;
    await analyzeProbe(
      options,
      checks,
      await mcpProbe(options, target, checks, options.token),
      options.token,
    );
    return checks;
  }

  if (auth === "multi" && chumboRuntime) {
    checks.push({
      name: "multi-auth-gate",
      ok: response.status === 401,
      detail: runtimeVersion
        ? `HTTP ${response.status} from Chumbo`
        : `HTTP ${response.status}; responding layer is unconfirmed`,
    });
  }

  const metadataUrl = challengeMetadataUrl(
    response.headers.get("www-authenticate"),
  );
  const otherServer = Boolean(options.deep) && !chumboRuntime;
  const unprotected = otherServer && response.status < 400 && !metadataUrl;
  if (unprotected) {
    checks.push({
      name: "oauth-challenge",
      ok: false,
      detail: `HTTP ${response.status}; the endpoint did not ask for sign-in, so OAuth discovery was skipped. If this MCP should be protected, require authentication on it and retry.`,
      blocking: false,
    });
  } else {
    // A server that is not Chumbo may omit resource_metadata; clients then
    // use the well-known location, so a plain 401 still passes.
    const challenged =
      response.status === 401 && (Boolean(metadataUrl) || otherServer);
    checks.push({
      name: "oauth-challenge",
      ok: challenged,
      detail: `HTTP ${response.status}${
        metadataUrl
          ? ` -> ${metadataUrl}`
          : challenged
            ? "; the challenge names no resource_metadata, so doctor looked at the well-known locations"
            : ""
      }`,
    });
    if (metadataUrl || (options.deep && response.status === 401)) {
      const endpoint = new URL(options.url);
      const discovery = await discoverProtectedResource(endpoint, metadataUrl);
      checks.push(...protectedResourceChecks(endpoint, discovery));
      if (options.deep && discovery.metadata) {
        checks.push(...(await authorizationServerChecks(discovery.metadata)));
      }
    }
  }

  if (options.token) {
    await analyzeProbe(
      options,
      checks,
      await mcpProbe(options, target, checks, options.token),
      options.token,
    );
  }
  return checks;
}
