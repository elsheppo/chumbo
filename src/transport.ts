import type { McpCorsOptions, McpTransportArmorOptions } from "./types.js";

const MAX_INBOUND_ENVELOPE_BYTES = 64 * 1024;
const MAX_JSON_RPC_CHECK_BYTES = 64 * 1024;
const mcpParamHeaderPattern = /^mcp-param-[a-z0-9_-]{1,64}$/i;
const safeHeaderTokenPattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
const protocolDatePattern = /^\d{4}-\d{2}-\d{2}$/;

export const DEFAULT_MCP_ALLOW_HEADERS = Object.freeze([
  "authorization",
  "content-type",
  "accept",
  "mcp-protocol-version",
  "mcp-session-id",
  "mcp-method",
  "mcp-name",
  "last-event-id",
  "apikey",
]);

export const DEFAULT_MCP_EXPOSE_HEADERS = Object.freeze([
  "www-authenticate",
  "mcp-session-id",
  "mcp-protocol-version",
  "x-chumbo-version",
  "x-chumbo-auth-mode",
  "x-chumbo-auth-strategy",
  "x-chumbo-resource-url",
  "x-supa-mcp-version",
  "x-supa-mcp-auth-mode",
  "x-supa-mcp-auth-strategy",
  "x-supa-mcp-resource-url",
]);

export interface SurfaceListRequest {
  readonly protocolVersion?: string;
}

export interface InboundMcpEnvelope {
  readonly era: "modern" | "legacy";
  readonly method?: string;
  readonly protocolVersion?: string;
  readonly rawClientInfo?: unknown;
  readonly rawCapabilities?: unknown;
  readonly surfaceList: SurfaceListRequest | null;
  readonly isSubscriptionsListen: boolean;
  readonly subscriptionsListenId: string | number | null;
  /** Defined only when the entire HTTP body fit in 64 KiB and parsed as valid JSON. */
  readonly parsedBody?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => {});
  } catch {
    // Non-blocking release of cloned tee branch.
  }
}

export async function boundedBodyText(
  body: Request | Response,
  maxBytes: number,
): Promise<{ readonly text: string; readonly complete: boolean } | null> {
  const contentLength = body.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) return null;
  }
  let clone: Request | Response;
  try {
    clone = body.clone();
  } catch {
    return null;
  }
  if (!clone.body) return { text: "", complete: true };
  // `@supabase/middleware`'s `bufferRequest(req)` proxy returns a proxy over the
  // same underlying Request from `clone()`, so `clone.body === body.body`. Reading
  // `clone.body.getReader()` would bypass its cache and drain the stream for
  // downstream handlers; reading `clone.arrayBuffer()` populates its cache safely.
  if (clone.body === body.body) {
    try {
      const buffer = await clone.arrayBuffer();
      if (buffer.byteLength > maxBytes) return null;
      return { text: new TextDecoder().decode(buffer), complete: true };
    } catch {
      return null;
    }
  }
  const reader = clone.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        cancelReader(reader);
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return { text: text + decoder.decode(), complete: true };
  } catch {
    cancelReader(reader);
    return null;
  }
}

function echoableRpcId(value: unknown): string | number | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function isModernHeaderVersion(headerVersion: string | undefined): boolean {
  if (!headerVersion || !protocolDatePattern.test(headerVersion)) return false;
  return headerVersion >= "2026-07-28";
}

function hasModernEnvelopeClaim(
  params: Record<string, unknown> | undefined,
): boolean {
  const meta = params && isRecord(params._meta) ? params._meta : undefined;
  if (!meta) return false;
  return (
    "io.modelcontextprotocol/protocolVersion" in meta ||
    "io.modelcontextprotocol/clientInfo" in meta ||
    "io.modelcontextprotocol/clientCapabilities" in meta
  );
}

/**
 * Single-pass bounded (64 KiB) HTTP request classifier shared across transport
 * armor, `ctx.client` extraction, `onSurface` `tools/list` inspection, and
 * 2025 `initialize` session issuance. Clones `request` at most once per `POST`
 * and cancels the clone reader immediately if a `tools/call` body exceeds 64 KiB.
 */
