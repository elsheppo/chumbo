import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { findSupabaseProject } from "./project.js";
import { detectGeneratedAuth, type SetupAuthMode } from "./setup.js";

export interface DoctorOptions {
  cwd: string;
  functionName: string;
  url?: string;
  token?: string;
  auth?: SetupAuthMode;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
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
          name: "create-supabase-mcp-doctor",
          version: "0.3.0",
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
  const auth =
    options.auth ??
    (await detectGeneratedAuth(root, options.functionName)) ??
    "oauth";
  const checks: DoctorCheck[] = [];
  const config = await readFile(join(root, "supabase", "config.toml"), "utf8");
  const escaped = options.functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const section = new RegExp(
    `\\[functions\\.${escaped}\\][\\s\\S]*?(?=\\n\\[|$)`,
  ).exec(config)?.[0];
  checks.push({
    name: "gateway",
    ok: Boolean(section && /verify_jwt\s*=\s*false/.test(section)),
    detail: section
      ? "function handles JWT verification and OAuth challenges"
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
    });
  }

  const denoPath = join(functionDir, "deno.json");
  if (await fileExists(denoPath)) {
    const deno = await readFile(denoPath, "utf8");
    checks.push({
      name: "dependencies",
      ok: /create-supabase-mcp@\d+\.\d+\.\d+/.test(deno),
      detail: "generated runtime import is pinned",
    });
  }

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

  if (auth === "bearer") {
    checks.push({
      name: "bearer-gate",
      ok: response.status === 401,
      detail: `HTTP ${response.status}`,
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
