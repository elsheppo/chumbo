import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { withOAuthProtectedResource, withSupabase } from "@supabase/server";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runDoctor, type DoctorCheck } from "../src/doctor.js";

const MCP = "https://p.supabase.co/functions/v1/mcp";
const ISSUER = "https://p.supabase.co/auth/v1";
const PRM_SUFFIX = `${MCP}/oauth-protected-resource`;
const PRM_WELL_KNOWN =
  "https://p.supabase.co/.well-known/oauth-protected-resource/functions/v1/mcp";
const AS_ORIGIN_LEVEL =
  "https://p.supabase.co/.well-known/oauth-authorization-server/auth/v1";
const AS_ISSUER_RELATIVE = `${ISSUER}/.well-known/oauth-authorization-server`;
const AS_OPENID_INSERT =
  "https://p.supabase.co/.well-known/openid-configuration/auth/v1";
const AS_OPENID = `${ISSUER}/.well-known/openid-configuration`;
const JWKS = `${ISSUER}/.well-known/jwks.json`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function unsignedJwt(sub: string, extra: Record<string, unknown> = {}): string {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "ES256", typ: "JWT" })}.${part({ sub, ...extra })}.signature`;
}

const asymmetricKey = {
  kty: "EC",
  crv: "P-256",
  alg: "ES256",
  kid: "k1",
  x: "M5Sjqn5zwC9Kl1zVfUUGvv9boQjCGd45G8sdopBExB4",
  y: "P6IXMvA2WYXSHSOMTBH2jsw_9rrzGy89FjPf6oOsIxQ",
};

function authorizationServerMetadata(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth/authorize`,
    token_endpoint: `${ISSUER}/oauth/token`,
    registration_endpoint: `${ISSUER}/oauth/clients/register`,
    jwks_uri: JWKS,
    ...overrides,
  };
}

interface Tool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

interface Fixture {
  /** Serves GET discovery documents; return undefined for a 404. */
  documents?: Record<string, unknown>;
  challenge?: string | null;
  tools?: Tool[];
  /** Result for a tools/call, keyed by tool then bearer token. */
  call?: (name: string, token: string) => Record<string, unknown> | Response;
  headers?: Record<string, string>;
}

function rpc(result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: "x", result });
}

function stubServer(fixture: Fixture) {
  const calls: Array<{ method: string; url: string; tool?: string }> = [];
  const fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (method === "GET") {
        calls.push({ method, url });
        const document = fixture.documents?.[url];
        return document === undefined
          ? new Response("not found", { status: 404 })
          : Response.json(document);
      }
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        params?: { name?: string };
      };
      calls.push({ method: body.method, url, tool: body.params?.name });
      const headers = new Headers(init?.headers);
      const authorization = headers.get("authorization");
      if (!authorization) {
        const challenge =
          fixture.challenge === undefined
            ? `Bearer resource_metadata="${PRM_SUFFIX}"`
            : fixture.challenge;
        return Response.json(
          { error: "Unauthorized" },
          {
            status: 401,
            headers: {
              ...(challenge ? { "www-authenticate": challenge } : {}),
              ...fixture.headers,
            },
          },
        );
      }
      const token = authorization.replace(/^Bearer /, "");
      if (body.method === "initialize") {
        return rpc({
          protocolVersion: "2025-03-26",
          capabilities: {},
          serverInfo: { name: "fixture", version: "1.0.0" },
        });
      }
      if (body.method === "tools/list") {
        return rpc({ tools: fixture.tools ?? [] });
      }
      const outcome = fixture.call?.(body.params?.name ?? "", token);
      if (outcome instanceof Response) return outcome;
      return rpc(
        outcome ?? { content: [{ type: "text", text: "ok" }], isError: false },
      );
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

function officialDocuments(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    [PRM_SUFFIX]: {
      resource: MCP,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
    },
    [AS_OPENID]: authorizationServerMetadata(),
    [JWKS]: { keys: [asymmetricKey] },
    ...overrides,
  };
}

async function emptyDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "chumbo-any-"));
}

async function doctor(
  options: Partial<Parameters<typeof runDoctor>[0]> = {},
): Promise<DoctorCheck[]> {
  return runDoctor({
    cwd: await emptyDirectory(),
    functionName: "mcp",
    url: MCP,
    deep: true,
    ...options,
  });
}

function named(checks: DoctorCheck[], name: string): DoctorCheck {
  const check = checks.find((entry) => entry.name === name);
  if (!check) {
    throw new Error(
      `Missing check ${name}; got ${checks.map((entry) => entry.name).join(", ")}`,
    );
  }
  return check;
}

describe("doctor against a server that is not Chumbo", () => {
  it("does not fail Chumbo-only checks and reports the runtime as not applicable", async () => {
    stubServer({ documents: officialDocuments() });
    const checks = await doctor();
    expect(checks.filter((check) => !check.ok)).toEqual([
      expect.objectContaining({ name: "runtime-reached", blocking: false }),
    ]);
    expect(named(checks, "runtime-reached").detail).toContain(
      "not a Chumbo runtime",
    );
    for (const name of [
      "runtime-version",
      "runtime-auth-mode",
      "runtime-auth-strategy",
      "runtime-resource-url",
      "public-rate-limit",
      "multi-auth-gate",
      "gateway",
      "dependencies",
    ]) {
      expect(checks.some((check) => check.name === name)).toBe(false);
    }
    expect(checks.some((check) => check.name.startsWith("file:"))).toBe(false);
  });

  it("skips Chumbo file checks in a Supabase project that has no such function", async () => {
    const cwd = await emptyDirectory();
    await mkdir(join(cwd, "supabase"), { recursive: true });
    await writeFile(
      join(cwd, "supabase", "config.toml"),
      'project_id = "other"\n',
    );
    stubServer({ documents: officialDocuments() });
    const checks = await doctor({ cwd });
    expect(checks.some((check) => check.name === "gateway")).toBe(false);
    expect(checks.some((check) => check.name.startsWith("file:"))).toBe(false);
  });

  it("does not demand Chumbo's rate limit from a public server", async () => {
    stubServer({});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { method: string };
        if (body.method === "initialize") {
          return rpc({ protocolVersion: "2025-03-26", capabilities: {} });
        }
        return rpc({ tools: [] });
      }),
    );
    const checks = await doctor({ auth: "public" });
    expect(checks.some((check) => check.name === "public-rate-limit")).toBe(
      false,
    );
    expect(named(checks, "public-tools-list").ok).toBe(true);
  });

  it("notes an endpoint that never asks for sign-in without failing the run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => rpc({ tools: [] })),
    );
    const checks = await doctor();
    const challenge = named(checks, "oauth-challenge");
    expect(challenge).toMatchObject({ ok: false, blocking: false });
    expect(challenge.detail).toContain("did not ask for sign-in");
  });
});

