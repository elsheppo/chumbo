import {
  McpServer,
  OAuthError,
  OAuthErrorCode,
  buildOAuthProtectedResourceMetadata,
  createMcpHandler,
  isCallToolResult,
  isInputRequiredResult,
  requireBearerAuth,
  type AuthInfo,
  type CallToolResult,
  type McpServer as McpServerType,
  type OAuthMetadata,
  type ServerContext,
} from "@modelcontextprotocol/server";
import {
  createAdminClient,
  createContextClient,
  verifyCredentials,
} from "@supabase/server/core";
import type { JWTClaims, SupabaseEnv, UserClaims } from "@supabase/server";
import type {
  CreateSupabaseMcpOptions,
  RuntimeDependencies,
  SupabaseMcpApp,
  SupabaseMcpApiKeyAuth,
  SupabaseMcpAuthentication,
  SupabaseMcpCapabilityKind,
  SupabaseMcpContext,
  SupabaseMcpErrorEvent,
  SupabaseMcpLifecycleEvent,
  SupabaseMcpLifecycleOutcome,
  SupabaseMcpProtectedAuth,
  SupabaseMcpPostgresRateLimit,
  SupabaseMcpResultMiddleware,
  SupabaseMcpRunFact,
  SupabaseMcpServer,
  SupabaseMcpSurfaceProof,
  SupabaseMcpSurfaceTool,
  SupabaseMcpSurfaceToolAnnotations,
  VerifiedSupabaseIdentity,
} from "./types.js";
import {
  composeResultContent,
  type JsonValue,
  type ResultContentComposition,
} from "./results.js";
import {
  createSupabaseMcpStateFactory,
  SupabaseMcpStateUnavailableError,
} from "./state.js";
import { PACKAGE_VERSION } from "./version.js";

const IDENTITY_KEY = "createSupabaseMcpIdentity";
const CONTEXT_KEY = "createSupabaseMcpContext";
const DEFAULT_SCOPES = ["openid", "email", "profile", "phone"] as const;
const DEFAULT_RATE_LIMIT = {
  requests: 60,
  windowSeconds: 60,
  functionName: "supa_mcp_rate_limit",
} as const;
const REMOTE_JWKS_TTL_MS = 60_000;
const MAX_JWKS_BYTES = 64 * 1024;
const MAX_SURFACE_REQUEST_BYTES = 64 * 1024;
const MAX_SURFACE_RESPONSE_BYTES = 512 * 1024;
const MAX_SURFACE_CANONICAL_BYTES = 256 * 1024;
const MAX_SURFACE_PROOF_BYTES = 256 * 1024;
const MAX_SURFACE_TOOLS = 256;
const MAX_SURFACE_JSON_DEPTH = 32;
const MAX_SURFACE_NAME_BYTES = 256;
const MAX_SURFACE_PROSE_BYTES = 32 * 1024;
const MAX_SURFACE_SERVER_NAME_BYTES = 1024;
const MAX_SURFACE_SERVER_VERSION_BYTES = 256;
const MAX_RESULT_MIDDLEWARE = 16;
type InlineJwks = Exclude<NonNullable<SupabaseEnv["jwks"]>, URL>;
const remoteJwksCache = new Map<
  string,
  { expiresAt: number; value: Promise<InlineJwks> }
>();
const REGISTRATION_METHODS = new Set([
  "registerPrompt",
  "registerResource",
  "registerResourceTemplate",
  "registerTool",
]);

interface RequestIdentity<Database> {
  token: string;
  userClaims: UserClaims | null;
  jwtClaims: JWTClaims | null;
  supabase: SupabaseMcpContext<Database>["supabase"];
  subject: string;
  clientId?: string;
  scopes: string[];
  authentication: SupabaseMcpContext<Database>["authentication"];
}

function strategyName<Database>(
  strategy: SupabaseMcpProtectedAuth<Database>,
): string {
  return strategy.strategy?.trim() || strategy.mode;
}

function protectedStrategies<Database>(
  auth: CreateSupabaseMcpOptions<Database>["auth"],
): readonly SupabaseMcpProtectedAuth<Database>[] {
  if (!auth || auth.mode === "public") return [];
  return auth.mode === "multi" ? auth.strategies : [auth];
}

function validateStrategies<Database>(
  strategies: readonly SupabaseMcpProtectedAuth<Database>[],
  multi: boolean,
): void {
  if (multi && strategies.length < 2) {
    throw new Error("Multi auth requires at least two strategies");
  }
  const userStrategies = strategies.filter(
    (strategy) => strategy.mode === "oauth" || strategy.mode === "bearer",
  );
  if (userStrategies.length > 1) {
    throw new Error("Multi auth accepts at most one OAuth or bearer strategy");
  }
  const names = strategies.map(strategyName);
  if (new Set(names).size !== names.length) {
    throw new Error("Authentication strategy names must be unique");
  }
  const prefixes: string[] = [];
  const staticKeys: string[] = [];
  for (const strategy of strategies) {
    if (strategy.mode !== "api-key") continue;
    if (typeof strategy.key === "string" && strategy.key.length === 0) {
      throw new Error("API-key mode requires a non-empty key");
    }
    if (typeof strategy.key === "string") staticKeys.push(strategy.key);
    if (strategy.tokenPrefix !== undefined && !strategy.tokenPrefix.trim()) {
      throw new Error("API-key tokenPrefix must be non-empty");
    }
    if (
      multi &&
      typeof strategy.verify === "function" &&
      !strategy.tokenPrefix
    ) {
      throw new Error(
        "Verifier-backed API keys require tokenPrefix in multi auth",
      );
    }
    if (strategy.tokenPrefix) prefixes.push(strategy.tokenPrefix);
  }
  if (new Set(staticKeys).size !== staticKeys.length) {
    throw new Error("Static API keys must be unique in multi auth");
  }
  if (new Set(prefixes).size !== prefixes.length) {
    throw new Error("API-key tokenPrefix values must be unique");
  }
  for (const prefix of prefixes) {
    if (
      prefixes.some((other) => other !== prefix && other.startsWith(prefix))
    ) {
      throw new Error("API-key tokenPrefix values must not overlap");
    }
  }
}

