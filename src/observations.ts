import type { CallToolResult } from "@modelcontextprotocol/server";
import { errorResult, type JsonValue } from "./results.js";
import {
  SupabaseMcpStateConflictError,
  SupabaseMcpStateMissingError,
  SupabaseMcpStateUnavailableError,
} from "./state.js";
import type { SupabaseMcpState, SupabaseMcpStateValue } from "./types.js";

const MAX_OBSERVE_CAS_ATTEMPTS = 4;

/** Positive integer version or non-empty opaque ETag / content digest. */
export type ObservedResourceVersion = number | string;

export interface ObservationReceipt<
  Meta extends Readonly<Record<string, JsonValue>> = Readonly<
    Record<string, JsonValue>
  >,
> {
  readonly v: 1;
  readonly resourceVersion: ObservedResourceVersion;
  readonly scope: string;
  readonly observedAt: string;
  readonly meta?: Meta;
}

export interface ObserveResourceOptions<
  Meta extends Readonly<Record<string, JsonValue>> = Readonly<
    Record<string, JsonValue>
  >,
> {
  readonly namespace: string;
  /** Immutable, authorized resource key (e.g. `document:${doc.id}`). Never raw user path input. */
  readonly resourceKey: string;
  readonly resourceVersion: ObservedResourceVersion;
  /** Observation breadth, e.g. `"full"` or `"blocks:4-8"`. Defaults to `"full"`. */
  readonly scope?: string;
  readonly meta?: Meta;
  readonly ttlSeconds?: number;
}

function validateResourceVersion(version: ObservedResourceVersion): void {
  if (typeof version === "number") {
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new TypeError(
        "Observed resourceVersion numbers must be non-negative safe integers.",
      );
    }
    return;
  }
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new TypeError(
      "Observed resourceVersion strings must be non-empty version identifiers.",
    );
  }
}

function validateScopeName(scope: string): string {
  const trimmed = scope.trim();
  if (!trimmed) {
    throw new TypeError("Observation scope must be a non-empty string.");
  }
  return trimmed;
}

function parseStoredReceipt<Meta extends Readonly<Record<string, JsonValue>>>(
  value: unknown,
): ObservationReceipt<Meta> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.v !== 1) return null;
  const rv = candidate.resourceVersion;
  const validVersion =
    (typeof rv === "number" && Number.isSafeInteger(rv) && rv >= 0) ||
    (typeof rv === "string" && rv.trim().length > 0);
  if (
    !validVersion ||
    typeof candidate.scope !== "string" ||
    candidate.scope.trim().length === 0 ||
    typeof candidate.observedAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.observedAt))
  ) {
    return null;
  }
  if (
    candidate.meta !== undefined &&
    (typeof candidate.meta !== "object" ||
      candidate.meta === null ||
      Array.isArray(candidate.meta))
  ) {
    return null;
  }
  return Object.freeze({
    v: 1 as const,
    resourceVersion: rv as ObservedResourceVersion,
    scope: candidate.scope,
    observedAt: candidate.observedAt,
    ...(candidate.meta !== undefined ? { meta: candidate.meta as Meta } : {}),
  });
}

export interface ObservedResourceStateValue<
  Meta extends Readonly<Record<string, JsonValue>> = Readonly<
    Record<string, JsonValue>
  >,
> {
  readonly value: ObservationReceipt<Meta>;
  readonly revision: number;
  readonly expiresAt: string;
}

/**
 * Record an observation receipt on `ctx.state` with bounded 4-attempt CAS retry
 * on concurrent reads by the same credential. Throws `SupabaseMcpStateUnavailableError`
 * if `state` is undefined or unavailable so read handlers can fail closed when required.
 */
export async function observeResource<
  Meta extends Readonly<Record<string, JsonValue>> = Readonly<
    Record<string, JsonValue>
  >,
