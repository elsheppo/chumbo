import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type {
  BrandedCliAuthMode,
  BrandedCliConfig,
  BrandedCliDependencies,
} from "./cli-host.js";

function defaultTokenEnvVar(binaryName: string): string {
  return `${binaryName.replaceAll("-", "_").toUpperCase()}_TOKEN`;
}
import {
  BRANDED_CLI_MANIFEST_PATH,
  packBrandedCliSourceTarball,
  planBrandedCliPackage,
  renderBrandedCliPackage,
  type BrandedCliDirectorySnapshot,
  type BrandedCliFileRole,
  type BrandedCliFileStatus,
  type BrandedCliPackageFiles,
  type BrandedCliPackagePlan,
  type RenderBrandedCliPackageOptions,
} from "./cli-package.js";
import {
  findPackageProject,
  findSupabaseProject,
  PACKAGE_VERSION,
  resolveTargetLocalEndpoint,
} from "./project.js";
import {
  detectGeneratedScaffold,
  detectLinkedProjectRef,
  endpointFor,
  normalizePublicUrl,
} from "./setup.js";

export const CLI_COMMAND_HELP = `Create a project CLI

Usage:
  chumbo cli init [options]    Create or safely update a project CLI package
  chumbo cli status [options]  Inspect project CLI source state without writing
  chumbo cli render [options]  Emit proposed CLI files as JSON or a .tgz archive
  chumbo cli try [options] [-- <args...>]
                               Run the project CLI in-process against an MCP connection

CLI options:
  --bin <name>            Command people will run (lowercase kebab-case, e.g. acme)
  --package <name>        npm package name (default: @<repo-scope>/<bin>-cli or <bin>-cli)
  --display-name <name>   Product display name (default: repository or MCP server name)
  --cli-version <semver>  CLI package version (default: existing version or 0.1.0)
  --url <url>             MCP connection URL (auto-discovered from public URL or project)
  --public-url <url>      Clean public MCP URL (alias for --url)
  --project-ref <ref>     Supabase project ref used for endpoint discovery
  --dir <path>            Package directory (default: packages/<bin>-cli or <bin>-cli)
  --license <spdx>        npm license expression (default: repo license or MIT)
  --access <policy>       npm publishConfig access: public or restricted
  --support-url <url>     Support URL shown in <bin> --help and README
  --powered-by <label>    Optional attribution line (omitted by default)
  --auth-mode <mode>      CLI auth mode: oauth (default), token, public, or auto
  --token-env <VAR>       Headless token env var name (default: <BIN>_TOKEN)
  --out-tgz <path>        Write a portable .tgz source archive (for \`cli render\`)
  --function <name>       Local MCP function used for endpoint discovery (default: mcp)
  --plan                  Review proposed files without writing
  --yes, -y               Apply safe changes without interactive confirmation
  --json                  Stable machine-readable receipt; never prompts
  --help                  Show this help
`;

export interface ChumboCliCommandJsonReport {
  readonly schemaVersion: 1;
  readonly command: "cli init" | "cli status" | "cli render" | "cli try";
  readonly status:
    | "planned"
    | "needs_confirmation"
    | "complete"
    | "current"
    | "safe_update"
    | "adopt"
    | "not_created"
    | "needs_decision"
    | "blocked";
  readonly stateLabel: string;
  readonly projectRoot: string;
  readonly packageDir: string;
  readonly config?: BrandedCliConfig;
  readonly tokenEnvVar?: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly role: BrandedCliFileRole;
    readonly status: BrandedCliFileStatus;
    readonly reason?: string;
  }>;
  readonly renderedFiles?: BrandedCliPackageFiles;
  readonly archivePath?: string;
  readonly archiveBytes?: number;
  readonly forwardedArgv?: readonly string[];
  readonly message: string;
  readonly recovery?: string;
  readonly nextCommand?: string;
}

export interface CliCommandIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly isTTY: boolean;
  readonly confirm: (question: string) => Promise<boolean>;
}

export interface CliCommandRuntimeOptions {
  readonly cwd?: string;
  readonly io?: Partial<CliCommandIo>;
  readonly fetch?: typeof globalThis.fetch;
  readonly brandedCliDependencies?: BrandedCliDependencies;
}

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/u;
const SUPABASE_FUNCTION_PATH = /^\/functions\/v1\/[a-z0-9][a-z0-9_-]{0,127}$/u;
const PROBE_TIMEOUT_MS = 3_000;

