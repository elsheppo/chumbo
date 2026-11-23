import {
  isCallToolResult,
  type CallToolResult,
  type ResourceLink,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { assertCollectionBudget } from "./internal/collection-budget.js";
import {
  formatDevGrantStderrHint,
  isLocalDevelopmentRuntime,
} from "./internal/grant-diagnostics.js";
import type { SupabaseMcpClientContext } from "./types.js";

export {
  openJsonSchema,
  openOutputSchema,
  withOpenOutputSchema,
} from "./internal/open-output-schema.js";

const MAX_ADDED_RESULT_BLOCKS = 16;
const MAX_ADDED_RESULT_BYTES = 64 * 1024;
const MAX_EMITTED_DEV_GRANT_HINTS = 64;
const emittedDevGrantHints = new Set<string>();
const utf8 = new TextEncoder();

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ResourceResultLink = ResourceLink;
export type ResultContentBlock = CallToolResult["content"][number];

/**
 * Operational instructions the agent must act on (what to do next, what not
 * to repeat, or conditions that changed under it). Authored once and emitted
 * into both `content[].text` and the leading keys of `structuredContent`.
 */
export interface ResultGuidance {
  readonly next?: string | null | false;
  readonly warnings?: readonly (string | null | false | undefined)[];
}

export interface NormalizedResultGuidance {
  readonly next?: string;
  readonly warnings?: string[];
}

export type GuidedValue<T extends Record<string, unknown>> = T &
  NormalizedResultGuidance;

export interface ResultContentComposition {
  /** Content inserted before every block authored by the tool handler. */
  readonly prepend?: readonly ResultContentBlock[];
  /** Content inserted after every block authored by the tool handler. */
  readonly append?: readonly ResultContentBlock[];
  /** Dual-lane operational guidance merged into text and structuredContent. */
  readonly guidance?: ResultGuidance;
}

export interface ResourceResultFallbackOptions {
  /** Client context for conditional inline fallback rendering. */
  readonly client?: SupabaseMcpClientContext;
  /** Explicit read tool to name when the client may not dereference `resource_link`. */
  readonly fallbackTool?: {
    readonly name: string;
    readonly arguments?: Readonly<Record<string, JsonValue>>;
  };
  /** Bounded inline excerpt appended when `client.supports.resourceLinks === "unsupported"`. */
  readonly inlineExcerpt?: string;
}

/** Raw Zod shape for spreading into custom `z.object({ ...resultGuidanceShape, ... })` output schemas. */
export const resultGuidanceShape = Object.freeze({
  next: z
    .string()
    .optional()
    .describe(
      "The next step this result requires. Follow it before other work.",
    ),
  warnings: z
    .array(z.string())
    .optional()
    .describe(
      "Conditions to act on, such as partial updates, stale assumptions, or incomplete checks.",
    ),
});

/** Standalone Standard Schema for guidance fields. */
export const resultGuidanceSchema = z.object(resultGuidanceShape);

/**
 * Return a new `z.ZodObject` whose advertised property order leads with `next`
 * and `warnings` followed by `schema.shape`.
 */
export function withResultGuidance<Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape>,
): z.ZodObject<typeof resultGuidanceShape & Shape> {
  return z.object({
    ...resultGuidanceShape,
    ...schema.shape,
  });
}