describe("protected-resource discovery", () => {
  it("follows the 401 challenge and says where the metadata came from", async () => {
    stubServer({ documents: officialDocuments() });
    const checks = await doctor();
    expect(named(checks, "oauth-challenge")).toMatchObject({ ok: true });
    const metadata = named(checks, "protected-resource-metadata");
    expect(metadata.ok).toBe(true);
    expect(metadata.detail).toContain("the 401 challenge");
    expect(metadata.detail).toContain(PRM_SUFFIX);
    expect(named(checks, "advertised-resource-url").ok).toBe(true);
  });

  it("falls back to the RFC 9728 well-known location when the challenge names none", async () => {
    stubServer({
      challenge: 'Bearer realm="mcp"',
      documents: officialDocuments({
        [PRM_SUFFIX]: undefined,
        [PRM_WELL_KNOWN]: { resource: MCP, authorization_servers: [ISSUER] },
      }),
    });
    const checks = await doctor();
    expect(named(checks, "oauth-challenge").ok).toBe(true);
    const metadata = named(checks, "protected-resource-metadata");
    expect(metadata.ok).toBe(true);
    expect(metadata.detail).toContain("the well-known location");
    expect(metadata.detail).toContain(PRM_WELL_KNOWN);
  });

  it("does not pass on the suffix location unless the challenge names it", async () => {
    stubServer({ challenge: null, documents: officialDocuments() });
    const metadata = named(await doctor(), "protected-resource-metadata");
    expect(metadata.ok).toBe(false);
    expect(metadata.blocking).toBeUndefined();
    expect(metadata.detail).toContain(`resource_metadata="${PRM_SUFFIX}"`);
    expect(metadata.detail).toContain("withOAuthProtectedResource");
  });

  it("falls back to the root well-known location last", async () => {
    stubServer({
      challenge: null,
      documents: officialDocuments({
        [PRM_SUFFIX]: undefined,
        "https://p.supabase.co/.well-known/oauth-protected-resource": {
          resource: MCP,
          authorization_servers: [ISSUER],
        },
      }),
    });
    const metadata = named(await doctor(), "protected-resource-metadata");
    expect(metadata.ok).toBe(true);
    expect(metadata.detail).toContain("the well-known location");
  });

  it("fails with the locations it tried when no metadata exists", async () => {
    stubServer({ challenge: null, documents: {} });
    const checks = await doctor();
    const metadata = named(checks, "protected-resource-metadata");
    expect(metadata.ok).toBe(false);
    expect(metadata.detail).toContain(PRM_WELL_KNOWN);
    expect(
      checks.some((check) => check.name === "authorization-server-metadata"),
    ).toBe(false);
  });
});

describe("authorization-server-metadata", () => {
  it("tries the OAuth path-inserted location first", async () => {
    const { calls } = stubServer({
      documents: officialDocuments({
        [AS_OPENID]: undefined,
        [AS_ORIGIN_LEVEL]: authorizationServerMetadata(),
      }),
    });
    const check = named(await doctor(), "authorization-server-metadata");
    expect(check.ok).toBe(true);
    expect(check.detail).toContain(AS_ORIGIN_LEVEL);
    expect(calls.some((call) => call.url === AS_OPENID)).toBe(false);
  });

  it("falls through the client order to OIDC path insertion, then path appending", async () => {
    stubServer({
      documents: officialDocuments({
        [AS_OPENID]: undefined,
        [AS_OPENID_INSERT]: authorizationServerMetadata(),
      }),
    });
    expect(
      named(await doctor(), "authorization-server-metadata").detail,
    ).toContain(AS_OPENID_INSERT);
    stubServer({ documents: officialDocuments() });
    const appended = named(await doctor(), "authorization-server-metadata");
    expect(appended.ok).toBe(true);
    expect(appended.detail).toContain(AS_OPENID);
  });

  it("uses the origin-level locations for an issuer without a path", async () => {
    const bare = "https://auth.example.com";
    const { calls } = stubServer({
      documents: {
        ...officialDocuments(),
        [PRM_SUFFIX]: {
          resource: MCP,
          authorization_servers: [bare],
        },
        [`${bare}/.well-known/openid-configuration`]:
          authorizationServerMetadata({ issuer: bare, jwks_uri: JWKS }),
      },
    });
    const check = named(await doctor(), "authorization-server-metadata");
    expect(check.ok).toBe(true);
    expect(calls.map((call) => call.url)).toContain(
      `${bare}/.well-known/oauth-authorization-server`,
    );
  });

  it("blocks when metadata exists only at the non-client issuer-relative path", async () => {
    stubServer({
      documents: officialDocuments({
        [AS_OPENID]: undefined,
        [AS_ISSUER_RELATIVE]: authorizationServerMetadata(),
      }),
    });
    const check = named(await doctor(), "authorization-server-metadata");
    expect(check.ok).toBe(false);
    expect(check.blocking).toBeUndefined();
    expect(check.detail).toContain("MCP clients do not read");
  });

  it("only warns for that path on a loopback issuer, as the local CLI gateway serves it", async () => {
    const local = "http://127.0.0.1:54321/auth/v1";
    const mcp = "http://127.0.0.1:54321/functions/v1/mcp";
    stubServer({
      documents: {
        [`${mcp}/oauth-protected-resource`]: {
          resource: mcp,
          authorization_servers: [local],
        },
        [`${local}/.well-known/oauth-authorization-server`]:
          authorizationServerMetadata({
            issuer: local,
            jwks_uri: `${local}/.well-known/jwks.json`,
          }),
        [`${local}/.well-known/jwks.json`]: { keys: [asymmetricKey] },
      },
      challenge: `Bearer resource_metadata="${mcp}/oauth-protected-resource"`,
    });
    const check = named(
      await doctor({ url: mcp }),
      "authorization-server-metadata",
    );
    expect(check).toMatchObject({ ok: false, blocking: false });
  });

  it("is a blocking failure that names every location when none serves metadata", async () => {
    stubServer({
      documents: officialDocuments({ [AS_OPENID]: undefined }),
    });
    const checks = await doctor();
    const check = named(checks, "authorization-server-metadata");
    expect(check).toMatchObject({ ok: false });
    expect(check.blocking).toBeUndefined();
    expect(check.detail).toContain(AS_ORIGIN_LEVEL);
    expect(check.detail).toContain(AS_OPENID_INSERT);
    expect(check.detail).toContain(AS_OPENID);
    expect(check.detail).toContain("OAuth Server");
    expect(checks.some((entry) => entry.name === "issuer-match")).toBe(false);
  });
});

