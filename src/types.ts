import type {
  CallToolResult,
  ClientCapabilities,
  Implementation,
  McpServer,
  ServerContext,
  ServerEventBus,
  ServerNotifier,
} from "@modelcontextprotocol/server";
import type { JWTClaims, SupabaseEnv, UserClaims } from "@supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { JsonValue, ResultContentComposition } from "./results.js";

export type DeepReadonly<Value> = Value extends (...args: never[]) => unknown
  ? Value
  : Value extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

export const RESERVED_CLI_ROOT_COMMANDS = Object.freeze([
  "login",
  "logout",
  "status",
  "commands",
  "skill",
  "completions",
  "help",
] as const);

export type ReservedCliRootCommand =
  (typeof RESERVED_CLI_ROOT_COMMANDS)[number];

export interface SupabaseMcpApiKeyIdentity {
  /** Stable application-owned identity for audit logs and scope resolution. */
  readonly subject: string;
  /** Optional MCP client identifier associated with this key. */
  readonly clientId?: string;
  /** Application capability scopes granted to this key. */
  readonly scopes?: readonly string[];
}

/** A verified OAuth access token from an application-owned authorization server.
 * The verifier must check issuer, audience/resource, expiry and revocation.
 * Chumbo does not forward this token to Supabase. */
export interface SupabaseMcpOAuthIdentity {
  readonly subject: string;
  readonly clientId?: string;
  readonly scopes?: readonly string[];
  /** Unix seconds, as required by the MCP bearer middleware. */
  readonly expiresAt: number;
}

/** Canonical OAuth coordinates advertised by this MCP resource server.
 * Verify the token against both values before returning an identity. */
export interface SupabaseMcpOAuthVerifyContext {
  readonly token: string;
  readonly resourceUrl: string;
  readonly issuer: string;
}

export type SupabaseMcpAuthMode = "oauth" | "bearer" | "api-key" | "public";

export interface SupabaseMcpAuthentication {
  /** The credential family that authenticated this request. */
  readonly mode: SupabaseMcpAuthMode;
  /** Stable builder-defined strategy name for logs and policy decisions. */
  readonly strategy: string;
}

export interface SupabaseMcpPrincipal {
  readonly subject: string;
  readonly clientId?: string;
  readonly authentication: SupabaseMcpAuthentication;
}

export interface SupabaseMcpRunScope {
  /** Stable builder project or installed-integration boundary. */
  readonly installation: string;
  /** Stable MCP surface or server boundary inside that installation. */
  readonly surface: string;
  /** Builder-authorized caller, account, or tenant partition. */
  readonly partition: string;
}

export interface SupabaseMcpRunCorrelationKey {
  /** Stable identifier carried by handles so rotations can select one key. */
  readonly version: string;
  /** Deployment secret used only for run-handle HMAC operations. */
  readonly secret: string;
}

export interface SupabaseMcpPreviousRunCorrelationKey extends SupabaseMcpRunCorrelationKey {
  /** ISO 8601 end of the explicit verification overlap for this old key. */
  readonly acceptUntil: string;
}

export interface SupabaseMcpRunFact {
  readonly schemaVersion: 1;
  /** Scope-bound opaque correlation ID safe for lifecycle events and state keys. */
  readonly id: string;
  readonly startedAt: string;
  readonly expiresAt: string;
}

/** Opaque HMAC-signed wire carrier string (`crun1.<payload>.<mac>`). */
export type RunHandle = string;
export type RunScope = SupabaseMcpRunScope;
export type RunCorrelationKey = SupabaseMcpRunCorrelationKey;
export type PreviousRunCorrelationKey = SupabaseMcpPreviousRunCorrelationKey;
export type RunFact = SupabaseMcpRunFact;

export interface MintedRun {
  /** Opaque signed value carried by a controlled client or run-aware tool. */
  readonly handle: RunHandle;
  /** The bounded fact the same server will recover from handle. */
  readonly run: SupabaseMcpRunFact;
}

/**
 * @deprecated Prefer `MintedRun` for `{ handle, run }` pairs returned by `mint`,
 * or `RunHandle` (`string`) for wire handle carriers.
 */