/** Normalize `ResultGuidance` into clean fields; returns `{}` when empty. */
export function guidanceFields(
  guidance?: ResultGuidance,
): NormalizedResultGuidance {
  if (!guidance) return {};
  const next =
    typeof guidance.next === "string" && guidance.next.trim().length > 0
      ? guidance.next.trim()
      : undefined;
  const warnings = [
    ...new Set(
      (guidance.warnings ?? [])
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ];
  return {
    ...(next !== undefined ? { next } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export function formatGuidanceLines(
  fields: NormalizedResultGuidance,
): string[] {
  return [
    ...(fields.warnings ?? []).map((item) => `Warning: ${item}`),
    ...(fields.next !== undefined ? [fields.next] : []),
  ];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addedContent(composition: ResultContentComposition): {
  prepend: ResultContentBlock[];
  append: ResultContentBlock[];
  guidance: NormalizedResultGuidance;
} {
  const guidance = guidanceFields(composition.guidance);
  const guidanceLines = formatGuidanceLines(guidance);
  const prepend = composition.prepend ?? [];
  const append = [
    ...(composition.append ?? []),
    ...(guidanceLines.length > 0
      ? [{ type: "text" as const, text: guidanceLines.join("\n") }]
      : []),
  ];
  const added = [...prepend, ...append];
  if (added.length > MAX_ADDED_RESULT_BLOCKS) {
    throw new RangeError(
      `Result composition may add at most ${MAX_ADDED_RESULT_BLOCKS} content blocks`,
    );
  }

  let serialized: string;
  let guidanceSerialized: string;
  try {
    serialized = JSON.stringify(added);
    guidanceSerialized = JSON.stringify(guidance);
  } catch {
    throw new TypeError("Result composition content must be JSON serializable");
  }
  const bytes =
    utf8.encode(serialized).byteLength +
    (guidance.next !== undefined || guidance.warnings !== undefined
      ? utf8.encode(guidanceSerialized).byteLength
      : 0);
  if (bytes > MAX_ADDED_RESULT_BYTES) {
    throw new RangeError(
      `Result composition may add at most ${MAX_ADDED_RESULT_BYTES} encoded bytes`,
    );
  }
  const snapshot = JSON.parse(serialized) as ResultContentBlock[];
  if (!isCallToolResult({ content: snapshot })) {
    throw new TypeError(
      "Result composition may add only valid MCP content blocks",
    );
  }
  return {
    prepend: snapshot.slice(0, prepend.length),
    append: snapshot.slice(prepend.length),
    guidance,
  };
}

/**
 * Add MCP content blocks and/or dual-lane guidance without replacing authored
 * fields. Additions are bounded; collection results also enforce their complete
 * byte budget. The original result remains untouched.
 */
export function composeResultContent(
  result: CallToolResult,
  composition: ResultContentComposition,
): CallToolResult {
  const added = addedContent(composition);
  const hasGuidance =
    added.guidance.next !== undefined || added.guidance.warnings !== undefined;
  if (added.prepend.length === 0 && added.append.length === 0 && !hasGuidance) {
    return result;
  }

  let structuredContent = result.structuredContent;
  if (hasGuidance && isPlainRecord(result.structuredContent)) {
    const priorWarnings = Array.isArray(result.structuredContent.warnings)
      ? result.structuredContent.warnings.filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0,
        )
      : [];
    const mergedWarnings = [
      ...new Set([...priorWarnings, ...(added.guidance.warnings ?? [])]),
    ];
    const mergedNext =
      added.guidance.next ??
      (typeof result.structuredContent.next === "string" &&
      result.structuredContent.next.trim().length > 0
        ? result.structuredContent.next.trim()
        : undefined);
    const mergedFields: NormalizedResultGuidance = {
      ...(mergedNext !== undefined ? { next: mergedNext } : {}),
      ...(mergedWarnings.length > 0 ? { warnings: mergedWarnings } : {}),
    };
    structuredContent = {
      ...mergedFields,
      ...result.structuredContent,
      ...mergedFields,
    };
  }

  const composed: CallToolResult = {
    ...result,
    content: [...added.prepend, ...result.content, ...added.append],
    ...(structuredContent !== undefined ? { structuredContent } : {}),
  };
  assertCollectionBudget(composed);
  return composed;
}

/** Append bounded model-facing text while preserving the authored result. */
export function appendResultText(
  result: CallToolResult,
  text: string,
): CallToolResult {
  return composeResultContent(result, {
    append: [{ type: "text", text }],
  });
}

/** Prepend bounded model-facing text while preserving the authored result. */
export function prependResultText(
  result: CallToolResult,
  text: string,
): CallToolResult {
  return composeResultContent(result, {
    prepend: [{ type: "text", text }],
  });
}

/** Return purpose-written text for an agent or person. */
export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * Return exact machine-readable JSON without manufacturing a duplicate text
 * representation. Register an outputSchema on the tool that describes value.
 */
export function structuredResult<T>(value: T): CallToolResult {
  return { content: [], structuredContent: value };
}

/**
 * Return intentionally different representations for two real consumers:
 * purpose-written model-facing text and exact machine-readable JSON. Register
 * an outputSchema on the tool that describes value.
 */
export function renderResult<T>(
  value: T,
  render: (value: T) => string,
): CallToolResult {
  return {
    content: [{ type: "text", text: render(value) }],
    structuredContent: value,
  };
}

/**
 * Build a dual-lane result whose prose is authored first and whose guidance
 * rides as a text footer AND as the leading keys of `structuredContent`.
 */
export function guidedResult<T extends Record<string, unknown>>(
  text: string,
  value: T,
  guidance?: ResultGuidance,
): CallToolResult {
  const fields = guidanceFields(guidance);
  const lines = [text, ...formatGuidanceLines(fields)].filter(
    (line) => line.length > 0,
  );
  const guided: GuidedValue<T> = { ...fields, ...value, ...fields };
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: guided,
  };
}

/**
 * Build a dual-lane result whose text is rendered from the structured value
 * with normalized guidance already merged onto it.
 */
export function renderGuidedResult<T extends Record<string, unknown>>(
  value: T,
  guidance: ResultGuidance | undefined,
  render: (value: GuidedValue<T>) => string,
): CallToolResult {
  const fields = guidanceFields(guidance);
  const guided: GuidedValue<T> = { ...fields, ...value, ...fields };
  return {
    content: [{ type: "text", text: render(guided) }],
    structuredContent: guided,
  };
}

/**
 * Point at content registered through MCP resources instead of embedding a
 * large body in a tool result. Text is the concise agent-facing reading card.
 */
export function resourceResult(
  text: string,
  resource: ResourceResultLink,
  fallback?: ResourceResultFallbackOptions,
): CallToolResult {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new TypeError(
      "resourceResult requires a non-empty reading card text",
    );
  }
  const support = fallback?.client?.supports.resourceLinks;
  let card = text;
  if (fallback?.fallbackTool && support !== "supported") {
    const toolName = fallback.fallbackTool.name.trim();
    if (!toolName) {
      throw new TypeError("resourceResult fallbackTool.name must be non-empty");
    }
    const serializedArgs = JSON.stringify(
      fallback.fallbackTool.arguments ?? {},
    );
    card += `\n\n→ Read full content: call ${toolName}(${serializedArgs}) if your client cannot open ${resource.uri}.`;
  }
  if (
    typeof fallback?.inlineExcerpt === "string" &&
    fallback.inlineExcerpt.trim().length > 0 &&
    support === "unsupported"
  ) {
    card += `\n\n${fallback.inlineExcerpt.trim()}`;
  }
  return { content: [{ type: "text", text: card }, resource] };
}

/** Return a recoverable tool-level error. */
export function errorResult(
  message: string,
  nextStep?: string,
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text:
          nextStep === undefined
            ? message
            : `${message}\n\n→ Next: ${nextStep}`,
      },
    ],
    isError: true,
  };
}

