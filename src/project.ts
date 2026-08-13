import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, parse, relative, resolve } from "node:path";

export const PACKAGE_VERSION = "0.1.1";

export interface PlannedFile {
  path: string;
  content: string;
  status: "create" | "unchanged" | "update" | "conflict";
}

export interface InitOptions {
  cwd: string;
  functionName: string;
  serverName: string;
  auth: "oauth" | "bearer" | "public";
  consent: "none" | "minimal";
  patchConfig: boolean;
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
  const functionDirectory = join(
    root,
    "supabase",
    "functions",
    options.functionName,
  );
  const replacements = {
    AUTH_MODE: options.auth,
    FUNCTION_NAME: options.functionName,
    PACKAGE_VERSION,
    SERVER_NAME: options.serverName,
  };
  const templates = [
    ["function/index.ts.tpl", join(functionDirectory, "index.ts")],
    [
      "function/capabilities.ts.tpl",
      join(functionDirectory, "capabilities.ts"),
    ],
    ["function/deno.json.tpl", join(functionDirectory, "deno.json")],
    ["function/index_test.ts.tpl", join(functionDirectory, "index_test.ts")],
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
