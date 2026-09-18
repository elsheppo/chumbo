import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, parse, relative, resolve } from "node:path";
import { PACKAGE_VERSION } from "./version.js";
import { validateDurableStateNamespace } from "./state.js";

export { PACKAGE_VERSION } from "./version.js";

export interface PlannedFile {
  path: string;
  content: string;
  status: "create" | "unchanged" | "update" | "conflict";
}

/**
 * Where the generated MCP server runs. The Supabase Edge Function remains the
 * default; `next` generates an App Router route handler and `node` generates a
 * standalone server served through `chumbo/node`. Every target keeps the
 * application's Supabase project as the identity and data plane.
 */
export type SetupTarget = "edge-function" | "next" | "node";

export const SETUP_TARGETS = ["edge-function", "next", "node"] as const;

export interface InitOptions {
  cwd: string;
  functionName: string;
  serverName: string;
  auth: "oauth" | "api-key" | "bearer" | "public";
  consent: "none" | "minimal";
  patchConfig: boolean;
  stateNamespace?: string;
  target?: SetupTarget;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function findSupabaseProject(start: string): Promise<string> {
  let current = resolve(start);
  while (true) {
    if (await exists(join(current, "supabase", "config.toml"))) return current;
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) {
      throw new Error(
        "No supabase/config.toml found. Run this command inside an existing Supabase project.",
      );
    }
    current = parent;
  }
}

export async function findPackageProject(start: string): Promise<string> {
  let current = resolve(start);
  while (true) {
    if (await exists(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) {
      throw new Error(
        "No package.json found. Run this command inside your application repository.",
      );
    }
    current = parent;
  }
}

export async function findProjectRoot(
  cwd: string,
  target: SetupTarget,
): Promise<string> {
  return target === "edge-function"
    ? await findSupabaseProject(cwd)
    : await findPackageProject(cwd);
}

function apiPortFromConfig(source: string): number {
  let inApiSection = false;
  const portAssignment = /^\s*(?:port|"port"|'port')\s*=/;
  const decimalPort =
    /^\s*(?:port|"port"|'port')\s*=\s*(\d(?:[\d_]*\d)?)\s*(?:#.*)?$/;
  for (const line of source.replace(/\r\n/g, "\n").split("\n")) {
    const section = /^\s*\[([^\]]+)]\s*(?:#.*)?$/.exec(line);
    if (section) {
      inApiSection = section[1]?.trim() === "api";
      continue;
    }
    if (!inApiSection || !portAssignment.test(line)) continue;
    const configured = decimalPort.exec(line)?.[1];
    const port = configured
      ? Number(configured.replaceAll("_", ""))
      : Number.NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(
        "supabase/config.toml [api].port must be an integer between 1 and 65535",
      );
    }
    return port;
  }
  return 54_321;
}

export async function resolveLocalMcpEndpoint(
  root: string,
  functionName: string,
): Promise<string> {
  const config = await readFile(join(root, "supabase", "config.toml"), "utf8");
  const port = apiPortFromConfig(config);
  return `http://127.0.0.1:${port}/functions/v1/${functionName}`;
}

/** Development URL where the generated MCP answers for each target. */
export async function resolveTargetLocalEndpoint(
  root: string,
  functionName: string,
  target: SetupTarget,
): Promise<string> {
  if (target === "edge-function") {
    return resolveLocalMcpEndpoint(root, functionName);
  }
  return target === "next"
    ? `http://localhost:3000/${functionName}`
    : `http://127.0.0.1:8080/${functionName}`;
}

/** The package-manager install prefix matching the repository's lockfile. */
export async function packageInstallCommand(root: string): Promise<string> {
  if (await exists(join(root, "pnpm-lock.yaml"))) return "pnpm add";
  if (await exists(join(root, "yarn.lock"))) return "yarn add";
  if (
    (await exists(join(root, "bun.lockb"))) ||
    (await exists(join(root, "bun.lock")))
  ) {
    return "bun add";
  }
  return "npm install";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function patchFunctionConfig(
  source: string,
  functionName: string,
): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const sectionPattern = new RegExp(
    `^\\s*\\[functions\\.${escapeRegExp(functionName)}\\]\\s*$`,
  );
  const sectionIndex = lines.findIndex((line) => sectionPattern.test(line));

  if (sectionIndex === -1) {
    const separator = source.trim().length === 0 ? [] : [""];
    return [
      ...lines.slice(0, lines.at(-1) === "" ? -1 : undefined),
      ...separator,
      `[functions.${functionName}]`,
      "verify_jwt = false",
      "",
    ].join("\n");
  }

  let end = lines.length;
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[index] ?? "")) {
      end = index;
      break;
    }
  }

  const verifyIndex = lines.findIndex(
    (line, index) =>
      index > sectionIndex && index < end && /^\s*verify_jwt\s*=/.test(line),
  );
  if (verifyIndex >= 0) {
    lines[verifyIndex] = "verify_jwt = false";
  } else {
    lines.splice(sectionIndex + 1, 0, "verify_jwt = false");
  }
  return lines.join("\n");
}

