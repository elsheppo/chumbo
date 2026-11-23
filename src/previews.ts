import type { CallToolResult } from "@modelcontextprotocol/server";
import { canonicalJsonValue, sha256Hex } from "./internal/surface-canonical.js";
import { errorResult, type JsonValue } from "./results.js";
import {
  SupabaseMcpStateConflictError,
  SupabaseMcpStateMissingError,
  SupabaseMcpStateUnavailableError,
} from "./state.js";
import type { SupabaseMcpState } from "./types.js";

export const previewLimits = Object.freeze({
  defaultTtlSeconds: 300,
  maxTtlSeconds: 900,
  tokenPattern: /^cprev1_[A-Za-z0-9_-]{32}$/,
});

interface StoredPreviewRecord<Summary extends JsonValue = JsonValue> {
  readonly v: 1;
  readonly tool: string;
  readonly payloadDigest: `sha256:${string}`;
  readonly mintedAt: string;
  readonly summary?: Summary;
}

export interface MintPreviewOptions<Summary extends JsonValue = JsonValue> {
  readonly namespace: string;
  /** Exact MCP tool name this token authorizes (e.g. `"delete_project"`). */
  readonly tool: string;
  /**
   * Optional verified caller/tenant/workspace scope bound into the SHA-256 digest
   * (especially recommended on shared-API-key surfaces where `ctx.state` is shared).
   */
  readonly scope?: string;
  /**
   * Canonical domain mutation arguments (excluding `dry_run` / `confirm_token` carrier fields).
   * Must be valid JSON; hashed with SHA-256 and never stored raw in state.
   */
  readonly payload: Readonly<Record<string, JsonValue>>;
  /** Optional bounded human/model summary echoed back on consumption. */
  readonly summary?: Summary;
  /** Lifetime in seconds (`1..min(900, namespace.maxTtlSeconds)`). Defaults to `min(300, namespace.ttlSeconds, namespace.maxTtlSeconds)`. */
  readonly ttlSeconds?: number;
}

export interface MintedPreview<Summary extends JsonValue = JsonValue> {
  readonly token: `cprev1_${string}`;
  readonly payloadDigest: `sha256:${string}`;
  readonly expiresAt: string;
  readonly summary?: Summary;
}

export type ConsumePreviewFailureReason =
  | "state_unavailable"
  | "invalid_token"
  | "missing_or_consumed"
  | "payload_mismatch";

export interface ConsumePreviewOptions {
  readonly namespace: string;
  readonly tool: string;
  readonly token: string;
  /** Must match the `scope` passed to `mintPreview` (or both omitted). */
  readonly scope?: string;
  /** Current call's domain mutation arguments — must hash identically to `mintPreview`. */
  readonly payload: Readonly<Record<string, JsonValue>>;
}

export type ConsumePreviewResult<Summary extends JsonValue = JsonValue> =
  | {
      readonly ok: true;
      readonly payloadDigest: `sha256:${string}`;
      readonly mintedAt: string;
      readonly summary?: Summary;
    }
  | {
      readonly ok: false;
      readonly reason: ConsumePreviewFailureReason;
      /** Actionable `errorResult` steering the model to run a fresh preview. */
      readonly error: CallToolResult;
    };

function base64UrlEncode24Bytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function generatePreviewToken(): `cprev1_${string}` {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return `cprev1_${base64UrlEncode24Bytes(bytes)}`;
}

function validateToolName(tool: string): string {
  const trimmed = tool.trim();
  if (!trimmed) {
    throw new TypeError("Preview tool must be a non-empty MCP tool name.");
  }
  return trimmed;
}

async function computePreviewDigest(input: {
  readonly tool: string;
  readonly scope: string | undefined;
  readonly payload: Readonly<Record<string, JsonValue>>;
}): Promise<`sha256:${string}`> {
  if (
    typeof input.payload !== "object" ||
    input.payload === null ||
    Array.isArray(input.payload)
  ) {
    throw new TypeError("Preview payload must be a JSON object.");
  }
  const canonical = canonicalJsonValue({
    v: 1,
    tool: input.tool,
    scope: input.scope ?? null,
    payload: input.payload,
  });
  if (canonical === null) {
    throw new TypeError(
      "Preview payload must be finite JSON within canonical nesting depth limits.",
    );
  }
  return `sha256:${await sha256Hex(JSON.stringify(canonical))}`;
}

function resolvePreviewTtlSeconds(
  state: SupabaseMcpState,
  namespace: string,
  requestedTtl: number | undefined,
): number {
  const configured = state.namespaceOptions?.(namespace);
  if (requestedTtl !== undefined) {
    if (
      !Number.isSafeInteger(requestedTtl) ||
      requestedTtl < 1 ||
      requestedTtl > previewLimits.maxTtlSeconds
    ) {
      throw new RangeError(
        `Preview ttlSeconds must be an integer between 1 and ${previewLimits.maxTtlSeconds} seconds.`,
      );
    }
    if (configured && requestedTtl > configured.maxTtlSeconds) {
      throw new RangeError(
        `Preview ttlSeconds (${requestedTtl}s) exceeds namespace "${namespace}" maxTtlSeconds (${configured.maxTtlSeconds}s).`,
      );
    }
    return requestedTtl;
  }
  if (!configured) return previewLimits.defaultTtlSeconds;
  return Math.min(
    configured.ttlSeconds,
    configured.maxTtlSeconds,
    previewLimits.defaultTtlSeconds,
  );
}

