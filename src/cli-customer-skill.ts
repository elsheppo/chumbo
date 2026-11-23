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
import {
  basename,
  dirname,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import type { BrandedCliConfig, BrandedCliIo } from "./cli-host.js";
import { propertyToCliFlag } from "./cli-completions.js";
import type { CliCapability } from "./cli-surface.js";

export type CustomerSkillAction = "install" | "status" | "update";
export type CustomerSkillTarget = "agents" | "claude" | "both";
export type CustomerSkillFileStatus =
  | "create"
  | "update"
  | "unchanged"
  | "delete"
  | "conflict";

export const CUSTOMER_SKILL_MANIFEST_NAME = ".chumbo-cli-skill.json" as const;
export const INLINE_CAPABILITY_BUDGET = 12;

interface CustomerSkillManifest {
  readonly schemaVersion: 1;
  readonly binaryName: string;
  readonly cliVersion: string;
  readonly surfaceDigest: string;
  readonly files: Readonly<Record<string, { readonly sha256: string }>>;
}

export interface PlannedCustomerSkillFile {
  readonly path: string;
  readonly relativePath: string;
  readonly target: "agents" | "claude";
  readonly kind: "skill" | "manifest";
  readonly status: CustomerSkillFileStatus;
  readonly content?: string;
  readonly reason?: string;
}

export interface CustomerSkillPlan {
  readonly action: CustomerSkillAction;
  readonly target: CustomerSkillTarget;
  readonly workspaceRoot: string;
  readonly cliVersion: string;
  readonly installedVersion?: string;
  readonly surfaceDigest: string;
  readonly state:
    | "ready"
    | "current"
    | "update_available"
    | "not_installed"
    | "modified"
    | "blocked";
  readonly files: readonly PlannedCustomerSkillFile[];
  readonly message?: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function portablePath(value: string): string {
  return value.split(sep).join("/");
}

function assertManagedRelativePath(value: string): void {
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

function sanitizeInlineText(raw: string | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function sanitizeTableCell(raw: string | undefined): string {
  return sanitizeInlineText(raw).replaceAll("|", "\\|").replaceAll("`", "'");
}

function sanitizeCodeLine(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replaceAll("```", "")
    .trim();
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function renderCapabilitySection(
  binaryName: string,
  item: CliCapability,
): string {
  const heading = `### \`${binaryName} ${item.command.join(" ")}\` (\`${item.risk}\`${item.idempotent ? ", idempotent" : ""})`;
  const description = sanitizeInlineText(item.description || item.title);
  const root = record(item.inputSchema) ?? {};
  const properties = record(root.properties) ?? {};
  const requiredSet = new Set(
    Array.isArray(root.required)
      ? root.required.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
  );

  const optionLines: string[] = [];
  for (const [name, rawSchema] of Object.entries(properties)) {
    const flag = propertyToCliFlag(name);
    if (!flag) continue;
    const shape = record(rawSchema) ?? {};
    const typeName =
      typeof shape.type === "string" ? sanitizeInlineText(shape.type) : "value";
    const reqTag = requiredSet.has(name) ? " (required)" : "";
    const propDesc =
      typeof shape.description === "string"
        ? ` — ${sanitizeInlineText(shape.description)}`
        : "";
    optionLines.push(`- \`${flag} <${typeName}>\`${reqTag}${propDesc}`);
  }
  if (item.risk !== "read") {
    optionLines.push("- `--yes` (required in non-interactive sessions)");
  }
  optionLines.push("- `--json` (emit structured JSON receipt)");

  const exampleLines = item.examples
    .map(sanitizeCodeLine)
    .filter((line) => line.length > 0)
    .map((line) => `${binaryName} ${line}`);

  const parts = [heading];
  if (description) parts.push(description);
  parts.push(optionLines.join("\n"));
  if (exampleLines.length > 0) {
    parts.push(`Examples:\n\`\`\`sh\n${exampleLines.join("\n")}\n\`\`\``);
  }
  return parts.join("\n\n");
}

export function synthesizeCustomerSkillFiles(
  config: BrandedCliConfig,
  capabilities: readonly CliCapability[],
  tokenEnvVar: string,
): Readonly<Record<string, string>> {
  const safeDisplay =
    sanitizeInlineText(config.displayName) || config.binaryName;
  const frontmatterDescription = JSON.stringify(
    `Use the ${safeDisplay} CLI (${config.binaryName}) to run authenticated ${safeDisplay} operations from the terminal with structured --json output.`,
  );

  const sorted = [...capabilities].sort((left, right) =>
    left.command.join(" ").localeCompare(right.command.join(" ")),
  );

  const tableRows = sorted.map((item) => {
    const cmdText = `\`${config.binaryName} ${item.command.join(" ")}\``;
    const riskNote =
      item.risk === "read"
        ? item.description || item.title
        : `${item.description || item.title} (--yes required)`;
    return `| ${cmdText} | \`${item.risk}\` | ${sanitizeTableCell(riskNote)} |`;
  });

  const commandTable =
    sorted.length > 0
      ? [
          "| Command | Risk | Description |",
          "| --- | --- | --- |",
          ...tableRows,
        ].join("\n")
      : `Run \`${config.binaryName} commands --json\` after signing in to inspect available commands.`;

  const splitReference = sorted.length > INLINE_CAPABILITY_BUDGET;
  const detailedSections = sorted
    .map((item) => renderCapabilitySection(config.binaryName, item))
    .join("\n\n");

  const supportLine = config.supportUrl
    ? `\nSupport: ${sanitizeInlineText(config.supportUrl)}\n`
    : "";

  const skillBody = `---
name: ${config.binaryName}
description: ${frontmatterDescription}
---

# ${safeDisplay} CLI (\`${config.binaryName}\`)

Use \`${config.binaryName}\` for ${safeDisplay} operations. Commands map directly to authenticated MCP capabilities and enforce the caller's permissions.

## 1. Check authentication before running commands

\`\`\`sh
${config.binaryName} status --json
\`\`\`

- Exit code \`0\`: signed in and ready.
- Exit code \`3\` (\`AUTH_REQUIRED\`): in headless or CI environments, ensure \`${tokenEnvVar}\` is set in the environment; in interactive sessions, ask the user to run \`${config.binaryName} login\`. Never echo or log \`${tokenEnvVar}\`.

## 2. Execution & safety rules

- **Always pass \`--json\`** when parsing output programmatically. Every tool command returns \`{ "ok": boolean, "command": string[], "capabilityId": string, "mcpName": string, "result": CallToolResult }\`.
- **Write & destructive confirmation (\`exit 4\`):** Commands marked \`write\` or \`destructive\` fail closed in non-interactive sessions without \`--yes\`. Inspect inputs carefully and confirm user intent before passing \`--yes\` on \`destructive\` commands.
- **Pagination (\`--limit\`, \`--cursor\`):** Collection commands accept \`--limit <integer>\` and \`--cursor <string>\`. Pass \`result.structuredContent.nextCursor\` to \`--cursor\` to fetch the next page.
- **Schema refresh:** Pass \`--refresh\` if a newly deployed command or option is not yet in the 60-second discovery cache.

## 3. Available commands

${commandTable}
${
  splitReference
    ? `\nFor full option schemas and examples across all ${sorted.length} commands, read [references/commands.md](references/commands.md).\n`
    : detailedSections
      ? `\n${detailedSections}\n`
      : ""
}${supportLine}`;

  const files: Record<string, string> = {
    "SKILL.md": `${skillBody.trimEnd()}\n`,
  };
  if (splitReference) {
    files["references/commands.md"] =
      `# ${safeDisplay} CLI Command Reference (\`${config.binaryName}\`)\n\n${detailedSections}\n`;
  }
  return Object.freeze(files);
}

function computeSurfaceDigest(files: Readonly<Record<string, string>>): string {
  const canonical = Object.entries(files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, content]) => `${name}\u0000${sha256(content)}`)
    .join("\n");
  return `sha256:${sha256(canonical)}`;
}

async function entryState(path: string): Promise<"missing" | "file" | "other"> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return "other";
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
  workspaceRoot: string,
): Promise<boolean> {
  const rootRel = portablePath(relative(workspaceRoot, skillRoot));
  const segments = [
    ...rootRel.split("/").filter(Boolean),
    ...managedPath.split("/").slice(0, -1),
  ];
  let current = workspaceRoot;
  for (const part of segments) {
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

function parseManifest(
  source: string,
  expectedBinary: string,
): CustomerSkillManifest {
  const parsed = JSON.parse(source) as Partial<CustomerSkillManifest>;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.binaryName !== expectedBinary ||
    typeof parsed.cliVersion !== "string" ||
    !parsed.cliVersion ||
    typeof parsed.surfaceDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(parsed.surfaceDigest) ||
    typeof parsed.files !== "object" ||
    parsed.files === null ||
    Array.isArray(parsed.files)
  ) {
    throw new Error(
      "The managed CLI skill manifest is invalid or unsupported.",
    );
  }
  for (const [path, entry] of Object.entries(parsed.files)) {
    assertManagedRelativePath(path);
    if (!entry || !/^[0-9a-f]{64}$/u.test(entry.sha256 ?? "")) {
      throw new Error(`The manifest hash for '${path}' is invalid.`);
    }
  }
  return parsed as CustomerSkillManifest;
}

async function listUnmanagedEntries(
  skillRoot: string,
  desired: ReadonlySet<string>,
): Promise<string[]> {
  try {
    const rootStat = await lstat(skillRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return [skillRoot];
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const unmanaged: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        unmanaged.push(full);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const rel = portablePath(relative(skillRoot, full));
      if (rel === CUSTOMER_SKILL_MANIFEST_NAME) continue;
      if (!entry.isFile() || !desired.has(rel)) {
        unmanaged.push(full);
      }
    }
  }
  await walk(skillRoot);
  return unmanaged;
}

function targetRootDirectory(
  workspaceRoot: string,
  target: "agents" | "claude",
  binaryName: string,
): string {
  return target === "agents"
    ? join(workspaceRoot, ".agents", "skills", binaryName)
    : join(workspaceRoot, ".claude", "skills", binaryName);
}

interface SingleTargetPlan {
  readonly state: CustomerSkillPlan["state"];
  readonly installedVersion?: string;
  readonly files: PlannedCustomerSkillFile[];
  readonly message?: string;
}

async function planSingleTarget(options: {
  action: CustomerSkillAction;
  workspaceRoot: string;
  target: "agents" | "claude";
  config: BrandedCliConfig;
  desiredFiles: Readonly<Record<string, string>>;
  surfaceDigest: string;
}): Promise<SingleTargetPlan> {
  const skillRoot = targetRootDirectory(
    options.workspaceRoot,
    options.target,
    options.config.binaryName,
  );
  const manifestPath = join(skillRoot, CUSTOMER_SKILL_MANIFEST_NAME);
  const files: PlannedCustomerSkillFile[] = [];

  const desiredManifest: CustomerSkillManifest = {
    schemaVersion: 1,
    binaryName: options.config.binaryName,
    cliVersion: options.config.version,
    surfaceDigest: options.surfaceDigest,
    files: Object.fromEntries(
      Object.entries(options.desiredFiles)
        .sort(([l], [r]) => l.localeCompare(r))
        .map(([name, content]) => [name, { sha256: sha256(content) }]),
    ),
  };
  const desiredManifestText = `${JSON.stringify(desiredManifest, null, 2)}\n`;

  const manifestEntryState = await entryState(manifestPath);
  if (manifestEntryState === "other") {
    return {
      state: "blocked",
      files: [
        {
          path: manifestPath,
          relativePath: portablePath(
            relative(options.workspaceRoot, manifestPath),
          ),
          target: options.target,
          kind: "manifest",
          status: "conflict",
          reason: "The managed skill manifest path is not a regular file.",
        },
      ],
      message:
        "The managed skill manifest cannot be trusted. Repair or remove the skill directory before continuing.",
    };
  }

  if (manifestEntryState === "missing") {
    if (options.action === "status" || options.action === "update") {
      return {
        state: "not_installed",
        files: [],
        message: `The ${options.config.displayName} agent skill is not installed in .${options.target}/skills/${options.config.binaryName}.`,
      };
    }

    const desiredSet = new Set(Object.keys(options.desiredFiles));
    for (const badPath of await listUnmanagedEntries(skillRoot, desiredSet)) {
      files.push({
        path: badPath,
        relativePath: portablePath(relative(options.workspaceRoot, badPath)),
        target: options.target,
        kind: "skill",
        status: "conflict",
        reason: "The target skill directory contains an unmanaged entry.",
      });
    }

    for (const [name, content] of Object.entries(options.desiredFiles).sort(
      ([l], [r]) => l.localeCompare(r),
    )) {
      const fullPath = join(skillRoot, ...name.split("/"));
      if (await hasUnsafeParent(skillRoot, name, options.workspaceRoot)) {
        files.push({
          path: fullPath,
          relativePath: portablePath(relative(options.workspaceRoot, fullPath)),
          target: options.target,
          kind: "skill",
          status: "conflict",
          reason:
            "A managed skill path has a non-directory or symbolic parent.",
        });
        continue;
      }
      const st = await entryState(fullPath);
      if (st === "missing") {
        files.push({
          path: fullPath,
          relativePath: portablePath(relative(options.workspaceRoot, fullPath)),
          target: options.target,
          kind: "skill",
          status: "create",
          content,
        });
      } else if (
        st === "file" &&
        (await readFile(fullPath, "utf8")) === content
      ) {
        files.push({
          path: fullPath,
          relativePath: portablePath(relative(options.workspaceRoot, fullPath)),
          target: options.target,
          kind: "skill",
          status: "unchanged",
        });
      } else {
        files.push({
          path: fullPath,
          relativePath: portablePath(relative(options.workspaceRoot, fullPath)),
          target: options.target,
          kind: "skill",
          status: "conflict",
          reason: "A different unmanaged file already exists at this path.",
        });
      }
    }

    files.push({
      path: manifestPath,
      relativePath: portablePath(relative(options.workspaceRoot, manifestPath)),
      target: options.target,
      kind: "manifest",
      status: "create",
      content: desiredManifestText,
    });

    const hasConflict = files.some((f) => f.status === "conflict");
    return {
      state: hasConflict ? "modified" : "ready",
      files,
      ...(hasConflict
        ? {
            message:
              "Resolve the listed skill file conflicts before installing.",
          }
        : {}),
    };
  }

  const manifestSource = await readFile(manifestPath, "utf8");
  let manifest: CustomerSkillManifest;
  try {
    manifest = parseManifest(manifestSource, options.config.binaryName);
  } catch (error) {
    return {
      state: "blocked",
      files: [
        {
          path: manifestPath,
          relativePath: portablePath(
            relative(options.workspaceRoot, manifestPath),
          ),
          target: options.target,
          kind: "manifest",
          status: "conflict",
          reason:
            error instanceof Error ? error.message : "Invalid skill manifest.",
        },
      ],
      message:
        "The managed skill manifest cannot be trusted. Repair or remove the skill directory before continuing.",
    };
  }

  const allNames = new Set([
    ...Object.keys(manifest.files),
    ...Object.keys(options.desiredFiles),
  ]);
  for (const name of [...allNames].sort()) {
    const fullPath = join(skillRoot, ...name.split("/"));
    if (await hasUnsafeParent(skillRoot, name, options.workspaceRoot)) {
      files.push({
        path: fullPath,
        relativePath: portablePath(relative(options.workspaceRoot, fullPath)),
        target: options.target,
        kind: "skill",
        status: "conflict",
        reason: "A managed skill path has a non-directory or symbolic parent.",
      });
      continue;
    }
    const previousHash = manifest.files[name]?.sha256;
    const nextContent = options.desiredFiles[name];
    const nextHash =
      nextContent === undefined ? undefined : sha256(nextContent);
    const st = await entryState(fullPath);

    if (st !== "file") {
      if (!previousHash && st === "missing" && nextContent !== undefined) {
        files.push({
          path: fullPath,
          relativePath: portablePath(relative(options.workspaceRoot, fullPath)),
          target: options.target,
          kind: "skill",
          status: "create",
          content: nextContent,
        });
      } else {
        files.push({
          path: fullPath,
          relativePath: portablePath(relative(options.workspaceRoot, fullPath)),
          target: options.target,
          kind: "skill",
          status: "conflict",
          reason:
            st === "missing"
              ? "A managed skill file is missing."
              : "A managed skill path is not a regular file.",
        });
      }
      continue;
    }

    const currentContent = await readFile(fullPath, "utf8");
    const currentHash = sha256(currentContent);
    if (!previousHash) {
      files.push({
        path: fullPath,
        relativePath: portablePath(relative(options.workspaceRoot, fullPath)),
        target: options.target,
        kind: "skill",
        status: currentHash === nextHash ? "unchanged" : "conflict",
        ...(currentHash === nextHash
          ? {}
          : {
              reason: "A different unmanaged file occupies a new skill path.",
            }),
      });
      continue;
    }

    if (nextContent === undefined) {
      files.push({
        path: fullPath,
        relativePath: portablePath(relative(options.workspaceRoot, fullPath)),
        target: options.target,
        kind: "skill",
        status: currentHash === previousHash ? "delete" : "conflict",
        ...(currentHash === previousHash
          ? {}
          : {
              reason: "A managed skill file was edited and cannot be removed.",
            }),
      });
      continue;
    }

    if (currentHash === nextHash) {
      files.push({
        path: fullPath,
        relativePath: portablePath(relative(options.workspaceRoot, fullPath)),
        target: options.target,
        kind: "skill",
        status: "unchanged",
      });
    } else if (currentHash === previousHash) {
      files.push({
        path: fullPath,
        relativePath: portablePath(relative(options.workspaceRoot, fullPath)),
        target: options.target,
        kind: "skill",
        status: "update",
        content: nextContent,
      });
    } else {
      files.push({
        path: fullPath,
        relativePath: portablePath(relative(options.workspaceRoot, fullPath)),
        target: options.target,
        kind: "skill",
        status: "conflict",
        reason: "The managed skill file has local edits.",
      });
    }
  }

  files.push({
    path: manifestPath,
    relativePath: portablePath(relative(options.workspaceRoot, manifestPath)),
    target: options.target,
    kind: "manifest",
    status: manifestSource === desiredManifestText ? "unchanged" : "update",
    ...(manifestSource === desiredManifestText
      ? {}
      : { content: desiredManifestText }),
  });

  const hasConflict = files.some((f) => f.status === "conflict");
  const hasChange = files.some((f) =>
    ["create", "update", "delete"].includes(f.status),
  );
  return {
    state: hasConflict
      ? "modified"
      : hasChange ||
          manifest.cliVersion !== options.config.version ||
          manifest.surfaceDigest !== options.surfaceDigest
        ? "update_available"
        : "current",
    installedVersion: manifest.cliVersion,
    files,
    ...(hasConflict
      ? {
          message:
            "Local edits conflict with the managed skill. No files will be overwritten.",
        }
      : {}),
  };
}

export async function planCustomerSkill(options: {
  action: CustomerSkillAction;
  workspaceRoot: string;
  target: CustomerSkillTarget;
  config: BrandedCliConfig;
  capabilities: readonly CliCapability[];
  tokenEnvVar: string;
}): Promise<CustomerSkillPlan> {
  const workspaceRoot = resolve(options.workspaceRoot);
  const desiredFiles = synthesizeCustomerSkillFiles(
    options.config,
    options.capabilities,
    options.tokenEnvVar,
  );
  const surfaceDigest = computeSurfaceDigest(desiredFiles);
  const targets: ReadonlyArray<"agents" | "claude"> =
    options.target === "both" ? ["agents", "claude"] : [options.target];

  const subPlans: SingleTargetPlan[] = [];
  for (const singleTarget of targets) {
    subPlans.push(
      await planSingleTarget({
        action: options.action,
        workspaceRoot,
        target: singleTarget,
        config: options.config,
        desiredFiles,
        surfaceDigest,
      }),
    );
  }

  const allFiles = subPlans.flatMap((p) => p.files);
  const installedVersion = subPlans.find(
    (p) => p.installedVersion,
  )?.installedVersion;

  let combinedState: CustomerSkillPlan["state"];
  if (subPlans.some((p) => p.state === "blocked")) {
    combinedState = "blocked";
  } else if (subPlans.some((p) => p.state === "modified")) {
    combinedState = "modified";
  } else if (subPlans.every((p) => p.state === "not_installed")) {
    combinedState = "not_installed";
  } else if (subPlans.every((p) => p.state === "current")) {
    combinedState = "current";
  } else if (
    options.action === "install" &&
    subPlans.some((p) => p.state === "ready")
  ) {
    combinedState = "ready";
  } else if (
    subPlans.some(
      (p) => p.state === "update_available" || p.state === "not_installed",
    )
  ) {
    combinedState =
      options.action === "update" &&
      subPlans.some((p) => p.state === "not_installed") &&
      !subPlans.some((p) => p.state === "update_available")
        ? "not_installed"
        : "update_available";
  } else {
    combinedState = "ready";
  }

  const message = subPlans.find((p) => p.message)?.message;
  return {
    action: options.action,
    target: options.target,
    workspaceRoot,
    cliVersion: options.config.version,
    ...(installedVersion ? { installedVersion } : {}),
    surfaceDigest,
    state: combinedState,
    files: allFiles,
    ...(message ? { message } : {}),
  };
}

let tempCounter = 0;

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.chumbo-${process.pid}-${tempCounter++}.tmp`,
  );
  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function applyCustomerSkillPlan(
  plan: CustomerSkillPlan,
): Promise<void> {
  const conflicts = plan.files.filter((file) => file.status === "conflict");
  if (conflicts.length > 0 || plan.state === "blocked") {
    throw new Error(
      `Refusing to overwrite modified skill files:\n${conflicts
        .map((file) => `- ${file.relativePath}: ${file.reason ?? "conflict"}`)
        .join("\n")}`,
    );
  }

  for (const file of plan.files) {
    if (
      file.kind === "manifest" ||
      !["create", "update"].includes(file.status)
    ) {
      continue;
    }
    if (file.content === undefined) {
      throw new Error(`No content planned for ${file.relativePath}`);
    }
    await atomicWrite(file.path, file.content);
  }

  for (const file of plan.files) {
    if (file.status === "delete") {
      await rm(file.path, { force: true });
    }
  }

  for (const manifest of plan.files.filter((f) => f.kind === "manifest")) {
    if (
      ["create", "update"].includes(manifest.status) &&
      manifest.content !== undefined
    ) {
      await atomicWrite(manifest.path, manifest.content);
    }
  }
}

function skillUsage(config: BrandedCliConfig): string {
  return `${config.displayName} CLI agent skill

Usage:
  ${config.binaryName} skill install [options]  Install the ${config.displayName} CLI agent skill
  ${config.binaryName} skill status [options]   Inspect installed skill files without writing
  ${config.binaryName} skill update [options]   Safely update unmodified skill files

Options:
  --target <target>  agents (.agents/skills/${config.binaryName}), claude (.claude/skills/${config.binaryName}), or both (default: agents)
  --dir <path>       Workspace root directory (default: current working directory)
  --refresh          Refresh MCP capability discovery before synthesizing the skill
  --plan             Review proposed skill files without writing
  --yes              Apply without interactive confirmation
  --json             Stable machine-readable receipt; never prompts`;
}

interface ParsedSkillArgs {
  readonly help: boolean;
  readonly action?: CustomerSkillAction;
  readonly target: CustomerSkillTarget;
  readonly dir?: string;
  readonly refresh: boolean;
  readonly plan: boolean;
  readonly yes: boolean;
  readonly json: boolean;
}

function parseSkillArgs(argv: readonly string[]): ParsedSkillArgs {
  let help = false;
  let action: CustomerSkillAction | undefined;
  let target: CustomerSkillTarget = "agents";
  let dir: string | undefined;
  let refresh = false;
  let plan = false;
  let yes = false;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--refresh") {
      refresh = true;
      continue;
    }
    if (token === "--plan") {
      plan = true;
      continue;
    }
    if (token === "--yes" || token === "-y") {
      yes = true;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--target") {
      const val = argv[++i];
      if (!val || !["agents", "claude", "both"].includes(val)) {
        throw new TypeError("--target must be one of: agents, claude, both");
      }
      target = val as CustomerSkillTarget;
      continue;
    }
    if (token === "--dir") {
      const val = argv[++i];
      if (!val) throw new TypeError("--dir requires a directory path");
      dir = val;
      continue;
    }
    if (token.startsWith("-")) {
      throw new TypeError(`Unknown skill option: ${token}`);
    }
    if (!action && ["install", "status", "update"].includes(token)) {
      action = token as CustomerSkillAction;
      continue;
    }
    throw new TypeError(
      "Use `skill install`, `skill status`, or `skill update`.",
    );
  }

  return { help, action, target, dir, refresh, plan, yes, json };
}

function formatPlanLines(plan: CustomerSkillPlan): string {
  return plan.files
    .map(
      (f) =>
        `${f.status.padEnd(9)} ${f.relativePath}${f.reason ? ` – ${f.reason}` : ""}`,
    )
    .join("\n");
}

function nextSkillCommand(
  binaryName: string,
  action: CustomerSkillAction,
  target: CustomerSkillTarget,
  state: CustomerSkillPlan["state"],
  needsConfirmation: boolean,
): string | undefined {
  const targetFlag = target === "agents" ? "" : ` --target ${target}`;
  if (needsConfirmation) {
    return `${binaryName} skill ${action}${targetFlag} --yes --json`;
  }
  if (state === "not_installed") {
    return `${binaryName} skill install${targetFlag} --yes --json`;
  }
  if (state === "update_available") {
    return `${binaryName} skill update${targetFlag} --yes --json`;
  }
  return undefined;
}

export async function runCustomerSkillCommand(input: {
  readonly argv: readonly string[];
  readonly config: BrandedCliConfig;
  readonly tokenEnvVar: string;
  readonly io: BrandedCliIo;
  readonly cwd: string;
  readonly loadCapabilities: (
    refresh: boolean,
  ) => Promise<readonly CliCapability[]>;
}): Promise<number> {
  const parsed = parseSkillArgs(input.argv);
  if (parsed.help) {
    input.io.stdout(skillUsage(input.config));
    return 0;
  }
  if (!parsed.action) {
    throw new TypeError(
      `Use '${input.config.binaryName} skill install', '${input.config.binaryName} skill status', or '${input.config.binaryName} skill update'.`,
    );
  }

  const workspaceRoot = parsed.dir ? resolve(input.cwd, parsed.dir) : input.cwd;
  const capabilities = await input.loadCapabilities(parsed.refresh);
  let plan = await planCustomerSkill({
    action: parsed.action,
    workspaceRoot,
    target: parsed.target,
    config: input.config,
    capabilities,
    tokenEnvVar: input.tokenEnvVar,
  });

  const buildReport = (
    status: string,
    message = plan.message,
    needsConfirmation = false,
  ) => {
    const nextCommand = nextSkillCommand(
      input.config.binaryName,
      parsed.action!,
      parsed.target,
      plan.state,
      needsConfirmation,
    );
    return {
      ok: !["blocked", "modified"].includes(status),
      schemaVersion: 1 as const,
      command: "skill" as const,
      action: parsed.action!,
      target: parsed.target,
      status,
      workspaceRoot: plan.workspaceRoot,
      cliVersion: plan.cliVersion,
      ...(plan.installedVersion
        ? { installedVersion: plan.installedVersion }
        : {}),
      surfaceDigest: plan.surfaceDigest,
      files: plan.files.map((f) => ({
        path: f.relativePath,
        target: f.target,
        kind: f.kind,
        status: f.status,
        ...(f.reason ? { reason: f.reason } : {}),
      })),
      ...(message ? { message } : {}),
      ...(nextCommand ? { nextCommand } : {}),
    };
  };

  // Terminal read-only / conflict / no-op states
  const terminalStatus =
    plan.state === "blocked"
      ? "blocked"
      : plan.state === "modified"
        ? "modified"
        : plan.state === "not_installed"
          ? "not_installed"
          : parsed.action === "install" && plan.state === "update_available"
            ? "update_available"
            : parsed.action === "status"
              ? plan.state === "ready"
                ? "not_installed"
                : plan.state
              : plan.state === "current"
                ? "current"
                : undefined;

  if (terminalStatus) {
    if (parsed.json) {
      input.io.stdout(JSON.stringify(buildReport(terminalStatus)));
    } else if (terminalStatus === "current") {
      input.io.stdout(
        `${input.config.displayName} skill (${input.config.version}) is current.`,
      );
    } else if (terminalStatus === "not_installed") {
      input.io.stdout(
        `The ${input.config.displayName} skill is not installed.\nRun: ${input.config.binaryName} skill install`,
      );
    } else if (terminalStatus === "update_available") {
      input.io.stdout(
        `An updated ${input.config.displayName} skill is available.\nRun: ${input.config.binaryName} skill update`,
      );
    } else {
      if (plan.files.length > 0) {
        input.io.stderr(`Proposed skill files:\n${formatPlanLines(plan)}`);
      }
      input.io.stderr(
        plan.message ?? "Skill installation blocked by local edits.",
      );
    }
    return ["blocked", "modified"].includes(terminalStatus) ? 1 : 0;
  }

  if (parsed.plan) {
    const message = "Proposed files are ready to review. No files changed.";
    if (parsed.json) {
      input.io.stdout(JSON.stringify(buildReport("planned", message)));
    } else {
      input.io.stdout(
        `Proposed skill files:\n${formatPlanLines(plan)}\n\n${message}`,
      );
    }
    return 0;
  }

  if (parsed.json && !parsed.yes) {
    const message = "Review the proposed skill files, then rerun with --yes.";
    input.io.stdout(
      JSON.stringify(buildReport("needs_confirmation", message, true)),
    );
    return 0;
  }

  if (!parsed.yes) {
    if (!input.io.isTTY) {
      input.io.stderr(
        "No skill files changed. Re-run with --yes for non-interactive use.",
      );
      return 1;
    }
    input.io.stdout(`Proposed skill files:\n${formatPlanLines(plan)}`);
    const confirmed = await input.io.confirm("Apply this skill plan?");
    if (!confirmed) {
      input.io.stderr("No skill files changed.");
      return 1;
    }
  }

  await applyCustomerSkillPlan(plan);
  plan = await planCustomerSkill({
    action: "status",
    workspaceRoot,
    target: parsed.target,
    config: input.config,
    capabilities,
    tokenEnvVar: input.tokenEnvVar,
  });
  if (plan.state !== "current") {
    throw new Error("Skill files were written but verification did not pass.");
  }

  if (parsed.json) {
    input.io.stdout(JSON.stringify(buildReport("complete")));
  } else {
    input.io.stdout(
      `Installed ${input.config.displayName} skill (${input.config.version}).`,
    );
  }
  return 0;
}