>(
  state: SupabaseMcpState | undefined,
  options: ObserveResourceOptions<Meta>,
): Promise<ObservedResourceStateValue<Meta>> {
  if (!state) {
    throw new SupabaseMcpStateUnavailableError();
  }
  validateResourceVersion(options.resourceVersion);
  const scope = validateScopeName(options.scope ?? "full");

  for (let attempt = 0; attempt < MAX_OBSERVE_CAS_ATTEMPTS; attempt += 1) {
    const existing = await state.get<JsonValue>(
      options.namespace,
      options.resourceKey,
    );
    const receipt: ObservationReceipt<Meta> = Object.freeze({
      v: 1 as const,
      resourceVersion: options.resourceVersion,
      scope,
      observedAt: new Date().toISOString(),
      ...(options.meta !== undefined ? { meta: options.meta } : {}),
    });
    try {
      const written = await state.put<JsonValue>(
        options.namespace,
        options.resourceKey,
        {
          value: receipt as unknown as JsonValue,
          expectedRevision: existing?.revision ?? null,
          ...(options.ttlSeconds !== undefined
            ? { ttlSeconds: options.ttlSeconds }
            : {}),
        },
      );
      return Object.freeze({
        value: receipt,
        revision: written.revision,
        expiresAt: written.expiresAt,
      });
    } catch (error) {
      if (
        (error instanceof SupabaseMcpStateConflictError ||
          error instanceof SupabaseMcpStateMissingError) &&
        attempt + 1 < MAX_OBSERVE_CAS_ATTEMPTS
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new SupabaseMcpStateUnavailableError();
}

export type ObservationFailureReason =
  | "state_unavailable"
  | "not_observed"
  | "insufficient_scope";

export type GuardedMutationOutcome<
  Value,
  RejectReason extends string = string,
> =
  | {
      readonly status: "committed";
      readonly value: Value;
      /**
       * New authoritative resource version after mutation.
       * - When provided (and `receipt !== "invalidate"`), Step 3 advances the receipt via CAS `put`.
       * - When omitted or `receipt === "invalidate"` (e.g. delete), Step 3 invalidates via CAS `delete`.
       */
      readonly nextVersion?: ObservedResourceVersion;
      readonly nextScope?: string;
      readonly nextMeta?: Readonly<Record<string, JsonValue>>;
      readonly receipt?: "advance" | "invalidate";
    }
  | {
      readonly status: "rejected";
      readonly reason: RejectReason;
      readonly error: CallToolResult;
    };

export interface RequireObservedOptions<
  Value,
  Meta extends Readonly<Record<string, JsonValue>> = Readonly<
    Record<string, JsonValue>
  >,
  RejectReason extends string = string,
> {
  readonly namespace: string;
  readonly resourceKey: string;
  /** Tool name to cite in fail-closed recovery instructions (e.g. `"read_document"`). */
  readonly readToolName: string;
  /** Optional scope predicate (e.g. verifying `receipt.scope === "full"` or block coverage). */
  verifyScope?(receipt: ObservationReceipt<Meta>): boolean;
  readonly ttlSeconds?: number;
  /**
   * Step 2: Perform the authoritative domain mutation using `observedVersion` as
   * an atomic database precondition (e.g. `UPDATE ... WHERE id = $1 AND version = $2`).
   * Executed ONLY after Step 1 receipt validation succeeds.
   */
  mutate(input: {
    readonly observedVersion: ObservedResourceVersion;
    readonly receipt: ObservationReceipt<Meta>;
    readonly stateRevision: number;
  }): Promise<GuardedMutationOutcome<Value, RejectReason>>;
}

export type RequireObservedResult<
  Value,
  RejectReason extends string = string,
> =
  | {
      readonly ok: true;
      readonly value: Value;
      /** False when Step 2 committed in the DB, but Step 3 receipt CAS update/delete failed. */
      readonly receiptAdvanced: boolean;
      /** True when `receipt === "invalidate"` or when Step 3 failed (safe false negative). */
      readonly rereadRequired: boolean;
    }
  | {
      readonly ok: false;
      readonly phase: "observation";
      readonly reason: ObservationFailureReason;
      readonly error: CallToolResult;
    }
  | {
      readonly ok: false;
      readonly phase: "mutation";
      readonly reason: RejectReason;
      readonly error: CallToolResult;
    };

/**
 * Enforce the 3-step `observation-before-action` contract:
 * 1. Load & validate receipt (fail closed before calling `mutate`).
 * 2. Run `mutate({ observedVersion })` (authoritative domain CAS).
 * 3. Advance or invalidate receipt ONLY after `status === "committed"`; if Step 3
 *    throws, catch and return `{ ok: true, value, receiptAdvanced: false, rereadRequired: true }`.
 */
export async function requireObserved<
  Value,
  Meta extends Readonly<Record<string, JsonValue>> = Readonly<
    Record<string, JsonValue>
  >,
  RejectReason extends string = string,
>(
  state: SupabaseMcpState | undefined,
  options: RequireObservedOptions<Value, Meta, RejectReason>,
): Promise<RequireObservedResult<Value, RejectReason>> {
  const readToolName = options.readToolName.trim() || "the read tool";
  if (!state) {
    return Object.freeze({
      ok: false as const,
      phase: "observation" as const,
      reason: "state_unavailable" as const,
      error: errorResult(
        "Observation state is unavailable, so this guarded write was not executed.",
        `Retry after durable state recovers and call ${readToolName} before mutating.`,
      ),
    });
  }

  let stored: SupabaseMcpStateValue<JsonValue> | null;
  try {
    stored = await state.get<JsonValue>(options.namespace, options.resourceKey);
  } catch (error) {
    if (error instanceof SupabaseMcpStateUnavailableError) {
      return Object.freeze({
        ok: false as const,
        phase: "observation" as const,
        reason: "state_unavailable" as const,
        error: errorResult(
          "Observation state is unavailable, so this guarded write was not executed.",
          `Retry after durable state recovers and call ${readToolName} before mutating.`,
        ),
      });
    }
    throw error;
  }

  const receipt = stored ? parseStoredReceipt<Meta>(stored.value) : null;
  if (!stored || !receipt) {
    return Object.freeze({
      ok: false as const,
      phase: "observation" as const,
      reason: "not_observed" as const,
      error: errorResult(
        `Current state has not been observed on this connection (or the observation expired). Nothing was changed.`,
        `Call ${readToolName} first to inspect the latest version before retrying.`,
      ),
    });
  }

  if (options.verifyScope && !options.verifyScope(receipt)) {
    return Object.freeze({
      ok: false as const,
      phase: "observation" as const,
      reason: "insufficient_scope" as const,
      error: errorResult(
        `Prior observation scope ("${receipt.scope}") does not cover this mutation. Nothing was changed.`,
        `Call ${readToolName} covering the target scope before retrying.`,
      ),
    });
  }

  const outcome = await options.mutate({
    observedVersion: receipt.resourceVersion,
    receipt,
    stateRevision: stored.revision,
  });

  if (outcome.status === "rejected") {
    return Object.freeze({
      ok: false as const,
      phase: "mutation" as const,
      reason: outcome.reason,
      error: outcome.error,
    });
  }

  const shouldInvalidate =
    outcome.receipt === "invalidate" || outcome.nextVersion === undefined;

  if (shouldInvalidate) {
    try {
      await state.delete(options.namespace, options.resourceKey, {
        expectedRevision: stored.revision,
      });
    } catch {
      // Safe false negative: domain commit already succeeded.
    }
    return Object.freeze({
      ok: true as const,
      value: outcome.value,
      receiptAdvanced: false,
      rereadRequired: true,
    });
  }

  try {
    validateResourceVersion(outcome.nextVersion);
    const nextScope = validateScopeName(outcome.nextScope ?? receipt.scope);
    const nextReceipt: ObservationReceipt<Readonly<Record<string, JsonValue>>> =
      {
        v: 1,
        resourceVersion: outcome.nextVersion,
        scope: nextScope,
        observedAt: new Date().toISOString(),
        ...(outcome.nextMeta !== undefined
          ? { meta: outcome.nextMeta }
          : receipt.meta !== undefined
            ? { meta: receipt.meta }
            : {}),
      };
    await state.put(options.namespace, options.resourceKey, {
      value: nextReceipt as unknown as JsonValue,
      expectedRevision: stored.revision,
      ...(options.ttlSeconds !== undefined
        ? { ttlSeconds: options.ttlSeconds }
        : {}),
    });
    return Object.freeze({
      ok: true as const,
      value: outcome.value,
      receiptAdvanced: true,
      rereadRequired: false,
    });
  } catch {
    // Safe false negative: domain mutation committed, but receipt CAS advancement
    // failed (e.g. transient state outage or concurrent read). Never report the
    // committed domain write as failed; mark rereadRequired: true instead.
    return Object.freeze({
      ok: true as const,
      value: outcome.value,
      receiptAdvanced: false,
      rereadRequired: true,
    });
  }
}
