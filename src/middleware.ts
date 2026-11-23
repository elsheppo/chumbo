import {
  createMcpHandler,
  McpServer,
  type Implementation,
  type ServerEventBus,
} from "@modelcontextprotocol/server";
import {
  defineMiddleware,
  type BaseContext,
  type Middleware,
  type NoConflict,
  type SingleKeyEntry,
} from "@supabase/middleware";
import type {
  AuthMode,
  JWTClaims,
  SupabaseContext,
  UserClaims,
} from "@supabase/server";
import { createAdminClient, extractCredentials } from "@supabase/server/core";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveMcpClientContext } from "./client-context.js";
import {
  checkAccessGates,
  contextWithScopes,
  createLifecycleEmitter,
  createResultMiddlewareRunner,
  createRunSlot,
  createSurfaceProof,
  extendMcpContext,
  instrumentMcpServer,
  normalizeError,
  responseWithMergedHeaders,
  type RunSlot,
} from "./internal/mcp-engine.js";
import { getRunCorrelationInternals } from "./internal/run-correlation.js";
import { issueMcpSessionId, mcpSessionId } from "./session-state.js";
import {
  createSupabaseMcpStateFactory,
  SupabaseMcpStateUnavailableError,
} from "./state.js";
import {
  applyMcpCorsPreflight,
  applyMcpTransportArmor,
  decorateMcpCorsResponse,
  inspectInboundMcpEnvelope,
  isSuccessfulJsonRpcResponse,
} from "./transport.js";
import type {
  McpCorsOptions,
  McpTransportArmorOptions,
  SupabaseMcpAccessOptions,
  SupabaseMcpAuthentication,
  SupabaseMcpClientPolicy,
  SupabaseMcpContext,
  SupabaseMcpDurableStateOptions,
  SupabaseMcpErrorEvent,
  SupabaseMcpLifecycleEvent,
  SupabaseMcpProfilesOptions,
  SupabaseMcpResultMiddleware,
  SupabaseMcpRunCorrelation,
  SupabaseMcpServer,
  SupabaseMcpSurfaceProof,
} from "./types.js";
import { PACKAGE_VERSION } from "./version.js";

/**
 * Required upstream context keys contributed by `@supabase/server`'s
 * `withSupabase(...)`. Used as `withChumbo`'s `In` prerequisite so placing
 * `withChumbo` before `withSupabase` fails at compile time, while optional
 * keys such as `oauthProtectedResource` remain truly optional in `pipeline`.
 */
export type ChumboUpstreamPrerequisites<Database = any> = Pick<
  SupabaseContext<Database>,
  "supabase" | "userClaims" | "jwtClaims" | "authMode"
>;

/**
 * Full upstream context read by `withChumbo` when running downstream of
 * `withSupabase(...)` and optionally `withOAuthProtectedResource()`.
 */
export interface ChumboUpstreamSupabaseContext<Database = any>
  extends BaseContext, ChumboUpstreamPrerequisites<Database> {
  readonly supabaseAdmin?: SupabaseClient<Database>;
  readonly authKeyName?: string;
  readonly oauthProtectedResource?: {
    readonly resourceMetadataUrl: string;
  };
}

export type SupabaseMcpPipelineAccessOptions<Database = unknown> =
  SupabaseMcpAccessOptions<Database>;

/**
 * Contribution attached at `ctx.chumbo` by `withChumbo(...)`.
 * Extends `SupabaseMcpContext<Database>` with `instrument(server)` so an
 * existing official `new McpServer(...)` block gains `withScopes`,
 * `resultMiddleware`, `onEvent`, `runCorrelation`, and lazy per-family
 * `listChanged: false` hardening without replacing `index.ts`.
 */
export interface SupabaseMcpPipelineContext<
  Database = unknown,
> extends SupabaseMcpContext<Database> {
  /**
   * Wrap an official `@modelcontextprotocol/server` `McpServer` instance with
   * Chumbo's scope proxy (`server.withScopes`), `resultMiddleware` runner,
   * `onEvent` / `runCorrelation` lifecycle emitter, and lazy per-family
   * `{ listChanged: false }` / `{ subscribe: false }` seeding.
   *
   * - Idempotent if called again on an already-instrumented `McpServer`.
   * - Throws `TypeError` if `tools`, `resources`, or `prompts` were already
   *   registered on `server` prior to `instrument(server)`.
   */
  instrument(server: McpServer): SupabaseMcpServer;
}