describe("issuer-match", () => {
  it("passes on an exact match", async () => {
    stubServer({ documents: officialDocuments() });
    expect(named(await doctor(), "issuer-match").ok).toBe(true);
  });

  it("treats a trailing-slash difference as a blocking mismatch, as clients do", async () => {
    stubServer({
      documents: officialDocuments({
        [AS_OPENID]: authorizationServerMetadata({ issuer: `${ISSUER}/` }),
      }),
    });
    const check = named(await doctor(), "issuer-match");
    expect(check.ok).toBe(false);
    expect(check.blocking).toBeUndefined();
    expect(check.detail).toContain("compare these exactly");
  });

  it("blocks on a custom-domain mismatch and names both values", async () => {
    stubServer({
      documents: officialDocuments({
        [AS_OPENID]: authorizationServerMetadata({
          issuer: "https://auth.example.com/auth/v1",
        }),
      }),
    });
    const check = named(await doctor(), "issuer-match");
    expect(check.ok).toBe(false);
    expect(check.blocking).toBeUndefined();
    expect(check.detail).toContain("https://auth.example.com/auth/v1");
    expect(check.detail).toContain(ISSUER);
    expect(check.detail).toContain("Advertise the issuer the metadata reports");
  });
});

describe("client-registration", () => {
  it("passes when a registration endpoint is advertised", async () => {
    stubServer({ documents: officialDocuments() });
    const check = named(await doctor(), "client-registration");
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("/oauth/clients/register");
  });

  it("warns without blocking when there is none", async () => {
    stubServer({
      documents: officialDocuments({
        [AS_OPENID]: authorizationServerMetadata({
          registration_endpoint: undefined,
          client_id_metadata_document_supported: true,
        }),
      }),
    });
    const checks = await doctor();
    const check = named(checks, "client-registration");
    expect(check).toMatchObject({ ok: false, blocking: false });
    expect(check.detail).toContain("Claude, ChatGPT");
    expect(check.detail).toContain("client ID metadata document");
    expect(checks.some((entry) => !entry.ok && entry.blocking !== false)).toBe(
      false,
    );
  });
});

describe("signing-keys", () => {
  it("passes with an asymmetric key", async () => {
    stubServer({ documents: officialDocuments() });
    const check = named(await doctor(), "signing-keys");
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("ES256");
  });

  it("accepts RSA and OKP keys that carry their key material", async () => {
    stubServer({
      documents: officialDocuments({
        [JWKS]: {
          keys: [
            { kty: "RSA", n: "abc", e: "AQAB" },
            { kty: "OKP", crv: "Ed25519", x: "abc" },
          ],
        },
      }),
    });
    expect(named(await doctor(), "signing-keys").ok).toBe(true);
  });

  it("does not count a key without its key material", async () => {
    stubServer({
      documents: officialDocuments({
        [JWKS]: { keys: [{ kty: "EC", alg: "ES256", kid: "stub" }] },
      }),
    });
    const check = named(await doctor(), "signing-keys");
    expect(check.ok).toBe(false);
    expect(check.blocking).toBeUndefined();
  });

  it("blocks on an empty key set and corrects the HS256 claim", async () => {
    stubServer({ documents: officialDocuments({ [JWKS]: { keys: [] } }) });
    const check = named(await doctor(), "signing-keys");
    expect(check.ok).toBe(false);
    expect(check.blocking).toBeUndefined();
    expect(check.detail).toContain("legacy HS256 projects cannot use it");
    expect(check.detail).toContain("Project Settings → JWT Keys");
    expect(check.detail).not.toContain("reject");
  });

  it("warns without blocking on an empty key set from a loopback issuer", async () => {
    const local = "http://127.0.0.1:54321/auth/v1";
    const mcp = "http://127.0.0.1:54321/functions/v1/mcp";
    stubServer({
      documents: {
        [`${mcp}/oauth-protected-resource`]: {
          resource: mcp,
          authorization_servers: [local],
        },
        [`${local}/.well-known/openid-configuration`]:
          authorizationServerMetadata({
            issuer: local,
            jwks_uri: `${local}/.well-known/jwks.json`,
          }),
        [`${local}/.well-known/jwks.json`]: { keys: [] },
      },
      challenge: `Bearer resource_metadata="${mcp}/oauth-protected-resource"`,
    });
    const check = named(await doctor({ url: mcp }), "signing-keys");
    expect(check).toMatchObject({ ok: false, blocking: false });
  });

  it("blocks on a published signing secret even beside good keys", async () => {
    for (const secret of [
      { kty: "oct", alg: "HS256", k: "c2VjcmV0" },
      { ...asymmetricKey, kid: "leaky", k: "c2VjcmV0" },
    ]) {
      stubServer({
        documents: officialDocuments({
          [JWKS]: { keys: [asymmetricKey, secret] },
        }),
      });
      const check = named(await doctor(), "signing-keys");
      expect(check.ok).toBe(false);
      expect(check.blocking).toBeUndefined();
      expect(check.detail).toContain("lets anyone forge tokens");
      expect(check.detail).toContain("Rotate the signing key now");
    }
  });

  it("blocks when the metadata has no jwks_uri", async () => {
    stubServer({
      documents: officialDocuments({
        [AS_OPENID]: authorizationServerMetadata({
          jwks_uri: undefined,
        }),
      }),
    });
    expect(named(await doctor(), "signing-keys").ok).toBe(false);
  });

  it("only ever sends GET requests during discovery", async () => {
    const { fetchMock } = stubServer({ documents: officialDocuments() });
    await doctor();
    const writes = fetchMock.mock.calls.filter(
      ([input, init]) =>
        init?.method === "POST" && /register|oauth\/token/.test(String(input)),
    );
    expect(writes).toEqual([]);
  });
});

