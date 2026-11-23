import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appCommand,
  auditCompiledAppHtml,
  chumboZodEnglishLocalePlugin,
  ensurePresentationPlaceholder,
  GENERATED_HTML_MARKER,
  GENERATED_TS_MARKER,
  type ViteBundlerDeps,
} from "../src/app-bundler.js";
import { MCP_APP_PRESENTATION_PLACEHOLDER } from "../src/mcp-apps.js";

const tempDirs: string[] = [];

async function createSupabaseFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "chumbo-app-bundler-"));
  tempDirs.push(dir);
  await mkdir(join(dir, "supabase", "functions", "mcp"), { recursive: true });
  await writeFile(
    join(dir, "supabase", "config.toml"),
    "[api]\nport = 54321\n",
    "utf8",
  );
  await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  return dir;
}

function mockViteDeps(htmlSource: string): ViteBundlerDeps {
  return {
    viteSingleFile: () => ({ name: "mock-singlefile" }),
    async build() {
      return {
        output: [
          {
            type: "asset",
            fileName: "index.html",
            source: htmlSource,
          },
        ],
      };
    },
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("chumbo app bundler & CLI", () => {
  it("supports --plan, --json needs_confirmation, non-TTY fail-closed, and conflict preservation on app add", async () => {
    const cwd = await createSupabaseFixture();
    const out: string[] = [];
    const err: string[] = [];

    // 1. --plan --json writes zero files:
    const planCode = await appCommand(
      ["add", "review-queue", "--plan", "--json"],
      {
        cwd,
        isTTY: false,
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      },
    );
    expect(planCode).toBe(0);
    const planJson = JSON.parse(out.join("\n"));
    expect(planJson).toMatchObject({
      schemaVersion: 1,
      command: "app",
      action: "add",
      status: "planned",
      appName: "review-queue",
      uri: "ui://mcp/review-queue.html",
      target: "edge-function",
      nextCommand: "npx chumbo app add review-queue --yes --json",
    });
    expect(planJson.files).toHaveLength(5);

    // 2. --json without --yes returns needs_confirmation without prompting:
    out.length = 0;
    const confirmCode = await appCommand(["add", "review-queue", "--json"], {
      cwd,
      isTTY: false,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    });
    expect(confirmCode).toBe(0);
    expect(JSON.parse(out.join("\n")).status).toBe("needs_confirmation");

    // 3. Non-TTY human invocation without --yes fails closed:
    err.length = 0;
    const nonTtyCode = await appCommand(["add", "review-queue"], {
      cwd,
      isTTY: false,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    });
    expect(nonTtyCode).toBe(1);
    expect(err.join("\n")).toContain("Re-run with --yes");

    // 4. --yes --json scaffolds all 5 files:
    out.length = 0;
    const applyCode = await appCommand(
      ["add", "review-queue", "--yes", "--json"],
      {
        cwd,
        isTTY: false,
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      },
    );
    expect(applyCode).toBe(0);
    expect(JSON.parse(out.join("\n")).status).toBe("complete");

    const mainPath = join(
      cwd,
      "supabase",
      "functions",
      "mcp",
      "apps",
      "review-queue",
      "main.ts",
    );
    const originalMain = await readFile(mainPath, "utf8");
    expect(originalMain).toContain("createAppWorkspace");

    // 5. Hand-editing main.ts causes conflict refusal without overwriting:
    await writeFile(mainPath, `${originalMain}\n// custom edit\n`, "utf8");
    out.length = 0;
    const conflictCode = await appCommand(
      ["add", "review-queue", "--yes", "--json"],
      {
        cwd,
        isTTY: false,
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      },
    );
    expect(conflictCode).toBe(1);
    expect(JSON.parse(out.join("\n")).status).toBe("conflict");
    expect(await readFile(mainPath, "utf8")).toContain("// custom edit");
  });

  it("plans, builds, checks drift, enforces generated-marker overwrite guard, and reports missing optional vite cleanly", async () => {
    const cwd = await createSupabaseFixture();
    await appCommand(["add", "review-queue", "--yes", "--json"], {
      cwd,
      isTTY: false,
      stdout: () => {},
      stderr: () => {},
    });

    // 1. `app build --plan --json` does not invoke Vite or write files:
    let viteInvoked = false;
    const out: string[] = [];
    const planCode = await appCommand(["build", "--plan", "--json"], {
      cwd,
      stdout: (line) => out.push(line),
      resolveVite: async () => {
        viteInvoked = true;
        return null;
      },
    });
    expect(planCode).toBe(0);
    expect(viteInvoked).toBe(false);
    const buildPlan = JSON.parse(out.join("\n"));
    expect(buildPlan.status).toBe("planned");
    expect(buildPlan.apps[0].outputs).toEqual([
      {
        path: "supabase/functions/mcp/generated/apps/review-queue.html.ts",
        status: "create",
      },
      {
        path: "supabase/functions/mcp/dist/apps/review-queue.html",
        status: "create",
      },
    ]);

    // 2. Missing optional vite returns blocked + pnpm install command:
    out.length = 0;
    const blockedCode = await appCommand(["build", "--json"], {
      cwd,
      stdout: (line) => out.push(line),
      resolveVite: async () => null,
    });
    expect(blockedCode).toBe(1);
    expect(JSON.parse(out.join("\n"))).toMatchObject({
      status: "blocked",
      missingDevDependencies: ["vite", "vite-plugin-singlefile"],
      nextCommand: "pnpm add -D vite vite-plugin-singlefile",
    });

    // 3. Hand-edited file without generated marker fails closed on both `--plan` and `build`:
    const htmlOutPath = join(
      cwd,
      "supabase",
      "functions",
      "mcp",
      "dist",
      "apps",
      "review-queue.html",
    );
    await mkdir(join(cwd, "supabase", "functions", "mcp", "dist", "apps"), {
      recursive: true,
    });
    await writeFile(htmlOutPath, "<!doctype html><html>hand edited</html>");
    out.length = 0;
    const guardCode = await appCommand(["build", "--json"], {
      cwd,
      stdout: (line) => out.push(line),
      resolveVite: async () =>
        mockViteDeps(
          "<!doctype html><html><head></head><body>ok</body></html>",
        ),
    });
    expect(guardCode).toBe(1);
    expect(JSON.parse(out.join("\n")).status).toBe("conflict");
    expect(await readFile(htmlOutPath, "utf8")).toContain("hand edited");

    // Remove conflicting hand-edited file and run full build:
    await rm(htmlOutPath);
    out.length = 0;
    const compiled =
      "<!doctype html><html><head><title>Q</title></head><body><main>ok</main></body></html>";
    const builtCode = await appCommand(["build", "--json"], {
      cwd,
      stdout: (line) => out.push(line),
      resolveVite: async () => mockViteDeps(compiled),
    });
    expect(builtCode).toBe(0);
    const buildReport = JSON.parse(out.join("\n"));
    expect(buildReport.status).toBe("complete");
    expect(buildReport.apps[0].name).toBe("review-queue");

    const tsModulePath = join(
      cwd,
      "supabase",
      "functions",
      "mcp",
      "generated",
      "apps",
      "review-queue.html.ts",
    );
    const tsModuleText = await readFile(tsModulePath, "utf8");
    expect(tsModuleText).toContain(GENERATED_TS_MARKER);
    expect(tsModuleText).toContain(MCP_APP_PRESENTATION_PLACEHOLDER);
    const distHtmlText = await readFile(htmlOutPath, "utf8");
    expect(distHtmlText).toContain(GENERATED_HTML_MARKER);
    expect(distHtmlText).toContain(MCP_APP_PRESENTATION_PLACEHOLDER);

    // 4. `--check` passes when fresh, fails with `drift` when edited:
    out.length = 0;
    const checkFresh = await appCommand(["build", "--check", "--json"], {
      cwd,
      stdout: (line) => out.push(line),
      resolveVite: async () => mockViteDeps(compiled),
    });
    expect(checkFresh).toBe(0);
    expect(JSON.parse(out.join("\n")).status).toBe("complete");

    out.length = 0;
    const checkDrift = await appCommand(["build", "--check", "--json"], {
      cwd,
      stdout: (line) => out.push(line),
      resolveVite: async () =>
        mockViteDeps(
          "<!doctype html><html><head></head><body>changed</body></html>",
        ),
    });
    expect(checkDrift).toBe(1);
    expect(JSON.parse(out.join("\n")).status).toBe("drift");

    // 5. `app list --plan --json` is a clean read-only no-op reporting fresh built view:
    out.length = 0;
    const listCode = await appCommand(["list", "--plan", "--json"], {
      cwd,
      stdout: (line) => out.push(line),
    });
    expect(listCode).toBe(0);
    expect(JSON.parse(out.join("\n")).apps[0]).toMatchObject({
      name: "review-queue",
      built: true,
      fresh: true,
    });
  });

  it("tree-shakes pnpm zod/v4/locales paths and audits placeholders, external assets, and size budgets", () => {
    const plugin = chumboZodEnglishLocalePlugin();
    expect(
      plugin.transform(
        "export * from './fr.js';",
        "/repo/node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/locales/index.js?v=1",
      ),
    ).toBe('export { default as en } from "./en.js";');
    expect(
      plugin.transform("export const x = 1;", "/repo/src/main.ts"),
    ).toBeUndefined();

    expect(
      ensurePresentationPlaceholder("<html><head></head><body></body></html>"),
    ).toContain(MCP_APP_PRESENTATION_PLACEHOLDER);
    expect(() =>
      ensurePresentationPlaceholder(
        `${MCP_APP_PRESENTATION_PLACEHOLDER} ${MCP_APP_PRESENTATION_PLACEHOLDER}`,
      ),
    ).toThrow(/multiple/u);

    expect(() =>
      auditCompiledAppHtml(
        '<script src="https://cdn.example.com/app.js"></script>',
        400_000,
        "demo",
      ),
    ).toThrow(/external <script/u);
    expect(() =>
      auditCompiledAppHtml(
        '<link rel="stylesheet" href="https://cdn.example.com/a.css" />',
        400_000,
        "demo",
      ),
    ).toThrow(/external stylesheet/u);
    expect(() => auditCompiledAppHtml("x".repeat(2048), 1024, "demo")).toThrow(
      /budget/u,
    );
  });
});
