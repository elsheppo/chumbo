import { describe, expect, it } from "vitest";
import {
  estimateCatalogTokens,
  estimateJsonTokens,
  estimateResultTokens,
  estimateTextTokens,
  estimateToolTokens,
  SURFACE_TOKEN_LIMITS,
  TOKEN_ESTIMATOR_ID,
} from "../src/surface-tokens.js";

describe("surface-tokens (chumbo-json-lexeme-v1)", () => {
  it("estimates ASCII prose, punctuation, and non-ASCII UTF-8 deterministically", () => {
    expect(estimateTextTokens("")).toBe(0);
    // "list" (4 -> 1) + "_" part of "list_notes" (10 -> ceil(10/4) = 3)
    expect(estimateTextTokens("list_notes")).toBe(3);
    // Non-ASCII multi-byte sequences scale with UTF-8 byte length
    expect(estimateTextTokens("Café")).toBeGreaterThan(1);
    expect(
      estimateJsonTokens('{"type":"object","properties":{}}'),
    ).toBeGreaterThan(5);
  });

  it("is 100% invariant to JSON object key ordering and tool array ordering", () => {
    const toolOrderA = [
      {
        name: "search_notes",
        title: "Search notes",
        description: "Search notes visible to the signed-in user.",
        inputSchema: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", description: "Search query text." },
            limit: { type: "integer", description: "Page size." },
          },
        },
        outputSchema: {
          type: "object",
          properties: {
            items: { type: "array", items: { type: "string" } },
          },
        },
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      {
        name: "archive_note",
        description: "Archive one note by ID.",
        inputSchema: {
          properties: {
            note_id: { description: "Note UUID.", type: "string" },
          },
          required: ["note_id"],
          type: "object",
        },
        annotations: { destructiveHint: false, readOnlyHint: false },
      },
    ];

    const toolOrderB = [
      {
        annotations: { readOnlyHint: false, destructiveHint: false },
        inputSchema: {
          type: "object",
          required: ["note_id"],
          properties: {
            note_id: { type: "string", description: "Note UUID." },
          },
        },
        description: "Archive one note by ID.",
        name: "archive_note",
      },
      {
        annotations: { idempotentHint: true, readOnlyHint: true },
        outputSchema: {
          properties: {
            items: { items: { type: "string" }, type: "array" },
          },
          type: "object",
        },
        inputSchema: {
          properties: {
            limit: { description: "Page size.", type: "integer" },
            query: { description: "Search query text.", type: "string" },
          },
          required: ["query"],
          type: "object",
        },
        description: "Search notes visible to the signed-in user.",
        title: "Search notes",
        name: "search_notes",
      },
    ];

    const reportA = estimateCatalogTokens(toolOrderA);
    const reportB = estimateCatalogTokens(toolOrderB);

    expect(reportA).toEqual(reportB);
    expect(reportA.estimator).toBe(TOKEN_ESTIMATOR_ID);
    expect(reportA.toolCount).toBe(2);
    expect(reportA.totalPromptTokens).toBe(
      SURFACE_TOKEN_LIMITS.catalogBaseTokens +
        reportA.tools.reduce((sum, item) => sum + item.promptTokens, 0),
    );
    expect(reportA.totalWireTokens).toBe(
      reportA.totalPromptTokens + reportA.totalOutputSchemaTokens,
    );
    expect(reportA.tools[0]?.name).toBe("search_notes");
    expect(reportA.tools[0]?.inputPropertyCount).toBe(2);
  });

  it("returns zero base tokens for an empty tool catalog", () => {
    const empty = estimateCatalogTokens([]);
    expect(empty.toolCount).toBe(0);
    expect(empty.totalPromptTokens).toBe(0);
    expect(empty.totalOutputSchemaTokens).toBe(0);
    expect(empty.totalWireBytes).toBe(0);
    expect(empty.overColdStartBudget).toBe(false);
  });

  it("flags bloated inputSchema, bloated outputSchema, and catalog cold-start budget overruns", () => {
    const hugeProperties: Record<string, unknown> = {};
    for (let i = 0; i < 65; i += 1) {
      hugeProperties[`column_field_${i}`] = {
        type: "string",
        description:
          "Unprojected raw database column description carrying verbose repetition.",
      };
    }

    const bloatedTool = estimateToolTokens({
      name: "raw_table_dump",
      description: "Dumps and mutates every column.",
      inputSchema: {
        type: "object",
        properties: hugeProperties,
      },
      outputSchema: {
        type: "object",
        properties: hugeProperties,
      },
    });

    expect(bloatedTool.bloatedInputSchema).toBe(true);
    expect(bloatedTool.bloatedOutputSchema).toBe(true);
    expect(bloatedTool.inputSchemaTokens).toBeGreaterThan(
      SURFACE_TOKEN_LIMITS.bloatedInputSchemaTokens,
    );
    expect(bloatedTool.outputSchemaTokens).toBeGreaterThan(
      SURFACE_TOKEN_LIMITS.bloatedOutputSchemaTokens,
    );

    const catalog = estimateCatalogTokens(
      [
        {
          name: "raw_table_dump",
          description: "Dumps and mutates every column.",
          inputSchema: { type: "object", properties: hugeProperties },
          outputSchema: { type: "object", properties: hugeProperties },
        },
      ],
      { maxCatalogTokens: 500 },
    );
    expect(catalog.overColdStartBudget).toBe(true);
    expect(catalog.bloatedInputTools).toEqual(["raw_table_dump"]);
    expect(catalog.bloatedOutputTools).toEqual(["raw_table_dump"]);
  });

  it("handles malformed non-Chumbo ProbeTool payloads gracefully without throwing", () => {
    const breakdown = estimateToolTokens({
      name: "",
      description: 42,
      inputSchema: null,
      annotations: "invalid",
    });
    expect(breakdown.name).toBe("(unnamed)");
    expect(breakdown.promptTokens).toBeGreaterThan(
      SURFACE_TOKEN_LIMITS.perToolEnvelopeTokens,
    );
  });

  it("separates textTokens and structuredTokens for runtime tool results", () => {
    const hybrid = estimateResultTokens({
      content: [{ type: "text", text: "## Visible projects – 1\n- **Alpha**" }],
      structuredContent: {
        projects: [{ id: "proj_1", name: "Alpha", status: "active" }],
      },
    });
    expect(hybrid.textTokens).toBeGreaterThan(0);
    expect(hybrid.structuredTokens).toBeGreaterThan(0);
    expect(hybrid.totalTokens).toBe(
      hybrid.textTokens + hybrid.structuredTokens,
    );
    expect(hybrid.encodedBytes).toBeGreaterThan(40);
  });
});
