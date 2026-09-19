import type { BrandedCliConfig } from "./cli-host.js";

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

const packageNamePattern =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const binaryNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const versionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const licensePattern = /^[A-Za-z0-9][A-Za-z0-9 .+()\-]{0,127}$/u;

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
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "127.0.0.1") {
    throw new TypeError("endpoint must use HTTPS outside loopback development");
  }
  if (config.supportUrl) new URL(config.supportUrl);
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
  const readme = `# ${config.displayName} CLI\n\nInstall and sign in:\n\n\`\`\`sh\nnpm install --global ${config.packageName}\n${config.binaryName} login\n${config.binaryName} commands\n\`\`\`${support}${attribution}`;
  return Object.freeze({
    "package.json": `${JSON.stringify(packageJson, null, 2)}\n`,
    "bin/cli.js": source,
    "README.md": readme,
  });
}
