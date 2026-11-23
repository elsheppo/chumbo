import type {
  CallToolResult,
  RegisteredTool,
  ServerContext,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  capabilityAnnotationsFor,
  capabilityManifest,
  CHUMBO_CAPABILITY_META_KEY,
  type ChumboCliProjection,
} from "./capabilities.js";
import {
  collectionBudgetKey,
  encodedBytes,
} from "./internal/collection-budget.js";
import { withOpenOutputSchema } from "./internal/open-output-schema.js";
import {
  canonicalJsonValue,
  PRESENTED_TOOL_NAME,
} from "./internal/surface-canonical.js";
import {
  errorResult,
  formatGuidanceLines,
  guidanceFields,
  resultGuidanceShape,
  type JsonValue,
  type NormalizedResultGuidance,
  type ResultGuidance,
} from "./results.js";
import type { SupabaseMcpServer } from "./types.js";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const CURSOR_PREFIX = "ccur1.";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export const collectionLimits = Object.freeze({
  defaultLimit: 20,
  maxLimit: 100,
  maxBytes: 16 * 1024,
  minBytes: 512,
  maxCursorLength: 2048,
});

const cursor = z.string().min(1).max(collectionLimits.maxCursorLength);
const nextCallSchema = z.object({
  name: z.string().min(1).max(128),
  arguments: z.record(z.string(), z.json()),
});

