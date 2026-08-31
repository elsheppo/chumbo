import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_VERSION } from "./version.js";

export const SKILL_RELATIVE_DIRECTORY = "skills/chumbo";
export const SKILL_MANIFEST_NAME = ".chumbo-skill.json";
export const AGENTS_POINTER_START = "<!-- chumbo:skill:start -->";
export const AGENTS_POINTER_END = "<!-- chumbo:skill:end -->";

const LEGACY_SKILL_RELATIVE_DIRECTORY = "skills/supa-mcp";
const LEGACY_SKILL_MANIFEST_NAME = ".supa-mcp-skill.json";
const LEGACY_AGENTS_POINTER_START = "<!-- supa-mcp:skill:start -->";
const LEGACY_AGENTS_POINTER_END = "<!-- supa-mcp:skill:end -->";

export const AGENTS_POINTER = `${AGENTS_POINTER_START}
## Chumbo agent skill

For designing, implementing, reviewing, or testing Chumbo capabilities, read
and follow \`skills/chumbo/SKILL.md\`.
${AGENTS_POINTER_END}`;

export interface SkillBundle {
  version: string;
  files: Readonly<Record<string, string>>;
}

interface SkillManifest {
  schemaVersion: 1;
  skill: "chumbo" | "supa-mcp";
  installedVersion: string;
  files: Record<string, { sha256: string }>;
  agents: {
    path: "AGENTS.md";
    pointerSha256: string;
  };
}

export type SkillAction = "install" | "status" | "update";
export type SkillFileStatus =
  | "create"
  | "update"
  | "unchanged"
  | "delete"
  | "conflict";

export interface PlannedSkillFile {
  path: string;
  relativePath: string;
  kind: "skill" | "agents" | "manifest";
  status: SkillFileStatus;
  reason?: string;
  content?: string;
}

export interface SkillPlan {
  action: SkillAction;
  projectRoot: string;
  availableVersion: string;
  installedVersion?: string;
  state:
    | "ready"
    | "current"
    | "update_available"
    | "not_installed"
    | "modified"
    | "blocked";
  files: PlannedSkillFile[];
  message?: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function portablePath(value: string): string {
  return value.split(sep).join("/");
}

function assertManagedPath(value: string): void {
  if (
    !value ||
    value.includes("\\") ||
    posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === ".." ||
    value.startsWith("../")
  ) {
    throw new Error(`Invalid managed skill path '${value}'`);
  }
}

async function fileState(path: string): Promise<"missing" | "file" | "other"> {
  try {
    const stat = await lstat(path);
    return stat.isFile() ? "file" : "other";
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      return "missing";
    }
    throw error;
  }
}

async function hasUnsafeParent(
  skillRoot: string,
  managedPath: string,
): Promise<boolean> {
  const parts = managedPath.split("/").slice(0, -1);
  let current = skillRoot;
  const rootState = await fileState(current);
  if (rootState === "file") return true;
  if (rootState === "other") {
    const stat = await lstat(current);
    if (!stat.isDirectory()) return true;
  }
  for (const part of parts) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return false;
}

async function readTree(
  root: string,
  current = root,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Bundled skill contains a symbolic link: ${path}`);
    }
    if (entry.isDirectory()) {
      Object.assign(result, await readTree(root, path));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Bundled skill contains an unsupported entry: ${path}`);
    }
    const name = portablePath(relative(root, path));
    assertManagedPath(name);
    result[name] = await readFile(path, "utf8");
  }
  return result;
}

export async function loadBundledSkill(
  sourceRoot = fileURLToPath(new URL("../skills/chumbo/", import.meta.url)),
  version = PACKAGE_VERSION,
): Promise<SkillBundle> {
  return { version, files: await readTree(sourceRoot) };
}

