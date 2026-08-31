import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  appendResultText,
  composeResultContent,
  errorResult,
  prependResultText,
  renderResult,
  resourceResult,
  structuredResult,
  textResult,
  type JsonValue,
} from "../src/results.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content[0]?.text ?? "";
}

function textsOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.flatMap((block) =>
    block.type === "text" && block.text !== undefined ? [block.text] : [],
  );
}

describe("result composition", () => {
  it("adds text in order without mutating a structured result", () => {
    const original = structuredResult({ projectId: "p1" });
    const composed = appendResultText(
      prependResultText(original, "Before"),
      "After",
    );

    expect(textsOf(composed)).toEqual(["Before", "After"]);
    expect(composed.structuredContent).toEqual({ projectId: "p1" });
    expect(original).toEqual({
      content: [],
      structuredContent: { projectId: "p1" },
    });
  });

  it("snapshots added blocks so later caller mutation cannot change the result", () => {
    const added = { type: "text" as const, text: "Stable guidance" };
    const composed = composeResultContent(textResult("Original"), {
      append: [added],
    });

    added.text = "Mutated guidance";
    expect(textsOf(composed)).toEqual(["Original", "Stable guidance"]);
  });

  it("preserves hybrid, Resource, error, and extension metadata", () => {
    const futureField = { enabled: true };
    const metadata = { "ui/resourceUri": "ui://reports/view" };
    const original = {
      ...resourceResult("Open the report", {
        type: "resource_link" as const,
        uri: "app://reports/p1",
        name: "report",
      }),
      structuredContent: { reportId: "p1" },
      isError: true,
      _meta: metadata,
      futureField,
    } as CallToolResult & { futureField: { enabled: boolean } };
    const composed = composeResultContent(original, {
      prepend: [{ type: "text", text: "Before" }],
      append: [{ type: "text", text: "After" }],
    });

    expect(textsOf(composed)).toEqual(["Before", "Open the report", "After"]);
    expect(composed.content[2]).toMatchObject({
      type: "resource_link",
      uri: "app://reports/p1",
    });
    expect(composed).toMatchObject({
      structuredContent: { reportId: "p1" },
      isError: true,
      _meta: { "ui/resourceUri": "ui://reports/view" },
      futureField: { enabled: true },
    });
    expect(composed._meta).toBe(metadata);
    expect((composed as typeof original).futureField).toBe(futureField);
  });

  it("rejects additions beyond the block and encoded-byte bounds", () => {
    expect(() =>
      composeResultContent(textResult("Original"), {
        append: Array.from({ length: 17 }, (_, index) => ({
          type: "text" as const,
          text: String(index),
        })),
      }),
    ).toThrow(/at most 16 content blocks/);
    expect(() =>
      appendResultText(textResult("Original"), "x".repeat(64 * 1024)),
    ).toThrow(/at most 65536 encoded bytes/);
    expect(() =>
      composeResultContent(textResult("Original"), {
        append: [{ type: "not-mcp-content" } as never],
      }),
    ).toThrow(/only valid MCP content blocks/);
  });
});

describe("textResult", () => {
  it("returns only purpose-written text", () => {
    expect(textResult("Project: Summer campaign")).toEqual({
      content: [{ type: "text", text: "Project: Summer campaign" }],
    });
  });
});

describe("structuredResult", () => {
  it.each([
    ["object", { projectId: "p1", title: "Summer" }],
    ["array", [{ id: "p1" }, { id: "p2" }]],
    ["string", "ready"],
    ["number", 3],
    ["boolean", true],
    ["null", null],
    ["nested", { project: { id: "p1", tags: ["summer", null] } }],
  ] satisfies Array<[string, JsonValue]>)(
    "preserves an exact %s JSON value without text",
    (_name, value) => {
      expect(structuredResult(value)).toEqual({
        content: [],
        structuredContent: value,
      });
    },
  );
});

describe("renderResult", () => {
  it("keeps purpose-written text and exact structured data distinct", () => {
    const value = { projectId: "p1", title: "Summer campaign" };
    expect(
      renderResult(
        value,
        ({ title }) => `Project: ${title}\n\n→ Next: call list_assets.`,
      ),
    ).toEqual({
      content: [
        {
          type: "text",
          text: "Project: Summer campaign\n\n→ Next: call list_assets.",
        },
      ],
      structuredContent: value,
    });
  });
});

describe("resourceResult", () => {
  it("returns a reading card and link without embedding the resource body", () => {
    const largeBody = "complete report body";
    const result = resourceResult("Summer campaign report", {
      type: "resource_link",
      uri: "app://projects/p1/report",
      name: "summer-campaign-report",
      title: "Summer campaign report",
      description: "Complete project report",
      mimeType: "text/markdown",
      size: largeBody.length,
    });

    expect(textOf(result)).toBe("Summer campaign report");
    expect(result.content[1]).toMatchObject({
      type: "resource_link",
      uri: "app://projects/p1/report",
    });
    expect(JSON.stringify(result)).not.toContain(largeBody);
    expect(result).not.toHaveProperty("structuredContent");
  });
});

describe("errorResult", () => {
  it("appends a next step when routing is provided", () => {
    expect(textOf(errorResult("No Block named X.", "call list_blocks."))).toBe(
      "No Block named X.\n\n→ Next: call list_blocks.",
    );
    expect(textOf(errorResult("No Block named X."))).toBe("No Block named X.");
  });
});
