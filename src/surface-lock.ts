import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { timedFetch } from "./doctor-http.js";
import { compareCanonicalText } from "./internal/surface-canonical.js";
import {
  resolveLocalPersonas,
  type LocalPersonaDeps,
} from "./local-personas.js";
import {
  findPackageProject,
  findSupabaseProject,
  PACKAGE_VERSION,
  type SetupTarget,
} from "./project.js";
import { detectGeneratedScaffold, inspectGeneratedAuthAt } from "./setup.js";
import {
  buildLockedSurfaceEntry,
  diffSurfaceSnapshots,
  SURFACE_DIFF_DEFAULTS,
  surfaceLockKey,
  type DiffSurfaceOptions,
  type LockedSurfaceEntry,
  type McpSurfaceLockfileV1,
  type SurfaceAuthMode,
  type SurfaceDiffCategory,
  type SurfaceDiffReport,
  type SurfaceSnapshotReport,
} from "./surface-diff.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_SURFACE_LOCKFILE = "mcp-surface.lock.json";
const STATIC_DENO_TIMEOUT_MS = 8_000;

export interface InspectSurfaceOptions {
  readonly cwd?: string;
  readonly functionName?: string;
  readonly target?: SetupTarget;
  readonly url?: string;
  readonly token?: string;
  readonly as?: string;
  readonly profile?: string;
  readonly allProfiles?: boolean;
  readonly scopes?: readonly string[];
  readonly envFile?: string;
  readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly personaDeps?: LocalPersonaDeps;
  readonly staticInspector?: (options: {
    projectRoot: string;
    functionName: string;
    target: SetupTarget;
    scopes?: readonly string[];
    profile?: string;
  }) => Promise<readonly LockedSurfaceEntry[]>;
}

export interface SurfaceSnapshotCommandOptions extends InspectSurfaceOptions {
  readonly lockfile?: string;
  readonly plan?: boolean;
  readonly yes?: boolean;
  readonly json?: boolean;
  readonly isTTY?: boolean;
  readonly confirmWrite?: (question: string) => Promise<boolean>;
}

