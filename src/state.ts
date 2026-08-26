import type { SupabaseClient } from "@supabase/supabase-js";
import type { JsonValue } from "./results.js";
import type {
  SupabaseMcpAuthentication,
  SupabaseMcpDurableStateOptions,
  SupabaseMcpState,
  SupabaseMcpStateNamespaceOptions,
  SupabaseMcpStateValue,
} from "./types.js";

const encoder = new TextEncoder();
const namespacePattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const controlPattern = /[\u0000-\u001f\u007f]/;

export const durableStateLimits = Object.freeze({
  hmacKeyBytes: { min: 32, max: 1024 },
  namespaces: 32,
  namespaceBytes: 64,
  keyBytes: 512,
  valueBytes: 64 * 1024,
  ttlSeconds: { min: 1, max: 30 * 24 * 60 * 60 },
});

export class SupabaseMcpStateConflictError extends Error {
  readonly code = "state_conflict";
  readonly actualRevision?: number;

  constructor(actualRevision?: number) {
    super("Durable state revision does not match.");
    this.name = "SupabaseMcpStateConflictError";
    this.actualRevision = actualRevision;
  }
}

export class SupabaseMcpStateMissingError extends Error {
  readonly code = "state_missing";

  constructor() {
    super("Durable state is missing or expired.");
    this.name = "SupabaseMcpStateMissingError";
  }
}

export class SupabaseMcpStateUnavailableError extends Error {
  readonly code = "state_unavailable";

  constructor() {
    super("Durable state is unavailable.");
    this.name = "SupabaseMcpStateUnavailableError";
  }
}

interface StateRow {
  status?: unknown;
  value_text?: unknown;
  revision?: unknown;
  expires_at?: unknown;
}

interface StateFactoryIdentity {
  readonly credential: string;
  readonly authentication: SupabaseMcpAuthentication;
}

export interface SupabaseMcpStateFactory {
  create<Database = unknown>(
    identity: StateFactoryIdentity,
    admin: SupabaseClient<Database>,
  ): Promise<SupabaseMcpState>;
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function validateDurableStateNamespace(namespace: string): void {
  if (
    !namespacePattern.test(namespace) ||
    byteLength(namespace) > durableStateLimits.namespaceBytes
  ) {
    throw new TypeError(
      "Durable state namespaces must be 1-64 bytes of lowercase letters, digits, dots, underscores, or hyphens, beginning and ending with an alphanumeric character.",
    );
  }
}

function validateKey(key: string): void {
  if (
    !key ||
    key !== key.trim() ||
    key !== key.normalize("NFC") ||
    controlPattern.test(key) ||
    byteLength(key) > durableStateLimits.keyBytes
  ) {
    throw new TypeError(
      "Durable state keys must be non-empty NFC text without surrounding whitespace or control characters and at most 512 bytes.",
    );
  }
}

function validatePositiveRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      "Durable state revisions must be positive safe integers.",
    );
  }
}

function validateTtl(ttlSeconds: number, maxTtlSeconds: number): void {
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < durableStateLimits.ttlSeconds.min ||
    ttlSeconds > maxTtlSeconds
  ) {
    throw new TypeError(
      `Durable state TTL must be an integer from 1 to ${maxTtlSeconds} seconds.`,
    );
  }
}

