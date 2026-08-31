import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { structuredResult } from "../src/results.js";
import { createSupabaseMcpInternal } from "../src/runtime.js";
import type {
  RuntimeDependencies,
  SupabaseMcpSurfaceProof,
  VerifiedSupabaseIdentity,
} from "../src/types.js";
import { PACKAGE_VERSION } from "../src/version.js";

const RESOURCE_URL = "https://project.supabase.co/functions/v1/mcp";

function identity(subject: string): VerifiedSupabaseIdentity {
  return {
    token: `credential-${subject}`,
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
  return {
    async verifyToken(token) {
      const found = users[token];
      if (!found) throw new Error("rejected credential");
      return found;
    },
    createClient(token) {
      return { token } as unknown as SupabaseClient;
    },
    createAdminClient() {
      return {} as SupabaseClient;
    },
    fetch: globalThis.fetch.bind(globalThis),
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
    "x-private-header": "header-secret",
  });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (typeof params.name === "string") headers.set("mcp-name", params.name);
  return new Request(RESOURCE_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "request-id-secret",
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "surface-proof-test",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
          private: "request-meta-secret",
        },
      },
    }),
  });
}

function legacyRequest(method: string): Request {
  return new Request(RESOURCE_URL, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "legacy-request-id-secret",
      method,
      params: {},
    }),
  });
}