function desiredManifest(bundle: SkillBundle): SkillManifest {
  const files = Object.fromEntries(
    Object.entries(bundle.files)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, content]) => {
        assertManagedPath(path);
        return [path, { sha256: sha256(content) }];
      }),
  );
  return {
    schemaVersion: 1,
    skill: "chumbo",
    installedVersion: bundle.version,
    files,
    agents: {
      path: "AGENTS.md",
      pointerSha256: sha256(AGENTS_POINTER),
    },
  };
}

function manifestText(manifest: SkillManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function parseManifest(
  source: string,
  expectedSkill: SkillManifest["skill"],
): SkillManifest {
  const value = JSON.parse(source) as Partial<SkillManifest>;
  if (
    value.schemaVersion !== 1 ||
    value.skill !== expectedSkill ||
    typeof value.installedVersion !== "string" ||
    !value.installedVersion ||
    !value.files ||
    typeof value.files !== "object" ||
    value.agents?.path !== "AGENTS.md" ||
    !/^[a-f0-9]{64}$/.test(value.agents.pointerSha256 ?? "")
  ) {
    throw new Error("The managed skill manifest is invalid or unsupported.");
  }
  for (const [path, entry] of Object.entries(value.files)) {
    assertManagedPath(path);
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) {
      throw new Error(`The manifest hash for '${path}' is invalid.`);
    }
  }
  return value as SkillManifest;
}

interface PointerInspection {
  state: "absent" | "valid" | "invalid";
  source: string;
  block?: string;
  start?: number;
  end?: number;
  reason?: string;
}

function markerIndexes(source: string, marker: string): number[] {
  const indexes: number[] = [];
  let from = 0;
  while (true) {
    const index = source.indexOf(marker, from);
    if (index < 0) return indexes;
    indexes.push(index);
    from = index + marker.length;
  }
}

function inspectPointer(
  source: string,
  startMarker = AGENTS_POINTER_START,
  endMarker = AGENTS_POINTER_END,
): PointerInspection {
  const starts = markerIndexes(source, startMarker);
  const ends = markerIndexes(source, endMarker);
  if (starts.length === 0 && ends.length === 0) {
    return { state: "absent", source };
  }
  if (starts.length !== 1 || ends.length !== 1 || starts[0]! > ends[0]!) {
    return {
      state: "invalid",
      source,
      reason:
        "AGENTS.md has incomplete, reversed, or duplicate Chumbo markers.",
    };
  }
  const start = starts[0]!;
  const end = ends[0]! + endMarker.length;
  return {
    state: "valid",
    source,
    block: source.slice(start, end),
    start,
    end,
  };
}

function appendPointer(source: string): string {
  if (source.length === 0) return `${AGENTS_POINTER}\n`;
  const separator = source.endsWith("\n") ? "\n" : "\n\n";
  return `${source}${separator}${AGENTS_POINTER}\n`;
}

function replacePointer(
  inspection: PointerInspection,
  desiredPointer = AGENTS_POINTER,
): string {
  return `${inspection.source.slice(0, inspection.start)}${desiredPointer}${inspection.source.slice(inspection.end)}`;
}

function plannedFile(
  projectRoot: string,
  path: string,
  kind: PlannedSkillFile["kind"],
  status: SkillFileStatus,
  options: { reason?: string; content?: string } = {},
): PlannedSkillFile {
  return {
    path,
    relativePath: portablePath(relative(projectRoot, path)),
    kind,
    status,
    ...options,
  };
}

async function readManifest(
  path: string,
  expectedSkill: SkillManifest["skill"],
): Promise<{ manifest?: SkillManifest; source?: string; error?: string }> {
  const state = await fileState(path);
  if (state === "missing") return {};
  if (state !== "file") {
    return { error: "The managed skill manifest path is not a regular file." };
  }
  const source = await readFile(path, "utf8");
  try {
    return { manifest: parseManifest(source, expectedSkill), source };
  } catch (error) {
    return {
      source,
      error: error instanceof Error ? error.message : "Invalid skill manifest.",
    };
  }
}

