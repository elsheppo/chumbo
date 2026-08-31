import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runDoctor } from "../src/doctor.js";
import {
  applyPlan,
  PACKAGE_VERSION,
  patchFunctionConfig,
  planInit,
  resolveLocalMcpEndpoint,
} from "../src/project.js";
import {
  buildSetupReport as buildSetupReportInternal,
  detectGeneratedAuth,
  endpointFor,
  formatSetupReport,
  inspectGeneratedAuth,
  normalizePublicUrl,
  SUPA_MCP_DOCUMENTATION_SERVER_URL,
  type BuildSetupReportOptions,
} from "../src/setup.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chumbo-"));
  await mkdir(join(root, "supabase"), { recursive: true });
  await writeFile(
    join(root, "supabase", "config.toml"),
    'project_id = "fixture"\n\n[api]\nport = 54321\n',
  );
  return root;
}

function buildSetupReport(
  options: Omit<BuildSetupReportOptions, "localEndpoint"> & {
    localEndpoint?: string;
  },
) {
  return buildSetupReportInternal({
    ...options,
    localEndpoint:
      options.localEndpoint ??
      `http://127.0.0.1:54321/functions/v1/${options.functionName}`,
  });
}

describe("release version", () => {
  it("keeps the manifest and generated runtime pin aligned", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(PACKAGE_VERSION).toBe(manifest.version);
  });

  it("keeps the generated and living-reference durable-state SQL identical", async () => {
    const template = await readFile(
      new URL("../templates/migrations/durable-state.sql.tpl", import.meta.url),
      "utf8",
    );
    const reference = await readFile(
      new URL(
        "../supabase/migrations/20260826042151_create_supa_mcp_durable_state.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(reference).toBe(template);
  });
});

describe("config patching", () => {
  it("adds a function section without changing existing content", () => {
    expect(patchFunctionConfig("[api]\nport = 54321\n", "mcp")).toBe(
      "[api]\nport = 54321\n\n[functions.mcp]\nverify_jwt = false\n",
    );
  });

  it("updates only the target function's gateway setting", () => {
    const source =
      '[functions.mcp]\nverify_jwt = true\nimport_map = "./deno.json"\n\n[functions.other]\nverify_jwt = true\n';
    const output = patchFunctionConfig(source, "mcp");
    expect(output).toContain(
      '[functions.mcp]\nverify_jwt = false\nimport_map = "./deno.json"',
    );
    expect(output).toContain("[functions.other]\nverify_jwt = true");
  });

  it("resolves the local MCP endpoint from the configured Supabase API port", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "supabase", "config.toml"),
      'project_id = "fixture"\n\n[api]\nport = 57321 # project-specific\n',
    );
    const endpoint = await resolveLocalMcpEndpoint(root, "mcp");
    expect(endpoint).toBe("http://127.0.0.1:57321/functions/v1/mcp");

    const plan = await planInit({
      cwd: root,
      functionName: "mcp",
      serverName: "Custom port fixture",
      auth: "bearer",
      consent: "none",
      patchConfig: true,
    });
    expect(
      plan.find((file) => file.path.endsWith("README.md"))?.content,
    ).toContain(`--url ${endpoint}`);
    expect(
      plan.find((file) => file.path.endsWith("index_test.ts"))?.content,
    ).toContain(endpoint);

    const report = buildSetupReport({
      command: "setup",
      projectRoot: root,
      functionName: "mcp",
      localEndpoint: endpoint,
      auth: "bearer",
      consent: "none",
      files: [],
      applied: true,
      planned: false,
    });
    expect(report.localEndpoint).toBe(endpoint);
    expect(report.steps.find((step) => step.id === "serve_local")?.url).toBe(
      endpoint,
    );
    expect(
      report.steps.find((step) => step.id === "verify_local")?.command,
    ).toContain(`--url ${endpoint}`);
  });

  it("uses port 54321 only when the Supabase API port is absent", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "supabase", "config.toml"),
      'project_id = "fixture"\n',
    );
    await expect(resolveLocalMcpEndpoint(root, "mcp")).resolves.toBe(
      "http://127.0.0.1:54321/functions/v1/mcp",
    );
  });

  it("rejects an invalid configured API port instead of silently using the default", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "supabase", "config.toml"),
      'project_id = "fixture"\n\n[api]\nport = "57321"\n',
    );
    await expect(resolveLocalMcpEndpoint(root, "mcp")).rejects.toThrow(
      "[api].port must be an integer",
    );
  });
});

