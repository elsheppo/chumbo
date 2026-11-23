import net from "node:net";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  decodeClientSupportMask,
  encodeClientSupportMask,
  resourceLinkFallbackMiddleware,
} from "../src/client-context.js";
import { collectionResult } from "../src/collections.js";
import { serve, type RunningNodeApp } from "../src/node.js";
import { structuredResult, textResult } from "../src/results.js";
import { createSupabaseMcpInternal } from "../src/runtime.js";
import { jsonRpcPayloadFromResponseText } from "../src/transport.js";
import type {
  RuntimeDependencies,
  SupabaseMcpClientContext,
  SupabaseMcpErrorEvent,
  VerifiedSupabaseIdentity,
} from "../src/types.js";

const RESOURCE_URL = "https://example.supabase.co/functions/v1/mcp";
const running: RunningNodeApp[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

function createDeps(): RuntimeDependencies<any> {
  return {
    async verifyToken(token): Promise<VerifiedSupabaseIdentity> {
      if (token === "alice-jwt") {
        return {
          token,
          userClaims: { id: "user-alice", email: "alice@example.com" },
          jwtClaims: {
            sub: "user-alice",
            client_id: "claude-code",
            scope: "docs:read",
            exp: Math.floor(Date.now() / 1000) + 3600,
          },
        };
      }
      throw new Error("invalid token");
    },
    createClient(token) {
      return { token } as unknown as SupabaseClient;
    },
    createAdminClient() {
      return {} as unknown as SupabaseClient;
    },
    async fetch() {
      return Response.json({
        issuer: "https://example.supabase.co/auth/v1",
        authorization_endpoint:
          "https://example.supabase.co/auth/v1/oauth/authorize",
        token_endpoint: "https://example.supabase.co/auth/v1/oauth/token",
        response_types_supported: ["code"],
      });
    },
    randomUUID: () => "11111111-2222-4333-8444-555555555555",
  };
}

describe("transport armor, CORS, ctx.client, and node disconnect propagation", () => {
  it("refuses GET SSE, DELETE, and POST subscriptions/listen immediately while preserving OAuth 401 and metadata", async () => {
    const app = createSupabaseMcpInternal(
      {
        server: { name: "stateless-mcp", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "oauth" },
        register(server) {
          server.registerTool(
            "ping_tool",
            { inputSchema: z.object({}) },
            async () => textResult("pong"),
          );
        },
      },
      createDeps(),
    );

    // 1. OAuth protected-resource metadata stays 200 OK.
    const meta = await app.fetch(
      new Request(`${RESOURCE_URL}/.well-known/oauth-protected-resource`, {
        method: "GET",
      }),
    );
    expect(meta.status).toBe(200);

    // 2. Unauthenticated GET /mcp hits auth gate first -> 401 + WWW-Authenticate exposed.
    const unauthGet = await app.fetch(
      new Request(RESOURCE_URL, {
        method: "GET",
        headers: { accept: "text/event-stream" },
      }),
    );
    expect(unauthGet.status).toBe(401);
    expect(unauthGet.headers.get("www-authenticate")).toContain(
      "resource_metadata=",
    );
    expect(
      unauthGet.headers.get("access-control-expose-headers")?.toLowerCase(),
    ).toContain("www-authenticate");
    expect(
      unauthGet.headers.get("access-control-expose-headers")?.toLowerCase(),
    ).toContain("mcp-session-id");

    // 3. Authenticated GET /mcp SSE probe refuses immediately with 405 + Allow: POST, OPTIONS.
    const started = performance.now();
    const authGet = await app.fetch(
      new Request(RESOURCE_URL, {
        method: "GET",
        headers: {
          authorization: "Bearer alice-jwt",
          accept: "text/event-stream",
        },
      }),
    );
    expect(performance.now() - started).toBeLessThan(100);
    expect(authGet.status).toBe(405);
    expect(authGet.headers.get("allow")).toBe("POST, OPTIONS");

    // 4. Authenticated DELETE /mcp refuses immediately with 405 + Allow: POST, OPTIONS.
    const authDelete = await app.fetch(
      new Request(RESOURCE_URL, {
        method: "DELETE",
        headers: {
          authorization: "Bearer alice-jwt",
          "mcp-session-id": "cs1_11111111222243338444555555555555_00",
        },
      }),
    );
    expect(authDelete.status).toBe(405);
    expect(authDelete.headers.get("allow")).toBe("POST, OPTIONS");

    // 5. POST subscriptions/listen (single and batch) refuses in <1ms with JSON-RPC -32601.
    const listen = await app.fetch(
      new Request(RESOURCE_URL, {
        method: "POST",
        headers: {
          authorization: "Bearer alice-jwt",
          "content-type": "application/json",
          "mcp-method": "subscriptions/listen",
          "mcp-protocol-version": "2026-07-28",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "sub-42",
          method: "subscriptions/listen",
          params: {},
        }),
      }),
    );
    expect(listen.status).toBe(200);
    expect(await listen.json()).toEqual({
      jsonrpc: "2.0",
      id: "sub-42",
      error: {
        code: -32601,
        message:
          "Method not found: subscriptions/listen is disabled on stateless endpoints.",
      },
    });

    const batchListen = await app.fetch(
      new Request(RESOURCE_URL, {
        method: "POST",
        headers: {
          authorization: "Bearer alice-jwt",
          "content-type": "application/json",
        },
        body: JSON.stringify([
          { jsonrpc: "2.0", id: "batch-9", method: "subscriptions/listen" },
        ]),
      }),
    );
    expect(batchListen.status).toBe(200);
    expect(await batchListen.json()).toMatchObject({
      id: "batch-9",
      error: { code: -32601 },
    });
  });

  it("enforces opt-in CORS allowlists, rejects Origin: null, and merges exposed headers", async () => {
    const app = createSupabaseMcpInternal(
      {
        server: { name: "cors-mcp", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        cors: {
          origins: ["https://inspector.example"],
          exposeHeaders: ["x-custom-trace"],
        },
        register(server) {
          server.registerTool("ok", { inputSchema: z.object({}) }, async () =>
            textResult("ok"),
          );
        },
      },
      createDeps(),
    );

    // Origin: null is always rejected with 403.
    const nullOrigin = await app.fetch(
      new Request(RESOURCE_URL, {
        method: "OPTIONS",
        headers: { origin: "null" },
      }),
    );
    expect(nullOrigin.status).toBe(403);
    expect(nullOrigin.headers.get("vary")).toContain("Origin");

    // Unlisted origin rejected with 403 on POST as well.
    const evilOrigin = await app.fetch(
      new Request(RESOURCE_URL, {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(evilOrigin.status).toBe(403);

    // Allowed origin receives 204 preflight and decorated POST response.
    const allowedPreflight = await app.fetch(
      new Request(RESOURCE_URL, {
        method: "OPTIONS",
        headers: {
          origin: "https://inspector.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, mcp-param-tenant",
        },
      }),
    );
    expect(allowedPreflight.status).toBe(204);
    expect(allowedPreflight.headers.get("access-control-allow-origin")).toBe(
      "https://inspector.example",
    );
    expect(
      allowedPreflight.headers.get("access-control-allow-headers"),
    ).toContain("mcp-param-tenant");
    expect(
      allowedPreflight.headers.get("access-control-allow-credentials"),
    ).toBeNull();

    const allowedPost = await app.fetch(
      new Request(RESOURCE_URL, {
        method: "POST",
        headers: {
          origin: "https://inspector.example",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/list" }),
      }),
    );
    expect(allowedPost.status).toBe(200);
    expect(allowedPost.headers.get("access-control-allow-origin")).toBe(
      "https://inspector.example",
    );
    const exposed =
      allowedPost.headers.get("access-control-expose-headers")?.toLowerCase() ??
      "";
    expect(exposed).toContain("www-authenticate");
    expect(exposed).toContain("mcp-session-id");
    expect(exposed).toContain("x-custom-trace");
  });

  it("extracts ctx.client across 2026 and 2025 eras and gates cs1_ session issuance strictly on 2025 initialize", async () => {
    const seenClients: SupabaseMcpClientContext[] = [];
    const app = createSupabaseMcpInternal(
      {
        server: { name: "client-ctx", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        register(server, ctx) {
          seenClients.push(ctx.client);
          server.registerTool(
            "inspect",
            { inputSchema: z.object({}) },
            async () => structuredResult({ supports: ctx.client.supports }),
          );
        },
      },
      createDeps(),
    );

    // 1. Legacy 2025 initialize stamps cs1_<uuid32>_<mask>.
    const initRes = await app.fetch(
      new Request(RESOURCE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "init",
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            clientInfo: { name: "ChatGPT-Connector", version: "2.1.0" },
            capabilities: {
              elicitation: { form: {}, url: {} },
              roots: {},
              extensions: { "io.modelcontextprotocol/ui": {} },
            },
          },
        }),
      }),
    );
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get("mcp-session-id");
    expect(sessionId).toMatch(
      /^cs1_11111111222243338444555555555555_[0-9a-f]{2}$/,
    );
    expect(decodeClientSupportMask(sessionId)).toEqual({
      elicitationForm: true,
      elicitationUrl: true,
      mcpAppsUi: true,
      sampling: false,
      roots: true,
      resourceLinks: "unsupported",
    });

    // 2. Subsequent 2025 tools/call recovers support flags from cs1_ header and does NOT re-mint Mcp-Session-Id.
    const legacyCall = await app.fetch(
      new Request(RESOURCE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "call-1",
          method: "tools/call",
          params: { name: "inspect", arguments: {} },
        }),
      }),
    );
    expect(legacyCall.status).toBe(200);
    expect(legacyCall.headers.get("mcp-session-id")).toBeNull();
    const legacyBody = jsonRpcPayloadFromResponseText(
      await legacyCall.text(),
    ) as {
      result?: { structuredContent?: { supports?: Record<string, unknown> } };
    };
    expect(legacyBody.result?.structuredContent?.supports).toEqual({
      elicitationForm: true,
      elicitationUrl: true,
      mcpAppsUi: true,
      sampling: false,
      roots: true,
      resourceLinks: "unsupported",
    });

    // 3. Modern 2026-07-28 call extracts capabilities from _meta and never mints Mcp-Session-Id.
    const modernCall = await app.fetch(
      new Request(RESOURCE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "inspect",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "call-2",
          method: "tools/call",
          params: {
            name: "inspect",
            arguments: {},
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": {
                name: "claude-desktop",
                version: "3.0.0",
              },
              "io.modelcontextprotocol/clientCapabilities": {
                elicitation: {},
                sampling: {},
              },
            },
          },
        }),
      }),
    );
    expect(modernCall.status).toBe(200);
    expect(modernCall.headers.get("mcp-session-id")).toBeNull();
    const modernBody = (await modernCall.json()) as {
      result?: { structuredContent?: { supports?: Record<string, unknown> } };
    };
    expect(modernBody.result?.structuredContent?.supports).toEqual({
      elicitationForm: true,
      elicitationUrl: false,
      mcpAppsUi: false,
      sampling: true,
      roots: false,
      resourceLinks: "unknown",
    });

    // Round-trip sanity check on bitmask helper.
    const mask = encodeClientSupportMask({
      elicitationForm: true,
      elicitationUrl: false,
      mcpAppsUi: true,
      sampling: true,
      roots: false,
      resourceLinks: "supported",
    });
    expect(decodeClientSupportMask(`cs1_${"a".repeat(32)}_${mask}`)).toEqual({
      elicitationForm: true,
      elicitationUrl: false,
      mcpAppsUi: true,
      sampling: true,
      roots: false,
      resourceLinks: "supported",
    });
  });

  it("synthesizes reading cards in resourceLinkFallbackMiddleware while respecting collection byte budgets", async () => {
    const errors: SupabaseMcpErrorEvent[] = [];
    const app = createSupabaseMcpInternal(
      {
        server: { name: "resource-fallback", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        resultMiddleware: [
          resourceLinkFallbackMiddleware({
            resolveFallbackHint: (link) => `Use read_doc("${link.uri}").`,
          }),
        ],
        onError: (event) => errors.push(event),
        register(server) {
          server.registerTool(
            "bare_link",
            { inputSchema: z.object({}) },
            async () => ({
              content: [
                {
                  type: "resource_link",
                  uri: "docs://handbook",
                  name: "handbook",
                  title: "Team Handbook",
                  mimeType: "text/markdown",
                },
              ],
            }),
          );
          server.registerTool(
            "tight_collection",
            { inputSchema: z.object({}) },
            async () => {
              const base = collectionResult({
                items: [{ id: "1", note: "x".repeat(260) }],
                itemSchema: z.object({ id: z.string(), note: z.string() }),
                project: (item) => item,
                mode: "structured",
                limit: 20,
                hasMore: false,
                cursorFor: (item) => item.id,
                tool: "tight_collection",
                maxBytes: 512,
              });
              return {
                ...base,
                content: [
                  {
                    type: "resource_link",
                    uri: "docs://huge",
                    name: "huge",
                    description: "d".repeat(120),
                  },
                ],
              };
            },
          );
        },
      },
      createDeps(),
    );

    const bareRes = await app.fetch(
      new Request(RESOURCE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          method: "tools/call",
          params: { name: "bare_link", arguments: {} },
        }),
      }),
    );
    const bareBody = jsonRpcPayloadFromResponseText(await bareRes.text()) as {
      result?: { content?: Array<{ type: string; text?: string }> };
    };
    expect(bareBody.result?.content?.[0]?.type).toBe("text");
    expect(bareBody.result?.content?.[0]?.text).toContain("Team Handbook");
    expect(bareBody.result?.content?.[0]?.text).toContain(
      'Use read_doc("docs://handbook").',
    );

    const tightRes = await app.fetch(
      new Request(RESOURCE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "2",
          method: "tools/call",
          params: { name: "tight_collection", arguments: {} },
        }),
      }),
    );
    expect(tightRes.status).toBe(200);
    // Budget overflow fell back cleanly to the original valid result and reported phase: "results".
    expect(errors.some((e) => e.phase === "results")).toBe(true);
  });

  it("propagates TCP client disconnects to Request.signal in chumbo/node", async () => {
    let signalAborted!: Promise<boolean>;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    const server = await serve(
      {
        fetch(request) {
          signalAborted = new Promise<boolean>((resolve) => {
            if (request.signal.aborted) {
              resolve(true);
              return;
            }
            request.signal.addEventListener("abort", () => resolve(true), {
              once: true,
            });
          });
          resolveStarted();
          return new Promise<Response>(() => {
            // Intentionally hold until client disconnects.
          });
        },
      },
      { port: 0, hostname: "127.0.0.1" },
    );
    running.push(server);

    const port = Number(new URL(server.url).port);
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write("GET /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    });
    await started;
    socket.destroy();

    const aborted = await Promise.race([
      signalAborted,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
    ]);
    expect(aborted).toBe(true);
  });
});