function trimTrailingSlash(url: URL): URL {
  const copy = new URL(url);
  copy.hash = "";
  copy.search = "";
  copy.pathname = copy.pathname.replace(/\/+$/, "");
  return copy;
}

function appendPath(url: URL, suffix: string): URL {
  const base = trimTrailingSlash(url);
  base.pathname = `${base.pathname}/${suffix.replace(/^\/+/, "")}`;
  return base;
}

function metadataUrlForIssuer(issuer: URL): URL {
  const result = new URL(issuer.origin);
  result.pathname = `/.well-known/oauth-authorization-server${issuer.pathname.replace(/\/+$/, "")}`;
  return result;
}

function scopesFromClaims(claims: JWTClaims): string[] {
  const value = claims.scope;
  if (typeof value === "string") {
    return value.split(/\s+/).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.filter((scope): scope is string => typeof scope === "string");
  }
  return [];
}

function actualClientId(claims: JWTClaims): string | undefined {
  return typeof claims.client_id === "string" ? claims.client_id : undefined;
}

function normalizedScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
}

function contextWithScopes<Database>(
  value: Omit<
    SupabaseMcpContext<Database>,
    "scopes" | "hasScope" | "hasScopes"
  >,
  scopes: readonly string[],
): SupabaseMcpContext<Database> {
  const normalized = Object.freeze(normalizedScopes(scopes));
  const set = new Set(normalized);
  return Object.freeze({
    ...value,
    scopes: normalized,
    hasScope(scope: string) {
      return set.has(scope);
    },
    hasScopes(required: readonly string[]) {
      return required.every((scope) => set.has(scope));
    },
  });
}

function scopedServer<Database>(
  server: McpServerType,
  context: SupabaseMcpContext<Database>,
  lifecycle: LifecycleEmitter<Database> | undefined,
  resultMiddleware: ResultMiddlewareRunner<Database> | undefined,
  requiredScopes: readonly string[] = [],
): SupabaseMcpServer {
  const required = normalizedScopes(requiredScopes);
  return new Proxy(server, {
    get(target, property) {
      if (property === "withScopes") {
        return (additional: readonly string[]) =>
          scopedServer(target, context, lifecycle, resultMiddleware, [
            ...required,
            ...additional,
          ]);
      }
      const value = Reflect.get(target, property, target);
      if (typeof property !== "string" || typeof value !== "function") {
        return value;
      }
      if (!REGISTRATION_METHODS.has(property)) return value.bind(target);
      return (...args: unknown[]) => {
        let registrationArgs = lifecycle
          ? lifecycle.wrapRegistration(property, args, context)
          : args;
        registrationArgs = resultMiddleware
          ? resultMiddleware.wrapRegistration(
              property,
              registrationArgs,
              context,
            )
          : registrationArgs;
        const registration = Reflect.apply(value, target, registrationArgs) as {
          disable?(): void;
        };
        if (!context.hasScopes(required)) registration.disable?.();
        return registration;
      };
    },
  }) as SupabaseMcpServer;
}

interface ResultMiddlewareRunner<Database> {
  wrapRegistration(
    method: string,
    args: readonly unknown[],
    context: SupabaseMcpContext<Database>,
  ): unknown[];
}