describe("user-isolation", () => {
  const readOnly = (name: string, extra: Partial<Tool> = {}): Tool => ({
    name,
    description: `Returns the ${name} for the signed-in user.`,
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    ...extra,
  });

  it("requires --token for --second-token", async () => {
    stubServer({});
    await expect(doctor({ secondToken: "b" })).rejects.toThrow(
      "--second-token requires --token",
    );
  });

  it("fails when both tokens are the same user, without calling any tool", async () => {
    const { calls } = stubServer({
      documents: officialDocuments(),
      tools: [readOnly("whoami")],
    });
    const checks = await doctor({
      token: unsignedJwt("user-1", { iat: 1 }),
      secondToken: unsignedJwt("user-1", { iat: 2 }),
    });
    const check = named(checks, "user-isolation");
    expect(check.ok).toBe(false);
    expect(check.blocking).toBeUndefined();
    expect(check.detail).toContain("same user");
    expect(calls.some((call) => call.method === "tools/call")).toBe(false);
  });

  it("passes when two users see different results, with heuristic wording", async () => {
    stubServer({
      documents: officialDocuments(),
      tools: [readOnly("whoami")],
      call: (_name, token) => ({
        content: [{ type: "text", text: `hello ${token}` }],
      }),
    });
    const checks = await doctor({
      token: unsignedJwt("user-1"),
      secondToken: unsignedJwt("user-2"),
    });
    const check = named(checks, "user-isolation");
    expect(check).toMatchObject({ ok: true, blocking: false });
    expect(check.detail).toContain("heuristic");
    expect(check.detail).toContain("not proof of isolation");
  });

  it("warns, naming the tool, when both users get the same result", async () => {
    stubServer({
      documents: officialDocuments(),
      tools: [readOnly("list_plans"), readOnly("whoami")],
      call: (name, token) => ({
        content: [
          { type: "text", text: name === "whoami" ? token : "same plans" },
        ],
        structuredContent: { b: 1, a: 2 },
      }),
    });
    const checks = await doctor({
      token: unsignedJwt("user-1"),
      secondToken: unsignedJwt("user-2"),
    });
    const check = named(checks, "user-isolation");
    expect(check).toMatchObject({ ok: false, blocking: false });
    expect(check.detail).toContain("Tool 'list_plans'");
    expect(check.detail).toContain(
      "returned the same result for both users; confirm this data is meant to be shared",
    );
    expect(check.detail).not.toContain("'whoami'");
    expect(checks.some((entry) => !entry.ok && entry.blocking !== false)).toBe(
      false,
    );
  });

  it("compares results independent of key order", async () => {
    let flip = false;
    stubServer({
      documents: officialDocuments(),
      tools: [readOnly("list_plans")],
      call: () => {
        flip = !flip;
        return {
          content: [{ type: "text", text: "plans" }],
          structuredContent: flip ? { a: 1, b: 2 } : { b: 2, a: 1 },
        };
      },
    });
    const check = named(
      await doctor({
        token: unsignedJwt("user-1"),
        secondToken: unsignedJwt("user-2"),
      }),
      "user-isolation",
    );
    expect(check.detail).toContain("returned the same result");
  });

  it("never calls tools that are not read-only or need inputs", async () => {
    const { calls } = stubServer({
      documents: officialDocuments(),
      tools: [
        readOnly("safe"),
        readOnly("delete_everything", { annotations: { readOnlyHint: false } }),
        readOnly("unmarked", { annotations: undefined }),
        readOnly("needs_input", {
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        }),
      ],
      call: (_name, token) => ({ content: [{ type: "text", text: token }] }),
    });
    await doctor({
      token: unsignedJwt("user-1"),
      secondToken: unsignedJwt("user-2"),
    });
    const called = new Set(
      calls.filter((call) => call.method === "tools/call").map((c) => c.tool),
    );
    expect([...called]).toEqual(["safe"]);
  });

  it("caps the tools it calls at 10 and says how many it skipped", async () => {
    const tools = Array.from({ length: 12 }, (_, index) =>
      readOnly(`tool_${index}`),
    );
    const { calls } = stubServer({
      documents: officialDocuments(),
      tools,
      call: (_name, token) => ({ content: [{ type: "text", text: token }] }),
    });
    const check = named(
      await doctor({
        token: unsignedJwt("user-1"),
        secondToken: unsignedJwt("user-2"),
      }),
      "user-isolation",
    );
    expect(calls.filter((call) => call.method === "tools/call")).toHaveLength(
      20,
    );
    expect(check.detail).toContain("2 more tools skipped");
  });

  it("says how to enable the check when no tool qualifies", async () => {
    stubServer({
      documents: officialDocuments(),
      tools: [readOnly("unmarked", { annotations: {} })],
    });
    const check = named(
      await doctor({
        token: unsignedJwt("user-1"),
        secondToken: unsignedJwt("user-2"),
      }),
      "user-isolation",
    );
    expect(check).toMatchObject({ ok: false, blocking: false });
    expect(check.detail).toContain("could not be checked");
    expect(check.detail).toContain("readOnlyHint");
  });

  it("notes, rather than fails, when a token is not a JWT", async () => {
    stubServer({
      documents: officialDocuments(),
      tools: [readOnly("whoami")],
      call: (_name, token) => ({ content: [{ type: "text", text: token }] }),
    });
    const check = named(
      await doctor({ token: "api-key-a", secondToken: "api-key-b" }),
      "user-isolation",
    );
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("not a JWT");
  });

  it("fails clearly when the second token is rejected", async () => {
    stubServer({
      documents: officialDocuments(),
      tools: [readOnly("whoami")],
      call: (_name, token) =>
        token === unsignedJwt("user-2")
          ? new Response("no", { status: 401 })
          : { content: [{ type: "text", text: token }] },
    });
    const check = named(
      await doctor({
        token: unsignedJwt("user-1"),
        secondToken: unsignedJwt("user-2"),
      }),
      "user-isolation",
    );
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("rejected --second-token");
  });

  it("never prints a token", async () => {
    const first = unsignedJwt("user-1");
    const second = unsignedJwt("user-2");
    stubServer({
      documents: officialDocuments(),
      tools: [readOnly("whoami")],
      call: (_name, token) => ({ content: [{ type: "text", text: token }] }),
    });
    const output = JSON.stringify(
      await doctor({ token: first, secondToken: second }),
    );
    expect(output).not.toContain(first);
    expect(output).not.toContain(second);
    expect(output).not.toContain("signature");
  });
});

