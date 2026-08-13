import {
  McpServer,
  OAuthError,
  OAuthErrorCode,
  buildOAuthProtectedResourceMetadata,
  createMcpHandler,
  requireBearerAuth,
  type AuthInfo,
  type OAuthMetadata,
} from "@modelcontextprotocol/server";
import { createContextClient, verifyCredentials } from "@supabase/server/core";
import type { JWTClaims, UserClaims } from "@supabase/server";
import type {
  CreateSupabaseMcpOptions,
  RuntimeDependencies,
  SupabaseMcpApp,
  SupabaseMcpContext,
  VerifiedSupabaseIdentity,
} from "./types.js";

const IDENTITY_KEY = "createSupabaseMcpIdentity";
const CONTEXT_KEY = "createSupabaseMcpContext";
const DEFAULT_SCOPES = ["openid", "email", "profile", "phone"] as const;

interface RequestIdentity<Database> extends VerifiedSupabaseIdentity {
  supabase: SupabaseMcpContext<Database>["supabase"];
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

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=300",
    },
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
        context = Object.freeze({
          request,
          supabase: dependencies.createClient(null, options.supabase?.env),
          user: null,
          jwtClaims: null,
          scopes: Object.freeze([]),
          traceId: dependencies.randomUUID(),
        });
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
      await options.register(server, context);
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
      if (authorizationRoute) return jsonResponse(metadata);
      return jsonResponse(
        buildOAuthProtectedResourceMetadata({
          oauthMetadata: metadata,
          resourceServerUrl: resourceUrl,
          resourceName: options.server.name,
          scopesSupported: advertisedScopes,
        }),
      );
    } catch (error) {
      options.onError?.({ error: normalizeError(error), phase: "metadata" });
      return jsonResponse(
        { error: "authorization_server_metadata_unavailable" },
        502,
      );
    }
  }

  return {
    async fetch(request) {
      const metadata = await serveMetadata(request);
      if (metadata) return metadata;

      if (!bearerGate) return mcpHandler.fetch(request);
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
      const context: SupabaseMcpContext<Database> = Object.freeze({
        request,
        supabase: identity.supabase,
        user: identity.userClaims,
        jwtClaims: identity.jwtClaims,
        clientId: identity.clientId,
        scopes: Object.freeze([...identity.scopes]),
        traceId,
      });
      authInfo.extra = { ...authInfo.extra, [CONTEXT_KEY]: context };
      return mcpHandler.fetch(request, { authInfo });
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