export type SupabaseMcpRunHandle = MintedRun;

export interface SupabaseMcpRunCorrelationOptions<Database = unknown> {
  readonly currentKey: SupabaseMcpRunCorrelationKey;
  readonly previousKey?: SupabaseMcpPreviousRunCorrelationKey;
  /** Defaults to four hours or maxTtlSeconds when that ceiling is shorter. */
  readonly ttlSeconds?: number;
  /** Maximum caller-selected lifetime. Defaults to thirty days. */
  readonly maxTtlSeconds?: number;
  /** Explicit tool argument carrying a handle. Defaults to `run_id`. */
  readonly argumentName?: string;
  /**
   * How invalid or expired run handles behave during invocation:
   * - `"reject"` (default): throw `SupabaseMcpRunCorrelationError` before capability code runs.
   * - `"ignore"`: degrade to `run = null` and record `runRejected` on `capability.finished`.
   */
  readonly onInvalidHandle?: "reject" | "ignore";
  /**
   * Issue and verify a stateless HMAC-signed `Mcp-Session-Id` header on MCP
   * sessions so clients correlate multi-step runs with zero tool-argument cost.
   */
  readonly sessionHeader?: boolean | { readonly headerName?: string };
  /**
   * Resolve the application-owned boundary used to mint and verify a handle.
   * The same logical run must resolve the same scope on every request.
   */
  scope(
    context: SupabaseMcpContext<Database>,
  ): SupabaseMcpRunScope | Promise<SupabaseMcpRunScope>;
}

export type RunCorrelationOptions<Database = unknown> =
  SupabaseMcpRunCorrelationOptions<Database>;

export interface SupabaseMcpMintRunOptions {
  /** Defaults to the correlation instance's configured lifetime. */
  readonly ttlSeconds?: number;
}

export type MintRunOptions = SupabaseMcpMintRunOptions;

export interface SupabaseMcpResolveRunInput {
  readonly serverContext: ServerContext;
  /** Parsed arguments for a tool that deliberately exposes the configured field. */
  readonly toolArguments?: unknown;
}

export type ResolveRunInput = SupabaseMcpResolveRunInput;

export interface SupabaseMcpRunCorrelation<Database = unknown> {
  readonly argumentName?: string;
  mint(
    context: SupabaseMcpContext<Database>,
    options?: SupabaseMcpMintRunOptions,
  ): Promise<MintedRun>;
  resolve(
    context: SupabaseMcpContext<Database>,
    input: SupabaseMcpResolveRunInput,
  ): Promise<SupabaseMcpRunFact | null>;
}

export type SupabaseMcpCapabilityKind = "tool" | "resource" | "prompt";

export interface SupabaseMcpLifecycleCapability {
  readonly kind: SupabaseMcpCapabilityKind;
  readonly name: string;
  /** Underlying canonical tool name when an active capability profile aliases `name`. */
  readonly canonicalName?: string;
}

export interface SupabaseMcpLifecycleServer {
  readonly name: string;
  readonly version: string;
}

export type SupabaseMcpLifecycleOutcome =
  | "success"
  | "tool-error"
  | "input-required"
  | "failure";

interface SupabaseMcpLifecycleEventCommon {
  /** ISO 8601 time at which this lifecycle transition occurred. */
  readonly timestamp: string;
  readonly traceId: string;
  readonly server: SupabaseMcpLifecycleServer;
  readonly capability: SupabaseMcpLifecycleCapability;
  readonly principal: SupabaseMcpPrincipal | null;
  readonly authentication: SupabaseMcpAuthentication;
}

interface SupabaseMcpLifecycleEventV1 extends SupabaseMcpLifecycleEventCommon {
  readonly schemaVersion: 1;
}

interface SupabaseMcpLifecycleEventV2 extends SupabaseMcpLifecycleEventCommon {
  readonly schemaVersion: 2;
  /** Explicit application run, or null when this invocation supplied no handle. */
  readonly run: SupabaseMcpRunFact | null;
}

