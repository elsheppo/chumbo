import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

async function runCliInDir(
  cwd: string,
  args: string[],
): Promise<{
  stdout: string;
  exitCode: number;
  error?: Error;
}> {
  const previousCwd = process.cwd();
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  let stdout = "";
  const logSpy = vi.spyOn(console, "log").mockImplementation((...parts) => {
    stdout += `${parts.map(String).join(" ")}\n`;
  });
  const writeSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
  let caught: Error | undefined;
  try {
    process.chdir(cwd);
    await main(args);
  } catch (error) {
    caught = error instanceof Error ? error : new Error(String(error));
  } finally {
    const exitCode = Number(process.exitCode ?? 0);
    process.chdir(previousCwd);
    process.exitCode = previousExitCode;
    logSpy.mockRestore();
    writeSpy.mockRestore();
    if (caught) {
      return { stdout, exitCode: exitCode || 1, error: caught };
    }
    return { stdout, exitCode };
  }
}

describe("unified CLI routing", () => {
  it("lists all unified commands and key flags in --help", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chumbo-cli-help-"));
    try {
      const result = await runCliInDir(dir, ["--help"]);
      expect(result.error).toBeUndefined();
      expect(result.exitCode).toBe(0);
      for (const command of [
        "chumbo setup",
        "chumbo init",
        "chumbo dev",
        "chumbo try",
        "chumbo surface <snapshot|diff>",
        "chumbo test scaffold",
        "chumbo app <add|build|list>",
        "chumbo cli <init|status|render|try>",
        "chumbo doctor",
        "chumbo skill",
        "chumbo cloud setup",
      ]) {
        expect(result.stdout).toContain(command);
      }
      for (const flag of [
        "--workbench",
        "--app <name>",
        "--max-catalog-tokens",
      ]) {
        expect(result.stdout).toContain(flag);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not hijack --help after -- when routing to chumbo cli", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chumbo-cli-doubledash-"));
    try {
      const result = await runCliInDir(dir, ["cli", "try", "--", "--help"]);
      // Routed to cliCommand (which rejects missing manifest/endpoint), NOT top-level HELP
      expect(result.stdout).not.toContain("chumbo surface snapshot");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("routes chumbo app list --json and chumbo test scaffold --plan --json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chumbo-cli-subcommands-"));
    try {
      await mkdir(join(dir, "supabase"), { recursive: true });
      await writeFile(
        join(dir, "supabase", "config.toml"),
        'project_id = "routing-test"\n',
      );

      const appResult = await runCliInDir(dir, ["app", "list", "--json"]);
      expect(appResult.error).toBeUndefined();
      expect(appResult.exitCode).toBe(0);
      const appReport = JSON.parse(appResult.stdout) as { apps: unknown[] };
      expect(Array.isArray(appReport.apps)).toBe(true);

      const scaffoldResult = await runCliInDir(dir, [
        "test",
        "scaffold",
        "--steps",
        "whoami",
        "--runner",
        "deno",
        "--plan",
        "--json",
      ]);
      expect(scaffoldResult.error).toBeUndefined();
      expect(scaffoldResult.exitCode).toBe(0);
      const scaffoldReport = JSON.parse(scaffoldResult.stdout) as {
        status: string;
        runner: string;
      };
      expect(scaffoldReport.status).toBe("planned");
      expect(scaffoldReport.runner).toBe("deno");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects chumbo try --args without a tool name and never echoes raw payloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chumbo-cli-try-"));
    try {
      const secret = "super-secret-payload-value";
      const result = await runCliInDir(dir, [
        "try",
        "--json",
        "--args",
        JSON.stringify({ secret }),
      ]);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain("--args requires a <tool> name");
      expect(result.error?.message).not.toContain(secret);
      expect(result.stdout).not.toContain(secret);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("plans official @supabase/server adoption via chumbo setup --plan --json without mutating disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chumbo-cli-official-"));
    try {
      await mkdir(join(dir, "supabase", "functions", "official-mcp"), {
        recursive: true,
      });
      await writeFile(
        join(dir, "supabase", "config.toml"),
        'project_id = "official-adopt"\n',
      );
      const entryPath = join(
        dir,
        "supabase",
        "functions",
        "official-mcp",
        "index.ts",
      );
      const originalSource = [
        'import { McpServer } from "@modelcontextprotocol/server";',
        'import { pipeline, withOAuthProtectedResource, withSupabase } from "@supabase/middleware";',
        'import { serveMcp } from "@supabase/server";',
        "",
        'const server = new McpServer({ name: "official-mcp", version: "1.0.0" });',
        "export const handler = pipeline(",
        '  [withOAuthProtectedResource(), withSupabase({ auth: "user" })],',
        "  serveMcp(server),",
        ");",
        "Deno.serve(handler);",
        "",
      ].join("\n");
      await writeFile(entryPath, originalSource);

      const planResult = await runCliInDir(dir, [
        "setup",
        "--function",
        "official-mcp",
        "--plan",
        "--json",
      ]);
      expect(planResult.error).toBeUndefined();
      expect(planResult.exitCode).toBe(0);
      const report = JSON.parse(planResult.stdout) as {
        status: string;
        files: Array<{ path: string; status: string }>;
      };
      expect(report.status).toBe("planned");
      expect(report.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "supabase/functions/official-mcp/index.ts",
            status: "update",
          }),
        ]),
      );
      expect(await readFile(entryPath, "utf8")).toBe(originalSource);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
