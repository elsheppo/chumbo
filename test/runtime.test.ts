import { describe, expect, it } from "vitest";
import { z } from "zod";
import { acceptedContent, inputRequired } from "@modelcontextprotocol/server";
import { jsonResult } from "../src/results.js";
import { createSupabaseMcpInternal, runtimeUrls } from "../src/runtime.js";
import type {
  RuntimeDependencies,
  VerifiedSupabaseIdentity,
} from "../src/types.js";
import type { SupabaseClient } from "@supabase/supabase-js";

const RESOURCE_URL = "https://project.supabase.co/functions/v1/mcp";
const ISSUER = "https://project.supabase.co/auth/v1";

function identity(
  id: string,
  clientId?: string,
  scopes?: readonly string[],
): VerifiedSupabaseIdentity {
  return {
    token: id,
    userClaims: { id, email: `${id}@example.com`, role: "authenticated" },
    jwtClaims: {
      sub: id,
      email: `${id}@example.com`,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...(clientId ? { client_id: clientId } : {}),
      ...(scopes ? { scope: scopes.join(" ") } : {}),
    },
  };
}

function dependencies(
  users: Record<string, VerifiedSupabaseIdentity> = {},
  rateLimit: {
    allowed?: boolean;
    currentCount?: number;
    error?: Error;
  } = {},
): RuntimeDependencies<any> {
  let sequence = 0;
  return {
    async verifyToken(token) {
      const found = users[token];
      if (!found) throw new Error("rejected token");
      return found;
    },
    createClient(token) {
      return { token } as unknown as SupabaseClient;
    },
    createAdminClient() {
      return {
        async rpc() {
          return {
            data: rateLimit.error
              ? null
              : [
                  {
                    allowed: rateLimit.allowed ?? true,
                    current_count: rateLimit.currentCount ?? 1,
                    reset_at: new Date(Date.now() + 60_000).toISOString(),
                  },
                ],
            error: rateLimit.error ?? null,
          };
        },
      } as unknown as SupabaseClient;
    },
    async fetch() {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        registration_endpoint: `${ISSUER}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
      });
    },
    randomUUID() {
      sequence += 1;
      return `trace-${sequence}`;
    },
  };
}

function request(
  method: string,
  token?: string,
  params: Record<string, unknown> = {},
): Request {
  const headers = new Headers({
    "content-type": "application/json",
    "mcp-method": method,
    "mcp-protocol-version": "2026-07-28",
  });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (typeof params.name === "string") headers.set("mcp-name", params.name);
  if (typeof params.uri === "string") headers.set("mcp-name", params.uri);
  return new Request(RESOURCE_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "runtime-test",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {
            elicitation: { form: {} },
          },
        },
      },
    }),
  });
}

function legacyRequest(
  method: string,
  params: Record<string, unknown> = {},
): Request {
  return new Request(RESOURCE_URL, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      params,
    }),
  });
}

describe("OAuth resource server", () => {
  it("returns a function-local protected-resource challenge", async () => {
    const app = createSupabaseMcpInternal(
      {
        server: { name: "test", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "oauth" },
        register() {},
      },
      dependencies(),
    );
    const response = await app.fetch(request("tools/list"));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      `${RESOURCE_URL}/.well-known/oauth-protected-resource`,
    );
  });

  it("serves protected-resource and authorization-server metadata", async () => {
    const app = createSupabaseMcpInternal(
      {
        server: { name: "test", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "oauth" },
        register() {},
      },
      dependencies(),
    );
    const protectedResponse = await app.fetch(
      new Request(runtimeUrls.resourceMetadata(RESOURCE_URL)),
    );
    const protectedBody = await protectedResponse.json();
    expect(protectedBody).toMatchObject({
      resource: RESOURCE_URL,
      authorization_servers: [ISSUER],
    });

    const authorizationResponse = await app.fetch(
      new Request(runtimeUrls.authorizationMetadataMirror(RESOURCE_URL)),
    );
    expect(await authorizationResponse.json()).toMatchObject({
      issuer: ISSUER,
    });
  });

  it("serves metadata when Supabase strips the functions/v1 prefix", async () => {
    const app = createSupabaseMcpInternal(
      {
        server: { name: "test", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "oauth" },
        register() {},
      },
      dependencies(),
    );

    const response = await app.fetch(
      new Request(
        "http://project.supabase.co/mcp/.well-known/oauth-protected-resource",
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resource: RESOURCE_URL,
      authorization_servers: [ISSUER],
    });
  });

  it("redacts token verification failures into an OAuth challenge", async () => {
    const app = createSupabaseMcpInternal(
      {
        server: { name: "test", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "oauth" },
        register() {},
      },
      dependencies(),
    );
    const response = await app.fetch(request("tools/list", "secret-bad-token"));
    const body = await response.text();
    expect(response.status).toBe(401);
    expect(body).toContain("invalid_token");
    expect(body).not.toContain("secret-bad-token");
    expect(body).not.toContain("rejected token");
  });

  it("rejects an expired verified identity", async () => {
    const expired = identity("expired");
    expired.jwtClaims.exp = Math.floor(Date.now() / 1000) - 60;
    const app = createSupabaseMcpInternal(
      {
        server: { name: "test", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "oauth" },
        register() {},
      },
      dependencies({ expired }),
    );

    const response = await app.fetch(request("tools/list", "expired"));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("invalid_token");
  });
});

describe("request context", () => {
  it("keeps concurrent user contexts isolated", async () => {
    const app = createSupabaseMcpInternal(
      {
        server: { name: "test", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "bearer" },
        register(server, context) {
          server.registerTool(
            "current_user",
            { inputSchema: z.object({}) },
            async () =>
              jsonResult({
                id: context.user?.id,
                clientToken: (context.supabase as unknown as { token: string })
                  .token,
              }),
          );
        },
      },
      dependencies({ alice: identity("alice"), bob: identity("bob") }),
    );

    const call = (token: string) =>
      app
        .fetch(
          request("tools/call", token, {
            name: "current_user",
            arguments: {},
          }),
        )
        .then((response) => response.json());

    const [alice, bob] = await Promise.all([call("alice"), call("bob")]);
    expect(alice.result.structuredContent).toEqual({
      id: "alice",
      clientToken: "alice",
    });
    expect(bob.result.structuredContent).toEqual({
      id: "bob",
      clientToken: "bob",
    });
  });

  it("does not expose an admin client", async () => {
    let contextKeys: string[] = [];
    const app = createSupabaseMcpInternal(
      {
        server: { name: "test", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "bearer" },
        register(_server, context) {
          contextKeys = Object.keys(context);
        },
      },
      dependencies({ alice: identity("alice") }),
    );
    await app.fetch(request("tools/list", "alice"));
    expect(contextKeys).not.toContain("supabaseAdmin");
  });

  it("supports an explicitly public stateless server", async () => {
    const app = createSupabaseMcpInternal(
      {
        server: { name: "public", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        register(server) {
          server.registerTool("ping", { inputSchema: z.object({}) }, async () =>
            jsonResult({ pong: true }),
          );
        },
      },
      dependencies(),
    );
    const response = await app.fetch(request("tools/list"));
    expect(response.status).toBe(200);
    expect((await response.json()).result.tools[0].name).toBe("ping");
  });
});

describe("progressive access controls", () => {
  it("keeps unscoped registration simple and filters scoped capabilities", async () => {
    let deniedCalls = 0;
    const app = createSupabaseMcpInternal(
      {
        server: { name: "scoped", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "bearer" },
        register(server, context) {
          expect(context.hasScope("projects:read")).toBe(true);
          expect(context.hasScopes(["projects:read"])).toBe(true);
          server.registerTool(
            "health",
            { inputSchema: z.object({}) },
            async () => jsonResult({ ok: true }),
          );
          server
            .withScopes(["projects:read"])
            .registerTool(
              "list_projects",
              { inputSchema: z.object({}) },
              async () => jsonResult({ projects: [] }),
            );
          server
            .withScopes(["projects:write"])
            .registerTool(
              "create_project",
              { inputSchema: z.object({}) },
              async () => {
                deniedCalls += 1;
                return jsonResult({ created: true });
              },
            );
        },
      },
      dependencies({
        reader: identity("reader", undefined, ["projects:read"]),
      }),
    );

    const response = await app.fetch(request("tools/list", "reader"));
    const names = (await response.json()).result.tools.map(
      (tool: { name: string }) => tool.name,
    );
    expect(names).toEqual(["health", "list_projects"]);

    const denied = await app.fetch(
      request("tools/call", "reader", {
        name: "create_project",
        arguments: {},
      }),
    );
    expect((await denied.json()).error).toBeDefined();
    expect(deniedCalls).toBe(0);
  });

  it("lets an application resolver supply authoritative scopes", async () => {
    const app = createSupabaseMcpInternal(
      {
        server: { name: "resolved", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "bearer" },
        access: {
          resolveScopes(context) {
            return context.user?.id === "writer" ? ["projects:write"] : [];
          },
        },
        register(server) {
          server
            .withScopes(["projects:write"])
            .registerTool(
              "create_project",
              { inputSchema: z.object({}) },
              async () => jsonResult({ created: true }),
            );
        },
      },
      dependencies({ writer: identity("writer") }),
    );

    const response = await app.fetch(request("tools/list", "writer"));
    expect((await response.json()).result.tools).toMatchObject([
      { name: "create_project" },
    ]);
  });

  it("redacts scope resolver failures", async () => {
    const errors: string[] = [];
    const app = createSupabaseMcpInternal(
      {
        server: { name: "resolved", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "bearer" },
        access: {
          resolveScopes() {
            throw new Error("private grant-table failure");
          },
        },
        register() {},
        onError(event) {
          errors.push(`${event.phase}:${event.error.message}`);
        },
      },
      dependencies({ reader: identity("reader") }),
    );

    const response = await app.fetch(request("tools/list", "reader"));
    const body = await response.text();
    expect(response.status).toBe(500);
    expect(body).not.toContain("private grant-table failure");
    expect(errors).toEqual(["runtime:private grant-table failure"]);
  });

  it("supports deliberately narrow public scopes", async () => {
    const app = createSupabaseMcpInternal(
      {
        server: { name: "public-scoped", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public", scopes: ["catalog:read"] },
        register(server, context) {
          expect(context.hasScope("catalog:read")).toBe(true);
          server
            .withScopes(["catalog:read"])
            .registerTool("catalog", { inputSchema: z.object({}) }, async () =>
              jsonResult({ items: [] }),
            );
          server
            .withScopes(["catalog:read"])
            .registerResource(
              "catalog-help",
              "app://catalog-help",
              { mimeType: "text/plain" },
              async (uri) => ({
                contents: [{ uri: uri.href, text: "Catalog help" }],
              }),
            );
          server
            .withScopes(["catalog:write"])
            .registerResource(
              "catalog-admin",
              "app://catalog-admin",
              { mimeType: "text/plain" },
              async (uri) => ({
                contents: [{ uri: uri.href, text: "Admin" }],
              }),
            );
          server
            .withScopes(["catalog:read"])
            .registerPrompt(
              "summarize-catalog",
              { argsSchema: z.object({}) },
              () => ({
                messages: [
                  {
                    role: "user",
                    content: { type: "text", text: "Summarize the catalog" },
                  },
                ],
              }),
            );
          server
            .withScopes(["catalog:write"])
            .registerPrompt(
              "rewrite-catalog",
              { argsSchema: z.object({}) },
              () => ({
                messages: [
                  {
                    role: "user",
                    content: { type: "text", text: "Rewrite the catalog" },
                  },
                ],
              }),
            );
        },
      },
      dependencies(),
    );

    const response = await app.fetch(request("tools/list"));
    expect((await response.json()).result.tools[0].name).toBe("catalog");

    const resources = await app.fetch(request("resources/list"));
    expect(
      (await resources.json()).result.resources.map(
        (resource: { name: string }) => resource.name,
      ),
    ).toEqual(["catalog-help"]);

    const prompts = await app.fetch(request("prompts/list"));
    expect(
      (await prompts.json()).result.prompts.map(
        (prompt: { name: string }) => prompt.name,
      ),
    ).toEqual(["summarize-catalog"]);
  });

  it("rate limits a generated public server with standard retry headers", async () => {
    const app = createSupabaseMcpInternal(
      {
        server: { name: "limited", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public", rateLimit: true },
        register() {},
      },
      dependencies({}, { allowed: false, currentCount: 61 }),
    );

    const response = await app.fetch(request("tools/list"));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
    expect(response.headers.get("x-ratelimit-limit")).toBe("60");
    expect(await response.json()).toEqual({ error: "rate_limit_exceeded" });
  });

  it("reports remaining public capacity on accepted requests", async () => {
    const app = createSupabaseMcpInternal(
      {
        server: { name: "limited", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: {
          mode: "public",
          rateLimit: { requests: 10, windowSeconds: 30 },
        },
        register(server) {
          server.registerTool("ping", { inputSchema: z.object({}) }, async () =>
            jsonResult({ pong: true }),
          );
        },
      },
      dependencies({}, { allowed: true, currentCount: 4 }),
    );

    const response = await app.fetch(request("tools/list"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratelimit-limit")).toBe("10");
    expect(response.headers.get("x-ratelimit-remaining")).toBe("6");
    expect(response.headers.get("x-ratelimit-reset")).toBeTruthy();
  });

  it("fails closed when the configured public limiter is unavailable", async () => {
    const errors: string[] = [];
    const app = createSupabaseMcpInternal(
      {
        server: { name: "limited", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public", rateLimit: true },
        register() {},
        onError(event) {
          errors.push(`${event.phase}:${event.error.message}`);
        },
      },
      dependencies({}, { error: new Error("missing limiter function") }),
    );

    const response = await app.fetch(request("tools/list"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "rate_limit_unavailable" });
    expect(errors).toEqual(["rate-limit:missing limiter function"]);
  });
});

describe("result helpers", () => {
  it("returns model-readable and structured JSON", () => {
    expect(jsonResult([1, 2])).toEqual({
      content: [{ type: "text", text: "[\n  1,\n  2\n]" }],
      structuredContent: { value: [1, 2] },
    });
  });
});

describe("protocol eras and malformed requests", () => {
  it("serves a stateless 2025-era tools/list by default", async () => {
    const app = createSupabaseMcpInternal(
      {
        server: { name: "legacy", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        register(server) {
          server.registerTool("ping", { inputSchema: z.object({}) }, async () =>
            jsonResult({ pong: true }),
          );
        },
      },
      dependencies(),
    );

    const response = await app.fetch(legacyRequest("tools/list"));
    const payload = (await response.text())
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length);
    const body = payload ? JSON.parse(payload) : null;
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.result.tools[0].name).toBe("ping");
  });

  it("does not silently downgrade a malformed modern request", async () => {
    const app = createSupabaseMcpInternal(
      {
        server: { name: "modern", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        register() {},
      },
      dependencies(),
    );
    const malformed = legacyRequest("tools/list");
    malformed.headers.set("mcp-protocol-version", "2026-07-28");
    malformed.headers.set("mcp-method", "tools/list");

    const response = await app.fetch(malformed);
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe(-32602);
  });
});

describe("MCP capability breadth", () => {
  it("serves discovery, resources, prompts, and a multi-round-trip tool", async () => {
    const app = createSupabaseMcpInternal(
      {
        server: { name: "breadth", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        register(server) {
          server.registerResource(
            "readme",
            "app://readme",
            { mimeType: "text/plain" },
            async (uri) => ({
              contents: [{ uri: uri.href, text: "hello resource" }],
            }),
          );
          server.registerPrompt(
            "hello",
            { argsSchema: z.object({ name: z.string() }) },
            ({ name }) => ({
              messages: [
                {
                  role: "user",
                  content: { type: "text", text: `Hello ${name}` },
                },
              ],
            }),
          );
          server.registerTool(
            "confirm",
            { inputSchema: z.object({}) },
            async (_args, context) => {
              const response = acceptedContent<{ ok: boolean }>(
                context.mcpReq.inputResponses,
                "answer",
              );
              return response?.ok
                ? jsonResult({ confirmed: true })
                : inputRequired({
                    inputRequests: {
                      answer: inputRequired.elicit({
                        message: "Continue?",
                        requestedSchema: z.object({ ok: z.boolean() }),
                      }),
                    },
                  });
            },
          );
        },
      },
      dependencies(),
    );

    const invoke = async (method: string, params = {}) => {
      const response = await app.fetch(request(method, undefined, params));
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      return body;
    };

    const discovery = await invoke("server/discover");
    expect(discovery.result.capabilities).toMatchObject({
      tools: {},
      resources: {},
      prompts: {},
    });
    const resource = await invoke("resources/read", { uri: "app://readme" });
    expect(resource.result.contents[0].text).toBe("hello resource");
    const prompt = await invoke("prompts/get", {
      name: "hello",
      arguments: { name: "Ada" },
    });
    expect(prompt.result.messages[0].content.text).toBe("Hello Ada");

    const first = await invoke("tools/call", {
      name: "confirm",
      arguments: {},
    });
    expect(first.result.resultType).toBe("input_required");
    expect(first.result.inputRequests.answer.method).toBe("elicitation/create");

    const second = await invoke("tools/call", {
      name: "confirm",
      arguments: {},
      inputResponses: {
        answer: { action: "accept", content: { ok: true } },
      },
    });
    expect(second.result.structuredContent).toEqual({ confirmed: true });
  });
});