function positiveLimit(
  value: number,
  maximum: number = collectionLimits.maxLimit,
) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(
      `Collection limit must be an integer from 1 to ${maximum}`,
    );
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64UrlEncodeUtf8(text: string): string {
  const bytes = utf8Encoder.encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlDecodeUtf8(encoded: string): string | null {
  if (!encoded || !BASE64URL_PATTERN.test(encoded)) return null;
  const padding = "=".repeat((4 - (encoded.length % 4)) % 4);
  try {
    const binary = atob(
      encoded.replaceAll("-", "+").replaceAll("_", "/") + padding,
    );
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return utf8Decoder.decode(bytes);
  } catch {
    return null;
  }
}

function stripUndefinedFields(
  obj: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export interface DefineCursorOptions<
  Keys extends Record<string, z.ZodType>,
  Filters extends Record<string, z.ZodType> = Record<never, never>,
> {
  /** Bump when changing sort columns or key encoding. Defaults to 1. */
  readonly version?: number;
  /** Keyset columns in deterministic sort order (end with a unique tie-breaker such as `id`). */
  readonly keys: Keys;
  /** Active filter/sort schemas bound into the cursor so filter drift is refused. */
  readonly filters?: Filters;
}

export type DecodedCursorResult<KeyValues> =
  | { readonly ok: true; readonly keys: KeyValues | null }
  | {
      readonly ok: false;
      readonly reason: "invalid_cursor" | "filter_mismatch";
      readonly result: CallToolResult;
    };

export interface DefinedCursor<
  KeyValues extends Record<string, JsonValue>,
  FilterValues extends Record<string, unknown> = Record<never, never>,
> {
  /** Validated string schema (1..2048 chars, `ccur1.` prefix) for `collectionInputSchema`. */
  readonly schema: z.ZodType<string, string>;

  encode(
    row: Readonly<KeyValues>,
    ...filters: [keyof FilterValues] extends [never]
      ? [filters?: undefined]
      : [filters: FilterValues]
  ): string;

  decode(
    cursorValue: string | undefined,
    ...filters: [keyof FilterValues] extends [never]
      ? [filters?: undefined]
      : [filters: FilterValues]
  ): DecodedCursorResult<KeyValues>;

  /** Curried `cursorFor` helper for `collectionResult`. */
  forFilters(
    ...filters: [keyof FilterValues] extends [never]
      ? [filters?: undefined]
      : [filters: FilterValues]
  ): (row: Readonly<KeyValues>) => string;
}

/**
 * Define an opaque, validated composite keyset cursor bound to active filter
 * and sort arguments (`ccur1.<base64url>`). Encodes position only, never authority.
 */
export function defineCursor<
  Keys extends Record<string, z.ZodType<JsonValue, any>>,
  Filters extends Record<string, z.ZodType> = Record<never, never>,
>(
  options: DefineCursorOptions<Keys, Filters>,
): DefinedCursor<
  { [K in keyof Keys]: z.output<Keys[K]> },
  [keyof Filters] extends [never]
    ? Record<never, never>
    : z.output<z.ZodObject<Filters>>
> {
  const version = options.version ?? 1;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new RangeError("Cursor version must be a positive safe integer");
  }
  const keyNames = Object.keys(options.keys);
  if (keyNames.length === 0) {
    throw new RangeError("defineCursor requires at least one key field");
  }
  const keysSchema = z.object(options.keys).strict();
  const filterNames = options.filters ? Object.keys(options.filters) : [];
  const filtersSchema = options.filters
    ? z.object(options.filters)
    : z.object({});

  type KeyValues = { [K in keyof Keys]: z.output<Keys[K]> };
  type FilterValues = [keyof Filters] extends [never]
    ? Record<never, never>
    : z.output<z.ZodObject<Filters>>;

  const normalizeFilters = (rawFilters: unknown): JsonValue => {
    const picked: Record<string, unknown> = {};
    if (isPlainRecord(rawFilters)) {
      for (const name of filterNames) {
        if (rawFilters[name] !== undefined) picked[name] = rawFilters[name];
      }
    }
    const parsed = filtersSchema.parse(picked) as Record<string, unknown>;
    const stripped = stripUndefinedFields(parsed);
    const canonical = canonicalJsonValue(stripped);
    if (canonical === null) {
      throw new TypeError("Cursor filters must serialize to valid JSON values");
    }
    return canonical;
  };

  const invalidCursor = (): DecodedCursorResult<KeyValues> => ({
    ok: false,
    reason: "invalid_cursor",
    result: errorResult(
      "Invalid pagination cursor.",
      "Omit cursor to restart from the first page.",
    ),
  });

  const filterMismatch = (): DecodedCursorResult<KeyValues> => ({
    ok: false,
    reason: "filter_mismatch",
    result: errorResult(
      "Pagination cursor does not match the current filters or sort order.",
      "Omit cursor to start a new query with these filters, or restore the previous filters.",
    ),
  });

  const cursorEnvelopeSchema = z
    .string()
    .min(CURSOR_PREFIX.length + 1)
    .max(collectionLimits.maxCursorLength)
    .refine(
      (val) =>
        val.startsWith(CURSOR_PREFIX) &&
        BASE64URL_PATTERN.test(val.slice(CURSOR_PREFIX.length)),
      "Invalid cursor format.",
    );

  const encodeImpl = (
    row: Readonly<KeyValues>,
    rawFilters?: unknown,
  ): string => {
    if (!isPlainRecord(row)) {
      throw new TypeError("Cursor row must be an object");
    }
    // Strictly pick declared key fields only so extra database columns never enter the cursor.
    const pickedKeys: Record<string, unknown> = {};
    for (const keyName of keyNames) {
      pickedKeys[keyName] = row[keyName];
    }
    const validatedKeys = keysSchema.parse(pickedKeys);
    const canonicalKeys = canonicalJsonValue(validatedKeys);
    if (canonicalKeys === null) {
      throw new TypeError("Cursor keys must serialize to valid JSON values");
    }
    const canonicalFilters = normalizeFilters(rawFilters);
    const encoded = `${CURSOR_PREFIX}${base64UrlEncodeUtf8(
      JSON.stringify({
        v: version,
        k: canonicalKeys,
        f: canonicalFilters,
      }),
    )}`;
    if (encoded.length > collectionLimits.maxCursorLength) {
      throw new RangeError(
        `Encoded cursor exceeds maximum length of ${collectionLimits.maxCursorLength} characters`,
      );
    }
    return encoded;
  };

  const decodeImpl = (
    cursorValue: string | undefined,
    rawFilters?: unknown,
  ): DecodedCursorResult<KeyValues> => {
    if (cursorValue === undefined) {
      return { ok: true, keys: null };
    }
    if (
      typeof cursorValue !== "string" ||
      !cursorValue.startsWith(CURSOR_PREFIX) ||
      cursorValue.length > collectionLimits.maxCursorLength
    ) {
      return invalidCursor();
    }
    const decodedJson = base64UrlDecodeUtf8(
      cursorValue.slice(CURSOR_PREFIX.length),
    );
    if (decodedJson === null) return invalidCursor();
    let envelope: unknown;
    try {
      envelope = JSON.parse(decodedJson);
    } catch {
      return invalidCursor();
    }
    if (!isPlainRecord(envelope) || envelope.v !== version) {
      return invalidCursor();
    }
    if (!isPlainRecord(envelope.k) || !isPlainRecord(envelope.f)) {
      return invalidCursor();
    }
    const parsedKeys = keysSchema.safeParse(envelope.k);
    if (!parsedKeys.success) return invalidCursor();

    let expectedFilters: JsonValue;
    try {
      expectedFilters = normalizeFilters(rawFilters);
    } catch {
      return invalidCursor();
    }
    const storedFilters = canonicalJsonValue(envelope.f);
    if (
      storedFilters === null ||
      JSON.stringify(storedFilters) !== JSON.stringify(expectedFilters)
    ) {
      return filterMismatch();
    }
    return {
      ok: true,
      keys: Object.freeze(parsedKeys.data) as KeyValues,
    };
  };

  return Object.freeze({
    schema: cursorEnvelopeSchema,
    encode(row: Readonly<KeyValues>, ...rest: unknown[]) {
      return encodeImpl(row, rest[0]);
    },
    decode(cursorValue: string | undefined, ...rest: unknown[]) {
      return decodeImpl(cursorValue, rest[0]);
    },
    forFilters(...rest: unknown[]) {
      const boundFilters = rest[0];
      return (row: Readonly<KeyValues>) => encodeImpl(row, boundFilters);
    },
  }) as DefinedCursor<KeyValues, FilterValues>;
}

/** Extend this object schema with application filters. Cursor semantics remain application-owned. */
export function collectionInputSchema(
  options: {
    defaultLimit?: number;
    maxLimit?: number;
    cursorSchema?: z.ZodType<string, string>;
  } = {},
) {
  const max = positiveLimit(options.maxLimit ?? collectionLimits.maxLimit);
  const defaultLimit = positiveLimit(
    options.defaultLimit ?? Math.min(collectionLimits.defaultLimit, max),
    max,
  );
  return z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(max)
      .default(defaultLimit)
      .describe(`How many items to return, from 1 to ${max}.`),
    cursor: cursor
      .pipe(options.cursorSchema ?? z.string())
      .pipe(cursor)
      .optional()
      .describe(
        "Omit for the first page. To continue, pass next_cursor from the previous result.",
      ),
  });
}

