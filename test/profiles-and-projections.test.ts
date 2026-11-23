import type { ServerContext } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CHUMBO_CAPABILITY_META_KEY,
  defineCapability,
  registerCapability,
} from "../src/capabilities.js";
import { cliCapabilities } from "../src/cli-surface.js";
import {
  projectInputFields,
  registerProjectedCapability,
} from "../src/field-projection.js";
import {
  defineToolVocabulary,
  mapInputSchemaDescriptions,
  scopedGuidance,
  scopedInputSchema,
} from "../src/guidance.js";
import {
  CHUMBO_CANONICAL_TOOL,
  defineProfile,
  defineProfiles,
  withProfile,
} from "../src/profiles.js";
import { structuredResult } from "../src/results.js";
import type { SupabaseMcpContext, SupabaseMcpServer } from "../src/types.js";
import {
  canonicalTerm,
  canonicalTermKey,
  resolveCanonicalVocabulary,
  VocabularyIncompleteError,
} from "../src/vocabulary.js";

function mockContext(scopes: readonly string[]): SupabaseMcpContext {
  const set = new Set(scopes);
  return Object.freeze({
    request: new Request("https://example.test/mcp"),
    supabase: {} as SupabaseMcpContext["supabase"],
    user: null,
    jwtClaims: null,
    principal: {
      subject: "user-1",
      authentication: { mode: "oauth" as const, strategy: "oauth" },
    },
    authentication: { mode: "oauth" as const, strategy: "oauth" },
    subject: "user-1",
    scopes: Object.freeze([...scopes]),
    hasScope: (s: string) => set.has(s),
    hasScopes: (req: readonly string[]) => req.every((s) => set.has(s)),
    traceId: "trace-1",
    client: {
      era: "modern" as const,
      info: null,
      capabilities: null,
      supports: {
        elicitationForm: false,
        elicitationUrl: false,
        mcpAppsUi: false,
        sampling: false,
        roots: false,
        resourceLinks: "unknown" as const,
      },
    },
    sessionId: null,
  });
}