export interface WithChumboOptions<Database = unknown> {
  /** Server identity stamped onto lifecycle events and surface proofs. */
  readonly server: Implementation;
  /**
   * Canonical public MCP URL. When omitted, derived from
   * `ctx.oauthProtectedResource.resourceMetadataUrl` (stripping both RFC 9728
   * origin-prefix and path-suffix forms) or from the Edge Function / request URL.
   */
  readonly resourceUrl?: string | URL;
  /** Optional stable strategy name override for `ctx.chumbo.authentication.strategy`. */
  readonly strategy?: string;
  /** Optional Postgres-backed durable state (`ctx.chumbo.state` & `ctx.chumbo.sessionState`). */
  readonly state?: SupabaseMcpDurableStateOptions;
  /** Optional explicit signed run correlation (`ctx.chumbo.run` & lifecycle v2). */
  readonly runCorrelation?: SupabaseMcpRunCorrelation<Database>;
  /** Optional `client_id` allowlist, required scopes, and `resolveScopes` resolver. */
  readonly access?: SupabaseMcpPipelineAccessOptions<Database>;
  /** Optional multi-audience tool profile catalog & selector. */
  readonly profiles?: SupabaseMcpProfilesOptions<string, Database>;
  /** Client capability heuristics and fallback policies. */
  readonly clientPolicy?: SupabaseMcpClientPolicy;
  /** Result composition middleware applied to tools registered on `ctx.chumbo.instrument(server)`. */
  readonly resultMiddleware?:
    | SupabaseMcpResultMiddleware<Database>
    | readonly SupabaseMcpResultMiddleware<Database>[];
  /** Transport armor & session ID behavior. Enabled by default (`subscriptions: "disabled"`, `sessionId: "stateless"`). */
  readonly transport?: McpTransportArmorOptions;
  /** Lifecycle telemetry sink (`capability.started`, `capability.finished`). */
  onEvent?(event: SupabaseMcpLifecycleEvent): void | Promise<void>;
  /** Canonical redacted `tools/list` surface proof sink. */
  onSurface?(proof: SupabaseMcpSurfaceProof): void | Promise<void>;
  /** Non-throwing operator error hook. */
  onError?(event: SupabaseMcpErrorEvent): void;
}

export interface McpCorsContribution {
  readonly origin: string | null;
  readonly allowed: boolean;
}

