import {
  inputRequired,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { structuredResult } from "../src/results.js";
import { createSupabaseMcpInternal } from "../src/runtime.js";
import type {
  RuntimeDependencies,
  SupabaseMcpLifecycleEvent,
  VerifiedSupabaseIdentity,
} from "../src/types.js";

const RESOURCE_URL = "https://project.supabase.co/functions/v1/mcp";

function identity(subject: string): VerifiedSupabaseIdentity {
  return {
    token: `verified-${subject}`,
    userClaims: {
      id: subject,
      email: `${subject}@example.com`,
      role: "authenticated",
    },
    jwtClaims: {
      sub: subject,
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
  };
}

function dependencies(
  users: Readonly<Record<string, VerifiedSupabaseIdentity>> = {},
): RuntimeDependencies<any> {
  let sequence = 0;
  let now = Date.UTC(2026, 7, 29, 12);
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
      return {} as SupabaseClient;
    },
    fetch: globalThis.fetch.bind(globalThis),
    now() {
      const current = now;
      now += 7;
      return current;
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
          "io.modelcontextprotocol/clientCapabilities": {
            elicitation: { form: {} },
          },
        },
      },
    }),
  });
}

function terminalEvents(
  events: readonly SupabaseMcpLifecycleEvent[],
): Extract<SupabaseMcpLifecycleEvent, { type: "capability.finished" }>[] {
  return events.filter(
    (
      event,
    ): event is Extract<
      SupabaseMcpLifecycleEvent,
      { type: "capability.finished" }
    > => event.type === "capability.finished",
  );
}

