import type {
  Implementation,
  McpServer,
  ServerNotifier,
} from "@modelcontextprotocol/server";
import type { JWTClaims, SupabaseEnv, UserClaims } from "@supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { JsonValue } from "./results.js";

export interface SupabaseMcpApiKeyIdentity {
  /** Stable application-owned identity for audit logs and scope resolution. */
  readonly subject: string;
  /** Optional MCP client identifier associated with this key. */
  readonly clientId?: string;
  /** Application capability scopes granted to this key. */
  readonly scopes?: readonly string[];
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

export type SupabaseMcpCapabilityKind = "tool" | "resource" | "prompt";

export interface SupabaseMcpLifecycleCapability {
  readonly kind: SupabaseMcpCapabilityKind;
  readonly name: string;
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

interface SupabaseMcpLifecycleEventBase {
  /** Version of this public event schema. */
  readonly schemaVersion: 1;
  /** ISO 8601 time at which this lifecycle transition occurred. */
  readonly timestamp: string;
  readonly traceId: string;
  readonly server: SupabaseMcpLifecycleServer;
  readonly capability: SupabaseMcpLifecycleCapability;
  readonly principal: SupabaseMcpPrincipal | null;
  readonly authentication: SupabaseMcpAuthentication;
}

export interface SupabaseMcpCapabilityStartedEvent extends SupabaseMcpLifecycleEventBase {
  readonly type: "capability.started";
}

export interface SupabaseMcpCapabilityFinishedEvent extends SupabaseMcpLifecycleEventBase {
  readonly type: "capability.finished";
  readonly durationMs: number;
  readonly outcome: SupabaseMcpLifecycleOutcome;
}

/** Redacted, request-scoped facts emitted around capability invocation. */
export type SupabaseMcpLifecycleEvent =
  | SupabaseMcpCapabilityStartedEvent
  | SupabaseMcpCapabilityFinishedEvent;

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

export type SupabaseMcpProtectedAuth<Database = unknown> =
  | {
      mode: "oauth";
      /** Stable name exposed as ctx.authentication.strategy. */
      strategy?: string;
      issuer?: string | URL;
      authorizationServerMetadataUrl?: string | URL;
      scopes?: readonly string[];
    }
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
  /**
   * Optional request-scoped, credential-partitioned state. Present only when
   * protected authentication and durable state are both configured.
   */
  readonly state?: SupabaseMcpState;
}

export interface SupabaseMcpErrorEvent {
  readonly error: Error;
  readonly phase:
    | "auth"
    | "events"
    | "metadata"
    | "mcp"
    | "rate-limit"
    | "runtime";
  readonly traceId?: string;
}

export interface SupabaseMcpAccessOptions<Database = unknown> {
  /**
   * Resolve application scopes for this request. When omitted, OAuth/Bearer
   * token scopes (or public scopes) are used unchanged.
   */
  resolveScopes?(
    context: SupabaseMcpContext<Database>,
  ): readonly string[] | Promise<readonly string[]>;
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
  access?: SupabaseMcpAccessOptions<Database>;
  register(
    server: SupabaseMcpServer,
    context: SupabaseMcpContext<Database>,
  ): void | Promise<void>;
  supabase?: {
    env?: Partial<SupabaseEnv>;
  };
  protocol?: {
    legacy?: "stateless" | "reject";
    responseMode?: "auto" | "json" | "sse";
  };
  /**
   * Receive redacted lifecycle facts in an application-owned sink. Returned
   * promises are observed for failures but never awaited by the MCP request.
   */
  onEvent?(event: SupabaseMcpLifecycleEvent): void | Promise<void>;
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
