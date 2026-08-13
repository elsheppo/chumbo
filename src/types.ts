import type {
  Implementation,
  McpServer,
  ServerNotifier,
} from "@modelcontextprotocol/server";
import type { JWTClaims, SupabaseEnv, UserClaims } from "@supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

export type SupabaseMcpAuth =
  | {
      mode: "oauth";
      issuer?: string | URL;
      authorizationServerMetadataUrl?: string | URL;
      scopes?: readonly string[];
    }
  | { mode: "bearer" }
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
  resourceUrl: string | URL;
  auth?: SupabaseMcpAuth;
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
