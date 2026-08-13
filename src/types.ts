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
  | { mode: "public" };

export interface SupabaseMcpContext<Database = unknown> {
  readonly request: Request;
  readonly supabase: SupabaseClient<Database>;
  readonly user: UserClaims | null;
  readonly jwtClaims: JWTClaims | null;
  readonly clientId?: string;
  readonly scopes: readonly string[];
  readonly traceId: string;
}

export interface SupabaseMcpErrorEvent {
  readonly error: Error;
  readonly phase: "auth" | "metadata" | "mcp" | "runtime";
  readonly traceId?: string;
}

export interface CreateSupabaseMcpOptions<Database = unknown> {
  server: Implementation;
  resourceUrl: string | URL;
  auth?: SupabaseMcpAuth;
  register(
    server: McpServer,
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
  fetch: typeof globalThis.fetch;
  randomUUID(): string;
}
