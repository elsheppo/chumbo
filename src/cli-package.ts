import type { BrandedCliConfig } from "./cli-host.js";

export interface BrandedCliPackageFiles {
  readonly "package.json": string;
  readonly "bin/cli.js": string;
  readonly "README.md": string;
}

export interface RenderBrandedCliPackageOptions {
  /** Exact or semver dependency range used by the generated package. */
  readonly chumboVersion: string;
}

const packageNamePattern =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const binaryNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const versionPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;

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
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "127.0.0.1") {
    throw new TypeError("endpoint must use HTTPS outside loopback development");
  }
  if (config.supportUrl) new URL(config.supportUrl);
}

/**
 * Render the complete source of a tiny customer-owned npm CLI package.
 * Chumbo Cloud can sign and publish these files without rewriting the host.
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
    license: "UNLICENSED",
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
