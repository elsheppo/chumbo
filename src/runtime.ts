import {
  McpServer,
  OAuthError,
  OAuthErrorCode,
  buildOAuthProtectedResourceMetadata,
  createMcpHandler,
  requireBearerAuth,
  type AuthInfo,
  type McpServer as McpServerType,
  type OAuthMetadata,
} from "@modelcontextprotocol/server";
import {
  createAdminClient,
  createContextClient,
  verifyCredentials,
} from "@supabase/server/core";
import type { JWTClaims, UserClaims } from "@supabase/server";
import type {
  CreateSupabaseMcpOptions,
  RuntimeDependencies,
  SupabaseMcpApp,
  SupabaseMcpContext,
  SupabaseMcpPostgresRateLimit,
  SupabaseMcpServer,
  VerifiedSupabaseIdentity,
} from "./types.js";
import { PACKAGE_VERSION } from "./version.js";

const IDENTITY_KEY = "createSupabaseMcpIdentity";
const CONTEXT_KEY = "createSupabaseMcpContext";
const DEFAULT_SCOPES = ["openid", "email", "profile", "phone"] as const;
const DEFAULT_RATE_LIMIT = {
  requests: 60,
  windowSeconds: 60,
  functionName: "supa_mcp_rate_limit",
} as const;
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
  requiredScopes: readonly string[] = [],
): SupabaseMcpServer {
  const required = normalizedScopes(requiredScopes);
  return new Proxy(server, {
    get(target, property) {
      if (property === "withScopes") {
        return (additional: readonly string[]) =>
          scopedServer(target, context, [...required, ...additional]);
      }
      const value = Reflect.get(target, property, target);
      if (typeof property !== "string" || typeof value !== "function") {
        return value;
      }
      if (!REGISTRATION_METHODS.has(property)) return value.bind(target);
      return (...args: unknown[]) => {
        const registration = Reflect.apply(value, target, args) as {
          disable?(): void;
        };
        if (!context.hasScopes(required)) registration.disable?.();
        return registration;
      };
    },
  }) as SupabaseMcpServer;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
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

export const defaultRuntimeDependencies: RuntimeDependencies = {
  async verifyToken(token, env) {
    const result = await verifyCredentials(
      { token, apikey: null },
      { auth: "user", env },
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
    return createContextClient({ auth: { token }, env });
  },
  createAdminClient(env) {
    return createAdminClient({ env });
  },
  fetch: globalThis.fetch.bind(globalThis),
  randomUUID: () => crypto.randomUUID(),
};

export function createSupabaseMcpInternal<Database = unknown>(
  options: CreateSupabaseMcpOptions<Database>,
  dependencies: RuntimeDependencies<Database>,
): SupabaseMcpApp {
  const auth = options.auth ?? { mode: "oauth" as const };
  const resourceUrl = trimTrailingSlash(new URL(options.resourceUrl));
  const resourceMetadataUrl = appendPath(
    resourceUrl,
    ".well-known/oauth-protected-resource",
  );
  const authorizationMetadataMirrorUrl = appendPath(
    resourceUrl,
    ".well-known/oauth-authorization-server",
  );
  const issuer =
    auth.mode === "oauth"
      ? trimTrailingSlash(
          new URL(auth.issuer ?? `${resourceUrl.origin}/auth/v1`),
        )
      : undefined;
  const authorizationServerMetadataUrl =
    auth.mode === "oauth"
      ? new URL(
          auth.authorizationServerMetadataUrl ?? metadataUrlForIssuer(issuer!),
        )
      : undefined;
  const advertisedScopes =
    auth.mode === "oauth" ? [...(auth.scopes ?? DEFAULT_SCOPES)] : [];
  const publicRateLimit =
    auth.mode === "public" && auth.rateLimit
      ? rateLimitConfig(auth.rateLimit)
      : undefined;
  const runtimeHeaders = {
    "access-control-expose-headers":
      "x-supa-mcp-version, x-supa-mcp-auth-mode, x-supa-mcp-auth-strategy, x-supa-mcp-resource-url",
    "x-supa-mcp-version": PACKAGE_VERSION,
    "x-supa-mcp-auth-mode": auth.mode,
    "x-supa-mcp-resource-url": resourceUrl.href,
    ...(auth.mode === "api-key"
      ? {
          "x-supa-mcp-auth-strategy":
            typeof auth.key === "string" ? "static" : "verifier",
        }
      : {}),
  };
  if (
    auth.mode === "api-key" &&
    typeof auth.key === "string" &&
    auth.key.length === 0
  ) {
    throw new Error("API-key mode requires a non-empty key");
  }

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

      const server = new McpServer(options.server);
      await options.register(scopedServer(server, context), context);
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

  const bearerGate =
    auth.mode === "public"
      ? undefined
      : requireBearerAuth({
          resourceMetadataUrl:
            auth.mode === "oauth" ? resourceMetadataUrl.href : undefined,
          verifier: {
            async verifyAccessToken(token: string): Promise<AuthInfo> {
              try {
                if (auth.mode === "api-key") {
                  const verified =
                    typeof auth.key === "string"
                      ? (await sha256(token)) === (await sha256(auth.key))
                        ? {
                            subject: auth.subject ?? "api-key",
                            scopes: auth.scopes,
                          }
                        : null
                      : await auth.verify({
                          token,
                          supabaseAdmin: dependencies.createAdminClient(
                            options.supabase?.env,
                          ),
                        });
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
                  const requestIdentity: RequestIdentity<Database> = {
                    token,
                    userClaims: null,
                    jwtClaims: null,
                    supabase: dependencies.createClient(
                      null,
                      options.supabase?.env,
                    ),
                    subject,
                    clientId: verified.clientId,
                    scopes: normalizedScopes(
                      verified.scopes ?? auth.scopes ?? [],
                    ),
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
                const requestIdentity: RequestIdentity<Database> = {
                  ...identity,
                  supabase: dependencies.createClient(
                    token,
                    options.supabase?.env,
                  ),
                  subject: identity.userClaims.id,
                  clientId: actualClientId(identity.jwtClaims),
                  scopes: scopesFromClaims(identity.jwtClaims),
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
                  phase: "auth",
                });
                if (error instanceof OAuthError) throw error;
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
    if (auth.mode !== "oauth") return undefined;
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
      const response = await mcpHandler.fetch(request);
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
      context = await buildContext(
        {
          request,
          supabase: identity.supabase,
          user: identity.userClaims,
          jwtClaims: identity.jwtClaims,
          subject: identity.subject,
          clientId: identity.clientId,
          traceId,
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
    return mcpHandler.fetch(request, { authInfo });
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