async function listUnmanagedInitialFiles(
  skillRoot: string,
  desired: ReadonlySet<string>,
): Promise<string[]> {
  const state = await fileState(skillRoot);
  if (state === "missing") return [];
  if (state !== "other") return [skillRoot];
  const result: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      const name = portablePath(relative(skillRoot, path));
      if (name === SKILL_MANIFEST_NAME) continue;
      if (entry.isSymbolicLink() || !entry.isFile() || !desired.has(name)) {
        result.push(path);
      }
    }
  }
  await walk(skillRoot);
  return result;
}

async function planInitialInstall(
  projectRoot: string,
  bundle: SkillBundle,
): Promise<SkillPlan> {
  const skillRoot = join(projectRoot, ...SKILL_RELATIVE_DIRECTORY.split("/"));
  const manifestPath = join(skillRoot, SKILL_MANIFEST_NAME);
  const agentsPath = join(projectRoot, "AGENTS.md");
  const files: PlannedSkillFile[] = [];
  const desiredNames = new Set(Object.keys(bundle.files));

  for (const path of await listUnmanagedInitialFiles(skillRoot, desiredNames)) {
    files.push(
      plannedFile(projectRoot, path, "skill", "conflict", {
        reason: "The target skill directory contains an unmanaged entry.",
      }),
    );
  }

  for (const [name, content] of Object.entries(bundle.files).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    assertManagedPath(name);
    const path = join(skillRoot, ...name.split("/"));
    if (await hasUnsafeParent(skillRoot, name)) {
      files.push(
        plannedFile(projectRoot, path, "skill", "conflict", {
          reason:
            "A managed skill path has a non-directory or symbolic parent.",
        }),
      );
      continue;
    }
    const state = await fileState(path);
    if (state === "missing") {
      files.push(
        plannedFile(projectRoot, path, "skill", "create", { content }),
      );
    } else if (state === "file" && (await readFile(path, "utf8")) === content) {
      files.push(plannedFile(projectRoot, path, "skill", "unchanged"));
    } else {
      files.push(
        plannedFile(projectRoot, path, "skill", "conflict", {
          reason: "A different unmanaged file already exists at this path.",
        }),
      );
    }
  }

  const agentsState = await fileState(agentsPath);
  const agentsSource =
    agentsState === "missing"
      ? ""
      : agentsState === "file"
        ? await readFile(agentsPath, "utf8")
        : undefined;
  if (agentsSource === undefined) {
    files.push(
      plannedFile(projectRoot, agentsPath, "agents", "conflict", {
        reason: "AGENTS.md is not a regular file.",
      }),
    );
  } else {
    const pointer = inspectPointer(agentsSource);
    if (pointer.state === "invalid") {
      files.push(
        plannedFile(projectRoot, agentsPath, "agents", "conflict", {
          reason: pointer.reason,
        }),
      );
    } else if (pointer.state === "valid") {
      files.push(
        plannedFile(
          projectRoot,
          agentsPath,
          "agents",
          pointer.block === AGENTS_POINTER ? "unchanged" : "conflict",
          pointer.block === AGENTS_POINTER
            ? {}
            : { reason: "The existing Chumbo managed pointer differs." },
        ),
      );
    } else {
      files.push(
        plannedFile(
          projectRoot,
          agentsPath,
          "agents",
          agentsState === "missing" ? "create" : "update",
          { content: appendPointer(agentsSource) },
        ),
      );
    }
  }

  const manifest = manifestText(desiredManifest(bundle));
  files.push(
    plannedFile(projectRoot, manifestPath, "manifest", "create", {
      content: manifest,
    }),
  );
  const conflict = files.some((file) => file.status === "conflict");
  return {
    action: "install",
    projectRoot,
    availableVersion: bundle.version,
    state: conflict ? "modified" : "ready",
    files,
    ...(conflict
      ? { message: "Resolve the listed conflicts before installing the skill." }
      : {}),
  };
}