describe("capability profiles & alias presentation", () => {
  it("preserves withProfile across withScopes, rewrites aliased capability _meta, and tags CHUMBO_CANONICAL_TOOL", () => {
    const catalog = defineProfiles(
      {
        reader: {
          tools: ["list_files", "read_document"],
          aliases: {
            read_document: {
              name: "open_doc",
              descriptionPrefix: "Reader view.",
            },
          },
          systemTools: ["send_feedback"],
        },
        admin: {
          tools: ["list_files", "read_document", "edit_document"],
          systemTools: ["send_feedback"],
        },
      },
      {
        references: {
          edit_document: {
            tool: "edit_document",
            unavailable: "document editing (unavailable on this connection)",
          },
        },
      },
    );

    expect(() => catalog.parseId("super-admin")).toThrow(
      /Unknown capability profile/,
    );
    expect(catalog.parseId("reader")).toBe("reader");

    const registered = new Map<string, Record<PropertyKey, unknown>>();
    const disabled = new Set<string>();
    const makeScopedServer = (
      requiredScopes: readonly string[],
    ): SupabaseMcpServer =>
      ({
        withScopes: (more: readonly string[]) =>
          makeScopedServer([...requiredScopes, ...more]),
        registerTool(name: string, config: Record<PropertyKey, unknown>) {
          registered.set(name, config);
          return {
            disable() {
              disabled.add(name);
            },
          };
        },
      }) as unknown as SupabaseMcpServer;

    const profiled = withProfile(makeScopedServer([]), catalog.get("reader"), {
      vocabulary: catalog.vocabulary,
    });

    const readCap = defineCapability({
      mcpName: "read_document",
      description: "Read markdown. Use edit_document to modify.",
      inputSchema: z.object({
        path: z.string().describe("Path from list_files or edit_document."),
      }),
      risk: "read",
      scopes: ["docs:read"],
      handler: async () => structuredResult({ ok: true }),
    });
    const editCap = defineCapability({
      mcpName: "edit_document",
      description: "Edit markdown.",
      risk: "write",
      scopes: ["docs:write"],
      handler: async () => structuredResult({ ok: true }),
    });

    registerCapability(profiled, readCap);
    registerCapability(profiled, editCap);

    // edit_document is outside reader ceiling even though registerCapability called withScopes()
    expect([...registered.keys()]).toEqual(["open_doc"]);
    const openDocConfig = registered.get("open_doc")!;
    expect(openDocConfig[CHUMBO_CANONICAL_TOOL]).toBe("read_document");
    expect(openDocConfig.description).toContain("Reader view.");
    expect(openDocConfig.description).toContain(
      "document editing (unavailable on this connection)",
    );
    expect(openDocConfig.description).not.toContain("edit_document");

    const inputSchema = openDocConfig.inputSchema as {
      "~standard": {
        jsonSchema: {
          input: (o: { target: "draft-2020-12" }) => Record<string, unknown>;
        };
      };
    };
    const inputJson = inputSchema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    }) as { properties: { path: { description: string } } };
    expect(inputJson.properties.path.description).toContain("list_files");
    expect(inputJson.properties.path.description).not.toContain(
      "edit_document",
    );

    // Aliased capability manifest has mcpName & id projected to "open_doc" for cliCapabilities
    const meta = openDocConfig._meta as Record<string, unknown>;
    const manifest = meta[CHUMBO_CAPABILITY_META_KEY] as Record<
      string,
      unknown
    >;
    expect(manifest.mcpName).toBe("open_doc");
    expect(manifest.id).toBe("open_doc");
    const cli = cliCapabilities([
      {
        name: "open_doc",
        description: String(openDocConfig.description),
        _meta: meta,
      },
    ]);
    expect(cli[0]?.authored).toBe(true);
    expect(cli[0]?.risk).toBe("read");
    expect(disabled.size).toBe(0);
  });

  it("rejects colliding aliases and aliases outside the tools ceiling", () => {
    expect(() =>
      defineProfile({
        id: "bad-ceiling",
        tools: ["a"],
        aliases: { b: "x" },
      }),
    ).toThrow(/not in its tools ceiling/);

    expect(() =>
      defineProfile({
        id: "bad-collision",
        tools: ["a", "b"],
        aliases: { a: "same", b: "same" },
      }),
    ).toThrow(/presented tool name 'same'/);
  });
});

describe("scopedGuidance & mapInputSchemaDescriptions", () => {
  it("rewrites single-pass aliases, compound phrases, plain-word syntax, and properties named default/examples", () => {
    const vocab = defineToolVocabulary({
      tools: ["read", "list_files", "edit_document", "a_tool", "b_tool"],
      references: {
        review_recent_files: { tool: "list_files", unavailable: "file list" },
        inspect_file: { tool: "list_files", unavailable: "file list" },
      },
      compoundReferences: {
        "review_recent_files or inspect_file": {
          tool: "list_files",
          unavailable: "previously supplied metadata",
        },
      },
    });

    const aliases = new Map([
      ["a_tool", "b_tool"],
      ["b_tool", "c_tool"],
    ]);
    const mounted = new Set(["list_files", "b_tool", "c_tool"]);
    const text = scopedGuidance(
      "Use review_recent_files or inspect_file, then read the summary or call read(id), a_tool, and edit_document.",
      vocab,
      mounted,
      aliases,
    );
    expect(text).toContain("Use list_files,");
    expect(text).toContain("then read the summary");
    expect(text).toContain("read (unavailable on this connection)(id)");
    expect(text).toContain("b_tool,");
    expect(text).not.toContain("edit_document");

    const schema = {
      default: z.string().describe("Populated from edit_document."),
      examples: z.string().describe("Examples from edit_document."),
      mode: z
        .enum(["edit_document", "other"])
        .describe("Mode from edit_document."),
    };
    const mapped = mapInputSchemaDescriptions(schema, (s) =>
      scopedGuidance(s, vocab, new Set(["list_files"])),
    ) as unknown as {
      "~standard": {
        jsonSchema: {
          input: (o: { target: "draft-2020-12" }) => Record<string, unknown>;
          output: (o: { target: "draft-2020-12" }) => Record<string, unknown>;
        };
      };
    };

    const jsonIn = mapped["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    }) as {
      properties: {
        default: { description: string };
        examples: { description: string };
        mode: { enum: string[]; description: string };
      };
    };
    expect(jsonIn.properties.default.description).not.toContain(
      "edit_document",
    );
    expect(jsonIn.properties.examples.description).not.toContain(
      "edit_document",
    );
    // Enum instance data must stay untouched
    expect(jsonIn.properties.mode.enum).toEqual(["edit_document", "other"]);
    expect(jsonIn.properties.mode.description).not.toContain("edit_document");

    const cachedA = scopedInputSchema(
      z.object({ id: z.string().describe("From edit_document") }),
      vocab,
      new Set(["list_files"]),
    );
    const cachedB = scopedInputSchema(
      z.object({ id: z.string().describe("From edit_document") }),
      vocab,
      new Set(["list_files"]),
    );
    expect(cachedA).not.toBe(cachedB); // distinct source schema objects
  });
});

