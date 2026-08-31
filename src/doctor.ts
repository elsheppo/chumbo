import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { findSupabaseProject, PACKAGE_VERSION } from "./project.js";
import {
  inspectGeneratedAuth,
  type ApiKeyStrategy,
  type SetupAuthMode,
} from "./setup.js";

export interface DoctorOptions {
  cwd: string;
  functionName: string;
  url?: string;
  token?: string;
  auth?: SetupAuthMode;
  apiKeyStrategy?: ApiKeyStrategy;
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

async function unreachableCheck(
  url: string,
  functionName: string,
): Promise<DoctorCheck> {
  if (!isLocalEndpoint(url)) {
    return {
      name: "endpoint-reachable",
      ok: false,
      detail:
        "The endpoint did not respond. Check the URL and deployment, then retry doctor.",
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

async function mcpProbe(
  options: DoctorOptions,
  checks: DoctorCheck[],
  token?: string,
): Promise<void> {
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
    checks.push(await unreachableCheck(options.url!, options.functionName));
    return;
  }
  const initializeBody = await responseBody(initializeResponse);
  if (initializeResponse.status === 401 || initializeResponse.status === 403) {
    checks.push({
      name: "credential-accepted",
      ok: false,
      detail: `HTTP ${initializeResponse.status}; the supplied credential was rejected. Check the credential and auth mode, then retry without placing the credential in the URL.`,
    });
    return;
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
  if (!initialized) return;

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
    return;
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
  if (!discovered || !options.callTool) return;

  if (!tools?.some((tool) => tool.name === options.callTool)) {
    checks.push({
      name: "tool-call",
      ok: false,
      detail: `Tool '${options.callTool}' was not discovered. Run doctor without --call-tool to verify discovery, then choose an advertised tool.`,
    });
    return;
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
    return;
  }
  const callBody = await responseBody(callResponse);
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
}

function challengeMetadataUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  return /resource_metadata=(?:"([^"]+)"|([^,\s]+))/
    .exec(value)
    ?.slice(1)
    .find(Boolean);
}

export async function runDoctor(
  options: DoctorOptions,
): Promise<DoctorCheck[]> {
  const root = await findSupabaseProject(options.cwd);
  const inspection = await inspectGeneratedAuth(root, options.functionName);
  const configuredAuth = options.auth ?? inspection?.mode;
  let auth: SetupAuthMode | "multi" = configuredAuth ?? "oauth";
  let apiKeyStrategy =
    options.apiKeyStrategy ?? inspection?.apiKeyStrategy ?? "unknown";
  const checks: DoctorCheck[] = [];
  const config = await readFile(join(root, "supabase", "config.toml"), "utf8");
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

  const functionDir = join(root, "supabase", "functions", options.functionName);
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
  const packagePath = join(root, "package.json");
  const dependencySources = await Promise.all(
    [indexPath, denoPath, packagePath].map(async (path) =>
      (await fileExists(path)) ? readFile(path, "utf8") : "",
    ),
  );
  const pinnedRuntime = dependencySources.some(
    (source) =>
      /(?:chumbo|supa-mcp)@\d+\.\d+\.\d+/.test(source) ||
      /["'](?:chumbo|supa-mcp)["']\s*:\s*["'](?:npm:)?(?:chumbo@|supa-mcp@)?\d+\.\d+\.\d+["']/.test(
        source,
      ),
  );
  checks.push({
    name: "dependencies",
    ok: pinnedRuntime,
    detail: pinnedRuntime
      ? "runtime import is pinned"
      : "pin chumbo to an exact version in index.ts, deno.json, or package.json",
  });

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
    checks.push(await unreachableCheck(options.url, options.functionName));
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
        ? `The local function '${options.functionName}' returned HTTP 404. Run npx chumbo dev --function ${options.functionName}, then retry doctor.`
        : `The function returned HTTP 404. Check --url and deploy '${options.functionName}', then retry doctor.`,
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
  checks.push({
    name: "runtime-reached",
    ok: Boolean(runtimeVersion),
    detail: runtimeVersion
      ? `chumbo ${runtimeVersion}`
      : "response did not identify the Chumbo runtime",
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
    checks.push({
      name: "public-rate-limit",
      ok: response.ok && response.headers.has("x-ratelimit-limit"),
      detail: response.headers.has("x-ratelimit-limit")
        ? `${response.headers.get("x-ratelimit-limit")} requests per window`
        : "missing rate-limit response headers; apply the generated public rate-limit migration to the local database, then retry",
    });
    await mcpProbe(options, checks);
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
    await mcpProbe(options, checks, options.token);
    return checks;
  }

  if (auth === "multi") {
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
  checks.push({
    name: "oauth-challenge",
    ok: response.status === 401 && Boolean(metadataUrl),
    detail: `HTTP ${response.status}${metadataUrl ? ` -> ${metadataUrl}` : ""}`,
  });
  if (metadataUrl) {
    const metadataResponse = await fetch(metadataUrl, {
      headers: { accept: "application/json" },
    });
    const metadata = (await metadataResponse.json().catch(() => null)) as {
      resource?: string;
      authorization_servers?: string[];
    } | null;
    checks.push({
      name: "protected-resource-metadata",
      ok:
        metadataResponse.ok &&
        typeof metadata?.resource === "string" &&
        Array.isArray(metadata.authorization_servers),
      detail: `HTTP ${metadataResponse.status}`,
    });
    const expectedResource = new URL(options.url);
    expectedResource.hash = "";
    expectedResource.search = "";
    expectedResource.pathname = expectedResource.pathname.replace(/\/+$/, "");
    checks.push({
      name: "advertised-resource-url",
      ok:
        metadataResponse.ok &&
        typeof metadata?.resource === "string" &&
        metadata.resource.replace(/\/+$/, "") ===
          expectedResource.href.replace(/\/+$/, ""),
      detail:
        typeof metadata?.resource === "string"
          ? metadata.resource
          : "protected-resource metadata did not advertise a resource URL",
    });
  }

  if (options.token) {
    await mcpProbe(options, checks, options.token);
  }
  return checks;
}
