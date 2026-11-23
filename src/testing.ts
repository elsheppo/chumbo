import type {
  CallToolResult,
  GetPromptResult,
  Implementation,
  InitializeResult,
  ListPromptsResult,
  ListResourcesResult,
  ReadResourceResult,
} from "@modelcontextprotocol/server";
import type { SupabaseEnv } from "@supabase/server";
import { DEFAULT_PLAIN_WORD_TOOLS } from "./guidance.js";
import {
  JSON_SCHEMA_INSTANCE_DATA_KEYWORDS,
  JSON_SCHEMA_MAP_KEYWORDS,
} from "./internal/open-output-schema.js";
import { computeCanonicalSurfaceDigest } from "./internal/surface-canonical.js";
import type { JsonValue } from "./results.js";
import { createSupabaseMcpInternal as createSupabaseMcpForTesting } from "./runtime.js";
import {
  diffSurfaceSnapshots,
  SURFACE_DIFF_DEFAULTS,
  type LockedSurfaceContextBudget,
  type LockedSurfaceEntry,
  type LockedToolAuthorityMeta,
  type McpSurfaceLockfileV1,
  type SurfaceAuthMode,
  type SurfaceDiffCategory,
  type SurfaceDiffFinding,
  type SurfaceDiffReport,
  type SurfaceDiffRuleCode,
} from "./surface-diff.js";
import {
  estimateCatalogTokens,
  estimateResultTokens,
  estimateTextTokens,
  estimateToolTokens,
  SURFACE_TOKEN_LIMITS,
  TOKEN_ESTIMATOR_ID,
  type CatalogTokenReport,
  type EstimateCatalogTokensOptions,
  type ResultTokenEstimate,
  type SurfaceToolInput,
  type ToolTokenBreakdown,
} from "./surface-tokens.js";
import { jsonRpcPayloadFromResponseText } from "./transport.js";
import type {
  RuntimeDependencies,
  SupabaseMcpApp,
  SupabaseMcpSurfaceTool,
  VerifiedSupabaseIdentity,
} from "./types.js";

export {
  createSupabaseMcpForTesting,
  diffSurfaceSnapshots,
  estimateCatalogTokens,
  estimateResultTokens,
  estimateTextTokens,
  estimateToolTokens,
  SURFACE_DIFF_DEFAULTS,
  SURFACE_TOKEN_LIMITS,
  TOKEN_ESTIMATOR_ID,
};
export type {
  CatalogTokenReport,
  EstimateCatalogTokensOptions,
  LockedSurfaceContextBudget,
  LockedSurfaceEntry,
  LockedToolAuthorityMeta,
  McpSurfaceLockfileV1,
  ResultTokenEstimate,
  RuntimeDependencies,
  SurfaceAuthMode,
  SurfaceDiffCategory,
  SurfaceDiffFinding,
  SurfaceDiffReport,
  SurfaceDiffRuleCode,
  SurfaceToolInput,
  ToolTokenBreakdown,
  VerifiedSupabaseIdentity,
};

const utf8Encoder = new TextEncoder();
const DEFAULT_PROTOCOL_VERSION = "2026-07-28";
const DEFAULT_CLIENT_INFO: Implementation = Object.freeze({
  name: "chumbo-test-client",
  version: "1.0.0",
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncodeBytes(utf8Encoder.encode(JSON.stringify(value)));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 32);
  const end = Math.min(text.length, index + length + 32);
  const slice = text.slice(start, end).replace(/\s+/gu, " ").trim();
  return `${start > 0 ? "..." : ""}${slice}${end < text.length ? "..." : ""}`;
}

export type McpTestableTarget =
  | Pick<SupabaseMcpApp, "fetch">
  | ((request: Request) => Response | Promise<Response>);

export interface TestUserPersona {
  readonly id: string;
  readonly email?: string;
  /** Supply a real Supabase session access_token for live RLS tests, or omit when using `authHarness`. */
  readonly token?: string;
  readonly role?: string;
  readonly scopes?: readonly string[];
  readonly clientId?: string;
  readonly appMetadata?: Readonly<Record<string, JsonValue>>;
  readonly userMetadata?: Readonly<Record<string, JsonValue>>;
  readonly expiresInSeconds?: number;
}

