import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  DEFAULT_CLIENT_SUPPORT,
  encodeClientSupportMask,
} from "./client-context.js";
import { assertCollectionBudget } from "./internal/collection-budget.js";
import { errorResult, renderResult, type JsonValue } from "./results.js";
import {
  SupabaseMcpStateConflictError,
  SupabaseMcpStateMissingError,
  SupabaseMcpStateUnavailableError,
} from "./state.js";
import type {
  SupabaseMcpClientSupport,
  SupabaseMcpContext,
  SupabaseMcpServer,
  SupabaseMcpState,
} from "./types.js";

export const MCP_SESSION_HEADER = "mcp-session-id";
export const DEFAULT_ACTIVE_WORKSPACE_TTL_SECONDS = 24 * 60 * 60;

const visibleSessionIdPattern = /^[\x21-\x7e]{1,1024}$/u;
const uuidHexPattern = /^[0-9a-f]{32}$/;
const safeIdentifierPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const forbiddenPropertyNames = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const MAX_CAS_ATTEMPTS = 4;

function validateSafeIdentifier(value: string, label: string): string {
  if (!safeIdentifierPattern.test(value) || forbiddenPropertyNames.has(value)) {
    throw new TypeError(
      `${label} must be a 1-64 character ASCII identifier starting with a letter and must not be a reserved prototype property.`,
    );
  }
  return value;
}

function mergeExposeHeaderValue(
  existing: string | null,
  headerToExpose: string,
): string {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const part of (existing ?? "").split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      ordered.push(trimmed);
    }
  }
  const lowerTarget = headerToExpose.trim().toLowerCase();
  if (lowerTarget && !seen.has(lowerTarget)) {
    ordered.push(headerToExpose.trim());
  }
  return ordered.join(", ");
}

function randomUuid32Hex(randomUUID: () => string): string {
  const candidate = randomUUID().replaceAll("-", "").toLowerCase();
  if (uuidHexPattern.test(candidate)) return candidate;
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Extract a spec-valid visible-ASCII `Mcp-Session-Id` (`0x21..0x7E`, 1..1024 chars),
 * supporting UUIDs, `cs1_<uuid32>_<mask>`, and `crun1.<payload>.<mac>` session headers.
 */
export function mcpSessionId(request: Request): string | null {
  const raw = request.headers.get(MCP_SESSION_HEADER);
  if (!raw || !visibleSessionIdPattern.test(raw)) return null;
  return raw;
}

/**
 * Stamp a fresh `cs1_<uuid32>_<capHex>` header onto a successful 2025 `initialize`
 * response when no `Mcp-Session-Id` header is already present.
 */
export function issueMcpSessionId(
  response: Response,
  supports: SupabaseMcpClientSupport = DEFAULT_CLIENT_SUPPORT,
  randomUUID: () => string = () => globalThis.crypto.randomUUID(),
): Response {
  if (response.headers.has(MCP_SESSION_HEADER)) return response;
  const sessionId = `cs1_${randomUuid32Hex(randomUUID)}_${encodeClientSupportMask(supports)}`;
  const headers = new Headers(response.headers);
  headers.set(MCP_SESSION_HEADER, sessionId);
  headers.set(
    "access-control-expose-headers",
    mergeExposeHeaderValue(
      headers.get("access-control-expose-headers"),
      "Mcp-Session-Id",
    ),
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export interface WorkspaceDescriptor {
  readonly id: string;
  readonly name: string;
}

export interface ActiveWorkspaceStoreOptions {
  /** Configured namespace in `state.namespaces` (e.g. `"mcp.active-workspace"`). */
  readonly namespace: string;
  /** Object key inside the session partition. Defaults to `"active-workspace"`. */
  readonly key?: string;
  /** Defaults to 86,400 (24 hours), clamped to namespace `maxTtlSeconds` when known. */
  readonly ttlSeconds?: number;
}

export interface ActiveWorkspaceStore {
  read(): Promise<{
    readonly workspaceId: string;
    readonly revision: number;
  } | null>;
  write(workspaceId: string): Promise<void>;
  clear(revision: number): Promise<void>;
}

interface StoredActiveWorkspace {
  readonly v: 1;
  readonly workspaceId: string;
  readonly updatedAt: string;
}

function isStoredWorkspaceRecord(
  value: unknown,
): value is { readonly workspaceId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { workspaceId?: unknown }).workspaceId === "string" &&
    (value as { workspaceId: string }).workspaceId.trim().length > 0
  );
}

export function activeWorkspaceStore(
  sessionState: SupabaseMcpState,
  options: ActiveWorkspaceStoreOptions,
): ActiveWorkspaceStore {
  const namespace = options.namespace;
  const objectKey = options.key ?? "active-workspace";

  function resolveTtlSeconds(): number {
    const configured = sessionState.namespaceOptions?.(namespace);
    if (options.ttlSeconds !== undefined) {
      return configured
        ? Math.min(options.ttlSeconds, configured.maxTtlSeconds)
        : options.ttlSeconds;
    }
    return configured
      ? Math.min(DEFAULT_ACTIVE_WORKSPACE_TTL_SECONDS, configured.maxTtlSeconds)
      : DEFAULT_ACTIVE_WORKSPACE_TTL_SECONDS;
  }

  return Object.freeze({
    async read() {
      const stored = await sessionState.get<JsonValue>(namespace, objectKey);
      if (!stored) return null;
      if (!isStoredWorkspaceRecord(stored.value)) return null;
      return Object.freeze({
        workspaceId: stored.value.workspaceId,
        revision: stored.revision,
      });
    },

    async write(workspaceId: string) {
      const normalized = workspaceId.trim();
      if (!normalized) {
        throw new TypeError("Active workspace ID must be a non-empty string.");
      }
      const ttlSeconds = resolveTtlSeconds();
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const current = await sessionState.get<JsonValue>(namespace, objectKey);
        const payload: StoredActiveWorkspace = {
          v: 1,
          workspaceId: normalized,
          updatedAt: new Date().toISOString(),
        };
        try {
          await sessionState.put(namespace, objectKey, {
            value: payload as unknown as JsonValue,
            expectedRevision: current?.revision ?? null,
            ttlSeconds,
          });
          return;
        } catch (error) {
          if (
            (error instanceof SupabaseMcpStateConflictError ||
              error instanceof SupabaseMcpStateMissingError) &&
            attempt + 1 < MAX_CAS_ATTEMPTS
          ) {
            continue;
          }
          throw error;
        }
      }
    },

    async clear(revision: number) {
      try {
        await sessionState.delete(namespace, objectKey, {
          expectedRevision: revision,
        });
      } catch (error) {
        if (
          error instanceof SupabaseMcpStateConflictError ||
          error instanceof SupabaseMcpStateMissingError
        ) {
          return;
        }
        throw error;
      }
    },
  });
}

