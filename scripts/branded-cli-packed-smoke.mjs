import { execFile } from "node:child_process";
import { createServer } from "node:http";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { renderBrandedCliPackage } from "../dist/cli-package.js";

const execFileAsync = promisify(execFile);

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await mkdtemp(join(tmpdir(), "chumbo-branded-cli-"));
const version = JSON.parse(
  await readFile(join(repository, "package.json"), "utf8"),
).version;

const server = createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body.method === "initialize") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "acme-ops", version: "1.0.0" },
          },
        }),
      );
      return;
    }
    if (body.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    if (body.method === "tools/list") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              {
                name: "whoami",
                description: "Inspect the signed-in caller.",
                inputSchema: { type: "object", properties: {} },
                annotations: { readOnlyHint: true },
              },
            ],
          },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: "Method not found" },
      }),
    );
  });
});

try {
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;

  const files = renderBrandedCliPackage(
    {
      packageName: "@acme/ops-cli",
      binaryName: "acme",
      displayName: "Acme Ops",
      version: "1.0.0",
      endpoint,
      supportUrl: "https://acme.example/support",
      poweredBy: "Chumbo Cloud",
    },
    { chumboVersion: version },
  );
  for (const [path, source] of Object.entries(files)) {
    const target = join(fixture, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  await chmod(join(fixture, "bin", "cli.js"), 0o755);
  await mkdir(join(fixture, "node_modules"));
  await symlink(repository, join(fixture, "node_modules", "chumbo"), "dir");

  const smokeEnv = {
    ...process.env,
    ACME_TOKEN: "smoke-token",
    XDG_CACHE_HOME: join(fixture, ".cache"),
  };

  const { stdout: help } = await execFileAsync(
    process.execPath,
    [join(fixture, "bin", "cli.js"), "--help"],
    { cwd: fixture, encoding: "utf8", env: smokeEnv },
  );
  if (
    !help.includes("Acme Ops CLI") ||
    !help.includes("acme login") ||
    !help.includes("Support: https://acme.example/support")
  ) {
    throw new Error(`Generated CLI did not retain project identity:\n${help}`);
  }

  const { stdout: completions } = await execFileAsync(
    process.execPath,
    [join(fixture, "bin", "cli.js"), "completions", "zsh"],
    { cwd: fixture, encoding: "utf8", env: smokeEnv },
  );
  if (!completions.includes("#compdef acme")) {
    throw new Error(
      `Generated CLI zsh completions did not include #compdef acme:\n${completions}`,
    );
  }

  const { stdout: skillPlanOut } = await execFileAsync(
    process.execPath,
    [join(fixture, "bin", "cli.js"), "skill", "install", "--plan", "--json"],
    { cwd: fixture, encoding: "utf8", env: smokeEnv },
  );
  const skillPlan = JSON.parse(skillPlanOut);
  if (skillPlan.status !== "planned") {
    throw new Error(
      `Expected branded CLI skill install --plan to report planned: ${JSON.stringify(skillPlan)}`,
    );
  }

  const { stdout: headlessStatusOut } = await execFileAsync(
    process.execPath,
    [join(fixture, "bin", "cli.js"), "status", "--json"],
    { cwd: fixture, encoding: "utf8", env: smokeEnv },
  );
  const headlessStatus = JSON.parse(headlessStatusOut);
  if (!headlessStatus.signedIn) {
    throw new Error(
      `Expected headless ACME_TOKEN status to report signedIn: ${JSON.stringify(headlessStatus)}`,
    );
  }

  const { stdout: packedOut } = await execFileAsync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", fixture],
    { cwd: fixture, encoding: "utf8" },
  );
  const packed = JSON.parse(packedOut)[0];
  if (packed.name !== "@acme/ops-cli") {
    throw new Error(`Generated package identity drifted: ${packed.name}`);
  }
  const names = new Set(packed.files.map((file) => file.path));
  for (const required of ["bin/cli.js", "README.md", "package.json"]) {
    if (!names.has(required))
      throw new Error(`Generated package omitted ${required}`);
  }
  console.log(
    "Project-branded CLI package renders, executes, and packs with project identity.",
  );
} finally {
  server.close();
  await rm(fixture, { recursive: true, force: true });
}
