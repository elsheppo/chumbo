import { McpServer } from "@modelcontextprotocol/server";
import { pipeline } from "@supabase/middleware";
import { withOAuthProtectedResource, withSupabase } from "@supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createRunCorrelation } from "../src/internal/run-correlation.js";
import {
  chumboMcpHandler,
  deriveResourceUrlFromMetadataUrl,
  withChumbo,
  withMcpCors,
  withMcpTransportArmor,
} from "../src/middleware.js";
import { structuredResult, textResult } from "../src/results.js";
import { jsonRpcPayloadFromResponseText } from "../src/transport.js";
import type {
  SupabaseMcpErrorEvent,
  SupabaseMcpLifecycleEvent,
  SupabaseMcpSurfaceProof,
} from "../src/types.js";

const SUPABASE_URL = "https://project.supabase.co";
const RESOURCE_URL = `${SUPABASE_URL}/functions/v1/mcp`;
const HMAC_KEY = "middleware-test-hmac-key-at-least-thirty-two-bytes";

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function encodeJson(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

async function createEs256AuthFixture() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const rawPublic = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const kid = "test-es256-1";
  const publicJwk = {
    kty: rawPublic.kty,
    crv: rawPublic.crv,
    x: rawPublic.x,
    y: rawPublic.y,
    kid,
    alg: "ES256",
  };

  async function signToken(claims: Record<string, unknown>): Promise<string> {
    const header = encodeJson({ alg: "ES256", typ: "JWT", kid });
    const now = Math.floor(Date.now() / 1000);
    const payload = encodeJson({
      iss: `${SUPABASE_URL}/auth/v1`,
      aud: "authenticated",
      role: "authenticated",
      iat: now,
      exp: now + 3600,
      ...claims,
    });
    const signingInput = `${header}.${payload}`;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.privateKey,
      new TextEncoder().encode(signingInput),
    );
    return `${signingInput}.${b64url(new Uint8Array(signature))}`;
  }

  return {
    env: {
      url: SUPABASE_URL,
      publishableKeys: { default: "sb_publishable_test_key" },
      secretKeys: { default: "sb_secret_test_key" },
      jwks: { keys: [publicJwk] },
    },
    signToken,
  };
}

function modernPost(
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Request {
  return new Request(RESOURCE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "pipeline-test",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
          ...(params._meta as Record<string, unknown> | undefined),
        },
      },
    }),
  });
}

