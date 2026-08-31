import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  AGENTS_POINTER,
  AGENTS_POINTER_END,
  AGENTS_POINTER_START,
  applySkillPlan,
  planSkill,
  SKILL_MANIFEST_NAME,
  type SkillBundle,
} from "../src/skill.js";

const firstBundle: SkillBundle = {
  version: "0.6.0-test",
  files: {
    "SKILL.md": "---\nname: chumbo\ndescription: test\n---\n\nFirst.\n",
    "references/old.md": "Old reference.\n",
  },
};

const nextBundle: SkillBundle = {
  version: "0.6.1-test",
  files: {
    "SKILL.md": "---\nname: chumbo\ndescription: test\n---\n\nSecond.\n",
    "references/new.md": "New reference.\n",
  },
};

async function fixture(agents?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chumbo-skill-"));
  await mkdir(join(root, "supabase"), { recursive: true });
  await writeFile(
    join(root, "supabase", "config.toml"),
    'project_id = "fixture"\n',
  );
  if (agents !== undefined) await writeFile(join(root, "AGENTS.md"), agents);
  return root;
}

async function manifest(root: string): Promise<{
  installedVersion: string;
  files: Record<string, { sha256: string }>;
}> {
  return JSON.parse(
    await readFile(join(root, "skills", "chumbo", SKILL_MANIFEST_NAME), "utf8"),
  );
}

describe("managed Chumbo skill", () => {
  it("plans without writing, installs idempotently, and preserves AGENTS content", async () => {
    const root = await fixture("# Existing agent guide\r\nNo final newline");
    const plan = await planSkill("install", root, firstBundle);
    expect(plan.state).toBe("ready");
    expect(plan.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: "skills/chumbo/SKILL.md",
          status: "create",
        }),
        expect.objectContaining({
          relativePath: "AGENTS.md",
          status: "update",
        }),
      ]),
    );
    await expect(
      readFile(join(root, "skills", "chumbo", "SKILL.md")),
    ).rejects.toThrow();

    await applySkillPlan(plan);
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(
      agents.startsWith("# Existing agent guide\r\nNo final newline"),
    ).toBe(true);
    expect(agents).toContain(AGENTS_POINTER);
    expect((await manifest(root)).installedVersion).toBe("0.6.0-test");

    const repeated = await planSkill("install", root, firstBundle);
    expect(repeated.state).toBe("current");
    expect(repeated.files.every((file) => file.status === "unchanged")).toBe(
      true,
    );
  });

  it("updates clean files, adds new references, and removes obsolete managed files", async () => {
    const root = await fixture("# Project instructions\n");
    await applySkillPlan(await planSkill("install", root, firstBundle));
    await writeFile(join(root, "UNRELATED.md"), "keep me\n");
    await writeFile(
      join(root, "AGENTS.md"),
      `${await readFile(join(root, "AGENTS.md"), "utf8")}\nUser-owned tail.\n`,
    );

    const update = await planSkill("update", root, nextBundle);
    expect(update.state).toBe("update_available");
    expect(update.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: "skills/chumbo/SKILL.md",
          status: "update",
        }),
        expect.objectContaining({
          relativePath: "skills/chumbo/references/old.md",
          status: "delete",
        }),
        expect.objectContaining({
          relativePath: "skills/chumbo/references/new.md",
          status: "create",
        }),
        expect.objectContaining({
          relativePath: "AGENTS.md",
          status: "unchanged",
        }),
      ]),
    );
    await applySkillPlan(update);

    expect(
      await readFile(join(root, "skills", "chumbo", "SKILL.md"), "utf8"),
    ).toContain("Second.");
    await expect(
      readFile(join(root, "skills", "chumbo", "references", "old.md")),
    ).rejects.toThrow();
    expect(
      await readFile(
        join(root, "skills", "chumbo", "references", "new.md"),
        "utf8",
      ),
    ).toBe("New reference.\n");
    expect(await readFile(join(root, "UNRELATED.md"), "utf8")).toBe(
      "keep me\n",
    );
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain(
      "User-owned tail.",
    );
    expect((await manifest(root)).installedVersion).toBe("0.6.1-test");
  });

  it("reports modified managed files and applies no partial update", async () => {
    const root = await fixture();
    await applySkillPlan(await planSkill("install", root, firstBundle));
    const skillPath = join(root, "skills", "chumbo", "SKILL.md");
    await writeFile(skillPath, "Builder-owned edit.\n");

    const update = await planSkill("update", root, nextBundle);
    expect(update.state).toBe("modified");
    expect(update.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: "skills/chumbo/SKILL.md",
          status: "conflict",
        }),
      ]),
    );
    await expect(applySkillPlan(update)).rejects.toThrow(
      "Refusing to overwrite",
    );
    expect(await readFile(skillPath, "utf8")).toBe("Builder-owned edit.\n");
    await expect(
      readFile(join(root, "skills", "chumbo", "references", "new.md")),
    ).rejects.toThrow();
    expect((await manifest(root)).installedVersion).toBe("0.6.0-test");
  });

  it("treats edits or malformed duplicates inside the managed AGENTS pointer as conflicts", async () => {
    const root = await fixture("# Existing\n");
    await applySkillPlan(await planSkill("install", root, firstBundle));
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(
      agentsPath,
      (await readFile(agentsPath, "utf8")).replace(
        "read\nand follow",
        "read carefully\nand follow",
      ),
    );
    expect((await planSkill("update", root, nextBundle)).state).toBe(
      "modified",
    );

    await writeFile(
      agentsPath,
      `${AGENTS_POINTER_START}\n${AGENTS_POINTER_START}\n${AGENTS_POINTER_END}\n`,
    );
    const malformed = await planSkill("update", root, nextBundle);
    expect(malformed.state).toBe("modified");
    expect(
      malformed.files.find((file) => file.relativePath === "AGENTS.md")?.reason,
    ).toContain("duplicate");
  });

  it("blocks an invalid or path-escaping manifest", async () => {
    const root = await fixture();
    const directory = join(root, "skills", "chumbo");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, SKILL_MANIFEST_NAME),
      JSON.stringify({
        schemaVersion: 1,
        skill: "chumbo",
        installedVersion: "bad",
        files: { "../outside.md": { sha256: "a".repeat(64) } },
        agents: {
          path: "AGENTS.md",
          pointerSha256: "b".repeat(64),
        },
      }),
    );
    const status = await planSkill("status", root, firstBundle);
    expect(status.state).toBe("blocked");
    expect(status.files[0]).toEqual(
      expect.objectContaining({ kind: "manifest", status: "conflict" }),
    );
  });

  it("refuses to take over a partially populated unmanaged skill directory", async () => {
    const root = await fixture();
    const directory = join(root, "skills", "chumbo");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "notes.md"), "User notes.\n");
    const install = await planSkill("install", root, firstBundle);
    expect(install.state).toBe("modified");
    expect(install.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: "skills/chumbo/notes.md",
          status: "conflict",
        }),
      ]),
    );
  });
});