describe("initializer", () => {
  it("plans all generated files without mutating the project", async () => {
    const root = await fixture();
    const plan = await planInit({
      cwd: root,
      functionName: "mcp",
      serverName: "Fixture",
      auth: "oauth",
      consent: "minimal",
      patchConfig: true,
    });
    expect(plan.filter((file) => file.status === "create")).toHaveLength(6);
    expect(plan.some((file) => file.status === "update")).toBe(true);
    expect(
      plan.find((file) => file.path.endsWith("deno.json"))?.content,
    ).toContain(`npm:chumbo@${PACKAGE_VERSION}`);
    await expect(
      readFile(join(root, "supabase", "functions", "mcp", "index.ts")),
    ).rejects.toThrow();
  });

  it("generates a consent function that supports hosted and local key environments", async () => {
    const root = await fixture();
    await applyPlan(
      await planInit({
        cwd: root,
        functionName: "mcp",
        serverName: "Fixture",
        auth: "oauth",
        consent: "minimal",
        patchConfig: true,
      }),
    );
    const consent = await readFile(
      join(root, "supabase", "functions", "mcp-consent", "index.ts"),
      "utf8",
    );
    expect(consent).toContain('Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")');
    expect(consent).toContain('Deno.env.get("SUPABASE_PUBLISHABLE_KEY")');
    expect(consent).toContain('Deno.env.get("SUPABASE_ANON_KEY")');

    const generatedTest = await readFile(
      join(root, "supabase", "functions", "mcp", "index_test.ts"),
      "utf8",
    );
    expect(generatedTest).toContain("Deno.env.set(");
    expect(generatedTest).toContain('"SUPABASE_URL"');
    expect(generatedTest).toContain('await import("./index.ts")');

    const entrypoint = await readFile(
      join(root, "supabase", "functions", "mcp", "index.ts"),
      "utf8",
    );
    expect(entrypoint).toContain('Deno.env.get("MCP_PUBLIC_URL")');
    expect(entrypoint).toContain("issuer: new URL(`${projectUrl}/auth/v1`)");
  });

  it("applies idempotently and refuses a conflicting capability file", async () => {
    const root = await fixture();
    const options = {
      cwd: root,
      functionName: "mcp",
      serverName: "Fixture",
      auth: "oauth" as const,
      consent: "none" as const,
      patchConfig: true,
    };
    await applyPlan(await planInit(options));
    const rerun = await planInit(options);
    expect(rerun.every((file) => file.status === "unchanged")).toBe(true);

    const capabilityPath = join(
      root,
      "supabase",
      "functions",
      "mcp",
      "capabilities.ts",
    );
    await writeFile(capabilityPath, "// application-owned\n");
    const conflict = await planInit(options);
    expect(conflict.find((file) => file.path === capabilityPath)?.status).toBe(
      "conflict",
    );
    await expect(applyPlan(conflict)).rejects.toThrow("Refusing to overwrite");
  });

  it("guardrails an explicitly public scaffold without changing other modes", async () => {
    const root = await fixture();
    const publicPlan = await planInit({
      cwd: root,
      functionName: "public-mcp",
      serverName: "Public fixture",
      auth: "public",
      consent: "none",
      patchConfig: true,
    });
    await applyPlan(publicPlan);

    const entrypoint = await readFile(
      join(root, "supabase", "functions", "public-mcp", "index.ts"),
      "utf8",
    );
    expect(entrypoint).toContain('auth: { mode: "public", rateLimit: true }');
    const publicTest = await readFile(
      join(root, "supabase", "functions", "public-mcp", "index_test.ts"),
      "utf8",
    );
    expect(publicTest).toContain("rate-limit guardrail");
    expect(publicTest).not.toContain("OAuth challenge");
    const migration = publicPlan.find((file) =>
      file.path.endsWith("create_supa_mcp_rate_limits.sql"),
    );
    expect(migration?.status).toBe("create");
    expect(migration?.content).toContain("security invoker");
    expect(migration?.content).toContain("grant execute");
    const publicReadme = await readFile(
      join(root, "supabase", "functions", "public-mcp", "README.md"),
      "utf8",
    );
    expect(publicReadme).toContain("supabase migration up --local");
    expect(publicReadme).toContain(
      "supabase start\nsupabase migration up --local\nnpx chumbo dev --function public-mcp",
    );

    const oauthRoot = await fixture();
    const oauthPlan = await planInit({
      cwd: oauthRoot,
      functionName: "mcp",
      serverName: "OAuth fixture",
      auth: "oauth",
      consent: "none",
      patchConfig: true,
    });
    expect(oauthPlan.some((file) => file.path.includes("migrations"))).toBe(
      false,
    );
  });

  it("generates the simple application API-key happy path", async () => {
    const root = await fixture();
    const plan = await planInit({
      cwd: root,
      functionName: "app-mcp",
      serverName: "Application fixture",
      auth: "api-key",
      consent: "none",
      patchConfig: true,
    });
    await applyPlan(plan);

    const entrypoint = await readFile(
      join(root, "supabase", "functions", "app-mcp", "index.ts"),
      "utf8",
    );
    expect(entrypoint).toContain('Deno.env.get("MCP_API_KEY")');
    expect(entrypoint).toContain('auth: { mode: "api-key", key: mcpApiKey }');
    expect(entrypoint).toContain(
      "Use the available capabilities according to their descriptions.",
    );
    expect(entrypoint).not.toContain("Call whoami");
    expect(plan.some((file) => file.path.includes("migrations"))).toBe(false);

    const capabilities = await readFile(
      join(root, "supabase", "functions", "app-mcp", "capabilities.ts"),
      "utf8",
    );
    expect(capabilities.match(/server\.registerTool\(/g)).toHaveLength(1);
    expect(capabilities).toContain('"whoami"');
    expect(capabilities).toContain("ctx.supabase");
    expect(capabilities).toContain("database authority follows");
    expect(capabilities).not.toContain("registerResource");
    expect(capabilities).not.toContain("registerPrompt");
    expect(capabilities).not.toContain("inputRequired");

    const generatedTest = await readFile(
      join(root, "supabase", "functions", "app-mcp", "index_test.ts"),
      "utf8",
    );
    expect(generatedTest).toContain(
      "the configured key discovers and invokes the starter",
    );
    expect(await detectGeneratedAuth(root, "app-mcp")).toBe("api-key");
    expect(await inspectGeneratedAuth(root, "app-mcp")).toEqual({
      mode: "api-key",
      apiKeyStrategy: "static",
    });
    const generatedReadme = await readFile(
      join(root, "supabase", "functions", "app-mcp", "README.md"),
      "utf8",
    );
    expect(generatedReadme).toContain("supabase/functions/.env.local");
    expect(generatedReadme).toContain(
      "chumbo dev --function app-mcp --env-file supabase/functions/.env.local",
    );
    expect(generatedReadme).toContain(
      'supabase secrets set MCP_API_KEY="replace-with-a-long-random-key"',
    );
  });

  it("describes request-scoped database authority for every access mode", async () => {
    const expectations = {
      oauth: "carries that user's Supabase access token",
      bearer: "carries that user's Supabase access token",
      "api-key": "an anonymous Supabase client",
      public: "Supabase's anonymous RLS role",
    } as const;

    for (const [auth, expected] of Object.entries(expectations)) {
      const root = await fixture();
      const plan = await planInit({
        cwd: root,
        functionName: "mcp",
        serverName: "Authority fixture",
        auth: auth as keyof typeof expectations,
        consent: "none",
        patchConfig: false,
      });
      const readme = plan.find((file) => file.path.endsWith("README.md"));
      expect(readme?.content).toContain(
        "`ctx.supabase` is request-scoped. Its database authority follows the access",
      );
      expect(readme?.content).toContain(expected);
      expect(readme?.content).not.toContain("authenticated MCP boundary");
      expect(readme?.content).not.toContain("connected user's existing grants");
    }
  });

  it("keeps durable state opt-in and generates its complete protected setup", async () => {
    const statelessRoot = await fixture();
    const explicitStatelessRoot = await fixture();
    const common = {
      functionName: "mcp",
      serverName: "State fixture",
      auth: "oauth" as const,
      consent: "none" as const,
      patchConfig: true,
    };
    const stateless = await planInit({ cwd: statelessRoot, ...common });
    const explicitStateless = await planInit({
      cwd: explicitStatelessRoot,
      ...common,
      stateNamespace: undefined,
    });
    expect(
      stateless.map((file) => ({
        relative: file.path.slice(statelessRoot.length),
        content: file.content,
        status: file.status,
      })),
    ).toEqual(
      explicitStateless.map((file) => ({
        relative: file.path.slice(explicitStatelessRoot.length),
        content: file.content,
        status: file.status,
      })),
    );
    expect(stateless.some((file) => file.path.includes("durable_state"))).toBe(
      false,
    );

    const stateRoot = await fixture();
    const stateful = await planInit({
      cwd: stateRoot,
      ...common,
      stateNamespace: "file-ide.observations",
    });
    const entrypoint = stateful.find((file) => file.path.endsWith("index.ts"));
    expect(entrypoint?.content).toContain("CHUMBO_STATE_HMAC_KEY");
    expect(entrypoint?.content).toContain(
      'namespaces: { "file-ide.observations": { ttlSeconds: 86400 } }',
    );
    const generatedTest = stateful.find((file) =>
      file.path.endsWith("index_test.ts"),
    );
    expect(generatedTest?.content).toContain(
      'Deno.env.set("CHUMBO_STATE_HMAC_KEY"',
    );
    expect(generatedTest?.content).toContain(
      'Deno.env.set("SUPABASE_SECRET_KEY"',
    );
    const migration = stateful.find((file) =>
      file.path.endsWith("create_supa_mcp_durable_state.sql"),
    );
    expect(migration?.content).toContain(
      "alter table private.supa_mcp_state enable row level security",
    );
    expect(migration?.content).toContain("security invoker");
    expect(migration?.content).toContain("to service_role");
    expect(migration?.content).toContain("from public, anon, authenticated");
    await applyPlan(stateful);
    expect(await inspectGeneratedAuth(stateRoot, "mcp")).toEqual({
      mode: "oauth",
      stateNamespace: "file-ide.observations",
    });

    await expect(
      planInit({
        cwd: await fixture(),
        ...common,
        stateNamespace: "../escape",
      }),
    ).rejects.toThrow("namespaces");
    await expect(
      planInit({
        cwd: await fixture(),
        ...common,
        auth: "public",
        stateNamespace: "observations",
      }),
    ).rejects.toThrow("protected authentication");
  });
});

describe("doctor", () => {
  function requestMethod(init?: RequestInit): string | undefined {
    if (typeof init?.body !== "string") return undefined;
    return (JSON.parse(init.body) as { method?: string }).method;
  }

  function initialized(): Response {
    return Response.json({
      jsonrpc: "2.0",
      id: "initialize",
      result: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        serverInfo: { name: "fixture", version: "1.0.0" },
      },
    });
  }

  it("checks OAuth discovery before an authenticated tools/list", async () => {
    const root = await fixture();
    await applyPlan(
      await planInit({
        cwd: root,
        functionName: "mcp",
        serverName: "Fixture",
        auth: "oauth",
        consent: "none",
        patchConfig: true,
      }),
    );
    const mcpUrl = "https://project.supabase.co/functions/v1/mcp";
    const metadataUrl = `${mcpUrl}/.well-known/oauth-protected-resource`;
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === metadataUrl) {
          return Response.json({
            resource: mcpUrl,
            authorization_servers: ["https://project.supabase.co/auth/v1"],
          });
        }
        const headers = new Headers(init?.headers);
        if (headers.has("authorization")) {
          if (requestMethod(init) === "initialize") return initialized();
          return Response.json({
            jsonrpc: "2.0",
            id: "authenticated",
            result: { tools: [{ name: "whoami" }] },
          });
        }
        return Response.json(
          { error: "invalid_token" },
          {
            status: 401,
            headers: {
              "www-authenticate": `Bearer resource_metadata="${metadataUrl}"`,
            },
          },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const checks = await runDoctor({
        cwd: root,
        functionName: "mcp",
        url: mcpUrl,
        token: "test-user-jwt",
      });
      expect(
        checks.filter((check) =>
          [
            "oauth-challenge",
            "protected-resource-metadata",
            "advertised-resource-url",
            "authenticated-tools-list",
          ].includes(check.name),
        ),
      ).toEqual([
        expect.objectContaining({ name: "oauth-challenge", ok: true }),
        expect.objectContaining({
          name: "protected-resource-metadata",
          ok: true,
        }),
        expect.objectContaining({
          name: "advertised-resource-url",
          ok: true,
        }),
        expect.objectContaining({
          name: "authenticated-tools-list",
          ok: true,
        }),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("initializes, discovers, and explicitly calls one public tool", async () => {
    const root = await fixture();
    await applyPlan(
      await planInit({
        cwd: root,
        functionName: "public-mcp",
        serverName: "Public fixture",
        auth: "public",
        consent: "none",
        patchConfig: true,
      }),
    );
    const fetchMock = vi.fn(async (_input, init?: RequestInit) => {
      if (requestMethod(init) === "initialize") return initialized();
      if (requestMethod(init) === "tools/call") {
        return Response.json({
          jsonrpc: "2.0",
          id: "call",
          result: { content: [{ type: "text", text: "ok" }] },
        });
      }
      return Response.json(
        {
          jsonrpc: "2.0",
          id: "list",
          result: { tools: [{ name: "whoami" }] },
        },
        { headers: { "x-ratelimit-limit": "60" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const checks = await runDoctor({
        cwd: root,
        functionName: "public-mcp",
        url: "http://127.0.0.1:54321/functions/v1/public-mcp",
        callTool: "whoami",
      });
      expect(checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "mcp-initialize", ok: true }),
          expect.objectContaining({ name: "public-tools-list", ok: true }),
          expect.objectContaining({ name: "tool-call", ok: true }),
        ]),
      );
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses to call a tool that discovery did not advertise", async () => {
    const root = await fixture();
    await applyPlan(
      await planInit({
        cwd: root,
        functionName: "public-mcp",
        serverName: "Public fixture",
        auth: "public",
        consent: "none",
        patchConfig: true,
      }),
    );
    const fetchMock = vi.fn(async (_input, init?: RequestInit) =>
      requestMethod(init) === "initialize"
        ? initialized()
        : Response.json(
            {
              jsonrpc: "2.0",
              id: "list",
              result: { tools: [{ name: "whoami" }] },
            },
            { headers: { "x-ratelimit-limit": "60" } },
          ),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const checks = await runDoctor({
        cwd: root,
        functionName: "public-mcp",
        url: "http://127.0.0.1:54321/functions/v1/public-mcp",
        callTool: "delete_everything",
      });
      expect(checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "tool-call",
            ok: false,
            detail: expect.stringContaining("was not discovered"),
          }),
        ]),
      );
      expect(
        fetchMock.mock.calls.some(
          ([, init]) => requestMethod(init) === "tools/call",
        ),
      ).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("stops before discovery when MCP initialization fails", async () => {
    const root = await fixture();
    await applyPlan(
      await planInit({
        cwd: root,
        functionName: "public-mcp",
        serverName: "Public fixture",
        auth: "public",
        consent: "none",
        patchConfig: true,
      }),
    );
    const fetchMock = vi.fn(async (_input, init?: RequestInit) =>
      requestMethod(init) === "initialize"
        ? Response.json({
            jsonrpc: "2.0",
            id: "initialize",
            error: { code: -32603, message: "private runtime detail" },
          })
        : Response.json(
            { jsonrpc: "2.0", id: "list", result: { tools: [] } },
            { headers: { "x-ratelimit-limit": "60" } },
          ),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const checks = await runDoctor({
        cwd: root,
        functionName: "public-mcp",
        url: "http://127.0.0.1:54321/functions/v1/public-mcp",
      });
      expect(checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "mcp-initialize",
            ok: false,
            detail: expect.stringContaining("MCP error -32603"),
          }),
        ]),
      );
      expect(checks.some((check) => check.name === "public-tools-list")).toBe(
        false,
      );
      expect(JSON.stringify(checks)).not.toContain("private runtime detail");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports an MCP error result as a failed capability proof without leaking credentials or arguments", async () => {
    const root = await fixture();
    await applyPlan(
      await planInit({
        cwd: root,
        functionName: "app-mcp",
        serverName: "Application fixture",
        auth: "api-key",
        consent: "none",
        patchConfig: true,
      }),
    );
    const token = "private-test-token";
    const privateArgument = "private-call-value";
    const fetchMock = vi.fn(async (_input, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (!headers.has("authorization")) {
        return Response.json(
          { error: "invalid_token" },
          {
            status: 401,
            headers: {
              "x-chumbo-version": PACKAGE_VERSION,
              "x-chumbo-auth-mode": "api-key",
              "x-chumbo-auth-strategy": "static",
            },
          },
        );
      }
      if (requestMethod(init) === "initialize") return initialized();
      if (requestMethod(init) === "tools/list") {
        return Response.json({
          jsonrpc: "2.0",
          id: "list",
          result: { tools: [{ name: "publish" }] },
        });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: "call",
        result: {
          isError: true,
          content: [{ type: "text", text: privateArgument }],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const checks = await runDoctor({
        cwd: root,
        functionName: "app-mcp",
        url: "http://127.0.0.1:54321/functions/v1/app-mcp",
        token,
        callTool: "publish",
        callArgs: { draft: privateArgument },
      });
      expect(checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "mcp-initialize", ok: true }),
          expect.objectContaining({
            name: "authenticated-tools-list",
            ok: true,
          }),
          expect.objectContaining({
            name: "tool-call",
            ok: false,
            detail: expect.stringContaining("MCP error result"),
          }),
        ]),
      );
      const diagnosticOutput = JSON.stringify(checks);
      expect(diagnosticOutput).not.toContain(token);
      expect(diagnosticOutput).not.toContain(privateArgument);
      const call = fetchMock.mock.calls.find(
        ([, init]) => requestMethod(init) === "tools/call",
      );
      expect(new Headers(call?.[1]?.headers).get("authorization")).toBe(
        `Bearer ${token}`,
      );
      expect(call?.[1]?.body).toContain(privateArgument);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("classifies a rejected protected credential without echoing it", async () => {
    const root = await fixture();
    await applyPlan(
      await planInit({
        cwd: root,
        functionName: "app-mcp",
        serverName: "Application fixture",
        auth: "api-key",
        consent: "none",
        patchConfig: true,
      }),
    );
    const token = "rejected-private-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init?: RequestInit) =>
        Response.json(
          { error: "invalid_token" },
          {
            status: 401,
            headers:
              requestMethod(init) === "tools/list" &&
              !new Headers(init?.headers).has("authorization")
                ? {
                    "x-chumbo-version": PACKAGE_VERSION,
                    "x-chumbo-auth-mode": "api-key",
                    "x-chumbo-auth-strategy": "static",
                  }
                : undefined,
          },
        ),
      ),
    );

    try {
      const checks = await runDoctor({
        cwd: root,
        functionName: "app-mcp",
        url: "http://127.0.0.1:54321/functions/v1/app-mcp",
        token,
      });
      expect(checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "credential-accepted", ok: false }),
        ]),
      );
      expect(JSON.stringify(checks)).not.toContain(token);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("distinguishes a stopped local stack from a missing local function", async () => {
    const root = await fixture();
    await applyPlan(
      await planInit({
        cwd: root,
        functionName: "mcp",
        serverName: "Fixture",
        auth: "bearer",
        consent: "none",
        patchConfig: true,
      }),
    );
    const url = "http://127.0.0.1:54321/functions/v1/mcp";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("off"))),
    );
    expect(await runDoctor({ cwd: root, functionName: "mcp", url })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "local-stack-running", ok: false }),
      ]),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        if (String(input) === "http://127.0.0.1:54321") {
          return new Response("not found", { status: 404 });
        }
        throw new Error("function unavailable");
      }),
    );
    expect(await runDoctor({ cwd: root, functionName: "mcp", url })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "function-reachable", ok: false }),
      ]),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("worker boot error", { status: 500 })),
    );
    expect(await runDoctor({ cwd: root, functionName: "mcp", url })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "function-reachable",
          ok: false,
          detail: expect.stringContaining("chumbo dev logs"),
        }),
      ]),
    );
    vi.unstubAllGlobals();
  });

  it("returns an actionable check for a malformed endpoint URL", async () => {
    const root = await fixture();
    await applyPlan(
      await planInit({
        cwd: root,
        functionName: "mcp",
        serverName: "Fixture",
        auth: "public",
        consent: "none",
        patchConfig: true,
      }),
    );
    const checks = await runDoctor({
      cwd: root,
      functionName: "mcp",
      url: "not-an-endpoint",
    });
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "endpoint-url", ok: false }),
      ]),
    );
  });

  it("checks public discovery and the generated limiter contract", async () => {
    const root = await fixture();
    await applyPlan(
      await planInit({
        cwd: root,
        functionName: "public-mcp",
        serverName: "Public fixture",
        auth: "public",
        consent: "none",
        patchConfig: true,
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init?: RequestInit) =>
        requestMethod(init) === "initialize"
          ? initialized()
          : Response.json(
              { jsonrpc: "2.0", id: "public", result: { tools: [] } },
              { headers: { "x-ratelimit-limit": "60" } },
            ),
      ),
    );

    try {
      const checks = await runDoctor({
        cwd: root,
        functionName: "public-mcp",
        url: "https://project.supabase.co/functions/v1/public-mcp",
      });
      expect(checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "public-tools-list", ok: true }),
          expect.objectContaining({ name: "public-rate-limit", ok: true }),
        ]),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports the missing public limiter without blocking MCP classification", async () => {
    const root = await fixture();
    await applyPlan(
      await planInit({
        cwd: root,
        functionName: "public-mcp",
        serverName: "Public fixture",
        auth: "public",
        consent: "none",
        patchConfig: true,
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init?: RequestInit) =>
        requestMethod(init) === "initialize"
          ? initialized()
          : Response.json({
              jsonrpc: "2.0",
              id: "public",
              result: { tools: [] },
            }),
      ),
    );

    try {
      const checks = await runDoctor({
        cwd: root,
        functionName: "public-mcp",
        url: "http://127.0.0.1:54321/functions/v1/public-mcp",
      });
      expect(checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "public-rate-limit", ok: false }),
          expect.objectContaining({ name: "mcp-initialize", ok: true }),
          expect.objectContaining({ name: "public-tools-list", ok: true }),
        ]),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("checks an application API-key gate through legacy runtime headers", async () => {
    const root = await fixture();
    await applyPlan(
      await planInit({
        cwd: root,
        functionName: "app-mcp",
        serverName: "Application fixture",
        auth: "api-key",
        consent: "none",
        patchConfig: true,
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        return headers.get("authorization") === "Bearer app-secret"
          ? requestMethod(init) === "initialize"
            ? initialized()
            : Response.json(
                {
                  jsonrpc: "2.0",
                  id: "authenticated",
                  result: { tools: [{ name: "whoami" }] },
                },
                {
                  headers: {
                    "x-supa-mcp-version": PACKAGE_VERSION,
                    "x-supa-mcp-auth-mode": "api-key",
                    "x-supa-mcp-auth-strategy": "static",
                  },
                },
              )
          : Response.json(
              { error: "invalid_token" },
              {
                status: 401,
                headers: {
                  "x-supa-mcp-version": PACKAGE_VERSION,
                  "x-supa-mcp-auth-mode": "api-key",
                  "x-supa-mcp-auth-strategy": "static",
                },
              },
            );
      }),
    );

    try {
      const checks = await runDoctor({
        cwd: root,
        functionName: "app-mcp",
        url: "https://project.supabase.co/functions/v1/app-mcp",
        token: "app-secret",
      });
      expect(checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "api-key-gate", ok: true }),
          expect.objectContaining({ name: "mcp-initialize", ok: true }),
          expect.objectContaining({ name: "runtime-reached", ok: true }),
          expect.objectContaining({
            name: "runtime-auth-strategy",
            ok: true,
            detail: "static",
          }),
          expect.objectContaining({
            name: "authenticated-tools-list",
            ok: true,
          }),
        ]),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("distinguishes a gateway 401 from a response proven to come from Chumbo", async () => {
    const root = await fixture();
    await applyPlan(
      await planInit({
        cwd: root,
        functionName: "app-mcp",
        serverName: "Application fixture",
        auth: "api-key",
        consent: "none",
        patchConfig: true,
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "gateway_rejected" }, { status: 401 }),
      ),
    );

    try {
      const checks = await runDoctor({
        cwd: root,
        functionName: "app-mcp",
        url: "https://project.supabase.co/functions/v1/app-mcp",
      });
      expect(checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "endpoint-reachable", ok: true }),
          expect.objectContaining({
            name: "runtime-reached",
            ok: false,
            blocking: false,
          }),
          expect.objectContaining({ name: "api-key-gate", ok: true }),
        ]),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the runtime fingerprint when auth configuration is imported", async () => {
    const root = await fixture();
    const functionDir = join(root, "supabase", "functions", "composed-mcp");
    await mkdir(functionDir, { recursive: true });
    await writeFile(
      join(root, "supabase", "config.toml"),
      "[functions.composed-mcp]\nverify_jwt = false\n",
    );
    await writeFile(
      join(functionDir, "index.ts"),
      `import { createSupabaseMcp } from "npm:chumbo@${PACKAGE_VERSION}";\nimport { auth } from "./auth.ts";\n`,
    );
    expect(await inspectGeneratedAuth(root, "composed-mcp")).toBeUndefined();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: "invalid_token" },
          {
            status: 401,
            headers: {
              "x-chumbo-version": PACKAGE_VERSION,
              "x-chumbo-auth-mode": "api-key",
              "x-chumbo-auth-strategy": "verifier",
            },
          },
        ),
      ),
    );

    try {
      const checks = await runDoctor({
        cwd: root,
        functionName: "composed-mcp",
        url: "https://example.com/mcp",
      });
      expect(checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "runtime-auth-mode",
            ok: true,
            detail: "api-key",
          }),
          expect.objectContaining({ name: "api-key-gate", ok: true }),
        ]),
      );
      expect(checks.some((check) => check.name === "oauth-challenge")).toBe(
        false,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("diagnoses composed authentication without mistaking a nested strategy for the server mode", async () => {
    const root = await fixture();
    const functionDir = join(root, "supabase", "functions", "composed-mcp");
    await mkdir(functionDir, { recursive: true });
    await writeFile(
      join(root, "supabase", "config.toml"),
      "[functions.composed-mcp]\nverify_jwt = false\n",
    );
    await writeFile(
      join(functionDir, "index.ts"),
      `import { createSupabaseMcp } from "npm:chumbo@${PACKAGE_VERSION}";\n` +
        'createSupabaseMcp({ auth: { mode: "multi", strategies: [{ mode: "oauth" }, { mode: "api-key", tokenPrefix: "app_", verify() {} }] } });\n',
    );
    expect(await inspectGeneratedAuth(root, "composed-mcp")).toBeUndefined();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/.well-known/oauth-protected-resource")) {
          return Response.json({
            resource: "https://example.com/mcp",
            authorization_servers: ["https://example.com/auth/v1"],
          });
        }
        if (new Headers(init?.headers).has("authorization")) {
          return Response.json(
            { jsonrpc: "2.0", id: "authenticated", result: { tools: [] } },
            {
              headers: {
                "x-chumbo-version": PACKAGE_VERSION,
                "x-chumbo-auth-mode": "multi",
                "x-chumbo-auth-strategy": "composed",
              },
            },
          );
        }
        return Response.json(
          { error: "invalid_token" },
          {
            status: 401,
            headers: {
              "www-authenticate":
                'Bearer resource_metadata="https://example.com/mcp/.well-known/oauth-protected-resource"',
              "x-chumbo-version": PACKAGE_VERSION,
              "x-chumbo-auth-mode": "multi",
              "x-chumbo-auth-strategy": "composed",
            },
          },
        );
      }),
    );

    try {
      const checks = await runDoctor({
        cwd: root,
        functionName: "composed-mcp",
        url: "https://example.com/mcp",
        token: "app_owner",
      });
      expect(checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "runtime-auth-mode",
            ok: true,
            detail: "multi",
          }),
          expect.objectContaining({ name: "multi-auth-gate", ok: true }),
          expect.objectContaining({
            name: "authenticated-tools-list",
            ok: true,
          }),
          expect.objectContaining({
            name: "protected-resource-metadata",
            ok: true,
          }),
        ]),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("treats the generated layout as guidance for a valid composed function", async () => {
    const root = await fixture();
    const functionDir = join(root, "supabase", "functions", "composed-mcp");
    await mkdir(functionDir, { recursive: true });
    await writeFile(
      join(root, "supabase", "config.toml"),
      "[functions.composed-mcp]\nverify_jwt = false\n",
    );
    await writeFile(
      join(functionDir, "index.ts"),
      `import { createSupabaseMcp } from "npm:chumbo@${PACKAGE_VERSION}";\n` +
        'createSupabaseMcp({ resourceUrl: "https://example.com/mcp", auth: { mode: "bearer" } });\n',
    );

    const checks = await runDoctor({
      cwd: root,
      functionName: "composed-mcp",
    });
    expect(checks.find((check) => check.name === "dependencies")).toMatchObject(
      { ok: true },
    );
    for (const name of ["capabilities.ts", "deno.json", "index_test.ts"]) {
      expect(
        checks.find((check) => check.name === `file:${name}`),
      ).toMatchObject({ ok: false, blocking: false });
    }
  });
});