export interface SupabaseMcpCapabilityStartedEventV1 extends SupabaseMcpLifecycleEventV1 {
  readonly type: "capability.started";
}

export interface SupabaseMcpCapabilityFinishedEventV1 extends SupabaseMcpLifecycleEventV1 {
  readonly type: "capability.finished";
  readonly durationMs: number;
  readonly outcome: SupabaseMcpLifecycleOutcome;
  readonly errorCode?: string;
}

export interface SupabaseMcpCapabilityStartedEventV2 extends SupabaseMcpLifecycleEventV2 {
  readonly type: "capability.started";
  readonly sessionId?: string;
}

export interface SupabaseMcpCapabilityFinishedEventV2 extends SupabaseMcpLifecycleEventV2 {
  readonly type: "capability.finished";
  readonly durationMs: number;
  readonly outcome: SupabaseMcpLifecycleOutcome;
  readonly errorCode?: string;
  readonly runRejected?: string;
  readonly sessionId?: string;
}

export type SupabaseMcpCapabilityStartedEvent =
  | SupabaseMcpCapabilityStartedEventV1
  | SupabaseMcpCapabilityStartedEventV2;

export type SupabaseMcpCapabilityFinishedEvent =
  | SupabaseMcpCapabilityFinishedEventV1
  | SupabaseMcpCapabilityFinishedEventV2;

/** Redacted, request-scoped facts emitted around capability invocation. */
export type SupabaseMcpLifecycleEvent =
  | SupabaseMcpCapabilityStartedEvent
  | SupabaseMcpCapabilityFinishedEvent;

export interface SupabaseMcpSurfaceToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

/** One tool exactly as advertised to the successful discovery caller. */
export interface SupabaseMcpSurfaceTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, JsonValue>>;
  readonly outputSchema?: Readonly<Record<string, JsonValue>>;
  readonly annotations?: SupabaseMcpSurfaceToolAnnotations;
}

/**
 * Canonical, redacted evidence derived from one complete successful tools/list.
 * It deliberately contains no caller identity, scopes, credentials, or traffic.
 */
export interface SupabaseMcpSurfaceProof {
  readonly schemaVersion: 1;
  readonly server: SupabaseMcpLifecycleServer;
  readonly runtime: {
    readonly name: "chumbo";
    readonly version: string;
  };
  readonly authentication: SupabaseMcpAuthentication;
  readonly protocolVersion?: string;
  /** Active capability profile ID when `profiles` is configured on this server. */
  readonly profile?: string;
  readonly tools: readonly SupabaseMcpSurfaceTool[];
  /** SHA-256 of canonical JSON containing schemaVersion and tools. */
  readonly contentDigest: `sha256:${string}`;
}

export interface SupabaseMcpClientInfo {
  readonly name: string;
  readonly version: string;
  readonly title?: string;
}

export type ResourceLinkSupport = "supported" | "unsupported" | "unknown";

export interface SupabaseMcpClientSupport {
  /** Client declared `elicitation: {}` or `elicitation.form` (supports form MRTR). */
  readonly elicitationForm: boolean;
  /** Client declared `elicitation.url` (supports out-of-band URL elicitation). */
  readonly elicitationUrl: boolean;
  /** Client declared `extensions["io.modelcontextprotocol/ui"]` (renders `ui://` MCP Apps). */
  readonly mcpAppsUi: boolean;
  /** Client declared `sampling`. */
  readonly sampling: boolean;
  /** Client declared `roots`. */
  readonly roots: boolean;
  /**
   * Host heuristic for `resource_link` content blocks (`ClientCapabilities` has
   * no wire bit for `resource_link`). Defaults to `"unknown"`, or `"unsupported"`
   * for known non-resource bridges or builder-configured `clientPolicy.resourceLinks`.
   */
  readonly resourceLinks: ResourceLinkSupport;
}

