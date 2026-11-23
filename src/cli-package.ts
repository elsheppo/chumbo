import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { BrandedCliConfig } from "./cli-host.js";

export const BRANDED_CLI_MANIFEST_PATH = ".chumbo/cli-manifest.json" as const;
export const BRANDED_CLI_MANIFEST_SCHEMA = "chumbo-cli-manifest@1" as const;

export interface BrandedCliManifestV1 {
  readonly schemaVersion: typeof BRANDED_CLI_MANIFEST_SCHEMA;
  readonly generatorVersion: string;
  readonly packageName: string;
  readonly binaryName: string;
  readonly managedFiles: Readonly<Record<string, string>>;
}

export interface BrandedCliPackageFiles {
  readonly "package.json": string;
  readonly "bin/cli.js": string;
  readonly "README.md": string;
}

export interface RenderBrandedCliPackageOptions {
  /** Exact or semver dependency range used by the generated package. */
  readonly chumboVersion: string;
  /** npm package license expression. Defaults to UNLICENSED. */
  readonly license?: string;
  /** npm publication visibility. Omit to leave publication policy unset. */
  readonly access?: "public" | "restricted";
  /** Canonical source repository for the generated package. */
  readonly repository?: {
    readonly url: string;
    readonly directory?: string;
  };
}

export type BrandedCliFileRole =
  | "managed"
  | "package-json"
  | "user-doc"
  | "manifest";
export type BrandedCliFileStatus =
  | "create"
  | "update"
  | "unchanged"
  | "delete"
  | "conflict";

export interface PlannedBrandedCliFile {
  readonly relativePath: string;
  readonly role: BrandedCliFileRole;
  readonly status: BrandedCliFileStatus;
  readonly executable: boolean;
  readonly content?: string;
  readonly reason?: string;
}

export type BrandedCliPlanState =
  | "create"
  | "current"
  | "safe_update"
  | "adopt"
  | "needs_decision"
  | "blocked";

export interface BrandedCliDirectorySnapshot {
  readonly files: Readonly<
    Record<string, string | null | { readonly kind: "non-regular" } | undefined>
  >;
  readonly isApplicationRoot?: boolean;
}

export interface BrandedCliPackagePlan {
  readonly state: BrandedCliPlanState;
  readonly stateLabel:
    | "Create a project CLI"
    | "CLI source is current"
    | "Safe generated update"
    | "Adopt existing CLI source"
    | "Source needs a decision"
    | "Blocked";
  readonly config: BrandedCliConfig;
  readonly files: readonly PlannedBrandedCliFile[];
  readonly manifest: BrandedCliManifestV1;
  readonly message: string;
  readonly recovery?: string;
}

const packageNamePattern =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const binaryNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const versionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const licensePattern = /^[A-Za-z0-9][A-Za-z0-9 .+()\-]{0,127}$/u;
const envVarNamePattern = /^[A-Z][A-Z0-9_]{1,63}$/u;
const httpHeaderNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/u;
const workflowPathPattern = /^chumbo-release\/publish-[a-z][a-z0-9-]*\.yml$/u;
const EXPECTED_TAR_FILES = ["README.md", "bin/cli.js", "package.json"] as const;

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]"
  );
}

function safeRepositoryDirectory(value: string): boolean {
  return (
    value !== "." &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    value
      .split("/")
      .every(
        (segment) =>
          segment !== "" &&
          segment !== "." &&
          segment !== ".." &&
          segment.toLowerCase() !== ".git",
      )
  );
}

