import {
  canonicalJsonValue,
  compareCanonicalText,
  normalizedSurfaceTool,
} from "./internal/surface-canonical.js";
import type { JsonValue } from "./results.js";

export const TOKEN_ESTIMATOR_ID = "chumbo-json-lexeme-v1" as const;

export const SURFACE_TOKEN_LIMITS = Object.freeze({
  /** Base host framing cost when >= 1 MCP tool is advertised. */
  catalogBaseTokens: 24,
  /** Per-tool MCP host wrapper overhead (tool header, role/callable framing). */
  perToolEnvelopeTokens: 12,
  /** Per-tool inputSchema advisory threshold (~3 KiB canonical schema). */
  bloatedInputSchemaTokens: 800,
  /** Per-tool outputSchema advisory threshold (~3 KiB canonical schema). */
  bloatedOutputSchemaTokens: 800,
  /** Total cold-start prompt token warning threshold across tools/list. */
  catalogColdStartWarnTokens: 8_000,
  /** Severe cold-start prompt token threshold. */
  catalogColdStartSevereTokens: 20_000,
});

/** Pure, Deno-safe structural input accepted by token and surface estimators. */
export interface SurfaceToolInput {
  readonly name?: unknown;
  readonly title?: unknown;
  readonly description?: unknown;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: unknown;
}

export interface ToolTokenBreakdown {
  readonly name: string;
  readonly envelopeTokens: number;
  readonly proseTokens: number;
  readonly inputSchemaTokens: number;
  readonly outputSchemaTokens: number;
  /** Cold-start tokens injected into model system context: envelope + prose + inputSchema. */
  readonly promptTokens: number;
  /** Full discovery cost including outputSchema: promptTokens + outputSchemaTokens. */
  readonly wireTokens: number;
  readonly wireBytes: number;
  readonly inputPropertyCount: number;
  readonly bloatedInputSchema: boolean;
  readonly bloatedOutputSchema: boolean;
}

export interface CatalogTokenReport {
  readonly estimator: typeof TOKEN_ESTIMATOR_ID;
  readonly toolCount: number;
  /** Total cold-start model context tokens (catalogBaseTokens + sum(promptTokens)). */
  readonly totalPromptTokens: number;
  readonly totalOutputSchemaTokens: number;
  readonly totalWireTokens: number;
  readonly totalWireBytes: number;
  readonly maxCatalogTokens: number;
  readonly overColdStartBudget: boolean;
  readonly bloatedInputTools: readonly string[];
  readonly bloatedOutputTools: readonly string[];
  /** Sorted by promptTokens descending, then name ascending for deterministic output. */
  readonly tools: readonly ToolTokenBreakdown[];
}

export interface EstimateCatalogTokensOptions {
  readonly maxCatalogTokens?: number;
  readonly bloatedInputSchemaTokens?: number;
  readonly bloatedOutputSchemaTokens?: number;
}

export interface ResultTokenEstimate {
  readonly estimator: typeof TOKEN_ESTIMATOR_ID;
  readonly textTokens: number;
  readonly structuredTokens: number;
  readonly totalTokens: number;
  readonly encodedBytes: number;
}

const utf8 = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deterministic token estimate for prose and JSON strings without BPE tables.
 * - ASCII alphanumeric/underscore runs: ceil(length / 4) tokens
 * - Structural JSON / punctuation characters: 1 token per symbol run of 1..2 chars
 * - Non-ASCII UTF-8 bytes: ceil(byteLength / 2) tokens
 */
export function estimateTextTokens(value: string): number {
  if (!value) return 0;
  let tokens = 0;
  for (const match of value.matchAll(
    /[A-Za-z0-9_]+|[^\sA-Za-z0-9_\u0080-\uFFFF]{1,2}|[\u0080-\uFFFF]+/gu,
  )) {
    const token = match[0];
    const first = token.codePointAt(0)!;
    if (first > 0x7f) {
      tokens += Math.ceil(utf8.encode(token).byteLength / 2);
    } else if (
      (first >= 0x30 && first <= 0x39) ||
      (first >= 0x41 && first <= 0x5a) ||
      (first >= 0x61 && first <= 0x7a) ||
      first === 0x5f
    ) {
      tokens += Math.ceil(token.length / 4);
    } else {
      tokens += 1;
    }
  }
  return tokens;
}

export function estimateJsonTokens(canonicalJson: string): number {
  return estimateTextTokens(canonicalJson);
}

interface CanonicalizedToolForEstimate {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, JsonValue>>;
  readonly outputSchema?: Readonly<Record<string, JsonValue>>;
  readonly wireObject: Readonly<Record<string, JsonValue>>;
}

