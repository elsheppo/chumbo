import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { buildHostTargetReport } from "../src/host-target.js";
import { applyPlan, PACKAGE_VERSION, planInit } from "../src/project.js";
import {
  detectGeneratedScaffold,
  inspectGeneratedAuthAt,
} from "../src/setup.js";

async function packageFixture(
  manifest: Record<string, unknown> = {
    name: "app",
    type: "module",
    dependencies: { next: "15.5.0" },
  },
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chumbo-host-"));
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return root;
}

describe("next target planning", () => {
  it("generates a colocated App Router scaffold under src/app when present", async () => {
    const root = await packageFixture();
    await mkdir(join(root, "src", "app"), { recursive: true });
    const files = await planInit({
      cwd: root,
      functionName: "mcp",
      serverName: "Fixture",
      auth: "oauth",
      consent: "none",
      patchConfig: true,
      target: "next",
    });
    expect(files.map((file) => file.path)).toEqual([
      join(root, "src", "app", "mcp", "[[...path]]", "route.ts"),
      join(root, "src", "app", "mcp", "capabilities.ts"),
      join(root, "src", "app", "mcp", "README.md"),
    ]);
    const route = files[0]!.content;
    expect(route).toContain(
      'import { registerCapabilities } from "../capabilities"',
    );
    expect(route).toContain("process.env.SUPABASE_URL");
    expect(route).toContain("process.env.NEXT_PUBLIC_SUPABASE_URL");
    expect(route).toContain('export const dynamic = "force-dynamic"');
    expect(route).toContain(
      "export { handle as GET, handle as POST, handle as DELETE, handle as OPTIONS }",
    );
    expect(route).toContain(
      '{ mode: "oauth", issuer: new URL(`${projectUrl}/auth/v1`) }',
    );
    expect(route).not.toContain("Deno.");
  });

  it("falls back to a root app directory and threads the api key from process.env", async () => {
    const root = await packageFixture();
    await mkdir(join(root, "app"), { recursive: true });
    const files = await planInit({
      cwd: root,
      functionName: "assistant",
      serverName: "Fixture",
      auth: "api-key",
      consent: "none",
      patchConfig: false,
      target: "next",
    });
    expect(files[0]!.path).toBe(
      join(root, "app", "assistant", "[[...path]]", "route.ts"),
    );
    expect(files[0]!.content).toContain(
      "const mcpApiKey = process.env.MCP_API_KEY;",
    );
    expect(files[0]!.content).toContain('{ mode: "api-key", key: mcpApiKey }');
    const readme = files.find((file) => file.path.endsWith("README.md"))!;
    expect(readme.content).toContain(
      "MCP_API_KEY=replace-with-a-long-random-key",
    );
    expect(readme.content).toContain(`chumbo@${PACKAGE_VERSION}`);
    expect(readme.content).toContain("/assistant");
  });

  it("requires a Next.js dependency and an App Router directory", async () => {
    const plain = await packageFixture({ name: "app", dependencies: {} });
    await mkdir(join(plain, "app"), { recursive: true });
    await expect(
      planInit({
        cwd: plain,
        functionName: "mcp",
        serverName: "Fixture",
        auth: "oauth",
        consent: "none",
        patchConfig: false,
        target: "next",
      }),
    ).rejects.toThrow("does not list a 'next' dependency");

    const missingAppDir = await packageFixture();
    await expect(
      planInit({
        cwd: missingAppDir,
        functionName: "mcp",
        serverName: "Fixture",
        auth: "oauth",
        consent: "none",
        patchConfig: false,
        target: "next",
      }),
    ).rejects.toThrow("No App Router directory");
  });

  it("keeps the generated consent function an Edge-only concern", async () => {
    const root = await packageFixture();
    await mkdir(join(root, "app"), { recursive: true });
    await expect(
      planInit({
        cwd: root,
        functionName: "mcp",
        serverName: "Fixture",
        auth: "oauth",
        consent: "minimal",
        patchConfig: false,
        target: "next",
      }),
    ).rejects.toThrow("signed-in UI owns consent");
  });
});

