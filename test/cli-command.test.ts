import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  runCliCommand,
  splitArgsAtDoubleDash,
  type CliCommandIo,
} from "../src/cli-command.js";
import { BRANDED_CLI_MANIFEST_PATH } from "../src/cli-package.js";

function makeIo(tty = false): {
  io: CliCommandIo;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (v) => stdout.push(v),
      stderr: (v) => stderr.push(v),
      isTTY: tty,
      confirm: async () => false,
    },
  };
}

describe("npx chumbo cli subcommands (init, status, render, try)", () => {
  it("splits argv cleanly at -- without intercepting forwarded flags or --help", () => {
    const split = splitArgsAtDoubleDash([
      "try",
      "--bin",
      "acme",
      "--",
      "projects",
      "delete",
      "--project-id",
      "p1",
      "--help",
    ]);
    expect(split.hasDoubleDash).toBe(true);
    expect(split.hostArgs).toEqual(["try", "--bin", "acme"]);
    expect(split.forwardedArgs).toEqual([
      "projects",
      "delete",
      "--project-id",
      "p1",
      "--help",
    ]);
  });

  it("supports init --plan --json, --json needs_confirmation, atomic creation, and Source needs a decision on edited bin/cli.js", async () => {
    const repo = await mkdtemp(join(tmpdir(), "chumbo-cli-cmd-"));
    try {
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({ name: "@acme/web", version: "1.0.0", license: "MIT" }),
      );

      // 1. `--plan --json` previews without writing
      const planHarness = makeIo(false);
      expect(
        await runCliCommand(
          [
            "init",
            "--bin",
            "acme",
            "--url",
            "https://api.acme.example/mcp",
            "--plan",
            "--json",
          ],
          { cwd: repo, io: planHarness.io },
        ),
      ).toBe(0);
      const planned = JSON.parse(planHarness.stdout[0]!);
      expect(planned).toMatchObject({
        schemaVersion: 1,
        command: "cli init",
        status: "planned",
        stateLabel: "Create a project CLI",
        packageDir: "acme-cli",
      });

      // 2. `--json` without `--yes` returns `needs_confirmation` without writing
      const confirmHarness = makeIo(false);
      expect(
        await runCliCommand(
          [
            "init",
            "--bin",
            "acme",
            "--url",
            "https://api.acme.example/mcp",
            "--json",
          ],
          { cwd: repo, io: confirmHarness.io },
        ),
      ).toBe(0);
      expect(JSON.parse(confirmHarness.stdout[0]!).status).toBe(
        "needs_confirmation",
      );

      // 3. Apply with `--yes --json` creates files with executable bit on `bin/cli.js`
      const applyHarness = makeIo(false);
      expect(
        await runCliCommand(
          [
            "init",
            "--bin",
            "acme",
            "--url",
            "https://api.acme.example/mcp",
            "--yes",
            "--json",
          ],
          { cwd: repo, io: applyHarness.io },
        ),
      ).toBe(0);
      expect(JSON.parse(applyHarness.stdout[0]!).status).toBe("complete");

      const binPath = join(repo, "acme-cli", "bin", "cli.js");
      const binStat = await stat(binPath);
      expect(binStat.mode & 0o111).toBeGreaterThan(0);
      const manifestRaw = await readFile(
        join(repo, "acme-cli", ...BRANDED_CLI_MANIFEST_PATH.split("/")),
        "utf8",
      );
      expect(JSON.parse(manifestRaw).schemaVersion).toBe(
        "chumbo-cli-manifest@1",
      );

      // 4. Editing `README.md` is preserved while updating version succeeds cleanly
      const readmePath = join(repo, "acme-cli", "README.md");
      await writeFile(readmePath, "# Custom Docs\n", "utf8");
      const updateHarness = makeIo(false);
      expect(
        await runCliCommand(
          [
            "init",
            "--bin",
            "acme",
            "--cli-version",
            "0.2.0",
            "--yes",
            "--json",
          ],
          { cwd: repo, io: updateHarness.io },
        ),
      ).toBe(0);
      expect(await readFile(readmePath, "utf8")).toBe("# Custom Docs\n");

      // 5. Editing `bin/cli.js` halts with `Source needs a decision` (exit 1) and preserves edit
      const editedBin = `${await readFile(binPath, "utf8")}// hand edit\n`;
      await writeFile(binPath, editedBin, "utf8");
      const conflictHarness = makeIo(false);
      expect(
        await runCliCommand(
          [
            "init",
            "--bin",
            "acme",
            "--cli-version",
            "0.3.0",
            "--yes",
            "--json",
          ],
          { cwd: repo, io: conflictHarness.io },
        ),
      ).toBe(1);
      const conflictReport = JSON.parse(conflictHarness.stdout[0]!);
      expect(conflictReport).toMatchObject({
        status: "needs_decision",
        stateLabel: "Source needs a decision",
      });
      expect(await readFile(binPath, "utf8")).toBe(editedBin);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("enforces needs_confirmation and overwrite guard on render --out-tgz", async () => {
    const repo = await mkdtemp(join(tmpdir(), "chumbo-cli-render-"));
    try {
      const archivePath = join(repo, "acme-cli.tgz");

      // `--json` without `--yes` returns `needs_confirmation`
      const confirmHarness = makeIo(false);
      expect(
        await runCliCommand(
          [
            "render",
            "--bin",
            "acme",
            "--package",
            "@acme/cli",
            "--url",
            "https://api.acme.example/mcp",
            "--out-tgz",
            archivePath,
            "--json",
          ],
          { cwd: repo, io: confirmHarness.io },
        ),
      ).toBe(0);
      expect(JSON.parse(confirmHarness.stdout[0]!).status).toBe(
        "needs_confirmation",
      );

      // `--yes --json` writes valid tarball
      const writeHarness = makeIo(false);
      expect(
        await runCliCommand(
          [
            "render",
            "--bin",
            "acme",
            "--package",
            "@acme/cli",
            "--url",
            "https://api.acme.example/mcp",
            "--out-tgz",
            archivePath,
            "--yes",
            "--json",
          ],
          { cwd: repo, io: writeHarness.io },
        ),
      ).toBe(0);
      expect(JSON.parse(writeHarness.stdout[0]!).status).toBe("complete");

      // Non-TTY overwrite without `--yes` fails closed (exit 1)
      const overwriteHarness = makeIo(false);
      expect(
        await runCliCommand(
          [
            "render",
            "--bin",
            "acme",
            "--package",
            "@acme/cli",
            "--url",
            "https://api.acme.example/mcp",
            "--out-tgz",
            archivePath,
          ],
          { cwd: repo, io: overwriteHarness.io },
        ),
      ).toBe(1);
      expect(overwriteHarness.stderr[0]).toContain("Refusing to overwrite");

      // Tarball extracts cleanly
      const list = execFileSync("tar", ["-tzf", archivePath], {
        encoding: "utf8",
      });
      expect(list).toContain("package/bin/cli.js");
      expect(list).toContain("package/package.json");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("runs `cli try --plan --json` offline and forwards `-- projects delete --project-id p1 --help` cleanly", async () => {
    const repo = await mkdtemp(join(tmpdir(), "chumbo-cli-try-"));
    try {
      // 1. `--plan --json` makes zero network calls
      const planHarness = makeIo(false);
      expect(
        await runCliCommand(
          [
            "try",
            "--bin",
            "acme",
            "--url",
            "https://api.acme.example/mcp",
            "--plan",
            "--json",
            "--",
            "projects",
            "delete",
            "--project-id",
            "p1",
            "--help",
          ],
          { cwd: repo, io: planHarness.io },
        ),
      ).toBe(0);
      const planReport = JSON.parse(planHarness.stdout[0]!);
      expect(planReport).toMatchObject({
        command: "cli try",
        status: "planned",
        tokenEnvVar: "ACME_TOKEN",
        forwardedArgv: ["projects", "delete", "--project-id", "p1", "--help"],
      });

      // 2. Live in-process execution forwards `--project-id` and `--help` to `createBrandedCli`
      const tryHarness = makeIo(false);
      const listTools = vi.fn(async () => ({
        tools: [
          {
            name: "delete_project",
            title: "Delete project",
            description: "Delete a project.",
            inputSchema: {
              type: "object",
              properties: { project_id: { type: "string" } },
              required: ["project_id"],
            },
            annotations: { destructiveHint: true },
            _meta: {
              "dev.chumbo/capability": {
                schemaVersion: 1,
                id: "projects.delete",
                mcpName: "delete_project",
                risk: "destructive",
                idempotent: true,
                scopes: [],
                cli: { command: ["projects", "delete"] },
              },
            },
          },
        ],
      }));
      expect(
        await runCliCommand(
          [
            "try",
            "--bin",
            "acme",
            "--url",
            "https://api.acme.example/mcp",
            "--",
            "projects",
            "delete",
            "--help",
          ],
          {
            cwd: repo,
            io: tryHarness.io,
            brandedCliDependencies: {
              connector: {
                connect: async () => ({
                  listTools,
                  callTool: async () => ({ content: [] }),
                  close: async () => {},
                }),
                loggedInIssuer: async () => "https://auth.acme.example",
                logout: async () => {},
              },
            },
          },
        ),
      ).toBe(0);
      expect(tryHarness.stdout[0]).toContain("Usage:\n  acme projects delete");
      expect(tryHarness.stdout[0]).toContain("--project-id <value>  required");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
