import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRANDED_CLI_MANIFEST_PATH,
  BRANDED_CLI_MANIFEST_SCHEMA,
  packBrandedCliSourceTarball,
  planBrandedCliPackage,
  renderBrandedCliPackage,
  sourceDigest,
} from "../src/cli-package.js";

const baseConfig = {
  packageName: "@acme/ops-cli",
  binaryName: "acme",
  displayName: "Acme Ops",
  version: "0.1.0",
  endpoint: "https://api.acme.example/mcp",
  supportUrl: "https://acme.example/support",
} as const;

describe("project-branded CLI package safe-update planning", () => {
  it("plans initial creation with chumbo-cli-manifest@1 and executable entrypoint", () => {
    const plan = planBrandedCliPackage(
      baseConfig,
      { chumboVersion: "^0.15.0", license: "MIT" },
      { files: {} },
    );

    expect(plan.state).toBe("create");
    expect(plan.stateLabel).toBe("Create a project CLI");
    expect(plan.manifest.schemaVersion).toBe(BRANDED_CLI_MANIFEST_SCHEMA);
    expect(plan.manifest.generatorVersion).toBe("0.15.0");
    expect(plan.manifest.managedFiles["bin/cli.js"]).toMatch(
      /^sha256:[0-9a-f]{64}$/u,
    );

    const byPath = new Map(plan.files.map((f) => [f.relativePath, f]));
    expect(byPath.get("package.json")?.status).toBe("create");
    expect(byPath.get("bin/cli.js")?.status).toBe("create");
    expect(byPath.get("bin/cli.js")?.executable).toBe(true);
    expect(byPath.get("README.md")?.status).toBe("create");
    expect(byPath.get(BRANDED_CLI_MANIFEST_PATH)?.status).toBe("create");
  });

  it("preserves user-edited README.md and extra package.json fields during a safe generated update", () => {
    const initial = planBrandedCliPackage(
      baseConfig,
      { chumboVersion: "^0.14.0", license: "MIT" },
      { files: {} },
    );
    const snapshotFiles: Record<string, string> = {};
    for (const file of initial.files) {
      if (file.content) snapshotFiles[file.relativePath] = file.content;
    }

    // User customizes README.md and adds scripts/devDependencies in package.json
    snapshotFiles["README.md"] =
      "# Custom Acme CLI Docs\n\nHand-written guide.\n";
    const pkg = JSON.parse(snapshotFiles["package.json"]!) as Record<
      string,
      unknown
    >;
    pkg.scripts = { lint: "eslint ." };
    pkg.devDependencies = { eslint: "^9.0.0" };
    snapshotFiles["package.json"] = `${JSON.stringify(pkg, null, 2)}\n`;

    const updated = planBrandedCliPackage(
      {
        ...baseConfig,
        version: "0.2.0",
        endpoint: "https://mcp.acme.example/v2",
      },
      { chumboVersion: "^0.15.0", license: "MIT" },
      { files: snapshotFiles },
    );

    expect(updated.state).toBe("safe_update");
    expect(updated.stateLabel).toBe("Safe generated update");

    const byPath = new Map(updated.files.map((f) => [f.relativePath, f]));
    expect(byPath.get("README.md")?.status).toBe("unchanged");
    expect(byPath.get("README.md")?.content).toBeUndefined();
    expect(byPath.get("bin/cli.js")?.status).toBe("update");
    expect(byPath.get("bin/cli.js")?.content).toContain(
      "https://mcp.acme.example/v2",
    );

    const mergedPkg = JSON.parse(
      byPath.get("package.json")!.content!,
    ) as Record<string, unknown>;
    expect(mergedPkg.version).toBe("0.2.0");
    expect(mergedPkg.scripts).toEqual({ lint: "eslint ." });
    expect(mergedPkg.devDependencies).toEqual({ eslint: "^9.0.0" });
    expect(mergedPkg.dependencies).toEqual({ chumbo: "^0.15.0" });
  });

  it("stops with Source needs a decision when bin/cli.js was edited after generation", () => {
    const initial = planBrandedCliPackage(
      baseConfig,
      { chumboVersion: "^0.15.0" },
      { files: {} },
    );
    const snapshotFiles: Record<string, string> = {};
    for (const file of initial.files) {
      if (file.content) snapshotFiles[file.relativePath] = file.content;
    }

    // Flip 1 character / add custom line to managed bin/cli.js
    snapshotFiles["bin/cli.js"] =
      `${snapshotFiles["bin/cli.js"]}// custom edit\n`;

    const conflictPlan = planBrandedCliPackage(
      { ...baseConfig, version: "0.2.0" },
      { chumboVersion: "^0.15.0" },
      { files: snapshotFiles },
    );

    expect(conflictPlan.state).toBe("needs_decision");
    expect(conflictPlan.stateLabel).toBe("Source needs a decision");
    expect(conflictPlan.message).toContain(
      "stopped before proposing a replacement",
    );
    expect(
      conflictPlan.files.some(
        (f) => f.relativePath === "bin/cli.js" && f.status === "conflict",
      ),
    ).toBe(true);
    expect(
      conflictPlan.files.some((f) =>
        ["create", "update", "delete"].includes(f.status),
      ),
    ).toBe(false);
  });

  it("verifies and preserves release workflow entries recorded in .chumbo/cli-manifest.json", () => {
    const rendered = renderBrandedCliPackage(baseConfig, {
      chumboVersion: "^0.14.0",
    });
    const workflowPath = "chumbo-release/publish-acme.yml";
    const workflowContent = "name: Publish Acme Ops CLI\n";
    const existingManifest = {
      schemaVersion: BRANDED_CLI_MANIFEST_SCHEMA,
      generatorVersion: "0.14.0",
      packageName: baseConfig.packageName,
      binaryName: baseConfig.binaryName,
      managedFiles: {
        "bin/cli.js": sourceDigest(rendered["bin/cli.js"]),
        [workflowPath]: sourceDigest(workflowContent),
      },
    };

    const plan = planBrandedCliPackage(
      { ...baseConfig, version: "0.2.0" },
      { chumboVersion: "^0.15.0" },
      {
        files: {
          "package.json": rendered["package.json"],
          "bin/cli.js": rendered["bin/cli.js"],
          "README.md": rendered["README.md"],
          [workflowPath]: workflowContent,
          [BRANDED_CLI_MANIFEST_PATH]: `${JSON.stringify(existingManifest, null, 2)}\n`,
        },
      },
    );

    expect(plan.state).toBe("safe_update");
    expect(plan.manifest.managedFiles[workflowPath]).toBe(
      sourceDigest(workflowContent),
    );
  });

  it("blocks accidental --dir . execution against an application root package.json", () => {
    const appPkg = JSON.stringify({
      name: "acme-web-app",
      version: "1.0.0",
      dependencies: { next: "15.0.0", react: "19.0.0" },
    });

    const plan = planBrandedCliPackage(
      baseConfig,
      { chumboVersion: "^0.15.0" },
      {
        isApplicationRoot: true,
        files: { "package.json": appPkg },
      },
    );

    expect(plan.state).toBe("blocked");
    expect(plan.stateLabel).toBe("Blocked");
    expect(plan.files[0]).toMatchObject({
      relativePath: "package.json",
      status: "conflict",
    });
  });

  it("packs a deterministic POSIX ustar .tgz source bundle extractable by tar", async () => {
    const rendered = renderBrandedCliPackage(
      {
        ...baseConfig,
        auth: { mode: "token", tokenEnvVar: "ACME_OPS_TOKEN" },
      },
      { chumboVersion: "^0.15.0", license: "MIT" },
    );
    const bytes = packBrandedCliSourceTarball(rendered);
    expect(bytes.byteLength).toBeGreaterThan(100);

    const fixture = await mkdtemp(join(tmpdir(), "chumbo-cli-tgz-"));
    try {
      const archivePath = join(fixture, "acme-cli-source.tgz");
      await writeFile(archivePath, bytes);
      execFileSync("tar", ["-xzf", archivePath, "-C", fixture]);

      const extractedBin = await readFile(
        join(fixture, "package", "bin", "cli.js"),
        "utf8",
      );
      const extractedReadme = await readFile(
        join(fixture, "package", "README.md"),
        "utf8",
      );
      expect(extractedBin).toBe(rendered["bin/cli.js"]);
      expect(extractedReadme).toContain("export ACME_OPS_TOKEN=");
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