export interface TestAuthHarness {
  readonly issuer: string;
  readonly resourceUrl: string;
  readonly jwks: {
    readonly keys: readonly (JsonWebKey & { readonly kid?: string })[];
  };
  /** Ready-to-pass `Partial<SupabaseEnv>` for `createSupabaseMcp({ supabase: { env } })` or `SUPABASE_JWKS`. */
  readonly supabaseEnv: Partial<SupabaseEnv>;
  mintUserToken(persona: TestUserPersona): Promise<string>;
}

/**
 * Generate an ephemeral in-memory WebCrypto ES256 JWKS harness for testing
 * authenticated MCP apps through real JWT signature verification without
 * auth backdoors or `node:crypto` dependencies.
 */
export async function createTestAuthHarness(options?: {
  readonly supabaseUrl?: string;
  readonly resourceUrl?: string;
  readonly kid?: string;
}): Promise<TestAuthHarness> {
  const supabaseUrl = (options?.supabaseUrl ?? "https://example.test").replace(
    /\/+$/u,
    "",
  );
  const issuer = `${supabaseUrl}/auth/v1`;
  const resourceUrl = options?.resourceUrl ?? `${supabaseUrl}/functions/v1/mcp`;
  const kid = options?.kid?.trim() || "chumbo-test-es256-1";

  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const exported = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  if (
    exported.kty !== "EC" ||
    exported.crv !== "P-256" ||
    typeof exported.x !== "string" ||
    typeof exported.y !== "string"
  ) {
    throw new Error("WebCrypto did not export an EC P-256 public JWK");
  }

  const publicJwk: JsonWebKey = Object.freeze({
    kty: "EC",
    crv: "P-256",
    x: exported.x,
    y: exported.y,
    use: "sig",
    alg: "ES256",
    kid,
  });
  const jwks = Object.freeze({ keys: Object.freeze([publicJwk]) });
  const supabaseEnv: Partial<SupabaseEnv> = Object.freeze({
    url: supabaseUrl,
    publishableKeys: Object.freeze({ default: "sb_publishable_chumbo_test" }),
    jwks: jwks as NonNullable<SupabaseEnv["jwks"]>,
  });

  async function mintUserToken(persona: TestUserPersona): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const ttl = persona.expiresInSeconds ?? 3600;
    const header = { alg: "ES256", typ: "JWT", kid };
    const payload: Record<string, unknown> = {
      sub: persona.id,
      aud: "authenticated",
      iss: issuer,
      iat: now,
      exp: now + ttl,
      role: persona.role ?? "authenticated",
      ...(persona.email ? { email: persona.email } : {}),
      ...(persona.scopes && persona.scopes.length > 0
        ? { scope: persona.scopes.join(" ") }
        : {}),
      ...(persona.clientId ? { client_id: persona.clientId } : {}),
      ...(persona.appMetadata ? { app_metadata: persona.appMetadata } : {}),
      ...(persona.userMetadata ? { user_metadata: persona.userMetadata } : {}),
    };
    const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(payload)}`;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.privateKey,
      utf8Encoder.encode(signingInput),
    );
    return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
  }

  return Object.freeze({
    issuer,
    resourceUrl,
    jwks,
    supabaseEnv,
    mintUserToken,
  });
}

export interface CreateMcpTestClientOptions {
  /** Base endpoint URL used in synthesized `Request` objects. Defaults to `"https://example.test/functions/v1/mcp"`. */
  readonly endpoint?: string | URL;
  /** Ephemeral ES256 JWT issuer enabling tokenless `asUser({ id, email, scopes })` against real JWKS verification. */
  readonly authHarness?: TestAuthHarness;
  /** Default client info sent in `_meta` and `initialize`. */
  readonly clientInfo?: Implementation;
  /** Known tool names across all profiles (enables automatic unmounted-tool-reference lint in `snapshotSurface`). */
  readonly knownTools?: Iterable<string>;
  readonly plainWordTools?: Iterable<string>;
}

export interface McpTestToolResult<
  Structured = Record<string, unknown>,
> extends CallToolResult {
  readonly structuredContent?: Structured;
  /** Concatenated text from all `{ type: "text" }` blocks in `content`. */
  readonly text: string;
  /** Exact UTF-8 serialized byte length of the wire `CallToolResult`. */
  readonly encodedBytes: number;
  /** Extracted dual-lane guidance (`structuredContent.next/warnings` or text lane fallback). */
  readonly guidance: {
    readonly next?: string;
    readonly warnings: readonly string[];
  };
}

export interface McpTestResourceResult extends ReadResourceResult {
  /** Concatenated UTF-8 text from all text contents in `contents`. */
  readonly text: string;
  /** Exact UTF-8 serialized byte length of the wire `ReadResourceResult`. */
  readonly encodedBytes: number;
}

export interface McpTestPromptResult extends GetPromptResult {
  /** Exact UTF-8 serialized byte length of the wire `GetPromptResult`. */
  readonly encodedBytes: number;
}

export interface UnmountedToolReferenceFinding {
  readonly location:
    | "instructions"
    | `${string}.description`
    | `${string}.inputSchema`
    | `${string}.outputSchema`;
  readonly referencedTool: string;
  readonly excerpt: string;
}

export interface SurfaceSnapshot {
  readonly schemaVersion: 1;
  readonly profile: string;
  readonly instructions?: string;
  readonly tools: readonly SupabaseMcpSurfaceTool[];
  /** Identical `sha256:<hex>` digest to `onSurface` and `mcp-surface.lock.json`. */
  readonly contentDigest: `sha256:${string}`;
  readonly estimatedTokens: number;
  readonly unmountedReferences: readonly UnmountedToolReferenceFinding[];
}

export interface McpTestCallOptions {
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>>;
  /** Convenience carrier setting `_meta["dev.chumbo/run"]`. */
  readonly run?: string;
  readonly sessionId?: string;
}

export interface McpTestHttpExchange {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

export interface McpTestPersonaClient {
  readonly sessionId: string | null;
  initialize(capabilities?: Record<string, unknown>): Promise<InitializeResult>;
  listTools(): Promise<readonly SupabaseMcpSurfaceTool[]>;
  callTool<Structured = Record<string, unknown>>(
    name: string,
    args?: Readonly<Record<string, unknown>>,
    options?: McpTestCallOptions,
  ): Promise<McpTestToolResult<Structured>>;
  /** Low-level JSON-RPC exchange preserving HTTP status (401/403/405/429) and JSON-RPC error envelopes. */
  exchange(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    options?: McpTestCallOptions,
  ): Promise<McpTestHttpExchange>;
  listResources(): Promise<ListResourcesResult["resources"]>;
  readResource(
    uri: string,
    options?: McpTestCallOptions,
  ): Promise<McpTestResourceResult>;
  listPrompts(): Promise<ListPromptsResult["prompts"]>;
  getPrompt(
    name: string,
    args?: Readonly<Record<string, string>>,
    options?: McpTestCallOptions,
  ): Promise<McpTestPromptResult>;
  /** Capture deterministic surface snapshot + `contentDigest` + unmounted-tool-reference lint. */
  snapshotSurface(options?: {
    readonly profile?: string;
    readonly knownTools?: Iterable<string>;
    readonly allowUnmountedReferences?: boolean;
  }): Promise<SurfaceSnapshot>;
}

export interface RlsIsolationAssertionOptions {
  readonly personaA: McpTestPersonaClient;
  readonly personaB: McpTestPersonaClient;
  readonly tool: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
  /** Private strings/IDs belonging to A that MUST appear in A's result and MUST NOT appear in B's result. */
  readonly mustIsolateForA?: readonly string[];
  /** Private strings/IDs belonging to B that MUST appear in B's result and MUST NOT appear in A's result. */
  readonly mustIsolateForB?: readonly string[];
  /** Cross-tenant direct-ID probes (e.g. A calls `get_draft` or `delete_draft` with B's ID) that must fail or return empty. */
  readonly crossAccessProbes?: readonly {
    readonly caller: "A" | "B";
    readonly tool: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly expectOutcome?: "error" | "empty";
  }[];
}

export interface McpTestClient {
  asUser(persona: TestUserPersona | string): McpTestPersonaClient;
  asApiKey(
    token: string,
    options?: { readonly header?: "authorization" | "apikey" },
  ): McpTestPersonaClient;
  anon(): McpTestPersonaClient;
  assertRlsIsolation(options: RlsIsolationAssertionOptions): Promise<{
    readonly resultA: McpTestToolResult;
    readonly resultB: McpTestToolResult;
  }>;
}

function collectSchemaDescriptions(
  node: unknown,
  out: string[],
  inSchemaMap: boolean,
): void {
  if (Array.isArray(node)) {
    for (const entry of node) collectSchemaDescriptions(entry, out, false);
    return;
  }
  if (!isPlainRecord(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (!inSchemaMap) {
      if (JSON_SCHEMA_INSTANCE_DATA_KEYWORDS.has(key)) continue;
      if (key === "description" && typeof value === "string") {
        out.push(value);
        continue;
      }
      if (JSON_SCHEMA_MAP_KEYWORDS.has(key) && isPlainRecord(value)) {
        for (const child of Object.values(value)) {
          collectSchemaDescriptions(child, out, false);
        }
        continue;
      }
    }
    collectSchemaDescriptions(value, out, false);
  }
}

/**
 * Deterministic linter checking server `instructions`, tool descriptions, and
 * JSON Schema `description` fields for references to known tools that are not
 * mounted on the advertised surface.
 */
export function lintUnmountedToolReferences(input: {
  readonly instructions?: string;
  readonly tools: readonly (Pick<SupabaseMcpSurfaceTool, "name"> &
    Partial<
      Pick<
        SupabaseMcpSurfaceTool,
        "description" | "inputSchema" | "outputSchema"
      >
    >)[];
  readonly knownTools: Iterable<string>;
  readonly plainWordTools?: Iterable<string>;
}): readonly UnmountedToolReferenceFinding[] {
  const mounted = new Set(input.tools.map((tool) => tool.name));
  const plainWordSet = new Set<string>(DEFAULT_PLAIN_WORD_TOOLS);
  if (input.plainWordTools) {
    for (const word of input.plainWordTools) {
      const trimmed = word.trim();
      if (trimmed) plainWordSet.add(trimmed);
    }
  }

  const unmounted = [...new Set(input.knownTools)]
    .map((name) => name.trim())
    .filter((name) => Boolean(name) && !mounted.has(name));
  if (unmounted.length === 0) return Object.freeze([]);

  const matchers = unmounted.map((name) => {
    const escaped = escapeRegExp(name);
    const pattern = plainWordSet.has(name)
      ? new RegExp(
          `(?<![\\w:'.-])${escaped}\\(|\`${escaped}\`|\\b(?:call|use|using|with|via|run)\\s+${escaped}\\b`,
          "u",
        )
      : new RegExp(`(?<![\\w.-])${escaped}(?![\\w-])`, "u");
    return { name, pattern };
  });

  const findings: UnmountedToolReferenceFinding[] = [];
  const scanText = (
    location: UnmountedToolReferenceFinding["location"],
    text: string | undefined,
  ): void => {
    if (!text) return;
    for (const { name, pattern } of matchers) {
      const match = pattern.exec(text);
      if (match) {
        findings.push(
          Object.freeze({
            location,
            referencedTool: name,
            excerpt: excerptAround(text, match.index, match[0].length),
          }),
        );
      }
    }
  };

  scanText("instructions", input.instructions);
  for (const tool of input.tools) {
    scanText(`${tool.name}.description`, tool.description);
    if (tool.inputSchema !== undefined) {
      const descriptions: string[] = [];
      collectSchemaDescriptions(tool.inputSchema, descriptions, false);
      for (const description of descriptions) {
        scanText(`${tool.name}.inputSchema`, description);
      }
    }
    if (tool.outputSchema !== undefined) {
      const descriptions: string[] = [];
      collectSchemaDescriptions(tool.outputSchema, descriptions, false);
      for (const description of descriptions) {
        scanText(`${tool.name}.outputSchema`, description);
      }
    }
  }

  return Object.freeze(findings);
}