function parseStoredPreview<Summary extends JsonValue>(
  value: unknown,
): StoredPreviewRecord<Summary> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.v !== 1 ||
    typeof record.tool !== "string" ||
    !record.tool ||
    typeof record.payloadDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(record.payloadDigest) ||
    typeof record.mintedAt !== "string" ||
    !Number.isFinite(Date.parse(record.mintedAt))
  ) {
    return null;
  }
  return {
    v: 1,
    tool: record.tool,
    payloadDigest: record.payloadDigest as `sha256:${string}`,
    mintedAt: record.mintedAt,
    ...(record.summary !== undefined
      ? { summary: record.summary as Summary }
      : {}),
  };
}

export async function mintPreview<Summary extends JsonValue = JsonValue>(
  state: SupabaseMcpState | undefined,
  options: MintPreviewOptions<Summary>,
): Promise<MintedPreview<Summary>> {
  if (!state) {
    throw new SupabaseMcpStateUnavailableError();
  }
  const tool = validateToolName(options.tool);
  const ttlSeconds = resolvePreviewTtlSeconds(
    state,
    options.namespace,
    options.ttlSeconds,
  );
  const payloadDigest = await computePreviewDigest({
    tool,
    scope: options.scope,
    payload: options.payload,
  });
  const token = generatePreviewToken();
  const record: StoredPreviewRecord<Summary> = {
    v: 1,
    tool,
    payloadDigest,
    mintedAt: new Date().toISOString(),
    ...(options.summary !== undefined ? { summary: options.summary } : {}),
  };
  const written = await state.put<JsonValue>(
    options.namespace,
    `preview:${token}`,
    {
      value: record as unknown as JsonValue,
      expectedRevision: null,
      ttlSeconds,
    },
  );
  return Object.freeze({
    token,
    payloadDigest,
    expiresAt: written.expiresAt,
    ...(options.summary !== undefined ? { summary: options.summary } : {}),
  });
}

/**
 * Verify tool + scope + canonical payload SHA-256 digest and atomically delete the
 * preview receipt BEFORE the caller executes its domain mutation.
 */
export async function consumePreview<Summary extends JsonValue = JsonValue>(
  state: SupabaseMcpState | undefined,
  options: ConsumePreviewOptions,
): Promise<ConsumePreviewResult<Summary>> {
  const tool = validateToolName(options.tool);
  if (!state) {
    return Object.freeze({
      ok: false as const,
      reason: "state_unavailable" as const,
      error: errorResult(
        `Confirmation state is unavailable, so ${tool} was not executed.`,
        `Retry after durable state recovers and request a fresh preview.`,
      ),
    });
  }

  const token = options.token.trim();
  if (!previewLimits.tokenPattern.test(token)) {
    return Object.freeze({
      ok: false as const,
      reason: "invalid_token" as const,
      error: errorResult(
        `The confirmation token for ${tool} is malformed. Nothing was changed.`,
        `Run ${tool} in preview mode first to mint a valid confirmation token.`,
      ),
    });
  }

  const expectedDigest = await computePreviewDigest({
    tool,
    scope: options.scope,
    payload: options.payload,
  });
  const objectKey = `preview:${token}`;

  let stored: Awaited<ReturnType<SupabaseMcpState["get"]>>;
  try {
    stored = await state.get<JsonValue>(options.namespace, objectKey);
  } catch (error) {
    if (error instanceof SupabaseMcpStateUnavailableError) {
      return Object.freeze({
        ok: false as const,
        reason: "state_unavailable" as const,
        error: errorResult(
          `Confirmation state is unavailable, so ${tool} was not executed.`,
          `Retry after durable state recovers and request a fresh preview.`,
        ),
      });
    }
    throw error;
  }

  const parsed = stored ? parseStoredPreview<Summary>(stored.value) : null;
  if (!stored || !parsed) {
    return Object.freeze({
      ok: false as const,
      reason: "missing_or_consumed" as const,
      error: errorResult(
        `The confirmation token for ${tool} has expired, was already used, or does not exist. Nothing was changed.`,
        `Run ${tool} in preview mode again to review current parameters and mint a fresh token.`,
      ),
    });
  }

  if (parsed.tool !== tool || parsed.payloadDigest !== expectedDigest) {
    // Burn tampered or mismatched tokens immediately so parameters cannot be probed.
    await state
      .delete(options.namespace, objectKey, {
        expectedRevision: stored.revision,
      })
      .catch(() => false);
    return Object.freeze({
      ok: false as const,
      reason: "payload_mismatch" as const,
      error: errorResult(
        `The arguments or tool for ${tool} do not match the approved preview, so the token was invalidated and nothing was changed.`,
        `Run ${tool} in preview mode with the exact intended arguments to mint a new confirmation token.`,
      ),
    });
  }

  let deleted = false;
  try {
    deleted = await state.delete(options.namespace, objectKey, {
      expectedRevision: stored.revision,
    });
  } catch (error) {
    if (
      error instanceof SupabaseMcpStateConflictError ||
      error instanceof SupabaseMcpStateMissingError
    ) {
      deleted = false;
    } else if (error instanceof SupabaseMcpStateUnavailableError) {
      return Object.freeze({
        ok: false as const,
        reason: "state_unavailable" as const,
        error: errorResult(
          `Confirmation state is unavailable, so ${tool} was not executed.`,
          `Retry after durable state recovers and request a fresh preview.`,
        ),
      });
    } else {
      throw error;
    }
  }

  if (!deleted) {
    return Object.freeze({
      ok: false as const,
      reason: "missing_or_consumed" as const,
      error: errorResult(
        `The confirmation token for ${tool} was already consumed by another request. Nothing was changed.`,
        `Check current state before minting a new preview.`,
      ),
    });
  }

  return Object.freeze({
    ok: true as const,
    payloadDigest: parsed.payloadDigest,
    mintedAt: parsed.mintedAt,
    ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
  });
}