export interface SurfaceDiffCommandOptions extends InspectSurfaceOptions {
  readonly lockfile?: string;
  readonly failOn?: readonly SurfaceDiffCategory[];
  readonly frozen?: boolean;
  readonly maxTokenDelta?: number;
  readonly maxCatalogTokens?: number;
  /** Accepted cleanly as a read-only no-op. */
  readonly plan?: boolean;
  readonly json?: boolean;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveProjectRootForSurface(
  cwd: string,
): Promise<string> {
  try {
    return await findSupabaseProject(cwd);
  } catch {
    try {
      return await findPackageProject(cwd);
    } catch {
      return resolve(cwd);
    }
  }
}

export function resolveLockfilePath(
  projectRoot: string,
  override?: string,
): string {
  if (!override) return join(projectRoot, DEFAULT_SURFACE_LOCKFILE);
  return isAbsolute(override) ? override : resolve(projectRoot, override);
}

export function serializeSurfaceLockfile(
  lockfile: McpSurfaceLockfileV1,
): string {
  const orderedSurfaces: Record<string, LockedSurfaceEntry> = {};
  for (const key of Object.keys(lockfile.surfaces).sort(compareCanonicalText)) {
    orderedSurfaces[key] = lockfile.surfaces[key]!;
  }
  return `${JSON.stringify(
    {
      lockfileVersion: 1,
      surfaces: orderedSurfaces,
    },
    null,
    2,
  )}\n`;
}

export async function readSurfaceLockfile(
  lockfilePath: string,
): Promise<McpSurfaceLockfileV1> {
  let raw: string;
  try {
    raw = await readFile(lockfilePath, "utf8");
  } catch {
    throw new Error(
      `Surface lockfile '${lockfilePath}' was not found. Run \`npx chumbo surface snapshot --yes\` first.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Surface lockfile '${lockfilePath}' is not valid JSON.`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as { lockfileVersion?: unknown }).lockfileVersion !== 1 ||
    typeof (parsed as { surfaces?: unknown }).surfaces !== "object" ||
    (parsed as { surfaces?: unknown }).surfaces === null ||
    Array.isArray((parsed as { surfaces?: unknown }).surfaces)
  ) {
    throw new Error(
      `Surface lockfile '${lockfilePath}' does not match lockfileVersion 1.`,
    );
  }
  return parsed as McpSurfaceLockfileV1;
}

export async function writeSurfaceLockfile(
  lockfilePath: string,
  lockfile: McpSurfaceLockfileV1,
): Promise<void> {
  await mkdir(dirname(lockfilePath), { recursive: true });
  await writeFile(lockfilePath, serializeSurfaceLockfile(lockfile), "utf8");
}

/**
 * Hermetic offline Edge Function surface inspection via `deno eval --allow-env`
 * (zero `--allow-net`, zero GoTrue or Postgres calls, zero network telemetry).
 */
export async function inspectLocalSurfaceStatic(options: {
  projectRoot: string;
  functionName: string;
  target: SetupTarget;
  scopes?: readonly string[];
  profile?: string;
  timeoutMs?: number;
}): Promise<LockedSurfaceEntry | null> {
  if (options.target !== "edge-function") return null;
  const functionDir = join(
    options.projectRoot,
    "supabase",
    "functions",
    options.functionName,
  );
  const indexPath = join(functionDir, "index.ts");
  if (!(await fileExists(indexPath))) return null;

  const authInfo = await inspectGeneratedAuthAt(indexPath);
  const authMode: SurfaceAuthMode = authInfo?.mode ?? "oauth";
  const scopesList = options.scopes ?? [];

  const evalScript = `
    const enc = new TextEncoder();
    const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"");
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
    pub.kid = "chumbo-static-1";
    pub.alg = "ES256";
    Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321");
    Deno.env.set("SUPABASE_PUBLISHABLE_KEY", Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "chumbo-surface-stub-key");
    Deno.env.set("SUPABASE_ANON_KEY", Deno.env.get("SUPABASE_ANON_KEY") ?? "chumbo-surface-stub-key");
    Deno.env.set("SUPABASE_JWKS", JSON.stringify({ keys: [pub] }));
    Deno.env.set("MCP_API_KEY", Deno.env.get("MCP_API_KEY") ?? "chumbo-surface-stub-api-key");
    Deno.env.set("CHUMBO_STATE_HMAC_KEY", Deno.env.get("CHUMBO_STATE_HMAC_KEY") ?? "0123456789abcdef0123456789abcdef");
    const mod = await import("./index.ts");
    const app = mod.default ?? mod.app;
    if (!app || typeof app.fetch !== "function") {
      throw new Error("Entry module does not export a Chumbo app with fetch()");
    }
    const now = Math.floor(Date.now() / 1000);
    const hdr = b64u(enc.encode(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "chumbo-static-1" })));
    const pld = b64u(enc.encode(JSON.stringify({
      iss: "http://127.0.0.1:54321/auth/v1",
      sub: "00000000-0000-4000-8000-000000000000",
      aud: "authenticated",
      role: "authenticated",
      email: "surface-inspector@chumbo.local",
      scope: ${JSON.stringify(scopesList.join(" "))},
      iat: now,
      exp: now + 300,
    })));
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, enc.encode(hdr + "." + pld));
    const jwt = hdr + "." + pld + "." + b64u(sig);
    const token = ${JSON.stringify(authMode)} === "api-key" ? Deno.env.get("MCP_API_KEY") : ${JSON.stringify(authMode)} === "public" ? undefined : jwt;
    const headers = {
      "accept": "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-method": "tools/list",
      "mcp-protocol-version": "2026-07-28",
      ...(token ? { "authorization": "Bearer " + token } : {}),
    };
    const res = await app.fetch(new Request("http://127.0.0.1:54321/functions/v1/${options.functionName}", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "surface-inspect",
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "chumbo-surface", version: ${JSON.stringify(PACKAGE_VERSION)} },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }));
    const text = await res.text();
    const dataLine = res.headers.get("content-type")?.includes("text/event-stream")
      ? text.split(/\\r?\\n/).find((l) => l.startsWith("data: "))?.slice(6) ?? ""
      : text;
    const parsed = JSON.parse(dataLine);
    console.log(JSON.stringify({
      status: res.status,
      authMode: res.headers.get("x-chumbo-auth-mode") ?? ${JSON.stringify(authMode)},
      tools: parsed?.result?.tools ?? [],
    }));
  `;

  try {
    const denoConfigPath = join(functionDir, "deno.json");
    const args = ["eval", "--allow-env"];
    if (await fileExists(denoConfigPath)) {
      args.push("--config", denoConfigPath);
    }
    args.push(evalScript);
    const { stdout } = await execFileAsync("deno", args, {
      cwd: functionDir,
      encoding: "utf8",
      timeout: options.timeoutMs ?? STATIC_DENO_TIMEOUT_MS,
    });
    const lastLine = stdout.trim().split(/\r?\n/).at(-1) ?? "";
    const inspected = JSON.parse(lastLine) as {
      status?: number;
      authMode?: string;
      tools?: unknown[];
    };
    if (inspected.status !== 200 || !Array.isArray(inspected.tools)) {
      return null;
    }
    const resolvedAuth = (
      ["oauth", "bearer", "api-key", "public", "multi"].includes(
        inspected.authMode ?? "",
      )
        ? inspected.authMode
        : authMode
    ) as SurfaceAuthMode;
    return await buildLockedSurfaceEntry({
      functionName: options.functionName,
      profile: options.profile ?? "default",
      serverName: options.functionName,
      authMode: resolvedAuth,
      tools: inspected.tools,
    });
  } catch {
    return null;
  }
}

async function probeLiveSurface(
  url: string,
  functionName: string,
  profile: string,
  token: string | undefined,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<LockedSurfaceEntry> {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-method": "tools/list",
    "mcp-protocol-version": "2026-07-28",
  });
  if (token) headers.set("authorization", `Bearer ${token}`);

