import { createHmac, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { CliToolDescriptor } from "./cli-surface.js";

export const DEFAULT_DISCOVERY_CACHE_TTL_MS = 60_000;
export const MAX_DISCOVERY_CACHE_TTL_MS = 300_000;
export const MAX_DISCOVERY_CACHE_BYTES = 524_288;
export const MAX_DISCOVERY_CACHE_ENTRIES = 64;

const CACHE_DOMAIN = "chumbo-cli-discovery@1";
const SALT_FILE_NAME = "cache-salt.key";
const SALT_BYTES = 32;

export interface DiscoveryCachePartitionInput {
  readonly endpoint: string;
  readonly credentialKind: "static" | "oauth" | "public";
  readonly headerName: string;
  readonly credentialMaterial: string;
}

export interface BrandedCliDiscoveryCache {
  read(
    partition: DiscoveryCachePartitionInput,
  ): Promise<readonly CliToolDescriptor[] | undefined>;
  write(
    partition: DiscoveryCachePartitionInput,
    tools: readonly CliToolDescriptor[],
    ttlMs?: number,
  ): Promise<void>;
  invalidate(partition: DiscoveryCachePartitionInput): Promise<void>;
  purgeAll(): Promise<void>;
}

interface StoredDiscoveryCacheEntry {
  readonly schemaVersion: 1;
  readonly cachedAtMs: number;
  readonly expiresAtMs: number;
  readonly tools: readonly CliToolDescriptor[];
}

export function clampDiscoveryCacheTtlMs(ttlMs: number | undefined): number {
  const raw = ttlMs ?? DEFAULT_DISCOVERY_CACHE_TTL_MS;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Math.floor(raw), MAX_DISCOVERY_CACHE_TTL_MS);
}

export function defaultDiscoveryCacheDirectory(
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  if (platform === "darwin") {
    return join(home, "Library", "Caches", "chumbo", "cli-discovery");
  }
  if (platform === "win32") {
    const base = env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local");
    return join(base, "chumbo", "cli-discovery");
  }
  const base = env.XDG_CACHE_HOME?.trim() || join(home, ".cache");
  return join(base, "chumbo", "cli-discovery");
}

let tempCounter = 0;

async function atomicWriteSecure(
  targetPath: string,
  content: string | Buffer,
): Promise<void> {
  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tempPath = join(
    dir,
    `.${basename(targetPath)}.tmp-${process.pid}-${tempCounter++}`,
  );
  try {
    await writeFile(tempPath, content, { mode: 0o600 });
    await chmod(tempPath, 0o600).catch(() => undefined);
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isValidToolDescriptor(value: unknown): value is CliToolDescriptor {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { name?: unknown }).name === "string" &&
    (value as { name: string }).name.length > 0
  );
}

export interface FileDiscoveryCacheOptions {
  readonly directory?: string;
  readonly defaultTtlMs?: number;
  readonly now?: () => number;
}

/**
 * Bounded, HMAC-salted filesystem cache for `tools/list` discovery metadata.
 * Stores zero credentials, URLs, issuers, or tool invocation outputs on disk.
 */
export class FileDiscoveryCache implements BrandedCliDiscoveryCache {
  private readonly directory: string;
  private readonly defaultTtlMs: number;
  private readonly now: () => number;

  constructor(options: FileDiscoveryCacheOptions = {}) {
    this.directory = options.directory ?? defaultDiscoveryCacheDirectory();
    this.defaultTtlMs = clampDiscoveryCacheTtlMs(options.defaultTtlMs);
    this.now = options.now ?? Date.now;
  }

  private saltPath(): string {
    return join(this.directory, SALT_FILE_NAME);
  }

