import { pipeline } from "@supabase/middleware";
import { withSupabase } from "@supabase/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createSupabaseMcp,
  defineProfiles,
  errorResult,
  guidedResult,
  structuredResult,
  textResult,
  type SupabaseMcpSurfaceProof,
} from "../src/index.js";
import { chumboMcpHandler, withChumbo } from "../src/middleware.js";
import {
  createMcpTestClient,
  createTestAuthHarness,
  lintUnmountedToolReferences,
} from "../src/testing.js";

describe("chumbo/testing client, auth harness, and profiles wiring", () => {
  it("authenticates tokenless asUser via WebCrypto ES256 JWKS and challenges anon with 401", async () => {
    const authHarness = await createTestAuthHarness({
      supabaseUrl: "https://project.supabase.co",
      resourceUrl: "https://project.supabase.co/functions/v1/mcp",
    });

    expect(authHarness.jwks.keys).toHaveLength(1);
    expect(authHarness.jwks.keys[0]?.alg).toBe("ES256");
    expect(authHarness.jwks.keys[0]?.kid).toBe("chumbo-test-es256-1");
    expect("key_ops" in (authHarness.jwks.keys[0] ?? {})).toBe(false);

    const app = createSupabaseMcp({
      server: { name: "testing-harness", version: "1.0.0" },
      resourceUrl: authHarness.resourceUrl,
      auth: { mode: "oauth", scopes: ["items:read"] },
      supabase: { env: authHarness.supabaseEnv },
      register(server, context) {
        server.registerTool(
          "whoami",
          { description: "Return the verified caller identity." },
          async () =>
            guidedResult(
              "Identity resolved.",
              {
                subject: context.subject ?? null,
                scopes: [...context.scopes],
              },
              {
                next: "Call list_items next.",
                warnings: ["Read-only identity check."],
              },
            ),
        );
      },
    });

    const client = createMcpTestClient(app, { authHarness });

    const anonChallenge = await client.anon().exchange("tools/list");
    expect(anonChallenge.status).toBe(401);
    expect(anonChallenge.headers.get("www-authenticate")).toContain(
      "resource_metadata=",
    );

    const alice = client.asUser({
      id: "user-alice",
      email: "alice@example.test",
      scopes: ["items:read", "items:write"],
    });
    const res = await alice.callTool<{
      subject: string;
      scopes: string[];
    }>("whoami");

    expect(res.structuredContent?.subject).toBe("user-alice");
    expect(res.structuredContent?.scopes).toEqual([
      "items:read",
      "items:write",
    ]);
    expect(res.guidance.next).toBe("Call list_items next.");
    expect(res.guidance.warnings).toEqual(["Read-only identity check."]);
    expect(res.text).toContain("Call list_items next.");

    // Helper properties must be non-enumerable and excluded from wire JSON.
    expect(Object.keys(res)).not.toContain("text");
    expect(Object.keys(res)).not.toContain("encodedBytes");
    expect(Object.keys(res)).not.toContain("guidance");
    const wireBytes = new TextEncoder().encode(JSON.stringify(res)).byteLength;
    expect(res.encodedBytes).toBe(wireBytes);
  });

  it("wires options.profiles into createSupabaseMcp with scoped instructions, surface proof profile, and matching digest", async () => {
    const profiles = defineProfiles(
      {
        reader: {
          tools: ["list_docs"],
          aliases: { list_docs: "browse_docs" },
          instructions:
            "Use list_docs to inspect files. Call delete_doc to remove files.",
        },
        admin: {
          tools: ["list_docs", "delete_doc"],
          instructions:
            "Use list_docs to inspect files. Call delete_doc to remove files.",
        },
      },
      {
        references: {
          delete_doc: { unavailable: "document deletion (admin only)" },
        },
      },
    );

    const proofs: SupabaseMcpSurfaceProof[] = [];
    const app = createSupabaseMcp({
      server: { name: "profiled-app", version: "1.0.0" },
      resourceUrl: "https://example.test/functions/v1/mcp",
      supabase: {
        env: {
          url: "https://example.test",
          publishableKeys: { default: "sb_publishable_test" },
          secretKeys: { default: "sb_secret_test" },
        },
      },
      auth: {
        mode: "api-key",
        verify({ token }) {
          if (token === "reader-key") {
            return { subject: "reader-1", scopes: ["docs:read"] };
          }
          if (token === "bad-profile-key") {
            return { subject: "bad-1", scopes: ["bad-profile"] };
          }
          return null;
        },
      },
      profiles: {
        catalog: profiles,
        select(context) {
          if (context.hasScope("bad-profile")) return "nonexistent";
          return "reader";
        },
      },
      onSurface(proof) {
        proofs.push(proof);
      },
      register(server) {
        server.registerTool(
          "list_docs",
          {
            description: "List documents. Use delete_doc to remove one.",
            inputSchema: z.object({
              default: z
                .string()
                .optional()
                .describe("Fallback query before calling delete_doc."),
            }),
          },
          async () => structuredResult({ items: [] }),
        );
        server.registerTool(
          "delete_doc",
          { description: "Delete a document permanently." },
          async () => textResult("deleted"),
        );
      },
    });

    const client = createMcpTestClient(app, {
      endpoint: "https://example.test/functions/v1/mcp",
      knownTools: profiles.vocabulary.knownTools,
    });

    const reader = client.asApiKey("reader-key");
    const snap = await reader.snapshotSurface({ profile: "reader" });

    expect(snap.tools.map((t) => t.name)).toEqual(["browse_docs"]);
    expect(snap.instructions).toContain("browse_docs");
    expect(snap.instructions).not.toContain("delete_doc");
    expect(snap.unmountedReferences).toEqual([]);
    expect(proofs).toHaveLength(1);
    expect(proofs[0]?.profile).toBe("reader");
    expect(proofs[0]?.contentDigest).toBe(snap.contentDigest);

    // Unknown profile returned by selector fails closed with HTTP 500.
    const bad = await client.asApiKey("bad-profile-key").exchange("tools/list");
    expect(bad.status).toBe(500);
  });

  it("wires options.profiles symmetrically into withChumbo + chumboMcpHandler", async () => {
    const authHarness = await createTestAuthHarness({
      supabaseUrl: "https://pipeline.supabase.co",
      resourceUrl: "https://pipeline.supabase.co/functions/v1/mcp",
    });
    const profiles = defineProfiles({
      viewer: {
        tools: ["get_status"],
        instructions: "Use get_status for health checks. Avoid reset_db.",
      },
      operator: {
        tools: ["get_status", "reset_db"],
      },
    });
    const proofs: SupabaseMcpSurfaceProof[] = [];

    const handler = pipeline(
      [
        withSupabase({
          auth: "user",
          cors: "disabled",
          env: authHarness.supabaseEnv,
        }),
        withChumbo({
          server: { name: "pipeline-profiled", version: "1.0.0" },
          resourceUrl: authHarness.resourceUrl,
          profiles: {
            catalog: profiles,
            select: () => "viewer",
          },
          onSurface(proof) {
            proofs.push(proof);
          },
        }),
      ],
      chumboMcpHandler({
        server: { name: "pipeline-profiled", version: "1.0.0" },
        register(server) {
          server.registerTool(
            "get_status",
            { description: "Check status. Do not call reset_db." },
            async () => textResult("ok"),
          );
          server.registerTool(
            "reset_db",
            { description: "Reset database." },
            async () => textResult("reset"),
          );
        },
      }),
    );

    const client = createMcpTestClient(
      (req) => handler(req, { env: authHarness.supabaseEnv } as never),
      { authHarness, knownTools: profiles.vocabulary.knownTools },
    );

    const snap = await client
      .asUser({ id: "user-1" })
      .snapshotSurface({ profile: "viewer" });
    expect(snap.tools.map((t) => t.name)).toEqual(["get_status"]);
    expect(snap.instructions).not.toContain("reset_db");
    expect(snap.unmountedReferences).toEqual([]);
    expect(proofs).toHaveLength(1);
    expect(proofs[0]?.profile).toBe("viewer");
    expect(proofs[0]?.contentDigest).toBe(snap.contentDigest);
  });

  it("lints unmounted tool references including plain-word syntax and schema map properties", () => {
    const findings = lintUnmountedToolReferences({
      instructions:
        "You may read the summary safely, or call read to inspect raw text.",
      tools: [
        {
          name: "list_items",
          description: "List items. Use delete_item to remove entries.",
          inputSchema: {
            type: "object",
            properties: {
              default: {
                type: "string",
                description: "Hint referencing archive_item.",
                examples: ["delete_item"],
              },
            },
          },
        },
      ],
      knownTools: ["list_items", "delete_item", "archive_item", "read"],
    });

    expect(findings.map((f) => `${f.location}:${f.referencedTool}`)).toEqual([
      "instructions:read",
      "list_items.description:delete_item",
      "list_items.inputSchema:archive_item",
    ]);

    // Ordinary English prose with plain-word tool name must not trigger false positives.
    const clean = lintUnmountedToolReferences({
      instructions: "Please read the returned summary carefully.",
      tools: [{ name: "list_items", description: "List items." }],
      knownTools: ["list_items", "read"],
    });
    expect(clean).toEqual([]);
  });

  it("enforces concurrent two-user assertRlsIsolation and catches leaks", async () => {
    const authHarness = await createTestAuthHarness();
    const rowsByUser: Record<string, { id: string; title: string }[]> = {
      "user-a": [{ id: "doc-a", title: "alice-secret-plan" }],
      "user-b": [{ id: "doc-b", title: "bob-secret-deck" }],
    };

    const app = createSupabaseMcp({
      server: { name: "rls-test", version: "1.0.0" },
      resourceUrl: authHarness.resourceUrl,
      auth: { mode: "bearer" },
      supabase: { env: authHarness.supabaseEnv },
      register(server, context) {
        server.registerTool(
          "list_docs",
          { description: "List caller's documents." },
          async () =>
            structuredResult({
              items: rowsByUser[context.subject ?? ""] ?? [],
            }),
        );
        server.registerTool(
          "delete_doc",
          {
            description: "Delete a document owned by the caller.",
            inputSchema: z.object({ id: z.string() }),
          },
          async ({ id }) => {
            const owned = (rowsByUser[context.subject ?? ""] ?? []).some(
              (row) => row.id === id,
            );
            if (!owned) {
              return errorResult("Document not found.", "List your documents.");
            }
            return textResult(`Deleted ${id}`);
          },
        );
      },
    });

    const client = createMcpTestClient(app, { authHarness });
    const alice = client.asUser({ id: "user-a" });
    const bob = client.asUser({ id: "user-b" });

    const { resultA, resultB } = await client.assertRlsIsolation({
      personaA: alice,
      personaB: bob,
      tool: "list_docs",
      mustIsolateForA: ["alice-secret-plan"],
      mustIsolateForB: ["bob-secret-deck"],
      crossAccessProbes: [
        {
          caller: "A",
          tool: "delete_doc",
          arguments: { id: "doc-b" },
          expectOutcome: "error",
        },
        {
          caller: "B",
          tool: "delete_doc",
          arguments: { id: "doc-a" },
          expectOutcome: "error",
        },
      ],
    });
    expect(resultA.isError).toBeUndefined();
    expect(resultB.isError).toBeUndefined();

    // Verify leak detection throws clearly.
    await expect(
      client.assertRlsIsolation({
        personaA: alice,
        personaB: alice,
        tool: "list_docs",
        mustIsolateForA: ["alice-secret-plan"],
      }),
    ).rejects.toThrow(/leaked personaA value/i);
  });
});
