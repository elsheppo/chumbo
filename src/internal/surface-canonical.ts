import type { JsonValue } from "../results.js";
import type {
  SupabaseMcpSurfaceTool,
  SupabaseMcpSurfaceToolAnnotations,
} from "../types.js";

/**
 * Process-local symbol used by capability profile proxies (`withProfile`) to
 * pass canonical tool names to lifecycle telemetry without leaking on the wire
 * or allowing external symbol forgery (`Symbol.for` is intentionally avoided).
 */
export const CHUMBO_CANONICAL_TOOL: unique symbol = Symbol(
  "dev.chumbo.canonicalTool",
);

/**
 * Process-local symbol used by `registerCollection` to query active presented
 * tool aliases across `withProfile` and `withScopes` proxies.
 */
export const PRESENTED_TOOL_NAME: unique symbol = Symbol(
  "dev.chumbo.presentedToolName",
);

export const SURFACE_CANONICAL_LIMITS = Object.freeze({
  maxJsonDepth: 32,
  maxNameBytes: 256,
  maxProseBytes: 32 * 1024,
  maxTools: 256,
  maxCanonicalBytes: 256 * 1024,
  maxProofBytes: 256 * 1024,
  maxServerNameBytes: 1024,
  maxServerVersionBytes: 256,
});

const utf8 = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function boundedUtf8(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && utf8.encode(value).byteLength <= maxBytes;
}

export function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    utf8.encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function canonicalJsonValue(
  value: unknown,
  depth = 0,
): JsonValue | null {
  if (depth > SURFACE_CANONICAL_LIMITS.maxJsonDepth) return null;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const entry of value) {
      const normalized = canonicalJsonValue(entry, depth + 1);
      if (normalized === null && entry !== null) return null;
      result.push(normalized);
    }
    return Object.freeze(result) as unknown as JsonValue;
  }
  if (!isRecord(value)) return null;
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort(compareCanonicalText)) {
    const entry = value[key];
    const normalized = canonicalJsonValue(entry, depth + 1);
    if (normalized === null && entry !== null) return null;
    result[key] = normalized;
  }
  return Object.freeze(result);
}

export function normalizedSurfaceAnnotations(
  value: unknown,
): SupabaseMcpSurfaceToolAnnotations | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const annotations: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  } = {};
  if (boundedUtf8(value.title, SURFACE_CANONICAL_LIMITS.maxProseBytes)) {
    annotations.title = value.title;
  } else if (value.title !== undefined) {
    return null;
  }
  for (const key of [
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
  ] as const) {
    if (typeof value[key] === "boolean") annotations[key] = value[key];
    else if (value[key] !== undefined) return null;
  }
  return Object.keys(annotations).length > 0
    ? Object.freeze(annotations)
    : undefined;
}

export function normalizedSurfaceTool(
  value: unknown,
): SupabaseMcpSurfaceTool | null {
  if (
    !isRecord(value) ||
    !boundedUtf8(value.name, SURFACE_CANONICAL_LIMITS.maxNameBytes) ||
    !value.name
  ) {
    return null;
  }
  if (
    (value.title !== undefined &&
      !boundedUtf8(value.title, SURFACE_CANONICAL_LIMITS.maxProseBytes)) ||
    (value.description !== undefined &&
      !boundedUtf8(value.description, SURFACE_CANONICAL_LIMITS.maxProseBytes))
  ) {
    return null;
  }
  if (!isRecord(value.inputSchema)) return null;
  const inputSchema = canonicalJsonValue(value.inputSchema);
  if (!isRecord(inputSchema)) return null;
  let outputSchema: Readonly<Record<string, JsonValue>> | undefined;
  if (value.outputSchema !== undefined) {
    if (!isRecord(value.outputSchema)) return null;
    const normalized = canonicalJsonValue(value.outputSchema);
    if (!isRecord(normalized)) return null;
    outputSchema = normalized as Readonly<Record<string, JsonValue>>;
  }
  const annotations = normalizedSurfaceAnnotations(value.annotations);
  if (annotations === null) return null;
  return Object.freeze({
    name: value.name,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.description === "string"
      ? { description: value.description }
      : {}),
    inputSchema: inputSchema as Readonly<Record<string, JsonValue>>,
    ...(outputSchema ? { outputSchema } : {}),
    ...(annotations ? { annotations } : {}),
  });
}

export async function computeCanonicalSurfaceDigest(
  rawTools: readonly unknown[],
): Promise<{
  readonly tools: readonly SupabaseMcpSurfaceTool[];
  readonly canonicalContent: string;
  readonly contentDigest: `sha256:${string}`;
} | null> {
  if (rawTools.length > SURFACE_CANONICAL_LIMITS.maxTools) return null;
  const tools: SupabaseMcpSurfaceTool[] = [];
  const names = new Set<string>();
  for (const value of rawTools) {
    const tool = normalizedSurfaceTool(value);
    if (!tool || names.has(tool.name)) return null;
    names.add(tool.name);
    tools.push(tool);
  }
  tools.sort((left, right) => compareCanonicalText(left.name, right.name));
  const frozenTools = Object.freeze(tools);
  const canonicalContent = JSON.stringify({
    schemaVersion: 1,
    tools: frozenTools,
  });
  if (
    utf8.encode(canonicalContent).byteLength >
    SURFACE_CANONICAL_LIMITS.maxCanonicalBytes
  ) {
    return null;
  }
  const contentDigest = `sha256:${await sha256Hex(canonicalContent)}` as const;
  return Object.freeze({
    tools: frozenTools,
    canonicalContent,
    contentDigest,
  });
}
