import { acceptedContent, inputRequired } from "@modelcontextprotocol/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  errorResult,
  renderResult,
  resourceResult,
  structuredResult,
  textResult,
} from "../src/results.js";
import { createSupabaseMcpInternal } from "../src/runtime.js";
import type { RuntimeDependencies } from "../src/types.js";

const RESOURCE_URL = "https://project.supabase.co/functions/v1/mcp";

function dependencies(): RuntimeDependencies<any> {
  let sequence = 0;
  return {
    async verifyToken() {
      throw new Error("not used");
    },
    createClient() {
      return {} as SupabaseClient;
    },
    createAdminClient() {
      return {} as SupabaseClient;
    },
    async fetch() {
      throw new Error("not used");
    },
    randomUUID() {
      sequence += 1;
      return `trace-${sequence}`;
    },
  };
}

function request(name: string): Request {
  return new Request(RESOURCE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-method": "tools/call",
      "mcp-name": name,
      "mcp-protocol-version": "2026-07-28",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: {
        name,
        arguments: {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "result-middleware-test",
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

function textBlocks(result: {
  content: Array<{ type: string; text?: string }>;
}): string[] {
  return result.content.flatMap((block) =>
    block.type === "text" && block.text !== undefined ? [block.text] : [],
  );
}

describe("result middleware", () => {
  it("adds ordered content to ordinary and scoped tools from one immutable authored snapshot", async () => {
    const snapshots: unknown[] = [];
    const app = createSupabaseMcpInternal(
      {
        server: { name: "results", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public", scopes: ["results:read"] },
        resultMiddleware: [
          ({ result, tool }) => {
            snapshots.push(result);
            expect(tool.name).toBe("hybrid");
            expect(Object.isFrozen(result)).toBe(true);
            expect(Object.isFrozen(result.content)).toBe(true);
            expect(Object.isFrozen(result.structuredContent)).toBe(true);
            expect(() =>
              (result.content as unknown[]).push({
                type: "text",
                text: "mutation",
              }),
            ).toThrow();
            expect(() =>
              Object.assign(result.structuredContent as object, {
                projectId: "mutated",
              }),
            ).toThrow();
            return {
              prepend: [{ type: "text", text: "First before" }],
              append: [{ type: "text", text: "First after" }],
            };
          },
          ({ result }) => {
            snapshots.push(result);
            return {
              prepend: [{ type: "text", text: "Second before" }],
              append: [{ type: "text", text: "Second after" }],
            };
          },
        ],
        register(server) {
          server
            .withScopes(["results:read"])
            .registerTool(
              "hybrid",
              { inputSchema: z.object({}) },
              async () => ({
                ...renderResult({ projectId: "p1" }, () => "Authored result"),
                _meta: { "ui/resourceUri": "ui://projects/view" },
              }),
            );
        },
      },
      dependencies(),
    );

    const response = await app.fetch(request("hybrid"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(textBlocks(body.result)).toEqual([
      "First before",
      "Second before",
      "Authored result",
      "First after",
      "Second after",
    ]);
    expect(body.result.structuredContent).toEqual({ projectId: "p1" });
    expect(body.result._meta).toMatchObject({
      "ui/resourceUri": "ui://projects/view",
    });
    expect(snapshots[0]).toBe(snapshots[1]);
  });

  it("preserves structured and Resource results while skipping tool errors", async () => {
    const visited: string[] = [];
    const app = createSupabaseMcpInternal(
      {
        server: { name: "results", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        resultMiddleware({ tool }) {
          visited.push(tool.name);
          return { append: [{ type: "text", text: "Guidance" }] };
        },
        register(server) {
          server.registerTool(
            "structured",
            { inputSchema: z.object({}) },
            async () => structuredResult({ ok: true }),
          );
          server.registerTool(
            "resource",
            { inputSchema: z.object({}) },
            async () =>
              resourceResult("Open the guide", {
                type: "resource_link",
                uri: "app://guides/results",
                name: "results-guide",
              }),
          );
          server.registerTool(
            "failure",
            { inputSchema: z.object({}) },
            async () => errorResult("Not available", "try again later."),
          );
        },
      },
      dependencies(),
    );

    const structured = (await (await app.fetch(request("structured"))).json())
      .result;
    const resource = (await (await app.fetch(request("resource"))).json())
      .result;
    const failure = (await (await app.fetch(request("failure"))).json()).result;

    expect(structured.structuredContent).toEqual({ ok: true });
    expect(textBlocks(structured)).toEqual(["Guidance"]);
    expect(resource.content[1]).toMatchObject({
      type: "resource_link",
      uri: "app://guides/results",
    });
    expect(textBlocks(resource)).toEqual(["Open the guide", "Guidance"]);
    expect(failure.isError).toBe(true);
    expect(textBlocks(failure)).toEqual([
      "Not available\n\n→ Next: try again later.",
    ]);
    expect(visited).toEqual(["structured", "resource"]);
  });

  it("skips input-required results", async () => {
    let calls = 0;
    const app = createSupabaseMcpInternal(
      {
        server: { name: "results", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        resultMiddleware() {
          calls += 1;
          return { append: [{ type: "text", text: "Guidance" }] };
        },
        register(server) {
          server.registerTool(
            "confirm",
            { inputSchema: z.object({}) },
            async (_args, serverContext) => {
              const response = acceptedContent<{ confirm: boolean }>(
                serverContext.mcpReq.inputResponses,
                "confirmation",
              );
              return response
                ? textResult("Confirmed")
                : inputRequired({
                    inputRequests: {
                      confirmation: inputRequired.elicit({
                        message: "Confirm?",
                        requestedSchema: z.object({ confirm: z.boolean() }),
                      }),
                    },
                  });
            },
          );
        },
      },
      dependencies(),
    );

    const body = await (await app.fetch(request("confirm"))).json();
    expect(body.result.resultType).toBe("input_required");
    expect(calls).toBe(0);
  });

  it("keeps valid additions when later middleware fails or exceeds cumulative bounds", async () => {
    const errors: Array<{ phase: string; message: string; traceId?: string }> =
      [];
    const app = createSupabaseMcpInternal(
      {
        server: { name: "results", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        resultMiddleware: [
          () => ({ append: [{ type: "text", text: "Valid first" }] }),
          () => {
            throw new Error("middleware unavailable");
          },
          () => ({
            append: Array.from({ length: 16 }, (_, index) => ({
              type: "text" as const,
              text: `too-many-${index}`,
            })),
          }),
          () => ({ append: [{ type: "text", text: "Valid last" }] }),
        ],
        register(server) {
          server.registerTool("ping", { inputSchema: z.object({}) }, async () =>
            textResult("Pong"),
          );
        },
        async onError(event) {
          errors.push({
            phase: event.phase,
            message: event.error.message,
            traceId: event.traceId,
          });
          throw new Error("logger unavailable");
        },
      },
      dependencies(),
    );

    const body = await (await app.fetch(request("ping"))).json();
    expect(textBlocks(body.result)).toEqual([
      "Pong",
      "Valid first",
      "Valid last",
    ]);
    expect(errors).toEqual([
      {
        phase: "results",
        message: "middleware unavailable",
        traceId: "trace-1",
      },
      {
        phase: "results",
        message: "Result composition may add at most 16 content blocks",
        traceId: "trace-1",
      },
    ]);
  });

  it("rejects malformed additions and does not run after an authored failure", async () => {
    const visited: string[] = [];
    const errors: string[] = [];
    const app = createSupabaseMcpInternal(
      {
        server: { name: "results", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        resultMiddleware({ tool }) {
          visited.push(tool.name);
          return {
            append: [{ type: "not-mcp-content" } as never],
          };
        },
        register(server) {
          server.registerTool(
            "malformed",
            { inputSchema: z.object({}) },
            async () => textResult("Authored result"),
          );
          server.registerTool(
            "throws",
            { inputSchema: z.object({}) },
            async () => {
              throw new Error("authored failure");
            },
          );
        },
        onError({ phase, error }) {
          if (phase === "results") errors.push(error.message);
        },
      },
      dependencies(),
    );

    const malformed = await (await app.fetch(request("malformed"))).json();
    const failed = await (await app.fetch(request("throws"))).json();

    expect(textBlocks(malformed.result)).toEqual(["Authored result"]);
    expect(failed.result.isError).toBe(true);
    expect(visited).toEqual(["malformed"]);
    expect(errors).toEqual([
      "Result composition may add only valid MCP content blocks",
    ]);
  });

  it("keeps request context isolated across concurrent calls", async () => {
    const app = createSupabaseMcpInternal(
      {
        server: { name: "results", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        async resultMiddleware({ context }) {
          await Promise.resolve();
          return {
            append: [{ type: "text", text: `Middleware ${context.traceId}` }],
          };
        },
        register(server, context) {
          server.registerTool(
            "trace",
            { inputSchema: z.object({}) },
            async () => textResult(`Handler ${context.traceId}`),
          );
        },
      },
      dependencies(),
    );

    const [first, second] = await Promise.all([
      app.fetch(request("trace")).then((response) => response.json()),
      app.fetch(request("trace")).then((response) => response.json()),
    ]);
    const results = [textBlocks(first.result), textBlocks(second.result)];
    expect(results).toContainEqual(["Handler trace-1", "Middleware trace-1"]);
    expect(results).toContainEqual(["Handler trace-2", "Middleware trace-2"]);
  });

  it("rejects an unbounded middleware chain at configuration time", () => {
    expect(() =>
      createSupabaseMcpInternal(
        {
          server: { name: "results", version: "1.0.0" },
          resourceUrl: RESOURCE_URL,
          auth: { mode: "public" },
          resultMiddleware: Array.from({ length: 17 }, () => () => undefined),
          register() {},
        },
        dependencies(),
      ),
    ).toThrow(/at most 16 result middleware functions/);
  });
});
