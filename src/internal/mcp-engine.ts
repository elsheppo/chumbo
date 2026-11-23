import {
  isCallToolResult,
  isInputRequiredResult,
  type CallToolResult,
  type Implementation,
  type McpServer as McpServerType,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { DEFAULT_CLIENT_CONTEXT } from "../client-context.js";
import { withProfile, type DefinedChumboProfile } from "../profiles.js";
import {
  composeResultContent,
  type ResultContentComposition,
} from "../results.js";
import {
  boundedBodyText,
  jsonRpcPayloadFromResponseText,
  mergeExposedHeaders,
  type SurfaceListRequest,
} from "../transport.js";
import type {
  SupabaseMcpAccessOptions,
  SupabaseMcpAuthentication,
  SupabaseMcpCapabilityKind,
  SupabaseMcpContext,
  SupabaseMcpErrorEvent,
  SupabaseMcpLifecycleEvent,
  SupabaseMcpLifecycleOutcome,
  SupabaseMcpProfileLike,
  SupabaseMcpProfilesOptions,
  SupabaseMcpResultMiddleware,
  SupabaseMcpRunCorrelation,
  SupabaseMcpRunFact,
  SupabaseMcpServer,
  SupabaseMcpSurfaceProof,
} from "../types.js";
import { PACKAGE_VERSION } from "../version.js";
import { withOpenOutputSchema } from "./open-output-schema.js";
import { getRunCorrelationInternals } from "./run-correlation.js";
import {
  boundedUtf8,
  CHUMBO_CANONICAL_TOOL,
  computeCanonicalSurfaceDigest,
  PRESENTED_TOOL_NAME,
  SURFACE_CANONICAL_LIMITS,
} from "./surface-canonical.js";

const MAX_RESULT_MIDDLEWARE = 16;
const MAX_SURFACE_RESPONSE_BYTES = 512 * 1024;
const runFactIdPattern = /^run_[A-Za-z0-9_-]{43}$/;

const REGISTRATION_METHODS = new Set([
  "registerPrompt",
  "registerResource",
  "registerResourceTemplate",
  "registerTool",
]);

export interface RunSlot {
  value: SupabaseMcpRunFact | null | undefined;
}

export function createRunSlot(hasRunCorrelation: boolean): RunSlot {
  return { value: hasRunCorrelation ? null : undefined };
}

export function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Unknown runtime error");
}