export interface SupabaseMcpClientContext {
  /** Protocol era of the current HTTP exchange. */
  readonly era: "modern" | "legacy";
  /** Validated `YYYY-MM-DD` protocol revision when known. */
  readonly protocolVersion?: string;
  /** Validated client `Implementation` when carried on this request (`initialize` or 2026 envelope). */
  readonly info: SupabaseMcpClientInfo | null;
  /** Raw validated `ClientCapabilities` from this request when present, deeply frozen. */
  readonly capabilities: DeepReadonly<ClientCapabilities> | null;
  /** Normalized feature flags (recovered across 2025 requests via `cs1_` session bitmask). */
  readonly supports: SupabaseMcpClientSupport;
}

export interface SupabaseMcpClientPolicy {
  /** Override `supports.resourceLinks` classification based on `clientInfo` or `User-Agent`. */
  resourceLinks?(input: {
    readonly info: SupabaseMcpClientInfo | null;
    readonly userAgent: string | null;
  }): ResourceLinkSupport;
}

export interface McpCorsOptions {
  /**
   * Allowed browser origins (`["https://claude.ai"]`, `"*"`, or predicate).
   * Literal `"null"` origins are always rejected with HTTP 403.
   */
  readonly origins: readonly string[] | "*" | ((origin: string) => boolean);
  /** Additional request headers allowed in preflight beyond standard MCP headers. */
  readonly allowHeaders?: readonly string[];
  /** Additional response headers exposed to browser JS beyond MCP/Chumbo defaults. */
  readonly exposeHeaders?: readonly string[];
  /** `Access-Control-Max-Age` in seconds on `204` preflights. Defaults to `600`. */
  readonly maxAgeSeconds?: number;
}

export interface McpTransportArmorOptions {
  /**
   * How server-push subscription streams (`GET` SSE and `POST` `subscriptions/listen`)
   * are handled. Defaults to `"disabled"` on stateless endpoints.
   */
  readonly subscriptions?: "disabled" | "in-memory" | ServerEventBus;
  /**
   * Stateless `Mcp-Session-Id` header issuance on 2025-era `initialize` responses.
   * Defaults to `"stateless"`.
   */
  readonly sessionId?: "stateless" | "disabled";
}

export interface SupabaseMcpApiKeyVerifyContext<Database = unknown> {
  readonly token: string;
  /**
   * Privileged client available only while verifying the key. It is never
   * exposed to tools through SupabaseMcpContext.
   */
  readonly supabaseAdmin: SupabaseClient<Database>;
}

export type SupabaseMcpApiKeyAuth<Database = unknown> = {
  mode: "api-key";
  /** Stable name exposed as ctx.authentication.strategy. */
  strategy?: string;
  /**
   * Credential prefix used to select this verifier without trying another
   * authentication strategy. Required for verifier-backed keys in multi mode.
   */
  tokenPrefix?: string;
  /** Default scopes for a static key or a verifier result that omits scopes. */
  scopes?: readonly string[];
} & (
  | {
      /** Simple single-key mode, normally loaded from an Edge Function secret. */
      key: string;
      /** Stable subject exposed as ctx.subject. Defaults to "api-key". */
      subject?: string;
      verify?: never;
    }
  | {
      key?: never;
      subject?: never;
      /** Resolve an application-owned key table or existing key service. */
      verify(
        context: SupabaseMcpApiKeyVerifyContext<Database>,
      ):
        | SupabaseMcpApiKeyIdentity
        | null
        | Promise<SupabaseMcpApiKeyIdentity | null>;
    }
);

export type SupabaseMcpOAuthAuth = {
  mode: "oauth";
  /** Stable name exposed as ctx.authentication.strategy. */
  strategy?: string;
  authorizationServerMetadataUrl?: string | URL;
  scopes?: readonly string[];
} & (
  | {
      /** Defaults to the resource's Supabase Auth issuer. */
      issuer?: string | URL;
      verify?: never;
    }
  | {
      /** The authorization server that issued the opaque access token. */
      issuer: string | URL;
      /** Verify issuer, exact resource, expiry, and revocation. Return null for
       * an invalid token. Omitting this verifier uses Supabase JWT verification. */
      verify: (
        context: SupabaseMcpOAuthVerifyContext,
      ) =>
        | SupabaseMcpOAuthIdentity
        | null
        | Promise<SupabaseMcpOAuthIdentity | null>;
    }
);