describe("chumbo/middleware pipeline composition", () => {
  it("derives canonical resource URLs from both RFC 9728 prefix and suffix metadata URLs", () => {
    expect(
      deriveResourceUrlFromMetadataUrl(
        "https://p.supabase.co/.well-known/oauth-protected-resource/functions/v1/mcp",
      ),
    ).toBe("https://p.supabase.co/functions/v1/mcp");
    expect(
      deriveResourceUrlFromMetadataUrl(
        "https://p.supabase.co/.well-known/oauth-protected-resource",
      ),
    ).toBe("https://p.supabase.co/");
    expect(
      deriveResourceUrlFromMetadataUrl(
        "https://p.supabase.co/functions/v1/mcp/oauth-protected-resource",
      ),
    ).toBe("https://p.supabase.co/functions/v1/mcp");
    expect(
      deriveResourceUrlFromMetadataUrl(
        "https://p.supabase.co/functions/v1/mcp/.well-known/oauth-protected-resource",
      ),
    ).toBe("https://p.supabase.co/functions/v1/mcp");
  });

  it("composes withMcpCors, withOAuthProtectedResource, withSupabase, withChumbo, and chumboMcpHandler end-to-end", async () => {
    const auth = await createEs256AuthFixture();
    const events: SupabaseMcpLifecycleEvent[] = [];
    const proofs: SupabaseMcpSurfaceProof[] = [];
    const observedKeys: string[][] = [];
    const observedRuns: Array<string | null | undefined> = [];

    const runs = createRunCorrelation({
      currentKey: {
        version: "v1",
        secret: "pipeline-run-key-at-least-thirty-two-bytes-long",
      },
      sessionHeader: true,
      scope: (ctx) => ({
        installation: "acme",
        surface: "todos",
        partition: ctx.subject ?? "anon",
      }),
    });

    const app = pipeline(
      [
        withMcpCors({ origins: ["https://claude.ai"] }),
        withOAuthProtectedResource({
          resourceServer: RESOURCE_URL,
          authorizationServer: `${SUPABASE_URL}/auth/v1`,
        }),
        withSupabase({
          auth: "user",
          cors: "disabled",
          env: auth.env,
        }),
        withChumbo({
          server: { name: "acme-todos", version: "1.0.0" },
          runCorrelation: runs,
          access: {
            allowClients: ["client-allowed"],
            requiredScopes: ["todos:read"],
          },
          resultMiddleware: () => ({
            append: [{ type: "text", text: "middleware-footer" }],
          }),
          onEvent: (event) => {
            events.push(event);
          },
          onSurface: (proof) => {
            proofs.push(proof);
          },
        }),
      ],
      chumboMcpHandler({
        server: { name: "acme-todos", version: "1.0.0" },
        register(server, ctx) {
          observedKeys.push(Object.keys(ctx).sort());
          server.withScopes(["todos:read"]).registerTool(
            "list_todos",
            {
              description: "List todos.",
              inputSchema: z.object({}),
              outputSchema: z.object({ ok: z.boolean() }).strict(),
            },
            async () => {
              observedRuns.push(ctx.run?.id ?? null);
              return structuredResult({ ok: true });
            },
          );
          server
            .withScopes(["todos:admin"])
            .registerTool(
              "delete_all",
              { description: "Admin only.", inputSchema: z.object({}) },
              async () => textResult("deleted"),
            );
        },
      }),
    );

    // 1. CORS preflight succeeds without credentials.
    const preflight = await app(
      new Request(RESOURCE_URL, {
        method: "OPTIONS",
        headers: {
          origin: "https://claude.ai",
          "access-control-request-method": "POST",
          "access-control-request-headers":
            "authorization, mcp-param-workspace",
        },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "https://claude.ai",
    );
    expect(preflight.headers.get("access-control-allow-headers")).toContain(
      "mcp-param-workspace",
    );
    expect(
      preflight.headers.get("access-control-allow-credentials"),
    ).toBeNull();

    // 2. Unauthenticated request receives 401 + exposed WWW-Authenticate.
    const unauth = await app(
      modernPost("tools/list", {}, { origin: "https://claude.ai" }),
    );
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).toContain(
      "resource_metadata=",
    );
    expect(
      unauth.headers.get("access-control-expose-headers")?.toLowerCase(),
    ).toContain("www-authenticate");

    // 3. Disallowed client_id fails with 403 unauthorized_client.
    const badClientToken = await auth.signToken({
      sub: "user-1",
      client_id: "client-blocked",
      scope: "todos:read",
    });
    const blockedClient = await app(
      modernPost(
        "tools/list",
        {},
        { authorization: `Bearer ${badClientToken}` },
      ),
    );
    expect(blockedClient.status).toBe(403);
    expect(await blockedClient.json()).toMatchObject({
      error: "unauthorized_client",
    });

    // 4. Missing requiredScope fails with 403 + insufficient_scope + resource_metadata.
    const narrowToken = await auth.signToken({
      sub: "user-1",
      client_id: "client-allowed",
      scope: "profile",
    });
    const missingScope = await app(
      modernPost("tools/list", {}, { authorization: `Bearer ${narrowToken}` }),
    );
    expect(missingScope.status).toBe(403);
    const challenge = missingScope.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="todos:read"');
    expect(challenge).toContain("resource_metadata=");

    // 5. Authorized initialize issues runCorrelation session header (crun1...).
    const validToken = await auth.signToken({
      sub: "user-1",
      client_id: "client-allowed",
      scope: "todos:read",
    });
    const initRes = await app(
      new Request(RESOURCE_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${validToken}`,
          origin: "https://claude.ai",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "init-1",
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "claude-code", version: "1.0.0" },
          },
        }),
      }),
    );
    expect(initRes.status).toBe(200);
    const sessionHeader = initRes.headers.get("mcp-session-id");
    expect(sessionHeader).toMatch(/^crun1\./);
    const initBody = jsonRpcPayloadFromResponseText(await initRes.text()) as {
      result?: { capabilities?: Record<string, unknown> };
    };
    // Lazy capability seeding: tool-only server advertises tools.listChanged: false and NO resources/prompts.
    expect(initBody.result?.capabilities?.tools).toEqual({
      listChanged: false,
    });
    expect(initBody.result?.capabilities?.resources).toBeUndefined();
    expect(initBody.result?.capabilities?.prompts).toBeUndefined();

    // 6. tools/list emits onSurface proof, filters scoped tools, and never exposes supabaseAdmin.
    const listRes = await app(
      modernPost("tools/list", {}, { authorization: `Bearer ${validToken}` }),
    );
    expect(listRes.status).toBe(200);
    expect(listRes.headers.get("x-chumbo-auth-mode")).toBe("oauth");
    expect(proofs).toHaveLength(1);
    expect(proofs[0]?.tools.map((t) => t.name)).toEqual(["list_todos"]);
    // openOutputSchema opened the strict output schema for clients.
    expect(
      proofs[0]?.tools[0]?.outputSchema?.additionalProperties,
    ).toBeUndefined();
    expect(observedKeys[0]).not.toContain("supabaseAdmin");

    // 7. tools/call with session header resolves ctx.run dynamically and fires lifecycle v2 + resultMiddleware.
    const callRes = await app(
      modernPost(
        "tools/call",
        { name: "list_todos", arguments: {} },
        {
          authorization: `Bearer ${validToken}`,
          "mcp-name": "list_todos",
          "mcp-session-id": sessionHeader!,
        },
      ),
    );
    expect(callRes.status).toBe(200);
    const callBody = (await callRes.json()) as {
      result?: {
        content?: Array<{ text?: string }>;
        structuredContent?: unknown;
      };
    };
    expect(callBody.result?.structuredContent).toEqual({ ok: true });
    expect(callBody.result?.content?.[0]?.text).toBe("middleware-footer");
    expect(observedRuns[0]).toMatch(/^run_/);
    expect(events.map((e) => e.type)).toEqual([
      "capability.started",
      "capability.finished",
    ]);
    expect(events[0]?.schemaVersion).toBe(2);
  });

  it("composes withSupabase({ auth: 'secret' }) without withOAuthProtectedResource and keeps supabaseAdmin out of ctx.chumbo", async () => {
    const auth = await createEs256AuthFixture();
    let sawAdminOnChumbo = false;
    let sawMode: string | undefined;

    const app = pipeline(
      [
        withSupabase({ auth: "secret", cors: "disabled", env: auth.env }),
        withChumbo({
          server: { name: "internal-api", version: "1.0.0" },
        }),
      ],
      async (_req, ctx) => {
        sawAdminOnChumbo = "supabaseAdmin" in ctx.chumbo;
        sawMode = ctx.chumbo.authentication.mode;
        return Response.json({ ok: true });
      },
    );

    const response = await app(
      new Request(RESOURCE_URL, {
        method: "POST",
        headers: {
          apikey: "sb_secret_test_key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(sawAdminOnChumbo).toBe(false);
    expect(sawMode).toBe("api-key");
  });

  it("fails closed when ctx.chumbo.instrument(server) is called after registering tools, and is idempotent before", async () => {
    const auth = await createEs256AuthFixture();
    let threwOnPreRegistered = false;
    let idempotentSameProxy = false;

    const app = pipeline(
      [
        withSupabase({ auth: "none", cors: "disabled", env: auth.env }),
        withChumbo({
          server: { name: "guard-test", version: "1.0.0" },
        }),
      ],
      async (_req, ctx) => {
        const clean = new McpServer({ name: "clean", version: "1.0.0" });
        const first = ctx.chumbo.instrument(clean);
        const second = ctx.chumbo.instrument(clean);
        idempotentSameProxy = first === second;

        const dirty = new McpServer({ name: "dirty", version: "1.0.0" });
        dirty.registerTool("pre", { inputSchema: z.object({}) }, async () =>
          textResult("pre"),
        );
        try {
          ctx.chumbo.instrument(dirty);
        } catch (error) {
          threwOnPreRegistered = error instanceof TypeError;
        }
        return Response.json({ ok: true });
      },
    );

    const res = await app(
      new Request(RESOURCE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(idempotentSameProxy).toBe(true);
    expect(threwOnPreRegistered).toBe(true);
  });

  it("refuses durable state when upstream withSupabase uses auth: 'none'", async () => {
    const auth = await createEs256AuthFixture();
    const errors: SupabaseMcpErrorEvent[] = [];
    const app = pipeline(
      [
        withSupabase({ auth: "none", cors: "disabled", env: auth.env }),
        withChumbo({
          server: { name: "public-state-guard", version: "1.0.0" },
          state: {
            hmacKey: HMAC_KEY,
            namespaces: { drafts: { ttlSeconds: 60 } },
          },
          onError: (event) => errors.push(event),
        }),
      ],
      async () => Response.json({ ok: true }),
    );

    const res = await app(
      new Request(RESOURCE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );
    expect(res.status).toBe(500);
    expect(errors[0]?.phase).toBe("runtime");
  });

  it("supports standalone withMcpTransportArmor without withChumbo", async () => {
    const handler = pipeline([withMcpTransportArmor()], async () =>
      Response.json({
        jsonrpc: "2.0",
        id: "1",
        result: { protocolVersion: "2025-11-25", capabilities: {} },
      }),
    );

    const getRes = await handler(
      new Request(RESOURCE_URL, {
        method: "GET",
        headers: { accept: "text/event-stream" },
      }),
    );
    expect(getRes.status).toBe(405);
    expect(getRes.headers.get("allow")).toBe("POST, OPTIONS");

    const initRes = await handler(
      new Request(RESOURCE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: { sampling: {} },
            clientInfo: { name: "legacy-client", version: "1.0.0" },
          },
        }),
      }),
    );
    expect(initRes.status).toBe(200);
    expect(initRes.headers.get("mcp-session-id")).toMatch(
      /^cs1_[0-9a-f]{32}_[0-9a-f]{2}$/,
    );
  });

  it("keeps SupabaseClient type intact when passing typed Database generic", async () => {
    type DemoDb = { public: { Tables: Record<string, never> } };
    const auth = await createEs256AuthFixture();
    let clientRef: SupabaseClient<DemoDb> | undefined;

    const app = pipeline(
      [
        withSupabase<DemoDb>({ auth: "none", cors: "disabled", env: auth.env }),
        withChumbo<DemoDb>({
          server: { name: "typed-db", version: "1.0.0" },
        }),
      ],
      async (_req, ctx) => {
        clientRef = ctx.chumbo.supabase;
        return Response.json({ ok: Boolean(clientRef) });
      },
    );

    const res = await app(
      new Request(RESOURCE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(clientRef).toBeDefined();
  });
});
