import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import {
  UnauthorizedError,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { defineCapability, registerCapability } from "../src/capabilities.js";
import { structuredResult } from "../src/results.js";
import type { SupabaseMcpServer } from "../src/types.js";

// Mock `@napi-rs/keyring` to throw on import, simulating a minimal headless
// Linux container (`node:22-slim` / Alpine) without `libsecret-1.so.0`.
vi.mock("@napi-rs/keyring", () => {
  throw new Error("libsecret-1.so.0: cannot open shared object file");
});

const { createBrandedCli, FileDiscoveryCache, KeychainOAuthProvider } =
  await import("../src/cli-host.js");

class MemoryStore {
  readonly values = new Map<string, string>();
  async get(account: string): Promise<string | undefined> {
    return this.values.get(account);
  }
  async set(account: string, value: string): Promise<void> {
    this.values.set(account, value);
  }
  async delete(account: string): Promise<boolean> {
    return this.values.delete(account);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("headless CLI authentication and HMAC-partitioned discovery cache", () => {
  it("authenticates via <BIN>_TOKEN without importing @napi-rs/keyring and ignores other CLIs' tokens", async () => {
    const endpoint = "https://api.acme.example/mcp";
    const expectedToken = "acme-ci-secret-token-123";
    const server = new McpServer({ name: "acme", version: "1.0.0" });
    const scoped = server as SupabaseMcpServer;
    scoped.withScopes = () => scoped;
    registerCapability(
      scoped,
      defineCapability({
        id: "projects.list",
        mcpName: "list_projects",
        title: "List projects",
        description: "List projects visible to this token.",
        inputSchema: z.object({}),
        risk: "read",
        idempotent: true,
        cli: { command: ["projects", "list"] },
        handler: async () => structuredResult({ items: ["p1"] }),
      }),
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const req = new Request(input, init);
        if (req.headers.get("authorization") !== `Bearer ${expectedToken}`) {
          return new Response("Unauthorized", { status: 401 });
        }
        return transport.handleRequest(req);
      }),
    );

    const cacheDir = await mkdtemp(join(tmpdir(), "chumbo-cli-cache-"));
    try {
      const stdout: string[] = [];
      const stderr: string[] = [];

      // 1. Ambient GLOBEX_TOKEN must NOT be sent by `acme` CLI
      const unauthCli = createBrandedCli(
        {
          packageName: "@acme/ops-cli",
          binaryName: "acme",
          displayName: "Acme Ops",
          version: "1.0.0",
          endpoint,
          auth: { mode: "token" },
        },
        {
          // Deliberately do NOT pass credentialStore -> SystemCredentialStore is constructed,
          // proving `@napi-rs/keyring` is not imported unless a store method is called.
          env: { GLOBEX_TOKEN: expectedToken },
          discoveryCache: new FileDiscoveryCache({ directory: cacheDir }),
          io: {
            stdout: (v) => stdout.push(v),
            stderr: (v) => stderr.push(v),
            isTTY: false,
            confirm: async () => false,
          },
        },
      );

      // With ACME_TOKEN set, zero keyring methods are invoked even though @napi-rs/keyring throws on import!
      const authedCli = createBrandedCli(
        {
          packageName: "@acme/ops-cli",
          binaryName: "acme",
          displayName: "Acme Ops",
          version: "1.0.0",
          endpoint,
          auth: { mode: "token" },
        },
        {
          env: { ACME_TOKEN: expectedToken, GLOBEX_TOKEN: "wrong-token" },
          discoveryCache: new FileDiscoveryCache({ directory: cacheDir }),
          io: {
            stdout: (v) => stdout.push(v),
            stderr: (v) => stderr.push(v),
            isTTY: false,
            confirm: async () => false,
          },
        },
      );

      expect(await authedCli.run(["projects", "list", "--json"])).toBe(0);
      expect(JSON.parse(stdout.at(-1)!)).toMatchObject({
        ok: true,
        capabilityId: "projects.list",
      });

      // Verify GLOBEX_TOKEN alone fails when backed by an empty MemoryStore
      const globexOnlyCli = createBrandedCli(
        {
          packageName: "@acme/ops-cli",
          binaryName: "acme",
          displayName: "Acme Ops",
          version: "1.0.0",
          endpoint,
          auth: { mode: "token" },
        },
        {
          credentialStore: new MemoryStore(),
          env: { GLOBEX_TOKEN: expectedToken },
          discoveryCache: new FileDiscoveryCache({ directory: cacheDir }),
          io: {
            stdout: (v) => stdout.push(v),
            stderr: (v) => stderr.push(v),
            isTTY: false,
            confirm: async () => false,
          },
        },
      );
      expect(await globexOnlyCli.run(["commands"])).toBe(3);
      void unauthCli;
    } finally {
      await server.close();
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("partitions discovery cache by HMAC credential fingerprint, busts on unknown command, and keys post-refresh OAuth tokens", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "chumbo-cli-cache-part-"));
    try {
      let nowMs = 1_760_000_000_000;
      const cache = new FileDiscoveryCache({
        directory: cacheDir,
        defaultTtlMs: 60_000,
        now: () => nowMs,
      });

      let currentToken = "token-alpha";
      let oauthToken = "oauth-pre-refresh";
      let useOauth = false;
      let deployedExtraTool = false;
      let tokenRevoked = false;

      const listToolsSpy = vi.fn(async () => ({
        tools: [
          {
            name: "list_items",
            title: "List items",
            description: "Read items.",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true },
            _meta: {
              "dev.chumbo/capability": {
                schemaVersion: 1,
                id: "items.list",
                mcpName: "list_items",
                risk: "read",
                idempotent: true,
                scopes: [],
                cli: { command: ["items", "list"] },
              },
            },
          },
          ...(deployedExtraTool
            ? [
                {
                  name: "archive_item",
                  title: "Archive item",
                  description: "Archive an item.",
                  inputSchema: {
                    type: "object",
                    properties: { item_id: { type: "string" } },
                    required: ["item_id"],
                  },
                  annotations: { destructiveHint: true },
                  _meta: {
                    "dev.chumbo/capability": {
                      schemaVersion: 1,
                      id: "items.archive",
                      mcpName: "archive_item",
                      risk: "destructive",
                      idempotent: true,
                      scopes: [],
                      cli: { command: ["items", "archive"] },
                    },
                  },
                },
              ]
            : []),
        ],
      }));

      const callToolSpy = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }));

      const connector = {
        async activeCredential() {
          if (useOauth) {
            return {
              source: {
                kind: "keychain-oauth" as const,
                issuer: "https://auth.acme.example",
              },
              partitionMaterial: `https://auth.acme.example\u0000${oauthToken}`,
            };
          }
          return {
            source: { kind: "env" as const, envVar: "ACME_TOKEN" },
            partitionMaterial: currentToken,
          };
        },
        async connect() {
          if (tokenRevoked) throw new UnauthorizedError("Revoked");
          // Simulate OAuth access_token refresh occurring inside connect()
          if (useOauth && oauthToken === "oauth-pre-refresh") {
            oauthToken = "oauth-post-refresh";
          }
          return {
            listTools: listToolsSpy,
            callTool: callToolSpy,
            close: async () => {},
          };
        },
        async loggedInIssuer() {
          return useOauth ? "https://auth.acme.example" : undefined;
        },
        async logout() {},
      };

      const stdout: string[] = [];
      const stderr: string[] = [];
      const cli = createBrandedCli(
        {
          packageName: "@acme/ops-cli",
          binaryName: "acme",
          displayName: "Acme Ops",
          version: "1.0.0",
          endpoint: "https://api.acme.example/mcp",
        },
        {
          connector,
          discoveryCache: cache,
          io: {
            stdout: (v) => stdout.push(v),
            stderr: (v) => stderr.push(v),
            isTTY: false,
            confirm: async () => false,
          },
        },
      );

      // 1. Cold start populates cache
      expect(await cli.run(["commands"])).toBe(0);
      expect(listToolsSpy).toHaveBeenCalledTimes(1);

      // 2. Warm cache serves `commands` and `--help` in 0 listTools() calls
      expect(await cli.run(["commands"])).toBe(0);
      expect(await cli.run(["items", "list", "--help"])).toBe(0);
      expect(listToolsSpy).toHaveBeenCalledTimes(1);

      // Verify on-disk cache contains zero secrets, URLs, or issuers
      const files = (await readdir(cacheDir)).filter((f) =>
        f.endsWith(".json"),
      );
      expect(files.length).toBe(1);
      const diskPayload = await readFile(join(cacheDir, files[0]!), "utf8");
      expect(diskPayload).not.toContain("token-alpha");
      expect(diskPayload).not.toContain("api.acme.example");

      // 3. Switching credential misses cache and creates a distinct partition
      currentToken = "token-beta";
      expect(await cli.run(["commands"])).toBe(0);
      expect(listToolsSpy).toHaveBeenCalledTimes(2);

      // 4. Newly deployed command while cache is warm triggers automatic cache-bust + single retry,
      // AND destructive command still fails closed with exit 4 (CONFIRMATION_REQUIRED) without --yes!
      deployedExtraTool = true;
      expect(
        await cli.run(["items", "archive", "--item-id", "i1", "--json"]),
      ).toBe(4);
      expect(listToolsSpy).toHaveBeenCalledTimes(3);
      expect(callToolSpy).not.toHaveBeenCalled();
      expect(JSON.parse(stdout.at(-1)!)).toMatchObject({
        ok: false,
        error: { code: "CONFIRMATION_REQUIRED", risk: "destructive" },
      });

      // With --yes, warm cache now knows `items archive` without calling listTools() again!
      expect(
        await cli.run([
          "items",
          "archive",
          "--item-id",
          "i1",
          "--yes",
          "--json",
        ]),
      ).toBe(0);
      expect(listToolsSpy).toHaveBeenCalledTimes(3);
      expect(callToolSpy).toHaveBeenCalledTimes(1);

      // 5. Post-refresh OAuth write-through: connect() refreshes `oauth-pre-refresh` -> `oauth-post-refresh`;
      // next invocation with `oauth-post-refresh` hits the warm cache in 0 listTools() calls!
      useOauth = true;
      expect(await cli.run(["commands"])).toBe(0);
      expect(listToolsSpy).toHaveBeenCalledTimes(4);
      expect(oauthToken).toBe("oauth-post-refresh");

      expect(await cli.run(["commands"])).toBe(0);
      expect(listToolsSpy).toHaveBeenCalledTimes(4);

      // 6. `status` ALWAYS checks live connect() even when cache is warm, catching revoked tokens immediately!
      tokenRevoked = true;
      expect(await cli.run(["status", "--json"])).toBe(3);
      expect(JSON.parse(stdout.at(-1)!)).toEqual({
        ok: false,
        signedIn: false,
      });
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("supports login --token-stdin into keychain store and scrubs secrets from error output", async () => {
    const store = new MemoryStore();
    const leakedSecret = "super-secret-pat-xyz987";
    const stdout: string[] = [];
    const stderr: string[] = [];

    const provider = new KeychainOAuthProvider({
      endpoint: "https://api.acme.example/mcp",
      redirectUrl: "http://127.0.0.1:47832/oauth/callback",
      displayName: "Acme Ops",
      version: "1.0.0",
      store,
      openAuthorization() {},
    });
    await provider.saveTokens(
      {
        access_token: "old-oauth",
        token_type: "Bearer",
        issuer: "https://issuer.example",
      } as StoredOAuthTokens,
      { issuer: "https://issuer.example" },
    );

    const cli = createBrandedCli(
      {
        packageName: "@acme/ops-cli",
        binaryName: "acme",
        displayName: "Acme Ops",
        version: "1.0.0",
        endpoint: "https://api.acme.example/mcp",
        auth: { mode: "token" },
      },
      {
        credentialStore: store,
        connector: {
          async connectWithToken(token) {
            expect(token).toBe(leakedSecret);
            return {
              listTools: async () => ({ tools: [] }),
              callTool: async () => {
                throw new Error(
                  `Upstream echoed header Bearer ${leakedSecret}`,
                );
              },
              close: async () => {},
            };
          },
          async saveStaticToken(token) {
            await store.set("token:test", JSON.stringify({ token }));
          },
          async activeCredential() {
            return store.values.has("token:test")
              ? {
                  source: { kind: "keychain-token" as const },
                  partitionMaterial: leakedSecret,
                }
              : undefined;
          },
          async connect() {
            throw new Error(`Upstream echoed header Bearer ${leakedSecret}`);
          },
          async loggedInIssuer() {
            return undefined;
          },
          async logout() {
            store.values.clear();
          },
        },
        io: {
          stdout: (v) => stdout.push(v),
          stderr: (v) => stderr.push(v),
          isTTY: false,
          stdinIsTTY: false,
          readStdin: async () => `${leakedSecret}\n`,
          confirm: async () => false,
        },
      },
    );

    expect(await cli.run(["login", "--token-stdin", "--json"])).toBe(0);
    expect(JSON.parse(stdout.at(-1)!)).toMatchObject({
      ok: true,
      action: "login",
      authSource: "keychain-token",
    });

    // Error messages must scrub inline `--token` secrets
    expect(await cli.run(["commands", "--token", leakedSecret])).toBe(2);
    expect(stderr.join("\n")).not.toContain(leakedSecret);
    expect(stderr.join("\n")).toContain("[REDACTED]");
  });
});