export type SupabaseMcpProtectedAuth<Database = unknown> =
  | SupabaseMcpOAuthAuth
  | { mode: "bearer"; strategy?: string }
  | SupabaseMcpApiKeyAuth<Database>;

export type SupabaseMcpAuth<Database = unknown> =
  | SupabaseMcpProtectedAuth<Database>
  | {
      mode: "multi";
      /**
       * Protected strategies sharing one MCP endpoint. A token is routed to
       * exactly one strategy before verification; failed verification never
       * falls through to another strategy.
       */
      strategies: readonly SupabaseMcpProtectedAuth<Database>[];
    }
  | {
      mode: "public";
      scopes?: readonly string[];
      rateLimit?: true | SupabaseMcpPostgresRateLimit;
    };

export interface SupabaseMcpPostgresRateLimit {
  /** Maximum requests accepted from one caller during each window. */
  requests?: number;
  /** Fixed-window duration in seconds. */
  windowSeconds?: number;
  /** Override the generated Postgres RPC name. */
  functionName?: string;
}

export interface SupabaseMcpStateNamespaceOptions {
  /** Default lifetime for values written in this namespace. */
  ttlSeconds: number;
  /** Optional ceiling for a caller-selected shorter or longer lifetime. */
  maxTtlSeconds?: number;
}

export interface SupabaseMcpDurableStateOptions {
  /**
   * Deployment secret used only to derive an opaque per-credential partition.
   * It is never exposed through SupabaseMcpContext.
   */
  hmacKey: string;
  /** Exact namespace allowlist available to application capability code. */
  namespaces: Readonly<Record<string, SupabaseMcpStateNamespaceOptions>>;
  /**
   * Optional Supabase environment owning the private durable-state RPCs.
   * Defaults to the application's ordinary Supabase environment.
   */
  supabase?: {
    env?: Partial<SupabaseEnv>;
  };
}

export interface SupabaseMcpStateValue<Value extends JsonValue = JsonValue> {
  readonly value: Value;
  readonly revision: number;
  readonly expiresAt: string;
}

export interface SupabaseMcpStatePutOptions<
  Value extends JsonValue = JsonValue,
> {
  readonly value: Value;
  /** Null creates missing state; a positive revision performs compare-and-swap. */
  readonly expectedRevision: number | null;
  /** Defaults to the configured namespace lifetime. */
  readonly ttlSeconds?: number;
}

export interface SupabaseMcpStateDeleteOptions {
  readonly expectedRevision: number;
}

export interface SupabaseMcpState {
  get<Value extends JsonValue = JsonValue>(
    namespace: string,
    key: string,
  ): Promise<SupabaseMcpStateValue<Value> | null>;
  put<Value extends JsonValue>(
    namespace: string,
    key: string,
    options: SupabaseMcpStatePutOptions<Value>,
  ): Promise<SupabaseMcpStateValue<Value>>;
  delete(
    namespace: string,
    key: string,
    options: SupabaseMcpStateDeleteOptions,
  ): Promise<boolean>;
  /** Configured TTL bounds for `namespace`, used by short-TTL preview helpers. */
  namespaceOptions?(
    namespace: string,
  ):
    | { readonly ttlSeconds: number; readonly maxTtlSeconds: number }
    | undefined;
}

export type SupabaseMcpServer = McpServer & {
  /**
   * Register capabilities only when the current request has every scope.
   * Unscoped registration remains the default and needs no extra ceremony.
   */
  withScopes(requiredScopes: readonly string[]): SupabaseMcpServer;
};