export type WorkspaceRouteProblem =
  | "no_session"
  | "no_choice"
  | "not_authorized"
  | "removed"
  | "unavailable";

export interface WorkspaceRoutingTerminology {
  /** Argument name on scoped tools and `use_<noun>`. Defaults to `"workspace"`. */
  readonly paramName?: string;
  /** Selector tool name. Defaults to `"use_workspace"`. */
  readonly selectorToolName?: string;
  /** Discovery tool name that lists valid choices (e.g. `"list_workspaces"`). */
  readonly listToolName: string;
  /** Human noun for prose messages. Defaults to `paramName` (e.g. `"project"`). */
  readonly noun?: string;
}

function normalizedTerminology(terminology: WorkspaceRoutingTerminology): {
  paramName: string;
  selectorToolName: string;
  listToolName: string;
  noun: string;
} {
  const paramName = validateSafeIdentifier(
    terminology.paramName ?? "workspace",
    "Workspace paramName",
  );
  const selectorToolName = validateSafeIdentifier(
    terminology.selectorToolName ?? `use_${paramName}`,
    "Workspace selectorToolName",
  );
  const listToolName = validateSafeIdentifier(
    terminology.listToolName,
    "Workspace listToolName",
  );
  const rawNoun = (terminology.noun ?? paramName).trim();
  if (!rawNoun) {
    throw new TypeError("Workspace noun must be non-empty.");
  }
  return { paramName, selectorToolName, listToolName, noun: rawNoun };
}

export function workspaceRequiredMessage(
  problem: WorkspaceRouteProblem,
  terminology: WorkspaceRoutingTerminology,
): string {
  const { paramName, selectorToolName, listToolName, noun } =
    normalizedTerminology(terminology);
  switch (problem) {
    case "no_session":
      return `No MCP session header is active on this connection, so an active ${noun} cannot be remembered across calls. Call ${listToolName} and pass ${paramName} explicitly on each tool call.`;
    case "no_choice":
      return `Multiple ${noun}s are available and no active ${noun} is selected for this session. Call ${listToolName}, then call ${selectorToolName} to set one for this session or pass ${paramName} directly.`;
    case "not_authorized":
      return `The requested ${noun} is not available on this connection. Call ${listToolName} to inspect authorized ${noun}s.`;
    case "removed":
      return `The previously selected ${noun} for this session is no longer available on this connection and has been cleared. Call ${listToolName} and select a current ${noun} with ${selectorToolName} or pass ${paramName} directly.`;
    case "unavailable":
      return `Session ${noun} state is temporarily unavailable. Pass ${paramName} explicitly on this call after checking ${listToolName}.`;
  }
}