describe("data-api-grants", () => {
  it("names the table from a Postgres permission error in a --call-tool result", async () => {
    stubServer({
      documents: officialDocuments(),
      tools: [{ name: "list_orders", description: "Lists your orders." }],
      call: () => ({
        isError: true,
        content: [
          { type: "text", text: 'permission denied for table "orders"' },
        ],
      }),
    });
    const checks = await doctor({ token: "key", callTool: "list_orders" });
    const check = named(checks, "data-api-grants");
    expect(check).toMatchObject({ ok: false, blocking: false });
    expect(check.detail).toContain("'public.orders'");
    expect(check.detail).toContain("2026-10-30");
    expect(check.detail).toContain("authenticated");
    expect(check.detail).toContain("grant select");
  });

  it("recognizes a schema error and the 42501 code", async () => {
    stubServer({
      documents: officialDocuments(),
      tools: [
        { name: "a", description: "Reads schema a thoroughly." },
        { name: "b", description: "Reads something else entirely." },
      ],
      call: (name) =>
        name === "a"
          ? {
              isError: true,
              content: [
                { type: "text", text: "permission denied for schema private" },
              ],
            }
          : {
              isError: true,
              content: [{ type: "text", text: '{"code":"42501"}' }],
            },
    });
    const first = await doctor({ token: "key", callTool: "a" });
    expect(named(first, "data-api-grants").detail).toContain(
      "grant usage on schema private",
    );
    const second = await doctor({ token: "key", callTool: "b" });
    expect(named(second, "data-api-grants").ok).toBe(false);
  });

  it("inspects isolation calls too, and a JSON-RPC error message", async () => {
    stubServer({
      documents: officialDocuments(),
      tools: [
        {
          name: "mine",
          description: "Lists what you own.",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object", properties: {} },
        },
      ],
      call: () =>
        Response.json({
          jsonrpc: "2.0",
          id: "x",
          error: {
            code: -32603,
            message: "permission denied for table projects",
          },
        }),
    });
    const checks = await doctor({
      token: unsignedJwt("user-1"),
      secondToken: unsignedJwt("user-2"),
    });
    expect(named(checks, "data-api-grants").detail).toContain(
      "'public.projects'",
    );
  });

  it("passes quietly when results carry no permission error", async () => {
    stubServer({
      documents: officialDocuments(),
      tools: [{ name: "ok", description: "Does a harmless thing." }],
    });
    const checks = await doctor({ token: "key", callTool: "ok" });
    expect(named(checks, "data-api-grants").ok).toBe(true);
  });

  it("is absent when doctor obtained no tool result", async () => {
    stubServer({ documents: officialDocuments(), tools: [] });
    const checks = await doctor({ token: "key" });
    expect(checks.some((check) => check.name === "data-api-grants")).toBe(
      false,
    );
  });
});

describe("tool-surface", () => {
  it("passes a well-described surface", async () => {
    stubServer({
      documents: officialDocuments(),
      tools: [
        {
          name: "whoami",
          description: "Returns the signed-in user.",
          annotations: { readOnlyHint: true },
          inputSchema: {
            type: "object",
            properties: { verbose: { type: "boolean", description: "More." } },
          },
        },
      ],
    });
    const check = named(await doctor({ token: "key" }), "tool-surface");
    expect(check).toMatchObject({ ok: true, blocking: false });
    expect(check.detail).toContain("no issues");
  });

  it("flags short descriptions, missing annotations, and bare input properties", async () => {
    stubServer({
      documents: officialDocuments(),
      tools: [
        {
          name: "short",
          description: "Too short",
          annotations: { readOnlyHint: true },
        },
        { name: "nodesc", annotations: { readOnlyHint: true } },
        {
          name: "unmarked",
          description: "Has a long enough description.",
          annotations: { title: "Unmarked" },
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string" },
              note: { type: "string", description: "A note." },
            },
          },
        },
        {
          name: "bare",
          description: "Has a long enough description.",
        },
      ],
    });
    const check = named(await doctor({ token: "key" }), "tool-surface");
    expect(check).toMatchObject({ ok: false, blocking: false });
    expect(check.detail).toContain("'short', 'nodesc'");
    expect(check.detail).toContain("'unmarked', 'bare'");
    expect(check.detail).toContain("1 input property without a description");
  });

  it("names at most five tools per rule", async () => {
    stubServer({
      documents: officialDocuments(),
      tools: Array.from({ length: 8 }, (_, index) => ({
        name: `tool_${index}`,
        annotations: { readOnlyHint: true },
      })),
    });
    const check = named(await doctor({ token: "key" }), "tool-surface");
    expect(check.detail).toContain("'tool_4' and 3 more");
    expect(check.detail).not.toContain("'tool_5'");
  });

  it("flags a result larger than 16 KiB", async () => {
    stubServer({
      documents: officialDocuments(),
      tools: [
        {
          name: "dump",
          description: "Dumps every row in the table.",
          annotations: { readOnlyHint: true },
        },
      ],
      call: () => ({
        content: [{ type: "text", text: "x".repeat(17 * 1024) }],
      }),
    });
    const check = named(
      await doctor({ token: "key", callTool: "dump" }),
      "tool-surface",
    );
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("larger than 16 KiB ('dump')");
  });

  it("does not run without tools/list", async () => {
    stubServer({ documents: officialDocuments() });
    const checks = await doctor();
    expect(checks.some((check) => check.name === "tool-surface")).toBe(false);
  });
});