function canonicalToolForEstimate(
  rawTool: SurfaceToolInput,
): CanonicalizedToolForEstimate {
  const strict = normalizedSurfaceTool(rawTool);
  if (strict) {
    return {
      name: strict.name,
      ...(strict.title !== undefined ? { title: strict.title } : {}),
      ...(strict.description !== undefined
        ? { description: strict.description }
        : {}),
      inputSchema: strict.inputSchema,
      ...(strict.outputSchema !== undefined
        ? { outputSchema: strict.outputSchema }
        : {}),
      wireObject: strict as unknown as Readonly<Record<string, JsonValue>>,
    };
  }

  // Fallback for non-strict external servers probed via `chumbo doctor --url`.
  const name =
    typeof rawTool.name === "string" && rawTool.name.length > 0
      ? rawTool.name
      : "(unnamed)";
  const title = typeof rawTool.title === "string" ? rawTool.title : undefined;
  const description =
    typeof rawTool.description === "string" ? rawTool.description : undefined;
  const normalizedInput = isRecord(rawTool.inputSchema)
    ? canonicalJsonValue(rawTool.inputSchema)
    : null;
  const inputSchema = isRecord(normalizedInput)
    ? (normalizedInput as Readonly<Record<string, JsonValue>>)
    : Object.freeze({});
  const normalizedOutput = isRecord(rawTool.outputSchema)
    ? canonicalJsonValue(rawTool.outputSchema)
    : null;
  const outputSchema = isRecord(normalizedOutput)
    ? (normalizedOutput as Readonly<Record<string, JsonValue>>)
    : undefined;
  const normalizedAnnotations = isRecord(rawTool.annotations)
    ? canonicalJsonValue(rawTool.annotations)
    : null;
  const wireRecord: Record<string, JsonValue> = {
    name,
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    inputSchema: inputSchema as JsonValue,
    ...(outputSchema !== undefined
      ? { outputSchema: outputSchema as JsonValue }
      : {}),
    ...(isRecord(normalizedAnnotations)
      ? { annotations: normalizedAnnotations as JsonValue }
      : {}),
  };
  return {
    name,
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    inputSchema,
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    wireObject: Object.freeze(wireRecord),
  };
}

export function estimateToolTokens(
  rawTool: SurfaceToolInput,
  options?: EstimateCatalogTokensOptions,
): ToolTokenBreakdown {
  const bloatedInputLimit =
    options?.bloatedInputSchemaTokens ??
    SURFACE_TOKEN_LIMITS.bloatedInputSchemaTokens;
  const bloatedOutputLimit =
    options?.bloatedOutputSchemaTokens ??
    SURFACE_TOKEN_LIMITS.bloatedOutputSchemaTokens;

  const tool = canonicalToolForEstimate(rawTool);
  const envelopeTokens = SURFACE_TOKEN_LIMITS.perToolEnvelopeTokens;
  const proseTokens =
    estimateTextTokens(tool.name) +
    (tool.title !== undefined ? estimateTextTokens(tool.title) : 0) +
    (tool.description !== undefined ? estimateTextTokens(tool.description) : 0);
  const inputSchemaJson = JSON.stringify(tool.inputSchema);
  const inputSchemaTokens = estimateJsonTokens(inputSchemaJson);
  const outputSchemaTokens =
    tool.outputSchema !== undefined
      ? estimateJsonTokens(JSON.stringify(tool.outputSchema))
      : 0;
  const promptTokens = envelopeTokens + proseTokens + inputSchemaTokens;
  const wireTokens = promptTokens + outputSchemaTokens;
  const wireBytes = utf8.encode(JSON.stringify(tool.wireObject)).byteLength;
  const properties = tool.inputSchema.properties;
  const inputPropertyCount = isRecord(properties)
    ? Object.keys(properties).length
    : 0;

  return Object.freeze({
    name: tool.name,
    envelopeTokens,
    proseTokens,
    inputSchemaTokens,
    outputSchemaTokens,
    promptTokens,
    wireTokens,
    wireBytes,
    inputPropertyCount,
    bloatedInputSchema: inputSchemaTokens > bloatedInputLimit,
    bloatedOutputSchema: outputSchemaTokens > bloatedOutputLimit,
  });
}