async function planManagedSkill(
  action: SkillAction,
  projectRoot: string,
  bundle: SkillBundle,
  manifest: SkillManifest,
  manifestSource: string,
): Promise<SkillPlan> {
  const skillRoot = join(projectRoot, ...SKILL_RELATIVE_DIRECTORY.split("/"));
  const manifestPath = join(skillRoot, SKILL_MANIFEST_NAME);
  const agentsPath = join(projectRoot, "AGENTS.md");
  const files: PlannedSkillFile[] = [];
  const desired = desiredManifest(bundle);
  const allNames = new Set([
    ...Object.keys(manifest.files),
    ...Object.keys(bundle.files),
  ]);

  for (const name of [...allNames].sort()) {
    assertManagedPath(name);
    const path = join(skillRoot, ...name.split("/"));
    if (await hasUnsafeParent(skillRoot, name)) {
      files.push(
        plannedFile(projectRoot, path, "skill", "conflict", {
          reason:
            "A managed skill path has a non-directory or symbolic parent.",
        }),
      );
      continue;
    }
    const previous = manifest.files[name]?.sha256;
    const nextContent = bundle.files[name];
    const nextHash =
      nextContent === undefined ? undefined : sha256(nextContent);
    const state = await fileState(path);
    if (state !== "file") {
      if (!previous && state === "missing" && nextContent !== undefined) {
        files.push(
          plannedFile(projectRoot, path, "skill", "create", {
            content: nextContent,
          }),
        );
      } else {
        files.push(
          plannedFile(projectRoot, path, "skill", "conflict", {
            reason:
              state === "missing"
                ? "A managed skill file is missing."
                : "A managed skill path is not a regular file.",
          }),
        );
      }
      continue;
    }
    const currentContent = await readFile(path, "utf8");
    const currentHash = sha256(currentContent);
    if (!previous) {
      files.push(
        plannedFile(
          projectRoot,
          path,
          "skill",
          currentHash === nextHash ? "unchanged" : "conflict",
          currentHash === nextHash
            ? {}
            : {
                reason: "A different unmanaged file occupies a new skill path.",
              },
        ),
      );
      continue;
    }
    if (nextContent === undefined) {
      files.push(
        plannedFile(
          projectRoot,
          path,
          "skill",
          currentHash === previous ? "delete" : "conflict",
          currentHash === previous
            ? {}
            : { reason: "A managed file was edited and cannot be removed." },
        ),
      );
      continue;
    }
    if (currentHash === nextHash) {
      files.push(plannedFile(projectRoot, path, "skill", "unchanged"));
    } else if (currentHash === previous) {
      files.push(
        plannedFile(projectRoot, path, "skill", "update", {
          content: nextContent,
        }),
      );
    } else {
      files.push(
        plannedFile(projectRoot, path, "skill", "conflict", {
          reason: "The managed skill file has local edits.",
        }),
      );
    }
  }

  const agentsState = await fileState(agentsPath);
  if (agentsState !== "file") {
    files.push(
      plannedFile(projectRoot, agentsPath, "agents", "conflict", {
        reason:
          agentsState === "missing"
            ? "The managed AGENTS.md pointer is missing."
            : "AGENTS.md is not a regular file.",
      }),
    );
  } else {
    const agentsSource = await readFile(agentsPath, "utf8");
    const pointer = inspectPointer(agentsSource);
    if (pointer.state !== "valid") {
      files.push(
        plannedFile(projectRoot, agentsPath, "agents", "conflict", {
          reason: pointer.reason ?? "The managed AGENTS.md pointer is missing.",
        }),
      );
    } else {
      const currentHash = sha256(pointer.block!);
      const desiredHash = desired.agents.pointerSha256;
      if (currentHash === desiredHash) {
        files.push(plannedFile(projectRoot, agentsPath, "agents", "unchanged"));
      } else if (currentHash === manifest.agents.pointerSha256) {
        files.push(
          plannedFile(projectRoot, agentsPath, "agents", "update", {
            content: replacePointer(pointer),
          }),
        );
      } else {
        files.push(
          plannedFile(projectRoot, agentsPath, "agents", "conflict", {
            reason: "The managed AGENTS.md pointer has local edits.",
          }),
        );
      }
    }
  }

  const desiredSource = manifestText(desired);
  files.push(
    plannedFile(
      projectRoot,
      manifestPath,
      "manifest",
      manifestSource === desiredSource ? "unchanged" : "update",
      manifestSource === desiredSource ? {} : { content: desiredSource },
    ),
  );

  const conflict = files.some((file) => file.status === "conflict");
  const changed = files.some((file) =>
    ["create", "update", "delete"].includes(file.status),
  );
  const versionChanged = manifest.installedVersion !== bundle.version;
  return {
    action,
    projectRoot,
    availableVersion: bundle.version,
    installedVersion: manifest.installedVersion,
    state: conflict
      ? "modified"
      : versionChanged || changed
        ? "update_available"
        : "current",
    files,
    ...(conflict
      ? {
          message:
            "Local changes conflict with the managed skill. No files will be overwritten.",
        }
      : {}),
  };
}

