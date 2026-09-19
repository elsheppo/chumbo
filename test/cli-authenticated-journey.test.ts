import { afterEach, describe, expect, it, vi } from "vitest";
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { defineCapability, registerCapability } from "../src/capabilities.js";
import {
  createBrandedCli,
  KeychainOAuthProvider,
  type SecureCredentialStore,
} from "../src/cli-host.js";
import { structuredResult } from "../src/results.js";
import type { SupabaseMcpServer } from "../src/types.js";

class MemoryStore implements SecureCredentialStore {
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

afterEach(() => vi.unstubAllGlobals());

describe("authenticated project CLI journey", () => {
  it("composes browser PKCE, secure storage, authenticated discovery, and MCP execution", async () => {
    const endpoint = "https://api.acme.example/mcp";
    const issuer = "https://auth.acme.example";
    const accessToken = "held-out-access-token";
    const callbackPort = 48976;
    const realFetch = globalThis.fetch;
    const handler = vi.fn(async ({ id }: { id: string }) =>
      structuredResult({ id, owner: "user-1" }),
    );
    const server = new McpServer({ name: "acme", version: "1.0.0" });
    const scoped = server as SupabaseMcpServer;
    scoped.withScopes = () => scoped;
    registerCapability(
      scoped,
      defineCapability({
        id: "projects.get",
        mcpName: "get_project",
        title: "Get project",
        description: "Get one project visible to the signed-in user.",
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ id: z.string(), owner: z.string() }),
        scopes: ["projects:read"],
        risk: "read",
        idempotent: true,
        cli: { command: ["projects", "get"] },
        handler,
      }),
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);

    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.href === `${endpoint}/.well-known/oauth-protected-resource`) {
          return Response.json({
            resource: endpoint,
            authorization_servers: [issuer],
            scopes_supported: ["projects:read"],
          });
        }
        if (url.href === `${issuer}/.well-known/oauth-authorization-server`) {
          return Response.json({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            registration_endpoint: `${issuer}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            token_endpoint_auth_methods_supported: ["none"],
            code_challenge_methods_supported: ["S256"],
            scopes_supported: ["projects:read"],
          });
        }
        if (url.href === `${issuer}/register`) {
          const metadata = JSON.parse(await request.text()) as Record<
            string,
            unknown
          >;
          return Response.json(
            { ...metadata, client_id: "acme-cli", issuer },
            { status: 201 },
          );
        }
        if (url.href === `${issuer}/token`) {
          const form = new URLSearchParams(await request.text());
          expect(form.get("code")).toBe("accepted-code");
          expect(form.get("code_verifier")).toBeTruthy();
          return Response.json({
            access_token: accessToken,
            token_type: "Bearer",
            expires_in: 3600,
            scope: "projects:read",
          });
        }
        if (url.href === endpoint) {
          if (
            request.headers.get("authorization") !== `Bearer ${accessToken}`
          ) {
            return new Response("Unauthorized", {
              status: 401,
              headers: {
                "www-authenticate": `Bearer resource_metadata="${endpoint}/.well-known/oauth-protected-resource"`,
              },
            });
          }
          return transport.handleRequest(request);
        }
        throw new Error(`Unexpected OAuth fixture request: ${url.href}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const output: string[] = [];
    const errors: string[] = [];
    const store = new MemoryStore();
    const staleAuth = new KeychainOAuthProvider({
      endpoint,
      redirectUrl: `http://127.0.0.1:${callbackPort}/oauth/callback`,
      displayName: "Acme Ops",
      version: "1.0.0",
      store,
      openAuthorization() {},
    });
    await staleAuth.saveDiscoveryState({
      authorizationServerUrl: issuer,
      resourceMetadataUrl: `${endpoint}/.well-known/oauth-protected-resource`,
      resourceMetadata: {
        resource: endpoint,
        authorization_servers: [issuer],
        scopes_supported: ["projects:read"],
      },
      authorizationServerMetadata: {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        response_types_supported: ["code"],
      },
    });
    const cli = createBrandedCli(
      {
        packageName: "@acme/ops-cli",
        binaryName: "acme",
        displayName: "Acme Ops",
        version: "1.0.0",
        endpoint,
        callbackPort,
      },
      {
        credentialStore: store,
        async openAuthorization(url) {
          expect(url.origin).toBe(issuer);
          const redirect = url.searchParams.get("redirect_uri");
          const state = url.searchParams.get("state");
          expect(url.searchParams.get("code_challenge_method")).toBe("S256");
          if (!redirect || !state)
            throw new Error("Incomplete authorization URL");
          const callback = new URL(redirect);
          callback.searchParams.set("code", "accepted-code");
          callback.searchParams.set("state", state);
          const response = await realFetch(callback);
          expect(response.status).toBe(200);
        },
        io: {
          stdout(value) {
            output.push(value);
          },
          stderr(value) {
            errors.push(value);
          },
          isTTY: false,
          async confirm() {
            return false;
          },
        },
      },
    );

    try {
      const loginExitCode = await cli.run(["login"]);
      expect({ loginExitCode, errors }).toEqual({
        loginExitCode: 0,
        errors: [],
      });
      expect(output).toContain("Signed in to Acme Ops. 1 commands available.");
      expect([...store.values.values()].join(" ")).toContain(accessToken);
      expect(
        fetchMock.mock.calls.some(
          ([input]) =>
            String(input) ===
            `${issuer}/.well-known/oauth-authorization-server`,
        ),
      ).toBe(true);

      await expect(
        cli.run(["projects", "get", "--id", "project-1", "--json"]),
      ).resolves.toBe(0);
      const receipt = JSON.parse(output.at(-1)!);
      expect(receipt).toMatchObject({
        ok: true,
        capabilityId: "projects.get",
        mcpName: "get_project",
        result: {
          structuredContent: { id: "project-1", owner: "user-1" },
        },
      });
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });
});