/** Register this outputSchema only for structured or intentional hybrid collection results. */
export function collectionOutputSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    ...resultGuidanceShape,
    items: z.array(itemSchema).max(collectionLimits.maxLimit),
    has_more: z.boolean(),
    next_cursor: cursor.nullable(),
    next_call: nextCallSchema.nullable(),
  });
}

export interface CollectionNextCall {
  name: string;
  arguments: Record<string, JsonValue>;
}

export interface CollectionPage<Item> {
  next?: string;
  warnings?: string[];
  items: Item[];
  has_more: boolean;
  next_cursor: string | null;
  next_call: CollectionNextCall | null;
}

export interface CollectionResultOptions<Row, Item = Row> {
  /** One bounded, ordered source window. Fetch limit + 1 to detect more rows. */
  items: readonly Row[];
  limit: number;
  /** Whether the source has rows beyond this supplied window. Defaults to `false`. */
  hasMore?: boolean;
  /**
   * Explicit compact projection, validated before it enters either response lane.
   * When omitted, copies strictly the keys declared in `itemSchema.shape` and parses via `itemSchema`.
   */
  project?: (row: Row) => Item;
  itemSchema: z.ZodType<Item>;
  /** Stable keyset cursor AFTER this row, never after the fetched window. */
  cursorFor: (row: Row) => string;
  tool: string;
  /** Explicit safe filters only. Chumbo overwrites cursor and limit with this page's continuation. */
  arguments?: Record<string, JsonValue>;
  maxLimit?: number;
  maxBytes?: number;
  mode?: "text" | "structured" | "hybrid";
  /** Purpose-written text from exactly the projected page. Required for text/hybrid. */
  render?: (page: Readonly<CollectionPage<Item>>) => string;
  /** Dual-lane operational guidance budgeted together with the returned page. */
  guidance?:
    | ResultGuidance
    | ((page: Readonly<CollectionPage<Item>>) => ResultGuidance);
  /** A compact detail-tool or Resource instruction when the first item cannot fit. */
  onOversizedItem?: (row: Row) => string;
}