function nextStepForProblem(
  problem: WorkspaceRouteProblem,
  terms: ReturnType<typeof normalizedTerminology>,
): string {
  switch (problem) {
    case "no_session":
    case "unavailable":
      return `Call ${terms.listToolName} and pass ${terms.paramName} on each call.`;
    case "no_choice":
    case "removed":
      return `Call ${terms.listToolName}, then call ${terms.selectorToolName} or pass ${terms.paramName}.`;
    case "not_authorized":
      return `Call ${terms.listToolName} and choose an authorized ${terms.noun}.`;
  }
}

export interface ResolveActiveWorkspaceOptions<
  Workspace extends WorkspaceDescriptor = WorkspaceDescriptor,
  Database = unknown,
>
  extends ActiveWorkspaceStoreOptions, WorkspaceRoutingTerminology {
  /** Explicit argument passed on this tool call (`args.workspace`), if any. Always wins. */
  readonly explicitId?: string;
  /**
   * Authoritative list of workspaces this caller currently reaches (e.g. via RLS query).
   * Re-evaluated on EVERY call — stored session state never bypasses authorization.
   */
  listAuthorized(
    context: SupabaseMcpContext<Database>,
  ): readonly Workspace[] | Promise<readonly Workspace[]>;
  /** Automatically select when the caller has exactly one authorized workspace. Defaults to `true`. */
  readonly autoSelectSingle?: boolean;
}

export type ResolveActiveWorkspaceResult<
  Workspace extends WorkspaceDescriptor = WorkspaceDescriptor,
> =
  | {
      readonly ok: true;
      readonly workspace: Workspace;
      readonly source: "explicit" | "single" | "session";
    }
  | {
      readonly ok: false;
      readonly problem: WorkspaceRouteProblem;
      /** Ready-to-return `errorResult` naming the exact recovery action for this client. */
      readonly error: CallToolResult;
    };

export async function resolveActiveWorkspace<
  Workspace extends WorkspaceDescriptor = WorkspaceDescriptor,
  Database = unknown,
>(
  context: SupabaseMcpContext<Database>,
  options: ResolveActiveWorkspaceOptions<Workspace, Database>,
): Promise<ResolveActiveWorkspaceResult<Workspace>> {
  const terms = normalizedTerminology(options);
  const failWith = (
    problem: WorkspaceRouteProblem,
  ): ResolveActiveWorkspaceResult<Workspace> =>
    Object.freeze({
      ok: false as const,
      problem,
      error: errorResult(
        workspaceRequiredMessage(problem, options),
        nextStepForProblem(problem, terms),
      ),
    });

  const authorized = await options.listAuthorized(context);
  const explicit = options.explicitId?.trim();
  if (explicit) {
    const matched = authorized.find((workspace) => workspace.id === explicit);
    if (!matched) return failWith("not_authorized");
    return Object.freeze({
      ok: true as const,
      workspace: matched,
      source: "explicit" as const,
    });
  }

  if (authorized.length === 0) {
    return failWith("not_authorized");
  }

  if (context.sessionState) {
    const store = activeWorkspaceStore(context.sessionState, options);
    let stored: Awaited<ReturnType<ActiveWorkspaceStore["read"]>>;
    try {
      stored = await store.read();
    } catch (error) {
      if (error instanceof SupabaseMcpStateUnavailableError) {
        return failWith("unavailable");
      }
      throw error;
    }
    if (stored) {
      const matched = authorized.find(
        (workspace) => workspace.id === stored.workspaceId,
      );
      if (!matched) {
        await store.clear(stored.revision).catch(() => {});
        return failWith("removed");
      }
      return Object.freeze({
        ok: true as const,
        workspace: matched,
        source: "session" as const,
      });
    }
  }

  if ((options.autoSelectSingle ?? true) && authorized.length === 1) {
    return Object.freeze({
      ok: true as const,
      workspace: authorized[0]!,
      source: "single" as const,
    });
  }

  if (!context.sessionId) return failWith("no_session");
  if (!context.sessionState) return failWith("unavailable");
  return failWith("no_choice");
}

export interface RegisterUseWorkspaceOptions<
  Workspace extends WorkspaceDescriptor = WorkspaceDescriptor,
  Database = unknown,
> extends Omit<
  ResolveActiveWorkspaceOptions<Workspace, Database>,
  "explicitId"
> {
  readonly description?: string;
}

