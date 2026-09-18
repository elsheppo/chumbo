import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { serve, toNodeHandler, type RunningNodeApp } from "../src/node.js";
import { textResult } from "../src/results.js";
import { createSupabaseMcpInternal } from "../src/runtime.js";
import type {
  RuntimeDependencies,
  VerifiedSupabaseIdentity,
} from "../src/types.js";
import type { SupabaseClient } from "@supabase/supabase-js";

const running: RunningNodeApp[] = [];

async function start(
  app: Parameters<typeof serve>[0],
): Promise<RunningNodeApp> {
  const server = await serve(app, { port: 0, hostname: "127.0.0.1" });
  running.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

describe("toNodeHandler", () => {
  it("passes method, URL, headers, and a streamed body through", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const server = await start({
      async fetch(request) {
        seen.push({
          method: request.method,
          url: request.url,
          echo: request.headers.get("x-echo"),
          body: await request.text(),
        });
        return Response.json({ ok: true });
      },
    });

    const response = await fetch(`${server.url}/mcp/deep/path?q=1`, {
      method: "POST",
      headers: { "x-echo": "echoed", "content-type": "text/plain" },
      body: "streamed body",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(seen).toEqual([
      {
        method: "POST",
        url: `${server.url}/mcp/deep/path?q=1`,
        echo: "echoed",
        body: "streamed body",
      },
    ]);
  });

  it("reconstructs the public URL from reverse-proxy forwarding headers", async () => {
    let observed: string | undefined;
    const server = await start({
      async fetch(request) {
        observed = request.url;
        return new Response(null, { status: 204 });
      },
    });

    await fetch(`${server.url}/mcp/.well-known/oauth-protected-resource`, {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "app.example.com",
      },
    });

    expect(observed).toBe(
      "https://app.example.com/mcp/.well-known/oauth-protected-resource",
    );
  });

  it("writes every set-cookie header separately", async () => {
    const server = await start({
      async fetch() {
        const headers = new Headers();
        headers.append("set-cookie", "a=1; Path=/");
        headers.append("set-cookie", "b=2; Path=/");
        return new Response("ok", { headers });
      },
    });

    const response = await fetch(server.url);
    expect(response.headers.getSetCookie()).toEqual([
      "a=1; Path=/",
      "b=2; Path=/",
    ]);
  });

  it("streams a server-sent-event body progressively", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const server = await start({
      async fetch() {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode("data: first\n\n"));
            await gate;
            controller.enqueue(encoder.encode("data: second\n\n"));
            controller.close();
          },
        });
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const response = await fetch(server.url);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("data: first");
    release?.();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toContain("data: second");
    expect((await reader.read()).done).toBe(true);
  });

  it("answers 500 without leaking details when the app throws", async () => {
    const server = await start({
      async fetch() {
        throw new Error("private failure detail");
      },
    });

    const response = await fetch(server.url);
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("server_error");
    expect(body).not.toContain("private failure detail");
  });

  it("is exported for embedding into an existing Node server", () => {
    const handler = toNodeHandler({
      async fetch() {
        return new Response("ok");
      },
    });
    expect(typeof handler).toBe("function");
  });
});

describe("serving a Chumbo MCP app over node:http", () => {
  function dependencies(): RuntimeDependencies<any> {
    return {
      async verifyToken(): Promise<VerifiedSupabaseIdentity> {
        throw new Error("rejected token");
      },
      createClient(token) {
        return { token } as unknown as SupabaseClient;
      },
      createAdminClient() {
        return {} as unknown as SupabaseClient;
      },
      async fetch() {
        throw new Error("no outbound calls expected");
      },
      randomUUID: () => crypto.randomUUID(),
    };
  }

  it("completes an authenticated MCP round trip through a real socket", async () => {
    const app = createSupabaseMcpInternal(
      {
        server: { name: "node-host", version: "1.0.0" },
        resourceUrl: "http://127.0.0.1/mcp",
        auth: { mode: "api-key", key: "node-secret", subject: "node-owner" },
        register(server, context) {
          server.registerTool(
            "whoami",
            { inputSchema: z.object({}) },
            async () => textResult(`Connected as ${context.subject}.`),
          );
        },
      },
      dependencies(),
    );
    const server = await start(app);

    const unauthenticated = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-method": "tools/list",
        "mcp-protocol-version": "2026-07-28",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "node-test",
              version: "1.0.0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("x-chumbo-auth-mode")).toBe("api-key");

    const call = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer node-secret",
        "content-type": "application/json",
        "mcp-method": "tools/call",
        "mcp-name": "whoami",
        "mcp-protocol-version": "2026-07-28",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "2",
        method: "tools/call",
        params: {
          name: "whoami",
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": {
              name: "node-test",
              version: "1.0.0",
            },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    expect(call.status).toBe(200);
    const body = (await call.json()) as {
      result?: { content?: Array<{ text?: string }> };
    };
    expect(body.result?.content?.[0]?.text).toBe("Connected as node-owner.");
    await app.close();
  });
});