function deepFreeze<Value>(value: Value, seen = new WeakSet<object>()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function createResultMiddlewareRunner<Database>(
  options: CreateSupabaseMcpOptions<Database>,
): ResultMiddlewareRunner<Database> | undefined {
  if (!options.resultMiddleware) return undefined;
  const configured = Array.isArray(options.resultMiddleware)
    ? [...options.resultMiddleware]
    : [options.resultMiddleware as SupabaseMcpResultMiddleware<Database>];
  if (configured.length === 0) return undefined;
  if (configured.length > MAX_RESULT_MIDDLEWARE) {
    throw new RangeError(
      `createSupabaseMcp accepts at most ${MAX_RESULT_MIDDLEWARE} result middleware functions`,
    );
  }
  if (configured.some((middleware) => typeof middleware !== "function")) {
    throw new TypeError("resultMiddleware must contain only functions");
  }

  const reportFailure = (error: unknown, traceId: string): void => {
    try {
      const reported = options.onError?.({
        error: normalizeError(error),
        phase: "results",
        traceId,
      });
      void Promise.resolve(reported).catch(() => {});
    } catch {
      // An operator hook must not change the authored tool result.
    }
  };

  return {
    wrapRegistration(method, args, context) {
      const name = args[0];
      const callbackIndex = args.length - 1;
      const callback = args[callbackIndex];
      if (
        method !== "registerTool" ||
        typeof name !== "string" ||
        typeof callback !== "function"
      ) {
        return [...args];
      }

      const wrapped = async function (
        this: unknown,
        ...callbackArgs: unknown[]
      ): Promise<unknown> {
        const original = await Reflect.apply(callback, this, callbackArgs);
        if (
          !isCallToolResult(original) ||
          isInputRequiredResult(original) ||
          original.isError === true
        ) {
          return original;
        }

        let snapshot: CallToolResult;
        try {
          snapshot = deepFreeze(structuredClone(original));
        } catch (error) {
          reportFailure(error, context.traceId);
          return original;
        }

        let composition: ResultContentComposition = {};
        let composed = original;
        const input = Object.freeze({
          context,
          tool: Object.freeze({ name }),
          result: snapshot,
        });
        for (const middleware of configured) {
          try {
            const addition = await middleware(input);
            if (!addition) continue;
            const candidate = {
              prepend: [
                ...(composition.prepend ?? []),
                ...(addition.prepend ?? []),
              ],
              append: [
                ...(composition.append ?? []),
                ...(addition.append ?? []),
              ],
            } satisfies ResultContentComposition;
            composed = composeResultContent(original, candidate);
            composition = candidate;
          } catch (error) {
            reportFailure(error, context.traceId);
          }
        }
        return composed;
      };

      const wrappedArgs = [...args];
      wrappedArgs[callbackIndex] = wrapped;
      return wrappedArgs;
    },
  };
}

interface LifecycleEmitter<Database> {
  wrapRegistration(
    method: string,
    args: readonly unknown[],
    context: SupabaseMcpContext<Database>,
  ): unknown[];
}

function capabilityKind(method: string): SupabaseMcpCapabilityKind | undefined {
  if (method === "registerTool") return "tool";
  if (method === "registerPrompt") return "prompt";
  if (method === "registerResource" || method === "registerResourceTemplate") {
    return "resource";
  }
  return undefined;
}

function lifecycleOutcome(
  kind: SupabaseMcpCapabilityKind,
  result: unknown,
): SupabaseMcpLifecycleOutcome {
  if (isInputRequiredResult(result)) return "input-required";
  if (
    kind === "tool" &&
    typeof result === "object" &&
    result !== null &&
    "isError" in result &&
    result.isError === true
  ) {
    return "tool-error";
  }
  return "success";
}

const runFactIdPattern = /^run_[A-Za-z0-9_-]{43}$/;

function lifecycleRunFact(run: SupabaseMcpRunFact): SupabaseMcpRunFact {
  const startedAt = Date.parse(run.startedAt);
  const expiresAt = Date.parse(run.expiresAt);
  if (
    run.schemaVersion !== 1 ||
    !runFactIdPattern.test(run.id) ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(expiresAt) ||
    new Date(startedAt).toISOString() !== run.startedAt ||
    new Date(expiresAt).toISOString() !== run.expiresAt ||
    expiresAt <= startedAt
  ) {
    throw new Error("Run correlation returned an invalid fact");
  }
  return Object.freeze({
    schemaVersion: 1,
    id: run.id,
    startedAt: run.startedAt,
    expiresAt: run.expiresAt,
  });
}

function createLifecycleEmitter<Database>(
  options: CreateSupabaseMcpOptions<Database>,
  dependencies: RuntimeDependencies<Database>,
): LifecycleEmitter<Database> | undefined {
  if (!options.onEvent && !options.runCorrelation) return undefined;

  const now = (): number => dependencies.now?.() ?? Date.now();

  const server = Object.freeze({
    name: options.server.name,
    version: options.server.version,
  });

  const reportSinkFailure = (error: unknown, traceId: string): void => {
    try {
      const reported = (
        options.onError as
          | ((event: SupabaseMcpErrorEvent) => unknown)
          | undefined
      )?.({ error: normalizeError(error), phase: "events", traceId });
      void Promise.resolve(reported).catch(() => {});
    } catch {
      // An operator hook must not create a second lifecycle failure.
    }
  };

  const emit = (event: SupabaseMcpLifecycleEvent): void => {
    if (!options.onEvent) return;
    try {
      const pending = options.onEvent(event);
      void Promise.resolve(pending).catch((error) => {
        reportSinkFailure(error, event.traceId);
      });
    } catch (error) {
      reportSinkFailure(error, event.traceId);
    }
  };

  return {
    wrapRegistration(method, args, context) {
      const kind = capabilityKind(method);
      const name = args[0];
      const callbackIndex = args.length - 1;
      const callback = args[callbackIndex];
      if (!kind || typeof name !== "string" || typeof callback !== "function") {
        return [...args];
      }

      const authentication = Object.freeze({ ...context.authentication });
      const principal = context.principal
        ? Object.freeze({
            subject: context.principal.subject,
            ...(context.principal.clientId
              ? { clientId: context.principal.clientId }
              : {}),
            authentication: Object.freeze({
              ...context.principal.authentication,
            }),
          })
        : null;
      const capability = Object.freeze({ kind, name });
      const common = {
        traceId: context.traceId,
        server,
        capability,
        principal,
        authentication,
      };

      const wrapped = async function (
        this: unknown,
        ...callbackArgs: unknown[]
      ): Promise<unknown> {
        const run = options.runCorrelation
          ? await options.runCorrelation.resolve(context, {
              serverContext: callbackArgs.at(-1) as ServerContext,
              ...(kind === "tool" && callbackArgs.length > 1
                ? { toolArguments: callbackArgs[0] }
                : {}),
            })
          : undefined;
        const base = options.runCorrelation
          ? {
              ...common,
              schemaVersion: 2 as const,
              run: run ? lifecycleRunFact(run) : null,
            }
          : { ...common, schemaVersion: 1 as const };
        const startedAt = now();
        emit(
          Object.freeze({
            ...base,
            type: "capability.started" as const,
            timestamp: new Date(startedAt).toISOString(),
          }),
        );
        try {
          const result = await Reflect.apply(callback, this, callbackArgs);
          const finishedAt = now();
          emit(
            Object.freeze({
              ...base,
              type: "capability.finished" as const,
              timestamp: new Date(finishedAt).toISOString(),
              durationMs: Math.max(0, finishedAt - startedAt),
              outcome: lifecycleOutcome(kind, result),
            }),
          );
          return result;
        } catch (error) {
          const finishedAt = now();
          emit(
            Object.freeze({
              ...base,
              type: "capability.finished" as const,
              timestamp: new Date(finishedAt).toISOString(),
              durationMs: Math.max(0, finishedAt - startedAt),
              outcome: "failure" as const,
            }),
          );
          throw error;
        }
      };

      const wrappedArgs = [...args];
      wrappedArgs[callbackIndex] = wrapped;
      return wrappedArgs;
    },
  };
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

interface SurfaceListRequest {
  protocolVersion?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedUtf8(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    new TextEncoder().encode(value).byteLength <= maxBytes
  );
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => {});
  } catch {
    // The observed clone is disposable; the actual protocol body is untouched.
  }
}

async function boundedBodyText(
  body: Request | Response,
  maxBytes: number,
): Promise<string | null> {
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
  if (!clone.body) return "";
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
        // A cloned response is a tee. Waiting for cancellation can wait for the
        // untouched response branch, so cancellation must remain non-blocking.
        cancelReader(reader);
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    cancelReader(reader);
    return null;
  }
}