function validatePackageConfig(
  config: BrandedCliConfig,
  options: RenderBrandedCliPackageOptions,
): void {
  if (!packageNamePattern.test(config.packageName)) {
    throw new TypeError(
      "packageName must be a valid lowercase npm package name",
    );
  }
  if (!binaryNamePattern.test(config.binaryName)) {
    throw new TypeError("binaryName must be lowercase kebab-case");
  }
  if (!config.displayName.trim())
    throw new TypeError("displayName is required");
  if (!versionPattern.test(config.version)) {
    throw new TypeError("version must be a valid semantic version");
  }
  if (!options.chumboVersion.trim()) {
    throw new TypeError("chumboVersion is required");
  }
  const license = options.license ?? "UNLICENSED";
  if (!licensePattern.test(license)) {
    throw new TypeError("license must be a bounded npm license expression");
  }
  if (options.access === "restricted" && !config.packageName.startsWith("@")) {
    throw new TypeError("restricted npm packages must use a scope");
  }
  if (options.repository) {
    const repository = new URL(options.repository.url);
    if (
      !["https:", "git+https:"].includes(repository.protocol) ||
      repository.username ||
      repository.password ||
      repository.search ||
      repository.hash
    ) {
      throw new TypeError("repository must be a credential-free HTTPS Git URL");
    }
    if (
      options.repository.directory &&
      !safeRepositoryDirectory(options.repository.directory)
    ) {
      throw new TypeError("repository directory must be a safe relative path");
    }
  }
  const endpoint = new URL(config.endpoint);
  if (
    endpoint.protocol !== "https:" &&
    !isLoopbackHostname(endpoint.hostname)
  ) {
    throw new TypeError("endpoint must use HTTPS outside loopback development");
  }
  if (config.supportUrl) new URL(config.supportUrl);

  if (config.auth) {
    if (
      config.auth.mode !== undefined &&
      !["oauth", "token", "public", "auto"].includes(config.auth.mode)
    ) {
      throw new TypeError(
        "auth.mode must be one of: oauth, token, public, auto",
      );
    }
    if (
      config.auth.tokenEnvVar !== undefined &&
      !envVarNamePattern.test(config.auth.tokenEnvVar)
    ) {
      throw new TypeError(
        "auth.tokenEnvVar must be an uppercase POSIX environment variable name",
      );
    }
    if (
      config.auth.headerName !== undefined &&
      !httpHeaderNamePattern.test(config.auth.headerName)
    ) {
      throw new TypeError("auth.headerName must be a valid HTTP header token");
    }
  }
  if (
    config.discoveryCache?.ttlMs !== undefined &&
    (!Number.isFinite(config.discoveryCache.ttlMs) ||
      config.discoveryCache.ttlMs < 0)
  ) {
    throw new TypeError("discoveryCache.ttlMs must be a non-negative number");
  }
}

