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

function modernRequest(method: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method,
    params: {
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
  const headers = new Headers({
    "content-type": "application/json",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": "tools/list",
  });
  const response = await fetch(options.url, {
    method: "POST",
    headers,
    body: modernRequest("tools/list"),
  });
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
    const body = (await response.json().catch(() => null)) as {
      result?: { tools?: unknown[] };
    } | null;
    checks.push({
      name: "public-tools-list",
      ok: response.ok && Array.isArray(body?.result?.tools),
      detail: `HTTP ${response.status}`,
    });
    checks.push({
      name: "public-rate-limit",
      ok: response.ok && response.headers.has("x-ratelimit-limit"),
      detail: response.headers.has("x-ratelimit-limit")
        ? `${response.headers.get("x-ratelimit-limit")} requests per window`
        : "missing rate-limit response headers",
    });
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

    const authenticatedHeaders = new Headers(headers);
    authenticatedHeaders.set("authorization", `Bearer ${options.token}`);
    const authenticatedResponse = await fetch(options.url, {
      method: "POST",
      headers: authenticatedHeaders,
      body: modernRequest("tools/list"),
    });
    const body = (await authenticatedResponse.json().catch(() => null)) as {
      result?: { tools?: unknown[] };
    } | null;
    checks.push({
      name: "authenticated-tools-list",
      ok: authenticatedResponse.ok && Array.isArray(body?.result?.tools),
      detail: `HTTP ${authenticatedResponse.status}`,
    });
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
    if (options.token) {
      const authenticatedHeaders = new Headers(headers);
      authenticatedHeaders.set("authorization", `Bearer ${options.token}`);
      const authenticatedResponse = await fetch(options.url, {
        method: "POST",
        headers: authenticatedHeaders,
        body: modernRequest("tools/list"),
      });
      const body = (await authenticatedResponse.json().catch(() => null)) as {
        result?: { tools?: unknown[] };
      } | null;
      checks.push({
        name: "authenticated-tools-list",
        ok: authenticatedResponse.ok && Array.isArray(body?.result?.tools),
        detail: `HTTP ${authenticatedResponse.status}`,
      });
    }
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
    const authenticatedHeaders = new Headers(headers);
    authenticatedHeaders.set("authorization", `Bearer ${options.token}`);
    const authenticatedResponse = await fetch(options.url, {
      method: "POST",
      headers: authenticatedHeaders,
      body: modernRequest("tools/list"),
    });
    const body = (await authenticatedResponse.json().catch(() => null)) as {
      result?: { tools?: unknown[] };
      error?: unknown;
    } | null;
    checks.push({
      name: "authenticated-tools-list",
      ok: authenticatedResponse.ok && Array.isArray(body?.result?.tools),
      detail: `HTTP ${authenticatedResponse.status}`,
    });
  }
  return checks;
}