  const response = await fetchFn(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "chumbo-surface",
            version: PACKAGE_VERSION,
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `tools/list at '${url}' returned HTTP ${response.status}. Supply --token or --as for protected endpoints.`,
    );
  }
  const text = await response.text();
  const payloadText = response.headers
    .get("content-type")
    ?.includes("text/event-stream")
    ? (text
        .split(/\r?\n/)
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length) ?? "")
    : text;
  const body = JSON.parse(payloadText) as {
    result?: { tools?: unknown[] };
    error?: { message?: string };
  };
  if (body.error || !Array.isArray(body.result?.tools)) {
    throw new Error(
      `tools/list at '${url}' failed: ${body.error?.message ?? "missing tools array"}`,
    );
  }
  const observedMode =
    response.headers.get("x-chumbo-auth-mode") ??
    response.headers.get("x-supa-mcp-auth-mode");
  const authMode: SurfaceAuthMode = [
    "oauth",
    "bearer",
    "api-key",
    "public",
    "multi",
  ].includes(observedMode ?? "")
    ? (observedMode as SurfaceAuthMode)
    : token
      ? "oauth"
      : "public";

  return await buildLockedSurfaceEntry({
    functionName,
    profile,
    serverName: functionName,
    authMode,
    tools: body.result.tools,
  });
}

