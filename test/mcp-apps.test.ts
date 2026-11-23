import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  RESOURCE_MIME_TYPE,
  RESOURCE_URI_META_KEY,
} from "@modelcontextprotocol/ext-apps";
import { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCapability } from "../src/capabilities.js";
import {
  assertMcpAppUri,
  buildHubUrl,
  defineMcpApp,
  idempotencyConflictResult,
  injectAppPresentation,
  isMcpAppOnlyTool,
  MCP_APP_MIME_TYPE,
  MCP_APP_PRESENTATION_PLACEHOLDER,
  MCP_APP_PRESENTATION_SCRIPT_ID,
  MCP_APP_RESOURCE_URI_META_KEY,
  McpAppPresentationError,
  mcpAppPresentationOrigins,
  mcpAppResourceMeta,
  mcpAppToolMeta,
  NEUTRAL_APP_PRESENTATION,
  parseAppPresentationEnv,
  registerMcpApp,
  requestIdFieldSchema,
  resolveAppPresentation,
  scriptSafeJson,
  type McpAppCsp,
  type McpAppPermissions,
  type McpAppResourceMeta,
  type McpAppToolMeta,
  type McpAppToolVisibility,
} from "../src/mcp-apps.js";
import { renderResult, structuredResult } from "../src/results.js";
import { createSupabaseMcpInternal } from "../src/runtime.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeDependencies } from "../src/types.js";

function testDependencies(): RuntimeDependencies<any> {
  return {
    async verifyToken() {
      throw new Error("not used in api-key test");
    },
    createClient() {
      return {} as unknown as SupabaseClient;
    },
    createAdminClient() {
      return {} as unknown as SupabaseClient;
    },
    fetch: globalThis.fetch,
    now: () => Date.now(),
    randomUUID: () => crypto.randomUUID(),
  };
}

