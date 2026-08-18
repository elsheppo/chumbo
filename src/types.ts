import type {
  Implementation,
  McpServer,
  ServerNotifier,
} from "@modelcontextprotocol/server";
import type { JWTClaims, SupabaseEnv, UserClaims } from "@supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseMcpApiKeyIdentity {
  /** Stable application-owned identity for audit logs and scope resolution. */
  readonly subject: string;
  /** Optional MCP client identifier associated with this key. */
  readonly clientId?: string;
  /** Application capability scopes granted to this key. */
  readonly scopes?: readonly string[];
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

export type SupabaseMcpAuth<Database = unknown> =
  | {
      mode: "oauth";
      issuer?: string | URL;
      authorizationServerMetadataUrl?: string | URL;
      scopes?: readonly string[];
    }
  | { mode: "bearer" }
  | SupabaseMcpApiKeyAuth<Database>
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
  /** Authenticated application principal, including non-Supabase API keys. */
  readonly subject?: string;
  readonly clientId?: string;
  readonly scopes: readonly string[];
  hasScope(scope: string): boolean;
  hasScopes(scopes: readonly string[]): boolean;
  readonly traceId: string;
}

export interface SupabaseMcpErrorEvent {
  readonly error: Error;
  readonly phase: "auth" | "metadata" | "mcp" | "rate-limit" | "runtime";
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
  randomUUID(): string;
}