async function loadTemplate(name: string): Promise<string> {
  return readFile(new URL(`../templates/${name}`, import.meta.url), "utf8");
}

function render(
  template: string,
  replacements: Record<string, string>,
): string {
  return Object.entries(replacements).reduce(
    (output, [key, value]) => output.replaceAll(`{{${key}}}`, value),
    template,
  );
}

async function classifyFile(
  path: string,
  content: string,
): Promise<PlannedFile> {
  if (!(await exists(path))) return { path, content, status: "create" };
  const current = await readFile(path, "utf8");
  return {
    path,
    content,
    status: current === content ? "unchanged" : "conflict",
  };
}

const RATE_LIMIT_MIGRATION = "20260813000000_create_supa_mcp_rate_limits.sql";
const DURABLE_STATE_MIGRATION =
  "20260826000000_create_supa_mcp_durable_state.sql";

function sharedReplacements(
  options: InitOptions,
  envRead: (name: string) => string,
): Record<string, string> {
  return {
    AUTH_SETUP:
      options.auth === "api-key"
        ? `const mcpApiKey = ${envRead("MCP_API_KEY")};\nif (!mcpApiKey) throw new Error("MCP_API_KEY is not configured");\n`
        : "",
    AUTH_CONFIG:
      options.auth === "public"
        ? '{ mode: "public", rateLimit: true }'
        : options.auth === "oauth"
          ? '{ mode: "oauth", issuer: new URL(`${projectUrl}/auth/v1`) }'
          : options.auth === "api-key"
            ? '{ mode: "api-key", key: mcpApiKey }'
            : '{ mode: "bearer" }',
    ACCESS_DESCRIPTION:
      options.auth === "public"
        ? "Requests use Supabase's anonymous RLS role. The generated Postgres migration adds a 60 request/minute, per-caller guardrail."
        : options.auth === "api-key"
          ? "Requests use your application's API key. Tools receive `ctx.subject` and an anonymous Supabase client; your capability code decides what the key may do."
          : "A request's `ctx.supabase` client carries that user's Supabase access token, so your existing Row Level Security policies decide which rows are visible.",
    FUNCTION_NAME: options.functionName,
    LOCAL_DOCTOR_AUTH:
      options.auth === "public"
        ? ""
        : options.auth === "api-key"
          ? "--token <MCP_API_KEY> \\\n  "
          : "--token <LOCAL_USER_JWT> \\\n  ",
    PACKAGE_VERSION,
    STATE_CONFIG: options.stateNamespace
      ? `  state: {\n    hmacKey: stateHmacKey,\n    namespaces: { ${JSON.stringify(options.stateNamespace)}: { ttlSeconds: 86400 } },\n  },\n`
      : "",
    STATE_SETUP: options.stateNamespace
      ? `const stateHmacKey = ${envRead("CHUMBO_STATE_HMAC_KEY")};\nif (!stateHmacKey) throw new Error("CHUMBO_STATE_HMAC_KEY is not configured");\n`
      : "",
    SERVER_NAME: options.serverName,
  };
}