async function planLegacyMigration(
  action: SkillAction,
  projectRoot: string,
  bundle: SkillBundle,
  manifest: SkillManifest,
  legacyManifestPath: string,
): Promise<SkillPlan> {
  const legacySkillRoot = join(
    projectRoot,
    ...LEGACY_SKILL_RELATIVE_DIRECTORY.split("/"),
  );
  const agentsPath = join(projectRoot, "AGENTS.md");
  const initial = await planInitialInstall(projectRoot, bundle);
  const canonicalManifest = initial.files.find(
    (file) => file.kind === "manifest",
  );
  const files = initial.files.filter(
    (file) => file.kind !== "agents" && file.kind !== "manifest",
  );

  for (const [name, entry] of Object.entries(manifest.files).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    assertManagedPath(name);
    const path = join(legacySkillRoot, ...name.split("/"));
    if (await hasUnsafeParent(legacySkillRoot, name)) {
      files.push(
        plannedFile(projectRoot, path, "skill", "conflict", {
          reason:
            "A managed legacy skill path has a non-directory or symbolic parent.",
        }),
      );
      continue;
    }
    const state = await fileState(path);
    if (state !== "file") {
      files.push(
        plannedFile(projectRoot, path, "skill", "conflict", {
          reason:
            state === "missing"
              ? "A managed legacy skill file is missing."
              : "A managed legacy skill path is not a regular file.",
        }),
      );
      continue;
    }
    const currentHash = sha256(await readFile(path, "utf8"));
    files.push(
      plannedFile(
        projectRoot,
        path,
        "skill",
        currentHash === entry.sha256 ? "delete" : "conflict",
        currentHash === entry.sha256
          ? {}
          : {
              reason:
                "The managed legacy skill file has local edits and cannot be migrated.",
            },
      ),
    );
  }

  const agentsState = await fileState(agentsPath);
  if (agentsState !== "file") {
    files.push(
      plannedFile(projectRoot, agentsPath, "agents", "conflict", {
        reason:
          agentsState === "missing"
            ? "The managed legacy AGENTS.md pointer is missing."
            : "AGENTS.md is not a regular file.",
      }),
    );
  } else {
    const agentsSource = await readFile(agentsPath, "utf8");
    const canonicalPointer = inspectPointer(agentsSource);
    const legacyPointer = inspectPointer(
      agentsSource,
      LEGACY_AGENTS_POINTER_START,
      LEGACY_AGENTS_POINTER_END,
    );
    if (canonicalPointer.state !== "absent") {
      files.push(
        plannedFile(projectRoot, agentsPath, "agents", "conflict", {
          reason:
            "AGENTS.md already contains Chumbo markers alongside the managed legacy pointer.",
        }),
      );
    } else if (legacyPointer.state !== "valid") {
      files.push(
        plannedFile(projectRoot, agentsPath, "agents", "conflict", {
          reason:
            legacyPointer.reason ??
            "The managed legacy AGENTS.md pointer is missing.",
        }),
      );
    } else if (sha256(legacyPointer.block!) !== manifest.agents.pointerSha256) {
      files.push(
        plannedFile(projectRoot, agentsPath, "agents", "conflict", {
          reason:
            "The managed legacy AGENTS.md pointer has local edits and cannot be migrated.",
        }),
      );
    } else {
      files.push(
        plannedFile(projectRoot, agentsPath, "agents", "update", {
          content: replacePointer(legacyPointer),
        }),
      );
    }
  }

  files.push(
    plannedFile(projectRoot, legacyManifestPath, "skill", "delete", {
      reason: "Replace the legacy managed manifest after migration.",
    }),
  );
  if (canonicalManifest) files.push(canonicalManifest);

  const conflict = files.some((file) => file.status === "conflict");
  return {
    action,
    projectRoot,
    availableVersion: bundle.version,
    installedVersion: manifest.installedVersion,
    state: conflict ? "modified" : "update_available",
    files,
    message: conflict
      ? "Local changes conflict with the managed legacy skill. No files will be written."
      : "The managed legacy skill is ready to migrate to skills/chumbo.",
  };
}

