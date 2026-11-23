import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  collectionOutputSchema,
  collectionResult,
} from "../src/collections.js";
import {
  composeResultContent,
  errorResult,
  fromSupabaseError,
  guidanceFields,
  guidedResult,
  openJsonSchema,
  openOutputSchema,
  renderGuidedResult,
  resourceResult,
  resultGuidanceSchema,
  structuredResult,
  textResult,
  withResultGuidance,
} from "../src/results.js";
import type { SupabaseMcpClientContext } from "../src/types.js";

function clientWithResourceLinks(
  resourceLinks: "supported" | "unsupported" | "unknown",
): SupabaseMcpClientContext {
  return Object.freeze({
    era: "modern",
    protocolVersion: "2026-07-28",
    info: { name: "test-host", version: "1.0.0" },
    capabilities: {},
    supports: {
      elicitationForm: false,
      elicitationUrl: false,
      mcpAppsUi: false,
      sampling: false,
      roots: false,
      resourceLinks,
    },
  });
}

describe("dual-lane guided results", () => {
  it("emits guidance in both text footer and leading keys of structuredContent", () => {
    const res = guidedResult(
      "Updated draft d1.",
      { id: "d1", revision: 3, next: "stale-value" },
      {
        warnings: [
          "Published copies are unchanged.",
          "Published copies are unchanged.",
          false,
          null,
          "   ",
          "Re-run checks.",
        ],
        next: "Call publish_draft with id d1.",
      },
    );

    expect(res.content).toEqual([
      {
        type: "text",
        text: [
          "Updated draft d1.",
          "Warning: Published copies are unchanged.",
          "Warning: Re-run checks.",
          "Call publish_draft with id d1.",
        ].join("\n"),
      },
    ]);

    const wireJson = JSON.parse(
      JSON.stringify(res.structuredContent),
    ) as Record<string, unknown>;
    expect(Object.keys(wireJson).slice(0, 2)).toEqual(["next", "warnings"]);
    expect(wireJson).toEqual({
      next: "Call publish_draft with id d1.",
      warnings: ["Published copies are unchanged.", "Re-run checks."],
      id: "d1",
      revision: 3,
    });
    expect(resultGuidanceSchema.parse(wireJson)).toEqual({
      next: "Call publish_draft with id d1.",
      warnings: ["Published copies are unchanged.", "Re-run checks."],
    });
  });

  it("omits guidance keys and lines when empty", () => {
    expect(guidanceFields({ next: "", warnings: [null, false, "  "] })).toEqual(
      {},
    );
    const res = guidedResult("All clear.", { ok: true }, { next: false });
    expect(res.content).toEqual([{ type: "text", text: "All clear." }]);
    expect(res.structuredContent).toEqual({ ok: true });
    expect(
      Object.keys(res.structuredContent as Record<string, unknown>),
    ).toEqual(["ok"]);
  });

  it("renders text from merged guidance in renderGuidedResult and leads withResultGuidance schema", () => {
    const schema = withResultGuidance(
      z.object({ id: z.string(), status: z.literal("queued") }),
    );
    const jsonSchema = z.toJSONSchema(schema, { io: "output" }) as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(jsonSchema.properties).slice(0, 2)).toEqual([
      "next",
      "warnings",
    ]);

    const res = renderGuidedResult(
      { id: "j1", status: "queued" as const },
      { next: "Poll get_job(j1)." },
      (val) => `Job ${val.id}: ${val.status}. ${val.next ?? ""}`.trim(),
    );
    expect(res.content).toEqual([
      { type: "text", text: "Job j1: queued. Poll get_job(j1)." },
    ]);
    expect(
      Object.keys(res.structuredContent as Record<string, unknown>)[0],
    ).toBe("next");
  });

  it("composes dual-lane guidance via composeResultContent and enforces collection budgets", () => {
    const base = guidedResult("Initial", { id: "1" }, { warnings: ["First"] });
    const composed = composeResultContent(base, {
      guidance: {
        warnings: ["First", "Second"],
        next: "Call next_tool.",
      },
    });
    expect(composed.structuredContent).toEqual({
      next: "Call next_tool.",
      warnings: ["First", "Second"],
      id: "1",
    });
    expect(
      Object.keys(composed.structuredContent as Record<string, unknown>).slice(
        0,
        2,
      ),
    ).toEqual(["next", "warnings"]);

    const itemSchema = z.object({ id: z.string(), label: z.string() });
    const paged = collectionResult({
      items: [
        { id: "1", label: "a".repeat(120) },
        { id: "2", label: "b".repeat(120) },
        { id: "3", label: "c".repeat(120) },
      ],
      limit: 3,
      itemSchema,
      cursorFor: (r) => r.id,
      tool: "list_items",
      mode: "structured",
      maxBytes: 700,
      guidance: {
        warnings: ["Legacy tag spelling reused."],
        next: "Pass id to get_item.",
      },
    });
    const parsed = collectionOutputSchema(itemSchema).parse(
      paged.structuredContent,
    );
    expect(parsed.next).toBe("Pass id to get_item.");
    expect(parsed.warnings).toEqual(["Legacy tag spelling reused."]);
    expect(
      new TextEncoder().encode(JSON.stringify(paged)).byteLength,
    ).toBeLessThanOrEqual(700);
    expect(() =>
      composeResultContent(paged, {
        guidance: { next: "x".repeat(600) },
      }),
    ).toThrow(/budget/);
  });
});

