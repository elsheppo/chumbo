import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Catalog entry read from a starter's `starter.json`. */
export interface StarterManifest {
  id: string;
  title: string;
  summary: string;
  auth: "oauth" | "api-key" | "bearer" | "public";
  function: string;
  serverName: string;
  frontend: string;
  tools: string[];
  demoUsers: Array<{ email: string; password: string }>;
}

export interface CreateStarterResult {
  starter: StarterManifest;
  directory: string;
  files: string[];
}

export const DEFAULT_STARTERS_ROOT = fileURLToPath(
  new URL("../starters/", import.meta.url),
);

// Local state that must never travel with a starter, even when a maintainer
// has run it in place inside the Chumbo repository.
const EXCLUDED_NAMES = new Set([
  "node_modules",
  "dist",
  ".DS_Store",
  ".temp",
  ".branches",
]);
// npm drops .gitignore from published packages, so starters carry _gitignore.
const RENAMED: Record<string, string> = { _gitignore: ".gitignore" };

function excluded(name: string): boolean {
  if (EXCLUDED_NAMES.has(name)) return true;
  return name.startsWith(".env") && name !== ".env.example";
}

function isManifest(value: unknown): value is StarterManifest {
  const candidate = value as Partial<StarterManifest> | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.id === "string" &&
    /^[a-z][a-z0-9-]*$/.test(candidate.id) &&
    typeof candidate.title === "string" &&
    typeof candidate.summary === "string" &&
    typeof candidate.function === "string" &&
    typeof candidate.serverName === "string" &&
    typeof candidate.frontend === "string" &&
    ["oauth", "api-key", "bearer", "public"].includes(
      candidate.auth as string,
    ) &&
    Array.isArray(candidate.tools) &&
    Array.isArray(candidate.demoUsers)
  );
}

export async function listStarters(
  root: string = DEFAULT_STARTERS_ROOT,
): Promise<StarterManifest[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const starters: StarterManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(root, entry.name, "starter.json");
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      continue;
    }
    if (!isManifest(manifest) || manifest.id !== entry.name) {
      throw new Error(`Invalid starter manifest: ${manifestPath}`);
    }
    starters.push(manifest);
  }
  return starters.sort((a, b) => a.id.localeCompare(b.id));
}

async function listFiles(root: string, directory = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, path)));
    else if (entry.isFile()) files.push(relative(root, path));
  }
  return files.sort();
}

function destinationPath(file: string): string {
  const name = basename(file);
  const renamed = RENAMED[name];
  return renamed ? join(file.slice(0, -name.length), renamed) : file;
}

/** Supabase uses project_id to name local Docker containers and volumes. */
export function projectIdFor(directory: string): string {
  const slug = basename(resolve(directory))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "chumbo-starter";
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function createStarter(options: {
  starter: string;
  directory: string;
  force?: boolean;
  startersRoot?: string;
}): Promise<CreateStarterResult> {
  const startersRoot = options.startersRoot ?? DEFAULT_STARTERS_ROOT;
  const starters = await listStarters(startersRoot);
  const starter = starters.find(({ id }) => id === options.starter);
  if (!starter) {
    throw new Error(
      `Unknown starter "${options.starter}". Available: ${starters.map(({ id }) => id).join(", ")}`,
    );
  }
  const target = resolve(options.directory);
  if (await exists(target)) {
    const info = await stat(target);
    if (!info.isDirectory()) {
      throw new Error(`${options.directory} exists and is not a directory`);
    }
    if ((await readdir(target)).length > 0 && !options.force) {
      throw new Error(
        `${options.directory} is not empty. Choose a new directory, or pass --force to add the starter without overwriting existing files.`,
      );
    }
  }

  const source = join(startersRoot, starter.id);
  const files = await listFiles(source);
  const planned = files.map((file) => ({
    from: join(source, file),
    to: destinationPath(file),
  }));
  const conflicts: string[] = [];
  for (const { to } of planned) {
    if (await exists(join(target, to))) conflicts.push(to);
  }
  if (conflicts.length > 0) {
    throw new Error(
      `Refusing to overwrite existing files: ${conflicts.join(", ")}`,
    );
  }

  const projectId = projectIdFor(target);
  for (const { from, to } of planned) {
    const destination = join(target, to);
    await mkdir(resolve(destination, ".."), { recursive: true });
    if (to === join("supabase", "config.toml")) {
      const config = await readFile(from, "utf8");
      await writeFile(
        destination,
        config.replace(
          /^project_id\s*=\s*".*"$/m,
          `project_id = "${projectId}"`,
        ),
      );
    } else {
      await copyFile(from, destination);
    }
  }
  return { starter, directory: target, files: planned.map(({ to }) => to) };
}

export function starterNextSteps(
  result: CreateStarterResult,
  displayDirectory: string,
): string[] {
  const [user] = result.starter.demoUsers;
  return [
    `cd ${displayDirectory}`,
    "npm run setup        # install the web app's dependencies",
    "supabase start       # local Postgres, Auth, and the OAuth server, with demo data",
    "npm run dev          # web app on http://127.0.0.1:5173 + the MCP function",
    ...(user
      ? [
          `Sign in as ${user.email} / ${user.password}, then follow "Connect an agent".`,
        ]
      : []),
  ];
}