export interface McpTransportContribution {
  readonly sessionId: string | null;
  readonly protocolVersion?: string;
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

function trimTrailingSlashHref(url: URL): string {
  const copy = new URL(url);
  copy.hash = "";
  copy.search = "";
  if (copy.pathname !== "/") {
    copy.pathname = copy.pathname.replace(/\/+$/, "");
  }
  return copy.href;
}

/**
 * Strip both RFC 9728 origin-prefix (`/.well-known/oauth-protected-resource/<path>`)
 * and path-suffix (`/<path>/oauth-protected-resource` or `.../.well-known/oauth-protected-resource`)
 * forms to recover the canonical MCP resource URL.
 */
export function deriveResourceUrlFromMetadataUrl(metadataUrl: string): string {
  const parsed = new URL(metadataUrl);
  parsed.hash = "";
  parsed.search = "";
  const pathname = parsed.pathname.replace(/\/+$/, "");
  const prefix = "/.well-known/oauth-protected-resource";
  if (pathname === prefix) {
    parsed.pathname = "/";
    return parsed.href;
  }
  if (pathname.startsWith(`${prefix}/`)) {
    parsed.pathname = pathname.slice(prefix.length) || "/";
    return trimTrailingSlashHref(parsed);
  }
  if (pathname.endsWith(prefix)) {
    parsed.pathname = pathname.slice(0, -prefix.length) || "/";
    return trimTrailingSlashHref(parsed);
  }
  const shortSuffix = "/oauth-protected-resource";
  if (pathname.endsWith(shortSuffix)) {
    parsed.pathname = pathname.slice(0, -shortSuffix.length) || "/";
    return trimTrailingSlashHref(parsed);
  }
  return trimTrailingSlashHref(parsed);
}

function resolvePipelineResourceUrl(
  req: Request,
  configured: string | URL | undefined,
  resourceMetadataUrl: string | undefined,
): string {
  if (configured !== undefined) {
    return trimTrailingSlashHref(new URL(configured));
  }
  if (resourceMetadataUrl) {
    try {
      return deriveResourceUrlFromMetadataUrl(resourceMetadataUrl);
    } catch {
      // Fall through to request/env derivation.
    }
  }
  const slug = runtimeVariable("SUPABASE_FUNCTION_SLUG");
  if (slug) {
    const publicUrl = runtimeVariable("SUPABASE_PUBLIC_URL");
    if (publicUrl) {
      try {
        const base = new URL(publicUrl);
        base.pathname = `/functions/v1/${slug}`;
        return trimTrailingSlashHref(base);
      } catch {
        // Fall through to forwarded headers.
      }
    }
    const proto =
      req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
    const host =
      req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
      req.headers.get("host");
    if (host) {
      return `${proto}://${host}/functions/v1/${slug}`;
    }
  }
  return trimTrailingSlashHref(new URL(req.url));
}

function scopesFromClaims(claims: JWTClaims | null): string[] {
  if (!claims) return [];
  const value = claims.scope;
  if (typeof value === "string") {
    return value.split(/\s+/).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.filter((scope): scope is string => typeof scope === "string");
  }
  return [];
}

function actualClientId(claims: JWTClaims | null): string | undefined {
  return claims && typeof claims.client_id === "string"
    ? claims.client_id
    : undefined;
}

function mapUpstreamAuth(
  upstream: ChumboUpstreamSupabaseContext<unknown>,
  strategyOverride: string | undefined,
): {
  readonly authentication: SupabaseMcpAuthentication;
  readonly subject?: string;
  readonly clientId?: string;
} {
  const mode: AuthMode = upstream.authMode;
  if (mode === "user") {
    const hasOauth = Boolean(upstream.oauthProtectedResource);
    const chumboMode = hasOauth ? "oauth" : "bearer";
    return {
      authentication: Object.freeze({
        mode: chumboMode,
        strategy: strategyOverride?.trim() || chumboMode,
      }),
      subject: upstream.userClaims?.id,
      clientId: actualClientId(upstream.jwtClaims),
    };
  }
  if (mode === "secret" || mode === "publishable") {
    const keyName = upstream.authKeyName?.trim();
    const defaultStrategy = keyName ? `${mode}:${keyName}` : mode;
    return {
      authentication: Object.freeze({
        mode: "api-key",
        strategy: strategyOverride?.trim() || defaultStrategy,
      }),
      subject: `${mode}:${keyName || "default"}`,
    };
  }
  return {
    authentication: Object.freeze({
      mode: "public",
      strategy: strategyOverride?.trim() || "public",
    }),
  };
}

/**
 * Pre-auth pipeline entry for browser MCP hosts. Place FIRST in `pipeline([...])`
 * (ahead of `withOAuthProtectedResource()` and `withSupabase({ cors: 'disabled' })`)
 * so `OPTIONS` preflights succeed without credentials and `401` OAuth challenges
 * expose `WWW-Authenticate` and `Mcp-Session-Id` to browser `fetch()`.
 */
export const withMcpCors: Middleware<
  "mcpCors",
  McpCorsOptions,
  Record<never, never>,
  McpCorsContribution
> = defineMiddleware<
  "mcpCors",
  McpCorsOptions,
  Record<never, never>,
  McpCorsContribution
>({
  key: "mcpCors",
  run: (config) =>
    async function* (req) {
      const { shortCircuit, evaluated } = applyMcpCorsPreflight(req, config);
      if (shortCircuit) return shortCircuit;
      const response: Response = yield {
        mcpCors: Object.freeze({
          origin: evaluated.allowOriginHeader ?? null,
          allowed: evaluated.allowed,
        }),
      };
      return decorateMcpCorsResponse(response, evaluated, config);
    },
});

/**
 * Standalone transport-armor pipeline entry for non-Chumbo MCP handlers that
 * only want immediate `405` / `-32601` SSE listen-stream refusal and stateless
 * `Mcp-Session-Id` issuance without `withChumbo`.
 */
export const withMcpTransportArmor: Middleware<
  "mcpTransport",
  McpTransportArmorOptions | undefined,
  Record<never, never>,
  McpTransportContribution
> = defineMiddleware<
  "mcpTransport",
  McpTransportArmorOptions | undefined,
  Record<never, never>,
  McpTransportContribution
>({
  key: "mcpTransport",
  run: (config) =>
    async function* (req) {
      const envelope = await inspectInboundMcpEnvelope(req);
      const refused = applyMcpTransportArmor(req, envelope, config);
      if (refused) return refused;
      const sessionId = mcpSessionId(req);
      const response: Response = yield {
        mcpTransport: Object.freeze({
          sessionId,
          ...(envelope.protocolVersion
            ? { protocolVersion: envelope.protocolVersion }
            : {}),
        }),
      };
      if (
        (config?.sessionId ?? "stateless") === "stateless" &&
        envelope.era === "legacy" &&
        envelope.method === "initialize" &&
        (await isSuccessfulJsonRpcResponse(response))
      ) {
        const client = resolveMcpClientContext(req, envelope, { sessionId });
        return issueMcpSessionId(response, client.supports);
      }
      return response;
    },
});

const rawWithChumbo = defineMiddleware<
  "chumbo",
  WithChumboOptions<any>,
  ChumboUpstreamPrerequisites<any>,
  SupabaseMcpPipelineContext<any>
>({
  key: "chumbo",
  run: (options) => {
    const stateFactory = options.state
      ? createSupabaseMcpStateFactory(options.state)
      : undefined;
    const runSlotByContext = new WeakMap<object, RunSlot>();
    const lifecycle = createLifecycleEmitter(options, {}, (ctx) =>
      runSlotByContext.get(ctx),
    );
    const resultMiddleware = createResultMiddlewareRunner(options);
    const runCorrelationInternals = getRunCorrelationInternals(
      options.runCorrelation,
    );
    const disableSubscriptions =
      (options.transport?.subscriptions ?? "disabled") === "disabled";
    const sessionIdMode = options.transport?.sessionId ?? "stateless";

    const reportSurfaceFailure = (error: unknown): void => {
      try {
        options.onError?.({
          error: normalizeError(error),
          phase: "surface",
        });
      } catch {
        // An operator hook must not change the successful discovery response.
      }
    };

    return async function* (req, upstream) {
      const fullUpstream = upstream as ChumboUpstreamSupabaseContext<any>;
      const traceId = globalThis.crypto.randomUUID();
      const resourceMetadataUrl =
        fullUpstream.oauthProtectedResource?.resourceMetadataUrl;
      const resourceUrl = resolvePipelineResourceUrl(
        req,
        options.resourceUrl,
        resourceMetadataUrl,
      );
      const { authentication, subject, clientId } = mapUpstreamAuth(
        fullUpstream,
        options.strategy,
      );

      const runtimeHeaders: Record<string, string> = {
        "x-chumbo-version": PACKAGE_VERSION,
        "x-chumbo-auth-mode": authentication.mode,
        "x-chumbo-auth-strategy": authentication.strategy,
        "x-chumbo-resource-url": resourceUrl,
        "x-supa-mcp-version": PACKAGE_VERSION,
        "x-supa-mcp-auth-mode": authentication.mode,
        "x-supa-mcp-auth-strategy": authentication.strategy,
        "x-supa-mcp-resource-url": resourceUrl,
      };

      const decorate = (
        response: Response,
        extraExpose: readonly string[] = [],
      ): Response =>
        responseWithMergedHeaders(response, runtimeHeaders, extraExpose);

      if (stateFactory && fullUpstream.authMode === "none") {
        options.onError?.({
          error: new Error(
            "Durable state requires protected authentication (auth: 'user', 'secret', or 'publishable').",
          ),
          phase: "runtime",
          traceId,
        });
        return decorate(
          Response.json(
            { error: "server_error", traceId },
            { status: 500, headers: { "cache-control": "no-store" } },
          ),
        );
      }

      const envelope = await inspectInboundMcpEnvelope(req);
      const refused = applyMcpTransportArmor(req, envelope, options.transport);
      if (refused) return decorate(refused);

      const sessionId = mcpSessionId(req);
      const client = resolveMcpClientContext(req, envelope, {
        sessionId,
        clientPolicy: options.clientPolicy,
      });

      let state: SupabaseMcpContext<any>["state"];
      let sessionState: SupabaseMcpContext<any>["sessionState"];
      if (stateFactory) {
        const extracted = extractCredentials(req);
        const credential =
          fullUpstream.authMode === "user" ? extracted.token : extracted.apikey;
        const adminClient = options.state?.supabase?.env
          ? createAdminClient({ env: options.state.supabase.env })
          : fullUpstream.supabaseAdmin;
        if (!credential || !adminClient) {
          options.onError?.({
            error: new SupabaseMcpStateUnavailableError(),
            phase: "runtime",
            traceId,
          });
          return decorate(
            Response.json(
              { error: "server_error", traceId },
              { status: 500, headers: { "cache-control": "no-store" } },
            ),
          );
        }
        try {
          state = await stateFactory.create(
            { credential, authentication },
            adminClient,
          );
          if (sessionId) {
            sessionState = await stateFactory.create(
              { credential, authentication, sessionId },
              adminClient,
            );
          }
        } catch {
          options.onError?.({
            error: new SupabaseMcpStateUnavailableError(),
            phase: "runtime",
            traceId,
          });
          return decorate(
            Response.json(
              { error: "server_error", traceId },
              { status: 500, headers: { "cache-control": "no-store" } },
            ),
          );
        }
      }

      const runSlot = createRunSlot(Boolean(options.runCorrelation));
      const baseInput = {
        request: req,
        supabase: fullUpstream.supabase,
        user: fullUpstream.userClaims,
        jwtClaims: fullUpstream.jwtClaims,
        principal: subject
          ? Object.freeze({
              subject,
              ...(clientId ? { clientId } : {}),
              authentication,
            })
          : null,
        authentication,
        ...(subject ? { subject } : {}),
        ...(clientId ? { clientId } : {}),
        traceId,
        client,
        sessionId,
        ...(state ? { state } : {}),
        ...(sessionState ? { sessionState } : {}),
      };

      const initialScopes = scopesFromClaims(fullUpstream.jwtClaims);
      const initialContext = contextWithScopes(
        baseInput,
        initialScopes,
        runSlot,
      );
      let resolvedScopes: readonly string[];
      try {
        resolvedScopes = options.access?.resolveScopes
          ? await options.access.resolveScopes(initialContext)
          : initialScopes;
      } catch (error) {
        options.onError?.({
          error: normalizeError(error),
          phase: "runtime",
          traceId,
        });
        return decorate(
          Response.json(
            { error: "server_error", traceId },
            { status: 500, headers: { "cache-control": "no-store" } },
          ),
        );
      }

      const coreContext = contextWithScopes(baseInput, resolvedScopes, runSlot);
      const accessCheck = await checkAccessGates(
        coreContext,
        options.access,
        resourceMetadataUrl,
      );
      if (!accessCheck.allowed && accessCheck.response) {
        return decorate(accessCheck.response);
      }

      let pipelineContext!: SupabaseMcpPipelineContext<any>;
      pipelineContext = extendMcpContext(
        coreContext,
        {
          instrument(server: McpServer): SupabaseMcpServer {
            return instrumentMcpServer(
              server,
              pipelineContext,
              lifecycle,
              resultMiddleware,
              { disableSubscriptions },
            );
          },
        },
        runSlot,
      );
      runSlotByContext.set(pipelineContext, runSlot);
      runSlotByContext.set(coreContext, runSlot);

      let response: Response = yield { chumbo: pipelineContext };
      const extraExpose: string[] = [];

      if (
        envelope.method === "initialize" &&
        response.ok &&
        runCorrelationInternals?.sessionHeaderName &&
        !response.headers.get(runCorrelationInternals.sessionHeaderName)
      ) {
        try {
          const handle =
            await runCorrelationInternals.issueSessionHeader(pipelineContext);
          const headerName = runCorrelationInternals.sessionHeaderName;
          extraExpose.push(headerName);
          response = responseWithMergedHeaders(
            response,
            { [headerName]: handle },
            [headerName],
          );
        } catch (error) {
          options.onError?.({
            error: normalizeError(error),
            phase: "runtime",
            traceId,
          });
        }
      }

      if (
        sessionIdMode === "stateless" &&
        envelope.era === "legacy" &&
        envelope.method === "initialize" &&
        (await isSuccessfulJsonRpcResponse(response))
      ) {
        response = issueMcpSessionId(response, client.supports);
      }

      if (envelope.surfaceList && options.onSurface) {
        try {
          const proof = await createSurfaceProof(
            response,
            envelope.surfaceList,
            options.server,
            authentication,
          );
          if (proof) {
            try {
              const pending = options.onSurface(proof);
              void Promise.resolve(pending).catch(reportSurfaceFailure);
            } catch (error) {
              reportSurfaceFailure(error);
            }
          }
        } catch (error) {
          reportSurfaceFailure(error);
        }
      }

      return decorate(response, extraExpose);
    };
  },
});

export interface WithChumboFunction {
  <
    Database = any,
    Base extends ChumboUpstreamPrerequisites<Database> & BaseContext =
      ChumboUpstreamPrerequisites<Database> & BaseContext,
  >(
    options: WithChumboOptions<Database>,
    handler: NoConflict<
      "chumbo",
      Base,
      (
        req: Request,
        ctx: NoInfer<Base> & { chumbo: SupabaseMcpPipelineContext<Database> },
      ) => Promise<Response>
    >,
  ): (req: Request, ctx: Base) => Promise<Response>;
  <Database = any>(
    options: WithChumboOptions<Database>,
  ): SingleKeyEntry<
    "chumbo",
    ChumboUpstreamPrerequisites<Database>,
    SupabaseMcpPipelineContext<Database>
  >;
}

/**
 * Primary Chumbo pipeline entry for `@supabase/server` MCP servers.
 * Place immediately AFTER `withSupabase(...)` in `pipeline([...], handler)`.
 */
export const withChumbo: WithChumboFunction =
  rawWithChumbo as unknown as WithChumboFunction;

export interface ChumboMcpHandlerOptions<Database = unknown> {
  readonly server: Implementation;
  readonly instructions?:
    | string
    | ((
        context: SupabaseMcpPipelineContext<Database>,
      ) => string | undefined | Promise<string | undefined>);
  readonly protocol?: {
    readonly legacy?: "stateless" | "reject";
    readonly responseMode?: "auto" | "json" | "sse";
    readonly subscriptions?: "disabled" | "in-memory" | ServerEventBus;
  };
  onError?(event: SupabaseMcpErrorEvent): void;
  register(
    server: SupabaseMcpServer,
    context: SupabaseMcpPipelineContext<Database>,
  ): void | Promise<void>;
}

const PIPELINE_CONTEXT_EXTRA_KEY = "chumboPipelineContext";

/**
 * Reusable terminal handler for `pipeline([...withChumbo(...)], chumboMcpHandler(...))`.
 * Instantiates `createMcpHandler` once at module initialization rather than per
 * request, resolves `instructions`, instruments `McpServer`, and calls `register`.
 */
export function chumboMcpHandler<Database = unknown>(
  options: ChumboMcpHandlerOptions<Database>,
): (
  req: Request,
  ctx: { readonly chumbo: SupabaseMcpPipelineContext<Database> },
) => Promise<Response> {
  const subscriptions = options.protocol?.subscriptions ?? "disabled";
  const bus =
    subscriptions !== "disabled" && subscriptions !== "in-memory"
      ? subscriptions
      : undefined;

  const handler = createMcpHandler(
    async (mcpContext) => {
      const chumbo = mcpContext.authInfo?.extra?.[
        PIPELINE_CONTEXT_EXTRA_KEY
      ] as SupabaseMcpPipelineContext<Database> | undefined;
      if (!chumbo) {
        throw new Error(
          "chumboMcpHandler requires withChumbo(...) upstream in the pipeline.",
        );
      }
      const instructions =
        typeof options.instructions === "function"
          ? await options.instructions(chumbo)
          : options.instructions;
      const rawServer = new McpServer(
        options.server,
        instructions ? { instructions } : undefined,
      );
      const instrumented = chumbo.instrument(rawServer);
      await options.register(instrumented, chumbo);
      return rawServer;
    },
    {
      legacy: options.protocol?.legacy ?? "stateless",
      responseMode: options.protocol?.responseMode ?? "auto",
      ...(subscriptions === "disabled"
        ? { maxSubscriptions: 0, keepAliveMs: 0 }
        : bus
          ? { bus }
          : {}),
      onerror(error) {
        options.onError?.({ error, phase: "mcp" });
      },
    },
  );

  return async (req, ctx) =>
    handler.fetch(req, {
      authInfo: {
        token: "",
        clientId: ctx.chumbo.clientId ?? ctx.chumbo.subject ?? "anonymous",
        scopes: [...ctx.chumbo.scopes],
        extra: { [PIPELINE_CONTEXT_EXTRA_KEY]: ctx.chumbo },
      },
    });
}
