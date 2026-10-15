import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStarter,
  listStarters,
  projectIdFor,
  starterNextSteps,
} from "../src/create.js";

const startersRoot = join(import.meta.dirname, "..", "starters");
const temporary: string[] = [];

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "chumbo-create-"));
  temporary.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("starter catalog", () => {
  it("lists every starter with a valid manifest", async () => {
    const starters = await listStarters(startersRoot);
    expect(starters.map(({ id }) => id)).toContain("team-tasks");
    const teamTasks = starters.find(({ id }) => id === "team-tasks")!;
    expect(teamTasks.auth).toBe("oauth");
    expect(teamTasks.function).toBe("mcp");
    expect(teamTasks.demoUsers.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects a manifest whose id does not match its directory", async () => {
    const root = await scratch();
    await mkdir(join(root, "real-name"));
    await writeFile(
      join(root, "real-name", "starter.json"),
      JSON.stringify({
        id: "other-name",
        title: "x",
        summary: "x",
        auth: "oauth",
        function: "mcp",
        serverName: "x",
        frontend: "vite-react",
        tools: [],
        demoUsers: [],
      }),
    );
    await expect(listStarters(root)).rejects.toThrow(
      /Invalid starter manifest/,
    );
  });
});

describe("chumbo create", () => {
  it("copies the starter, renames _gitignore, and sets a unique project_id", async () => {
    const parent = await scratch();
    const target = join(parent, "My Cool App");
    const result = await createStarter({
      starter: "team-tasks",
      directory: target,
      startersRoot,
    });

    expect(result.files).toContain(".gitignore");
    expect(result.files).not.toContain("_gitignore");
    expect(result.files).toContain(
      join("supabase", "functions", "mcp", "capabilities.ts"),
    );
    expect(result.files).toContain(join("web", "src", "Consent.tsx"));
    expect(result.files).toContain(join("web", ".env.example"));
    expect(
      result.files.some(
        (file) =>
          file.includes("node_modules") ||
          /(^|\/)\.env(\.local)?$/.test(file) ||
          file.startsWith(join("web", "dist")),
      ),
    ).toBe(false);

    const config = await readFile(
      join(target, "supabase", "config.toml"),
      "utf8",
    );
    expect(config).toMatch(/^project_id = "my-cool-app"$/m);
    expect(config).toMatch(/\[auth\.oauth_server\]\n(#.*\n)*enabled = true/);
    expect(config).toMatch(/\[functions\.mcp\]\nverify_jwt = false/);

    const steps = starterNextSteps(result, "My Cool App");
    expect(steps[0]).toBe("cd My Cool App");
    expect(steps.join("\n")).toContain("alice@example.com");
  });

  it("refuses a non-empty directory unless forced, and never overwrites", async () => {
    const target = await scratch();
    await writeFile(join(target, "notes.txt"), "keep me");
    await expect(
      createStarter({ starter: "team-tasks", directory: target, startersRoot }),
    ).rejects.toThrow(/not empty/);

    await createStarter({
      starter: "team-tasks",
      directory: target,
      startersRoot,
      force: true,
    });
    expect(await readFile(join(target, "notes.txt"), "utf8")).toBe("keep me");
    expect((await stat(join(target, "starter.json"))).isFile()).toBe(true);

    await expect(
      createStarter({
        starter: "team-tasks",
        directory: target,
        startersRoot,
        force: true,
      }),
    ).rejects.toThrow(/Refusing to overwrite existing files/);
  });

  it("reports unknown starters with the available ids", async () => {
    const target = join(await scratch(), "app");
    await expect(
      createStarter({ starter: "nope", directory: target, startersRoot }),
    ).rejects.toThrow(/Available: .*team-tasks/);
    await expect(readdir(target)).rejects.toThrow();
  });

  it("derives Docker-safe Supabase project ids", () => {
    expect(projectIdFor("/tmp/Team Tasks!")).toBe("team-tasks");
    expect(projectIdFor("/tmp/___")).toBe("chumbo-starter");
  });
});
