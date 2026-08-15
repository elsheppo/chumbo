import { describe, expect, it } from "vitest";
import {
  errorResult,
  jsonResult,
  renderResult,
  textResult,
  toMarkdown,
} from "../src/results.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content[0]?.text ?? "";
}

describe("toMarkdown", () => {
  it("renders flat objects as bolded key lines", () => {
    expect(toMarkdown({ name: "Film Color", snippet_count: 4 })).toBe(
      "**name**: Film Color\n**snippet_count**: 4",
    );
  });

  it("renders arrays of flat objects as one-line rows", () => {
    const text = toMarkdown({
      blocks: [
        { name: "Lens", snippet_count: 3 },
        { name: "Film Color", snippet_count: 4 },
      ],
    });
    expect(text).toContain("- name: Lens · snippet_count: 3");
    expect(text).toContain("- name: Film Color · snippet_count: 4");
    expect(text).not.toContain("{");
  });

  it("renders scalar arrays as list rows and empties explicitly", () => {
    expect(toMarkdown(["a", "b"])).toBe("- a\n- b");
    expect(toMarkdown({ matches: [] })).toBe("**matches**:\n  - (none)");
    expect(toMarkdown({})).toBe("(none)");
    expect(toMarkdown({ filters: {} })).toBe("**filters**:\n  (none)");
    expect(toMarkdown([{}])).toBe("- (none)");
    expect(toMarkdown("")).toBe("(empty)");
  });

  it("renders null and undefined as an em dash and skips undefined keys", () => {
    expect(toMarkdown({ a: null, b: undefined, c: 1 })).toBe(
      "**a**: —\n**c**: 1",
    );
  });

  it("keeps multiline values attached to their key or list item", () => {
    expect(toMarkdown({ note: "line one\nline two" })).toBe(
      "**note**:\n  line one\n  line two",
    );
    expect(toMarkdown(["line one\nline two"])).toBe("- line one\n  line two");
    expect(toMarkdown([{ note: "line one\nline two" }])).toBe(
      "-\n  **note**:\n    line one\n    line two",
    );
  });
});

describe("jsonResult", () => {
  it("defaults the text lane to markdown, not JSON", () => {
    const result = jsonResult({ ok: true, count: 2 });
    expect(textOf(result)).toBe("**ok**: true\n**count**: 2");
    expect(result.structuredContent).toEqual({ ok: true, count: 2 });
  });

  it("keeps explicit text verbatim for backward compatibility", () => {
    const result = jsonResult({ ok: true }, "Created the Block.");
    expect(textOf(result)).toBe("Created the Block.");
  });

  it("wraps non-object values for structured content", () => {
    expect(jsonResult("plain").structuredContent).toEqual({ value: "plain" });
  });
});

describe("renderResult", () => {
  it("uses the renderer for text and the value for structured content", () => {
    const result = renderResult(
      { name: "Lens" },
      (value) => `## ${value.name}`,
    );
    expect(textOf(result)).toBe("## Lens");
    expect(result.structuredContent).toEqual({ name: "Lens" });
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

describe("textResult", () => {
  it("passes text through", () => {
    expect(textOf(textResult("hello"))).toBe("hello");
  });
});