function extractTextFromCallToolResult(result: CallToolResult): string {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function extractGuidance(
  result: CallToolResult,
  text: string,
): { readonly next?: string; readonly warnings: readonly string[] } {
  const structured = isPlainRecord(result.structuredContent)
    ? result.structuredContent
    : undefined;
  let next: string | undefined;
  let warnings: string[] = [];

  if (structured) {
    if (typeof structured.next === "string" && structured.next.trim()) {
      next = structured.next.trim();
    }
    if (Array.isArray(structured.warnings)) {
      warnings = structured.warnings.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      );
    }
  }

  if (next === undefined && warnings.length === 0 && text) {
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("Next: ") && next === undefined) {
        const candidate = trimmed.slice("Next: ".length).trim();
        if (candidate) next = candidate;
      } else if (trimmed.startsWith("Warning: ")) {
        const candidate = trimmed.slice("Warning: ".length).trim();
        if (candidate) warnings.push(candidate);
      }
    }
  }

  return Object.freeze({
    ...(next !== undefined ? { next } : {}),
    warnings: Object.freeze(warnings),
  });
}

function decorateToolResult<Structured = Record<string, unknown>>(
  raw: CallToolResult,
): McpTestToolResult<Structured> {
  const encodedBytes = utf8Encoder.encode(JSON.stringify(raw)).byteLength;
  const text = extractTextFromCallToolResult(raw);
  const guidance = extractGuidance(raw, text);
  const decorated = { ...raw };
  Object.defineProperty(decorated, "text", {
    value: text,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(decorated, "encodedBytes", {
    value: encodedBytes,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(decorated, "guidance", {
    value: guidance,
    enumerable: false,
    configurable: true,
  });
  return decorated as McpTestToolResult<Structured>;
}

function decorateResourceResult(
  raw: ReadResourceResult,
): McpTestResourceResult {
  const encodedBytes = utf8Encoder.encode(JSON.stringify(raw)).byteLength;
  const textParts: string[] = [];
  for (const entry of raw.contents ?? []) {
    if ("text" in entry && typeof entry.text === "string") {
      textParts.push(entry.text);
    }
  }
  const decorated = { ...raw };
  Object.defineProperty(decorated, "text", {
    value: textParts.join("\n"),
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(decorated, "encodedBytes", {
    value: encodedBytes,
    enumerable: false,
    configurable: true,
  });
  return decorated as McpTestResourceResult;
}

function decoratePromptResult(raw: GetPromptResult): McpTestPromptResult {
  const encodedBytes = utf8Encoder.encode(JSON.stringify(raw)).byteLength;
  const decorated = { ...raw };
  Object.defineProperty(decorated, "encodedBytes", {
    value: encodedBytes,
    enumerable: false,
    configurable: true,
  });
  return decorated as McpTestPromptResult;
}

function unwrapJsonRpcResult<Result>(
  exchange: McpTestHttpExchange,
  method: string,
): Result {
  if (exchange.status !== 200) {
    throw new Error(
      `MCP ${method} failed with HTTP ${exchange.status}: ${typeof exchange.body === "string" ? exchange.body : JSON.stringify(exchange.body)}`,
    );
  }
  if (!isPlainRecord(exchange.body)) {
    throw new Error(
      `MCP ${method} returned a non-JSON-RPC body: ${String(exchange.body)}`,
    );
  }
  if ("error" in exchange.body && exchange.body.error !== undefined) {
    throw new Error(
      `MCP ${method} returned JSON-RPC error: ${JSON.stringify(exchange.body.error)}`,
    );
  }
  if (!("result" in exchange.body)) {
    throw new Error(
      `MCP ${method} response missing result field: ${JSON.stringify(exchange.body)}`,
    );
  }
  return exchange.body.result as Result;
}

function isEmptyToolResult(result: McpTestToolResult): boolean {
  if (result.isError === true) return false;
  if (isPlainRecord(result.structuredContent)) {
    const sc = result.structuredContent;
    if (Array.isArray(sc.items)) return sc.items.length === 0;
    if (Object.keys(sc).length === 0) return true;
  }
  return result.text.trim().length === 0;
}

/**
 * Create a zero-backdoor HTTP MCP test client supporting multi-persona
 * execution (`asUser`, `asApiKey`, `anon`), deterministic surface snapshots
 * with unmounted-tool-reference linting, and concurrent two-user RLS assertions.
 */
export function createMcpTestClient(
  target: McpTestableTarget,
  options?: CreateMcpTestClientOptions,
): McpTestClient {
  const fetchTarget =
    typeof target === "function"
      ? target
      : (request: Request) => target.fetch(request);
  const endpoint =
    typeof options?.endpoint === "string"
      ? options.endpoint
      : options?.endpoint instanceof URL
        ? options.endpoint.href
        : (options?.authHarness?.resourceUrl ??
          "https://example.test/functions/v1/mcp");
  const clientInfo = options?.clientInfo ?? DEFAULT_CLIENT_INFO;

  function createPersona(
    resolveAuthHeader: () => Promise<Readonly<Record<string, string>>>,
  ): McpTestPersonaClient {
    let activeSessionId: string | null = null;
    let nextRequestId = 1;

    async function exchange(
      method: string,
      params?: Readonly<Record<string, unknown>>,
      callOptions?: McpTestCallOptions,
    ): Promise<McpTestHttpExchange> {
      const authHeaders = await resolveAuthHeader();
      const sessionId = callOptions?.sessionId ?? activeSessionId;
      const headers = new Headers({
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(method !== "initialize"
          ? {
              "mcp-protocol-version": DEFAULT_PROTOCOL_VERSION,
              "mcp-method": method,
            }
          : {}),
        ...authHeaders,
        ...(callOptions?.headers ?? {}),
      });
      if (method === "tools/call" && typeof params?.name === "string") {
        headers.set("mcp-name", params.name);
      }
      if (sessionId) {
        headers.set("mcp-session-id", sessionId);
      }

      const existingMeta = isPlainRecord(params?._meta) ? params._meta : {};
      const mergedMeta: Record<string, unknown> = {
        ...existingMeta,
        ...(callOptions?.meta ?? {}),
        ...(callOptions?.run ? { "dev.chumbo/run": callOptions.run } : {}),
      };
      if (method !== "initialize") {
        if (!("io.modelcontextprotocol/protocolVersion" in mergedMeta)) {
          mergedMeta["io.modelcontextprotocol/protocolVersion"] =
            DEFAULT_PROTOCOL_VERSION;
        }
        if (!("io.modelcontextprotocol/clientInfo" in mergedMeta)) {
          mergedMeta["io.modelcontextprotocol/clientInfo"] = clientInfo;
        }
        if (!("io.modelcontextprotocol/clientCapabilities" in mergedMeta)) {
          mergedMeta["io.modelcontextprotocol/clientCapabilities"] = {};
        }
      }

      const rpcParams: Record<string, unknown> = {
        ...(params ?? {}),
        ...(Object.keys(mergedMeta).length > 0 ? { _meta: mergedMeta } : {}),
      };

      const request = new Request(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: nextRequestId++,
          method,
          params: rpcParams,
        }),
      });
      const response = await fetchTarget(request);
      const issuedSession = response.headers.get("mcp-session-id");
      if (issuedSession) activeSessionId = issuedSession;

      const rawText = await response.text();
      let body: unknown = rawText;
      if (rawText.trim()) {
        const parsed = jsonRpcPayloadFromResponseText(rawText);
        if (parsed !== undefined) {
          body = parsed;
        } else {
          try {
            body = JSON.parse(rawText);
          } catch {
            body = rawText;
          }
        }
      }

      return Object.freeze({
        status: response.status,
        headers: response.headers,
        body,
      });
    }

    async function initialize(
      capabilities?: Record<string, unknown>,
    ): Promise<InitializeResult> {
      const res = await exchange("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: capabilities ?? {},
        clientInfo,
      });
      return unwrapJsonRpcResult<InitializeResult>(res, "initialize");
    }

    async function listTools(): Promise<readonly SupabaseMcpSurfaceTool[]> {
      const tools: SupabaseMcpSurfaceTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page += 1) {
        const res = await exchange("tools/list", cursor ? { cursor } : {});
        const result = unwrapJsonRpcResult<{
          tools?: SupabaseMcpSurfaceTool[];
          nextCursor?: string;
        }>(res, "tools/list");
        if (Array.isArray(result.tools)) {
          tools.push(...result.tools);
        }
        if (typeof result.nextCursor === "string" && result.nextCursor) {
          cursor = result.nextCursor;
        } else {
          break;
        }
      }
      return Object.freeze(tools);
    }

    async function callTool<Structured = Record<string, unknown>>(
      name: string,
      args?: Readonly<Record<string, unknown>>,
      callOptions?: McpTestCallOptions,
    ): Promise<McpTestToolResult<Structured>> {
      const res = await exchange(
        "tools/call",
        { name, arguments: args ?? {} },
        callOptions,
      );
      const result = unwrapJsonRpcResult<CallToolResult>(res, "tools/call");
      return decorateToolResult<Structured>(result);
    }

    async function listResources(): Promise<ListResourcesResult["resources"]> {
      const res = await exchange("resources/list", {});
      const result = unwrapJsonRpcResult<ListResourcesResult>(
        res,
        "resources/list",
      );
      return result.resources ?? [];
    }

    async function readResource(
      uri: string,
      callOptions?: McpTestCallOptions,
    ): Promise<McpTestResourceResult> {
      const res = await exchange("resources/read", { uri }, callOptions);
      const result = unwrapJsonRpcResult<ReadResourceResult>(
        res,
        "resources/read",
      );
      return decorateResourceResult(result);
    }

    async function listPrompts(): Promise<ListPromptsResult["prompts"]> {
      const res = await exchange("prompts/list", {});
      const result = unwrapJsonRpcResult<ListPromptsResult>(
        res,
        "prompts/list",
      );
      return result.prompts ?? [];
    }

    async function getPrompt(
      name: string,
      args?: Readonly<Record<string, string>>,
      callOptions?: McpTestCallOptions,
    ): Promise<McpTestPromptResult> {
      const res = await exchange(
        "prompts/get",
        { name, ...(args ? { arguments: args } : {}) },
        callOptions,
      );
      const result = unwrapJsonRpcResult<GetPromptResult>(res, "prompts/get");
      return decoratePromptResult(result);
    }

    async function snapshotSurface(snapOptions?: {
      readonly profile?: string;
      readonly knownTools?: Iterable<string>;
      readonly allowUnmountedReferences?: boolean;
    }): Promise<SurfaceSnapshot> {
      const init = await initialize();
      const rawTools = await listTools();
      const computed = await computeCanonicalSurfaceDigest(rawTools);
      if (!computed) {
        throw new Error(
          "Could not compute canonical surface digest for tools/list response",
        );
      }
      const tokenReport = estimateCatalogTokens(computed.tools);
      const knownTools = snapOptions?.knownTools ?? options?.knownTools;
      const unmountedReferences = knownTools
        ? lintUnmountedToolReferences({
            ...(init.instructions ? { instructions: init.instructions } : {}),
            tools: computed.tools,
            knownTools,
            ...(options?.plainWordTools
              ? { plainWordTools: options.plainWordTools }
              : {}),
          })
        : Object.freeze([]);

      if (
        unmountedReferences.length > 0 &&
        !snapOptions?.allowUnmountedReferences
      ) {
        const detail = unmountedReferences
          .map(
            (finding) =>
              `  - ${finding.location} references unmounted tool '${finding.referencedTool}' (${finding.excerpt})`,
          )
          .join("\n");
        throw new Error(
          `Surface snapshot found ${unmountedReferences.length} unmounted tool reference(s):\n${detail}`,
        );
      }

      return Object.freeze({
        schemaVersion: 1,
        profile: snapOptions?.profile ?? "default",
        ...(init.instructions ? { instructions: init.instructions } : {}),
        tools: computed.tools,
        contentDigest: computed.contentDigest,
        estimatedTokens: tokenReport.totalPromptTokens,
        unmountedReferences,
      });
    }

    return {
      get sessionId() {
        return activeSessionId;
      },
      initialize,
      listTools,
      callTool,
      exchange,
      listResources,
      readResource,
      listPrompts,
      getPrompt,
      snapshotSurface,
    };
  }

  return {
    asUser(persona: TestUserPersona | string): McpTestPersonaClient {
      if (typeof persona === "string") {
        const token = persona.trim();
        if (!token) {
          throw new TypeError(
            "asUser(token) requires a non-empty bearer token",
          );
        }
        return createPersona(async () => ({
          authorization: `Bearer ${token}`,
        }));
      }
      let cachedToken: string | undefined = persona.token;
      return createPersona(async () => {
        if (!cachedToken) {
          if (!options?.authHarness) {
            throw new TypeError(
              "asUser({ id, ... }) without a token requires createMcpTestClient(app, { authHarness })",
            );
          }
          cachedToken = await options.authHarness.mintUserToken(persona);
        }
        return { authorization: `Bearer ${cachedToken}` };
      });
    },

    asApiKey(
      token: string,
      keyOptions?: { readonly header?: "authorization" | "apikey" },
    ): McpTestPersonaClient {
      const trimmed = token.trim();
      if (!trimmed) {
        throw new TypeError("asApiKey(token) requires a non-empty key");
      }
      const header = keyOptions?.header ?? "authorization";
      return createPersona(
        async (): Promise<Readonly<Record<string, string>>> =>
          header === "apikey"
            ? { apikey: trimmed }
            : { authorization: `Bearer ${trimmed}` },
      );
    },

    anon(): McpTestPersonaClient {
      return createPersona(async () => ({}));
    },

    async assertRlsIsolation(assertion: RlsIsolationAssertionOptions): Promise<{
      readonly resultA: McpTestToolResult;
      readonly resultB: McpTestToolResult;
    }> {
      const [resultA, resultB] = await Promise.all([
        assertion.personaA.callTool(assertion.tool, assertion.arguments),
        assertion.personaB.callTool(assertion.tool, assertion.arguments),
      ]);
      const haystackA = `${JSON.stringify(resultA)}\n${resultA.text}`;
      const haystackB = `${JSON.stringify(resultB)}\n${resultB.text}`;

      for (const secret of assertion.mustIsolateForA ?? []) {
        if (!haystackA.includes(secret)) {
          throw new Error(
            `RLS isolation failed: personaA did not receive expected value '${secret}' from '${assertion.tool}'`,
          );
        }
        if (haystackB.includes(secret)) {
          throw new Error(
            `RLS isolation failed: personaB leaked personaA value '${secret}' from '${assertion.tool}'`,
          );
        }
      }

      for (const secret of assertion.mustIsolateForB ?? []) {
        if (!haystackB.includes(secret)) {
          throw new Error(
            `RLS isolation failed: personaB did not receive expected value '${secret}' from '${assertion.tool}'`,
          );
        }
        if (haystackA.includes(secret)) {
          throw new Error(
            `RLS isolation failed: personaA leaked personaB value '${secret}' from '${assertion.tool}'`,
          );
        }
      }

      if (
        assertion.crossAccessProbes &&
        assertion.crossAccessProbes.length > 0
      ) {
        await Promise.all(
          assertion.crossAccessProbes.map(async (probe) => {
            const caller =
              probe.caller === "A" ? assertion.personaA : assertion.personaB;
            const outcome = probe.expectOutcome ?? "error";
            const probeResult = await caller.callTool(
              probe.tool,
              probe.arguments,
            );
            if (outcome === "error" && probeResult.isError !== true) {
              throw new Error(
                `Cross-access probe (${probe.caller} -> ${probe.tool}) succeeded unexpectedly; expected isError: true`,
              );
            }
            if (outcome === "empty" && !isEmptyToolResult(probeResult)) {
              throw new Error(
                `Cross-access probe (${probe.caller} -> ${probe.tool}) returned non-empty data; expected empty result`,
              );
            }
          }),
        );
      }

      return Object.freeze({ resultA, resultB });
    },
  };
}