export function sourceDigest(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

/**
 * Render the complete source of a tiny project-owned npm CLI package.
 * Rendering produces source files without publishing them.
 */
export function renderBrandedCliPackage(
  config: BrandedCliConfig,
  options: RenderBrandedCliPackageOptions,
): BrandedCliPackageFiles {
  validatePackageConfig(config, options);
  const packageJson = {
    name: config.packageName,
    version: config.version,
    description: `${config.displayName} command-line interface.`,
    type: "module",
    license: options.license ?? "UNLICENSED",
    ...(options.access ? { publishConfig: { access: options.access } } : {}),
    ...(options.repository
      ? {
          repository: {
            type: "git",
            url: options.repository.url,
            ...(options.repository.directory
              ? { directory: options.repository.directory }
              : {}),
          },
        }
      : {}),
    engines: { node: ">=22" },
    bin: { [config.binaryName]: "bin/cli.js" },
    files: ["bin", "README.md"],
    dependencies: { chumbo: options.chumboVersion },
  };
  const source = `#!/usr/bin/env node\nimport { runBrandedCli } from "chumbo/cli-host";\n\nawait runBrandedCli(${JSON.stringify(config, null, 2)});\n`;
  const support = config.supportUrl
    ? `\nSupport: ${config.supportUrl}\n`
    : "\n";
  const attribution = config.poweredBy
    ? `\nPowered by ${config.poweredBy}.\n`
    : "";
  const tokenEnv =
    config.auth?.tokenEnvVar ??
    `${config.binaryName.replaceAll("-", "_").toUpperCase()}_TOKEN`;
  const signInBlock =
    config.auth?.mode === "token"
      ? `npm install --global ${config.packageName}\nexport ${tokenEnv}="<your-token>"\n${config.binaryName} commands`
      : config.auth?.mode === "public"
        ? `npm install --global ${config.packageName}\n${config.binaryName} commands`
        : `npm install --global ${config.packageName}\n${config.binaryName} login\n${config.binaryName} commands`;
  const readme = `# ${config.displayName} CLI\n\nInstall and sign in:\n\n\`\`\`sh\n${signInBlock}\n\`\`\`${support}${attribution}`;
  return Object.freeze({
    "package.json": `${JSON.stringify(packageJson, null, 2)}\n`,
    "bin/cli.js": source,
    "README.md": readme,
  });
}

function parseManifestContent(content: string): BrandedCliManifestV1 | null {
  try {
    const value = JSON.parse(content) as Partial<BrandedCliManifestV1>;
    if (
      value.schemaVersion !== BRANDED_CLI_MANIFEST_SCHEMA ||
      typeof value.generatorVersion !== "string" ||
      typeof value.packageName !== "string" ||
      typeof value.binaryName !== "string" ||
      value.managedFiles === null ||
      typeof value.managedFiles !== "object" ||
      Array.isArray(value.managedFiles) ||
      Object.keys(value.managedFiles).length > 8 ||
      Object.entries(value.managedFiles).some(
        ([path, digest]) =>
          path.length === 0 ||
          (path !== "bin/cli.js" && !workflowPathPattern.test(path)) ||
          path.startsWith("/") ||
          path.includes("\\") ||
          path.split("/").some((segment) => !segment || segment === "..") ||
          typeof digest !== "string" ||
          !/^sha256:[0-9a-f]{64}$/u.test(digest),
      )
    ) {
      return null;
    }
    return value as BrandedCliManifestV1;
  } catch {
    return null;
  }
}

function isCompatibleGeneratedCliEntrypoint(source: string): boolean {
  const prefix =
    '#!/usr/bin/env node\nimport { runBrandedCli } from "chumbo/cli-host";\n\nawait runBrandedCli(';
  const suffix = ");\n";
  if (!source.startsWith(prefix) || !source.endsWith(suffix)) return false;
  const body = source.slice(prefix.length, source.length - suffix.length);
  try {
    const parsed = JSON.parse(body) as unknown;
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as { binaryName?: unknown }).binaryName === "string" &&
      typeof (parsed as { endpoint?: unknown }).endpoint === "string"
    );
  } catch {
    return false;
  }
}

function looksLikeApplicationManifest(
  rawPackageJson: string,
  desiredPackageName: string,
): boolean {
  try {
    const parsed = JSON.parse(rawPackageJson) as Record<string, unknown>;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return true;
    }
    for (const field of ["dependencies", "devDependencies"]) {
      const deps = parsed[field];
      if (deps && typeof deps === "object" && !Array.isArray(deps)) {
        if (
          [
            "next",
            "vite",
            "react",
            "astro",
            "nuxt",
            "@supabase/supabase-js",
          ].some((pkg) => pkg in deps)
        ) {
          return true;
        }
      }
    }
    return (
      typeof parsed.name === "string" &&
      parsed.name.length > 0 &&
      parsed.name !== desiredPackageName
    );
  } catch {
    return true;
  }
}

function mergePackageJsonContent(
  current: string,
  desired: string,
): string | null {
  try {
    const existing = JSON.parse(current) as Record<string, unknown>;
    const generated = JSON.parse(desired) as Record<string, unknown>;
    if (
      existing === null ||
      generated === null ||
      typeof existing !== "object" ||
      typeof generated !== "object" ||
      Array.isArray(existing) ||
      Array.isArray(generated)
    ) {
      return null;
    }
    const merged: Record<string, unknown> = { ...existing };
    for (const key of [
      "name",
      "version",
      "description",
      "type",
      "license",
      "publishConfig",
      "repository",
      "engines",
      "bin",
      "files",
    ]) {
      if (generated[key] === undefined) {
        delete merged[key];
      } else {
        merged[key] = generated[key];
      }
    }
    const existingDependencies =
      existing.dependencies !== null &&
      typeof existing.dependencies === "object" &&
      !Array.isArray(existing.dependencies)
        ? (existing.dependencies as Record<string, unknown>)
        : {};
    const generatedDependencies = generated.dependencies as Record<
      string,
      unknown
    >;
    merged.dependencies = {
      ...existingDependencies,
      chumbo: generatedDependencies.chumbo,
    };
    return `${JSON.stringify(merged, null, 2)}\n`;
  } catch {
    return null;
  }
}