  private async ensureSalt(rotate = false): Promise<Buffer> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!rotate) {
      try {
        const existing = await readFile(this.saltPath());
        if (existing.byteLength === SALT_BYTES) return existing;
      } catch {
        /* generate fresh salt */
      }
    }
    const fresh = randomBytes(SALT_BYTES);
    await atomicWriteSecure(this.saltPath(), fresh);
    return fresh;
  }

  private computePartitionId(
    salt: Buffer,
    partition: DiscoveryCachePartitionInput,
  ): string {
    const canonicalEndpoint = new URL(partition.endpoint).href;
    return createHmac("sha256", salt)
      .update(
        [
          CACHE_DOMAIN,
          canonicalEndpoint,
          partition.credentialKind,
          partition.headerName.toLowerCase(),
          partition.credentialMaterial,
        ].join("\u0000"),
      )
      .digest("hex");
  }

  private entryPath(partitionId: string): string {
    return join(this.directory, `${partitionId}.json`);
  }

  async read(
    partition: DiscoveryCachePartitionInput,
  ): Promise<readonly CliToolDescriptor[] | undefined> {
    if (this.defaultTtlMs <= 0) return undefined;
    try {
      const salt = await readFile(this.saltPath());
      if (salt.byteLength !== SALT_BYTES) return undefined;
      const path = this.entryPath(this.computePartitionId(salt, partition));
      const raw = await readFile(path, "utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_DISCOVERY_CACHE_BYTES) {
        await rm(path, { force: true }).catch(() => undefined);
        return undefined;
      }
      const parsed = JSON.parse(raw) as Partial<StoredDiscoveryCacheEntry>;
      if (
        parsed.schemaVersion !== 1 ||
        typeof parsed.cachedAtMs !== "number" ||
        typeof parsed.expiresAtMs !== "number" ||
        !Array.isArray(parsed.tools) ||
        !parsed.tools.every(isValidToolDescriptor)
      ) {
        await rm(path, { force: true }).catch(() => undefined);
        return undefined;
      }
      if (this.now() >= parsed.expiresAtMs) {
        await rm(path, { force: true }).catch(() => undefined);
        return undefined;
      }
      return Object.freeze([...parsed.tools]);
    } catch {
      return undefined;
    }
  }

  async write(
    partition: DiscoveryCachePartitionInput,
    tools: readonly CliToolDescriptor[],
    ttlMs?: number,
  ): Promise<void> {
    const effectiveTtl = clampDiscoveryCacheTtlMs(ttlMs ?? this.defaultTtlMs);
    if (effectiveTtl <= 0) return;
    try {
      const salt = await this.ensureSalt(false);
      const cachedAtMs = this.now();
      const entry: StoredDiscoveryCacheEntry = {
        schemaVersion: 1,
        cachedAtMs,
        expiresAtMs: cachedAtMs + effectiveTtl,
        tools,
      };
      const serialized = `${JSON.stringify(entry)}\n`;
      if (Buffer.byteLength(serialized, "utf8") > MAX_DISCOVERY_CACHE_BYTES) {
        return;
      }
      const path = this.entryPath(this.computePartitionId(salt, partition));
      await atomicWriteSecure(path, serialized);
      await this.pruneIfNeeded();
    } catch {
      /* read-only or unavailable cache filesystem degrades to live discovery */
    }
  }

  async invalidate(partition: DiscoveryCachePartitionInput): Promise<void> {
    try {
      const salt = await readFile(this.saltPath());
      if (salt.byteLength !== SALT_BYTES) return;
      const path = this.entryPath(this.computePartitionId(salt, partition));
      await rm(path, { force: true });
    } catch {
      /* ignore missing cache */
    }
  }

  async purgeAll(): Promise<void> {
    try {
      const entries = await readdir(this.directory, { withFileTypes: true });
      await Promise.all(
        entries
          .filter(
            (entry) =>
              entry.isFile() &&
              (entry.name.endsWith(".json") || entry.name === SALT_FILE_NAME),
          )
          .map((entry) =>
            rm(join(this.directory, entry.name), { force: true }),
          ),
      );
      await this.ensureSalt(true);
    } catch {
      /* ignore missing or read-only directory */
    }
  }

  private async pruneIfNeeded(): Promise<void> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const jsonFiles = entries.filter(
      (entry) => entry.isFile() && /^[0-9a-f]{64}\.json$/u.test(entry.name),
    );
    if (jsonFiles.length <= MAX_DISCOVERY_CACHE_ENTRIES) return;

    const nowMs = this.now();
    const inspected: Array<{
      path: string;
      cachedAtMs: number;
      expired: boolean;
    }> = [];
    for (const file of jsonFiles) {
      const fullPath = join(this.directory, file.name);
      try {
        const parsed = JSON.parse(
          await readFile(fullPath, "utf8"),
        ) as Partial<StoredDiscoveryCacheEntry>;
        const cachedAtMs =
          typeof parsed.cachedAtMs === "number" ? parsed.cachedAtMs : 0;
        const expired =
          typeof parsed.expiresAtMs !== "number" || nowMs >= parsed.expiresAtMs;
        inspected.push({ path: fullPath, cachedAtMs, expired });
      } catch {
        inspected.push({ path: fullPath, cachedAtMs: 0, expired: true });
      }
    }

    inspected.sort((left, right) => {
      if (left.expired !== right.expired) return left.expired ? -1 : 1;
      return left.cachedAtMs - right.cachedAtMs;
    });

    const excess = inspected.length - MAX_DISCOVERY_CACHE_ENTRIES;
    const toRemove = inspected.filter(
      (item, index) => item.expired || index < excess,
    );
    await Promise.all(
      toRemove.map((item) =>
        rm(item.path, { force: true }).catch(() => undefined),
      ),
    );
  }
}
