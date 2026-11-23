import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  gatherDevStartupBanner,
  startDevWorkbench,
} from "../src/dev-workbench.js";
import {
  assertLoopbackEndpoint,
  resolveLocalPersonas,
  resolveLocalSupabaseStack,
  type LocalPersonaDeps,
} from "../src/local-personas.js";
import { buildLockedSurfaceEntry } from "../src/surface-diff.js";
import { runSurfaceDiff, runSurfaceSnapshot } from "../src/surface-lock.js";
import { parseTryArgs, runTry } from "../src/try.js";

function mockSupabaseClients(options: {
  users: Array<{ id: string; email: string | null }>;
  onGenerateLink?: (email: string) => void;
  onCreateUser?: (email: string) => void;
  onDeleteUser?: (id: string) => void;
  onSignOut?: () => void;
}): LocalPersonaDeps {
  const users = [...options.users];
  const admin = {
    auth: {
      admin: {
        async getUserById(id: string) {
          const found = users.find((u) => u.id === id);
          return found
            ? { data: { user: found }, error: null }
            : { data: { user: null }, error: { message: "not found" } };
        },
        async listUsers() {
          return { data: { users: [...users] }, error: null };
        },
        async generateLink({ email }: { email: string }) {
          options.onGenerateLink?.(email);
          return {
            data: { properties: { hashed_token: `hash-for-${email}` } },
            error: null,
          };
        },
        async createUser({ email }: { email: string }) {
          options.onCreateUser?.(email);
          const created = { id: `ephem-${users.length + 1}`, email };
          users.push(created);
          return { data: { user: created }, error: null };
        },
        async deleteUser(id: string) {
          options.onDeleteUser?.(id);
          return { data: {}, error: null };
        },
      },
    },
  } as unknown as SupabaseClient;

  const anon = {
    auth: {
      async verifyOtp({ token_hash }: { token_hash: string }) {
        return {
          data: {
            session: {
              access_token: `secret-jwt-${token_hash}`,
            },
          },
          error: null,
        };
      },
      async signOut() {
        options.onSignOut?.();
        return { error: null };
      },
    },
  } as unknown as SupabaseClient;

  return {
    async readSupabaseStatus() {
      return {
        API_URL: "http://127.0.0.1:54321",
        PUBLISHABLE_KEY: "local-pub-key",
        SECRET_KEY: "local-secret-key",
      };
    },
    createAdminClient: () => admin,
    createAnonClient: () => anon,
  };
}