function snapshot<T>(value: T): T {
  // z.json rejects undefined, bigint, NaN, Dates and other silently lossy values.
  // Catch cycles before recursive validation so failures are explicit.
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError("Collection values must be JSON serializable");
  }
  if (!z.json().safeParse(value).success) {
    throw new TypeError("Collection values must contain only JSON values");
  }
  return JSON.parse(serialized) as T;
}

function defaultProjectionFor<Row, Item>(
  itemSchema: z.ZodType<Item>,
): (row: Row) => Item {
  const maybeObject = itemSchema as unknown as {
    shape?: Record<string, unknown>;
  };
  if (!isPlainRecord(maybeObject.shape)) {
    throw new TypeError(
      "collectionResult requires an explicit project(row) function when itemSchema is not a z.object(...) shape",
    );
  }
  const allowedKeys = Object.keys(maybeObject.shape);
  return (row: Row): Item => {
    if (!isPlainRecord(row)) {
      throw new TypeError("Default collection projection expects object rows");
    }
    const picked: Record<string, unknown> = {};
    for (const key of allowedKeys) {
      if (row[key] !== undefined) picked[key] = row[key];
    }
    return itemSchema.parse(picked);
  };
}

/**
 * Build the largest prefix that fits both count and UTF-8 serialized CallToolResult budgets.
 * Source queries, stable ordering, projection semantics and authorization remain builder-owned.
 * Existing result helpers and arbitrary tool results are never automatically paginated.
 */