describe("builder-owned lifecycle events", () => {
  it("emits minimal correlated start and finish events for tools, Resources, and prompts", async () => {
    const events: SupabaseMcpLifecycleEvent[] = [];
    const app = createSupabaseMcpInternal(
      {
        server: { name: "observed", version: "1.2.3" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        register(server) {
          server.registerTool("ping", { inputSchema: z.object({}) }, async () =>
            structuredResult({ pong: true }),
          );
          server.registerResource(
            "guide",
            "app://guide",
            { mimeType: "text/plain" },
            async (uri) => ({
              contents: [{ uri: uri.href, text: "Guide" }],
            }),
          );
          server.registerPrompt(
            "welcome",
            { argsSchema: z.object({}) },
            async () => ({
              messages: [
                {
                  role: "user",
                  content: { type: "text", text: "Welcome" },
                },
              ],
            }),
          );
        },
        onEvent(event) {
          events.push(event);
        },
      },
      dependencies(),
    );

    await app.fetch(
      request("tools/call", undefined, { name: "ping", arguments: {} }),
    );
    await app.fetch(
      request("resources/read", undefined, { uri: "app://guide" }),
    );
    await app.fetch(
      request("prompts/get", undefined, { name: "welcome", arguments: {} }),
    );

    expect(
      events.map((event) => [
        event.type,
        event.capability.kind,
        event.capability.name,
      ]),
    ).toEqual([
      ["capability.started", "tool", "ping"],
      ["capability.finished", "tool", "ping"],
      ["capability.started", "resource", "guide"],
      ["capability.finished", "resource", "guide"],
      ["capability.started", "prompt", "welcome"],
      ["capability.finished", "prompt", "welcome"],
    ]);
    expect(events[0]).toEqual({
      schemaVersion: 1,
      type: "capability.started",
      timestamp: "2026-08-29T12:00:00.000Z",
      traceId: "trace-1",
      server: { name: "observed", version: "1.2.3" },
      capability: { kind: "tool", name: "ping" },
      principal: null,
      authentication: { mode: "public", strategy: "public" },
    });
    expect(terminalEvents(events)).toMatchObject([
      { traceId: "trace-1", durationMs: 7, outcome: "success" },
      { traceId: "trace-2", durationMs: 7, outcome: "success" },
      { traceId: "trace-3", durationMs: 7, outcome: "success" },
    ]);
    expect(Object.isFrozen(events[0])).toBe(true);
    expect(Object.isFrozen(events[0]?.capability)).toBe(true);
  });

  it("classifies success, tool-declared errors, input-required results, and thrown failures", async () => {
    const events: SupabaseMcpLifecycleEvent[] = [];
    const app = createSupabaseMcpInternal(
      {
        server: { name: "outcomes", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        register(server) {
          server.registerTool(
            "success",
            { inputSchema: z.object({}) },
            async () => structuredResult({ ok: true }),
          );
          server.registerTool(
            "declared-error",
            { inputSchema: z.object({}) },
            async (): Promise<CallToolResult> => ({
              content: [{ type: "text", text: "private result detail" }],
              isError: true,
            }),
          );
          server.registerTool(
            "needs-input",
            { inputSchema: z.object({}) },
            async () =>
              inputRequired({
                inputRequests: {
                  approval: inputRequired.elicit({
                    message: "Approve?",
                    requestedSchema: z.object({ approved: z.boolean() }),
                  }),
                },
              }),
          );
          server.registerTool(
            "failure",
            { inputSchema: z.object({ secret: z.string() }) },
            async () => {
              throw new Error("private thrown exception detail");
            },
          );
        },
        onEvent(event) {
          events.push(event);
        },
      },
      dependencies(),
    );

    for (const name of [
      "success",
      "declared-error",
      "needs-input",
      "failure",
    ]) {
      await app.fetch(
        request("tools/call", undefined, {
          name,
          arguments: { secret: "private tool argument" },
        }),
      );
    }

    expect(terminalEvents(events).map((event) => event.outcome)).toEqual([
      "success",
      "tool-error",
      "input-required",
      "failure",
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("private tool argument");
    expect(serialized).not.toContain("private result detail");
    expect(serialized).not.toContain("private thrown exception detail");
  });

  it("keeps trace and principal correlation isolated across concurrent callers", async () => {
    const events: SupabaseMcpLifecycleEvent[] = [];
    const app = createSupabaseMcpInternal(
      {
        server: { name: "isolated", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "bearer" },
        register(server, context) {
          server.registerTool(
            "identity",
            { inputSchema: z.object({ secret: z.string() }) },
            async () => {
              await new Promise((resolve) =>
                setTimeout(resolve, context.subject === "alice" ? 2 : 0),
              );
              return structuredResult({
                subject: context.subject,
                privateResult: "result-secret",
              });
            },
          );
        },
        onEvent(event) {
          events.push(event);
        },
      },
      dependencies({
        "token-alice-secret": identity("alice"),
        "token-bob-secret": identity("bob"),
      }),
    );

    await Promise.all(
      Array.from({ length: 12 }, (_, index) => {
        const token =
          index % 2 === 0 ? "token-alice-secret" : "token-bob-secret";
        return app.fetch(
          request("tools/call", token, {
            name: "identity",
            arguments: { secret: `argument-secret-${index}` },
          }),
        );
      }),
    );

    const byTrace = new Map<string, SupabaseMcpLifecycleEvent[]>();
    for (const event of events) {
      const related = byTrace.get(event.traceId) ?? [];
      related.push(event);
      byTrace.set(event.traceId, related);
    }
    expect(byTrace.size).toBe(12);
    for (const related of byTrace.values()) {
      expect(related.map((event) => event.type).sort()).toEqual([
        "capability.finished",
        "capability.started",
      ]);
      expect(
        new Set(related.map((event) => event.principal?.subject)).size,
      ).toBe(1);
    }
    expect(
      terminalEvents(events).filter(
        (event) => event.principal?.subject === "alice",
      ),
    ).toHaveLength(6);
    expect(
      terminalEvents(events).filter(
        (event) => event.principal?.subject === "bob",
      ),
    ).toHaveLength(6);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("token-alice-secret");
    expect(serialized).not.toContain("token-bob-secret");
    expect(serialized).not.toContain("argument-secret");
    expect(serialized).not.toContain("result-secret");
  });

  it("keeps synchronous and asynchronous sink failures out of MCP responses", async () => {
    const errors: string[] = [];
    let invocation = 0;
    const app = createSupabaseMcpInternal(
      {
        server: { name: "fail-open", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        register(server) {
          server.registerTool("ping", { inputSchema: z.object({}) }, async () =>
            structuredResult({ pong: true }),
          );
        },
        onEvent() {
          invocation += 1;
          if (invocation === 1) throw new Error("synchronous sink failure");
          if (invocation === 2) {
            return Promise.reject(new Error("asynchronous sink failure"));
          }
          return new Promise(() => {});
        },
        onError(event) {
          errors.push(`${event.phase}:${event.error.message}`);
        },
      },
      dependencies(),
    );

    const first = await app.fetch(
      request("tools/call", undefined, { name: "ping", arguments: {} }),
    );
    expect((await first.json()).result.structuredContent).toEqual({
      pong: true,
    });
    await Promise.resolve();
    expect(errors).toEqual([
      "events:synchronous sink failure",
      "events:asynchronous sink failure",
    ]);

    const second = await app.fetch(
      request("tools/call", undefined, { name: "ping", arguments: {} }),
    );
    expect((await second.json()).result.structuredContent).toEqual({
      pong: true,
    });

    const guarded = createSupabaseMcpInternal(
      {
        server: { name: "guarded", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        register(server) {
          server.registerTool("ping", { inputSchema: z.object({}) }, async () =>
            structuredResult({ pong: true }),
          );
        },
        onEvent() {
          throw new Error("sink failure");
        },
        onError() {
          throw new Error("operator hook failure");
        },
      },
      dependencies(),
    );
    const guardedResponse = await guarded.fetch(
      request("tools/call", undefined, { name: "ping", arguments: {} }),
    );
    expect((await guardedResponse.json()).result.structuredContent).toEqual({
      pong: true,
    });
  });

  it("does not emit events for a capability disabled by scopes", async () => {
    const events: SupabaseMcpLifecycleEvent[] = [];
    const app = createSupabaseMcpInternal(
      {
        server: { name: "scoped", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "bearer" },
        register(server) {
          server
            .withScopes(["projects:write"])
            .registerTool("write", { inputSchema: z.object({}) }, async () =>
              structuredResult({ written: true }),
            );
        },
        onEvent(event) {
          events.push(event);
        },
      },
      dependencies({ reader: identity("reader") }),
    );

    await app.fetch(
      request("tools/call", "reader", { name: "write", arguments: {} }),
    );
    expect(events).toEqual([]);
  });
});
