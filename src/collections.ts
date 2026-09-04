import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { errorResult, type JsonValue } from "./results.js";
import {
  collectionBudgetKey,
  encodedBytes,
} from "./internal/collection-budget.js";

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
    limit: z.number().int().min(1).max(max).default(defaultLimit),
    cursor: cursor
      .pipe(options.cursorSchema ?? z.string())
      .pipe(cursor)
      .optional(),
  });
}

/** Register this outputSchema only for structured or intentional hybrid collection results. */
export function collectionOutputSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
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
  items: Item[];
  has_more: boolean;
  next_cursor: string | null;
  next_call: CollectionNextCall | null;
}

export interface CollectionResultOptions<Row, Item> {
  /** One bounded, ordered source window. Fetch limit + 1 to detect more rows. */
  items: readonly Row[];
  limit: number;
  /** Whether the source has rows beyond this supplied window. No total count needed. */
  hasMore: boolean;
  /** Explicit compact projection, validated before it enters either response lane. */
  project: (row: Row) => Item;
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

/**
 * Build the largest prefix that fits both count and UTF-8 serialized CallToolResult budgets.
 * Source queries, stable ordering, projection semantics and authorization remain builder-owned.
 * Existing result helpers and arbitrary tool results are never automatically paginated.
 */
export function collectionResult<Row, Item>(
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
  if (
    !Array.isArray(options.items) ||
    options.items.length > max + 1 ||
    typeof options.hasMore !== "boolean"
  ) {
    throw new TypeError(
      "Supply a bounded collection source window (at most maxLimit + 1 items) and boolean hasMore",
    );
  }
  if (options.items.length === 0 && options.hasMore) {
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
  const projected: Item[] = [];
  const cursors: string[] = [];
  // Validate only the bounded candidate page, not the source's lookahead row.
  for (const row of options.items.slice(0, limit)) {
    projected.push(snapshot(options.itemSchema.parse(options.project(row))));
    const key = cursor.parse(options.cursorFor(row));
    if (cursors.includes(key) || key === args.cursor) {
      throw new TypeError(
        "Collection cursors must advance uniquely after each returned item",
      );
    }
    cursors.push(key);
  }
  function build(count: number): CallToolResult {
    const hasMore = options.hasMore || count < options.items.length;
    const nextCursor = hasMore ? cursors[count - 1]! : null;
    const nextCall =
      nextCursor === null
        ? null
        : { name, arguments: { ...args, cursor: nextCursor, limit } };
    const page: CollectionPage<Item> = {
      items: projected.slice(0, count),
      has_more: hasMore,
      next_cursor: nextCursor,
      next_call: nextCall,
    };
    const content: CallToolResult["content"] = [];
    if (mode !== "structured") {
      // Give render its own snapshot: it must not change structured data or continuation.
      const rendered = options.render!(snapshot(page));
      if (typeof rendered !== "string")
        throw new TypeError("Collection render must return text");
      content.push({ type: "text", text: rendered });
      content.push({
        type: "text",
        text: nextCall
          ? `Showing ${count} records. has_more: true; next_cursor: ${JSON.stringify(nextCursor)}.\nNext: call ${name} with ${JSON.stringify(nextCall.arguments)}.`
          : `Showing ${count} records. has_more: false; next_cursor: null. End of results.`,
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