function blockedInstallationPlan(
  action: SkillAction,
  projectRoot: string,
  bundle: SkillBundle,
  path: string,
  reason: string,
  message: string,
  kind: PlannedSkillFile["kind"] = "manifest",
): SkillPlan {
  return {
    action,
    projectRoot,
    availableVersion: bundle.version,
    state: "blocked",
    files: [plannedFile(projectRoot, path, kind, "conflict", { reason })],
    message,
  };
}

export async function planSkill(
  action: SkillAction,
  projectRoot: string,
  bundle: SkillBundle,
): Promise<SkillPlan> {
  if (!bundle.version.trim())
    throw new Error("The bundled skill has no version.");
  if (!("SKILL.md" in bundle.files)) {
    throw new Error("The bundled Chumbo skill has no SKILL.md.");
  }
  for (const path of Object.keys(bundle.files)) assertManagedPath(path);

  const skillRoot = join(projectRoot, ...SKILL_RELATIVE_DIRECTORY.split("/"));
  const manifestPath = join(skillRoot, SKILL_MANIFEST_NAME);
  const legacySkillRoot = join(
    projectRoot,
    ...LEGACY_SKILL_RELATIVE_DIRECTORY.split("/"),
  );
  const legacyManifestPath = join(legacySkillRoot, LEGACY_SKILL_MANIFEST_NAME);
  const loaded = await readManifest(manifestPath, "chumbo");
  if (loaded.error) {
    return blockedInstallationPlan(
      action,
      projectRoot,
      bundle,
      manifestPath,
      loaded.error,
      "The managed Chumbo manifest cannot be trusted. Repair or remove the skill installation before continuing.",
    );
  }

  const legacyLoaded = await readManifest(legacyManifestPath, "supa-mcp");
  if (legacyLoaded.error) {
    return blockedInstallationPlan(
      action,
      projectRoot,
      bundle,
      legacyManifestPath,
      legacyLoaded.error,
      "The managed legacy skill manifest cannot be trusted. Repair or remove the legacy installation before continuing.",
    );
  }
  const legacySkillPath = join(legacySkillRoot, "SKILL.md");
  const legacySkillState = await fileState(legacySkillPath);
  const agentsPath = join(projectRoot, "AGENTS.md");
  const agentsState = await fileState(agentsPath);
  const legacyPointerState =
    agentsState === "file"
      ? inspectPointer(
          await readFile(agentsPath, "utf8"),
          LEGACY_AGENTS_POINTER_START,
          LEGACY_AGENTS_POINTER_END,
        ).state
      : "absent";

  if (loaded.manifest && loaded.source !== undefined) {
    if (
      legacyLoaded.manifest ||
      legacySkillState !== "missing" ||
      legacyPointerState !== "absent"
    ) {
      const conflictPath = legacyLoaded.manifest
        ? legacyManifestPath
        : legacySkillState !== "missing"
          ? legacySkillPath
          : agentsPath;
      return blockedInstallationPlan(
        action,
        projectRoot,
        bundle,
        conflictPath,
        "A legacy skill installation exists alongside the canonical Chumbo skill.",
        "Remove or reconcile the duplicate legacy skill before continuing.",
        conflictPath === agentsPath ? "agents" : "skill",
      );
    }
    return planManagedSkill(
      action,
      projectRoot,
      bundle,
      loaded.manifest,
      loaded.source,
    );
  }

  if (legacyLoaded.manifest && legacyLoaded.source !== undefined) {
    return planLegacyMigration(
      action,
      projectRoot,
      bundle,
      legacyLoaded.manifest,
      legacyManifestPath,
    );
  }

  if (legacySkillState !== "missing") {
    return blockedInstallationPlan(
      action,
      projectRoot,
      bundle,
      legacySkillPath,
      "An unmanaged legacy SKILL.md would create a duplicate active skill.",
      "Move or remove the unmanaged legacy skill before installing the canonical Chumbo skill.",
      "skill",
    );
  }

  if (legacyPointerState !== "absent") {
    return blockedInstallationPlan(
      action,
      projectRoot,
      bundle,
      agentsPath,
      "AGENTS.md contains legacy Chumbo skill markers without a trusted managed manifest.",
      "Repair or remove the stale legacy pointer before installing the canonical Chumbo skill.",
      "agents",
    );
  }

  if (action === "update" || action === "status") {
    return {
      action,
      projectRoot,
      availableVersion: bundle.version,
      state: "not_installed",
      files: [],
      message: "The Chumbo project skill is not installed.",
    };
  }
  return planInitialInstall(projectRoot, bundle);
}