export async function inspectInboundMcpEnvelope(
  request: Request,
): Promise<InboundMcpEnvelope> {
  const headerVersion = request.headers.get("mcp-protocol-version")?.trim();
  const headerMethod = request.headers.get("mcp-method")?.trim();
  const validHeaderVersion =
    headerVersion && protocolDatePattern.test(headerVersion)
      ? headerVersion
      : undefined;

  if (request.method !== "POST") {
    return Object.freeze({
      era: isModernHeaderVersion(validHeaderVersion) ? "modern" : "legacy",
      ...(validHeaderVersion ? { protocolVersion: validHeaderVersion } : {}),
      surfaceList: null,
      isSubscriptionsListen: false,
      subscriptionsListenId: null,
    });
  }

  const headerIsListen = headerMethod === "subscriptions/listen";
  const bodySlice = await boundedBodyText(request, MAX_INBOUND_ENVELOPE_BYTES);
  if (!bodySlice || !bodySlice.text.trim()) {
    return Object.freeze({
      era: isModernHeaderVersion(validHeaderVersion) ? "modern" : "legacy",
      ...(headerMethod ? { method: headerMethod } : {}),
      ...(validHeaderVersion ? { protocolVersion: validHeaderVersion } : {}),
      surfaceList: null,
      isSubscriptionsListen: headerIsListen,
      subscriptionsListenId: null,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodySlice.text);
  } catch {
    return Object.freeze({
      era: isModernHeaderVersion(validHeaderVersion) ? "modern" : "legacy",
      ...(headerMethod ? { method: headerMethod } : {}),
      ...(validHeaderVersion ? { protocolVersion: validHeaderVersion } : {}),
      surfaceList: null,
      isSubscriptionsListen: headerIsListen,
      subscriptionsListenId: null,
    });
  }

  if (Array.isArray(parsed)) {
    const listenEntry = parsed.find(
      (entry) => isRecord(entry) && entry.method === "subscriptions/listen",
    ) as Record<string, unknown> | undefined;
    const anyModern =
      isModernHeaderVersion(validHeaderVersion) ||
      parsed.some(
        (entry) =>
          isRecord(entry) &&
          hasModernEnvelopeClaim(
            isRecord(entry.params) ? entry.params : undefined,
          ),
      );
    return Object.freeze({
      era: anyModern ? "modern" : "legacy",
      ...(validHeaderVersion ? { protocolVersion: validHeaderVersion } : {}),
      surfaceList: null,
      isSubscriptionsListen: headerIsListen || Boolean(listenEntry),
      subscriptionsListenId: listenEntry ? echoableRpcId(listenEntry.id) : null,
      ...(bodySlice.complete ? { parsedBody: parsed } : {}),
    });
  }

  if (!isRecord(parsed)) {
    return Object.freeze({
      era: isModernHeaderVersion(validHeaderVersion) ? "modern" : "legacy",
      ...(validHeaderVersion ? { protocolVersion: validHeaderVersion } : {}),
      surfaceList: null,
      isSubscriptionsListen: headerIsListen,
      subscriptionsListenId: null,
      ...(bodySlice.complete ? { parsedBody: parsed } : {}),
    });
  }

  const method =
    typeof parsed.method === "string" ? parsed.method : headerMethod;
  const params = isRecord(parsed.params) ? parsed.params : undefined;
  const meta = params && isRecord(params._meta) ? params._meta : undefined;
  const era: "modern" | "legacy" =
    hasModernEnvelopeClaim(params) || isModernHeaderVersion(validHeaderVersion)
      ? "modern"
      : "legacy";

  const metaVersion =
    typeof meta?.["io.modelcontextprotocol/protocolVersion"] === "string"
      ? meta["io.modelcontextprotocol/protocolVersion"].trim()
      : undefined;
  const initVersion =
    method === "initialize" && typeof params?.protocolVersion === "string"
      ? params.protocolVersion.trim()
      : undefined;
  const candidateVersion = validHeaderVersion ?? metaVersion ?? initVersion;
  const protocolVersion =
    candidateVersion && protocolDatePattern.test(candidateVersion)
      ? candidateVersion
      : undefined;

  const rawClientInfo =
    era === "modern"
      ? meta?.["io.modelcontextprotocol/clientInfo"]
      : method === "initialize"
        ? params?.clientInfo
        : undefined;
  const rawCapabilities =
    era === "modern"
      ? meta?.["io.modelcontextprotocol/clientCapabilities"]
      : method === "initialize"
        ? params?.capabilities
        : undefined;

  const surfaceList: SurfaceListRequest | null =
    method === "tools/list" && !(params && typeof params.cursor === "string")
      ? protocolVersion
        ? { protocolVersion }
        : {}
      : null;

  const isSubscriptionsListen =
    headerIsListen || method === "subscriptions/listen";

  return Object.freeze({
    era,
    ...(method ? { method } : {}),
    ...(protocolVersion ? { protocolVersion } : {}),
    ...(rawClientInfo !== undefined ? { rawClientInfo } : {}),
    ...(rawCapabilities !== undefined ? { rawCapabilities } : {}),
    surfaceList,
    isSubscriptionsListen,
    subscriptionsListenId: isSubscriptionsListen
      ? echoableRpcId(parsed.id)
      : null,
    ...(bodySlice.complete ? { parsedBody: parsed } : {}),
  });
}

export function jsonRpcPayloadFromResponseText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice("data:".length).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const payload = JSON.parse(data) as unknown;
        if (isRecord(payload) && ("result" in payload || "error" in payload)) {
          return payload;
        }
      } catch {
        // Ignore unrelated SSE frames.
      }
    }
    return null;
  }
}