describe("projectInputFields & registerProjectedCapability", () => {
  const baseSchema = z.object({
    path: z.string(),
    description: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    source_date: z.string().nullable().optional(),
    version_id: z.string().uuid().optional(),
  });

  it("drops when empty, masks unpermitted fields in tools/list, and enforces call-time TOCTOU revocation", async () => {
    const empty = await projectInputFields(mockContext([]), {
      schema: baseSchema,
      alwaysInclude: ["path"],
      fields: {
        description: {
          allow: "files:describe",
          summary: "authored description",
        },
        tags: { allow: "files:tag", summary: "complete tag set" },
        source_date: {
          allow: "files:date",
          summary: "source date",
          companionFields: ["version_id"],
        },
      },
      description: ({ bullets }) => bullets.join("\n"),
    });
    expect(empty).toBeNull();

    let allowTagsNow = true;
    const handlerSpy = vi.fn(async (plan) =>
      structuredResult({ updated: plan.fields }),
    );
    const registered: Array<{
      name: string;
      config: Record<string, unknown>;
      handler: (
        args: Record<string, unknown>,
        ctx: ServerContext,
      ) => Promise<unknown>;
    }> = [];
    const server = {
      withScopes: () => server,
      registerTool(
        name: string,
        config: Record<string, unknown>,
        handler: (
          args: Record<string, unknown>,
          ctx: ServerContext,
        ) => Promise<unknown>,
      ) {
        registered.push({ name, config, handler });
        return { enabled: true };
      },
    } as unknown as SupabaseMcpServer;

    const reg = await registerProjectedCapability(
      server,
      mockContext(["files:tag"]),
      {
        mcpName: "update_file",
        risk: "write",
        schema: baseSchema,
        alwaysInclude: ["path"],
        fields: {
          description: {
            allow: "files:describe",
            summary: "authored description",
          },
          tags: { allow: () => allowTagsNow, summary: "complete tag set" },
          source_date: {
            allow: "files:date",
            summary: "source date",
            companionFields: ["version_id"],
          },
        },
        description: ({ permittedFields, bullets }) =>
          `Update ${permittedFields.join(", ")}\n${bullets.join("\n")}`,
        handler: handlerSpy,
      },
    );

    expect(reg).not.toBeNull();
    expect(registered).toHaveLength(1);
    const tool = registered[0]!;
    expect(
      (tool.config._meta as Record<string, unknown>)[
        CHUMBO_CAPABILITY_META_KEY
      ],
    ).toMatchObject({ mcpName: "update_file", risk: "write" });

    const advertised = (
      tool.config.inputSchema as {
        "~standard": {
          jsonSchema: {
            input: (o: { target: "draft-2020-12" }) => Record<string, unknown>;
          };
          validate: (v: unknown) => { issues?: unknown[] };
        };
      }
    )["~standard"].jsonSchema.input({ target: "draft-2020-12" }) as {
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
    expect(Object.keys(advertised.properties)).toEqual(["path", "tags"]);
    expect(advertised.additionalProperties).toBe(false);

    // Unpermitted field rejected atomically before handler runs
    const refused = (await tool.handler(
      { path: "/a.md", tags: ["ok"], description: "nope" },
      {} as ServerContext,
    )) as { isError?: boolean; content: Array<{ text: string }> };
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain("description");
    expect(refused.content[0]?.text).toContain("Nothing was changed");
    expect(handlerSpy).not.toHaveBeenCalled();

    // Companion field without owner rejected before handler runs
    const orphanCompanion = (await tool.handler(
      {
        path: "/a.md",
        tags: ["ok"],
        version_id: "45000000-0000-4000-8000-000000000001",
      },
      {} as ServerContext,
    )) as { isError?: boolean; content: Array<{ text: string }> };
    expect(orphanCompanion.isError).toBe(true);
    expect(orphanCompanion.content[0]?.text).toContain("version_id");
    expect(handlerSpy).not.toHaveBeenCalled();

    // Permitted call succeeds
    const ok = (await tool.handler(
      { path: "/a.md", tags: ["approved"] },
      {} as ServerContext,
    )) as { isError?: boolean; structuredContent: { updated: string[] } };
    expect(ok.isError).toBeUndefined();
    expect(ok.structuredContent).toEqual({ updated: ["tags"] });
    expect(handlerSpy).toHaveBeenCalledTimes(1);

    // Call-time TOCTOU revocation blocks write immediately
    allowTagsNow = false;
    const revoked = (await tool.handler(
      { path: "/a.md", tags: ["approved"] },
      {} as ServerContext,
    )) as { isError?: boolean };
    expect(revoked.isError).toBe(true);
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  });
});

describe("resolveCanonicalVocabulary", () => {
  it("normalizes NFC and whitespace, reuses legacy spellings across pages, and keeps hyphenated terms distinct", async () => {
    expect(canonicalTerm("  Cafe\u0301   Notes ")).toBe("Café Notes");
    expect(canonicalTermKey("  Cafe\u0301   Notes ")).toBe("café notes");

    const listPage = vi
      .fn()
      .mockResolvedValueOnce({ items: ["case report"], nextCursor: "p2" })
      .mockResolvedValueOnce({ items: ["Case  Study"], nextCursor: null })
      .mockResolvedValue({ items: [], nextCursor: null });

    const resolved = await resolveCanonicalVocabulary({
      values: [
        " CASE STUDY ",
        "case   study",
        "case-study",
        " Cafe\u0301 ",
        "Café",
        "   ",
      ],
      listPage,
    });

    expect(resolved).toEqual(["Case  Study", "case-study", "café"]);
    expect(listPage).toHaveBeenCalledWith({ prefix: "case", limit: 50 });
    expect(listPage).toHaveBeenCalledWith({
      prefix: "case",
      cursor: "p2",
      limit: 50,
    });
  });

  it("fails closed with VocabularyIncompleteError on truncated pages or stalled cursors", async () => {
    const truncated = vi
      .fn()
      .mockImplementation(async ({ cursor }: { cursor?: string }) => ({
        items: [],
        nextCursor: `page-${(cursor ? Number(cursor.split("-")[1]) : 0) + 1}`,
      }));

    await expect(
      resolveCanonicalVocabulary({
        values: ["case study"],
        listPage: truncated,
        maxPages: 5,
      }),
    ).rejects.toBeInstanceOf(VocabularyIncompleteError);
    expect(truncated).toHaveBeenCalledTimes(5);

    const stalled = vi
      .fn()
      .mockResolvedValue({ items: [], nextCursor: "same" });
    await expect(
      resolveCanonicalVocabulary({
        values: ["case study"],
        listPage: stalled,
        maxPages: 10,
      }),
    ).rejects.toBeInstanceOf(VocabularyIncompleteError);
    expect(stalled).toHaveBeenCalledTimes(2);
  });
});
