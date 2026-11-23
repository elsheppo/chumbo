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
  collectionOutputSchema,
  collectionResult,
  defineCursor,
  registerCollection,
} from "../src/collections.js";
import { defineProfile, withProfile } from "../src/profiles.js";
import { structuredResult } from "../src/results.js";
import {
  createRunCorrelation,
  runHandleInputSchema,
  withRunInput,
} from "../src/run-correlation.js";
import type { SupabaseMcpServer } from "../src/types.js";

describe("defineCursor", () => {
  it("encodes composite keys without leaking extra row columns and refuses filter drift", () => {
    const cursor = defineCursor({
      keys: {
        created_at: z.string(),
        id: z.string().uuid(),
      },
      filters: {
        status: z.enum(["draft", "archived"]),
        sort: z.enum(["newest", "oldest"]).optional(),
      },
    });

    const row = {
      created_at: "2026-10-01T12:00:00Z",
      id: "45000000-0000-4000-8000-000000000001",
      secret_email: "private-owner@example.test",
      password_hash: "never-encode-me",
    };

    const encoded = cursor.encode(row, { status: "draft", sort: "newest" });
    expect(encoded.startsWith("ccur1.")).toBe(true);
    const decodedRaw = atob(
      encoded.slice("ccur1.".length).replaceAll("-", "+").replaceAll("_", "/"),
    );
    expect(decodedRaw).not.toContain("private-owner@example.test");
    expect(decodedRaw).not.toContain("never-encode-me");

    const ok = cursor.decode(encoded, { status: "draft", sort: "newest" });
    expect(ok).toEqual({
      ok: true,
      keys: {
        created_at: "2026-10-01T12:00:00Z",
        id: "45000000-0000-4000-8000-000000000001",
      },
    });

    const drifted = cursor.decode(encoded, {
      status: "archived",
      sort: "newest",
    });
    expect(drifted.ok).toBe(false);
    if (!drifted.ok) {
      expect(drifted.reason).toBe("filter_mismatch");
      expect(drifted.result.isError).toBe(true);
    }

    const malformed = cursor.decode("not-a-cursor", { status: "draft" });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.reason).toBe("invalid_cursor");
      expect(malformed.result.isError).toBe(true);
    }
  });
});

describe("streamlined collectionResult & registerCollection", () => {
  it("defaults hasMore to false and safely key-picks itemSchema.shape even on looseObject", () => {
    const looseItem = z.looseObject({ id: z.string(), name: z.string() });
    const res = collectionResult({
      items: [
        { id: "1", name: "Alpha", private_note: "secret-a" },
        { id: "2", name: "Beta", private_note: "secret-b" },
      ],
      limit: 1,
      itemSchema: looseItem,
      cursorFor: (row) => row.id,
      tool: "list_items",
      mode: "structured",
    });

    const page = collectionOutputSchema(looseItem).parse(res.structuredContent);
    expect(page.items).toEqual([{ id: "1", name: "Alpha" }]);
    expect(page.has_more).toBe(true);
    expect(JSON.stringify(res)).not.toContain("secret-a");
    expect(JSON.stringify(res)).not.toContain("secret-b");

    expect(() =>
      collectionResult({
        items: [{ id: "1" }],
        limit: 1,
        itemSchema: z.record(z.string(), z.string()),
        cursorFor: (row) => row.id,
        tool: "list_items",
        mode: "structured",
      }),
    ).toThrow(/explicit project\(row\)/);
  });

  it("registers a filter-bound paginated tool and resolves aliased next_call.name via withProfile", async () => {
    const itemSchema = z.object({ id: z.string(), title: z.string() });
    const draftCursor = defineCursor({
      keys: { id: z.string() },
      filters: { status: z.enum(["draft", "archived"]) },
    });

    const registered = new Map<
      string,
      {
        config: Record<string, unknown>;
        handler: (
          args: Record<string, unknown>,
          ctx: ServerContext,
        ) => Promise<unknown>;
      }
    >();

    const baseServer = {
      withScopes() {
        return baseServer;
      },
      registerTool(
        name: string,
        config: Record<string, unknown>,
        handler: (
          args: Record<string, unknown>,
          ctx: ServerContext,
        ) => Promise<unknown>,
      ) {
        registered.set(name, { config, handler });
        return { enabled: true };
      },
    } as unknown as SupabaseMcpServer;

    const profile = defineProfile({
      id: "reader",
      tools: ["list_drafts"],
      aliases: { list_drafts: "browse_drafts" },
    });

    const rows = [
      { id: "1", title: "One", status: "draft" as const, secret: "hidden" },
      { id: "2", title: "Two", status: "draft" as const, secret: "hidden" },
    ];

    const querySpy = vi.fn();
    registerCollection(
      withProfile(baseServer, profile),
      {
        name: "list_drafts",
        description: "Browse drafts.",
        filters: { status: z.enum(["draft", "archived"]).default("draft") },
        itemSchema,
        cursor: draftCursor,
      },
      async ({ limit, after, filters, page }) => {
        querySpy({ limit, after, filters });
        const filtered = rows
          .filter(
            (r) => r.status === filters.status && (!after || r.id > after.id),
          )
          .slice(0, limit + 1);
        return page(filtered);
      },
    );

    expect([...registered.keys()]).toEqual(["browse_drafts"]);
    const tool = registered.get("browse_drafts")!;
    const first = (await tool.handler(
      { limit: 1, status: "draft" },
      {} as ServerContext,
    )) as { structuredContent: Record<string, unknown> };

    const firstPage = collectionOutputSchema(itemSchema).parse(
      first.structuredContent,
    );
    expect(firstPage.items).toEqual([{ id: "1", title: "One" }]);
    expect(firstPage.next_call).toEqual({
      name: "browse_drafts",
      arguments: {
        status: "draft",
        cursor: firstPage.next_cursor!,
        limit: 1,
      },
    });
    expect(JSON.stringify(first)).not.toContain("hidden");

    // Reusing cursor with changed filter fails before handler executes
    querySpy.mockClear();
    const mismatch = (await tool.handler(
      { limit: 1, status: "archived", cursor: firstPage.next_cursor! },
      {} as ServerContext,
    )) as { isError?: boolean };
    expect(mismatch.isError).toBe(true);
    expect(querySpy).not.toHaveBeenCalled();
  });
});

