import { afterEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { z } from "zod";
import {
  createSupabaseMcp,
  defaultRuntimeDependencies,
} from "../src/runtime.js";

async function signedUserToken(kid: string) {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    email: "person@example.com",
    phone: "",
    role: "authenticated",
    aal: "aal1",
    amr: [],
    session_id: crypto.randomUUID(),
    is_anonymous: false,
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: {},
  })
    .setProtectedHeader({ alg: "ES256", kid, typ: "JWT" })
    .setIssuer("https://project.supabase.co/auth/v1")
    .setAudience("authenticated")
    .setSubject(crypto.randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(privateKey);
  return { token, jwks: { keys: [{ ...jwk, alg: "ES256", kid, use: "sig" }] } };
}

describe("remote JWKS verification", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function toolsListRequest(token: string) {
    return new Request("https://project.supabase.co/functions/v1/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "mcp-method": "tools/list",
        "mcp-protocol-version": "2026-07-28",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "assembled-oauth-proof",
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "compatibility-proof",
              version: "1.0.0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
  }

  it("fetches one bounded JWKS snapshot and reuses it across requests", async () => {
    const fixture = await signedUserToken("cache-proof");
    const fetchJwks = vi.fn(async () => Response.json(fixture.jwks));
    vi.stubGlobal("fetch", fetchJwks);
    const env = {
      url: "https://project.supabase.co",
      jwks: new URL(
        `https://project.supabase.co/auth/v1/.well-known/jwks.json?case=${crypto.randomUUID()}`,
      ),
    };

    const first = await defaultRuntimeDependencies.verifyToken(
      fixture.token,
      env,
    );
    const second = await defaultRuntimeDependencies.verifyToken(
      fixture.token,
      env,
    );

    expect(first.userClaims.id).toBe(first.jwtClaims.sub);
    expect(second.userClaims.id).toBe(first.userClaims.id);
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  it("does not retain a failed JWKS fetch", async () => {
    const fixture = await signedUserToken("retry-proof");
    const fetchJwks = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json(fixture.jwks));
    vi.stubGlobal("fetch", fetchJwks);
    const env = {
      url: "https://project.supabase.co",
      jwks: new URL(
        `https://project.supabase.co/auth/v1/.well-known/jwks.json?case=${crypto.randomUUID()}`,
      ),
    };

    await expect(
      defaultRuntimeDependencies.verifyToken(fixture.token, env),
    ).rejects.toThrow("JWKS endpoint returned HTTP 503");
    await expect(
      defaultRuntimeDependencies.verifyToken(fixture.token, env),
    ).resolves.toMatchObject({ userClaims: { email: "person@example.com" } });
    expect(fetchJwks).toHaveBeenCalledTimes(2);
  });

  it("assembles an OAuth request with the legacy Edge anon-key variable", async () => {
    const fixture = await signedUserToken("legacy-edge-key-proof");
    const fetchJwks = vi.fn(async () => Response.json(fixture.jwks));
    vi.stubGlobal("fetch", fetchJwks);
    vi.stubEnv("SUPABASE_ANON_KEY", "legacy-anon-key");
    const app = createSupabaseMcp({
      server: { name: "compatibility-proof", version: "1.0.0" },
      resourceUrl: "https://project.supabase.co/functions/v1/mcp",
      auth: { mode: "oauth" },
      supabase: {
        env: {
          url: "https://project.supabase.co",
          jwks: new URL(
            `https://project.supabase.co/auth/v1/.well-known/jwks.json?case=${crypto.randomUUID()}`,
          ),
        },
      },
      register(server) {
        server.registerTool(
          "ping",
          { inputSchema: z.object({}) },
          async () => ({ content: [{ type: "text", text: "pong" }] }),
        );
      },
    });

    const response = await app.fetch(toolsListRequest(fixture.token));

    expect(response.status).toBe(200);
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  it("assembles an OAuth request with an explicit modern publishable key", async () => {
    const fixture = await signedUserToken("modern-edge-key-proof");
    const fetchJwks = vi.fn(async () => Response.json(fixture.jwks));
    vi.stubGlobal("fetch", fetchJwks);
    const app = createSupabaseMcp({
      server: { name: "modern-key-proof", version: "1.0.0" },
      resourceUrl: "https://project.supabase.co/functions/v1/mcp",
      auth: { mode: "oauth" },
      supabase: {
        env: {
          url: "https://project.supabase.co",
          jwks: new URL(
            `https://project.supabase.co/auth/v1/.well-known/jwks.json?case=${crypto.randomUUID()}`,
          ),
          publishableKeys: { default: "modern-publishable-key" },
        },
      },
      register(server) {
        server.registerTool(
          "ping",
          { inputSchema: z.object({}) },
          async () => ({ content: [{ type: "text", text: "pong" }] }),
        );
      },
    });

    const response = await app.fetch(toolsListRequest(fixture.token));

    expect(response.status).toBe(200);
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  it("reports post-verification setup failures as safe runtime errors", async () => {
    const fixture = await signedUserToken("runtime-error-proof");
    const events: Array<{ phase: string; message: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(fixture.jwks)),
    );
    const app = createSupabaseMcp({
      server: { name: "diagnostic-proof", version: "1.0.0" },
      resourceUrl: "https://project.supabase.co/functions/v1/mcp",
      auth: { mode: "oauth" },
      supabase: {
        env: {
          url: "https://project.supabase.co",
          jwks: new URL(
            `https://project.supabase.co/auth/v1/.well-known/jwks.json?case=${crypto.randomUUID()}`,
          ),
          publishableKeys: {},
        },
      },
      register() {},
      onError(event) {
        events.push({ phase: event.phase, message: event.error.message });
      },
    });

    const response = await app.fetch(toolsListRequest(fixture.token));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      error: "server_error",
      error_description: "Authentication runtime unavailable",
    });
    expect(JSON.stringify(body)).not.toContain(fixture.token);
    expect(events).toEqual([
      {
        phase: "runtime",
        message: expect.stringContaining("publishable key"),
      },
    ]);
  });
});