export async function inspectSurfaceEntries(
  options: InspectSurfaceOptions,
): Promise<Readonly<Record<string, LockedSurfaceEntry>>> {
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = await resolveProjectRootForSurface(cwd);
  const functionName = options.functionName ?? "mcp";
  const profile = options.profile ?? "default";

  if (options.staticInspector) {
    const entries = await options.staticInspector({
      projectRoot,
      functionName,
      target: options.target ?? "edge-function",
      scopes: options.scopes,
      profile: options.profile,
    });
    const map: Record<string, LockedSurfaceEntry> = {};
    for (const entry of entries) {
      map[surfaceLockKey(entry.functionName, entry.profile)] = entry;
    }
    return map;
  }

  if (options.url) {
    let token = options.token;
    let cleanup = async () => {};
    if (!token && options.as) {
      const resolved = await resolveLocalPersonas({
        projectRoot,
        endpointUrl: options.url,
        specifiers: [options.as],
        envFile: options.envFile,
        scopes: options.scopes,
        deps: options.personaDeps,
      });
      token = resolved[0]?.getToken();
      cleanup = async () => {
        await Promise.allSettled(resolved.map((p) => p.cleanup()));
      };
    }
    try {
      const entry = await probeLiveSurface(
        options.url,
        functionName,
        profile,
        token,
        options.fetchImpl ?? timedFetch,
      );
      return { [surfaceLockKey(entry.functionName, entry.profile)]: entry };
    } finally {
      await cleanup();
    }
  }

  const scaffold = await detectGeneratedScaffold(projectRoot, functionName);
  const target = options.target ?? scaffold?.target ?? "edge-function";
  const entry = await inspectLocalSurfaceStatic({
    projectRoot,
    functionName,
    target,
    scopes: options.scopes,
    profile,
  });
  if (!entry) {
    throw new Error(
      `Could not statically inspect '${functionName}'. Start your server and pass --url <endpoint>, or verify deno is installed for Edge Functions.`,
    );
  }
  return { [surfaceLockKey(entry.functionName, entry.profile)]: entry };
}

export async function runSurfaceSnapshot(
  options: SurfaceSnapshotCommandOptions,
): Promise<{
  readonly report: SurfaceSnapshotReport;
  readonly exitCode: 0 | 1;
}> {
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = await resolveProjectRootForSurface(cwd);
  const lockfilePath = resolveLockfilePath(projectRoot, options.lockfile);
  const relativeLockPath = relative(projectRoot, lockfilePath) || lockfilePath;

  const discovered = await inspectSurfaceEntries(options);
  let existing: McpSurfaceLockfileV1 | null = null;
  if (await fileExists(lockfilePath)) {
    existing = await readSurfaceLockfile(lockfilePath);
  }

  const mergedSurfaces: Record<string, LockedSurfaceEntry> = {
    ...(existing?.surfaces ?? {}),
    ...discovered,
  };
  const nextLockfile: McpSurfaceLockfileV1 = {
    lockfileVersion: 1,
    surfaces: mergedSurfaces,
  };
  const nextSerialized = serializeSurfaceLockfile(nextLockfile);
  const currentSerialized = existing
    ? serializeSurfaceLockfile(existing)
    : null;
  const changed = nextSerialized !== currentSerialized;

  const surfaceSummaries = Object.keys(mergedSurfaces)
    .sort(compareCanonicalText)
    .map((key) => {
      const entry = mergedSurfaces[key]!;
      const prev = existing?.surfaces[key];
      return {
        key,
        contentDigest: entry.contentDigest,
        toolCount: entry.tools.length,
        totalPromptTokens: entry.contextBudget.totalPromptTokens,
        changed:
          !prev ||
          prev.contentDigest !== entry.contentDigest ||
          JSON.stringify(prev.toolAuthority) !==
            JSON.stringify(entry.toolAuthority),
      };
    });

  if (!changed) {
    return {
      exitCode: 0,
      report: Object.freeze({
        schemaVersion: 1,
        command: "surface snapshot",
        status: "unchanged",
        lockfilePath: relativeLockPath,
        surfaces: surfaceSummaries,
      }),
    };
  }

  if (options.plan) {
    return {
      exitCode: 0,
      report: Object.freeze({
        schemaVersion: 1,
        command: "surface snapshot",
        status: "planned",
        lockfilePath: relativeLockPath,
        surfaces: surfaceSummaries,
        nextCommand: `npx chumbo surface snapshot --yes${options.json ? " --json" : ""}`,
      }),
    };
  }

  if (!options.yes) {
    if (options.json) {
      return {
        exitCode: 0,
        report: Object.freeze({
          schemaVersion: 1,
          command: "surface snapshot",
          status: "needs_confirmation",
          lockfilePath: relativeLockPath,
          surfaces: surfaceSummaries,
          nextCommand: "npx chumbo surface snapshot --yes --json",
        }),
      };
    }
    if (options.isTTY && options.confirmWrite) {
      const approved = await options.confirmWrite(
        `Write ${relativeLockPath} (${surfaceSummaries.length} surface(s))?`,
      );
      if (!approved) {
        throw new Error(
          "No files changed. Re-run with --yes for non-interactive use.",
        );
      }
    } else {
      throw new Error(
        "No files changed. Re-run with --yes for non-interactive use.",
      );
    }
  }

  await writeSurfaceLockfile(lockfilePath, nextLockfile);
  return {
    exitCode: 0,
    report: Object.freeze({
      schemaVersion: 1,
      command: "surface snapshot",
      status: "complete",
      lockfilePath: relativeLockPath,
      surfaces: surfaceSummaries,
    }),
  };
}