export type SupabaseErrorCategory =
  | "notFound"
  | "conflict"
  | "foreignKey"
  | "invalidInput"
  | "permissionDenied"
  | "custom"
  | "unknown";

export interface RedactedSupabaseErrorInfo {
  readonly code: string | undefined;
  readonly category: SupabaseErrorCategory;
}

export type SupabaseErrorReply =
  | string
  | readonly [message: string, nextStep?: string]
  | { readonly message: string; readonly nextStep?: string }
  | CallToolResult;

export type SupabaseErrorHandler =
  | SupabaseErrorReply
  | ((info: RedactedSupabaseErrorInfo) => SupabaseErrorReply);

export interface FromSupabaseErrorHandlers {
  readonly notFound?: SupabaseErrorHandler;
  readonly conflict?: SupabaseErrorHandler;
  readonly foreignKey?: SupabaseErrorHandler;
  readonly invalidInput?: SupabaseErrorHandler;
  readonly permissionDenied?: SupabaseErrorHandler;
  /** Explicit SQLSTATE or PostgREST code overrides (checked before category slots). */
  readonly codes?: Readonly<Record<string, SupabaseErrorHandler>>;
  /** Catch-all override for unmapped codes. */
  readonly fallback?: SupabaseErrorHandler;
}

export interface FromSupabaseErrorOptions {
  /**
   * Override local-development detection for `42501` Data API grant hints on stderr.
   * Defaults to `isLocalDevelopmentRuntime()` (false on hosted Deno Deploy / Edge Runtime
   * and when `NODE_ENV === "production"`).
   */
  readonly devHint?: boolean;
  /** Optional sink override for deterministic testing of dev stderr diagnostics. */
  readonly stderr?: (line: string) => void;
}