function validateStateOptions(options: InitOptions): void {
  if (!options.stateNamespace) return;
  if (options.auth === "public") {
    throw new Error("Durable state requires protected authentication");
  }
  validateDurableStateNamespace(options.stateNamespace);
}

async function planEdgeInit(options: InitOptions): Promise<PlannedFile[]> {
  const root = await findSupabaseProject(options.cwd);
  const localEndpoint = await resolveLocalMcpEndpoint(
    root,
    options.functionName,
  );
  validateStateOptions(options);
  const functionDirectory = join(
    root,
    "supabase",
    "functions",
    options.functionName,
  );
  const replacements = {
    ...sharedReplacements(options, (name) => `Deno.env.get("${name}")`),
    API_KEY_SETUP:
      options.auth === "api-key"
        ? '\nFor local development, create the gitignored file `supabase/functions/.env.local`:\n\n```dotenv\nMCP_API_KEY=replace-with-a-long-random-key\n```\n\nLoad it with `npx chumbo dev --function {{FUNCTION_NAME}} --env-file supabase/functions/.env.local`. For the hosted function, set the same secret separately:\n\n```sh\nsupabase secrets set MCP_API_KEY="replace-with-a-long-random-key"\n```\n\nPass that value as `Authorization: Bearer <key>` from MCP clients.\n'
        : "",
    LOCAL_DEV_AUTH:
      options.auth === "api-key"
        ? " --env-file supabase/functions/.env.local"
        : "",
    LOCAL_MIGRATION_COMMAND:
      options.auth === "public" ? "supabase migration up --local\n" : "",
    LOCAL_ENDPOINT: localEndpoint,
    LOCAL_ORIGIN: new URL(localEndpoint).origin,
    PUBLIC_SETUP:
      options.auth === "public"
        ? "\nPublic mode is intentionally anonymous and rate limited. After starting local Supabase, apply the generated migration before probing the function:\n\n```sh\nsupabase migration up --local\n```\n\nApply the same migration to the linked project with `supabase db push` before deployment.\n"
        : "",
    STATE_README: options.stateNamespace
      ? `\nThis function opts into credential-partitioned durable state in the ${JSON.stringify(options.stateNamespace)} namespace. Apply the generated migration, then set a unique deployment HMAC secret before starting or deploying:\n\n\`\`\`sh\nsupabase db push\nsupabase secrets set CHUMBO_STATE_HMAC_KEY=\"replace-with-at-least-32-random-bytes\"\n\`\`\`\n\nThe runtime keeps its service-role client private. Capability code sees only \`ctx.state.get\`, revision-checked \`put\`, and revision-checked \`delete\`.\n`
      : "",
    STATE_TEST_SETUP: options.stateNamespace
      ? 'Deno.env.set("CHUMBO_STATE_HMAC_KEY", "generated-state-test-hmac-key-32-bytes");\nDeno.env.set("SUPABASE_SECRET_KEY", Deno.env.get("SUPABASE_SECRET_KEY") ?? "generated-secret-key");\n'
      : "",
  };
  const templates = [
    ["function/index.ts.tpl", join(functionDirectory, "index.ts")],
    [
      "function/capabilities.ts.tpl",
      join(functionDirectory, "capabilities.ts"),
    ],
    ["function/deno.json.tpl", join(functionDirectory, "deno.json")],
    [
      `function/index_test_${options.auth}.ts.tpl`,
      join(functionDirectory, "index_test.ts"),
    ],
    ["function/README.md.tpl", join(functionDirectory, "README.md")],
  ] as const;

  const files: PlannedFile[] = [];
  for (const [template, path] of templates) {
    files.push(
      await classifyFile(
        path,
        render(await loadTemplate(template), replacements),
      ),
    );
  }

  if (options.auth === "public") {
    const path = join(root, "supabase", "migrations", RATE_LIMIT_MIGRATION);
    files.push(
      await classifyFile(
        path,
        render(
          await loadTemplate("migrations/rate-limit.sql.tpl"),
          replacements,
        ),
      ),
    );
  }

  if (options.stateNamespace) {
    const path = join(root, "supabase", "migrations", DURABLE_STATE_MIGRATION);
    files.push(
      await classifyFile(
        path,
        render(
          await loadTemplate("migrations/durable-state.sql.tpl"),
          replacements,
        ),
      ),
    );
  }

  if (options.consent === "minimal") {
    const consentName = `${options.functionName}-consent`;
    const path = join(root, "supabase", "functions", consentName, "index.ts");
    files.push(
      await classifyFile(
        path,
        render(await loadTemplate("consent/index.ts.tpl"), {
          ...replacements,
          CONSENT_FUNCTION_NAME: consentName,
        }),
      ),
    );
  }

  if (options.patchConfig) {
    const configPath = join(root, "supabase", "config.toml");
    const current = await readFile(configPath, "utf8");
    let content = patchFunctionConfig(current, options.functionName);
    if (options.consent === "minimal") {
      content = patchFunctionConfig(content, `${options.functionName}-consent`);
    }
    files.push({
      path: configPath,
      content,
      status: content === current ? "unchanged" : "update",
    });
  }
  return files;
}