function protocolVersionFromRequest(
  request: Request,
  payload: Record<string, unknown>,
): string | undefined {
  const header = request.headers.get("mcp-protocol-version")?.trim();
  const params = isRecord(payload.params) ? payload.params : undefined;
  const meta = params && isRecord(params._meta) ? params._meta : undefined;
  const metadataVersion = meta?.["io.modelcontextprotocol/protocolVersion"];
  const candidate =
    header ||
    (typeof metadataVersion === "string" ? metadataVersion.trim() : "");
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : undefined;
}

async function inspectSurfaceListRequest(
  request: Request,
): Promise<SurfaceListRequest | null> {
  if (request.method !== "POST") return null;
  const text = await boundedBodyText(request, MAX_SURFACE_REQUEST_BYTES);
  if (text === null) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(payload) || payload.method !== "tools/list") return null;
  const params = isRecord(payload.params) ? payload.params : undefined;
  if (params && typeof params.cursor === "string") return null;
  const protocolVersion = protocolVersionFromRequest(request, payload);
  return protocolVersion ? { protocolVersion } : {};
}

function canonicalJsonValue(value: unknown, depth = 0): JsonValue | null {
  if (depth > MAX_SURFACE_JSON_DEPTH) return null;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const entry of value) {
      const normalized = canonicalJsonValue(entry, depth + 1);
      if (normalized === null && entry !== null) return null;
      result.push(normalized);
    }
    return Object.freeze(result) as unknown as JsonValue;
  }
  if (!isRecord(value)) return null;
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort(compareCanonicalText)) {
    const entry = value[key];
    const normalized = canonicalJsonValue(entry, depth + 1);
    if (normalized === null && entry !== null) return null;
    result[key] = normalized;
  }
  return Object.freeze(result);
}

function normalizedSurfaceAnnotations(
  value: unknown,
): SupabaseMcpSurfaceToolAnnotations | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const annotations: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  } = {};
  if (boundedUtf8(value.title, MAX_SURFACE_PROSE_BYTES)) {
    annotations.title = value.title;
  } else if (value.title !== undefined) {
    return null;
  }
  for (const key of [
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
  ] as const) {
    if (typeof value[key] === "boolean") annotations[key] = value[key];
    else if (value[key] !== undefined) return null;
  }
  return Object.keys(annotations).length > 0
    ? Object.freeze(annotations)
    : undefined;
}

function normalizedSurfaceTool(value: unknown): SupabaseMcpSurfaceTool | null {
  if (
    !isRecord(value) ||
    !boundedUtf8(value.name, MAX_SURFACE_NAME_BYTES) ||
    !value.name
  ) {
    return null;
  }
  if (
    (value.title !== undefined &&
      !boundedUtf8(value.title, MAX_SURFACE_PROSE_BYTES)) ||
    (value.description !== undefined &&
      !boundedUtf8(value.description, MAX_SURFACE_PROSE_BYTES))
  ) {
    return null;
  }
  if (!isRecord(value.inputSchema)) return null;
  const inputSchema = canonicalJsonValue(value.inputSchema);
  if (!isRecord(inputSchema)) return null;
  let outputSchema: Readonly<Record<string, JsonValue>> | undefined;
  if (value.outputSchema !== undefined) {
    if (!isRecord(value.outputSchema)) return null;
    const normalized = canonicalJsonValue(value.outputSchema);
    if (!isRecord(normalized)) return null;
    outputSchema = normalized as Readonly<Record<string, JsonValue>>;
  }
  const annotations = normalizedSurfaceAnnotations(value.annotations);
  if (annotations === null) return null;
  return Object.freeze({
    name: value.name,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.description === "string"
      ? { description: value.description }
      : {}),
    inputSchema: inputSchema as Readonly<Record<string, JsonValue>>,
    ...(outputSchema ? { outputSchema } : {}),
    ...(annotations ? { annotations } : {}),
  });
}

function jsonRpcPayloadFromResponse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice("data:".length).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const payload = JSON.parse(data) as unknown;
        if (isRecord(payload) && isRecord(payload.result)) return payload;
      } catch {
        // Ignore unrelated or malformed SSE events.
      }
    }
    return null;
  }
}

async function createSurfaceProof(
  response: Response,
  request: SurfaceListRequest,
  server: CreateSupabaseMcpOptions["server"],
  authentication: SupabaseMcpAuthentication,
): Promise<SupabaseMcpSurfaceProof | null> {
  if (!response.ok) return null;
  if (
    !boundedUtf8(server.name, MAX_SURFACE_SERVER_NAME_BYTES) ||
    !server.name ||
    !boundedUtf8(server.version, MAX_SURFACE_SERVER_VERSION_BYTES) ||
    !server.version ||
    !boundedUtf8(authentication.strategy, MAX_SURFACE_NAME_BYTES) ||
    !authentication.strategy
  ) {
    return null;
  }
  const text = await boundedBodyText(response, MAX_SURFACE_RESPONSE_BYTES);
  if (text === null) return null;
  const payload = jsonRpcPayloadFromResponse(text);
  if (!isRecord(payload) || payload.jsonrpc !== "2.0" || "error" in payload) {
    return null;
  }
  const result = isRecord(payload.result) ? payload.result : undefined;
  if (!result || !Array.isArray(result.tools) || result.nextCursor != null) {
    return null;
  }
  if (result.tools.length > MAX_SURFACE_TOOLS) return null;
  const tools: SupabaseMcpSurfaceTool[] = [];
  const names = new Set<string>();
  for (const value of result.tools) {
    const tool = normalizedSurfaceTool(value);
    if (!tool || names.has(tool.name)) return null;
    names.add(tool.name);
    tools.push(tool);
  }
  tools.sort((left, right) => compareCanonicalText(left.name, right.name));
  const frozenTools = Object.freeze(tools);
  const canonicalContent = JSON.stringify({
    schemaVersion: 1,
    tools: frozenTools,
  });
  if (
    new TextEncoder().encode(canonicalContent).byteLength >
    MAX_SURFACE_CANONICAL_BYTES
  ) {
    return null;
  }
  const contentDigest = `sha256:${await sha256(canonicalContent)}` as const;
  const proof: SupabaseMcpSurfaceProof = {
    schemaVersion: 1,
    server: Object.freeze({ name: server.name, version: server.version }),
    runtime: Object.freeze({
      name: "chumbo" as const,
      version: PACKAGE_VERSION,
    }),
    authentication: Object.freeze({ ...authentication }),
    ...(request.protocolVersion
      ? { protocolVersion: request.protocolVersion }
      : {}),
    tools: frozenTools,
    contentDigest,
  };
  if (
    new TextEncoder().encode(JSON.stringify(proof)).byteLength >
    MAX_SURFACE_PROOF_BYTES
  ) {
    return null;
  }
  return Object.freeze(proof);
}