function resolveReply(
  handler: SupabaseErrorHandler,
  info: RedactedSupabaseErrorInfo,
): CallToolResult {
  const reply = typeof handler === "function" ? handler(info) : handler;
  if (typeof reply === "string") return errorResult(reply);
  if (Array.isArray(reply)) {
    const [message, nextStep] = reply;
    return errorResult(message, nextStep);
  }
  if (isCallToolResult(reply)) {
    return reply.isError === true ? reply : { ...reply, isError: true };
  }
  const spec = reply as {
    readonly message: string;
    readonly nextStep?: string;
  };
  return errorResult(spec.message, spec.nextStep);
}

function maybeEmitDevGrantHint(
  code: string | undefined,
  rawMessage: string,
  options?: FromSupabaseErrorOptions,
): void {
  const isPermissionFailure =
    code === "42501" ||
    /permission denied for (?:table|relation|view|materialized view|sequence|schema)\b/i.test(
      rawMessage,
    );
  if (!isPermissionFailure) return;
  const enabled = options?.devHint ?? isLocalDevelopmentRuntime();
  if (!enabled) return;

  const hint = formatDevGrantStderrHint(rawMessage);
  if (!hint) return;
  if (options?.stderr) {
    options.stderr(hint);
    return;
  }
  if (emittedDevGrantHints.has(hint)) return;
  if (emittedDevGrantHints.size >= MAX_EMITTED_DEV_GRANT_HINTS) {
    const oldest = emittedDevGrantHints.values().next().value;
    if (typeof oldest === "string") emittedDevGrantHints.delete(oldest);
  }
  emittedDevGrantHints.add(hint);
  console.error(hint);
}

const DEFAULT_ERROR_REPLIES: Readonly<
  Record<Exclude<SupabaseErrorCategory, "custom">, CallToolResult>
> = Object.freeze({
  notFound: errorResult(
    "The requested record was not found or is not visible to this account.",
  ),
  conflict: errorResult(
    "This change conflicts with an existing record.",
    "Read the current state before retrying.",
  ),
  foreignKey: errorResult(
    "A referenced record does not exist or is still in use.",
    "Verify related identifiers before retrying.",
  ),
  invalidInput: errorResult(
    "One or more input values had an invalid format.",
    "Check identifier and parameter formats and try again.",
  ),
  permissionDenied: errorResult(
    "You do not have permission to perform this operation.",
    "Check the connected account's access or ask an administrator.",
  ),
  unknown: errorResult(
    "The database operation could not be completed.",
    "Retry once if transient, or contact the service operator.",
  ),
});

/**
 * Map a Supabase / PostgREST error into a domain-explicit `errorResult` without
 * leaking SQL text, table names, constraint names, or row values to callers.
 */
export function fromSupabaseError(
  error: unknown,
  handlers: FromSupabaseErrorHandlers = {},
  options?: FromSupabaseErrorOptions,
): CallToolResult {
  const record = isPlainRecord(error) ? error : undefined;
  const code =
    typeof record?.code === "string" && record.code.trim().length > 0
      ? record.code.trim()
      : undefined;
  const rawMessage = typeof record?.message === "string" ? record.message : "";
  const rawDetails = typeof record?.details === "string" ? record.details : "";

  maybeEmitDevGrantHint(code, `${rawMessage} ${rawDetails}`.trim(), options);

  if (
    code !== undefined &&
    handlers.codes &&
    Object.hasOwn(handlers.codes, code)
  ) {
    const customHandler = handlers.codes[code];
    if (customHandler !== undefined) {
      return resolveReply(
        customHandler,
        Object.freeze({ code, category: "custom" }),
      );
    }
  }

  let category: Exclude<SupabaseErrorCategory, "custom"> = "unknown";
  if (code === "P0002") {
    category = "notFound";
  } else if (code === "PGRST116") {
    const multipleRows = /\b(?!0\b)\d+\s+rows\b/i.test(rawDetails);
    category = multipleRows ? "unknown" : "notFound";
  } else if (code === "23505") {
    category = "conflict";
  } else if (code === "23503") {
    category = "foreignKey";
  } else if (code === "22P02") {
    category = "invalidInput";
  } else if (code === "42501") {
    category = "permissionDenied";
  }

  const info: RedactedSupabaseErrorInfo = Object.freeze({ code, category });
  const slotHandler =
    category === "unknown" ? handlers.fallback : handlers[category];
  if (slotHandler !== undefined) {
    return resolveReply(slotHandler, info);
  }
  if (handlers.fallback !== undefined) {
    return resolveReply(handlers.fallback, info);
  }
  return DEFAULT_ERROR_REPLIES[category];
}
