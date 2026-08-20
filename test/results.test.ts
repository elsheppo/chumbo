import { describe, expect, it } from "vitest";
import {
  errorResult,
  renderResult,
  resourceResult,
  structuredResult,
  textResult,
  type JsonValue,
} from "../src/results.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content[0]?.text ?? "";
}

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