describe("openOutputSchema", () => {
  it("strips additionalProperties: false on advertised output JSON Schema while keeping input and validation strict", () => {
    const rawShape = {
      id: z.string(),
      default: z.object({ nested: z.string() }),
    };
    const openedFromShape = openOutputSchema(rawShape) as {
      "~standard": {
        jsonSchema: {
          input: (o: { target: "draft-2020-12" }) => Record<string, unknown>;
          output: (o: { target: "draft-2020-12" }) => Record<string, unknown>;
        };
        validate: (v: unknown) => { issues?: unknown[] };
      };
    };

    const outputJson = openedFromShape["~standard"].jsonSchema.output({
      target: "draft-2020-12",
    });
    expect(outputJson.additionalProperties).toBeUndefined();
    const props = outputJson.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.default?.additionalProperties).toBeUndefined();
    expect(
      openJsonSchema({ type: "object", additionalProperties: false }),
    ).toEqual({
      type: "object",
    });

    const strictSchema = z.object({ id: z.string() }).strict();
    const openedStrict = openOutputSchema(strictSchema);
    const outSchema = openedStrict["~standard"].jsonSchema.output({
      target: "draft-2020-12",
    });
    const inSchema = openedStrict["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    });
    expect(outSchema.additionalProperties).toBeUndefined();
    expect(inSchema.additionalProperties).toBe(false);
    const badResult = openedStrict["~standard"].validate({
      id: "1",
      extra: true,
    });
    expect("issues" in badResult && badResult.issues).toBeTruthy();
  });
});

describe("resourceResult fallback options", () => {
  const link = {
    type: "resource_link" as const,
    uri: "app://docs/1",
    name: "doc-1",
  };

  it("rejects empty reading card text", () => {
    expect(() => resourceResult("   ", link)).toThrow(/non-empty reading card/);
  });

  it("appends fallback tool hint unless client supports resourceLinks, and inlineExcerpt only when unsupported", () => {
    const unknown = resourceResult("Summary card.", link, {
      client: clientWithResourceLinks("unknown"),
      fallbackTool: { name: "read_doc", arguments: { id: "1" } },
      inlineExcerpt: "First paragraph excerpt.",
    });
    const unknownText = (unknown.content[0] as { text: string }).text;
    expect(unknownText).toContain('call read_doc({"id":"1"})');
    expect(unknownText).not.toContain("First paragraph excerpt.");

    const unsupported = resourceResult("Summary card.", link, {
      client: clientWithResourceLinks("unsupported"),
      fallbackTool: { name: "read_doc", arguments: { id: "1" } },
      inlineExcerpt: "First paragraph excerpt.",
    });
    const unsupportedText = (unsupported.content[0] as { text: string }).text;
    expect(unsupportedText).toContain('call read_doc({"id":"1"})');
    expect(unsupportedText).toContain("First paragraph excerpt.");

    const supported = resourceResult("Summary card.", link, {
      client: clientWithResourceLinks("supported"),
      fallbackTool: { name: "read_doc", arguments: { id: "1" } },
      inlineExcerpt: "First paragraph excerpt.",
    });
    expect((supported.content[0] as { text: string }).text).toBe(
      "Summary card.",
    );
  });
});