let temporaryCounter = 0;

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.chumbo-${process.pid}-${temporaryCounter++}.tmp`,
  );
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function applySkillPlan(plan: SkillPlan): Promise<void> {
  const conflicts = plan.files.filter((file) => file.status === "conflict");
  if (conflicts.length > 0 || plan.state === "blocked") {
    throw new Error(
      `Refusing to overwrite modified skill files:\n${conflicts
        .map((file) => `- ${file.relativePath}: ${file.reason ?? "conflict"}`)
        .join("\n")}`,
    );
  }

  const manifest = plan.files.find((file) => file.kind === "manifest");
  for (const file of plan.files) {
    if (
      file.kind === "manifest" ||
      !["create", "update"].includes(file.status)
    ) {
      continue;
    }
    if (file.content === undefined) {
      throw new Error(`No content was planned for ${file.relativePath}`);
    }
    await atomicWrite(file.path, file.content);
  }
  for (const file of plan.files) {
    if (file.status === "delete") await rm(file.path);
  }
  if (
    manifest &&
    ["create", "update"].includes(manifest.status) &&
    manifest.content !== undefined
  ) {
    await atomicWrite(manifest.path, manifest.content);
  }
}

export function skillPlanSummary(plan: SkillPlan): Array<{
  path: string;
  kind: PlannedSkillFile["kind"];
  status: SkillFileStatus;
  reason?: string;
}> {
  return plan.files.map(({ relativePath: path, kind, status, reason }) => ({
    path,
    kind,
    status,
    ...(reason ? { reason } : {}),
  }));
}
