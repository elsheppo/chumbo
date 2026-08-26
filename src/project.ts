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

export interface InitOptions {
  cwd: string;
  functionName: string;
  serverName: string;
  auth: "oauth" | "api-key" | "bearer" | "public";
  consent: "none" | "minimal";
  patchConfig: boolean;
  stateNamespace?: string;
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

export async function planInit(options: InitOptions): Promise<PlannedFile[]> {
  const root = await findSupabaseProject(options.cwd);
  if (options.stateNamespace) {
    if (options.auth === "public") {
      throw new Error("Durable state requires protected authentication");
    }
    validateDurableStateNamespace(options.stateNamespace);
  }
  const functionDirectory = join(
    root,
    "supabase",
    "functions",
    options.functionName,
  );
  const replacements = {
    AUTH_SETUP:
      options.auth === "api-key"
        ? 'const mcpApiKey = Deno.env.get("MCP_API_KEY");\nif (!mcpApiKey) throw new Error("MCP_API_KEY is not configured");\n'
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
    API_KEY_SETUP:
      options.auth === "api-key"
        ? '\nSet one Edge Function secret before local development or deployment:\n\n```sh\nsupabase secrets set MCP_API_KEY="replace-with-a-long-random-key"\n```\n\nPass that value as `Authorization: Bearer <key>` from MCP clients.\n'
        : "",
    FUNCTION_NAME: options.functionName,
    PACKAGE_VERSION,
    PUBLIC_SETUP:
      options.auth === "public"
        ? "\nPublic mode is intentionally anonymous and rate limited. Apply the generated migration before starting the function:\n\n```sh\nsupabase db push\n```\n"
        : "",
    STATE_CONFIG: options.stateNamespace
      ? `  state: {\n    hmacKey: stateHmacKey,\n    namespaces: { ${JSON.stringify(options.stateNamespace)}: { ttlSeconds: 86400 } },\n  },\n`
      : "",
    STATE_README: options.stateNamespace
      ? `\nThis function opts into credential-partitioned durable state in the ${JSON.stringify(options.stateNamespace)} namespace. Apply the generated migration, then set a unique deployment HMAC secret before starting or deploying:\n\n\`\`\`sh\nsupabase db push\nsupabase secrets set SUPA_MCP_STATE_HMAC_KEY=\"replace-with-at-least-32-random-bytes\"\n\`\`\`\n\nThe runtime keeps its service-role client private. Capability code sees only \`ctx.state.get\`, revision-checked \`put\`, and revision-checked \`delete\`.\n`
      : "",
    STATE_SETUP: options.stateNamespace
      ? 'const stateHmacKey = Deno.env.get("SUPA_MCP_STATE_HMAC_KEY");\nif (!stateHmacKey) throw new Error("SUPA_MCP_STATE_HMAC_KEY is not configured");\n'
      : "",
    STATE_TEST_SETUP: options.stateNamespace
      ? 'Deno.env.set("SUPA_MCP_STATE_HMAC_KEY", "generated-state-test-hmac-key-32-bytes");\nDeno.env.set("SUPABASE_SECRET_KEY", Deno.env.get("SUPABASE_SECRET_KEY") ?? "generated-secret-key");\n'
      : "",
    SERVER_NAME: options.serverName,
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
    const path = join(
      root,
      "supabase",
      "migrations",
      "20260813000000_create_supa_mcp_rate_limits.sql",
    );
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
    const path = join(
      root,
      "supabase",
      "migrations",
      "20260826000000_create_supa_mcp_durable_state.sql",
    );
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