/** Register the `use_workspace` (or `use_<noun>`) tool on `server` for `context`. */
export function registerUseWorkspace<
  Workspace extends WorkspaceDescriptor = WorkspaceDescriptor,
  Database = unknown,
>(
  server: SupabaseMcpServer,
  context: SupabaseMcpContext<Database>,
  options: RegisterUseWorkspaceOptions<Workspace, Database>,
): void {
  const terms = normalizedTerminology(options);
  const inputShape = {
    [terms.paramName]: z
      .string()
      .min(1)
      .describe(
        `Authorized ${terms.noun} ID returned by ${terms.listToolName}.`,
      ),
  };
  const outputShape = {
    [terms.paramName]: z.object({
      id: z.string(),
      name: z.string(),
    }),
  };

  server.registerTool(
    terms.selectorToolName,
    {
      description:
        options.description ??
        `Select the active ${terms.noun} for subsequent tool calls in this MCP session. Call ${terms.listToolName} first to inspect valid IDs.`,
      inputSchema: z.object(inputShape),
      outputSchema: z.object(outputShape),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args: Record<string, unknown>) => {
      if (!context.sessionId) {
        return errorResult(
          workspaceRequiredMessage("no_session", options),
          nextStepForProblem("no_session", terms),
        );
      }
      if (!context.sessionState) {
        return errorResult(
          workspaceRequiredMessage("unavailable", options),
          nextStepForProblem("unavailable", terms),
        );
      }
      const rawTarget = args[terms.paramName];
      const targetId = typeof rawTarget === "string" ? rawTarget.trim() : "";
      if (!targetId) {
        return errorResult(
          workspaceRequiredMessage("not_authorized", options),
          nextStepForProblem("not_authorized", terms),
        );
      }
      const authorized = await options.listAuthorized(context);
      const matched = authorized.find((workspace) => workspace.id === targetId);
      if (!matched) {
        return errorResult(
          workspaceRequiredMessage("not_authorized", options),
          nextStepForProblem("not_authorized", terms),
        );
      }
      try {
        const store = activeWorkspaceStore(context.sessionState, options);
        await store.write(matched.id);
      } catch (error) {
        if (error instanceof SupabaseMcpStateUnavailableError) {
          return errorResult(
            workspaceRequiredMessage("unavailable", options),
            nextStepForProblem("unavailable", terms),
          );
        }
        throw error;
      }
      return renderResult(
        {
          [terms.paramName]: {
            id: matched.id,
            name: matched.name,
          },
        },
        () =>
          `Active ${terms.noun} set to ${matched.name} (${matched.id}) for this session.`,
      );
    },
  );
}

/**
 * Echo the resolved workspace in both `content[].text` and `structuredContent[fieldName]`
 * on non-error results so multi-workspace calls are self-identifying. Preserves
 * `io.chumbo/collectionMaxBytes` when applied to a `collectionResult`.
 */
export function withWorkspaceEcho<
  Workspace extends WorkspaceDescriptor = WorkspaceDescriptor,
>(
  result: CallToolResult,
  workspace: Workspace,
  options: { readonly fieldName?: string; readonly label?: string } = {},
): CallToolResult {
  if (result.isError === true) return result;
  const fieldName = validateSafeIdentifier(
    options.fieldName ?? "workspace",
    "Workspace echo fieldName",
  );
  const label = (options.label ?? fieldName).trim() || fieldName;
  const prefix = `[${label}: ${workspace.name} (${workspace.id})]`;

  let nextContent: CallToolResult["content"];
  const textIndex = result.content.findIndex((block) => block.type === "text");
  if (textIndex >= 0) {
    nextContent = result.content.map((block, index) =>
      index === textIndex && block.type === "text"
        ? {
            ...block,
            text: block.text ? `${prefix}\n${block.text}` : prefix,
          }
        : block,
    );
  } else if (result.content.length > 0) {
    nextContent = [{ type: "text", text: prefix }, ...result.content];
  } else {
    nextContent = [];
  }

  let nextStructured: Record<string, unknown> | undefined;
  if (
    result.structuredContent &&
    typeof result.structuredContent === "object" &&
    !Array.isArray(result.structuredContent)
  ) {
    const safeClone: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(result.structuredContent)) {
      if (!forbiddenPropertyNames.has(key)) safeClone[key] = value;
    }
    safeClone[fieldName] = { id: workspace.id, name: workspace.name };
    nextStructured = safeClone;
  }

  const candidate: CallToolResult = {
    ...result,
    content: nextContent,
    ...(nextStructured !== undefined
      ? { structuredContent: nextStructured }
      : {}),
  };

  try {
    assertCollectionBudget(candidate);
    return candidate;
  } catch {
    return result;
  }
}
