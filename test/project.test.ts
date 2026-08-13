import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { applyPlan, patchFunctionConfig, planInit } from "../src/project.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "create-supabase-mcp-"));
  await mkdir(join(root, "supabase"), { recursive: true });
  await writeFile(
    join(root, "supabase", "config.toml"),
    'project_id = "fixture"\n\n[api]\nport = 54321\n',
  );
  return root;
}

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
      file.path.endsWith("create_supabase_mcp_rate_limits.sql"),
    );
    expect(migration?.status).toBe("create");
    expect(migration?.content).toContain("security invoker");
    expect(migration?.content).toContain("grant execute");

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
});

describe("doctor", () => {
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
          name: "authenticated-tools-list",
          ok: true,
        }),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