function normalizedNamespaceOptions(
  options: SupabaseMcpDurableStateOptions,
): ReadonlyMap<string, Required<SupabaseMcpStateNamespaceOptions>> {
  const entries = Object.entries(options.namespaces);
  if (entries.length === 0 || entries.length > durableStateLimits.namespaces) {
    throw new TypeError(
      `Durable state requires between 1 and ${durableStateLimits.namespaces} configured namespaces.`,
    );
  }
  const result = new Map<string, Required<SupabaseMcpStateNamespaceOptions>>();
  for (const [namespace, configured] of entries) {
    validateDurableStateNamespace(namespace);
    const maxTtlSeconds = configured.maxTtlSeconds ?? configured.ttlSeconds;
    if (
      !Number.isSafeInteger(maxTtlSeconds) ||
      maxTtlSeconds < durableStateLimits.ttlSeconds.min ||
      maxTtlSeconds > durableStateLimits.ttlSeconds.max
    ) {
      throw new TypeError(
        `Durable state max TTL must be an integer from 1 to ${durableStateLimits.ttlSeconds.max} seconds.`,
      );
    }
    validateTtl(configured.ttlSeconds, maxTtlSeconds);
    result.set(
      namespace,
      Object.freeze({ ttlSeconds: configured.ttlSeconds, maxTtlSeconds }),
    );
  }
  return result;
}

function framed(parts: readonly string[]): Uint8Array<ArrayBuffer> {
  const values = parts.map((part) => encoder.encode(part));
  const total = values.reduce((sum, value) => sum + 4 + value.byteLength, 0);
  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const value of values) {
    view.setUint32(offset, value.byteLength);
    offset += 4;
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

function hex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function firstRow(data: unknown): StateRow | undefined {
  const value = Array.isArray(data) ? data[0] : data;
  return value && typeof value === "object" ? (value as StateRow) : undefined;
}

function parsedRevision(value: unknown): number | undefined {
  const revision =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(revision) && revision > 0 ? revision : undefined;
}

function parsedExpiry(value: unknown): string | undefined {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return undefined;
  }
  return value;
}

function normalizedJson<Value extends JsonValue>(
  value: Value,
): {
  value: Value;
  text: string;
} {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new TypeError("Durable state values must be valid JSON.");
  }
  if (text === undefined) {
    throw new TypeError("Durable state values must be valid JSON.");
  }
  if (byteLength(text) > durableStateLimits.valueBytes) {
    throw new TypeError(
      `Durable state values must not exceed ${durableStateLimits.valueBytes} encoded bytes.`,
    );
  }
  try {
    return { value: JSON.parse(text) as Value, text };
  } catch {
    throw new TypeError("Durable state values must be valid JSON.");
  }
}

function parsedValue<Value extends JsonValue>(row: StateRow): Value {
  if (typeof row.value_text !== "string") {
    throw new SupabaseMcpStateUnavailableError();
  }
  if (byteLength(row.value_text) > durableStateLimits.valueBytes) {
    throw new SupabaseMcpStateUnavailableError();
  }
  try {
    return JSON.parse(row.value_text) as Value;
  } catch {
    throw new SupabaseMcpStateUnavailableError();
  }
}

function parsedStateValue<Value extends JsonValue>(
  row: StateRow,
  value: Value,
): SupabaseMcpStateValue<Value> {
  const revision = parsedRevision(row.revision);
  const expiresAt = parsedExpiry(row.expires_at);
  if (!revision || !expiresAt) {
    throw new SupabaseMcpStateUnavailableError();
  }
  return Object.freeze({ value, revision, expiresAt });
}

async function rpc<Database>(
  admin: SupabaseClient<Database>,
  functionName: string,
  args: Record<string, unknown>,
): Promise<StateRow | undefined> {
  try {
    const { data, error } = await admin.rpc(
      functionName as never,
      args as never,
    );
    if (error) throw error;
    return firstRow(data);
  } catch {
    throw new SupabaseMcpStateUnavailableError();
  }
}