function callerAddress(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

interface RateLimitRow {
  allowed: boolean;
  current_count: number;
  reset_at: string;
}

function rateLimitConfig(
  configured: true | SupabaseMcpPostgresRateLimit,
): Required<SupabaseMcpPostgresRateLimit> {
  const value = configured === true ? {} : configured;
  const requests = value.requests ?? DEFAULT_RATE_LIMIT.requests;
  const windowSeconds = value.windowSeconds ?? DEFAULT_RATE_LIMIT.windowSeconds;
  if (!Number.isSafeInteger(requests) || requests < 1) {
    throw new Error("Public rateLimit.requests must be a positive integer");
  }
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
    throw new Error(
      "Public rateLimit.windowSeconds must be a positive integer",
    );
  }
  return {
    requests,
    windowSeconds,
    functionName: value.functionName ?? DEFAULT_RATE_LIMIT.functionName,
  };
}

function jsonResponse(value: unknown, status = 200, cache = false): Response {
  return Response.json(value, {
    status,
    headers: {
      "access-control-allow-origin": "*",
      "cache-control": cache ? "public, max-age=300" : "no-store",
    },
  });
}

function responseWithHeaders(
  response: Response,
  values: Readonly<Record<string, string>>,
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(values)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function metadataPreflight(request: Request): Response | undefined {
  if (request.method !== "OPTIONS") return undefined;
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
    },
  });
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Unknown runtime error");
}