export async function runSurfaceDiff(
  options: SurfaceDiffCommandOptions,
): Promise<SurfaceDiffReport> {
  const cwd = options.cwd ?? process.cwd();
  const projectRoot = await resolveProjectRootForSurface(cwd);
  const lockfilePath = resolveLockfilePath(projectRoot, options.lockfile);
  const relativeLockPath = relative(projectRoot, lockfilePath) || lockfilePath;

  const baseline = await readSurfaceLockfile(lockfilePath);
  const candidateSurfaces = await inspectSurfaceEntries(options);

  const diffOptions: DiffSurfaceOptions = {
    lockfilePath: relativeLockPath,
    failOn: options.failOn ?? SURFACE_DIFF_DEFAULTS.failOn,
    frozen: options.frozen,
    maxTokenDelta: options.maxTokenDelta,
    maxCatalogTokens: options.maxCatalogTokens,
  };

  // When diffing a single named profile, scope baseline to that key.
  const scopedBaseline: McpSurfaceLockfileV1 =
    options.profile && !options.allProfiles
      ? {
          lockfileVersion: 1,
          surfaces: Object.fromEntries(
            Object.entries(baseline.surfaces).filter(([key]) =>
              Object.prototype.hasOwnProperty.call(candidateSurfaces, key),
            ),
          ),
        }
      : baseline;

  return diffSurfaceSnapshots(
    scopedBaseline,
    { lockfileVersion: 1, surfaces: candidateSurfaces },
    diffOptions,
  );
}

export function formatSurfaceDiffReport(report: SurfaceDiffReport): string {
  const lines: string[] = [
    `Lockfile: ${report.lockfilePath}`,
    `Status:   ${report.status} (breaking: ${report.summary.breaking}, authority-widening: ${report.summary.authorityWidening}, context-regression: ${report.summary.contextRegression}, additive: ${report.summary.additive}, token delta: ${report.summary.promptTokenDelta >= 0 ? "+" : ""}${report.summary.promptTokenDelta})`,
  ];
  for (const surface of report.surfaces) {
    lines.push(
      "",
      `Surface '${surface.key}': ${surface.baselinePromptTokens} -> ${surface.candidatePromptTokens} prompt tokens`,
    );
    if (surface.findings.length === 0) {
      lines.push("  ✓ No changes.");
      continue;
    }
    for (const finding of surface.findings) {
      const marker =
        finding.category === "additive"
          ? "+"
          : finding.category === "context-regression"
            ? "!"
            : "✗";
      lines.push(
        `  ${marker} [${finding.category}] ${finding.code}: ${finding.detail}`,
      );
    }
  }
  if (report.nextCommand) {
    lines.push("", `Next: ${report.nextCommand}`);
  }
  return lines.join("\n");
}