describe("local-personas security gates and chumbo try", () => {
  it("Gate 1: refuses non-loopback MCP endpoints before inspecting supabase status", async () => {
    const readStatus = vi.fn();
    await expect(
      resolveLocalPersonas({
        projectRoot: "/tmp/unused",
        endpointUrl: "https://abc.supabase.co/functions/v1/mcp",
        specifiers: ["alice@example.com"],
        deps: { readSupabaseStatus: readStatus },
      }),
    ).rejects.toThrow(/refuses non-loopback URL/i);
    expect(readStatus).not.toHaveBeenCalled();
    expect(() =>
      assertLoopbackEndpoint("http://127.0.0.1:54321/functions/v1/mcp"),
    ).not.toThrow();
  });

  it("Gate 2: refuses non-loopback API_URL from supabase status and ignores ambient SUPABASE_SECRET_KEY", async () => {
    await expect(
      resolveLocalSupabaseStack("/tmp/unused", {
        async readSupabaseStatus() {
          return {
            API_URL: "https://prod.supabase.co",
            PUBLISHABLE_KEY: "pub",
            SECRET_KEY: "sec",
          };
        },
        env: { SUPABASE_SECRET_KEY: "prod-ambient-secret" },
      }),
    ).rejects.toThrow(/non-loopback Supabase API_URL/i);
  });

  it("Gate 3: never calls generateLink for missing seed users and cleans up sessions/ephemeral users", async () => {
    const generateLink = vi.fn();
    const deleteUser = vi.fn();
    const signOut = vi.fn();
    const deps = mockSupabaseClients({
      users: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          email: "alice@example.com",
        },
      ],
      onGenerateLink: generateLink,
      onDeleteUser: deleteUser,
      onSignOut: signOut,
    });

    await expect(
      resolveLocalPersonas({
        projectRoot: "/tmp/unused",
        endpointUrl: "http://127.0.0.1:54321/functions/v1/mcp",
        specifiers: ["typo@example.com"],
        deps,
      }),
    ).rejects.toThrow(/alice@example\.com/);
    expect(generateLink).not.toHaveBeenCalled();

    // Existing alias resolves and never exposes raw JWT in descriptor JSON
    const resolved = await resolveLocalPersonas({
      projectRoot: "/tmp/unused",
      endpointUrl: "http://127.0.0.1:54321/functions/v1/mcp",
      specifiers: ["alice", "bob"],
      ephemeralUsers: true,
      deps,
    });
    expect(resolved).toHaveLength(2);
    expect(JSON.stringify(resolved.map((p) => p.descriptor))).not.toContain(
      "secret-jwt-",
    );
    expect(resolved[0]!.getToken()).toBe(
      "secret-jwt-hash-for-alice@example.com",
    );
    await Promise.all(resolved.map((p) => p.cleanup()));
    expect(signOut).toHaveBeenCalledTimes(2);
    expect(deleteUser).toHaveBeenCalledTimes(1);
  });

  it("validates --args without ever echoing raw argument payloads on error", async () => {
    const secretPayload = '{"apiSecret":"do-not-echo-this-secret"}';
    await expect(
      parseTryArgs({ tool: null, argsFlag: secretPayload }),
    ).rejects.toThrow("--args requires a <tool> name.");

    try {
      await parseTryArgs({ tool: null, argsFlag: secretPayload });
    } catch (error) {
      expect(String(error)).not.toContain("do-not-echo-this-secret");
    }

    await expect(
      parseTryArgs({
        tool: "whoami",
        argsFlag: secretPayload,
        callArgsFlag: "{}",
      }),
    ).rejects.toThrow(/not both/i);

    try {
      await parseTryArgs({ tool: "whoami", argsFlag: "{bad-secret-value" });
    } catch (error) {
      expect(String(error)).not.toContain("bad-secret-value");
    }
  });

  it("enforces --yes write gate in --json mode (preserving @file) and diffs two-persona RLS results", async () => {
    const deps = mockSupabaseClients({
      users: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          email: "alice@example.com",
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          email: "bob@example.com",
        },
      ],
    });

    let callCount = 0;
    const fetchMock = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method: string;
        params?: { name?: string };
      };
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      const isAlice = auth.includes("alice@example.com");
      if (body.method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0",
          id: "1",
          result: {
            tools: [
              {
                name: "list_projects",
                description: "List caller projects.",
                inputSchema: { type: "object", properties: {} },
                annotations: { readOnlyHint: true },
              },
              {
                name: "delete_project",
                description: "Delete one project.",
                inputSchema: {
                  type: "object",
                  properties: { id: { type: "string" } },
                },
                annotations: { readOnlyHint: false, destructiveHint: true },
              },
            ],
          },
        });
      }
      callCount += 1;
      return Response.json({
        jsonrpc: "2.0",
        id: "2",
        result: {
          content: [
            {
              type: "text",
              text: isAlice ? "Alice project" : "Bob project",
            },
          ],
          structuredContent: {
            projects: [
              isAlice
                ? { id: "proj_alice", name: "Alice Workspace" }
                : { id: "proj_bob", name: "Bob Workspace" },
            ],
          },
        },
      });
    };

    const tempRoot = await mkdtemp(join(tmpdir(), "chumbo-try-test-"));
    try {
      await mkdir(join(tempRoot, "supabase"), { recursive: true });
      await writeFile(
        join(tempRoot, "supabase", "config.toml"),
        'project_id = "try-test"\n[api]\nport = 54321\n',
      );

      // 1. Non-read-only tool in --json without --yes -> needs_confirmation, 0 tools/call, preserves @payload.json
      const confirmReport = await runTry({
        cwd: tempRoot,
        tool: "delete_project",
        args: { id: "proj_alice" },
        rawArgsSource: "@payload.json",
        as: ["alice", "bob"],
        json: true,
        fetchImpl: fetchMock,
        personaDeps: deps,
      });
      expect(confirmReport.status).toBe("needs_confirmation");
      expect(confirmReport.nextCommand).toContain("--args @payload.json");
      expect(confirmReport.nextCommand).toContain("--yes --json");
      expect(callCount).toBe(0);

      // 2. Read-only tool runs immediately and detects isolated-different with 0 shared IDs
      const readReport = await runTry({
        cwd: tempRoot,
        tool: "list_projects",
        as: ["alice", "bob"],
        json: true,
        fetchImpl: fetchMock,
        personaDeps: deps,
      });
      expect(readReport.status).toBe("complete");
      expect(callCount).toBe(2);
      expect(readReport.comparison?.verdict).toBe("isolated-different");
      expect(readReport.comparison?.structuredIdOverlap).toEqual({
        firstCount: 1,
        secondCount: 1,
        sharedCount: 0,
      });
      expect(JSON.stringify(readReport)).not.toContain("secret-jwt-");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("enforces surface snapshot/diff lockfile workflow and workbench CSRF protection", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "chumbo-surface-lock-"));
    try {
      await mkdir(join(tempRoot, "supabase"), { recursive: true });
      await writeFile(
        join(tempRoot, "supabase", "config.toml"),
        'project_id = "lock-test"\n',
      );

      const entryV1 = await buildLockedSurfaceEntry({
        functionName: "mcp",
        serverName: "lock-test",
        tools: [
          {
            name: "list_notes",
            description: "List notes.",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true },
          },
        ],
      });

      const planned = await runSurfaceSnapshot({
        cwd: tempRoot,
        plan: true,
        json: true,
        staticInspector: async () => [entryV1],
      });
      expect(planned.report.status).toBe("planned");

      const written = await runSurfaceSnapshot({
        cwd: tempRoot,
        yes: true,
        json: true,
        staticInspector: async () => [entryV1],
      });
      expect(written.report.status).toBe("complete");

      const diffClean = await runSurfaceDiff({
        cwd: tempRoot,
        plan: true,
        json: true,
        staticInspector: async () => [entryV1],
      });
      expect(diffClean.status).toBe("unchanged");
      expect(diffClean.exitCode).toBe(0);

      // Dev startup banner performs zero generateLink sign-ins
      const generateLink = vi.fn();
      const deps = mockSupabaseClients({
        users: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            email: "alice@example.com",
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            email: "bob@example.com",
          },
        ],
        onGenerateLink: generateLink,
      });
      const banner = await gatherDevStartupBanner({
        projectRoot: tempRoot,
        functionName: "mcp",
        personaDeps: deps,
        staticInspector: async () => entryV1,
      });
      expect(generateLink).not.toHaveBeenCalled();
      expect(banner.lines.join("\n")).toContain("Cold-start surface:");
      expect(banner.lines.join("\n")).toContain(
        "alice@example.com,bob@example.com",
      );

      // Workbench server rejects cross-origin / missing-token POSTs with 403
      const workbench = await startDevWorkbench({
        projectRoot: tempRoot,
        functionName: "mcp",
        mcpEndpointUrl: "http://127.0.0.1:54321/functions/v1/mcp",
        personaDeps: deps,
      });
      try {
        const forbidden = await fetch(
          `${workbench.url}/__chumbo/workbench/try`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tool: null, as: ["anon"] }),
          },
        );
        expect(forbidden.status).toBe(403);

        const crossOrigin = await fetch(
          `${workbench.url}/__chumbo/workbench/try`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-chumbo-workbench-token": workbench.token,
              origin: "https://evil.example",
            },
            body: JSON.stringify({ tool: null, as: ["anon"] }),
          },
        );
        expect(crossOrigin.status).toBe(403);
      } finally {
        await workbench.close();
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