describe("guided setup", () => {
  it("normalizes clean public URLs and rejects ambiguous ones", () => {
    expect(normalizePublicUrl("https://directory.example/mcp/")).toBe(
      "https://directory.example/mcp",
    );
    expect(() => normalizePublicUrl("ftp://directory.example/mcp")).toThrow(
      "http or https",
    );
    expect(() =>
      normalizePublicUrl("https://directory.example/mcp?preview=true"),
    ).toThrow("query string");
  });

  it("detects an existing generated auth mode for idempotent resume", async () => {
    const root = await fixture();
    await applyPlan(
      await planInit({
        cwd: root,
        functionName: "mcp",
        serverName: "Fixture",
        auth: "bearer",
        consent: "none",
        patchConfig: true,
      }),
    );
    expect(await detectGeneratedAuth(root, "mcp")).toBe("bearer");
    expect(await detectGeneratedAuth(root, "missing")).toBeUndefined();
  });

  it("keeps local API-key loading separate from hosted secret mutation", () => {
    const report = buildSetupReport({
      command: "setup",
      projectRoot: "/tmp/project",
      functionName: "app-mcp",
      auth: "api-key",
      apiKeyStrategy: "static",
      consent: "none",
      files: [],
      applied: true,
      planned: false,
      localChecks: "complete",
    });
    expect(
      report.steps.find((step) => step.id === "serve_local")?.command,
    ).toBe(
      "npx chumbo dev --function app-mcp --env-file supabase/functions/.env.local",
    );
    expect(
      report.steps.find((step) => step.id === "set_api_key_secret")?.command,
    ).toContain("supabase secrets set");
    expect(
      report.steps.find((step) => step.id === "serve_local")?.command,
    ).not.toContain("supabase secrets set");
  });

  it("recognizes verifier-backed application keys without prescribing a shared secret", async () => {
    const root = await fixture();
    const functionDir = join(root, "supabase", "functions", "app-mcp");
    await mkdir(functionDir, { recursive: true });
    await writeFile(
      join(functionDir, "index.ts"),
      `const auth = { mode: "api-key", async verify({ token }: { token: string }) { return token ? { subject: token } : null; } };\n`,
    );

    expect(await inspectGeneratedAuth(root, "app-mcp")).toEqual({
      mode: "api-key",
      apiKeyStrategy: "verifier",
    });

    const report = buildSetupReport({
      command: "status",
      projectRoot: root,
      functionName: "app-mcp",
      auth: "api-key",
      apiKeyStrategy: "verifier",
      consent: "none",
      files: [],
      applied: true,
      planned: false,
      localChecks: "complete",
      endpoint: "https://example.com/mcp",
    });
    expect(report.authStrategy).toBe("verifier");
    expect(report.steps.some((step) => step.id === "set_api_key_secret")).toBe(
      false,
    );
    expect(
      report.steps.find((step) => step.id === "verify_remote")?.command,
    ).toContain("--token <APPLICATION_API_KEY>");
  });

  it("does not guess the secret name for a custom static application key", async () => {
    const root = await fixture();
    const functionDir = join(root, "supabase", "functions", "app-mcp");
    await mkdir(functionDir, { recursive: true });
    await writeFile(
      join(functionDir, "index.ts"),
      'const customKey = Deno.env.get("FILES_API_KEY");\nconst auth = { mode: "api-key", key: customKey };\n',
    );
    expect(await inspectGeneratedAuth(root, "app-mcp")).toEqual({
      mode: "api-key",
      apiKeyStrategy: "unknown",
    });
    const report = buildSetupReport({
      command: "status",
      projectRoot: root,
      functionName: "app-mcp",
      auth: "api-key",
      apiKeyStrategy: "unknown",
      consent: "none",
      files: [],
      applied: true,
      planned: false,
      localChecks: "complete",
    });
    expect(report.steps.some((step) => step.id === "set_api_key_secret")).toBe(
      false,
    );
  });

  it("keeps an uncredentialed but protected endpoint ready rather than blocked", () => {
    const report = buildSetupReport({
      command: "status",
      projectRoot: "/tmp/project",
      functionName: "mcp",
      auth: "api-key",
      apiKeyStrategy: "verifier",
      consent: "none",
      files: [],
      applied: true,
      planned: false,
      localChecks: "complete",
      remoteAttempted: true,
      remoteReady: true,
      remoteVerified: false,
      endpoint: "https://example.com/mcp",
      verification: {
        attempted: true,
        reachable: true,
        runtimeReached: true,
        authGateObserved: true,
        credentialSupplied: false,
        mcpDiscoveryVerified: false,
      },
    });
    expect(report.steps.find((step) => step.id === "deploy")?.status).toBe(
      "complete",
    );
    expect(
      report.steps.find((step) => step.id === "verify_remote")?.status,
    ).toBe("ready");
    expect(report.status).toBe("ready");
  });

  it("does not send a verified deployed server back through local first-run steps", () => {
    const report = buildSetupReport({
      command: "status",
      projectRoot: "/tmp/project",
      functionName: "mcp",
      auth: "bearer",
      consent: "none",
      files: [],
      applied: true,
      planned: false,
      localChecks: "complete",
      remoteVerified: true,
      endpoint: "https://example.com/mcp",
    });
    expect(report.status).toBe("complete");
    expect(
      report.nextActions.some((step) =>
        ["start_local_supabase", "serve_local", "verify_local"].includes(
          step.id,
        ),
      ),
    ).toBe(false);
  });

  it("hands a discovery-verified OAuth endpoint to the client for sign-in", () => {
    const report = buildSetupReport({
      command: "status",
      projectRoot: "/tmp/project",
      functionName: "mcp",
      auth: "oauth",
      consent: "none",
      files: [],
      applied: true,
      planned: false,
      localChecks: "complete",
      remoteAttempted: true,
      remoteReady: true,
      remoteVerified: false,
      endpoint: "https://example.com/mcp",
      verification: {
        attempted: true,
        reachable: true,
        runtimeReached: true,
        authGateObserved: true,
        credentialSupplied: false,
        mcpDiscoveryVerified: false,
        resourceUrlVerified: true,
      },
    });
    expect(
      report.steps.find((step) => step.id === "verify_remote")?.status,
    ).toBe("complete");
    expect(
      report.steps.find((step) => step.id === "connect_client")?.status,
    ).toBe("ready");
    expect(formatSetupReport(report)).toContain(
      "Your Chumbo is deployed and responding.",
    );
  });

  it("gives public installs an ordered, machine-readable next-action ladder", () => {
    const endpoint = endpointFor("project-ref", "mcp");
    const report = buildSetupReport({
      command: "setup",
      projectRoot: "/tmp/project",
      functionName: "mcp",
      auth: "public",
      consent: "none",
      files: [{ path: "supabase/functions/mcp/index.ts", status: "create" }],
      applied: true,
      planned: false,
      localChecks: "complete",
      migrations: "ready",
      endpoint,
      projectRef: "project-ref",
    });

    expect(report.schemaVersion).toBe(1);
    expect(report.status).toBe("ready");
    expect(report.endpoint).toBe(endpoint);
    expect(report.localEndpoint).toBe(
      "http://127.0.0.1:54321/functions/v1/mcp",
    );
    expect(report.nextActions.map((step) => step.id)).toEqual([
      "start_local_supabase",
      "apply_local_migrations",
      "serve_local",
      "verify_local",
      "apply_rate_limit_migration",
      "deploy",
      "verify_remote",
    ]);
    expect(report.nextActions[0]?.command).toBe("supabase start");
    expect(report.nextActions[1]?.command).toBe(
      "supabase migration up --local",
    );
    expect(report.nextActions[3]?.command).toContain("--call-tool whoami");
    expect(report.nextActions[4]?.command).toBe("supabase db push --yes");
    expect(report.resumeCommand).toContain("--resume");
    expect(report.agentHandoff).toEqual({
      documentationServerUrl: SUPA_MCP_DOCUMENTATION_SERVER_URL,
      prompt:
        "Inspect this project and implement the authenticated-tools pattern.",
      skillInstallCommand: "npx chumbo skill install --yes --json",
    });
    expect(formatSetupReport(report)).toContain(
      `MCP docs: ${SUPA_MCP_DOCUMENTATION_SERVER_URL}`,
    );
    expect(formatSetupReport(report)).toContain(
      "Agent skill (optional): npx chumbo skill install",
    );
  });

  it("marks OAuth dashboard configuration as an explicit user action", () => {
    const report = buildSetupReport({
      command: "setup",
      projectRoot: "/tmp/project",
      functionName: "mcp",
      auth: "oauth",
      consent: "none",
      files: [],
      applied: true,
      planned: false,
      localChecks: "complete",
      projectRef: "project-ref",
    });

    expect(report.status).toBe("needs_user_action");
    expect(report.nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "configure_oauth",
          status: "needs_user_action",
        }),
      ]),
    );
  });

  it("makes a clean public route an explicit, verifiable setup step", () => {
    const report = buildSetupReport({
      command: "setup",
      projectRoot: "/tmp/project",
      functionName: "mcp",
      auth: "oauth",
      consent: "none",
      files: [],
      applied: true,
      planned: false,
      localChecks: "complete",
      projectRef: "project-ref",
      publicUrl: "https://directory.example/mcp/",
    });

    expect(report.endpoint).toBe("https://directory.example/mcp");
    expect(report.upstreamEndpoint).toBe(
      "https://project-ref.supabase.co/functions/v1/mcp",
    );
    expect(report.nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "configure_public_url" }),
        expect.objectContaining({
          id: "publish_public_route",
          status: "needs_user_action",
        }),
      ]),
    );
  });
});
