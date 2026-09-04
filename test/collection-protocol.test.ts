import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  collectionInputSchema,
  collectionOutputSchema,
  collectionResult,
} from "../src/index.js";
import { createSupabaseMcpInternal } from "../src/runtime.js";
import type { RuntimeDependencies } from "../src/types.js";

const url = "https://project.supabase.co/functions/v1/mcp";
const itemSchema = z.object({ id: z.string(), label: z.string() });
function request(token: string, args: Record<string, unknown>) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "mcp-method": "tools/call",
      "mcp-name": "list_records",
      "mcp-protocol-version": "2026-07-28",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: {
        name: "list_records",
        arguments: args,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "collection-test",
            version: "1",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

describe("collection MCP transport", () => {
  it("rechecks authority on every page, preserves filters, and budgets cumulative middleware", async () => {
    const active = new Set(["alice", "bob"]);
    const verified: string[] = [];
    const clients: object[] = [];
    const errors: unknown[] = [];
    let rows = [
      {
        id: "1",
        owner: "alice",
        label: "First",
        category: "open",
        secret: "full-record-leak",
      },
      {
        id: "2",
        owner: "alice",
        label: "Second",
        category: "open",
        secret: "full-record-leak",
      },
      {
        id: "3",
        owner: "bob",
        label: "Bob only",
        category: "open",
        secret: "full-record-leak",
      },
      {
        id: "4",
        owner: "alice",
        label: "Closed",
        category: "closed",
        secret: "full-record-leak",
      },
    ];
    const deps: RuntimeDependencies<any> = {
      async verifyToken(token) {
        verified.push(token);
        if (!active.has(token)) throw new Error("revoked");
        return {
          token,
          userClaims: { id: token, role: "authenticated" },
          jwtClaims: { sub: token, exp: Math.floor(Date.now() / 1000) + 3600 },
        };
      },
      createClient(token) {
        const client = { token };
        clients.push(client);
        return client as unknown as SupabaseClient;
      },
      createAdminClient() {
        throw new Error("No privileged client needed");
      },
      async fetch() {
        throw new Error("No remote fetch needed");
      },
      randomUUID: () => crypto.randomUUID(),
    };
    const app = createSupabaseMcpInternal(
      {
        server: { name: "collections", version: "1" },
        resourceUrl: url,
        auth: { mode: "bearer" },
        onError: (event) => {
          errors.push(event);
        },
        resultMiddleware: [
          ({ result }) => ({
            append: [
              {
                type: "text",
                text:
                  "Continue only if needed." +
                  " ".repeat(
                    Math.floor(
                      (1000 -
                        new TextEncoder().encode(JSON.stringify(result))
                          .byteLength) /
                        2,
                    ),
                  ),
              },
            ],
          }),
          ({ result }) => ({
            prepend: [
              {
                type: "text",
                text:
                  "More optional guidance." +
                  " ".repeat(
                    Math.floor(
                      (1000 -
                        new TextEncoder().encode(JSON.stringify(result))
                          .byteLength) /
                        2,
                    ),
                  ),
              },
            ],
          }),
        ],
        register(server, ctx) {
          server.registerTool(
            "list_records",
            {
              inputSchema: collectionInputSchema({
                defaultLimit: 1,
                cursorSchema: z.string().regex(/^\d+$/),
              }).extend({ category: z.enum(["open", "closed"]) }),
              outputSchema: collectionOutputSchema(itemSchema),
            },
            async ({ limit, cursor, category }) => {
              // This fixture's data plane models the request-scoped client applying RLS.
              const owner = (ctx.supabase as unknown as { token: string })
                .token;
              const visible = rows
                .filter(
                  (row) =>
                    row.owner === owner &&
                    row.category === category &&
                    (!cursor || row.id > cursor),
                )
                .sort((a, b) => a.id.localeCompare(b.id))
                .slice(0, limit + 1);
              return collectionResult({
                items: visible,
                limit,
                hasMore: false,
                itemSchema,
                project: ({ id, label }) => ({ id, label }),
                cursorFor: ({ id }) => id,
                tool: "list_records",
                arguments: { category, ...(cursor ? { cursor } : {}) },
                mode: "hybrid",
                maxBytes: 1000,
                render: ({ items }) =>
                  items.map(({ id, label }) => `${id}: ${label}`).join("\n"),
                onOversizedItem: ({ id }) => `call get_record with id ${id}`,
              });
            },
          );
        },
      },
      deps,
    );
    const first = await (
      await app.fetch(request("alice", { category: "open" }))
    ).json();
    expect(first.error).toBeUndefined();
    const page = first.result.structuredContent;
    expect(page.items).toEqual([{ id: "1", label: "First" }]);
    expect(page.next_call.arguments).toEqual({
      category: "open",
      cursor: "1",
      limit: 1,
    });
    expect(JSON.stringify(first.result)).not.toContain("full-record-leak");
    expect(
      new TextEncoder().encode(JSON.stringify(first.result)).byteLength,
    ).toBeLessThanOrEqual(1000);
    expect(first.result.content.at(-1).text.trim()).toBe(
      "Continue only if needed.",
    );
    expect(errors.length).toBe(1);
    // Rows before the stable key can disappear; later rows can be inserted. No snapshot is implied.
    rows = rows.filter((row) => row.id !== "1");
    rows.push({
      id: "15",
      owner: "alice",
      label: "Inserted after cursor",
      category: "open",
      secret: "full-record-leak",
    });
    const second = await (
      await app.fetch(request("alice", page.next_call.arguments))
    ).json();
    expect(second.result.structuredContent.items[0].id).toBe("15");
    const bob = await (
      await app.fetch(request("bob", page.next_call.arguments))
    ).json();
    expect(bob.result.structuredContent.items).toEqual([
      { id: "3", label: "Bob only" },
    ]);
    const invalid = await (
      await app.fetch(request("alice", { category: "open", cursor: "invalid" }))
    ).json();
    expect(invalid.error ?? invalid.result?.isError).toBeTruthy();
    active.delete("alice");
    expect(
      (await app.fetch(request("alice", page.next_call.arguments))).status,
    ).toBe(401);
    expect(verified).toEqual(["alice", "alice", "bob", "alice", "alice"]);
    expect(new Set(clients).size).toBe(clients.length);
    // Even with an outputSchema, overflow is a valid tool-level error rather than invalid structured output.
    rows = [
      {
        id: "3",
        owner: "bob",
        label: "x".repeat(10000),
        category: "open",
        secret: "full-record-leak",
      },
    ];
    const overflow = await (
      await app.fetch(request("bob", { category: "open" }))
    ).json();
    expect(overflow.error).toBeUndefined();
    expect(overflow.result.isError).toBe(true);
    expect(overflow.result.content[0].text).toContain("get_record with id 3");
    expect(overflow.result).not.toHaveProperty("structuredContent");
  });
});