describe("node target planning", () => {
  it("generates a standalone server served through chumbo/node", async () => {
    const root = await packageFixture({ name: "svc", type: "module" });
    const files = await planInit({
      cwd: root,
      functionName: "mcp",
      serverName: "Fixture",
      auth: "api-key",
      consent: "none",
      patchConfig: false,
      target: "node",
    });
    expect(files.map((file) => file.path)).toEqual([
      join(root, "mcp", "index.ts"),
      join(root, "mcp", "capabilities.ts"),
      join(root, "mcp", "README.md"),
    ]);
    const entry = files[0]!.content;
    expect(entry).toContain('import { serve } from "chumbo/node"');
    expect(entry).toContain(
      'import { registerCapabilities } from "./capabilities.ts"',
    );
    expect(entry).toContain("Number(process.env.PORT ?? 8080)");
    expect(entry).not.toContain("Deno.");
  });

  it("places database support beside the scaffold when no Supabase directory exists", async () => {
    const root = await packageFixture({ name: "svc", type: "module" });
    const files = await planInit({
      cwd: root,
      functionName: "mcp",
      serverName: "Fixture",
      auth: "public",
      consent: "none",
      patchConfig: false,
      target: "node",
    });
    const migration = files.find((file) => file.path.endsWith(".sql"))!;
    expect(migration.path).toContain(join("mcp", "migrations"));
    const readme = files.find((file) => file.path.endsWith("README.md"))!;
    expect(readme.content).toContain("SQL editor or `psql`");
    expect(readme.content).toContain(
      "SUPABASE_SECRET_KEY=your-secret-or-service-role-key",
    );
  });

  it("routes database support into supabase/migrations when the project has one", async () => {
    const root = await packageFixture({ name: "svc", type: "module" });
    await mkdir(join(root, "supabase"), { recursive: true });
    await writeFile(
      join(root, "supabase", "config.toml"),
      'project_id = "x"\n',
    );
    const files = await planInit({
      cwd: root,
      functionName: "mcp",
      serverName: "Fixture",
      auth: "api-key",
      consent: "none",
      patchConfig: false,
      stateNamespace: "observations",
      target: "node",
    });
    const migration = files.find((file) => file.path.endsWith(".sql"))!;
    expect(migration.path).toContain(join("supabase", "migrations"));
    const entry = files[0]!.content;
    expect(entry).toContain(
      "const stateHmacKey = process.env.CHUMBO_STATE_HMAC_KEY;",
    );
    const readme = files.find((file) => file.path.endsWith("README.md"))!;
    expect(readme.content).toContain("supabase db push");
    expect(readme.content).toContain("CHUMBO_STATE_HMAC_KEY");
  });
});

describe("host scaffold detection", () => {
  it("detects applied scaffolds and re-reads their auth for resume", async () => {
    const root = await packageFixture();
    await mkdir(join(root, "src", "app"), { recursive: true });
    await applyPlan(
      await planInit({
        cwd: root,
        functionName: "mcp",
        serverName: "Fixture",
        auth: "bearer",
        consent: "none",
        patchConfig: false,
        target: "next",
      }),
    );
    const scaffold = await detectGeneratedScaffold(root, "mcp");
    expect(scaffold?.target).toBe("next");
    const inspection = await inspectGeneratedAuthAt(scaffold!.entryPath);
    expect(inspection?.mode).toBe("bearer");
  });

  it("does not claim an arbitrary application directory as a node scaffold", async () => {
    const root = await packageFixture({ name: "svc", type: "module" });
    await mkdir(join(root, "mcp"), { recursive: true });
    await writeFile(join(root, "mcp", "index.ts"), "export const other = 1;\n");
    expect(await detectGeneratedScaffold(root, "mcp")).toBeUndefined();
  });
});