export function estimateCatalogTokens(
  tools: readonly SurfaceToolInput[],
  options?: EstimateCatalogTokensOptions,
): CatalogTokenReport {
  const maxCatalogTokens =
    options?.maxCatalogTokens ??
    SURFACE_TOKEN_LIMITS.catalogColdStartWarnTokens;
  const bloatedInputLimit =
    options?.bloatedInputSchemaTokens ??
    SURFACE_TOKEN_LIMITS.bloatedInputSchemaTokens;
  const bloatedOutputLimit =
    options?.bloatedOutputSchemaTokens ??
    SURFACE_TOKEN_LIMITS.bloatedOutputSchemaTokens;

  const canonicalWireObjects: Array<{
    readonly name: string;
    readonly wireObject: Readonly<Record<string, JsonValue>>;
  }> = [];
  const breakdowns: ToolTokenBreakdown[] = [];

  for (const rawTool of tools) {
    const canonical = canonicalToolForEstimate(rawTool);
    canonicalWireObjects.push({
      name: canonical.name,
      wireObject: canonical.wireObject,
    });
    const envelopeTokens = SURFACE_TOKEN_LIMITS.perToolEnvelopeTokens;
    const proseTokens =
      estimateTextTokens(canonical.name) +
      (canonical.title !== undefined
        ? estimateTextTokens(canonical.title)
        : 0) +
      (canonical.description !== undefined
        ? estimateTextTokens(canonical.description)
        : 0);
    const inputSchemaTokens = estimateJsonTokens(
      JSON.stringify(canonical.inputSchema),
    );
    const outputSchemaTokens =
      canonical.outputSchema !== undefined
        ? estimateJsonTokens(JSON.stringify(canonical.outputSchema))
        : 0;
    const promptTokens = envelopeTokens + proseTokens + inputSchemaTokens;
    const wireTokens = promptTokens + outputSchemaTokens;
    const wireBytes = utf8.encode(
      JSON.stringify(canonical.wireObject),
    ).byteLength;
    const properties = canonical.inputSchema.properties;
    const inputPropertyCount = isRecord(properties)
      ? Object.keys(properties).length
      : 0;

    breakdowns.push(
      Object.freeze({
        name: canonical.name,
        envelopeTokens,
        proseTokens,
        inputSchemaTokens,
        outputSchemaTokens,
        promptTokens,
        wireTokens,
        wireBytes,
        inputPropertyCount,
        bloatedInputSchema: inputSchemaTokens > bloatedInputLimit,
        bloatedOutputSchema: outputSchemaTokens > bloatedOutputLimit,
      }),
    );
  }

  breakdowns.sort((left, right) => {
    const delta = right.promptTokens - left.promptTokens;
    return delta !== 0 ? delta : compareCanonicalText(left.name, right.name);
  });

  canonicalWireObjects.sort((left, right) =>
    compareCanonicalText(left.name, right.name),
  );

  const baseTokens =
    breakdowns.length > 0 ? SURFACE_TOKEN_LIMITS.catalogBaseTokens : 0;
  const sumPromptTokens = breakdowns.reduce(
    (sum, item) => sum + item.promptTokens,
    0,
  );
  const totalPromptTokens = baseTokens + sumPromptTokens;
  const totalOutputSchemaTokens = breakdowns.reduce(
    (sum, item) => sum + item.outputSchemaTokens,
    0,
  );
  const totalWireTokens = totalPromptTokens + totalOutputSchemaTokens;
  const totalWireBytes =
    canonicalWireObjects.length === 0
      ? 0
      : utf8.encode(
          JSON.stringify(canonicalWireObjects.map((entry) => entry.wireObject)),
        ).byteLength;

  const bloatedInputTools = Object.freeze(
    breakdowns
      .filter((item) => item.bloatedInputSchema)
      .map((item) => item.name),
  );
  const bloatedOutputTools = Object.freeze(
    breakdowns
      .filter((item) => item.bloatedOutputSchema)
      .map((item) => item.name),
  );

  return Object.freeze({
    estimator: TOKEN_ESTIMATOR_ID,
    toolCount: breakdowns.length,
    totalPromptTokens,
    totalOutputSchemaTokens,
    totalWireTokens,
    totalWireBytes,
    maxCatalogTokens,
    overColdStartBudget: totalPromptTokens > maxCatalogTokens,
    bloatedInputTools,
    bloatedOutputTools,
    tools: Object.freeze(breakdowns),
  });
}

function safeCanonicalString(value: unknown): string {
  const canonical = canonicalJsonValue(value);
  if (canonical !== null || value === null) {
    return JSON.stringify(canonical);
  }
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "null";
  }
}

/**
 * Deterministic token and byte estimate for a runtime tool/resource/prompt result.
 */
export function estimateResultTokens(result: unknown): ResultTokenEstimate {
  const serialized = safeCanonicalString(result ?? {});
  const encodedBytes = utf8.encode(serialized).byteLength;

  if (!isRecord(result)) {
    const totalTokens = estimateJsonTokens(serialized);
    return Object.freeze({
      estimator: TOKEN_ESTIMATOR_ID,
      textTokens: 0,
      structuredTokens: totalTokens,
      totalTokens,
      encodedBytes,
    });
  }

  let textTokens = 0;
  let sawContentArray = false;
  if (Array.isArray(result.content)) {
    sawContentArray = true;
    for (const block of result.content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        textTokens += estimateTextTokens(block.text);
      } else {
        textTokens += estimateJsonTokens(safeCanonicalString(block));
      }
    }
  }

  let structuredTokens = 0;
  if (result.structuredContent !== undefined) {
    structuredTokens = estimateJsonTokens(
      safeCanonicalString(result.structuredContent),
    );
  } else if (!sawContentArray) {
    structuredTokens = estimateJsonTokens(serialized);
  }

  return Object.freeze({
    estimator: TOKEN_ESTIMATOR_ID,
    textTokens,
    structuredTokens,
    totalTokens: textTokens + structuredTokens,
    encodedBytes,
  });
}