function runtimeVariable(name: string): string | undefined {
  const runtimeGlobal = globalThis as typeof globalThis & {
    Deno?: { env?: { get(variable: string): string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  const denoValue = runtimeGlobal.Deno?.env?.get(name);
  if (denoValue) return denoValue;
  return runtimeGlobal.process?.env?.[name];
}

function runtimeKeyMap(
  pluralName: string,
  singularName: string,
  legacyName: string,
): Record<string, string> | undefined {
  const pluralValue = runtimeVariable(pluralName);
  if (pluralValue) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(pluralValue);
    } catch {
      throw new Error(`${pluralName} must be valid JSON`);
    }
    if (
      !parsed ||
      Array.isArray(parsed) ||
      typeof parsed !== "object" ||
      Object.values(parsed).some((value) => typeof value !== "string")
    ) {
      throw new Error(`${pluralName} must be a JSON object of string values`);
    }
    const keys = parsed as Record<string, string>;
    if (Object.keys(keys).length > 0) return keys;
  }
  const singleValue =
    runtimeVariable(singularName) ?? runtimeVariable(legacyName);
  return singleValue ? { default: singleValue } : undefined;
}

function compatibleSupabaseEnv(
  env?: Partial<SupabaseEnv>,
): Partial<SupabaseEnv> | undefined {
  const resolved = { ...env };
  if (!resolved.url) {
    resolved.url = runtimeVariable("SUPABASE_URL");
  }
  resolved.publishableKeys ??= runtimeKeyMap(
    "SUPABASE_PUBLISHABLE_KEYS",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_ANON_KEY",
  );
  resolved.secretKeys ??= runtimeKeyMap(
    "SUPABASE_SECRET_KEYS",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  );
  if (resolved.jwks === undefined) {
    const jwks = runtimeVariable("SUPABASE_JWKS");
    if (jwks) {
      try {
        resolved.jwks = JSON.parse(jwks) as InlineJwks;
      } catch {
        throw new Error("SUPABASE_JWKS must be valid JSON");
      }
    }
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

async function loadRemoteJwks(url: URL): Promise<InlineJwks> {
  const key = url.href;
  const now = Date.now();
  const cached = remoteJwksCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = fetch(url, {
    headers: { accept: "application/json" },
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(`JWKS endpoint returned HTTP ${response.status}`);
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_JWKS_BYTES) {
      throw new Error("JWKS response exceeds 64 KiB");
    }
    const parsed = JSON.parse(text) as Partial<InlineJwks>;
    if (!Array.isArray(parsed.keys)) {
      throw new Error("JWKS response has no keys array");
    }
    return { keys: parsed.keys };
  });
  remoteJwksCache.set(key, {
    expiresAt: now + REMOTE_JWKS_TTL_MS,
    value,
  });
  value.catch(() => {
    if (remoteJwksCache.get(key)?.value === value) remoteJwksCache.delete(key);
  });
  return value;
}

async function verificationEnv(
  env?: Partial<SupabaseEnv>,
): Promise<Partial<SupabaseEnv> | undefined> {
  if (!(env?.jwks instanceof URL)) return env;
  return { ...env, jwks: await loadRemoteJwks(env.jwks) };
}

export const defaultRuntimeDependencies: RuntimeDependencies = {
  async verifyToken(token, env) {
    const resolvedEnv = await verificationEnv(compatibleSupabaseEnv(env));
    const result = await verifyCredentials(
      { token, apikey: null },
      { auth: "user", env: resolvedEnv },
    );
    if (result.error || !result.data.userClaims || !result.data.jwtClaims) {
      throw new OAuthError(
        OAuthErrorCode.InvalidToken,
        "Invalid or expired access token",
      );
    }
    return {
      token,
      userClaims: result.data.userClaims,
      jwtClaims: result.data.jwtClaims,
    };
  },
  createClient(token, env) {
    return createContextClient({
      auth: { token },
      env: compatibleSupabaseEnv(env),
    });
  },
  createAdminClient(env) {
    return createAdminClient({ env: compatibleSupabaseEnv(env) });
  },
  fetch: globalThis.fetch.bind(globalThis),
  now: () => Date.now(),
  randomUUID: () => crypto.randomUUID(),
};

export function createSupabaseMcpInternal<Database = unknown>(
  options: CreateSupabaseMcpOptions<Database>,
  dependencies: RuntimeDependencies<Database>,
): SupabaseMcpApp {
  const auth = options.auth ?? { mode: "oauth" as const };
  if (auth.mode === "public" && options.state) {
    throw new Error("Durable state requires protected authentication");
  }
  const strategies = protectedStrategies(auth);
  validateStrategies(strategies, auth.mode === "multi");
  const stateFactory = options.state
    ? createSupabaseMcpStateFactory(options.state)
    : undefined;
  const lifecycle = createLifecycleEmitter(options, dependencies);
  const resultMiddleware = createResultMiddlewareRunner(options);
  const oauthStrategy = strategies.find(
    (strategy) => strategy.mode === "oauth",
  );
  const resourceUrl = trimTrailingSlash(new URL(options.resourceUrl));
  const resourceMetadataUrl = appendPath(
    resourceUrl,
    ".well-known/oauth-protected-resource",
  );
  const authorizationMetadataMirrorUrl = appendPath(
    resourceUrl,
    ".well-known/oauth-authorization-server",
  );
  const issuer = oauthStrategy
    ? trimTrailingSlash(
        new URL(oauthStrategy.issuer ?? `${resourceUrl.origin}/auth/v1`),
      )
    : undefined;
  const authorizationServerMetadataUrl = oauthStrategy
    ? new URL(
        oauthStrategy.authorizationServerMetadataUrl ??
          metadataUrlForIssuer(issuer!),
      )
    : undefined;
  const advertisedScopes = oauthStrategy
    ? [...(oauthStrategy.scopes ?? DEFAULT_SCOPES)]
    : [];
  const publicRateLimit =
    auth.mode === "public" && auth.rateLimit
      ? rateLimitConfig(auth.rateLimit)
      : undefined;
  const runtimeHeaders = {
    "access-control-expose-headers":
      "x-chumbo-version, x-chumbo-auth-mode, x-chumbo-auth-strategy, x-chumbo-resource-url, x-supa-mcp-version, x-supa-mcp-auth-mode, x-supa-mcp-auth-strategy, x-supa-mcp-resource-url",
    "x-chumbo-version": PACKAGE_VERSION,
    "x-chumbo-auth-mode": auth.mode,
    "x-chumbo-resource-url": resourceUrl.href,
    "x-supa-mcp-version": PACKAGE_VERSION,
    "x-supa-mcp-auth-mode": auth.mode,
    "x-supa-mcp-resource-url": resourceUrl.href,
    ...(auth.mode === "api-key"
      ? {
          "x-chumbo-auth-strategy":
            typeof auth.key === "string" ? "static" : "verifier",
          "x-supa-mcp-auth-strategy":
            typeof auth.key === "string" ? "static" : "verifier",
        }
      : auth.mode === "multi"
        ? {
            "x-chumbo-auth-strategy": "composed",
            "x-supa-mcp-auth-strategy": "composed",
          }
        : {}),
  };

  async function buildContext(
    value: Omit<
      SupabaseMcpContext<Database>,
      "scopes" | "hasScope" | "hasScopes"
    >,
    initialScopes: readonly string[],
  ): Promise<SupabaseMcpContext<Database>> {
    const initial = contextWithScopes(value, initialScopes);
    const resolved = options.access?.resolveScopes
      ? await options.access.resolveScopes(initial)
      : initialScopes;
    return contextWithScopes(value, resolved);
  }

  let oauthMetadataPromise: Promise<OAuthMetadata> | undefined;
  const loadOAuthMetadata = (): Promise<OAuthMetadata> => {
    if (!authorizationServerMetadataUrl) {
      return Promise.reject(new Error("OAuth metadata is not configured"));
    }
    oauthMetadataPromise ??= dependencies
      .fetch(authorizationServerMetadataUrl, {
        headers: { accept: "application/json" },
      })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            `Authorization server metadata returned HTTP ${response.status}`,
          );
        }
        const metadata = (await response.json()) as OAuthMetadata;
        if (metadata.issuer !== issuer!.href.replace(/\/$/, "")) {
          throw new Error("Authorization server metadata issuer mismatch");
        }
        return metadata;
      })
      .catch((error) => {
        oauthMetadataPromise = undefined;
        throw error;
      });
    return oauthMetadataPromise;
  };

  const mcpHandler = createMcpHandler(
    async (mcpContext) => {
      const request = mcpContext.requestInfo;
      if (!request) throw new Error("MCP HTTP request context is unavailable");

      let context: SupabaseMcpContext<Database>;
      if (auth.mode === "public") {
        context = await buildContext(
          {
            request,
            supabase: dependencies.createClient(null, options.supabase?.env),
            user: null,
            jwtClaims: null,
            principal: null,
            authentication: { mode: "public", strategy: "public" },
            traceId: dependencies.randomUUID(),
          },
          auth.scopes ?? [],
        );
      } else {
        const extra = mcpContext.authInfo?.extra;
        const stored = extra?.[CONTEXT_KEY] as
          | SupabaseMcpContext<Database>
          | undefined;
        if (!stored)
          throw new Error("Authenticated request context is unavailable");
        context = stored;
      }

      const instructions =
        typeof options.instructions === "function"
          ? await options.instructions(context)
          : options.instructions;
      const server = new McpServer(
        options.server,
        instructions ? { instructions } : undefined,
      );
      await options.register(
        scopedServer(server, context, lifecycle, resultMiddleware),
        context,
      );
      return server;
    },
    {
      legacy: options.protocol?.legacy ?? "stateless",
      responseMode: options.protocol?.responseMode ?? "auto",
      onerror(error) {
        options.onError?.({ error, phase: "mcp" });
      },
    },
  );

  const reportSurfaceFailure = (error: unknown): void => {
    try {
      options.onError?.({ error: normalizeError(error), phase: "surface" });
    } catch {
      // An operator hook must not change the successful discovery response.
    }
  };

  async function fetchMcp(
    request: Request,
    authentication: SupabaseMcpAuthentication,
    authInfo?: AuthInfo,
  ): Promise<Response> {
    const surfaceRequest = options.onSurface
      ? await inspectSurfaceListRequest(request)
      : null;
    const response = authInfo
      ? await mcpHandler.fetch(request, { authInfo })
      : await mcpHandler.fetch(request);
    if (!surfaceRequest || !options.onSurface) return response;
    try {
      const proof = await createSurfaceProof(
        response,
        surfaceRequest,
        options.server,
        authentication,
      );
      if (!proof) return response;
      try {
        const pending = options.onSurface(proof);
        void Promise.resolve(pending).catch(reportSurfaceFailure);
      } catch (error) {
        reportSurfaceFailure(error);
      }
    } catch (error) {
      reportSurfaceFailure(error);
    }
    return response;
  }

  const bearerGate =
    auth.mode === "public"
      ? undefined
      : requireBearerAuth({
          resourceMetadataUrl: oauthStrategy
            ? resourceMetadataUrl.href
            : undefined,
          verifier: {
            async verifyAccessToken(token: string): Promise<AuthInfo> {
              let failurePhase: "auth" | "runtime" = "auth";
              try {
                const apiKeyStrategies = strategies.filter(
                  (strategy): strategy is SupabaseMcpApiKeyAuth<Database> =>
                    strategy.mode === "api-key",
                );
                let selected = apiKeyStrategies.find(
                  (strategy) =>
                    typeof strategy.key === "string" && strategy.key === token,
                );
                selected ??= apiKeyStrategies.find(
                  (strategy) =>
                    Boolean(strategy.tokenPrefix) &&
                    token.startsWith(strategy.tokenPrefix!),
                );
                const userStrategy = strategies.find(
                  (strategy) =>
                    strategy.mode === "oauth" || strategy.mode === "bearer",
                );
                if (
                  !selected &&
                  !userStrategy &&
                  apiKeyStrategies.length === 1
                ) {
                  selected = apiKeyStrategies[0];
                }

                if (selected) {
                  const verified =
                    typeof selected.key === "string"
                      ? (await sha256(token)) === (await sha256(selected.key))
                        ? {
                            subject: selected.subject ?? "api-key",
                            scopes: selected.scopes,
                          }
                        : null
                      : await (async () => {
                          failurePhase = "runtime";
                          const supabaseAdmin = dependencies.createAdminClient(
                            options.supabase?.env,
                          );
                          failurePhase = "auth";
                          return selected.verify({ token, supabaseAdmin });
                        })();
                  if (!verified) {
                    throw new OAuthError(
                      OAuthErrorCode.InvalidToken,
                      "Invalid API key",
                    );
                  }
                  const subject = verified.subject.trim();
                  if (!subject) {
                    throw new Error(
                      "API-key verifier returned an empty subject",
                    );
                  }
                  failurePhase = "runtime";
                  const supabase = dependencies.createClient(
                    null,
                    options.supabase?.env,
                  );
                  const requestIdentity: RequestIdentity<Database> = {
                    token,
                    userClaims: null,
                    jwtClaims: null,
                    supabase,
                    subject,
                    clientId: verified.clientId,
                    scopes: normalizedScopes(
                      verified.scopes ?? selected.scopes ?? [],
                    ),
                    authentication: {
                      mode: "api-key",
                      strategy: strategyName(selected),
                    },
                  };
                  return {
                    token,
                    clientId: requestIdentity.clientId ?? subject,
                    scopes: requestIdentity.scopes,
                    // The MCP bearer middleware requires an expiry timestamp.
                    // Application keys are non-expiring unless their verifier
                    // rejects them, so represent that contract explicitly.
                    expiresAt: Number.MAX_SAFE_INTEGER,
                    extra: { [IDENTITY_KEY]: requestIdentity },
                  };
                }
                if (!userStrategy) {
                  throw new OAuthError(
                    OAuthErrorCode.InvalidToken,
                    "Invalid access token",
                  );
                }
                const identity = await dependencies.verifyToken(
                  token,
                  options.supabase?.env,
                );
                const exp = identity.jwtClaims.exp;
                if (typeof exp !== "number") {
                  throw new OAuthError(
                    OAuthErrorCode.InvalidToken,
                    "Access token has no expiration",
                  );
                }
                failurePhase = "runtime";
                const supabase = dependencies.createClient(
                  token,
                  options.supabase?.env,
                );
                const requestIdentity: RequestIdentity<Database> = {
                  ...identity,
                  supabase,
                  subject: identity.userClaims.id,
                  clientId: actualClientId(identity.jwtClaims),
                  scopes: scopesFromClaims(identity.jwtClaims),
                  authentication: {
                    mode: userStrategy.mode,
                    strategy: strategyName(userStrategy),
                  },
                };
                return {
                  token,
                  clientId: requestIdentity.clientId ?? identity.userClaims.id,
                  scopes: requestIdentity.scopes,
                  expiresAt: exp,
                  extra: { [IDENTITY_KEY]: requestIdentity },
                };
              } catch (error) {
                options.onError?.({
                  error: normalizeError(error),
                  phase: failurePhase,
                });
                if (error instanceof OAuthError) throw error;
                if (failurePhase === "runtime") {
                  throw new OAuthError(
                    OAuthErrorCode.ServerError,
                    "Authentication runtime unavailable",
                  );
                }
                throw new OAuthError(
                  OAuthErrorCode.InvalidToken,
                  "Invalid or expired access token",
                );
              }
            },
          },
        });

  async function serveMetadata(
    request: Request,
  ): Promise<Response | undefined> {
    if (!oauthStrategy) return undefined;
    const pathname = new URL(request.url).pathname.replace(/\/+$/, "");
    const protectedPath = resourceMetadataUrl.pathname.replace(/\/+$/, "");
    const authorizationPath = authorizationMetadataMirrorUrl.pathname.replace(
      /\/+$/,
      "",
    );
    // Supabase's hosted gateway strips `/functions/v1` before forwarding the
    // request URL to Edge Runtime. Match the canonical external path and the
    // stable metadata suffix so this also works locally and elsewhere.
    const protectedRoute =
      pathname === protectedPath ||
      pathname.endsWith("/.well-known/oauth-protected-resource");
    const authorizationRoute =
      pathname === authorizationPath ||
      pathname.endsWith("/.well-known/oauth-authorization-server");
    if (!protectedRoute && !authorizationRoute) {
      return undefined;
    }
    const preflight = metadataPreflight(request);
    if (preflight) return preflight;
    if (request.method !== "GET") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "GET, OPTIONS" },
      });
    }
    try {
      const metadata = await loadOAuthMetadata();
      if (authorizationRoute) return jsonResponse(metadata, 200, true);
      return jsonResponse(
        buildOAuthProtectedResourceMetadata({
          oauthMetadata: metadata,
          resourceServerUrl: resourceUrl,
          resourceName: options.server.name,
          scopesSupported: advertisedScopes,
        }),
        200,
        true,
      );
    } catch (error) {
      options.onError?.({ error: normalizeError(error), phase: "metadata" });
      return jsonResponse(
        { error: "authorization_server_metadata_unavailable" },
        502,
      );
    }
  }

  async function fetchRequest(request: Request): Promise<Response> {
    const metadata = await serveMetadata(request);
    if (metadata) return metadata;

    let rateHeaders: Record<string, string> | undefined;
    if (publicRateLimit && request.method === "POST") {
      try {
        const admin = dependencies.createAdminClient(options.supabase?.env);
        const key = await sha256(
          `${resourceUrl.href}|${callerAddress(request)}`,
        );
        const { data, error } = await admin.rpc(
          publicRateLimit.functionName as never,
          {
            p_key: key,
            p_limit: publicRateLimit.requests,
            p_window_seconds: publicRateLimit.windowSeconds,
          } as never,
        );
        if (error) throw error;
        const row = (Array.isArray(data) ? data[0] : data) as
          | RateLimitRow
          | undefined;
        if (!row || typeof row.allowed !== "boolean") {
          throw new Error("Rate-limit RPC returned an invalid result");
        }
        const resetSeconds = Math.max(
          1,
          Math.ceil((Date.parse(row.reset_at) - Date.now()) / 1000),
        );
        const resetAt = String(Math.ceil(Date.parse(row.reset_at) / 1000));
        if (!row.allowed) {
          return Response.json(
            { error: "rate_limit_exceeded" },
            {
              status: 429,
              headers: {
                "access-control-allow-origin": "*",
                "cache-control": "no-store",
                "retry-after": String(resetSeconds),
                "x-ratelimit-limit": String(publicRateLimit.requests),
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": resetAt,
              },
            },
          );
        }
        rateHeaders = {
          "x-ratelimit-limit": String(publicRateLimit.requests),
          "x-ratelimit-remaining": String(
            Math.max(0, publicRateLimit.requests - row.current_count),
          ),
          "x-ratelimit-reset": resetAt,
        };
      } catch (error) {
        options.onError?.({
          error: normalizeError(error),
          phase: "rate-limit",
        });
        return jsonResponse({ error: "rate_limit_unavailable" }, 503);
      }
    }

    if (!bearerGate) {
      const response = await fetchMcp(request, {
        mode: "public",
        strategy: "public",
      });
      return rateHeaders
        ? responseWithHeaders(response, rateHeaders)
        : response;
    }
    const authInfo = await bearerGate(request);
    if (authInfo instanceof Response) return authInfo;

    const identity = authInfo.extra?.[IDENTITY_KEY] as
      | RequestIdentity<Database>
      | undefined;
    if (!identity) {
      options.onError?.({
        error: new Error("Verified identity was not attached"),
        phase: "runtime",
      });
      return jsonResponse({ error: "server_error" }, 500);
    }
    const traceId = dependencies.randomUUID();
    let context: SupabaseMcpContext<Database>;
    try {
      let state: SupabaseMcpContext<Database>["state"];
      if (stateFactory) {
        try {
          state = await stateFactory.create(
            {
              credential: identity.token,
              authentication: identity.authentication,
            },
            dependencies.createAdminClient(
              options.state?.supabase?.env ?? options.supabase?.env,
            ),
          );
        } catch {
          throw new SupabaseMcpStateUnavailableError();
        }
      }
      context = await buildContext(
        {
          request,
          supabase: identity.supabase,
          user: identity.userClaims,
          jwtClaims: identity.jwtClaims,
          subject: identity.subject,
          clientId: identity.clientId,
          principal: {
            subject: identity.subject,
            ...(identity.clientId ? { clientId: identity.clientId } : {}),
            authentication: identity.authentication,
          },
          authentication: identity.authentication,
          traceId,
          ...(state ? { state } : {}),
        },
        identity.scopes,
      );
    } catch (error) {
      options.onError?.({
        error: normalizeError(error),
        phase: "runtime",
        traceId,
      });
      return jsonResponse({ error: "server_error", traceId }, 500);
    }
    authInfo.extra = { ...authInfo.extra, [CONTEXT_KEY]: context };
    return fetchMcp(request, context.authentication, authInfo);
  }

  return {
    async fetch(request) {
      return responseWithHeaders(await fetchRequest(request), runtimeHeaders);
    },
    close: mcpHandler.close,
    notify: mcpHandler.notify,
  };
}

export function createSupabaseMcp<Database = unknown>(
  options: CreateSupabaseMcpOptions<Database>,
): SupabaseMcpApp {
  return createSupabaseMcpInternal(
    options,
    defaultRuntimeDependencies as RuntimeDependencies<Database>,
  );
}

export const oauthDefaults = Object.freeze({
  scopes: DEFAULT_SCOPES,
});

export const runtimeUrls = {
  resourceMetadata(resourceUrl: string | URL): URL {
    return appendPath(
      trimTrailingSlash(new URL(resourceUrl)),
      ".well-known/oauth-protected-resource",
    );
  },
  authorizationMetadataMirror(resourceUrl: string | URL): URL {
    return appendPath(
      trimTrailingSlash(new URL(resourceUrl)),
      ".well-known/oauth-authorization-server",
    );
  },
  authorizationServerMetadata(issuer: string | URL): URL {
    return metadataUrlForIssuer(trimTrailingSlash(new URL(issuer)));
  },
};