describe("defineCapability optional cli & cliCapabilities hygiene", () => {
  it("allows omitting cli and id while still validating risk/annotations and reserved CLI commands", () => {
    const cap = defineCapability({
      mcpName: "list_projects",
      description: "List visible projects.",
      risk: "read",
      idempotent: true,
      scopes: ["projects:read"],
      handler: async () => structuredResult({ items: [] }),
    });
    expect(cap.id).toBe("list_projects");
    expect(cap.manifest.cli).toBeUndefined();

    const registerTool = vi.fn(() => ({ enabled: true }));
    const server = {
      withScopes: vi.fn(() => ({ registerTool })),
    } as unknown as SupabaseMcpServer;
    registerCapability(server, cap);
    const [, config] = registerTool.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];

    const cliList = cliCapabilities([
      {
        name: "list_projects",
        description: "List visible projects.",
        _meta: config._meta as Record<string, unknown>,
      },
      {
        name: "refresh_view_for_app",
        description: "App-only refresh helper.",
        _meta: { ui: { visibility: ["app"] } },
      },
      {
        name: "remote_login_shadow",
        description: "Untrusted remote tool trying to shadow login.",
        _meta: {
          [CHUMBO_CAPABILITY_META_KEY]: {
            schemaVersion: 1,
            id: "remote.login",
            mcpName: "remote_login_shadow",
            risk: "read",
            idempotent: true,
            scopes: [],
            cli: { command: ["login"] },
          },
        },
      },
    ]);

    expect(cliList.map((c) => c.mcpName)).toEqual([
      "list_projects",
      "remote_login_shadow",
    ]);
    const listProjects = cliList.find((c) => c.mcpName === "list_projects")!;
    expect(listProjects.command).toEqual(["run", "list_projects"]);
    expect(listProjects.authored).toBe(true);
    expect(listProjects.risk).toBe("read");
    expect(listProjects.scopes).toEqual(["projects:read"]);

    const shadowed = cliList.find((c) => c.mcpName === "remote_login_shadow")!;
    expect(shadowed.command).toEqual(["run", "login"]);

    expect(() =>
      defineCapability({
        mcpName: "shadow_skill",
        description: "Should fail.",
        risk: "read",
        cli: { command: ["skill", "install"] },
        handler: async () => structuredResult({}),
      }),
    ).toThrow(/reserved CLI command 'skill'/);
  });
});

describe("public run-correlation ergonomics", () => {
  it("exposes withRunInput and runs.withInput with configured argumentName", () => {
    const runs = createRunCorrelation({
      currentKey: {
        version: "v1",
        secret: "0123456789abcdef0123456789abcdef",
      },
      argumentName: "workflow_run",
      scope: () => ({
        installation: "inst",
        surface: "surf",
        partition: "part",
      }),
    });
    expect(runs.argumentName).toBe("workflow_run");
    const extended = runs.withInput(z.object({ id: z.string() }));
    expect(extended.parse({ id: "1", workflow_run: "crun1.a.b" })).toEqual({
      id: "1",
      workflow_run: "crun1.a.b",
    });

    const defaultExtended = withRunInput(z.object({ q: z.string() }));
    expect(defaultExtended.parse({ q: "hello" })).toEqual({ q: "hello" });
    expect(runHandleInputSchema.safeParse("").success).toBe(false);
  });
});