describe("surface proofs", () => {
  it("emits one canonical redacted proof from the successful tools/list result", async () => {
    const proofs: SupabaseMcpSurfaceProof[] = [];
    const description =
      "Find one catalog item by its stable identifier.\n\tUse the returned title in the next step.";
    const app = createSupabaseMcpInternal(
      {
        server: { name: "catalog", version: "2.3.4" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "bearer" },
        register(server) {
          server.registerTool(
            "find_item",
            {
              title: "Find item",
              description,
              inputSchema: z.object({
                item_id: z.string().describe("Stable catalog identifier"),
              }),
              outputSchema: z.object({
                title: z.string(),
              }),
              annotations: {
                title: "Catalog lookup",
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
              },
              _meta: {
                credential: "registration-meta-secret",
              },
            },
            async () => structuredResult({ title: "Private result" }),
          );
        },
        onSurface(proof) {
          proofs.push(proof);
        },
      },
      dependencies({ "credential-alice": identity("alice") }),
    );

    const response = await app.fetch(request("tools/list", "credential-alice"));

    expect(response.status).toBe(200);
    expect(proofs).toHaveLength(1);
    expect(proofs[0]).toMatchObject({
      schemaVersion: 1,
      server: { name: "catalog", version: "2.3.4" },
      runtime: { name: "chumbo", version: PACKAGE_VERSION },
      authentication: { mode: "bearer", strategy: "bearer" },
      protocolVersion: "2026-07-28",
      tools: [
        {
          name: "find_item",
          title: "Find item",
          description,
          annotations: {
            title: "Catalog lookup",
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
      ],
    });
    expect(proofs[0]?.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(proofs[0]?.tools[0]?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        item_id: { type: "string", description: "Stable catalog identifier" },
      },
      required: ["item_id"],
    });
    expect(proofs[0]?.tools[0]?.outputSchema).toMatchObject({
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    });
    expect(Object.isFrozen(proofs[0])).toBe(true);
    expect(Object.isFrozen(proofs[0]?.tools)).toBe(true);
    expect(Object.isFrozen(proofs[0]?.tools[0]?.inputSchema)).toBe(true);

    const serialized = JSON.stringify(proofs[0]);
    for (const forbidden of [
      "alice",
      "credential-alice",
      "request-id-secret",
      "header-secret",
      "request-meta-secret",
      "registration-meta-secret",
      "Private result",
      "principal",
      "scopes",
      "_meta",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("adds no proof hashing when the callback is absent", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");
    const app = createSupabaseMcpInternal(
      {
        server: { name: "plain", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        register(server) {
          server.registerTool("ping", { inputSchema: z.object({}) }, async () =>
            structuredResult({ pong: true }),
          );
        },
      },
      dependencies(),
    );

    const response = await app.fetch(request("tools/list"));

    expect(response.status).toBe(200);
    expect(digest).not.toHaveBeenCalled();
    digest.mockRestore();
  });

  it("derives the same bounded proof from a successful legacy SSE discovery", async () => {
    const proofs: SupabaseMcpSurfaceProof[] = [];
    const app = createSupabaseMcpInternal(
      {
        server: { name: "legacy", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        register(server) {
          server.registerTool("ping", { inputSchema: z.object({}) }, async () =>
            structuredResult({ pong: true }),
          );
        },
        onSurface(proof) {
          proofs.push(proof);
        },
      },
      dependencies(),
    );

    const response = await app.fetch(legacyRequest("tools/list"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(proofs).toHaveLength(1);
    expect(proofs[0]?.tools).toMatchObject([
      { name: "ping", inputSchema: { type: "object" } },
    ]);
    expect(proofs[0]).not.toHaveProperty("protocolVersion");
    expect(JSON.stringify(proofs[0])).not.toContain("legacy-request-id-secret");
  });

  it("does not emit for rejected, failed, non-discovery, paginated, or oversized discovery", async () => {
    const proofs: SupabaseMcpSurfaceProof[] = [];
    const protectedApp = createSupabaseMcpInternal(
      {
        server: { name: "protected", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "bearer" },
        register(server) {
          server.registerTool("ping", { inputSchema: z.object({}) }, async () =>
            structuredResult({ pong: true }),
          );
        },
        onSurface(proof) {
          proofs.push(proof);
        },
      },
      dependencies({ "credential-alice": identity("alice") }),
    );

    expect(
      (await protectedApp.fetch(request("tools/list", "wrong"))).status,
    ).toBe(401);
    expect(
      (
        await protectedApp.fetch(
          request("tools/call", "credential-alice", {
            name: "ping",
            arguments: {},
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await protectedApp.fetch(
          request("tools/list", "credential-alice", { cursor: "next-secret" }),
        )
      ).status,
    ).toBe(200);

    const oversized = createSupabaseMcpInternal(
      {
        server: { name: "oversized", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        register(server) {
          for (let index = 0; index < 257; index += 1) {
            server.registerTool(
              `tool_${index.toString().padStart(3, "0")}`,
              { inputSchema: z.object({}) },
              async () => structuredResult({ ok: true }),
            );
          }
        },
        onSurface(proof) {
          proofs.push(proof);
        },
      },
      dependencies(),
    );
    expect((await oversized.fetch(request("tools/list"))).status).toBe(200);

    const oversizedMetadata = createSupabaseMcpInternal(
      {
        server: { name: "s".repeat(200_000), version: "v".repeat(200_000) },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        register(server) {
          server.registerTool("ping", { inputSchema: z.object({}) }, async () =>
            structuredResult({ pong: true }),
          );
        },
        onSurface(proof) {
          proofs.push(proof);
        },
      },
      dependencies(),
    );
    expect((await oversizedMetadata.fetch(request("tools/list"))).status).toBe(
      200,
    );

    const oversizedAuth = createSupabaseMcpInternal(
      {
        server: { name: "auth-bounded", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "bearer", strategy: "a".repeat(200_000) },
        register(server) {
          server.registerTool("ping", { inputSchema: z.object({}) }, async () =>
            structuredResult({ pong: true }),
          );
        },
        onSurface(proof) {
          proofs.push(proof);
        },
      },
      dependencies({ "credential-alice": identity("alice") }),
    );
    expect(
      (await oversizedAuth.fetch(request("tools/list", "credential-alice")))
        .status,
    ).toBe(200);
    expect(proofs).toEqual([]);
  });

  it("returns a real streamed discovery promptly when observation exceeds its byte bound", async () => {
    const proofs: SupabaseMcpSurfaceProof[] = [];
    const hugeDescription = "x".repeat(600 * 1024);
    const app = createSupabaseMcpInternal(
      {
        server: { name: "streamed", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        register(server) {
          server.registerTool(
            "huge",
            { description: hugeDescription, inputSchema: z.object({}) },
            async () => structuredResult({ ok: true }),
          );
        },
        onSurface(proof) {
          proofs.push(proof);
        },
      },
      dependencies(),
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("oversized surface observation stalled")),
        1_000,
      );
    });
    let response: Response;
    try {
      response = await Promise.race([
        app.fetch(request("tools/list")),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBeNull();
    const body = await response.json();
    expect(body.result.tools[0].description).toHaveLength(600 * 1024);
    expect(proofs).toEqual([]);
  });

  it("caps the complete proof envelope after metadata is added", async () => {
    const proofs: SupabaseMcpSurfaceProof[] = [];
    const server = {
      name: "s".repeat(1_024),
      version: "v".repeat(256),
    };
    const title = "t".repeat(32 * 1024);
    const description = "d".repeat(32 * 1024);
    const annotationTitle = "a".repeat(32 * 1024);
    const app = createSupabaseMcpInternal(
      {
        server,
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        register(mcp) {
          mcp.registerTool(
            "alpha",
            {
              title,
              description,
              annotations: { title: annotationTitle },
              inputSchema: z.object({}).describe("i".repeat(64_000)),
            },
            async () => structuredResult({ ok: true }),
          );
          mcp.registerTool(
            "beta",
            {
              title,
              description,
              annotations: { title: annotationTitle },
              inputSchema: z.object({}),
            },
            async () => structuredResult({ ok: true }),
          );
        },
        onSurface(proof) {
          proofs.push(proof);
        },
      },
      dependencies(),
    );

    const response = await app.fetch(request("tools/list"));
    const body = await response.json();
    const content = { schemaVersion: 1, tools: body.result.tools };
    const contentBytes = new TextEncoder().encode(
      JSON.stringify(content),
    ).byteLength;
    const completeBytes = new TextEncoder().encode(
      JSON.stringify({
        ...content,
        server,
        runtime: { name: "chumbo", version: PACKAGE_VERSION },
        authentication: { mode: "public", strategy: "public" },
        protocolVersion: "2026-07-28",
        contentDigest: `sha256:${"0".repeat(64)}`,
      }),
    ).byteLength;

    expect(response.status).toBe(200);
    expect(contentBytes).toBeLessThan(256 * 1024);
    expect(completeBytes).toBeGreaterThan(256 * 1024);
    expect(proofs).toEqual([]);
  });

  it("keeps the digest stable across registration and schema-key order", async () => {
    const proofs: SupabaseMcpSurfaceProof[] = [];
    const create = (reverse: boolean) =>
      createSupabaseMcpInternal(
        {
          server: { name: "stable", version: "1.0.0" },
          resourceUrl: RESOURCE_URL,
          auth: { mode: "public" },
          register(server) {
            const registrations = [
              () =>
                server.registerTool(
                  "alpha",
                  {
                    inputSchema: reverse
                      ? z.object({
                          second: z.number().optional(),
                          first: z.string().optional(),
                        })
                      : z.object({
                          first: z.string().optional(),
                          second: z.number().optional(),
                        }),
                  },
                  async () => structuredResult({ ok: true }),
                ),
              () =>
                server.registerTool(
                  "beta",
                  { inputSchema: z.object({ enabled: z.boolean() }) },
                  async () => structuredResult({ ok: true }),
                ),
            ];
            for (const register of reverse
              ? registrations.reverse()
              : registrations) {
              register();
            }
          },
          onSurface(proof) {
            proofs.push(proof);
          },
        },
        dependencies(),
      );

    await create(false).fetch(request("tools/list"));
    await create(true).fetch(request("tools/list"));

    expect(proofs).toHaveLength(2);
    expect(proofs[0]?.tools.map((tool) => tool.name)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(proofs[1]?.tools.map((tool) => tool.name)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(proofs[0]?.contentDigest).toBe(proofs[1]?.contentDigest);
  });

  it("uses runtime-independent UTF-16 ordering while preserving schema arrays", async () => {
    const proofs: SupabaseMcpSurfaceProof[] = [];
    const toolNames = ["😀", "é", "z", "e\u0301"];
    const propertyNames = ["😀", "é", "z", "e\u0301"];
    const create = (reverse: boolean) =>
      createSupabaseMcpInternal(
        {
          server: { name: "unicode", version: "1.0.0" },
          resourceUrl: RESOURCE_URL,
          auth: { mode: "public" },
          register(server) {
            const orderedTools = reverse ? [...toolNames].reverse() : toolNames;
            for (const name of orderedTools) {
              const orderedProperties = reverse
                ? [...propertyNames].reverse()
                : propertyNames;
              const shape = Object.fromEntries(
                orderedProperties.map((property) => [
                  property,
                  property === "é"
                    ? z.enum(["é", "e\u0301", "😀"]).optional()
                    : z.string().optional(),
                ]),
              );
              server.registerTool(
                name,
                { inputSchema: z.object(shape) },
                async () => structuredResult({ ok: true }),
              );
            }
          },
          onSurface(proof) {
            proofs.push(proof);
          },
        },
        dependencies(),
      );

    await create(false).fetch(request("tools/list"));
    await create(true).fetch(request("tools/list"));

    const expectedOrder = ["e\u0301", "z", "é", "😀"];
    expect(proofs).toHaveLength(2);
    for (const proof of proofs) {
      expect(proof.tools.map((tool) => tool.name)).toEqual(expectedOrder);
      const properties = proof.tools[0]?.inputSchema.properties as Record<
        string,
        { enum?: string[] }
      >;
      expect(Object.keys(properties)).toEqual(expectedOrder);
      expect(properties["é"]?.enum).toEqual(["é", "e\u0301", "😀"]);
    }
    expect(proofs[0]?.contentDigest).toBe(proofs[1]?.contentDigest);
  });

  it("isolates concurrent authorized surfaces without exporting caller facts", async () => {
    const proofs: SupabaseMcpSurfaceProof[] = [];
    const app = createSupabaseMcpInternal(
      {
        server: { name: "scoped", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "bearer" },
        access: {
          resolveScopes(context) {
            return context.subject === "writer" ? ["write"] : ["read"];
          },
        },
        register(server) {
          server
            .withScopes(["read"])
            .registerTool("read", { inputSchema: z.object({}) }, async () =>
              structuredResult({ ok: true }),
            );
          server
            .withScopes(["write"])
            .registerTool("write", { inputSchema: z.object({}) }, async () =>
              structuredResult({ ok: true }),
            );
        },
        onSurface(proof) {
          proofs.push(proof);
        },
      },
      dependencies({
        "credential-reader": identity("reader"),
        "credential-writer": identity("writer"),
      }),
    );

    await Promise.all([
      app.fetch(request("tools/list", "credential-reader")),
      app.fetch(request("tools/list", "credential-writer")),
    ]);

    expect(proofs).toHaveLength(2);
    expect(
      proofs.map((proof) => proof.tools.map((tool) => tool.name)).sort(),
    ).toEqual([["read"], ["write"]]);
    const serialized = JSON.stringify(proofs);
    expect(serialized).not.toContain("reader");
    expect(serialized).not.toContain("writer");
    expect(serialized).not.toContain("credential-");
    expect(serialized).not.toContain("scopes");
  });

  it("keeps synchronous and asynchronous surface sink failures out of discovery", async () => {
    const errors: string[] = [];
    let calls = 0;
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
        onSurface() {
          calls += 1;
          if (calls === 1) throw new Error("synchronous surface sink failure");
          return Promise.reject(new Error("asynchronous surface sink failure"));
        },
        onError(event) {
          errors.push(`${event.phase}:${event.error.message}`);
        },
      },
      dependencies(),
    );

    const first = await app.fetch(request("tools/list"));
    expect(first.status).toBe(200);
    const second = await app.fetch(request("tools/list"));
    expect(second.status).toBe(200);
    await Promise.resolve();
    expect(errors).toEqual([
      "surface:synchronous surface sink failure",
      "surface:asynchronous surface sink failure",
    ]);
  });
});