export async function isSuccessfulJsonRpcResponse(
  response: Response,
): Promise<boolean> {
  if (response.status !== 200) return false;
  const body = await boundedBodyText(response, MAX_JSON_RPC_CHECK_BYTES);
  if (!body || !body.text.trim()) return false;
  const payload = jsonRpcPayloadFromResponseText(body.text);
  return (
    isRecord(payload) &&
    payload.jsonrpc === "2.0" &&
    !("error" in payload) &&
    isRecord(payload.result)
  );
}

/**
 * Immediate, spec-compliant refusal of unsupported SSE/listen-stream requests
 * so stateless Edge Functions and Cloud Run containers never hold open idle
 * streams until platform request timeouts.
 */
export function applyMcpTransportArmor(
  request: Request,
  envelope: InboundMcpEnvelope,
  options?: McpTransportArmorOptions,
): Response | undefined {
  const subscriptions = options?.subscriptions ?? "disabled";
  if (subscriptions !== "disabled") return undefined;

  if (request.method === "OPTIONS") return undefined;

  if (request.method !== "POST") {
    return new Response(
      request.method === "HEAD"
        ? null
        : JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message:
                "Method not allowed: standalone SSE listen streams and server-side session deletion are disabled on stateless endpoints.",
            },
            id: null,
          }),
      {
        status: 405,
        headers: {
          allow: "POST, OPTIONS",
          "cache-control": "no-store",
          "content-type": "application/json",
        },
      },
    );
  }

  if (envelope.isSubscriptionsListen) {
    return Response.json(
      {
        jsonrpc: "2.0",
        id: envelope.subscriptionsListenId,
        error: {
          code: -32601,
          message:
            "Method not found: subscriptions/listen is disabled on stateless endpoints.",
        },
      },
      {
        status: 200,
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  }

  return undefined;
}

/** Case-insensitive comma-token union for `Access-Control-Expose-Headers` and `Vary`. */
export function mergeHeaderTokens(
  existing: string | null | undefined,
  additions: readonly string[],
): string {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const pushToken = (raw: string): void => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) return;
    seen.add(lower);
    ordered.push(trimmed);
  };

  for (const part of (existing ?? "").split(",")) pushToken(part);
  for (const addition of additions) {
    for (const part of addition.split(",")) pushToken(part);
  }
  return ordered.join(", ");
}

export function mergeExposedHeaders(
  existing: string | null | undefined,
  extra: readonly string[] = [],
): string {
  return mergeHeaderTokens(existing, [...DEFAULT_MCP_EXPOSE_HEADERS, ...extra]);
}