function normalizedGeneratorVersion(chumboVersion: string): string {
  const stripped = chumboVersion.trim().replace(/^[~^>=<\s]+/u, "");
  return stripped || chumboVersion.trim();
}

export function planBrandedCliPackage(
  config: BrandedCliConfig,
  options: RenderBrandedCliPackageOptions,
  snapshot: BrandedCliDirectorySnapshot,
): BrandedCliPackagePlan {
  const rendered = renderBrandedCliPackage(config, options);
  const generatorVersion = normalizedGeneratorVersion(options.chumboVersion);

  const fallbackManifest: BrandedCliManifestV1 = {
    schemaVersion: BRANDED_CLI_MANIFEST_SCHEMA,
    generatorVersion,
    packageName: config.packageName,
    binaryName: config.binaryName,
    managedFiles: {
      "bin/cli.js": sourceDigest(rendered["bin/cli.js"]),
    },
  };

  // 1. Reject non-regular files (directories or symlinks at managed/package paths)
  for (const [path, entry] of Object.entries(snapshot.files)) {
    if (entry && typeof entry === "object" && entry.kind === "non-regular") {
      return {
        state: "blocked",
        stateLabel: "Blocked",
        config,
        manifest: fallbackManifest,
        files: [
          {
            relativePath: path,
            role:
              path === BRANDED_CLI_MANIFEST_PATH
                ? "manifest"
                : path === "package.json"
                  ? "package-json"
                  : path === "README.md"
                    ? "user-doc"
                    : "managed",
            status: "conflict",
            executable: path === "bin/cli.js",
            reason: "Path is occupied by a directory or symbolic link.",
          },
        ],
        message: `${path} is not a regular file, so Chumbo stopped before proposing changes.`,
        recovery: `Remove or relocate the non-regular entry at ${path} before trying again.`,
      };
    }
  }

  const rawManifest = snapshot.files[BRANDED_CLI_MANIFEST_PATH] as
    | string
    | null
    | undefined;
  let manifest: BrandedCliManifestV1 | null = null;
  if (typeof rawManifest === "string") {
    manifest = parseManifestContent(rawManifest);
    if (!manifest) {
      return {
        state: "blocked",
        stateLabel: "Blocked",
        config,
        manifest: fallbackManifest,
        files: [
          {
            relativePath: BRANDED_CLI_MANIFEST_PATH,
            role: "manifest",
            status: "conflict",
            executable: false,
            reason: "The CLI source manifest is invalid.",
          },
        ],
        message:
          "The CLI source manifest is invalid. Chumbo stopped before proposing replacements.",
        recovery:
          "Repair or remove .chumbo/cli-manifest.json only after reviewing the current source.",
      };
    }
  }

  const rawPackageJson = snapshot.files["package.json"] as
    | string
    | null
    | undefined;
  const rawBinCli = snapshot.files["bin/cli.js"] as string | null | undefined;
  const rawReadme = snapshot.files["README.md"] as string | null | undefined;

  // 2. Guard against overwriting an application's root package.json when `--dir .` is misused
  if (
    !manifest &&
    snapshot.isApplicationRoot &&
    typeof rawPackageJson === "string" &&
    looksLikeApplicationManifest(rawPackageJson, config.packageName)
  ) {
    return {
      state: "blocked",
      stateLabel: "Blocked",
      config,
      manifest: fallbackManifest,
      files: [
        {
          relativePath: "package.json",
          role: "package-json",
          status: "conflict",
          executable: false,
          reason:
            "Target directory contains an existing application package.json.",
        },
      ],
      message:
        "Refusing to merge CLI package metadata into the application root package.json.",
      recovery: `Target a dedicated package directory such as packages/${config.binaryName}-cli.`,
    };
  }

  const plannedFiles: PlannedBrandedCliFile[] = [];
  const nextManagedHashes: Record<string, string> = {
    "bin/cli.js": sourceDigest(rendered["bin/cli.js"]),
  };

  // 3. Verify baseline of managed files (`bin/cli.js` + any `chumbo-release/publish-*.yml` workflow templates)
  let managedConflictPath: string | undefined;
  if (manifest) {
    for (const [managedPath, expectedDigest] of Object.entries(
      manifest.managedFiles,
    )) {
      const currentContent = snapshot.files[managedPath] as
        | string
        | null
        | undefined;
      if (typeof currentContent !== "string") {
        managedConflictPath = managedPath;
        plannedFiles.push({
          relativePath: managedPath,
          role: "managed",
          status: "conflict",
          executable: managedPath === "bin/cli.js",
          reason: "Managed generated file was removed after generation.",
        });
        continue;
      }
      if (sourceDigest(currentContent) !== expectedDigest) {
        managedConflictPath = managedPath;
        plannedFiles.push({
          relativePath: managedPath,
          role: "managed",
          status: "conflict",
          executable: managedPath === "bin/cli.js",
          reason: "Edited after Chumbo generated it.",
        });
        continue;
      }
      if (managedPath !== "bin/cli.js") {
        // Preserve untouched managed release workflow templates in `.chumbo/cli-manifest.json`
        nextManagedHashes[managedPath] = expectedDigest;
        plannedFiles.push({
          relativePath: managedPath,
          role: "managed",
          status: "unchanged",
          executable: false,
        });
      }
    }
  } else if (
    typeof rawBinCli === "string" &&
    rawBinCli !== rendered["bin/cli.js"] &&
    !isCompatibleGeneratedCliEntrypoint(rawBinCli)
  ) {
    managedConflictPath = "bin/cli.js";
    plannedFiles.push({
      relativePath: "bin/cli.js",
      role: "managed",
      status: "conflict",
      executable: true,
      reason: "Existing bin/cli.js contains custom source.",
    });
  }

  if (managedConflictPath) {
    if (typeof rawReadme === "string") {
      plannedFiles.push({
        relativePath: "README.md",
        role: "user-doc",
        status: "unchanged",
        executable: false,
      });
    }
    return {
      state: "needs_decision",
      stateLabel: "Source needs a decision",
      config,
      manifest: fallbackManifest,
      files: plannedFiles,
      message:
        "A generated file was edited, so Chumbo stopped before proposing a replacement. All repository source remains unchanged.",
      recovery: `Keep the edit and update ${managedConflictPath} manually, or restore the recorded generated version before trying again.`,
    };
  }

  // 4. Plan `package.json`
  let nextPackageJson = rendered["package.json"];
  let packageStatus: BrandedCliFileStatus = "create";
  if (typeof rawPackageJson === "string") {
    const merged = mergePackageJsonContent(
      rawPackageJson,
      rendered["package.json"],
    );
    if (merged === null) {
      return {
        state: "needs_decision",
        stateLabel: "Source needs a decision",
        config,
        manifest: fallbackManifest,
        files: [
          {
            relativePath: "package.json",
            role: "package-json",
            status: "conflict",
            executable: false,
            reason: "Existing package.json could not be safely parsed.",
          },
        ],
        message:
          "The existing package.json could not be safely updated. Chumbo stopped before proposing replacements.",
        recovery: "Keep the current package.json and update it manually.",
      };
    }
    nextPackageJson = merged;
    packageStatus = merged === rawPackageJson ? "unchanged" : "update";
  }
  plannedFiles.push({
    relativePath: "package.json",
    role: "package-json",
    status: packageStatus,
    executable: false,
    ...(packageStatus === "unchanged" ? {} : { content: nextPackageJson }),
  });

  // 5. Plan `bin/cli.js`
  const binStatus: BrandedCliFileStatus =
    typeof rawBinCli !== "string"
      ? "create"
      : rawBinCli === rendered["bin/cli.js"]
        ? "unchanged"
        : "update";
  plannedFiles.push({
    relativePath: "bin/cli.js",
    role: "managed",
    status: binStatus,
    executable: true,
    ...(binStatus === "unchanged" ? {} : { content: rendered["bin/cli.js"] }),
  });

  // 6. Plan user-owned `README.md` (written ONLY on initial creation when absent; preserved otherwise)
  if (typeof rawReadme === "string") {
    plannedFiles.push({
      relativePath: "README.md",
      role: "user-doc",
      status: "unchanged",
      executable: false,
    });
  } else if (!manifest) {
    plannedFiles.push({
      relativePath: "README.md",
      role: "user-doc",
      status: "create",
      executable: false,
      content: rendered["README.md"],
    });
  }

  // 7. Plan `.chumbo/cli-manifest.json`
  const nextManifest: BrandedCliManifestV1 = {
    schemaVersion: BRANDED_CLI_MANIFEST_SCHEMA,
    generatorVersion,
    packageName: config.packageName,
    binaryName: config.binaryName,
    managedFiles: nextManagedHashes,
  };
  const nextManifestText = `${JSON.stringify(nextManifest, null, 2)}\n`;
  const manifestStatus: BrandedCliFileStatus =
    typeof rawManifest !== "string"
      ? "create"
      : rawManifest === nextManifestText
        ? "unchanged"
        : "update";
  plannedFiles.push({
    relativePath: BRANDED_CLI_MANIFEST_PATH,
    role: "manifest",
    status: manifestStatus,
    executable: false,
    ...(manifestStatus === "unchanged" ? {} : { content: nextManifestText }),
  });

  const hadExistingSource =
    typeof rawPackageJson === "string" ||
    typeof rawBinCli === "string" ||
    typeof rawReadme === "string";
  const hasMutations = plannedFiles.some((file) =>
    ["create", "update", "delete"].includes(file.status),
  );

  if (!manifest) {
    if (hadExistingSource) {
      return {
        state: "adopt",
        stateLabel: "Adopt existing CLI source",
        config,
        manifest: nextManifest,
        files: plannedFiles,
        message:
          "Existing compatible CLI source will be adopted while preserving user-owned documentation.",
      };
    }
    return {
      state: "create",
      stateLabel: "Create a project CLI",
      config,
      manifest: nextManifest,
      files: plannedFiles,
      message: "Proposed files are ready to review.",
    };
  }

  if (!hasMutations) {
    return {
      state: "current",
      stateLabel: "CLI source is current",
      config,
      manifest: nextManifest,
      files: plannedFiles,
      message:
        "All managed CLI files already match the requested configuration.",
    };
  }

  return {
    state: "safe_update",
    stateLabel: "Safe generated update",
    config,
    manifest: nextManifest,
    files: plannedFiles,
    message:
      "Managed files match their recorded baseline. Proposed files are ready to review.",
  };
}