export function normalizedScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<Value>(value: Value, seen = new WeakSet<object>()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

export type PartialContextInput<Database = unknown> = Omit<
  SupabaseMcpContext<Database>,
  "scopes" | "hasScope" | "hasScopes" | "client" | "sessionId" | "run"
> & {
  readonly client?: SupabaseMcpContext<Database>["client"];
  readonly sessionId?: string | null;
};

/**
 * Freeze a `SupabaseMcpContext` with normalized scopes and attach the live
 * `runSlot` getter *after* object spreading so `{ ...value }` never flattens
 * `ctx.run` to a static `null`.
 */
export function contextWithScopes<Database = unknown>(
  value: PartialContextInput<Database>,
  scopes: readonly string[],
  runSlot?: RunSlot,
): SupabaseMcpContext<Database> {
  const normalized = Object.freeze(normalizedScopes(scopes));
  const set = new Set(normalized);
  const target: Record<string, unknown> = {
    ...value,
    client: value.client ?? DEFAULT_CLIENT_CONTEXT,
    sessionId: value.sessionId ?? null,
    scopes: normalized,
    hasScope(scope: string) {
      return set.has(scope);
    },
    hasScopes(required: readonly string[]) {
      return required.every((scope) => set.has(scope));
    },
  };
  if (runSlot) {
    Object.defineProperty(target, "run", {
      enumerable: true,
      configurable: false,
      get: () => runSlot.value,
    });
  }
  return Object.freeze(target) as unknown as SupabaseMcpContext<Database>;
}

/**
 * Clone a frozen `SupabaseMcpContext` with extra methods (such as `instrument`)
 * while preserving the non-configurable `run` getter descriptor.
 */
export function extendMcpContext<
  Database,
  Extra extends Record<string, unknown>,
>(
  context: SupabaseMcpContext<Database>,
  extra: Extra,
  runSlot?: RunSlot,
): SupabaseMcpContext<Database> & Extra {
  const target: Record<string, unknown> = {
    ...context,
    ...extra,
  };
  if (runSlot) {
    Object.defineProperty(target, "run", {
      enumerable: true,
      configurable: false,
      get: () => runSlot.value,
    });
  }
  return Object.freeze(target) as unknown as SupabaseMcpContext<Database> &
    Extra;
}

export interface AccessGateResult {
  readonly allowed: boolean;
  readonly response?: Response;
}

function escapeHeaderQuoted(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/**
 * Enforce `access.allowClients` and `access.requiredScopes` symmetrically for
 * both `createSupabaseMcp` and `withChumbo`.
 */
export async function checkAccessGates<Database = unknown>(
  context: SupabaseMcpContext<Database>,
  access: SupabaseMcpAccessOptions<Database> | undefined,
  resourceMetadataUrl?: string,
): Promise<AccessGateResult> {
  if (!access) return { allowed: true };

  if (access.allowClients !== undefined) {
    const allowed = Array.isArray(access.allowClients)
      ? Boolean(
          context.clientId &&
          (access.allowClients as readonly string[]).includes(context.clientId),
        )
      : Boolean(
          await (
            access.allowClients as (
              clientId: string | undefined,
              context: SupabaseMcpContext<Database>,
            ) => boolean | Promise<boolean>
          )(context.clientId, context),
        );
    if (!allowed) {
      return {
        allowed: false,
        response: Response.json(
          {
            error: "unauthorized_client",
            error_description:
              "This OAuth client is not permitted to access this MCP endpoint.",
          },
          {
            status: 403,
            headers: {
              "cache-control": "no-store",
            },
          },
        ),
      };
    }
  }

  if (access.requiredScopes && access.requiredScopes.length > 0) {
    const required = normalizedScopes(access.requiredScopes);
    const missing = required.filter((scope) => !context.hasScope(scope));
    if (missing.length > 0) {
      const scopeParam = escapeHeaderQuoted(required.join(" "));
      const parts = [`error="insufficient_scope"`, `scope="${scopeParam}"`];
      if (resourceMetadataUrl) {
        parts.push(
          `resource_metadata="${escapeHeaderQuoted(resourceMetadataUrl)}"`,
        );
      }
      return {
        allowed: false,
        response: Response.json(
          {
            error: "insufficient_scope",
            error_description: `Missing required scope(s): ${missing.join(", ")}`,
            scope: required.join(" "),
          },
          {
            status: 403,
            headers: {
              "cache-control": "no-store",
              "www-authenticate": `Bearer ${parts.join(", ")}`,
            },
          },
        ),
      };
    }
  }

  return { allowed: true };
}

export interface ResultMiddlewareRunner<Database> {
  wrapRegistration(
    method: string,
    args: readonly unknown[],
    context: SupabaseMcpContext<Database>,
  ): unknown[];
}

export interface ResultMiddlewareEngineOptions<Database = unknown> {
  readonly resultMiddleware?:
    | SupabaseMcpResultMiddleware<Database>
    | readonly SupabaseMcpResultMiddleware<Database>[];
  onError?(event: SupabaseMcpErrorEvent): void;
}

export function createResultMiddlewareRunner<Database>(
  options: ResultMiddlewareEngineOptions<Database>,
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
            const candidate: ResultContentComposition = {
              ...composition,
              ...addition,
              prepend: [
                ...(composition.prepend ?? []),
                ...(addition.prepend ?? []),
              ],
              append: [
                ...(composition.append ?? []),
                ...(addition.append ?? []),
              ],
            };
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

export interface LifecycleEmitter<Database> {
  wrapRegistration(
    method: string,
    args: readonly unknown[],
    context: SupabaseMcpContext<Database>,
    canonicalName?: string,
  ): unknown[];
}

export interface LifecycleEngineOptions<Database = unknown> {
  readonly server: Implementation;
  readonly runCorrelation?: SupabaseMcpRunCorrelation<Database>;
  onEvent?(event: SupabaseMcpLifecycleEvent): void | Promise<void>;
  onError?(event: SupabaseMcpErrorEvent): void;
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

export function createLifecycleEmitter<Database>(
  options: LifecycleEngineOptions<Database>,
  clock: { now?(): number },
  runSlotForContext?: (
    context: SupabaseMcpContext<Database>,
  ) => RunSlot | undefined,
): LifecycleEmitter<Database> | undefined {
  if (!options.onEvent && !options.runCorrelation) return undefined;

  const now = (): number => clock.now?.() ?? Date.now();

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
    wrapRegistration(method, args, context, canonicalName) {
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
      const capability = Object.freeze({
        kind,
        name,
        ...(canonicalName && canonicalName !== name ? { canonicalName } : {}),
      });
      const common = {
        traceId: context.traceId,
        server,
        capability,
        principal,
        authentication,
      };

      const internals = getRunCorrelationInternals(options.runCorrelation);
      const runSlot = runSlotForContext?.(context);

      const wrapped = async function (
        this: unknown,
        ...callbackArgs: unknown[]
      ): Promise<unknown> {
        const serverContext = callbackArgs.at(-1) as ServerContext;
        const initialRun = options.runCorrelation
          ? await options.runCorrelation.resolve(context, {
              serverContext,
              ...(kind === "tool" && callbackArgs.length > 1
                ? { toolArguments: callbackArgs[0] }
                : {}),
            })
          : undefined;
        const verifiedInitialRun = initialRun
          ? lifecycleRunFact(initialRun)
          : null;
        if (runSlot && options.runCorrelation) {
          runSlot.value = verifiedInitialRun;
        }
        const meta =
          options.runCorrelation && serverContext
            ? internals?.resolutionMeta(serverContext)
            : undefined;
        const startedBase = options.runCorrelation
          ? {
              ...common,
              schemaVersion: 2 as const,
              run: verifiedInitialRun,
              ...(meta?.sessionId ? { sessionId: meta.sessionId } : {}),
            }
          : { ...common, schemaVersion: 1 as const };
        const startedAt = now();
        emit(
          Object.freeze({
            ...startedBase,
            type: "capability.started" as const,
            timestamp: new Date(startedAt).toISOString(),
          }),
        );
        const buildFinishedBase = () => {
          if (!options.runCorrelation) {
            return { ...common, schemaVersion: 1 as const };
          }
          const finalRun = initialRun ?? internals?.mintedFor(context) ?? null;
          return {
            ...common,
            schemaVersion: 2 as const,
            run: finalRun ? lifecycleRunFact(finalRun) : null,
            ...(meta?.runRejected ? { runRejected: meta.runRejected } : {}),
            ...(meta?.sessionId ? { sessionId: meta.sessionId } : {}),
          };
        };
        try {
          const result = await Reflect.apply(callback, this, callbackArgs);
          const finishedAt = now();
          emit(
            Object.freeze({
              ...buildFinishedBase(),
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
              ...buildFinishedBase(),
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

interface LazyCapabilitySeedState {
  tools: boolean;
  resources: boolean;
  prompts: boolean;
}

export interface ScopedServerOptions {
  readonly requiredScopes?: readonly string[];
  readonly disableSubscriptions?: boolean;
  readonly seedState?: LazyCapabilitySeedState;
}

function seedCapabilityFamilyIfNeeded(
  target: McpServerType,
  method: string,
  disableSubscriptions: boolean,
  seedState: LazyCapabilitySeedState,
): void {
  if (!disableSubscriptions) return;
  const lowLevel = target.server;
  if (!lowLevel || typeof lowLevel.registerCapabilities !== "function") return;
  const existing =
    typeof lowLevel.getCapabilities === "function"
      ? lowLevel.getCapabilities()
      : undefined;

  if (method === "registerTool" && !seedState.tools) {
    seedState.tools = true;
    if (existing?.tools === undefined) {
      lowLevel.registerCapabilities({ tools: { listChanged: false } });
    }
  } else if (
    (method === "registerResource" || method === "registerResourceTemplate") &&
    !seedState.resources
  ) {
    seedState.resources = true;
    if (existing?.resources === undefined) {
      lowLevel.registerCapabilities({
        resources: { listChanged: false, subscribe: false },
      });
    }
  } else if (method === "registerPrompt" && !seedState.prompts) {
    seedState.prompts = true;
    if (existing?.prompts === undefined) {
      lowLevel.registerCapabilities({ prompts: { listChanged: false } });
    }
  }
}

function prepareToolRegistrationArgs(args: readonly unknown[]): {
  readonly args: unknown[];
  readonly canonicalName?: string;
} {
  if (args.length < 3 || !isRecord(args[1])) {
    return { args: [...args] };
  }
  const config = args[1] as Record<string | symbol, unknown>;
  const rawCanonical = config[CHUMBO_CANONICAL_TOOL];
  const canonicalName =
    typeof rawCanonical === "string" ? rawCanonical : undefined;
  let cleaned: Record<string, unknown> = config as Record<string, unknown>;
  if (CHUMBO_CANONICAL_TOOL in config) {
    cleaned = { ...(config as Record<string, unknown>) };
  }
  const opened = withOpenOutputSchema(cleaned);
  if (opened === config && !(CHUMBO_CANONICAL_TOOL in config)) {
    return { args: [...args], canonicalName };
  }
  const nextArgs = [...args];
  nextArgs[1] = opened;
  return { args: nextArgs, canonicalName };
}

export function scopedServer<Database>(
  server: McpServerType,
  context: SupabaseMcpContext<Database>,
  lifecycle: LifecycleEmitter<Database> | undefined,
  resultMiddleware: ResultMiddlewareRunner<Database> | undefined,
  options: ScopedServerOptions = {},
): SupabaseMcpServer {
  const required = normalizedScopes(options.requiredScopes ?? []);
  const disableSubscriptions = options.disableSubscriptions ?? true;
  const seedState: LazyCapabilitySeedState = options.seedState ?? {
    tools: false,
    resources: false,
    prompts: false,
  };
  return new Proxy(server, {
    get(target, property) {
      if (property === "withScopes") {
        return (additional: readonly string[]) =>
          scopedServer(target, context, lifecycle, resultMiddleware, {
            requiredScopes: [...required, ...additional],
            disableSubscriptions,
            seedState,
          });
      }
      if (property === PRESENTED_TOOL_NAME) {
        return Reflect.get(target, property, target);
      }
      const value = Reflect.get(target, property, target);
      if (typeof property !== "string" || typeof value !== "function") {
        return value;
      }
      if (!REGISTRATION_METHODS.has(property)) return value.bind(target);
      return (...args: unknown[]) => {
        seedCapabilityFamilyIfNeeded(
          target,
          property,
          disableSubscriptions,
          seedState,
        );
        const prepared =
          property === "registerTool"
            ? prepareToolRegistrationArgs(args)
            : { args: [...args], canonicalName: undefined };
        let registrationArgs = lifecycle
          ? lifecycle.wrapRegistration(
              property,
              prepared.args,
              context,
              prepared.canonicalName,
            )
          : prepared.args;
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

const instrumentedServers = new WeakMap<object, SupabaseMcpServer>();

/**
 * Wrap an official `McpServer` for `ctx.chumbo.instrument(server)`:
 * - Idempotent when called on an already-instrumented server (or returned proxy).
 * - Fails closed with `TypeError` if `tools`, `resources`, or `prompts` were
 *   already registered prior to `instrument(server)`.
 */
export function instrumentMcpServer<Database>(
  server: McpServerType,
  context: SupabaseMcpContext<Database>,
  lifecycle: LifecycleEmitter<Database> | undefined,
  resultMiddleware: ResultMiddlewareRunner<Database> | undefined,
  options: { readonly disableSubscriptions?: boolean } = {},
): SupabaseMcpServer {
  const existingProxy = instrumentedServers.get(server);
  if (existingProxy) return existingProxy;

  const caps =
    typeof server.server?.getCapabilities === "function"
      ? server.server.getCapabilities()
      : undefined;
  if (
    caps &&
    (caps.tools !== undefined ||
      caps.resources !== undefined ||
      caps.prompts !== undefined)
  ) {
    throw new TypeError(
      "ctx.chumbo.instrument(server) must be called before registering tools, resources, or prompts on McpServer; pre-registered capabilities would bypass scope checks, lifecycle telemetry, and result middleware.",
    );
  }

  const wrapped = scopedServer(server, context, lifecycle, resultMiddleware, {
    disableSubscriptions: options.disableSubscriptions ?? true,
  });
  instrumentedServers.set(server, wrapped);
  instrumentedServers.set(wrapped, wrapped);
  return wrapped;
}

export async function createSurfaceProof(
  response: Response,
  request: SurfaceListRequest,
  server: Implementation,
  authentication: SupabaseMcpAuthentication,
  profile?: string,
): Promise<SupabaseMcpSurfaceProof | null> {
  if (!response.ok) return null;
  if (
    !boundedUtf8(server.name, SURFACE_CANONICAL_LIMITS.maxServerNameBytes) ||
    !server.name ||
    !boundedUtf8(
      server.version,
      SURFACE_CANONICAL_LIMITS.maxServerVersionBytes,
    ) ||
    !server.version ||
    !boundedUtf8(
      authentication.strategy,
      SURFACE_CANONICAL_LIMITS.maxNameBytes,
    ) ||
    !authentication.strategy
  ) {
    return null;
  }
  const body = await boundedBodyText(response, MAX_SURFACE_RESPONSE_BYTES);
  if (!body) return null;
  const payload = jsonRpcPayloadFromResponseText(body.text);
  if (!isRecord(payload) || payload.jsonrpc !== "2.0" || "error" in payload) {
    return null;
  }
  const result = isRecord(payload.result) ? payload.result : undefined;
  if (!result || !Array.isArray(result.tools) || result.nextCursor != null) {
    return null;
  }
  const computed = await computeCanonicalSurfaceDigest(result.tools);
  if (!computed) return null;
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
    ...(profile ? { profile } : {}),
    tools: computed.tools,
    contentDigest: computed.contentDigest,
  };
  if (
    new TextEncoder().encode(JSON.stringify(proof)).byteLength >
    SURFACE_CANONICAL_LIMITS.maxProofBytes
  ) {
    return null;
  }
  return Object.freeze(proof);
}

export interface ResolvedActiveProfile<Database = unknown> {
  readonly id: string;
  readonly profile: SupabaseMcpProfileLike<string, Database>;
  readonly vocabulary?: {
    readonly knownTools: ReadonlySet<string>;
    readonly plainWordTools: ReadonlySet<string>;
    rewrite(
      text: string,
      mounted: ReadonlySet<string>,
      aliases?: ReadonlyMap<string, string>,
    ): string;
  };
}

export async function resolveActiveProfile<Database = unknown>(
  profiles: SupabaseMcpProfilesOptions<string, Database> | undefined,
  context: SupabaseMcpContext<Database>,
): Promise<ResolvedActiveProfile<Database> | undefined> {
  if (!profiles) return undefined;
  const selected = await profiles.select(context);
  const id = profiles.catalog.parseId(selected);
  const profile = profiles.catalog.get(id);
  return {
    id,
    profile,
    ...(profiles.catalog.vocabulary
      ? { vocabulary: profiles.catalog.vocabulary }
      : {}),
  };
}

export async function resolveProfileInstructions<
  Database = unknown,
  Context extends SupabaseMcpContext<Database> = SupabaseMcpContext<Database>,
>(
  baseInstructions:
    | string
    | ((context: Context) => string | undefined | Promise<string | undefined>)
    | undefined,
  activeProfile: ResolvedActiveProfile<Database> | undefined,
  context: Context,
): Promise<string | undefined> {
  const source =
    activeProfile?.profile.instructions !== undefined
      ? activeProfile.profile.instructions
      : baseInstructions;
  const raw =
    typeof source === "function"
      ? await (
          source as (
            ctx: Context,
          ) => string | undefined | Promise<string | undefined>
        )(context)
      : source;
  if (!raw || !activeProfile?.vocabulary) return raw;

  const mounted = new Set<string>();
  const aliases = new Map<string, string>();
  for (const canonical of activeProfile.profile.tools) {
    const presented =
      activeProfile.profile.presentedNameFor(canonical) ?? canonical;
    mounted.add(presented);
    if (presented !== canonical) {
      aliases.set(canonical, presented);
    }
  }
  for (const sysTool of activeProfile.profile.systemTools) {
    mounted.add(sysTool);
  }
  return activeProfile.vocabulary.rewrite(raw, mounted, aliases);
}

export function applyActiveProfile<Database = unknown>(
  server: SupabaseMcpServer,
  activeProfile: ResolvedActiveProfile<Database> | undefined,
): SupabaseMcpServer {
  if (!activeProfile) return server;
  return withProfile(
    server,
    activeProfile.profile as DefinedChumboProfile<string, Database>,
    activeProfile.vocabulary
      ? { vocabulary: activeProfile.vocabulary }
      : undefined,
  );
}

export function responseWithMergedHeaders(
  response: Response,
  values: Readonly<Record<string, string>>,
  extraExposeHeaders: readonly string[] = [],
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(values)) {
    if (name.toLowerCase() === "access-control-expose-headers") {
      headers.set(
        "access-control-expose-headers",
        mergeExposedHeaders(headers.get("access-control-expose-headers"), [
          value,
          ...extraExposeHeaders,
        ]),
      );
      continue;
    }
    headers.set(name, value);
  }
  if (
    !Object.keys(values).some(
      (name) => name.toLowerCase() === "access-control-expose-headers",
    )
  ) {
    headers.set(
      "access-control-expose-headers",
      mergeExposedHeaders(
        headers.get("access-control-expose-headers"),
        extraExposeHeaders,
      ),
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
