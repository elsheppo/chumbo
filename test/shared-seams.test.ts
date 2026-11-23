import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  extractDeniedPostgresObjects,
  formatDevGrantStderrHint,
  normalizeQualifiedSqlIdentifier,
} from "../src/internal/grant-diagnostics.js";
import {
  openJsonSchema,
  openOutputSchema,
} from "../src/internal/open-output-schema.js";
import {
  canonicalJsonValue,
  computeCanonicalSurfaceDigest,
} from "../src/internal/surface-canonical.js";

describe("shared internal runtime seams", () => {
  it("computes deterministic canonical surface digests regardless of key or tool order", async () => {
    const first = await computeCanonicalSurfaceDigest([
      {
        name: "b_tool",
        inputSchema: {
          type: "object",
          properties: { z: { type: "string" }, a: { type: "number" } },
        },
      },
      {
        name: "a_tool",
        inputSchema: { properties: { x: { type: "boolean" } }, type: "object" },
      },
    ]);
    const second = await computeCanonicalSurfaceDigest([
      {
        name: "a_tool",
        inputSchema: { type: "object", properties: { x: { type: "boolean" } } },
      },
      {
        name: "b_tool",
        inputSchema: {
          properties: { a: { type: "number" }, z: { type: "string" } },
          type: "object",
        },
      },
    ]);
    expect(first).not.toBeNull();
    expect(first?.contentDigest).toBe(second?.contentDigest);
    expect(canonicalJsonValue(Number.NaN)).toBeNull();
  });

  it("opens advertised output JSON Schemas while preserving property names and validation", async () => {
    const schema = z.object({
      id: z.string(),
      default: z.object({ label: z.string() }),
    });
    const opened = openOutputSchema(schema);
    const jsonSchema = opened["~standard"].jsonSchema.output({
      target: "draft-2020-12",
    }) as Record<string, unknown>;
    expect(jsonSchema.additionalProperties).toBeUndefined();
    const props = jsonSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.default?.additionalProperties).toBeUndefined();

    const valid = await opened["~standard"].validate({
      id: "1",
      default: { label: "ok" },
    });
    expect("value" in valid).toBe(true);
    expect(
      openJsonSchema({ additionalProperties: false, type: "object" }),
    ).toEqual({
      type: "object",
    });
  });

  it("extracts safe SQL identifiers and strips injection payloads from 42501 grant messages", () => {
    expect(normalizeQualifiedSqlIdentifier('"public"."drafts"')).toEqual({
      schema: "public",
      name: "drafts",
      qualified: "public.drafts",
    });
    expect(
      normalizeQualifiedSqlIdentifier("public.drafts;DROP TABLE users"),
    ).toBeNull();

    const denied = extractDeniedPostgresObjects([
      "permission denied for table public.invoices",
      "permission denied for sequence billing.invoice_seq",
    ]);
    expect(denied).toEqual({
      schemas: ["billing"],
      relations: ["public.invoices"],
      sequences: ["billing.invoice_seq"],
    });
    expect(
      formatDevGrantStderrHint("permission denied for table public.invoices"),
    ).toContain("grant select on table public.invoices to authenticated;");
  });
});