function tarOctal(value: number, width: number): string {
  return `${value
    .toString(8)
    .padStart(width - 1, "0")
    .slice(-(width - 1))}\0`;
}

function writeTarText(
  header: Buffer,
  value: string,
  offset: number,
  length: number,
): void {
  header.write(value, offset, length, "utf8");
}

/**
 * Deterministic POSIX ustar `.tgz` archive containing the portable CLI source
 * (`package/README.md`, `package/bin/cli.js`, `package/package.json`).
 */
export function packBrandedCliSourceTarball(
  files: BrandedCliPackageFiles,
): Uint8Array {
  const chunks: Buffer[] = [];
  for (const path of EXPECTED_TAR_FILES) {
    const content = Buffer.from(files[path], "utf8");
    const header = Buffer.alloc(512);
    writeTarText(header, `package/${path}`, 0, 100);
    writeTarText(
      header,
      tarOctal(path === "bin/cli.js" ? 0o755 : 0o644, 8),
      100,
      8,
    );
    writeTarText(header, tarOctal(0, 8), 108, 8);
    writeTarText(header, tarOctal(0, 8), 116, 8);
    writeTarText(header, tarOctal(content.byteLength, 12), 124, 12);
    writeTarText(header, tarOctal(0, 12), 136, 12);
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    writeTarText(header, "ustar\0", 257, 6);
    writeTarText(header, "00", 263, 2);
    writeTarText(header, "chumbo", 265, 32);
    writeTarText(header, "chumbo", 297, 32);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeTarText(header, `${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    chunks.push(header, content);
    const padding = (512 - (content.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1_024));
  return new Uint8Array(gzipSync(Buffer.concat(chunks), { level: 9 }));
}