function mcpPost(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
  token?: string,
): Request {
  const headers = new Headers({
    "content-type": "application/json",
    "mcp-method": method,
    "mcp-protocol-version": "2026-07-28",
  });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (typeof params.name === "string") headers.set("mcp-name", params.name);
  if (typeof params.uri === "string") headers.set("mcp-name", params.uri);
  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "mcp-apps-test",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

describe("SEP-1865 structural & schema parity", () => {
  it("matches @modelcontextprotocol/ext-apps constants, schema.json, and Chumbo capability mcpMeta contracts", async () => {
    expect(MCP_APP_MIME_TYPE).toBe(RESOURCE_MIME_TYPE);
    expect(MCP_APP_RESOURCE_URI_META_KEY).toBe(RESOURCE_URI_META_KEY);

    const extAppsSchema = JSON.parse(
      await readFile(
        fileURLToPath(
          import.meta.resolve("@modelcontextprotocol/ext-apps/schema.json"),
        ),
        "utf8",
      ),
    ) as {
      definitions?: Record<
        string,
        { properties?: Record<string, unknown>; enum?: string[] }
      >;
    };

    const defs = extAppsSchema.definitions ?? {};
    if (defs.McpUiToolVisibility?.enum) {
      const allowedVis: McpAppToolVisibility[] = ["model", "app"];
      expect(defs.McpUiToolVisibility.enum).toEqual(
        expect.arrayContaining(allowedVis),
      );
    }
    if (defs.McpUiResourceCsp?.properties) {
      const csp: Required<McpAppCsp> = {
        connectDomains: ["https://api.example.com"],
        resourceDomains: ["https://cdn.example.com"],
        frameDomains: ["https://embed.example.com"],
        baseUriDomains: ["https://app.example.com"],
      };
      for (const key of Object.keys(csp)) {
        expect(defs.McpUiResourceCsp.properties).toHaveProperty(key);
      }
    }
    if (defs.McpUiResourcePermissions?.properties) {
      const permissions: Required<McpAppPermissions> = {
        camera: {},
        microphone: {},
        geolocation: {},
        clipboardWrite: {},
      };
      for (const key of Object.keys(permissions)) {
        expect(defs.McpUiResourcePermissions.properties).toHaveProperty(key);
      }
    }

    const resourceMeta: McpAppResourceMeta = mcpAppResourceMeta({
      csp: { connectOrigins: ["https://api.example.com"] },
      permissions: { clipboardWrite: {} },
      prefersBorder: true,
    });
    expect(resourceMeta.ui.prefersBorder).toBe(true);

    // Direct assignability to `defineCapability({ mcpMeta })` without casting:
    const toolMeta: McpAppToolMeta = mcpAppToolMeta(
      "ui://acme/review-queue.html",
      ["model"],
    );
    const cap = defineCapability({
      id: "review.open",
      mcpName: "open_review_queue",
      description: "Open review queue.",
      risk: "read",
      cli: { command: ["review", "open"] },
      mcpMeta: toolMeta,
      handler: async () => structuredResult({ ok: true }),
    });
    expect(cap.mcpMeta).toEqual(toolMeta);
  });

  it("keeps src/mcp-apps.ts and src/app.ts free of placeholder duplication and Node/ext-apps cross-imports", async () => {
    const serverSource = await readFile(
      fileURLToPath(new URL("../src/mcp-apps.ts", import.meta.url)),
      "utf8",
    );
    const browserSource = await readFile(
      fileURLToPath(new URL("../src/app.ts", import.meta.url)),
      "utf8",
    );
    const sharedSource = await readFile(
      fileURLToPath(
        new URL("../src/internal/app-presentation-shared.ts", import.meta.url),
      ),
      "utf8",
    );

    expect(serverSource).not.toContain("@modelcontextprotocol/ext-apps");
    expect(serverSource).not.toMatch(/from\s+["']node:/u);
    expect(browserSource).not.toMatch(/from\s+["']zod/u);
    expect(browserSource).not.toMatch(/from\s+["']node:/u);
    expect(browserSource).not.toContain(MCP_APP_PRESENTATION_PLACEHOLDER);
    expect(sharedSource).not.toContain(MCP_APP_PRESENTATION_PLACEHOLDER);
  });
});

describe("URI, CSP, presentation, and XSS safety", () => {
  it("validates canonical ui:// URIs and rejects traversal, queries, hashes, or wrong schemes", () => {
    expect(assertMcpAppUri("ui://supa-mcp/review-queue.html")).toBe(
      "ui://supa-mcp/review-queue.html",
    );
    expect(assertMcpAppUri("ui://acme.ops/views/file-viewer.html")).toBe(
      "ui://acme.ops/views/file-viewer.html",
    );

    for (const invalid of [
      "https://example.com/review.html",
      "ui:///review.html",
      "ui://acme/",
      "ui://acme/review.js",
      "ui://acme/../secret.html",
      "ui://acme/review.html?token=secret",
      "ui://acme/review.html#frag",
      "ui://user:pass@acme/review.html",
    ]) {
      expect(() => assertMcpAppUri(invalid)).toThrow(TypeError);
    }
  });

  it("escapes </script>, HTML comments, ampersands, and JS line terminators in scriptSafeJson and injectAppPresentation", () => {
    const rawPayload = {
      evil: "</script><script>alert('xss')</script><!-- -->&",
      lines: "a\u2028b\u2029c",
    };
    const encoded = scriptSafeJson(rawPayload);
    expect(encoded).not.toContain("<");
    expect(encoded).not.toContain(">");
    expect(encoded).not.toContain("&");
    expect(encoded).not.toContain("\u2028");
    expect(encoded).not.toContain("\u2029");
    expect(JSON.parse(encoded)).toEqual(rawPayload);

    const presentation = resolveAppPresentation({
      productName: "</script><script>window.pwn=1</script>",
      hubUrl: "https://hub.example.com",
      brand: {
        logoUrl: "https://assets.example.com/logo.svg",
        logoDarkUrl: "https://dark-assets.example.com/logo-dark.svg",
        theme: {
          light: {
            background: "#ffffff",
            surface: "#f8faf9",
            border: "#d8ded9",
            text: "#131513",
            textSecondary: "#5d6a63",
          },
          dark: {
            background: "#111412",
            surface: "#1a1f1c",
            border: "#2d3630",
            text: "#f3f6f4",
            textSecondary: "#9aa8a0",
          },
          defaultScheme: "light",
        },
        colors: { accent: "#2f7a4d", accentSoft: "#e6f2eb" },
        fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      },
    });

    const shell = `<!doctype html><html><head><script id="${MCP_APP_PRESENTATION_SCRIPT_ID}" type="application/json">${MCP_APP_PRESENTATION_PLACEHOLDER}</script></head><body></body></html>`;
    const injected = injectAppPresentation(shell, presentation);
    expect(injected).not.toContain("</script><script>");
    expect(injected).not.toContain(MCP_APP_PRESENTATION_PLACEHOLDER);

    const extracted = injected.match(
      /<script id="mcp-app-presentation" type="application\/json">([\s\S]*?)<\/script>/u,
    )?.[1];
    expect(extracted).toBeDefined();
    expect(JSON.parse(extracted!)).toEqual(presentation);

    // Zero placeholders fail in strict "placeholder" mode, pass through in "auto" mode:
    const staticHtml = "<!doctype html><html><body>Static</body></html>";
    expect(() => injectAppPresentation(staticHtml, presentation)).toThrow(
      McpAppPresentationError,
    );
    expect(
      injectAppPresentation(staticHtml, presentation, { mode: "auto" }),
    ).toBe(staticHtml);

    // Duplicate placeholders ALWAYS fail in both modes:
    const duplicateHtml = `${shell}<!-- ${MCP_APP_PRESENTATION_PLACEHOLDER} -->`;
    expect(() => injectAppPresentation(duplicateHtml, presentation)).toThrow(
      McpAppPresentationError,
    );
    expect(() =>
      injectAppPresentation(duplicateHtml, presentation, { mode: "auto" }),
    ).toThrow(McpAppPresentationError);

    // Auto-CSP derivation includes both logo origins and explicit connect/wildcard resource origins:
    expect(mcpAppPresentationOrigins(presentation)).toEqual([
      "https://assets.example.com",
      "https://dark-assets.example.com",
    ]);
    const meta = mcpAppResourceMeta({
      presentation,
      csp: {
        connectOrigins: ["https://delivery.example.com"],
        resourceOrigins: [
          "https://*.cdn.example.com",
          "https://assets.example.com",
        ],
      },
      prefersBorder: false,
    });
    expect(meta).toEqual({
      ui: {
        csp: {
          connectDomains: ["https://delivery.example.com"],
          resourceDomains: [
            "https://*.cdn.example.com",
            "https://assets.example.com",
            "https://dark-assets.example.com",
          ],
        },
        prefersBorder: false,
      },
    });
  });

  it("supports snake_case environment manifests and locks buildHubUrl strictly to hubUrl origin", () => {
    expect(parseAppPresentationEnv(undefined)).toBeUndefined();
    expect(parseAppPresentationEnv("   ")).toBeUndefined();
    expect(() => parseAppPresentationEnv("{not-json")).toThrow(
      McpAppPresentationError,
    );

    const fromSnakeEnv = parseAppPresentationEnv(
      JSON.stringify({
        product_name: "Marketing Hub",
        hub_url: "https://marketing.example.com",
        brand: {
          logo_url: "https://cdn.example.com/brand.png",
          theme: {
            color_scheme: "dark",
            background: "#101211",
            surface: "#181c1a",
            border: "#2c332f",
            text: "#f0f4f1",
            text_secondary: "#a1ada5",
          },
          font_family: "Plus Jakarta Sans, sans-serif",
        },
      }),
    );
    expect(fromSnakeEnv?.productName).toBe("Marketing Hub");
    expect(fromSnakeEnv?.hubUrl).toBe("https://marketing.example.com");
    expect(fromSnakeEnv?.brand?.theme?.dark?.background).toBe("#101211");
    expect(fromSnakeEnv?.brand?.theme?.defaultScheme).toBe("dark");

    // Reject CSS injection in fontFamily or credentials in URLs:
    expect(() =>
      parseAppPresentationEnv(
        JSON.stringify({
          brand: { font_family: "Inter; background: url(https://evil.test)" },
        }),
      ),
    ).toThrow(McpAppPresentationError);
    expect(() =>
      parseAppPresentationEnv(
        JSON.stringify({
          brand: { logo_url: "https://user:secret@cdn.example.com/logo.png" },
        }),
      ),
    ).toThrow(McpAppPresentationError);

    expect(buildHubUrl(NEUTRAL_APP_PRESENTATION, "/sources")).toBeNull();
    expect(
      buildHubUrl(fromSnakeEnv, "/sources", {
        source: "file-123",
        tab: undefined,
      }),
    ).toBe("https://marketing.example.com/sources?source=file-123");

    for (const badPath of [
      "//evil.example.com/steal",
      "https://evil.example.com/steal",
      "javascript:alert(1)",
      "sources/relative",
      "/sources\\..\\evil",
      "/sources\u0000bad",
    ]) {
      expect(() => buildHubUrl(fromSnakeEnv, badPath)).toThrow(TypeError);
    }
  });

  it("classifies app-only tools and provides request_id idempotency helpers", () => {
    expect(
      isMcpAppOnlyTool({
        _meta: mcpAppToolMeta("ui://acme/app.html", ["app"]),
      }),
    ).toBe(true);
    expect(
      isMcpAppOnlyTool({
        _meta: mcpAppToolMeta("ui://acme/app.html", ["model"]),
      }),
    ).toBe(false);
    expect(
      isMcpAppOnlyTool({
        _meta: mcpAppToolMeta("ui://acme/app.html", ["model", "app"]),
      }),
    ).toBe(false);
    expect(isMcpAppOnlyTool({})).toBe(false);

    const id = crypto.randomUUID();
    expect(requestIdFieldSchema.parse(id)).toBe(id);
    const conflict = idempotencyConflictResult("request_id");
    expect(conflict.isError).toBe(true);
    expect(conflict.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("idempotency_conflict:"),
    });
  });
});

describe("defineMcpApp and registerMcpApp protocol & authority enforcement", () => {
  const reviewQueueDef = defineMcpApp({
    name: "review-queue",
    uri: "ui://supa-mcp/review-queue.html",
    title: (p) =>
      p.productName ? `${p.productName} review queue` : "Review queue",
    description: "Interactive review queue.",
    scopes: ["review:read"],
    html: `<!doctype html><html><head><script id="${MCP_APP_PRESENTATION_SCRIPT_ID}" type="application/json">${MCP_APP_PRESENTATION_PLACEHOLDER}</script></head><body>Queue</body></html>`,
  });

  it("enforces explicit scopes on mutating appTools when an app is scoped and fails closed on bare McpServer", () => {
    const bare = new McpServer({ name: "bare", version: "1.0.0" });
    expect(() => registerMcpApp(bare, reviewQueueDef)).toThrow(
      /without withScopes/u,
    );

    const unscopedDef = defineMcpApp({
      name: "viewer",
      uri: "ui://supa-mcp/viewer.html",
      title: "Viewer",
      description: "Unscoped viewer.",
      html: "<!doctype html><html><body>Viewer</body></html>",
    });
    const unscopedUi = registerMcpApp(bare, unscopedDef);
    expect(unscopedUi.uri).toBe("ui://supa-mcp/viewer.html");

    // On a scoped app, omitting `scopes` on a mutating `appTool` throws immediately:
    const fakeScopedServer = new Proxy(bare, {
      get(target, prop) {
        if (prop === "withScopes") return () => fakeScopedServer;
        const val = Reflect.get(target, prop, target);
        return typeof val === "function" ? val.bind(target) : val;
      },
    });
    const ui = registerMcpApp(fakeScopedServer as never, reviewQueueDef);
    expect(() =>
      ui.appTool(
        "decide_item",
        {
          description: "Approve or reject item.",
          risk: "write",
        },
        async () => structuredResult({ ok: true }),
      ),
    ).toThrow(/must declare explicit scopes/u);
  });

  it("serves dual resource _meta, injects presentation per-read, and enforces scope isolation across personas", async () => {
    const endpoint = "https://example.test/functions/v1/mcp";
    const presentation = resolveAppPresentation({
      productName: "Acme Hub",
      hubUrl: "https://acme.example.com",
      brand: { logoUrl: "https://cdn.acme.example.com/mark.svg" },
    });

    const mcp = createSupabaseMcpInternal(
      {
        server: { name: "review-server", version: "0.14.0" },
        resourceUrl: endpoint,
        auth: {
          mode: "api-key",
          async verify({ token }) {
            if (token === "contributor-key") {
              return { subject: "contributor-1", scopes: ["review:flag"] };
            }
            if (token === "reader-key") {
              return { subject: "reader-1", scopes: ["review:read"] };
            }
            if (token === "admin-key") {
              return {
                subject: "admin-1",
                scopes: ["review:read", "review:decide"],
              };
            }
            return null;
          },
        },
        register(server) {
          const ui = registerMcpApp(server, reviewQueueDef, { presentation });

          ui.openTool(
            "open_review_queue",
            {
              title: "Open review queue",
              description: "Open the review queue.",
              inputSchema: z.object({}),
              outputSchema: z.object({ pendingCount: z.number() }),
            },
            async () =>
              renderResult(
                { pendingCount: 2 },
                (q) => `${q.pendingCount} pending`,
              ),
          );

          ui.appTool(
            "refresh_review_queue",
            {
              title: "Refresh queue",
              description: "Refresh queue data.",
              risk: "read",
              inputSchema: z.object({}),
              outputSchema: z.object({ pendingCount: z.number() }),
            },
            async () => structuredResult({ pendingCount: 2 }),
          );

          ui.appTool(
            "decide_review_item",
            {
              title: "Decide item",
              description: "Resolve one item.",
              scopes: ["review:decide"],
              risk: "destructive",
              idempotent: true,
              inputSchema: z.object({
                id: z.string(),
                request_id: requestIdFieldSchema,
              }),
              outputSchema: z.object({ outcome: z.literal("applied") }),
            },
            async () => structuredResult({ outcome: "applied" as const }),
          );
        },
      },
      testDependencies(),
    );

    // 1. Contributor without `review:read` sees neither the tools nor the `ui://` Resource:
    const contributorTools = await (
      await mcp.fetch(mcpPost(endpoint, "tools/list", {}, "contributor-key"))
    ).json();
    expect(contributorTools.result.tools).toEqual([]);

    const contributorResources = await (
      await mcp.fetch(
        mcpPost(endpoint, "resources/list", {}, "contributor-key"),
      )
    ).json();
    expect(contributorResources.result.resources).toEqual([]);

    const deniedRead = await (
      await mcp.fetch(
        mcpPost(
          endpoint,
          "resources/read",
          { uri: "ui://supa-mcp/review-queue.html" },
          "contributor-key",
        ),
      )
    ).json();
    expect(deniedRead.error).toBeDefined();

    // 2. Reader with `review:read` sees `open_review_queue` + `refresh_review_queue`, NOT `decide_review_item`:
    const readerTools = await (
      await mcp.fetch(mcpPost(endpoint, "tools/list", {}, "reader-key"))
    ).json();
    expect(
      readerTools.result.tools.map((t: { name: string }) => t.name),
    ).toEqual(["open_review_queue", "refresh_review_queue"]);

    const deniedDecide = await (
      await mcp.fetch(
        mcpPost(
          endpoint,
          "tools/call",
          {
            name: "decide_review_item",
            arguments: { id: "1", request_id: crypto.randomUUID() },
          },
          "reader-key",
        ),
      )
    ).json();
    expect(deniedDecide.error ?? deniedDecide.result?.isError).toBeTruthy();

    // 3. Admin sees all 3 tools with exact nested + legacy metadata, and reads injected HTML + auto-CSP:
    const adminTools = await (
      await mcp.fetch(mcpPost(endpoint, "tools/list", {}, "admin-key"))
    ).json();
    const byName = new Map<string, Record<string, unknown>>(
      adminTools.result.tools.map((tool: { name: string }) => [
        tool.name,
        tool,
      ]),
    );
    expect(byName.get("open_review_queue")?._meta).toEqual({
      ui: {
        resourceUri: "ui://supa-mcp/review-queue.html",
        visibility: ["model"],
      },
      [MCP_APP_RESOURCE_URI_META_KEY]: "ui://supa-mcp/review-queue.html",
    });
    expect(byName.get("decide_review_item")?._meta).toEqual({
      ui: {
        resourceUri: "ui://supa-mcp/review-queue.html",
        visibility: ["app"],
      },
      [MCP_APP_RESOURCE_URI_META_KEY]: "ui://supa-mcp/review-queue.html",
    });
    expect(byName.get("decide_review_item")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });

    const expectedResourceMeta = {
      ui: {
        csp: {
          resourceDomains: ["https://cdn.acme.example.com"],
        },
        prefersBorder: true,
      },
    };

    const listedResources = await (
      await mcp.fetch(mcpPost(endpoint, "resources/list", {}, "admin-key"))
    ).json();
    expect(listedResources.result.resources).toHaveLength(1);
    expect(listedResources.result.resources[0]).toMatchObject({
      name: "review-queue",
      uri: "ui://supa-mcp/review-queue.html",
      title: "Acme Hub review queue",
      mimeType: MCP_APP_MIME_TYPE,
      _meta: expectedResourceMeta,
    });

    const readRes = await (
      await mcp.fetch(
        mcpPost(
          endpoint,
          "resources/read",
          { uri: "ui://supa-mcp/review-queue.html" },
          "admin-key",
        ),
      )
    ).json();
    const contentItem = readRes.result.contents[0];
    expect(contentItem.mimeType).toBe(MCP_APP_MIME_TYPE);
    expect(contentItem._meta).toEqual(expectedResourceMeta);
    expect(contentItem.text).toContain('"productName":"Acme Hub"');
    expect(contentItem.text).not.toContain(MCP_APP_PRESENTATION_PLACEHOLDER);
  });
});