export function collectionResult<Row, Item = Row>(
  options: CollectionResultOptions<Row, Item>,
): CallToolResult {
  const max = positiveLimit(options.maxLimit ?? collectionLimits.maxLimit);
  const limit = positiveLimit(options.limit, max);
  const maxBytes = options.maxBytes ?? collectionLimits.maxBytes;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < collectionLimits.minBytes ||
    maxBytes > 1024 * 1024
  ) {
    throw new RangeError(
      "Collection maxBytes must be an integer from 512 to 1048576",
    );
  }
  const hasMoreOption = options.hasMore ?? false;
  if (
    !Array.isArray(options.items) ||
    options.items.length > max + 1 ||
    typeof hasMoreOption !== "boolean"
  ) {
    throw new TypeError(
      "Supply a bounded collection source window (at most maxLimit + 1 items) and boolean hasMore",
    );
  }
  if (options.items.length === 0 && hasMoreOption) {
    throw new TypeError(
      "An empty source window cannot continue without a returned cursor",
    );
  }
  const mode = options.mode ?? "text";
  if (
    !["text", "structured", "hybrid"].includes(mode) ||
    (mode !== "structured" && typeof options.render !== "function")
  ) {
    throw new TypeError(
      "Collection text/hybrid mode requires a purpose-written render function",
    );
  }
  const name = nextCallSchema.shape.name.parse(options.tool);
  const args = snapshot(options.arguments ?? {});
  const projectFn =
    options.project !== undefined
      ? options.project
      : defaultProjectionFor<Row, Item>(options.itemSchema);
  const projected: Item[] = [];
  const cursors: string[] = [];
  // Validate only the bounded candidate page, not the source's lookahead row.
  for (const row of options.items.slice(0, limit)) {
    projected.push(snapshot(options.itemSchema.parse(projectFn(row))));
    const key = cursor.parse(options.cursorFor(row));
    if (cursors.includes(key) || key === args.cursor) {
      throw new TypeError(
        "Collection cursors must advance uniquely after each returned item",
      );
    }
    cursors.push(key);
  }
  function build(count: number): CallToolResult {
    const hasMore = hasMoreOption || count < options.items.length;
    const nextCursor = hasMore ? cursors[count - 1]! : null;
    const nextCall =
      nextCursor === null
        ? null
        : { name, arguments: { ...args, cursor: nextCursor, limit } };
    const basePage: CollectionPage<Item> = {
      items: projected.slice(0, count),
      has_more: hasMore,
      next_cursor: nextCursor,
      next_call: nextCall,
    };
    const resolvedGuidance =
      typeof options.guidance === "function"
        ? options.guidance(snapshot(basePage))
        : options.guidance;
    const fields: NormalizedResultGuidance = guidanceFields(resolvedGuidance);
    const page: CollectionPage<Item> =
      fields.next !== undefined || fields.warnings !== undefined
        ? { ...fields, ...basePage, ...fields }
        : basePage;

    const content: CallToolResult["content"] = [];
    const guidanceLines = formatGuidanceLines(fields);
    if (mode !== "structured") {
      // Give render its own snapshot: it must not change structured data or continuation.
      const rendered = options.render!(snapshot(page));
      if (typeof rendered !== "string") {
        throw new TypeError("Collection render must return text");
      }
      content.push({ type: "text", text: rendered });
      const continuationLine = nextCall
        ? `Showing ${count} records. has_more: true; next_cursor: ${JSON.stringify(nextCursor)}.\nNext: call ${name} with ${JSON.stringify(nextCall.arguments)}.`
        : `Showing ${count} records. has_more: false; next_cursor: null. End of results.`;
      content.push({
        type: "text",
        text: [continuationLine, ...guidanceLines].join("\n"),
      });
    } else if (guidanceLines.length > 0) {
      content.push({
        type: "text",
        text: guidanceLines.join("\n"),
      });
    }
    return {
      content,
      ...(mode === "text" ? {} : { structuredContent: page }),
      _meta: { [collectionBudgetKey]: maxBytes },
    };
  }
  // Scan from largest to smallest: a terminal page can be smaller than a partial
  // page because it needs no continuation arguments. Never assume monotonic size.
  for (
    let count = projected.length;
    count >= (projected.length ? 1 : 0);
    count--
  ) {
    const result = build(count);
    if (encodedBytes(result) <= maxBytes) return result;
  }
  let failure = errorResult(
    "Collection page exceeds its response budget. No records were returned or skipped.",
    options.items[0] !== undefined && options.onOversizedItem
      ? options.onOversizedItem(options.items[0])
      : "use a detail tool or Resource for the first record, or ask the builder for a smaller projection.",
  );
  if (
    encodedBytes({ ...failure, _meta: { [collectionBudgetKey]: maxBytes } }) >
    maxBytes
  ) {
    failure = errorResult(
      "Collection page exceeds its response budget. No records were returned or skipped.",
      "ask the builder for a smaller projection or a detail/Resource path.",
    );
  }
  return { ...failure, _meta: { [collectionBudgetKey]: maxBytes } };
}

export interface CollectionPageBuilderOptions<Row, Item> {
  readonly hasMore?: boolean;
  readonly guidance?:
    | ResultGuidance
    | ((page: Readonly<CollectionPage<Item>>) => ResultGuidance);
  readonly onOversizedItem?: (row: Row) => string;
}