function defaultIo(): CliCommandIo {
  return {
    stdout(value) {
      process.stdout.write(`${value}\n`);
    },
    stderr(value) {
      process.stderr.write(`${value}\n`);
    },
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    async confirm(question) {
      if (!process.stdin.isTTY) return false;
      const reader = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        const answer = await reader.question(`${question} [y/N] `);
        return /^(?:y|yes)$/iu.test(answer.trim());
      } finally {
        reader.close();
      }
    },
  };
}

export function splitArgsAtDoubleDash(rawArgs: readonly string[]): {
  readonly hostArgs: readonly string[];
  readonly forwardedArgs: readonly string[];
  readonly hasDoubleDash: boolean;
} {
  const index = rawArgs.indexOf("--");
  if (index === -1) {
    return {
      hostArgs: rawArgs,
      forwardedArgs: [],
      hasDoubleDash: false,
    };
  }
  return {
    hostArgs: rawArgs.slice(0, index),
    forwardedArgs: rawArgs.slice(index + 1),
    hasDoubleDash: true,
  };
}

function portablePath(value: string): string {
  return value.split(sep).join("/");
}

function slugifyBinaryName(raw: string): string {
  const cleaned = raw
    .normalize("NFKD")
    .toLowerCase()
    .replace(/^@[^/]+\//u, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return /^[a-z]/u.test(cleaned) ? cleaned : "app-cli";
}

function humanizeDisplayName(raw: string): string {
  const words = raw
    .replace(/^@[^/]+\//u, "")
    .replace(/[-_]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (words.length === 0) return "Project";
  return words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
}

function parseCliSubcommandArgs(hostArgs: readonly string[]) {
  return parseArgs({
    args: [...hostArgs],
    allowPositionals: true,
    strict: true,
    options: {
      access: { type: "string" },
      "auth-mode": { type: "string" },
      bin: { type: "string" },
      "cli-version": { type: "string" },
      dir: { type: "string" },
      "display-name": { type: "string" },
      function: { type: "string" },
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      license: { type: "string" },
      "out-tgz": { type: "string" },
      package: { type: "string" },
      plan: { type: "boolean" },
      "powered-by": { type: "string" },
      "project-ref": { type: "string" },
      "public-url": { type: "string" },
      "support-url": { type: "string" },
      "token-env": { type: "string" },
      url: { type: "string" },
      yes: { type: "boolean", short: "y" },
    },
  });
}

async function statKind(
  path: string,
): Promise<"missing" | "file" | "dir" | "other"> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return "other";
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "dir";
    return "other";
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

async function resolveProjectRoot(cwd: string): Promise<{
  readonly root: string;
  readonly hasSupabase: boolean;
}> {
  try {
    const root = await findSupabaseProject(cwd);
    return { root, hasSupabase: true };
  } catch {
    /* not a Supabase repository */
  }
  try {
    const root = await findPackageProject(cwd);
    return { root, hasSupabase: false };
  } catch {
    return { root: resolve(cwd), hasSupabase: false };
  }
}

async function readRootPackageMetadata(root: string): Promise<{
  readonly name?: string;
  readonly scope?: string;
  readonly license?: string;
}> {
  try {
    const raw = await readFile(join(root, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const name = typeof parsed.name === "string" ? parsed.name : undefined;
    const scopeMatch = name ? /^(@[a-z0-9][a-z0-9._-]*)\//u.exec(name) : null;
    const license =
      typeof parsed.license === "string" && parsed.license.trim()
        ? parsed.license.trim()
        : undefined;
    return {
      ...(name ? { name } : {}),
      ...(scopeMatch?.[1] ? { scope: scopeMatch[1] } : {}),
      ...(license ? { license } : {}),
    };
  } catch {
    return {};
  }
}

function extractConfigFromEntrypoint(
  source: string,
): Partial<BrandedCliConfig> | undefined {
  const marker = "await runBrandedCli(";
  const start = source.indexOf(marker);
  if (start === -1) return undefined;
  const openBrace = source.indexOf("{", start + marker.length);
  if (openBrace === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let endBrace = -1;
  for (let i = openBrace; i < source.length; i += 1) {
    const ch = source[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        endBrace = i;
        break;
      }
    }
  }
  if (endBrace === -1) return undefined;
  try {
    const parsed = JSON.parse(source.slice(openBrace, endBrace + 1)) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    return parsed as Partial<BrandedCliConfig>;
  } catch {
    return undefined;
  }
}

async function discoverExistingCliDirectory(
  projectRoot: string,
  requestedBin?: string,
): Promise<string | undefined> {
  const candidates: string[] = [];
  const packagesDir = join(projectRoot, "packages");
  if ((await statKind(packagesDir)) === "dir") {
    for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.push(join(packagesDir, entry.name));
      }
    }
  }
  for (const entry of await readdir(projectRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith("-cli")) {
      candidates.push(join(projectRoot, entry.name));
    }
  }
  candidates.push(projectRoot);

  const matches: Array<{ dir: string; binaryName?: string }> = [];
  for (const dir of candidates) {
    const manifestPath = join(dir, ...BRANDED_CLI_MANIFEST_PATH.split("/"));
    if ((await statKind(manifestPath)) !== "file") continue;
    try {
      const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as {
        binaryName?: unknown;
      };
      const binaryName =
        typeof parsed.binaryName === "string" ? parsed.binaryName : undefined;
      if (!requestedBin || binaryName === requestedBin) {
        matches.push({ dir, binaryName });
      }
    } catch {
      if (!requestedBin) {
        matches.push({ dir });
      }
    }
  }
  if (matches.length === 1) return matches[0]!.dir;
  return undefined;
}

async function readDirectorySnapshot(
  packageDir: string,
  projectRoot: string,
): Promise<BrandedCliDirectorySnapshot> {
  const files: Record<
    string,
    string | null | { readonly kind: "non-regular" }
  > = {};
  const basePaths = [
    "package.json",
    "bin/cli.js",
    "README.md",
    BRANDED_CLI_MANIFEST_PATH,
  ];

  const readOne = async (rel: string): Promise<void> => {
    const full = join(packageDir, ...rel.split("/"));
    const kind = await statKind(full);
    if (kind === "missing") {
      files[rel] = null;
    } else if (kind === "file") {
      files[rel] = await readFile(full, "utf8");
    } else {
      files[rel] = { kind: "non-regular" };
    }
  };

  for (const rel of basePaths) {
    await readOne(rel);
  }

  // Also read any extra managedFiles recorded in an existing `.chumbo/cli-manifest.json`
  const rawManifest = files[BRANDED_CLI_MANIFEST_PATH];
  if (typeof rawManifest === "string") {
    try {
      const parsed = JSON.parse(rawManifest) as {
        managedFiles?: Record<string, unknown>;
      };
      if (
        parsed.managedFiles &&
        typeof parsed.managedFiles === "object" &&
        !Array.isArray(parsed.managedFiles)
      ) {
        for (const rel of Object.keys(parsed.managedFiles)) {
          if (
            !(rel in files) &&
            !rel.startsWith("/") &&
            !rel.includes("\\") &&
            !rel.split("/").some((s) => !s || s === "..")
          ) {
            await readOne(rel);
          }
        }
      }
    } catch {
      /* invalid manifest is handled fail-closed by planBrandedCliPackage */
    }
  }

  return {
    files,
    isApplicationRoot: resolve(packageDir) === resolve(projectRoot),
  };
}

function isSupabaseFunctionEndpoint(url: URL): boolean {
  const hostMatch = /^([a-z0-9]{20})\.supabase\.co$/u.exec(url.hostname);
  return (
    url.protocol === "https:" &&
    hostMatch !== null &&
    PROJECT_REF_PATTERN.test(hostMatch[1]!) &&
    url.port === "" &&
    SUPABASE_FUNCTION_PATH.test(url.pathname)
  );
}

async function probeCanonicalEndpoint(
  rawUrl: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (!isSupabaseFunctionEndpoint(parsed)) return parsed.href;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(parsed, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    const advertised =
      response.headers.get("x-chumbo-resource-url") ??
      response.headers.get("x-supa-mcp-resource-url");
    await response.body?.cancel().catch(() => undefined);
    if (!advertised) return parsed.href;
    const canonical = new URL(advertised);
    if (
      canonical.protocol === "https:" &&
      !canonical.username &&
      !canonical.password &&
      !canonical.search &&
      !canonical.hash
    ) {
      return canonical.href;
    }
    return parsed.href;
  } catch {
    return parsed.href;
  } finally {
    clearTimeout(timer);
  }
}

let tempCounter = 0;

async function atomicWriteFile(
  path: string,
  content: string | Uint8Array,
  executable = false,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.chumbo-${process.pid}-${tempCounter++}.tmp`,
  );
  try {
    await writeFile(tempPath, content);
    if (executable) {
      await chmod(tempPath, 0o755);
    }
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function applyBrandedCliPlan(
  packageDir: string,
  plan: BrandedCliPackagePlan,
): Promise<void> {
  if (plan.state === "needs_decision" || plan.state === "blocked") {
    throw new Error(plan.message);
  }

  for (const file of plan.files) {
    if (
      file.role === "manifest" ||
      !["create", "update"].includes(file.status)
    ) {
      continue;
    }
    if (file.content === undefined) {
      throw new Error(`No content planned for ${file.relativePath}`);
    }
    await atomicWriteFile(
      join(packageDir, ...file.relativePath.split("/")),
      file.content,
      file.executable,
    );
  }

  for (const file of plan.files) {
    if (file.status === "delete") {
      await rm(join(packageDir, ...file.relativePath.split("/")), {
        force: true,
      });
    }
  }

  const manifestFile = plan.files.find((f) => f.role === "manifest");
  if (
    manifestFile &&
    ["create", "update"].includes(manifestFile.status) &&
    manifestFile.content !== undefined
  ) {
    await atomicWriteFile(
      join(packageDir, ...manifestFile.relativePath.split("/")),
      manifestFile.content,
      false,
    );
  }
}

function formatPlanTable(
  plan: BrandedCliPackagePlan,
  projectRoot: string,
  packageDir: string,
): string {
  return plan.files
    .map((file) => {
      const displayPath = portablePath(
        relative(
          projectRoot,
          join(packageDir, ...file.relativePath.split("/")),
        ),
      );
      return `${file.status.padEnd(9)} ${displayPath}${file.reason ? ` – ${file.reason}` : ""}`;
    })
    .join("\n");
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

function buildNextCommand(
  subcommand: "init" | "render",
  values: ReturnType<typeof parseCliSubcommandArgs>["values"],
  resolvedDirRel: string,
): string {
  const parts = ["npx", "chumbo", "cli", subcommand];
  if (values.bin) parts.push("--bin", shellArg(values.bin));
  if (values.package) parts.push("--package", shellArg(values.package));
  if (values["display-name"])
    parts.push("--display-name", shellArg(values["display-name"]));
  if (values["cli-version"])
    parts.push("--cli-version", shellArg(values["cli-version"]));
  if (values.url) parts.push("--url", shellArg(values.url));
  else if (values["public-url"])
    parts.push("--public-url", shellArg(values["public-url"]));
  if (values.dir) parts.push("--dir", shellArg(values.dir));
  else if (subcommand === "init" && resolvedDirRel)
    parts.push("--dir", shellArg(resolvedDirRel));
  if (values.license) parts.push("--license", shellArg(values.license));
  if (values.access) parts.push("--access", shellArg(values.access));
  if (values["auth-mode"])
    parts.push("--auth-mode", shellArg(values["auth-mode"]));
  if (values["token-env"])
    parts.push("--token-env", shellArg(values["token-env"]));
  if (values["out-tgz"]) parts.push("--out-tgz", shellArg(values["out-tgz"]));
  parts.push("--yes", "--json");
  return parts.join(" ");
}

function parseOptionalAuthMode(
  raw: string | undefined,
): BrandedCliAuthMode | undefined {
  if (raw === undefined) return undefined;
  if (!["oauth", "token", "public", "auto"].includes(raw)) {
    throw new Error("--auth-mode must be one of: oauth, token, public, auto");
  }
  return raw as BrandedCliAuthMode;
}

function parseOptionalAccess(
  raw: string | undefined,
): "public" | "restricted" | undefined {
  if (raw === undefined) return undefined;
  if (raw !== "public" && raw !== "restricted") {
    throw new Error("--access must be one of: public, restricted");
  }
  return raw;
}

export async function runCliCommand(
  rawArgs: readonly string[],
  runtimeOptions: CliCommandRuntimeOptions = {},
): Promise<number> {
  const io: CliCommandIo = { ...defaultIo(), ...runtimeOptions.io };
  const cwd = resolve(runtimeOptions.cwd ?? process.cwd());
  const fetchImpl = runtimeOptions.fetch ?? globalThis.fetch;

  const { hostArgs, forwardedArgs } = splitArgsAtDoubleDash(rawArgs);
  const parsed = parseCliSubcommandArgs(hostArgs);
  const machine = Boolean(parsed.values.json);

  if (parsed.values.help || parsed.positionals.length === 0) {
    io.stdout(CLI_COMMAND_HELP.trimEnd());
    return 0;
  }

  const [action, ...extraPositionals] = parsed.positionals;
  if (
    !action ||
    !["init", "status", "render", "try"].includes(action) ||
    extraPositionals.length > 0
  ) {
    throw new Error(
      "Use `chumbo cli init`, `chumbo cli status`, `chumbo cli render`, or `chumbo cli try -- <args...>`.",
    );
  }

  const { root: projectRoot, hasSupabase } = await resolveProjectRoot(cwd);
  const rootMeta = await readRootPackageMetadata(projectRoot);
  const functionName = parsed.values.function ?? "mcp";

  // Locate target package directory
  const discoveredDir = parsed.values.dir
    ? resolve(cwd, parsed.values.dir)
    : await discoverExistingCliDirectory(projectRoot, parsed.values.bin);

  const existingSnapshot = discoveredDir
    ? await readDirectorySnapshot(discoveredDir, projectRoot)
    : undefined;
  const existingEntryConfig =
    typeof existingSnapshot?.files["bin/cli.js"] === "string"
      ? extractConfigFromEntrypoint(existingSnapshot.files["bin/cli.js"])
      : undefined;
  const existingPkg = (() => {
    const raw = existingSnapshot?.files["package.json"];
    if (typeof raw !== "string") return undefined;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  })();

  const binaryName =
    parsed.values.bin ??
    existingEntryConfig?.binaryName ??
    slugifyBinaryName(rootMeta.name ?? basename(projectRoot));

  const packageDir =
    discoveredDir ??
    ((await statKind(join(projectRoot, "packages"))) === "dir"
      ? join(projectRoot, "packages", `${binaryName}-cli`)
      : join(projectRoot, `${binaryName}-cli`));
  const packageDirRel = portablePath(relative(projectRoot, packageDir) || ".");

  const defaultPackageName = rootMeta.scope
    ? `${rootMeta.scope}/${binaryName}-cli`
    : `${binaryName}-cli`;
  const packageName =
    parsed.values.package ??
    existingEntryConfig?.packageName ??
    (typeof existingPkg?.name === "string" &&
    resolve(packageDir) !== resolve(projectRoot)
      ? existingPkg.name
      : defaultPackageName);

  const displayName =
    parsed.values["display-name"] ??
    existingEntryConfig?.displayName ??
    humanizeDisplayName(rootMeta.name ?? binaryName);

  const cliVersion =
    parsed.values["cli-version"] ??
    existingEntryConfig?.version ??
    (typeof existingPkg?.version === "string" &&
    resolve(packageDir) !== resolve(projectRoot)
      ? existingPkg.version
      : "0.1.0");

  // Resolve MCP connection URL
  let endpoint =
    parsed.values.url ??
    (parsed.values["public-url"]
      ? normalizePublicUrl(parsed.values["public-url"])
      : undefined) ??
    existingEntryConfig?.endpoint;

  if (!endpoint) {
    const projectRef =
      parsed.values["project-ref"] ??
      (hasSupabase ? await detectLinkedProjectRef(projectRoot) : undefined);
    endpoint = endpointFor(projectRef, functionName);
  }
  if (!endpoint) {
    const scaffold = await detectGeneratedScaffold(projectRoot, functionName);
    if (scaffold) {
      endpoint = await resolveTargetLocalEndpoint(
        projectRoot,
        functionName,
        scaffold.target,
      );
    } else if (hasSupabase) {
      endpoint = await resolveTargetLocalEndpoint(
        projectRoot,
        functionName,
        "edge-function",
      );
    }
  }

  if (endpoint && action !== "try") {
    endpoint = await probeCanonicalEndpoint(endpoint, fetchImpl);
  }

  const authMode =
    parseOptionalAuthMode(parsed.values["auth-mode"]) ??
    existingEntryConfig?.auth?.mode;
  const tokenEnvVarOverride =
    parsed.values["token-env"] ?? existingEntryConfig?.auth?.tokenEnvVar;
  const headerName = existingEntryConfig?.auth?.headerName;
  const authConfig =
    authMode || tokenEnvVarOverride || headerName
      ? {
          ...(authMode ? { mode: authMode } : {}),
          ...(tokenEnvVarOverride ? { tokenEnvVar: tokenEnvVarOverride } : {}),
          ...(headerName ? { headerName } : {}),
        }
      : undefined;

  const supportUrl =
    parsed.values["support-url"] ?? existingEntryConfig?.supportUrl;
  const poweredBy =
    parsed.values["powered-by"] ?? existingEntryConfig?.poweredBy;
  const resolvedTokenEnvVar =
    tokenEnvVarOverride ?? defaultTokenEnvVar(binaryName);

  const renderOptions: RenderBrandedCliPackageOptions = {
    chumboVersion: `^${PACKAGE_VERSION}`,
    license:
      parsed.values.license ??
      (typeof existingPkg?.license === "string"
        ? existingPkg.license
        : (rootMeta.license ?? "MIT")),
    ...(parseOptionalAccess(parsed.values.access)
      ? { access: parseOptionalAccess(parsed.values.access) }
      : {}),
  };

  // --- `chumbo cli try` ---
  if (action === "try") {
    if (!endpoint) {
      throw new Error(
        "No MCP connection URL found. Pass --url <https-or-loopback-url> to run `chumbo cli try`.",
      );
    }
    const config: BrandedCliConfig = {
      packageName,
      binaryName,
      displayName,
      version: cliVersion,
      endpoint,
      ...(supportUrl ? { supportUrl } : {}),
      ...(poweredBy ? { poweredBy } : {}),
      ...(authConfig ? { auth: authConfig } : {}),
    };

    const effectiveForwarded =
      forwardedArgs.length > 0
        ? machine &&
          !parsed.values.plan &&
          !forwardedArgs.includes("--json") &&
          !forwardedArgs.includes("--help")
          ? [...forwardedArgs, "--json"]
          : [...forwardedArgs]
        : ["--help"];

    if (parsed.values.plan) {
      const report: ChumboCliCommandJsonReport = {
        schemaVersion: 1,
        command: "cli try",
        status: "planned",
        stateLabel: "Proposed CLI invocation",
        projectRoot,
        packageDir: packageDirRel,
        config,
        tokenEnvVar: resolvedTokenEnvVar,
        files: [],
        forwardedArgv: effectiveForwarded,
        message: "No network requests were made.",
      };
      if (machine) {
        io.stdout(JSON.stringify(report, null, 2));
      } else {
        io.stdout(
          `Command:        ${config.binaryName} ${effectiveForwarded.join(" ")}\nMCP connection: ${config.endpoint}\nToken env var:  ${resolvedTokenEnvVar}\n\nNo network requests were made.`,
        );
      }
      return 0;
    }

    const { createBrandedCli } = await import("./cli-host.js");
    const brandedCli = createBrandedCli(config, {
      cwd,
      io: {
        stdout: io.stdout,
        stderr: io.stderr,
        isTTY: io.isTTY,
        confirm: io.confirm,
      },
      ...runtimeOptions.brandedCliDependencies,
    });
    return await brandedCli.run(effectiveForwarded);
  }

  // --- `chumbo cli status` ---
  if (action === "status") {
    const snapshot =
      existingSnapshot ??
      (await readDirectorySnapshot(packageDir, projectRoot));
    const hasAnyFile = Object.values(snapshot.files).some(
      (entry) => entry !== null && entry !== undefined,
    );
    if (!hasAnyFile) {
      const report: ChumboCliCommandJsonReport = {
        schemaVersion: 1,
        command: "cli status",
        status: "not_created",
        stateLabel: "Create a project CLI",
        projectRoot,
        packageDir: packageDirRel,
        tokenEnvVar: resolvedTokenEnvVar,
        files: [],
        message: "No project CLI package was found in this repository.",
        nextCommand: `npx chumbo cli init --bin ${shellArg(binaryName)} --plan --json`,
      };
      if (machine) io.stdout(JSON.stringify(report, null, 2));
      else {
        io.stdout(
          `${report.message}\nNext: npx chumbo cli init --bin ${binaryName} --plan`,
        );
      }
      return 0;
    }

    if (!endpoint) {
      throw new Error(
        "No MCP connection URL could be determined. Pass --url <url> to inspect CLI source status.",
      );
    }

    const config: BrandedCliConfig = {
      packageName,
      binaryName,
      displayName,
      version: cliVersion,
      endpoint,
      ...(supportUrl ? { supportUrl } : {}),
      ...(poweredBy ? { poweredBy } : {}),
      ...(authConfig ? { auth: authConfig } : {}),
    };
    const plan = planBrandedCliPackage(config, renderOptions, snapshot);
    const report: ChumboCliCommandJsonReport = {
      schemaVersion: 1,
      command: "cli status",
      status: plan.state === "create" ? "not_created" : plan.state,
      stateLabel: plan.stateLabel,
      projectRoot,
      packageDir: packageDirRel,
      config,
      tokenEnvVar: resolvedTokenEnvVar,
      files: plan.files.map((f) => ({
        path: portablePath(
          relative(projectRoot, join(packageDir, ...f.relativePath.split("/"))),
        ),
        role: f.role,
        status: f.status,
        ...(f.reason ? { reason: f.reason } : {}),
      })),
      message: plan.message,
      ...(plan.recovery ? { recovery: plan.recovery } : {}),
    };

    if (machine) {
      io.stdout(JSON.stringify(report, null, 2));
    } else {
      io.stdout(
        `${plan.stateLabel}\n\nCommand:        ${config.binaryName}\nPackage:        ${config.packageName}@${config.version}\nMCP connection: ${config.endpoint}\nToken env var:  ${resolvedTokenEnvVar}\n\n${formatPlanTable(plan, projectRoot, packageDir)}\n\n${plan.message}${plan.recovery ? `\n\nRecovery: ${plan.recovery}` : ""}`,
      );
    }
    return plan.state === "needs_decision" || plan.state === "blocked" ? 1 : 0;
  }

  if (!endpoint) {
    throw new Error(
      "No MCP connection URL found. Pass --url <https-url> or run inside a linked Supabase project.",
    );
  }

  const config: BrandedCliConfig = {
    packageName,
    binaryName,
    displayName,
    version: cliVersion,
    endpoint,
    ...(supportUrl ? { supportUrl } : {}),
    ...(poweredBy ? { poweredBy } : {}),
    ...(authConfig ? { auth: authConfig } : {}),
  };

  // --- `chumbo cli render` ---
  if (action === "render") {
    const rendered = renderBrandedCliPackage(config, renderOptions);
    const outTgz = parsed.values["out-tgz"];

    if (!outTgz) {
      const report: ChumboCliCommandJsonReport = {
        schemaVersion: 1,
        command: "cli render",
        status: parsed.values.plan ? "planned" : "complete",
        stateLabel: "Proposed files are ready to review",
        projectRoot,
        packageDir: packageDirRel,
        config,
        tokenEnvVar: resolvedTokenEnvVar,
        files: Object.keys(rendered).map((rel) => ({
          path: rel,
          role:
            rel === "package.json"
              ? "package-json"
              : rel === "README.md"
                ? "user-doc"
                : "managed",
          status: "create",
        })),
        renderedFiles: rendered,
        message: "Proposed CLI files rendered in memory without writing.",
      };
      if (machine) {
        io.stdout(JSON.stringify(report, null, 2));
      } else {
        io.stdout(
          `Proposed files for ${config.packageName} (${config.binaryName}):\n${Object.keys(
            rendered,
          )
            .map((p) => `  ${p}`)
            .join(
              "\n",
            )}\n\nPass --json to inspect full file contents or --out-tgz <path> to package a portable archive.`,
        );
      }
      return 0;
    }

    const archiveFullPath = resolve(cwd, outTgz);
    const archiveRelPath = portablePath(
      relative(projectRoot, archiveFullPath) || outTgz,
    );
    const existingArchiveKind = await statKind(archiveFullPath);
    if (existingArchiveKind === "dir" || existingArchiveKind === "other") {
      throw new Error(
        `Archive destination '${outTgz}' is not a writable file path.`,
      );
    }
    const existsAlready = existingArchiveKind === "file";
    const tarballBytes = packBrandedCliSourceTarball(rendered);
    const nextCmd = buildNextCommand("render", parsed.values, packageDirRel);

    const buildArchiveReport = (
      status: ChumboCliCommandJsonReport["status"],
      message: string,
    ): ChumboCliCommandJsonReport => ({
      schemaVersion: 1,
      command: "cli render",
      status,
      stateLabel: existsAlready
        ? "Existing source archive"
        : "Download source package",
      projectRoot,
      packageDir: packageDirRel,
      config,
      tokenEnvVar: resolvedTokenEnvVar,
      archivePath: archiveRelPath,
      archiveBytes: tarballBytes.byteLength,
      files: [
        {
          path: archiveRelPath,
          role: "managed",
          status: existsAlready ? "conflict" : "create",
          ...(existsAlready
            ? { reason: "Archive file already exists at destination." }
            : {}),
        },
      ],
      message,
      ...(status === "needs_confirmation" ? { nextCommand: nextCmd } : {}),
    });

    if (parsed.values.plan) {
      const msg = existsAlready
        ? `${archiveRelPath} already exists (${tarballBytes.byteLength} bytes). Pass --yes to overwrite. No files changed.`
        : `Ready to write portable source archive ${archiveRelPath} (${tarballBytes.byteLength} bytes). No files changed.`;
      const report = buildArchiveReport("planned", msg);
      if (machine) io.stdout(JSON.stringify(report, null, 2));
      else io.stdout(msg);
      return 0;
    }

    if (machine && !parsed.values.yes) {
      const report = buildArchiveReport(
        "needs_confirmation",
        "Review the archive target, then rerun with --yes.",
      );
      io.stdout(JSON.stringify(report, null, 2));
      return 0;
    }

    if (!parsed.values.yes) {
      if (!io.isTTY) {
        io.stderr(
          existsAlready
            ? `Refusing to overwrite existing archive ${archiveRelPath} without --yes in a non-interactive session.`
            : "No archive written. Re-run with --yes for non-interactive use.",
        );
        return 1;
      }
      const prompt = existsAlready
        ? `Overwrite existing archive ${archiveRelPath}?`
        : `Write source archive to ${archiveRelPath}?`;
      if (!(await io.confirm(prompt))) {
        io.stderr("No archive written.");
        return 1;
      }
    }

    await atomicWriteFile(archiveFullPath, tarballBytes, false);
    const doneMsg = `Wrote portable source archive ${archiveRelPath} (${tarballBytes.byteLength} bytes).`;
    if (machine) {
      io.stdout(
        JSON.stringify(buildArchiveReport("complete", doneMsg), null, 2),
      );
    } else {
      io.stdout(doneMsg);
    }
    return 0;
  }

  // --- `chumbo cli init` ---
  const snapshot =
    existingSnapshot ?? (await readDirectorySnapshot(packageDir, projectRoot));
  const plan = planBrandedCliPackage(config, renderOptions, snapshot);
  const nextCmd = buildNextCommand("init", parsed.values, packageDirRel);

  const buildInitReport = (
    status: ChumboCliCommandJsonReport["status"],
    message = plan.message,
    includeNext = false,
  ): ChumboCliCommandJsonReport => ({
    schemaVersion: 1,
    command: "cli init",
    status,
    stateLabel: plan.stateLabel,
    projectRoot,
    packageDir: packageDirRel,
    config,
    tokenEnvVar: resolvedTokenEnvVar,
    files: plan.files.map((f) => ({
      path: portablePath(
        relative(projectRoot, join(packageDir, ...f.relativePath.split("/"))),
      ),
      role: f.role,
      status: f.status,
      ...(f.reason ? { reason: f.reason } : {}),
    })),
    message,
    ...(plan.recovery ? { recovery: plan.recovery } : {}),
    ...(includeNext ? { nextCommand: nextCmd } : {}),
  });

  if (plan.state === "needs_decision" || plan.state === "blocked") {
    if (machine) {
      io.stdout(JSON.stringify(buildInitReport(plan.state), null, 2));
    } else {
      io.stderr(
        `${plan.stateLabel}\n\n${formatPlanTable(plan, projectRoot, packageDir)}\n\n${plan.message}${plan.recovery ? `\n\nRecovery: ${plan.recovery}` : ""}`,
      );
    }
    return 1;
  }

  if (plan.state === "current") {
    if (machine) {
      io.stdout(JSON.stringify(buildInitReport("current"), null, 2));
    } else {
      io.stdout(
        `${plan.stateLabel}\n\n${formatPlanTable(plan, projectRoot, packageDir)}\n\n${plan.message}`,
      );
    }
    return 0;
  }

  if (parsed.values.plan) {
    const msg = "Proposed files are ready to review. No files changed.";
    if (machine) {
      io.stdout(JSON.stringify(buildInitReport("planned", msg, true), null, 2));
    } else {
      io.stdout(
        `${plan.stateLabel}\n\nTerminal preview:\n  $ npm install --global ${config.packageName}\n  $ ${config.binaryName} login\n  $ ${config.binaryName} commands\n\nMCP connection: ${config.endpoint}\n\nProposed files:\n${formatPlanTable(plan, projectRoot, packageDir)}\n\n${msg}`,
      );
    }
    return 0;
  }

  if (machine && !parsed.values.yes) {
    io.stdout(
      JSON.stringify(
        buildInitReport(
          "needs_confirmation",
          "Review the proposed files, then rerun with --yes.",
          true,
        ),
        null,
        2,
      ),
    );
    return 0;
  }

  if (!parsed.values.yes) {
    if (!io.isTTY) {
      io.stderr("No files changed. Re-run with --yes for non-interactive use.");
      return 1;
    }
    io.stdout(
      `${plan.stateLabel}\n\nTerminal preview:\n  $ npm install --global ${config.packageName}\n  $ ${config.binaryName} login\n  $ ${config.binaryName} commands\n\nMCP connection: ${config.endpoint}\n\nProposed files:\n${formatPlanTable(plan, projectRoot, packageDir)}\n`,
    );
    if (!(await io.confirm("Write these proposed CLI files?"))) {
      io.stderr("No files changed.");
      return 1;
    }
  }

  await applyBrandedCliPlan(packageDir, plan);
  const doneMsg = `Created project CLI package '${config.packageName}' (${config.binaryName}) in ${packageDirRel}.`;
  if (machine) {
    io.stdout(JSON.stringify(buildInitReport("complete", doneMsg), null, 2));
  } else {
    io.stdout(
      `${doneMsg}\n\nPreview locally without publishing:\n  npx chumbo cli try --dir ${packageDirRel} -- --help`,
    );
  }
  return 0;
}

export async function cliCommand(rawArgs: readonly string[]): Promise<void> {
  const code = await runCliCommand(rawArgs);
  if (code !== 0) {
    process.exitCode = code;
  }
}
