import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  collectionInputSchema,
  collectionOutputSchema,
  collectionResult,
  collectionLimits,
  type CollectionResultOptions,
} from "../src/collections.js";
import { appendResultText } from "../src/results.js";

const rowSchema = z.object({ id: z.string(), title: z.string() });
type Row = { id: string; title: string; transcript?: string };
const rows: Row[] = Array.from({ length: 4 }, (_, index) => ({
  id: String(index + 1),
  title: `Call ${index + 1}`,
  transcript: "private source record".repeat(500),
}));
function options(
  overrides: Partial<
    CollectionResultOptions<Row, z.infer<typeof rowSchema>>
  > = {},
): CollectionResultOptions<Row, z.infer<typeof rowSchema>> {
  return {
    items: rows,
    limit: 3,
    hasMore: false,
    project: ({ id, title }) => ({ id, title }),
    itemSchema: rowSchema,
    cursorFor: ({ id }) => id,
    tool: "list_calls",
    arguments: { status: "complete", sort: "newest" },
    mode: "hybrid",
    render: ({ items }) =>
      items.map((item) => `${item.id}: ${item.title}`).join("\n"),
    ...overrides,
  };
}
function page(result: ReturnType<typeof collectionResult>) {
  return collectionOutputSchema(rowSchema).parse(result.structuredContent);
}
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe("bounded collection contracts", () => {
  it("supplies validated defaults, bounded custom limits and semantic cursor validation", () => {
    expect(collectionInputSchema().parse({})).toEqual({
      limit: collectionLimits.defaultLimit,
    });
    const schema = collectionInputSchema({
      defaultLimit: 2,
      maxLimit: 3,
      cursorSchema: z.string().regex(/^call-[0-9]+$/),
    });
    expect(schema.parse({ cursor: "call-7" })).toEqual({
      limit: 2,
      cursor: "call-7",
    });
    for (const args of [
      { limit: 0 },
      { limit: 4 },
      { limit: 1.5 },
      { cursor: "" },
      { cursor: "bad" },
      { cursor: "x".repeat(2049) },
    ])
      expect(schema.safeParse(args).success).toBe(false);
    expect(() =>
      collectionInputSchema({ defaultLimit: 4, maxLimit: 3 }),
    ).toThrow();
  });

  it("projects one count-bounded page with exact filter-preserving continuation and no full records", () => {
    const result = collectionResult(options());
    expect(page(result)).toEqual({
      items: rows.slice(0, 3).map(({ id, title }) => ({ id, title })),
      has_more: true,
      next_cursor: "3",
      next_call: {
        name: "list_calls",
        arguments: {
          status: "complete",
          sort: "newest",
          cursor: "3",
          limit: 3,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("private source record");
    expect(result.content).toContainEqual({
      type: "text",
      text: expect.stringContaining('"cursor":"3"'),
    });
    const next = collectionResult(
      options({
        items: rows.filter((row) => row.id > page(result).next_cursor!),
        arguments: page(result).next_call!.arguments,
      }),
    );
    expect(page(next)).toMatchObject({
      items: [{ id: "4" }],
      has_more: false,
      next_cursor: null,
      next_call: null,
    });
  });

  it.each(["text", "structured", "hybrid"] as const)(
    "supports deliberate %s lanes and successful empty pages",
    (mode) => {
      const result = collectionResult(options({ mode, items: [] }));
      if (mode === "text")
        expect(result).not.toHaveProperty("structuredContent");
      else
        expect(page(result)).toEqual({
          items: [],
          has_more: false,
          next_cursor: null,
          next_call: null,
        });
      if (mode === "structured") expect(result.content).toEqual([]);
      else
        expect(result.content.at(-1)).toMatchObject({
          text: expect.stringContaining("End of results"),
        });
    },
  );

  it("budgets UTF-8 over both lanes and resumes after the last returned, never the fetched row", () => {
    const source = rows.map((row) => ({ ...row, title: "🙂".repeat(100) }));
    const first = collectionResult(options({ items: source, maxBytes: 1600 }));
    expect(bytes(first)).toBeLessThanOrEqual(1600);
    expect(page(first).items.length).toBe(1);
    expect(page(first).next_cursor).toBe("1");
    const next = collectionResult(
      options({
        items: source.filter((row) => row.id > page(first).next_cursor!),
        maxBytes: 1600,
        arguments: page(first).next_call!.arguments,
      }),
    );
    expect(page(next).items[0]?.id).toBe("2");
    expect(() => appendResultText(first, "a".repeat(1000))).toThrow(/budget/);
    expect(page(first).next_cursor).toBe("1");
  });

  it("checks the terminal page before a larger partial-page envelope", () => {
    const result = collectionResult(
      options({
        items: rows.slice(0, 2),
        limit: 2,
        maxBytes: 512,
        arguments: { filter: "x".repeat(1000) },
        mode: "structured",
      }),
    );
    expect(page(result).items).toHaveLength(2);
    expect(page(result).has_more).toBe(false);
  });

  it("returns a bounded recoverable oversized-item error, never silent omission", () => {
    const result = collectionResult(
      options({
        items: [{ id: "1", title: "x".repeat(10000) }],
        maxBytes: 512,
        mode: "structured",
        onOversizedItem: ({ id }) => `call get_call with id ${id}`,
      }),
    );
    expect(result.isError).toBe(true);
    expect(result).not.toHaveProperty("structuredContent");
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("get_call with id 1"),
    });
    expect(bytes(result)).toBeLessThanOrEqual(512);
    const fallback = collectionResult(
      options({
        items: [{ id: "1", title: "x".repeat(10000) }],
        maxBytes: 512,
        onOversizedItem: () => "x".repeat(10000),
      }),
    );
    expect(bytes(fallback)).toBeLessThanOrEqual(512);
    expect(fallback.isError).toBe(true);
  });

  it("validates projection, cursor progress, source bounds and serializability", () => {
    for (const override of [
      { limit: 0 },
      { maxBytes: 511 },
      { items: [], hasMore: true },
      { items: Array(102).fill(rows[0]) },
      { cursorFor: () => "same" },
      { cursorFor: () => "" },
      { mode: "text" as const, render: undefined },
    ])
      expect(() => collectionResult(options(override))).toThrow();
    expect(() =>
      collectionResult(
        options({ project: () => ({ id: "1", title: 7 as never }) }),
      ),
    ).toThrow();
    expect(() =>
      collectionResult(options({ arguments: { bad: undefined as never } })),
    ).toThrow(/JSON/);
    expect(() =>
      collectionResult(options({ arguments: { bad: NaN } })),
    ).toThrow(/JSON/);
    const cycle: any = {};
    cycle.self = cycle;
    expect(() => collectionResult(options({ arguments: cycle }))).toThrow(
      /serializable/,
    );
    expect(() =>
      collectionResult(options({ arguments: { cursor: "1" } })),
    ).toThrow(/advance/);
  });

  it("prevents render mutation from changing the structured page", () => {
    const result = collectionResult(
      options({
        render: (value) => {
          value.items[0]!.title = "mutated";
          return "Readable card";
        },
      }),
    );
    expect(page(result).items[0]?.title).toBe("Call 1");
  });
});