describe("output and exit contract", () => {
  it("fails the run only for blocking checks", async () => {
    stubServer({
      documents: officialDocuments({
        [AS_OPENID]: authorizationServerMetadata({
          registration_endpoint: undefined,
        }),
      }),
      tools: [{ name: "bare" }],
    });
    const checks = await doctor({ token: "key" });
    const advisory = checks.filter(
      (check) => !check.ok && check.blocking === false,
    );
    expect(advisory.map((check) => check.name)).toEqual(
      expect.arrayContaining(["client-registration", "tool-surface"]),
    );
    expect(checks.some((check) => !check.ok && check.blocking !== false)).toBe(
      false,
    );
  });

  it("documents --second-token in the CLI help", async () => {
    const source = await readFile(
      join(import.meta.dirname, "..", "src", "cli.ts"),
      "utf8",
    );
    expect(source).toMatch(/--second-token <token>\s+Second user's token/);
  });
});

describe("a server composed like Supabase's official guide", () => {
  const origin = "https://p.supabase.co";

  async function officialServer() {
    vi.stubEnv("SUPABASE_FUNCTION_SLUG", "mcp");
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" };
    const sign = (sub: string) =>
      new SignJWT({ role: "authenticated" })
        .setProtectedHeader({ alg: "ES256", kid: "k1" })
        .setSubject(sub)
        .setIssuer(ISSUER)
        .setAudience("authenticated")
        .setExpirationTime("1h")
        .sign(privateKey);

    const notes: Record<string, string[]> = {
      "11111111-1111-4111-8111-111111111111": ["buy milk"],
      "22222222-2222-4222-8222-222222222222": ["call mom", "file taxes"],
    };
    const handleMcp = async (
      req: Request,
      ctx: { userClaims: { id: string } | null },
    ) => {
      const handler = createMcpHandler(() => {
        const server = new McpServer({ name: "fixture", version: "1.0.0" });
        server.registerTool(
          "whoami",
          {
            description: "Returns the signed-in user's id.",
            inputSchema: z.object({}),
            annotations: { readOnlyHint: true },
          },
          async () => ({
            content: [{ type: "text", text: `user ${ctx.userClaims?.id}` }],
          }),
        );
        server.registerTool(
          "list_notes",
          {
            description: "Lists the signed-in user's notes.",
            inputSchema: z.object({}),
            annotations: { readOnlyHint: true },
          },
          async () => ({
            content: [
              {
                type: "text",
                text: JSON.stringify(notes[ctx.userClaims?.id ?? ""] ?? []),
              },
            ],
          }),
        );
        return server;
      });
      return handler.fetch(req);
    };
    const serve = withOAuthProtectedResource(
      withSupabase(
        {
          auth: "user",
          env: {
            url: origin,
            publishableKeys: { default: "sb_publishable_fixture" },
            jwks: { keys: [jwk] },
          },
        },
        handleMcp,
      ),
    );

    // Route like the Supabase gateway: strip /functions/v1 and forward the
    // external origin. Auth serves its metadata and signing keys.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === "/auth/v1/.well-known/openid-configuration") {
          return Response.json(authorizationServerMetadata());
        }
        if (url.pathname === "/auth/v1/.well-known/jwks.json") {
          return Response.json({ keys: [jwk] });
        }
        if (url.pathname.startsWith("/functions/v1/mcp")) {
          const headers = new Headers(request.headers);
          headers.set("x-forwarded-host", url.host);
          headers.set("x-forwarded-proto", "https");
          const inner = new URL(request.url);
          inner.pathname = url.pathname.replace("/functions/v1", "");
          return serve(new Request(inner, new Request(request, { headers })));
        }
        return new Response("not found", { status: 404 });
      }),
    );
    return { sign };
  }

  it("passes discovery, signing keys, and user isolation for two users", async () => {
    const { sign } = await officialServer();
    const checks = await doctor({
      token: await sign("11111111-1111-4111-8111-111111111111"),
      secondToken: await sign("22222222-2222-4222-8222-222222222222"),
    });
    const failing = checks.filter((check) => !check.ok);
    expect(
      failing.filter((check) => check.blocking !== false),
      JSON.stringify(failing),
    ).toEqual([]);
    expect(named(checks, "oauth-challenge").detail).toContain(
      "/functions/v1/mcp/oauth-protected-resource",
    );
    expect(named(checks, "protected-resource-metadata").ok).toBe(true);
    expect(named(checks, "advertised-resource-url").ok).toBe(true);
    expect(named(checks, "authorization-server-metadata").ok).toBe(true);
    expect(named(checks, "issuer-match").ok).toBe(true);
    expect(named(checks, "signing-keys").ok).toBe(true);
    expect(named(checks, "authenticated-tools-list").ok).toBe(true);
    const isolation = named(checks, "user-isolation");
    expect(isolation.ok, isolation.detail).toBe(true);
    expect(named(checks, "tool-surface").ok).toBe(true);
  });

  it("flags the same user signed in twice", async () => {
    const { sign } = await officialServer();
    const sub = "11111111-1111-4111-8111-111111111111";
    const checks = await doctor({
      token: await sign(sub),
      secondToken: await sign(sub),
    });
    expect(named(checks, "user-isolation").detail).toMatch(/same (user|token)/);
  });
});

describe("endpoints that are not protected", () => {
  it("fails a plain HTML page that answers 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>hello</html>", {
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    const checks = await doctor();
    const initialize = named(checks, "mcp-initialize");
    expect(initialize.ok).toBe(false);
    expect(initialize.blocking).toBeUndefined();
  });

  it("passes a public MCP server and lints its tools", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { method: string };
        if (body.method === "initialize") {
          return rpc({ protocolVersion: "2025-03-26", capabilities: {} });
        }
        return rpc({ tools: [{ name: "bare" }] });
      }),
    );
    const checks = await doctor();
    expect(named(checks, "mcp-initialize").ok).toBe(true);
    expect(named(checks, "public-tools-list").ok).toBe(true);
    expect(named(checks, "tool-surface").detail).toContain("'bare'");
    expect(checks.some((check) => !check.ok && check.blocking !== false)).toBe(
      false,
    );
  });

  it("names the status and a next step for a non-401 client error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 405 })),
    );
    const challenge = named(await doctor(), "oauth-challenge");
    expect(challenge.ok).toBe(false);
    expect(challenge.detail).toContain("HTTP 405");
    expect(challenge.detail).toContain("Check that --url is the MCP endpoint");
  });
});

describe("local checks for a project that is not a Chumbo scaffold", () => {
  it("does not fail any local check for an official-guide function", async () => {
    const cwd = await emptyDirectory();
    const functionDir = join(cwd, "supabase", "functions", "mcp");
    await mkdir(functionDir, { recursive: true });
    await writeFile(
      join(cwd, "supabase", "config.toml"),
      'project_id = "official"\n',
    );
    await writeFile(
      join(functionDir, "index.ts"),
      'import { withSupabase } from "npm:@supabase/server@1.9.2";\nDeno.serve(withSupabase({ auth: "user" }, () => new Response("ok")));\n',
    );
    stubServer({ documents: officialDocuments() });
    const checks = await doctor({ cwd });
    for (const check of checks) {
      expect(check.name).not.toMatch(/^(gateway|dependencies|file:)/);
    }
  });
});