export interface RegisterCollectionConfig<
  ItemSchema extends z.ZodObject<any>,
  KeyValues extends Record<string, JsonValue>,
  FiltersShape extends Record<string, z.ZodType> = Record<never, never>,
  Row = z.input<ItemSchema>,
> {
  readonly name: string;
  readonly id?: string;
  readonly title?: string;
  readonly description: string;
  readonly scopes?: readonly string[];
  readonly cli?: ChumboCliProjection;
  readonly filters?: FiltersShape;
  readonly itemSchema: ItemSchema;
  readonly cursor: DefinedCursor<
    KeyValues,
    [keyof FiltersShape] extends [never]
      ? Record<never, never>
      : { [K in keyof FiltersShape]: z.output<FiltersShape[K]> }
  >;
  readonly defaultLimit?: number;
  readonly maxLimit?: number;
  readonly maxBytes?: number;
  /** Defaults to `"structured"` when `render` is omitted, or `"hybrid"` when `render` is supplied. */
  readonly mode?: "text" | "structured" | "hybrid";
  readonly project?: (row: Row) => z.output<ItemSchema>;
  readonly render?: (
    page: Readonly<CollectionPage<z.output<ItemSchema>>>,
  ) => string;
  readonly onOversizedItem?: (row: Row) => string;
  readonly annotations?: ToolAnnotations;
  readonly mcpMeta?: Readonly<Record<string, unknown>>;
}

export interface CollectionHandlerInput<
  ItemSchema extends z.ZodObject<any>,
  KeyValues extends Record<string, JsonValue>,
  FiltersShape extends Record<string, z.ZodType>,
  Row,
> {
  readonly limit: number;
  readonly cursor: string | undefined;
  /** Decoded keyset values from `cursor`, or `null` on the first page. */
  readonly after: KeyValues | null;
  /** Validated filter/sort arguments (excluding `limit` and `cursor`). */
  readonly filters: { [K in keyof FiltersShape]: z.output<FiltersShape[K]> };
  /** Build the bounded `CallToolResult` with tool name, cursor, filters, and schemas pre-bound. */
  page(
    items: readonly Row[],
    options?: CollectionPageBuilderOptions<Row, z.output<ItemSchema>>,
  ): CallToolResult;
}

function resolvePresentedToolName(
  server: SupabaseMcpServer,
  canonicalName: string,
): string {
  const lookup = (server as unknown as Record<symbol, unknown>)[
    PRESENTED_TOOL_NAME
  ];
  if (typeof lookup === "function") {
    const resolved = (lookup as (name: string) => string | undefined)(
      canonicalName,
    );
    if (typeof resolved === "string" && resolved.length > 0) return resolved;
  }
  return canonicalName;
}

/**
 * Register a bounded, keyset-paginated read capability with filter-bound cursor
 * decoding, automatic `outputSchema`, and pre-bound `page(items)` result builder.
 */
export function registerCollection<
  ItemSchema extends z.ZodObject<any>,
  KeyValues extends Record<string, JsonValue>,
  FiltersShape extends Record<string, z.ZodType> = Record<never, never>,
  Row extends KeyValues = z.input<ItemSchema> & KeyValues,