async function readPackageManifest(
  root: string,
): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    throw new Error(
      "package.json could not be read. Run this command inside your application repository.",
    );
  }
}

function hasDependency(
  manifest: Record<string, unknown>,
  name: string,
): boolean {
  for (const field of ["dependencies", "devDependencies"]) {
    const dependencies = manifest[field];
    if (
      dependencies &&
      typeof dependencies === "object" &&
      name in dependencies
    ) {
      return true;
    }
  }
  return false;
}

/** The App Router base directory of a Next.js repository, if present. */
export async function nextAppBase(root: string): Promise<string | undefined> {
  if (await exists(join(root, "src", "app"))) return join("src", "app");
  if (await exists(join(root, "app"))) return "app";
  return undefined;
}

/** Directory holding the generated host-target scaffold for a repository. */
export async function hostScaffoldDirectory(
  root: string,
  functionName: string,
  target: SetupTarget,
): Promise<string> {
  if (target === "next") {
    const base = await nextAppBase(root);
    return join(root, base ?? "app", functionName);
  }
  return join(root, functionName);
}

async function planHostInit(options: InitOptions): Promise<PlannedFile[]> {
  const target = options.target as Exclude<SetupTarget, "edge-function">;
  const root = await findPackageProject(options.cwd);
  validateStateOptions(options);
  if (options.consent === "minimal") {
    throw new Error(
      "The generated consent function targets Supabase Edge Functions. On this target, your application's signed-in UI owns consent.",
    );
  }
  const manifest = await readPackageManifest(root);
  if (target === "next" && !hasDependency(manifest, "next")) {
    throw new Error(
      "--target next requires a Next.js application: package.json does not list a 'next' dependency.",
    );
  }
  let scaffoldDirectory: string;
  let entryTemplate: string;
  let entryPath: string;
  let readmeTemplate: string;
  if (target === "next") {
    const base = await nextAppBase(root);
    if (!base) {
      throw new Error(
        "No App Router directory was found. Create app/ or src/app/, or use --target node for a standalone server.",
      );
    }
    scaffoldDirectory = join(root, base, options.functionName);
    entryTemplate = "host/next-route.ts.tpl";
    entryPath = join(scaffoldDirectory, "[[...path]]", "route.ts");
    readmeTemplate = "host/next-README.md.tpl";
  } else {
    scaffoldDirectory = join(root, options.functionName);
    entryTemplate = "host/node-index.ts.tpl";
    entryPath = join(scaffoldDirectory, "index.ts");
    readmeTemplate = "host/node-README.md.tpl";
  }

  const localEndpoint = await resolveTargetLocalEndpoint(
    root,
    options.functionName,
    target,
  );
  const installCommand = await packageInstallCommand(root);
  const hasSupabaseConfig = await exists(join(root, "supabase", "config.toml"));
  const migrationDirectory = hasSupabaseConfig
    ? join(root, "supabase", "migrations")
    : join(scaffoldDirectory, "migrations");
  const applyMigrationInstruction = hasSupabaseConfig
    ? "Apply it to your Supabase project with `supabase db push`."
    : "Apply it to your Supabase project through the SQL editor or `psql` before serving traffic.";

  const envLines: string[] = [];
  if (options.auth === "api-key") {
    envLines.push("MCP_API_KEY=replace-with-a-long-random-key");
  }
  if (options.auth === "public") {
    envLines.push("SUPABASE_SECRET_KEY=your-secret-or-service-role-key");
  }
  if (options.stateNamespace) {
    envLines.push(
      "CHUMBO_STATE_HMAC_KEY=replace-with-at-least-32-random-bytes",
      "SUPABASE_SECRET_KEY=your-secret-or-service-role-key",
    );
  }
  const migrationNotes: string[] = [];
  if (options.auth === "public") {
    migrationNotes.push(
      `Public mode is intentionally anonymous and rate limited. The endpoint returns 503 until the generated \`${RATE_LIMIT_MIGRATION}\` migration is installed. ${applyMigrationInstruction}`,
    );
  }
  if (options.stateNamespace) {
    migrationNotes.push(
      `Durable state stays unavailable until the generated \`${DURABLE_STATE_MIGRATION}\` migration is installed. ${applyMigrationInstruction} The runtime keeps its service-role client private; capability code sees only \`ctx.state.get\`, revision-checked \`put\`, and revision-checked \`delete\`.`,
    );
  }

  const replacements = {
    ...sharedReplacements(options, (name) => `process.env.${name}`),
    HOST_ENV_SETUP: envLines.length > 0 ? `${envLines.join("\n")}\n` : "",
    HOST_MIGRATION_SETUP:
      migrationNotes.length > 0
        ? `\n${migrationNotes.map((note) => `${note}\n`).join("\n")}`
        : "",
    INSTALL_COMMAND: installCommand,
    LOCAL_ENDPOINT: localEndpoint,
  };

  const files: PlannedFile[] = [
    await classifyFile(
      entryPath,
      render(await loadTemplate(entryTemplate), replacements),
    ),
    await classifyFile(
      join(scaffoldDirectory, "capabilities.ts"),
      render(await loadTemplate("function/capabilities.ts.tpl"), replacements),
    ),
    await classifyFile(
      join(scaffoldDirectory, "README.md"),
      render(await loadTemplate(readmeTemplate), replacements),
    ),
  ];

  if (options.auth === "public") {
    files.push(
      await classifyFile(
        join(migrationDirectory, RATE_LIMIT_MIGRATION),
        render(
          await loadTemplate("migrations/rate-limit.sql.tpl"),
          replacements,
        ),
      ),
    );
  }
  if (options.stateNamespace) {
    files.push(
      await classifyFile(
        join(migrationDirectory, DURABLE_STATE_MIGRATION),
        render(
          await loadTemplate("migrations/durable-state.sql.tpl"),
          replacements,
        ),
      ),
    );
  }
  return files;
}

export async function planInit(options: InitOptions): Promise<PlannedFile[]> {
  const target = options.target ?? "edge-function";
  return target === "edge-function"
    ? planEdgeInit(options)
    : planHostInit({ ...options, target });
}

export async function applyPlan(files: readonly PlannedFile[]): Promise<void> {
  const conflicts = files.filter((file) => file.status === "conflict");
  if (conflicts.length > 0) {
    throw new Error(
      `Refusing to overwrite existing files:\n${conflicts.map((file) => `- ${file.path}`).join("\n")}`,
    );
  }
  for (const file of files) {
    if (file.status === "unchanged") continue;
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, "utf8");
  }
}

export function displayPlan(
  files: readonly PlannedFile[],
  root: string,
): string {
  return files
    .map((file) => `${file.status.padEnd(9)} ${relative(root, file.path)}`)
    .join("\n");
}