export interface SupabaseMcpContext<Database = unknown> {
  readonly request: Request;
  readonly supabase: SupabaseClient<Database>;
  readonly user: UserClaims | null;
  readonly jwtClaims: JWTClaims | null;
  /** Normalized identity independent of the credential mechanism. */
  readonly principal: SupabaseMcpPrincipal | null;
  /** The exact strategy that authenticated this request. */
  readonly authentication: SupabaseMcpAuthentication;
  /** Authenticated application principal, including non-Supabase API keys. */
  readonly subject?: string;
  readonly clientId?: string;
  readonly scopes: readonly string[];
  hasScope(scope: string): boolean;
  hasScopes(scopes: readonly string[]): boolean;
  readonly traceId: string;
  /** Normalized protocol era, client identity, and capability support flags. */
  readonly client: SupabaseMcpClientContext;
  /** Validated visible-ASCII `Mcp-Session-Id` header when supplied, else `null`. */
  readonly sessionId: string | null;
  /**
   * Optional request-scoped, credential-partitioned state. Present only when
   * protected authentication and durable state are both configured.
   */
  readonly state?: SupabaseMcpState;
  /**
   * Optional `(credential, sessionId)`-partitioned durable state. Present only
   * when protected authentication, durable state, and a valid `Mcp-Session-Id`
   * header are all present.
   */
  readonly sessionState?: SupabaseMcpState;
  /**
   * Verified explicit application-run fact when `runCorrelation` is configured:
   * `RunFact` when request carried a valid handle, `null` when none was supplied,
   * `undefined` when `runCorrelation` is not configured.
   */
  readonly run?: SupabaseMcpRunFact | null;
}

export interface SupabaseMcpErrorEvent {
  readonly error: Error;
  readonly phase:
    | "auth"
    | "events"
    | "metadata"
    | "mcp"
    | "rate-limit"
    | "register"
    | "results"
    | "runtime"
    | "surface";
  readonly traceId?: string;
}

export interface SupabaseMcpResultMiddlewareInput<Database = unknown> {
  readonly context: SupabaseMcpContext<Database>;
  readonly tool: {
    readonly name: string;
  };
  /**
   * A deeply frozen structured-clone snapshot of the original successful
   * handler result. Every middleware receives the same authored snapshot.
   */
  readonly result: DeepReadonly<CallToolResult>;
}

export type SupabaseMcpResultMiddleware<Database = unknown> = (
  input: SupabaseMcpResultMiddlewareInput<Database>,
) =>
  | ResultContentComposition
  | null
  | undefined
  | Promise<ResultContentComposition | null | undefined>;

export interface SupabaseMcpAccessOptions<Database = unknown> {
  /**
   * Resolve application scopes for this request. When omitted, OAuth/Bearer
   * token scopes (or public scopes) are used unchanged.
   */
  resolveScopes?(
    context: SupabaseMcpContext<Database>,
  ): readonly string[] | Promise<readonly string[]>;
  /**
   * Restrict which verified OAuth / API-key `clientId` values may call this
   * MCP surface. Checked against verified `jwtClaims.client_id` / verifier
   * `clientId` (never unverified `clientInfo.name`). Rejects with HTTP 403.
   */
  readonly allowClients?:
    | readonly string[]
    | ((
        clientId: string | undefined,
        context: SupabaseMcpContext<Database>,
      ) => boolean | Promise<boolean>);
  /**
   * Require every listed scope before entering the MCP handler. Missing scopes
   * short-circuit with HTTP 403 + RFC 6750 `WWW-Authenticate` `insufficient_scope`.
   */
  readonly requiredScopes?: readonly string[];
}

export type SupabaseMcpPipelineAccessOptions<Database = unknown> =
  SupabaseMcpAccessOptions<Database>;

export interface SupabaseMcpProfileLike<
  Id extends string = string,
  Database = unknown,
> {
  readonly id: Id;
  readonly tools: ReadonlySet<string>;
  readonly systemTools: ReadonlySet<string>;
  readonly presentedNameFor: (canonicalName: string) => string | undefined;
  readonly canonicalNameFor: (presentedName: string) => string | undefined;
  readonly instructions?:
    | string
    | ((
        context: SupabaseMcpContext<Database>,
      ) => string | undefined | Promise<string | undefined>);
}

export interface SupabaseMcpProfileCatalogLike<
  ProfileId extends string = string,
  Database = unknown,