describe("doctor outside a Supabase project", () => {
  it("asks for --url instead of demanding supabase/config.toml", async () => {
    const root = await mkdtemp(join(tmpdir(), "chumbo-plain-"));
    await expect(runDoctor({ cwd: root, functionName: "mcp" })).rejects.toThrow(
      "pass --url to probe a deployed endpoint",
    );
  });

  it("checks host scaffold files and the pinned runtime dependency", async () => {
    const root = await packageFixture({
      name: "svc",
      type: "module",
      dependencies: { chumbo: PACKAGE_VERSION },
    });
    await applyPlan(
      await planInit({
        cwd: root,
        functionName: "mcp",
        serverName: "Fixture",
        auth: "api-key",
        consent: "none",
        patchConfig: false,
        target: "node",
      }),
    );
    const checks = await runDoctor({ cwd: root, functionName: "mcp" });
    expect(checks).toEqual([
      { name: "file:index.ts", ok: true, detail: "present" },
      {
        name: "file:capabilities.ts",
        ok: true,
        detail: "present",
        blocking: false,
      },
      {
        name: "dependencies",
        ok: true,
        detail: "runtime dependency is pinned",
      },
    ]);
  });
});

describe("host target report", () => {
  const base = {
    command: "setup" as const,
    projectRoot: "/repo",
    functionName: "mcp",
    target: "next" as const,
    auth: "oauth" as const,
    localEndpoint: "http://localhost:3000/mcp",
    files: [],
    applied: true,
    planned: false,
    installCommand: "pnpm add",
  };

  it("walks a fresh setup through environment, deploy, and verification", () => {
    const report = buildHostTargetReport(base);
    expect(report.status).toBe("needs_user_action");
    expect(report.target).toBe("next");
    expect(report.steps.map((step) => step.id)).toEqual([
      "scaffold",
      "install_runtime",
      "configure_env",
      "serve_local",
      "verify_local",
      "deploy",
      "configure_oauth",
      "verify_remote",
    ]);
    expect(report.resumeCommand).toContain("--target next");
    const install = report.steps.find((step) => step.id === "install_runtime");
    expect(install?.command).toBe(`pnpm add chumbo@${PACKAGE_VERSION}`);
    const serve = report.steps.find((step) => step.id === "serve_local");
    expect(serve?.command).toBe("pnpm dev");
  });

  it("marks the manual steps complete once the deployed endpoint verifies", () => {
    const report = buildHostTargetReport({
      ...base,
      target: "node",
      auth: "api-key",
      runtimeInstalled: true,
      publicUrl: "https://mcp.example.com/mcp",
      remoteVerified: true,
      remoteAttempted: true,
      remoteReady: true,
      verification: {
        attempted: true,
        reachable: true,
        runtimeReached: true,
        authGateObserved: true,
        credentialSupplied: true,
        credentialAccepted: true,
        mcpDiscoveryVerified: true,
      },
    });
    expect(report.status).toBe("complete");
    const byId = new Map(report.steps.map((step) => [step.id, step.status]));
    expect(byId.get("configure_env")).toBe("complete");
    expect(byId.get("deploy")).toBe("complete");
    expect(byId.get("verify_remote")).toBe("complete");
    expect(byId.get("connect_client")).toBe("ready");
    expect(report.steps.map((step) => step.id)).not.toContain("serve_local");
  });

  it("reports a failing remote probe as blocked", () => {
    const report = buildHostTargetReport({
      ...base,
      endpoint: "https://mcp.example.com/mcp",
      remoteAttempted: true,
      remoteReady: false,
      verifyDetail: "endpoint-reachable: HTTP 404",
    });
    expect(report.status).toBe("blocked");
    const verify = report.steps.find((step) => step.id === "verify_remote");
    expect(verify?.status).toBe("blocked");
    expect(verify?.detail).toBe("endpoint-reachable: HTTP 404");
  });
});