>(
  server: SupabaseMcpServer,
  config: RegisterCollectionConfig<ItemSchema, KeyValues, FiltersShape, Row>,
  handler: (
    input: CollectionHandlerInput<ItemSchema, KeyValues, FiltersShape, Row>,
    mcpContext: ServerContext,
  ) => CallToolResult | Promise<CallToolResult>,
): RegisteredTool {
  const mode = config.mode ?? (config.render ? "hybrid" : "structured");
  if (mode !== "structured" && typeof config.render !== "function") {
    throw new TypeError(
      "registerCollection in text/hybrid mode requires a render(page) function",
    );
  }
  // Use unvalidated base cursor string schema on inputSchema so malformed or
  // filter-mismatched cursors enter the handler wrapper and return a recoverable
  // tool-level errorResult with restart guidance rather than a raw protocol error.
  const baseInput = collectionInputSchema({
    defaultLimit: config.defaultLimit,
    maxLimit: config.maxLimit,
  });
  const filterKeys = config.filters ? Object.keys(config.filters) : [];
  const inputSchema = config.filters
    ? baseInput.extend(config.filters)
    : baseInput;
  const outputSchema =
    mode === "text" ? undefined : collectionOutputSchema(config.itemSchema);

  const manifest = capabilityManifest({
    ...(config.id ? { id: config.id } : {}),
    mcpName: config.name,
    ...(config.title ? { title: config.title } : {}),
    description: config.description,
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
    ...(config.scopes ? { scopes: config.scopes } : {}),
    risk: "read",
    idempotent: true,
    ...(config.cli ? { cli: config.cli } : {}),
    ...(config.annotations ? { annotations: config.annotations } : {}),
    handler: async () => ({ content: [] }),
  });

  const target = server.withScopes(manifest.scopes);
  const presentedName = resolvePresentedToolName(target, config.name);

  const toolConfig = withOpenOutputSchema({
    ...(config.title ? { title: config.title } : {}),
    description: config.description,
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
    annotations: capabilityAnnotationsFor({
      title: config.title,
      risk: "read",
      annotations: config.annotations,
      manifest,
    }),
    _meta: {
      ...config.mcpMeta,
      [CHUMBO_CAPABILITY_META_KEY]: manifest,
    },
  });

  return target.registerTool(
    config.name,
    toolConfig,
    async (rawArgs: Record<string, unknown>, mcpContext: ServerContext) => {
      const limit = rawArgs.limit as number;
      const cursorArg = rawArgs.cursor as string | undefined;
      const extractedFilters: Record<string, unknown> = {};
      for (const key of filterKeys) {
        if (rawArgs[key] !== undefined) extractedFilters[key] = rawArgs[key];
      }
      const decodeFn = config.cursor.decode as (
        c: string | undefined,
        f?: unknown,
      ) => DecodedCursorResult<KeyValues>;
      const decoded = decodeFn(cursorArg, extractedFilters);
      if (!decoded.ok) return decoded.result;

      const safeArgs: Record<string, JsonValue> = {};
      for (const [key, val] of Object.entries(extractedFilters)) {
        const normalized = canonicalJsonValue(val);
        if (normalized !== null || val === null) {
          safeArgs[key] = normalized;
        }
      }
      if (cursorArg !== undefined) {
        safeArgs.cursor = cursorArg;
      }

      const cursorFor = (
        config.cursor.forFilters as (
          f?: unknown,
        ) => (row: Readonly<KeyValues>) => string
      )(extractedFilters);

      const page = (
        items: readonly Row[],
        pageOptions?: CollectionPageBuilderOptions<Row, z.output<ItemSchema>>,
      ): CallToolResult =>
        collectionResult<Row, z.output<ItemSchema>>({
          items,
          limit,
          hasMore: pageOptions?.hasMore ?? false,
          itemSchema: config.itemSchema as unknown as z.ZodType<
            z.output<ItemSchema>
          >,
          ...(config.project ? { project: config.project } : {}),
          cursorFor: (row) => cursorFor(row),
          tool: presentedName,
          arguments: safeArgs,
          ...(config.maxLimit !== undefined
            ? { maxLimit: config.maxLimit }
            : {}),
          ...(config.maxBytes !== undefined
            ? { maxBytes: config.maxBytes }
            : {}),
          mode,
          ...(config.render ? { render: config.render } : {}),
          ...(pageOptions?.guidance !== undefined
            ? { guidance: pageOptions.guidance }
            : {}),
          ...((pageOptions?.onOversizedItem ?? config.onOversizedItem)
            ? {
                onOversizedItem:
                  pageOptions?.onOversizedItem ?? config.onOversizedItem,
              }
            : {}),
        });

      return handler(
        {
          limit,
          cursor: cursorArg,
          after: decoded.keys,
          filters: extractedFilters as {
            [K in keyof FiltersShape]: z.output<FiltersShape[K]>;
          },
          page,
        },
        mcpContext,
      );
    },
  );
}