describe("runtime-reached wording", () => {
  it("keeps the original detail outside deep mode", async () => {
    stubServer({ documents: officialDocuments() });
    const checks = await doctor({ deep: false });
    expect(named(checks, "runtime-reached").detail).toBe(
      "response did not identify the Chumbo runtime",
    );
  });
});

describe("user-isolation always reports when --second-token is set", () => {
  const readOnly: Tool = {
    name: "mine",
    description: "Lists what the user owns.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  };
  const tokens = {
    token: unsignedJwt("user-1", { email: "one@example.com" }),
    secondToken: unsignedJwt("user-2", { email: "two@example.com" }),
  };

  async function isolation(
    call: (name: string, token: string) => Record<string, unknown>,
  ): Promise<DoctorCheck> {
    stubServer({ documents: officialDocuments(), tools: [readOnly], call });
    return named(await doctor(tokens), "user-isolation");
  }

  it("treats results that differ only by identity as nothing to compare", async () => {
    const check = await isolation((_name, token) => {
      const claims = JSON.parse(
        Buffer.from(token.split(".")[1]!, "base64url").toString(),
      ) as { sub: string; email: string };
      return {
        content: [
          {
            type: "text",
            text: `signed in as ${claims.email} (${claims.sub})`,
          },
        ],
      };
    });
    expect(check).toMatchObject({ ok: false, blocking: false });
    expect(check.detail).toContain("could not be checked");
  });

  it.each([
    ["an empty array", [{ type: "text", text: "[]" }], undefined],
    ["an empty object", [{ type: "text", text: "{}" }], undefined],
    ["an empty string", [{ type: "text", text: "" }], undefined],
    ["empty content", [], undefined],
    [
      "an empty items list",
      [{ type: "text", text: '{"items":[]}' }],
      undefined,
    ],
    ["empty structured content", [], { items: [] }],
  ])(
    "does not warn about identical %s",
    async (_label, content, structured) => {
      const check = await isolation(() => ({
        content,
        ...(structured ? { structuredContent: structured } : {}),
      }));
      expect(check.ok).toBe(false);
      expect(check.detail).toContain("could not be checked");
      expect(check.detail).not.toContain("same result");
    },
  );

  it("still warns when real data is identical", async () => {
    const check = await isolation(() => ({
      content: [{ type: "text", text: '{"items":["shared"]}' }],
    }));
    expect(check.detail).toContain("returned the same result");
  });

  it("passes on differing rows even when identity is also present", async () => {
    const check = await isolation((_name, token) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            rows: token === tokens.token ? ["a"] : ["b", "c"],
            owner: JSON.parse(
              Buffer.from(token.split(".")[1]!, "base64url").toString(),
            ).sub,
          }),
        },
      ],
    }));
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("heuristic");
  });

  it("explains itself for identical tokens, even when they are not JWTs", async () => {
    stubServer({ documents: officialDocuments(), tools: [readOnly] });
    const check = named(
      await doctor({ token: "key-1", secondToken: "key-1" }),
      "user-isolation",
    );
    expect(check.ok).toBe(false);
    expect(check.blocking).toBeUndefined();
    expect(check.detail).toContain("same token");
  });

  it("explains itself for a public server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => rpc({ tools: [], protocolVersion: "x" })),
    );
    const check = named(await doctor(tokens), "user-isolation");
    expect(check).toMatchObject({ ok: false, blocking: false });
    expect(check.detail).toContain("does not ask for sign-in");
  });

  it("explains itself when no tools are discovered", async () => {
    stubServer({
      documents: officialDocuments(),
      tools: [{ name: "bare", description: "No annotations at all." }],
    });
    const check = named(await doctor(tokens), "user-isolation");
    expect(check).toMatchObject({ ok: false, blocking: false });
  });

  it("explains itself when doctor stops early", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("down"))),
    );
    const check = named(await doctor(tokens), "user-isolation");
    expect(check).toMatchObject({ ok: false, blocking: false });
    expect(check.detail).toContain("stopped");
  });

  it("counts a tool's result once, however many users called it", async () => {
    stubServer({
      documents: officialDocuments(),
      tools: [{ ...readOnly, name: "bare", description: undefined }],
      call: (_name, token) => ({ content: [{ type: "text", text: token }] }),
    });
    const checks = await doctor(tokens);
    expect(named(checks, "tool-surface").detail).toContain("1 result checked");
  });
});

describe("data-api-grants reads errors only", () => {
  it("ignores permission text inside successful data", async () => {
    stubServer({
      documents: officialDocuments(),
      tools: [{ name: "notes", description: "Lists the user's notes." }],
      call: () => ({
        content: [
          { type: "text", text: "note: permission denied for table orders" },
        ],
      }),
    });
    const check = named(
      await doctor({ token: "key", callTool: "notes" }),
      "data-api-grants",
    );
    expect(check.ok).toBe(true);
  });

  it("keeps the schema and explains local resets", async () => {
    stubServer({
      documents: officialDocuments(),
      tools: [{ name: "list", description: "Lists the user's rows." }],
      call: () => ({
        isError: true,
        content: [
          { type: "text", text: 'permission denied for table "app"."orders"' },
        ],
      }),
    });
    const check = named(
      await doctor({ token: "key", callTool: "list" }),
      "data-api-grants",
    );
    expect(check.detail).toContain(
      "grant select on table app.orders to authenticated;",
    );
    expect(check.detail).toContain("insert, update, or delete");
    expect(check.detail).toContain("supabase db reset");
    expect(check.detail).toContain("preview branches");
  });
});