> {
  readonly ids: readonly ProfileId[];
  readonly vocabulary?: {
    readonly knownTools: ReadonlySet<string>;
    readonly plainWordTools: ReadonlySet<string>;
    rewrite(
      text: string,
      mounted: ReadonlySet<string>,
      aliases?: ReadonlyMap<string, string>,
    ): string;
  };
  get(id: ProfileId): SupabaseMcpProfileLike<ProfileId, Database>;
  parseId(value: string): ProfileId;
}

export interface SupabaseMcpProfilesOptions<
  ProfileId extends string = string,
  Database = unknown,
> {
  readonly catalog: SupabaseMcpProfileCatalogLike<ProfileId, Database>;
  select(context: SupabaseMcpContext<Database>): ProfileId | Promise<ProfileId>;
}

export interface CreateSupabaseMcpOptions<Database = unknown> {
  server: Implementation;
  /**
   * Server-level usage guidance returned in the `initialize` result.
   * Clients surface it to the model as "how to use this server" context,
   * complementing per-tool descriptions. A resolver receives the
   * request context, so row-defined servers can return per-surface
   * instructions.
   */
  instructions?:
    | string
    | ((
        context: SupabaseMcpContext<Database>,
      ) => string | undefined | Promise<string | undefined>);
  resourceUrl: string | URL;
  auth?: SupabaseMcpAuth<Database>;
  /** Optional Postgres-backed state for authenticated MCP capabilities. */
  state?: SupabaseMcpDurableStateOptions;
  /** Optional explicit application-run correlation for handlers and lifecycle v2. */
  runCorrelation?: SupabaseMcpRunCorrelation<Database>;
  access?: SupabaseMcpAccessOptions<Database>;
  /** Optional multi-audience capability profile catalog and request-time selector. */
  profiles?: SupabaseMcpProfilesOptions<string, Database>;
  /** Optional client capability heuristics and fallback policies. */
  clientPolicy?: SupabaseMcpClientPolicy;
  /** Optional browser MCP host CORS preflight and origin allowlist. */
  cors?: McpCorsOptions;
  register(
    server: SupabaseMcpServer,
    context: SupabaseMcpContext<Database>,
  ): void | Promise<void>;
  /**
   * Add bounded content to successful tool results. Middleware runs in the
   * declared order against the same immutable authored-result snapshot.
   */
  resultMiddleware?:
    | SupabaseMcpResultMiddleware<Database>
    | readonly SupabaseMcpResultMiddleware<Database>[];
  supabase?: {
    env?: Partial<SupabaseEnv>;
  };
  protocol?: {
    legacy?: "stateless" | "reject";
    responseMode?: "auto" | "json" | "sse";
    subscriptions?: McpTransportArmorOptions["subscriptions"];
    sessionId?: McpTransportArmorOptions["sessionId"];
  };
  /**
   * Receive redacted lifecycle facts in an application-owned sink. Returned
   * promises are observed for failures but never awaited by the MCP request.
   */
  onEvent?(event: SupabaseMcpLifecycleEvent): void | Promise<void>;
  /**
   * Receive a bounded, redacted proof after a complete successful tools/list.
   * Chumbo performs no surface inspection or delivery work when this is absent.
   */
  onSurface?(proof: SupabaseMcpSurfaceProof): void | Promise<void>;
  onError?(event: SupabaseMcpErrorEvent): void;
}

export interface SupabaseMcpApp {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
  readonly notify: ServerNotifier;
}

export interface VerifiedSupabaseIdentity {
  token: string;
  userClaims: UserClaims;
  jwtClaims: JWTClaims;
}

export interface RuntimeDependencies<Database = unknown> {
  verifyToken(
    token: string,
    env?: Partial<SupabaseEnv>,
  ): Promise<VerifiedSupabaseIdentity>;
  createClient(
    token: string | null,
    env?: Partial<SupabaseEnv>,
  ): SupabaseClient<Database>;
  createAdminClient(env?: Partial<SupabaseEnv>): SupabaseClient<Database>;
  fetch: typeof globalThis.fetch;
  /** Optional deterministic clock for runtime tests. */
  now?(): number;
  randomUUID(): string;
}
