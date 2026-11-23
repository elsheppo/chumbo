import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createSupabaseMcp } from "../src/index.js";
import type { SupabaseMcpSurfaceProof } from "../src/types.js";
import {
  buildLockedSurfaceEntry,
  diffSurfaceSnapshots,
  surfaceLockKey,
  type McpSurfaceLockfileV1,
} from "../src/surface-diff.js";

describe("surface-diff and mcp-surface.lock.json parity", () => {
  it("produces bit-for-bit identical contentDigest to runtime onSurface", async () => {
    let observedProof: SupabaseMcpSurfaceProof | undefined;
    const app = createSupabaseMcp({
      server: { name: "digest-parity-server", version: "1.0.0" },
      resourceUrl: "https://example.test/functions/v1/mcp",
      auth: { mode: "api-key", key: "parity-test-key" },
      supabase: {
        env: {
          url: "https://example.supabase.co",
          publishableKeys: { default: "parity-publishable-key" },
        },
      },
      register(server) {
        server.registerTool(
          "list_notes",
          {
            title: "List notes",
            description: "List compact note summaries for the caller.",
            inputSchema: z.object({
              limit: z.number().int().min(1).max(50).optional(),
              tag: z.string().optional(),
            }),
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
            },
          },
          async () => ({ content: [{ type: "text", text: "ok" }] }),
        );
      },
      onSurface(proof) {
        observedProof = proof;
      },
    });

    const response = await app.fetch(
      new Request("https://example.test/functions/v1/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer parity-test-key",
          "content-type": "application/json",
          "mcp-method": "tools/list",
          "mcp-protocol-version": "2026-07-28",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "list-1",
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": {
                name: "parity-test",
                version: "1.0.0",
              },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { tools: unknown[] };
    };
    expect(observedProof).toBeDefined();

    const locked = await buildLockedSurfaceEntry({
      functionName: "mcp",
      serverName: "digest-parity-server",
      authMode: "api-key",
      tools: body.result.tools,
    });

    expect(locked.contentDigest).toBe(observedProof!.contentDigest);
    expect(surfaceLockKey("mcp")).toBe("mcp");
    expect(surfaceLockKey("mcp", "reader")).toBe("mcp:reader");

    const unchanged = diffSurfaceSnapshots(
      { lockfileVersion: 1, surfaces: { mcp: locked } },
      { lockfileVersion: 1, surfaces: { mcp: locked } },
    );
    expect(unchanged.status).toBe("unchanged");
    expect(unchanged.exitCode).toBe(0);
    expect(unchanged.nextCommand).toBeUndefined();
  });

  it("classifies contravariant input and covariant output breaking changes accurately", async () => {
    const baseline = await buildLockedSurfaceEntry({
      functionName: "mcp",
      serverName: "demo",
      tools: [
        {
          name: "search_records",
          description: "Search records with filters.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: ["string", "null"], maxLength: 200 },
              status: { type: "string", enum: ["open", "archived"] },
              score: { type: "number", minimum: 0 },
              legacyFilter: { type: "string" },
            },
          },
          outputSchema: {
            type: "object",
            required: ["items", "total"],
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "state"],
                  properties: {
                    id: { type: "string" },
                    state: { type: "string", enum: ["open", "archived"] },
                  },
                },
              },
              total: { type: "integer" },
            },
          },
          annotations: { readOnlyHint: true },
        },
        {
          name: "legacy_tool",
          description: "Will be removed in candidate.",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
      ],
    });

    const candidate = await buildLockedSurfaceEntry({
      functionName: "mcp",
      serverName: "demo",
      tools: [
        {
          name: "search_records",
          description: "Search records with stricter inputs and wider outputs.",
          inputSchema: {
            type: "object",
            required: ["tenant_id"],
            properties: {
              tenant_id: { type: "string" },
              query: { type: "string", maxLength: 100, pattern: "^[a-z]+$" },
              status: { type: "string", enum: ["open"] },
              score: { type: "integer", minimum: 10 },
            },
          },
          outputSchema: {
            type: "object",
            required: ["items"],
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  required: ["state"],
                  properties: {
                    state: {
                      type: "string",
                      enum: ["open", "archived", "pending"],
                    },
                  },
                },
              },
              total: { type: "number" },
            },
          },
          annotations: { readOnlyHint: true },
        },
      ],
    });

    const report = diffSurfaceSnapshots({ mcp: baseline }, { mcp: candidate });
    expect(report.status).toBe("policy_failed");
    expect(report.exitCode).toBe(2);

    const codes = new Set(
      report.surfaces[0]!.findings.filter((f) => f.category === "breaking").map(
        (f) => f.code,
      ),
    );
    expect(codes).toContain("tool-removed");
    expect(codes).toContain("input-required-added");
    expect(codes).toContain("input-property-removed");
    expect(codes).toContain("input-type-narrowed");
    expect(codes).toContain("input-enum-narrowed");
    expect(codes).toContain("input-bounds-tightened");
    expect(codes).toContain("output-property-removed");
    expect(codes).toContain("output-type-widened");
  });

  it("flags outputSchema removal and profile surface removal as breaking", async () => {
    const reader = await buildLockedSurfaceEntry({
      functionName: "mcp",
      profile: "reader",
      serverName: "demo",
      tools: [
        {
          name: "get_note",
          description: "Read one note.",
          inputSchema: { type: "object", properties: {} },
          outputSchema: {
            type: "object",
            properties: { title: { type: "string" } },
          },
          annotations: { readOnlyHint: true },
        },
      ],
    });
    const admin = await buildLockedSurfaceEntry({
      functionName: "mcp",
      profile: "admin",
      serverName: "demo",
      tools: [],
    });
    const readerWithoutOutput = await buildLockedSurfaceEntry({
      functionName: "mcp",
      profile: "reader",
      serverName: "demo",
      tools: [
        {
          name: "get_note",
          description: "Read one note.",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
      ],
    });

    const baseLock: McpSurfaceLockfileV1 = {
      lockfileVersion: 1,
      surfaces: { "mcp:reader": reader, "mcp:admin": admin },
    };
    const candLock: McpSurfaceLockfileV1 = {
      lockfileVersion: 1,
      surfaces: { "mcp:reader": readerWithoutOutput },
    };

    const report = diffSurfaceSnapshots(baseLock, candLock);
    expect(report.exitCode).toBe(2);
    const allCodes = report.surfaces.flatMap((s) =>
      s.findings.map((f) => f.code),
    );
    expect(allCodes).toContain("output-schema-removed");
    expect(allCodes).toContain("surface-removed");
  });

  it("detects every authority-widening vector (annotations, scopes, anon exposure, UI visibility)", async () => {
    const baseline = await buildLockedSurfaceEntry({
      functionName: "mcp",
      serverName: "demo",
      authMode: "oauth",
      tools: [
        {
          name: "read_flag",
          description: "Read review flag.",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
        {
          name: "purge_flag",
          description: "Delete review flag.",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: false, destructiveHint: true },
          _meta: {
            "dev.chumbo/capability": {
              risk: "destructive",
              scopes: ["flags:read", "flags:admin"],
            },
          },
        },
        {
          name: "decide_in_ui",
          description: "UI-only decision helper.",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: false, destructiveHint: false },
          _meta: {
            ui: {
              resourceUri: "ui://review/queue.html",
              visibility: ["app"],
            },
          },
        },
      ],
    });

    const candidate = await buildLockedSurfaceEntry({
      functionName: "mcp",
      serverName: "demo",
      authMode: "public",
      tools: [
        {
          name: "read_flag",
          description: "Mutate review flag now.",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: false },
        },
        {
          name: "purge_flag",
          description: "Delete review flag silently.",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: false, destructiveHint: false },
          _meta: {
            "dev.chumbo/capability": {
              risk: "write",
              scopes: ["flags:read"],
            },
          },
        },
        {
          name: "decide_in_ui",
          description: "Now visible to model too.",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: false, destructiveHint: false },
          _meta: {
            ui: {
              resourceUri: "ui://review/queue.html",
              visibility: ["app", "model"],
            },
          },
        },
        {
          name: "webhook_blast",
          description: "Sends outbound webhooks.",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: false, openWorldHint: true },
        },
      ],
    });

    const report = diffSurfaceSnapshots({ mcp: baseline }, { mcp: candidate });
    expect(report.status).toBe("policy_failed");
    expect(report.exitCode).toBe(2);

    const authCodes = new Set(
      report.surfaces[0]!.findings.filter(
        (f) => f.category === "authority-widening",
      ).map((f) => f.code),
    );
    expect(authCodes).toContain("surface-anon-opened");
    expect(authCodes).toContain("anon-tool-added");
    expect(authCodes).toContain("read-only-hint-dropped");
    expect(authCodes).toContain("destructive-hint-dropped");
    expect(authCodes).toContain("scope-requirement-widened");
    expect(authCodes).toContain("model-visibility-widened");
    expect(authCodes).toContain("destructive-or-open-world-added");
  });

  it("flags context-regression rules and passes pure additive changes unless --frozen is set", async () => {
    const baseline = await buildLockedSurfaceEntry({
      functionName: "mcp",
      serverName: "demo",
      tools: [
        {
          name: "list_items",
          description: "List items in the workspace.",
          inputSchema: {
            type: "object",
            required: ["workspace_id"],
            properties: {
              workspace_id: { type: "string", description: "Workspace UUID." },
              limit: { type: "integer", description: "Max items." },
            },
          },
          outputSchema: {
            type: "object",
            properties: {
              count: { type: "integer" },
            },
          },
          annotations: { readOnlyHint: true },
        },
      ],
    });

    // Pure additive evolution: optional input added, integer widened to number, output field added, new safe tool added
    const additiveCandidate = await buildLockedSurfaceEntry({
      functionName: "mcp",
      serverName: "demo",
      tools: [
        {
          name: "list_items",
          description: "List items in the workspace with cursor pagination.",
          inputSchema: {
            type: "object",
            required: ["workspace_id"],
            properties: {
              workspace_id: { type: "string", description: "Workspace UUID." },
              limit: { type: "number", description: "Max items." },
              cursor: { type: "string", description: "Pagination cursor." },
            },
          },
          outputSchema: {
            type: "object",
            properties: {
              count: { type: "integer" },
              nextCursor: { type: "string" },
            },
          },
          annotations: { readOnlyHint: true },
        },
        {
          name: "get_item",
          description: "Read one item by ID.",
          inputSchema: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string", description: "Item ID." } },
          },
          annotations: { readOnlyHint: true },
        },
      ],
    });

    const compatible = diffSurfaceSnapshots(
      { mcp: baseline },
      { mcp: additiveCandidate },
    );
    expect(compatible.status).toBe("compatible");
    expect(compatible.exitCode).toBe(0);
    expect(compatible.summary.breaking).toBe(0);
    expect(compatible.summary.authorityWidening).toBe(0);
    expect(compatible.summary.contextRegression).toBe(0);
    expect(compatible.summary.additive).toBeGreaterThan(0);
    expect(compatible.nextCommand).toBe("npx chumbo surface snapshot --yes");

    // With --frozen, additive drift fails with exit code 2
    const frozen = diffSurfaceSnapshots(
      { mcp: baseline },
      { mcp: additiveCandidate },
      { frozen: true },
    );
    expect(frozen.status).toBe("policy_failed");
    expect(frozen.exitCode).toBe(2);

    // Context reduction emits context-reduced when prose is trimmed safely
    const trimmedCandidate = await buildLockedSurfaceEntry({
      functionName: "mcp",
      serverName: "demo",
      tools: [
        {
          name: "list_items",
          description: "List items.",
          inputSchema: {
            type: "object",
            required: ["workspace_id"],
            properties: {
              workspace_id: { type: "string" },
              limit: { type: "integer" },
            },
          },
          outputSchema: {
            type: "object",
            properties: {
              count: { type: "integer" },
            },
          },
          annotations: { readOnlyHint: true },
        },
      ],
    });
    const reduced = diffSurfaceSnapshots(
      { mcp: baseline },
      { mcp: trimmedCandidate },
    );
    expect(reduced.status).toBe("compatible");
    expect(reduced.surfaces[0]!.findings.map((f) => f.code)).toContain(
      "context-reduced",
    );

    // Context regression: huge bloated tool exceeds delta, ceiling, and per-tool limit
    const bloatedProps: Record<string, unknown> = {};
    for (let i = 0; i < 60; i += 1) {
      bloatedProps[`bloated_prop_${i}`] = {
        type: "string",
        description:
          "Verbose generated description causing severe cold-start context regression.",
      };
    }
    const bloatedCandidate = await buildLockedSurfaceEntry({
      functionName: "mcp",
      serverName: "demo",
      tools: [
        ...baseline.tools,
        {
          name: "bloated_reader",
          description: "Reads bloated table.",
          inputSchema: { type: "object", properties: bloatedProps },
          annotations: { readOnlyHint: true },
        },
      ],
    });

    const regressed = diffSurfaceSnapshots(
      { mcp: baseline },
      { mcp: bloatedCandidate },
      { maxTokenDelta: 200, maxCatalogTokens: 500 },
    );
    expect(regressed.status).toBe("policy_failed");
    expect(regressed.exitCode).toBe(2);
    const regressionCodes = new Set(
      regressed.surfaces[0]!.findings.filter(
        (f) => f.category === "context-regression",
      ).map((f) => f.code),
    );
    expect(regressionCodes).toContain("tool-schema-bloated");
    expect(regressionCodes).toContain("catalog-token-delta-exceeded");
    expect(regressionCodes).toContain("catalog-token-ceiling-exceeded");
  });
});
