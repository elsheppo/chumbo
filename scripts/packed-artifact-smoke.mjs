import { execFileSync } from "node:child_process";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await mkdtemp(join(repository, ".packed-artifact-smoke-"));
const packageVersion = JSON.parse(
  await readFile(join(repository, "package.json"), "utf8"),
).version;

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repository,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    stdio: options.stdio ?? "pipe",
  });
}

async function filesUnder(directory) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) results.push(...(await filesUnder(path)));
    else results.push(path);
  }
  return results;
}

try {
  const packed = JSON.parse(
    run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", fixture],
      { env: { npm_config_dry_run: "false" } },
    ),
  )[0];
  const tarball = join(fixture, packed.filename);
  run("tar", ["-xzf", tarball, "-C", fixture]);
  const packageRoot = join(fixture, "package");
  const packedPackage = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  if (
    packedPackage.name !== "chumbo" ||
    packedPackage.version !== packageVersion
  ) {
    throw new Error(
      `Packed identity mismatch: ${packedPackage.name}@${packedPackage.version}`,
    );
  }
  if (
    packedPackage.bin?.chumbo !== "dist/cli.js" ||
    packedPackage.bin?.["supa-mcp"] !== "dist/cli.js"
  ) {
    throw new Error("Packed CLI does not expose both chumbo and supa-mcp");
  }
  const cliHelp = run(process.execPath, [
    join(packageRoot, "dist", "cli.js"),
    "--help",
  ]);
  if (!cliHelp.includes(`chumbo ${packageVersion}`)) {
    throw new Error("Packed CLI help does not identify Chumbo and its version");
  }
  const declarationFiles = (await filesUnder(join(packageRoot, "dist"))).filter(
    (path) => path.endsWith(".d.ts"),
  );
  const missing = [];
  for (const declaration of declarationFiles) {
    const source = await readFile(declaration, "utf8");
    for (const match of source.matchAll(
      /(?:from\s+|import\s*\()(["'])(\.[^"']+\.js)\1/g,
    )) {
      const runtimePath = resolve(dirname(declaration), match[2]);
      try {
        await readFile(runtimePath);
      } catch {
        missing.push(`${relative(packageRoot, declaration)} -> ${match[2]}`);
      }
    }
  }
  if (missing.length) {
    throw new Error(
      `Packed declarations reference missing JavaScript:\n${missing.join("\n")}`,
    );
  }

  const runtimeUrl = pathToFileURL(join(packageRoot, "dist", "index.js")).href;
  run(process.execPath, [
    "--input-type=module",
    "--eval",
    `const api = await import(${JSON.stringify(runtimeUrl)});
if (typeof api.createSupabaseMcp !== "function") throw new Error("createSupabaseMcp missing");
if (typeof api.createRunCorrelation !== "function") throw new Error("createRunCorrelation missing");
if (typeof api.durableStateLimits !== "object") throw new Error("durableStateLimits missing");`,
  ]);

  const typeConsumer = join(fixture, "node-consumer.ts");
  await writeFile(
    typeConsumer,
    `import {
  createRunCorrelation,
  createSupabaseMcp,
  type SupabaseMcpContext,
  type SupabaseMcpRunCorrelation,
  type SupabaseMcpState,
  type SupabaseMcpSurfaceProof,
} from "./package/dist/index.js";

function stateFrom(context: SupabaseMcpContext): SupabaseMcpState | undefined {
  return context.state;
}

function surfaceFrom(proof: SupabaseMcpSurfaceProof): string {
  return proof.contentDigest;
}

const runs: SupabaseMcpRunCorrelation = createRunCorrelation({
  currentKey: {
    version: "packed-v1",
    secret: "0123456789abcdef0123456789abcdef",
  },
  scope(context) {
    return {
      installation: "packed-installation",
      surface: "packed-surface",
      partition: context.subject ?? "public",
    };
  },
});

createSupabaseMcp({
  server: { name: "packed type smoke", version: "1.0.0" },
  resourceUrl: "https://example.test/mcp",
  auth: { mode: "api-key", key: "test-key" },
  state: {
    hmacKey: "0123456789abcdef0123456789abcdef",
    namespaces: { observations: { ttlSeconds: 60 } },
  },
  runCorrelation: runs,
  register(_server, context) {
    void stateFrom(context);
  },
  onSurface(proof) {
    void surfaceFrom(proof);
  },
});
`,
  );
  await writeFile(
    join(fixture, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          types: ["node"],
        },
        files: ["node-consumer.ts"],
      },
      null,
      2,
    )}\n`,
  );
  run(process.execPath, [
    join(repository, "node_modules", "typescript", "bin", "tsc"),
    "--project",
    join(fixture, "tsconfig.json"),
  ]);

  const nodeModules = join(fixture, "node_modules");
  await mkdir(nodeModules);
  await cp(packageRoot, join(nodeModules, "chumbo"), { recursive: true });
  for (const dependency of [
    "@modelcontextprotocol/server",
    "@supabase/server",
    "@supabase/supabase-js",
    "zod",
  ]) {
    const destination = join(nodeModules, dependency);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(
      join(repository, "node_modules", dependency),
      destination,
      "dir",
    );
  }
  await writeFile(
    join(fixture, "package.json"),
    `${JSON.stringify(
      {
        type: "module",
        dependencies: { chumbo: packageVersion },
      },
      null,
      2,
    )}\n`,
  );

  const denoConsumer = join(fixture, "deno-consumer.ts");
  await writeFile(
    denoConsumer,
    `import {
  createRunCorrelation,
  createSupabaseMcp,
  durableStateLimits,
  runCorrelationLimits,
  type SupabaseMcpContext,
  type SupabaseMcpRunCorrelation,
  type SupabaseMcpState,
  type SupabaseMcpSurfaceProof,
} from "chumbo";

function stateFrom(context: SupabaseMcpContext): SupabaseMcpState | undefined {
  return context.state;
}

function surfaceFrom(proof: SupabaseMcpSurfaceProof): string {
  return proof.contentDigest;
}

const runs: SupabaseMcpRunCorrelation = createRunCorrelation({
  currentKey: {
    version: "packed-v1",
    secret: "0123456789abcdef0123456789abcdef",
  },
  scope(context) {
    return {
      installation: "packed-installation",
      surface: "packed-surface",
      partition: context.subject ?? "public",
    };
  },
});

const app = createSupabaseMcp({
  server: { name: "packed deno smoke", version: "1.0.0" },
  resourceUrl: "https://example.test/mcp",
  auth: { mode: "api-key", key: "test-key" },
  state: {
    hmacKey: "0123456789abcdef0123456789abcdef",
    namespaces: { observations: { ttlSeconds: 60 } },
  },
  runCorrelation: runs,
  register(_server, context) {
    void stateFrom(context);
  },
  onSurface(proof) {
    void surfaceFrom(proof);
  },
});

if (
  typeof app.fetch !== "function" ||
  durableStateLimits.keyBytes !== 512 ||
  runCorrelationLimits.tokenBytes !== 1024
) {
  throw new Error("Packed Deno runtime exports are invalid");
}
`,
  );
  await writeFile(
    join(fixture, "deno.json"),
    `${JSON.stringify(
      {
        nodeModulesDir: "manual",
        compilerOptions: { strict: true },
      },
      null,
      2,
    )}\n`,
  );
  run("deno", ["check", "--config", join(fixture, "deno.json"), denoConsumer]);
  run("deno", ["run", "--config", join(fixture, "deno.json"), denoConsumer]);

  console.log(
    `Packed artifact passed package identity, dual CLI, Node ESM, strict TypeScript, Deno runtime/type, and ${declarationFiles.length}-file declaration graph checks.`,
  );
} finally {
  await rm(fixture, { recursive: true, force: true });
}