export function createSupabaseMcpStateFactory(
  options: SupabaseMcpDurableStateOptions,
): SupabaseMcpStateFactory {
  const hmacKeyBytes = encoder.encode(options.hmacKey);
  if (
    hmacKeyBytes.byteLength < durableStateLimits.hmacKeyBytes.min ||
    hmacKeyBytes.byteLength > durableStateLimits.hmacKeyBytes.max
  ) {
    throw new TypeError(
      "Durable state hmacKey must be a deployment secret between 32 and 1024 encoded bytes.",
    );
  }
  const namespaces = normalizedNamespaceOptions(options);
  let cryptoKey: Promise<CryptoKey> | undefined;

  return Object.freeze({
    async create<Database>(
      identity: StateFactoryIdentity,
      admin: SupabaseClient<Database>,
    ) {
      cryptoKey ??= crypto.subtle.importKey(
        "raw",
        hmacKeyBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const callerKey = hex(
        await crypto.subtle.sign(
          "HMAC",
          await cryptoKey,
          framed([
            "supa-mcp-state-v1",
            identity.authentication.mode,
            identity.authentication.strategy,
            identity.credential,
          ]),
        ),
      );

      function namespaceOptions(
        namespace: string,
      ): Required<SupabaseMcpStateNamespaceOptions> {
        validateDurableStateNamespace(namespace);
        const configured = namespaces.get(namespace);
        if (!configured) {
          throw new TypeError("Durable state namespace is not configured.");
        }
        return configured;
      }

      return Object.freeze({
        async get<Value extends JsonValue = JsonValue>(
          namespace: string,
          key: string,
        ): Promise<SupabaseMcpStateValue<Value> | null> {
          namespaceOptions(namespace);
          validateKey(key);
          const row = await rpc(admin, "supa_mcp_state_get", {
            p_namespace: namespace,
            p_caller_key: callerKey,
            p_object_key: key,
          });
          if (!row) return null;
          if (row.status !== "found") {
            throw new SupabaseMcpStateUnavailableError();
          }
          return parsedStateValue(row, parsedValue<Value>(row));
        },

        async put<Value extends JsonValue>(
          namespace: string,
          key: string,
          putOptions: {
            value: Value;
            expectedRevision: number | null;
            ttlSeconds?: number;
          },
        ): Promise<SupabaseMcpStateValue<Value>> {
          const configured = namespaceOptions(namespace);
          validateKey(key);
          if (putOptions.expectedRevision !== null) {
            validatePositiveRevision(putOptions.expectedRevision);
          }
          const ttlSeconds = putOptions.ttlSeconds ?? configured.ttlSeconds;
          validateTtl(ttlSeconds, configured.maxTtlSeconds);
          const normalized = normalizedJson(putOptions.value);
          const row = await rpc(admin, "supa_mcp_state_put", {
            p_namespace: namespace,
            p_caller_key: callerKey,
            p_object_key: key,
            p_value_text: normalized.text,
            p_expected_revision: putOptions.expectedRevision,
            p_ttl_seconds: ttlSeconds,
          });
          if (!row) throw new SupabaseMcpStateUnavailableError();
          if (row.status === "conflict") {
            throw new SupabaseMcpStateConflictError(
              parsedRevision(row.revision),
            );
          }
          if (row.status === "missing") {
            throw new SupabaseMcpStateMissingError();
          }
          if (row.status !== "written") {
            throw new SupabaseMcpStateUnavailableError();
          }
          return parsedStateValue(row, normalized.value);
        },

        async delete(
          namespace: string,
          key: string,
          deleteOptions: { expectedRevision: number },
        ): Promise<boolean> {
          namespaceOptions(namespace);
          validateKey(key);
          validatePositiveRevision(deleteOptions.expectedRevision);
          const row = await rpc(admin, "supa_mcp_state_delete", {
            p_namespace: namespace,
            p_caller_key: callerKey,
            p_object_key: key,
            p_expected_revision: deleteOptions.expectedRevision,
          });
          if (!row) throw new SupabaseMcpStateUnavailableError();
          if (row.status === "deleted") return true;
          if (row.status === "missing") return false;
          if (row.status === "conflict") {
            throw new SupabaseMcpStateConflictError(
              parsedRevision(row.revision),
            );
          }
          throw new SupabaseMcpStateUnavailableError();
        },
      });
    },
  });
}