describe("fromSupabaseError", () => {
  it("maps PostgREST/Postgres codes cleanly and distinguishes 0-row vs multi-row PGRST116", () => {
    const notFound = fromSupabaseError(
      {
        code: "PGRST116",
        message: "JSON object requested, multiple (or no) rows returned",
        details: "The result contains 0 rows",
      },
      { notFound: ["Draft not found.", "Call list_drafts."] },
    );
    expect(notFound).toEqual(
      errorResult("Draft not found.", "Call list_drafts."),
    );

    const multiRow = fromSupabaseError(
      {
        code: "PGRST116",
        message: "JSON object requested, multiple (or no) rows returned",
        details: "The result contains 3 rows",
      },
      {
        notFound: "Should not trigger",
        fallback: "Unexpected duplicate rows.",
      },
    );
    expect(multiRow).toEqual(errorResult("Unexpected duplicate rows."));

    const conflict = fromSupabaseError(
      {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "drafts_slug_key"',
      },
      {
        conflict: ({ code, category }) => [
          `Slug conflict (${code}/${category}).`,
          "Pick another slug.",
        ],
      },
    );
    expect(conflict).toEqual(
      errorResult("Slug conflict (23505/conflict).", "Pick another slug."),
    );

    const fk = fromSupabaseError(
      { code: "23503", message: "violates foreign key constraint" },
      {
        foreignKey: {
          message: "Parent project missing.",
          nextStep: "List projects.",
        },
      },
    );
    expect(fk).toEqual(
      errorResult("Parent project missing.", "List projects."),
    );

    const invalid = fromSupabaseError(
      { code: "22P02", message: "invalid input syntax for type uuid" },
      { invalidInput: "Invalid UUID." },
    );
    expect(invalid).toEqual(errorResult("Invalid UUID."));

    const custom = fromSupabaseError(
      { code: "P0001", message: "secret_table_rule failed" },
      { codes: { P0001: "Business rule prevented update." } },
    );
    expect(custom).toEqual(errorResult("Business rule prevented update."));
  });

  it("never leaks SQL, table names, or details on unhandled errors and gates 42501 dev hints strictly", () => {
    const lines: string[] = [];
    const denied = fromSupabaseError(
      {
        code: "42501",
        message: "permission denied for table private_deals\n\x00",
        details: "secret_col=42",
      },
      {},
      { devHint: true, stderr: (line) => lines.push(line) },
    );
    expect(denied.isError).toBe(true);
    const serialized = JSON.stringify(denied);
    expect(serialized).not.toContain("private_deals");
    expect(serialized).not.toContain("secret_col");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      "grant select on table public.private_deals to authenticated;",
    );

    const prodLines: string[] = [];
    fromSupabaseError(
      { code: "42501", message: "permission denied for table private_deals" },
      {},
      { devHint: false, stderr: (line) => prodLines.push(line) },
    );
    expect(prodLines).toEqual([]);

    vi.stubEnv("DENO_DEPLOYMENT_ID", "dep_123");
    vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
    const hostedLines: string[] = [];
    fromSupabaseError(
      { code: "42501", message: "permission denied for table private_deals" },
      {},
      { stderr: (line) => hostedLines.push(line) },
    );
    expect(hostedLines).toEqual([]);
    vi.unstubAllEnvs();
  });

  it("preserves non-error CallToolResult shapes safely as isError: true when returned by custom handler", () => {
    const res = fromSupabaseError(
      { code: "23505", message: "conflict" },
      { conflict: () => structuredResult({ retryable: true }) },
    );
    expect(res.isError).toBe(true);
  });
});