function normalizeOrigin(origin: string): string | null {
  const trimmed = origin.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    if (parsed.origin !== trimmed) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export interface EvaluatedCorsOrigin {
  readonly hasOriginHeader: boolean;
  readonly allowed: boolean;
  readonly allowOriginHeader?: string;
  readonly varyOrigin: boolean;
}

export function evaluateMcpCorsOrigin(
  request: Request,
  options: McpCorsOptions,
): EvaluatedCorsOrigin {
  const rawOrigin = request.headers.get("origin");
  if (rawOrigin === null) {
    return {
      hasOriginHeader: false,
      allowed: true,
      varyOrigin: false,
    };
  }
  const normalized = normalizeOrigin(rawOrigin);
  if (!normalized) {
    return {
      hasOriginHeader: true,
      allowed: false,
      varyOrigin: true,
    };
  }
  if (options.origins === "*") {
    return {
      hasOriginHeader: true,
      allowed: true,
      allowOriginHeader: "*",
      varyOrigin: false,
    };
  }
  const matched = Array.isArray(options.origins)
    ? (options.origins as readonly string[]).some(
        (entry) => normalizeOrigin(entry) === normalized,
      )
    : (options.origins as (origin: string) => boolean)(normalized);
  if (!matched) {
    return {
      hasOriginHeader: true,
      allowed: false,
      varyOrigin: true,
    };
  }
  return {
    hasOriginHeader: true,
    allowed: true,
    allowOriginHeader: normalized,
    varyOrigin: true,
  };
}

function resolveAllowHeaders(
  request: Request,
  options: McpCorsOptions,
): string {
  const dynamicMcpParams: string[] = [];
  const requested = request.headers.get("access-control-request-headers");
  if (requested) {
    for (const part of requested.split(",")) {
      const trimmed = part.trim();
      if (mcpParamHeaderPattern.test(trimmed)) {
        dynamicMcpParams.push(trimmed.toLowerCase());
      }
    }
  }
  const configured = (options.allowHeaders ?? []).filter((header) =>
    safeHeaderTokenPattern.test(header.trim()),
  );
  return mergeHeaderTokens(undefined, [
    ...DEFAULT_MCP_ALLOW_HEADERS,
    ...configured,
    ...dynamicMcpParams,
  ]);
}

export function forbiddenOriginResponse(): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message:
          "Forbidden: Origin header is not permitted by this MCP server.",
      },
      id: null,
    },
    {
      status: 403,
      headers: {
        "cache-control": "no-store",
        vary: "Origin",
      },
    },
  );
}

/**
 * Evaluate `Origin` and answer `OPTIONS` CORS preflights before auth runs.
 * Returns a `403` `Response` for disallowed or `"null"` origins and a `204`
 * `Response` for valid `OPTIONS` preflights; returns `undefined` to continue.
 */
export function applyMcpCorsPreflight(
  request: Request,
  options: McpCorsOptions,
): {
  readonly shortCircuit?: Response;
  readonly evaluated: EvaluatedCorsOrigin;
} {
  const evaluated = evaluateMcpCorsOrigin(request, options);
  if (!evaluated.allowed) {
    return { shortCircuit: forbiddenOriginResponse(), evaluated };
  }
  if (request.method !== "OPTIONS") {
    return { evaluated };
  }
  const maxAge = options.maxAgeSeconds ?? 600;
  const headers = new Headers({
    allow: "POST, OPTIONS",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": resolveAllowHeaders(request, options),
    "access-control-max-age": String(
      Number.isSafeInteger(maxAge) && maxAge >= 0 ? maxAge : 600,
    ),
  });
  if (evaluated.allowOriginHeader) {
    headers.set("access-control-allow-origin", evaluated.allowOriginHeader);
  }
  if (evaluated.varyOrigin) {
    headers.set("vary", "Origin, Access-Control-Request-Headers");
  } else {
    headers.set("vary", "Access-Control-Request-Headers");
  }
  return {
    shortCircuit: new Response(null, { status: 204, headers }),
    evaluated,
  };
}

/** Stamp CORS origin and merged `Access-Control-Expose-Headers` onto an outbound response. */
export function decorateMcpCorsResponse(
  response: Response,
  evaluated: EvaluatedCorsOrigin,
  options?: McpCorsOptions,
): Response {
  const headers = new Headers(response.headers);
  if (evaluated.allowOriginHeader) {
    headers.set("access-control-allow-origin", evaluated.allowOriginHeader);
  }
  if (evaluated.varyOrigin) {
    headers.set("vary", mergeHeaderTokens(headers.get("vary"), ["Origin"]));
  }
  headers.set(
    "access-control-expose-headers",
    mergeExposedHeaders(
      headers.get("access-control-expose-headers"),
      options?.exposeHeaders,
    ),
  );
  headers.delete("access-control-allow-credentials");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