describe("limits and hardening", () => {
  it("reports a timeout with the URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init?: RequestInit) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        throw new DOMException("timed out", "TimeoutError");
      }),
    );
    const check = named(await doctor(), "endpoint-reachable");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("timed out after 10 seconds at " + MCP);
  });

  it("does not read a discovery body over 256 KiB", async () => {
    stubServer({
      documents: officialDocuments({
        [JWKS]: { keys: [asymmetricKey], padding: "x".repeat(300 * 1024) },
      }),
    });
    const check = named(await doctor(), "signing-keys");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("more than 256 KiB");
  });

  it.each([
    ["data:", 'data:application/json,{"resource":"x"}'],
    ["file:", "file:///etc/passwd"],
    ["plain http", "http://evil.example/prm"],
  ])("rejects a %s resource_metadata without fetching it", async (_l, url) => {
    const { fetchMock } = stubServer({
      challenge: `Bearer resource_metadata="${url}"`,
      documents: {},
    });
    const checks = await doctor();
    const check = named(checks, "protected-resource-metadata");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("not an https URL");
    expect(fetchMock.mock.calls.some(([input]) => String(input) === url)).toBe(
      false,
    );
  });

  it("rejects non-https authorization servers, jwks_uri, and registration endpoints", async () => {
    stubServer({
      documents: officialDocuments({
        [PRM_SUFFIX]: {
          resource: MCP,
          authorization_servers: ["file:///etc/passwd"],
        },
      }),
    });
    expect(
      named(await doctor(), "authorization-server-metadata").detail,
    ).toContain("not an https URL");

    const { fetchMock } = stubServer({
      documents: officialDocuments({
        [AS_OPENID]: authorizationServerMetadata({
          jwks_uri: "data:application/json,{}",
          registration_endpoint: "http://evil.example/register",
        }),
      }),
    });
    const checks = await doctor();
    expect(named(checks, "signing-keys").ok).toBe(false);
    expect(named(checks, "signing-keys").blocking).toBeUndefined();
    const registration = named(checks, "client-registration");
    expect(registration.ok).toBe(false);
    expect(registration.blocking).toBeUndefined();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        /evil\.example/.test(String(input)),
      ),
    ).toBe(false);
  });

  it("strips control characters from server-supplied text", async () => {
    stubServer({
      documents: officialDocuments(),
      tools: [
        {
          name: "evil\u001b[31mtool\u0007\u009b",
          description: "Short",
          annotations: { readOnlyHint: true },
        },
      ],
    });
    const checks = await doctor({ token: "key" });
    const output = JSON.stringify(checks);
    // eslint-disable-next-line no-control-regex
    expect(output).not.toMatch(/\\u001b|\\u0007|\\u009b/);
    expect(named(checks, "tool-surface").detail).toContain("eviltool");
  });
});

describe("credential handling", () => {
  const token = unsignedJwt("user-1");
  const second = unsignedJwt("user-2");

  function hostileServer() {
    const authorized: Array<{ url: string; redirect?: string }> = [];
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const headers = new Headers(init?.headers);
        if (headers.has("authorization")) {
          authorized.push({ url, redirect: init?.redirect });
        }
        if (init?.method === "GET") {
          if (url === "https://evil.example/prm") {
            return Response.json({
              resource: MCP,
              authorization_servers: ["https://evil.example/as"],
            });
          }
          if (url.startsWith("https://evil.example/as/.well-known")) {
            return Response.json(
              authorizationServerMetadata({
                issuer: "https://evil.example/as",
                jwks_uri: "https://evil.example/jwks",
                registration_endpoint: "https://evil.example/register",
              }),
            );
          }
          if (url === "https://evil.example/jwks") {
            return Response.json({ keys: [asymmetricKey] });
          }
          return new Response("nope", { status: 404 });
        }
        const body = JSON.parse(String(init?.body)) as { method: string };
        if (!headers.has("authorization")) {
          return Response.json(
            {},
            {
              status: 401,
              headers: {
                "www-authenticate":
                  'Bearer resource_metadata="https://evil.example/prm"',
              },
            },
          );
        }
        if (body.method === "initialize") {
          return rpc({ protocolVersion: "x", capabilities: {} });
        }
        if (body.method === "tools/list") {
          return rpc({
            tools: [
              {
                name: "mine",
                description: "Lists what the user owns.",
                annotations: { readOnlyHint: true },
                inputSchema: { type: "object", properties: {} },
              },
            ],
          });
        }
        return rpc({ content: [{ type: "text", text: token }] });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, authorized };
  }

  it("sends tokens only to --url, with redirects disabled, even for hostile metadata", async () => {
    const { fetchMock, authorized } = hostileServer();
    await doctor({ token, secondToken: second });
    expect(authorized.length).toBeGreaterThanOrEqual(4);
    for (const request of authorized) {
      expect(request.url).toBe(MCP);
      expect(request.redirect).toBe("error");
    }
    const evil = fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith("https://evil.example"),
    );
    expect(evil.length).toBeGreaterThan(0);
    for (const [, init] of evil) {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(init?.method).toBe("GET");
    }
  });

  it("fails cleanly on a redirect from an authenticated request and does not follow it", async () => {
    const followed: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        if (!headers.has("authorization")) {
          return Response.json(
            {},
            {
              status: 401,
              headers: {
                "www-authenticate": `Bearer resource_metadata="${PRM_SUFFIX}"`,
              },
            },
          );
        }
        if (url !== MCP) followed.push(url);
        if (init?.redirect === "error") throw new TypeError("redirect");
        followed.push("https://evil.example/stolen");
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/stolen" },
        });
      }),
    );
    const checks = await doctor({ token });
    expect(followed).toEqual([]);
    expect(
      checks.some((check) => check.name === "endpoint-reachable" && !check.ok),
    ).toBe(true);
  });

  it("sends Accept for Streamable HTTP on every MCP POST", async () => {
    const { fetchMock } = stubServer({
      documents: officialDocuments(),
      tools: [{ name: "x", description: "Does a thing, usefully." }],
    });
    await doctor({ token: "key" });
    const posts = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === "POST",
    );
    expect(posts.length).toBeGreaterThan(2);
    for (const [, init] of posts) {
      expect(new Headers(init?.headers).get("accept")).toBe(
        "application/json, text/event-stream",
      );
    }
  });
});

describe("function name in recovery advice", () => {
  it("does not name a default function when none is known", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("missing", { status: 404 })),
    );
    const check = named(
      await doctor({ functionKnown: false }),
      "function-reachable",
    );
    expect(check.detail).toContain("deploy the function at this URL");
    expect(check.detail).not.toContain("'mcp'");
  });

  it("reads the name from a /functions/v1/<name> URL", async () => {
    const { functionNameFromUrl } = await import("../src/doctor.js");
    expect(
      functionNameFromUrl("https://p.supabase.co/functions/v1/notes/x"),
    ).toBe("notes");
    expect(functionNameFromUrl("https://app.example.com/mcp")).toBeUndefined();
  });
});
