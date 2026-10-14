import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(join(repository, "package.json"), "utf8"),
);
const minimum = manifest.peerDependencies.zod.replace(/^\^/, "");
const current = manifest.devDependencies.zod;
const fixture = await mkdtemp(join(tmpdir(), "chumbo-zod-consumers-"));
function run(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
      // npm pack --dry-run runs prepack with this flag inherited. The smoke
      // still needs a real tarball and real installs in its temporary fixtures.
      env: { ...process.env, npm_config_dry_run: "false" },
    });
  } catch (error) {
    console.error(error.stdout?.toString(), error.stderr?.toString());
    throw error;
  }
}
try {
  const packed = JSON.parse(
    run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", fixture],
      repository,
    ),
  )[0];
  for (const manager of ["npm", "pnpm"]) {
    for (const version of new Set([minimum, current])) {
      const consumer = join(fixture, `${manager}-${version}`);
      await cp(
        join(repository, "scripts", "fixtures", "zod-consumer"),
        consumer,
        {
          recursive: true,
        },
      );
      await writeFile(
        join(consumer, "package.json"),
        JSON.stringify(
          {
            private: true,
            type: "module",
            dependencies: {
              chumbo: `file:${join(fixture, packed.filename)}`,
              zod: version,
            },
            devDependencies: {
              typescript: manifest.devDependencies.typescript,
              "@types/node": manifest.devDependencies["@types/node"],
            },
          },
          null,
          2,
        ),
      );
      await writeFile(
        join(consumer, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            skipLibCheck: false,
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            outDir: "out",
            types: ["node"],
          },
          files: ["consumer.ts"],
        }),
      );
      run(
        manager,
        [
          "install",
          "--ignore-scripts",
          ...(manager === "npm"
            ? ["--no-audit", "--no-fund"]
            : ["--strict-peer-dependencies"]),
        ],
        consumer,
      );
      // Resolve from the installed package, not a repository symlink: its peer
      // must be the application's Zod even when the SDK resolves another copy.
      run(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fromChumbo = createRequire(import.meta.resolve('chumbo'));
assert.equal(fromChumbo.resolve('zod'), require.resolve('zod'));
assert.equal(require('zod/package.json').version, ${JSON.stringify(version)});
`,
        ],
        consumer,
      );
      run(
        process.execPath,
        [join(consumer, "node_modules/typescript/bin/tsc"), "-p", consumer],
        consumer,
      );
      console.log(
        `${manager}, Zod ${version}: ${run(process.execPath, ["out/consumer.js"], consumer).trim()}`,
      );
    }
  }
} finally {
  await rm(fixture, { recursive: true, force: true });
}
