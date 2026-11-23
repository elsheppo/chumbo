import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isLoopbackHost } from "./doctor-http.js";

const execFileAsync = promisify(execFile);

export const MAX_LOCAL_PERSONAS = 4;
const LOCAL_STATUS_TIMEOUT_MS = 5_000;
const SEED_LIST_TIMEOUT_MS = 1_500;
const LIST_USERS_PAGE_SIZE = 200;
const LIST_USERS_MAX_PAGES = 10;
const SHORT_LIVED_JWT_TTL_SECONDS = 300;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENV_VAR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type PersonaKind =
  | "supabase-user"
  | "ephemeral-user"
  | "api-key"
  | "env"
  | "anon"
  | "explicit-token";

export interface PersonaDescriptor {
  readonly specifier: string;
  readonly kind: PersonaKind;
  readonly userId?: string;
  readonly email?: string | null;
  readonly scopes: readonly string[];
}

/**
 * Resolved persona whose credential stays closure-private behind `getToken()`
 * so `JSON.stringify(persona.descriptor)` can never leak JWTs or secret keys.
 */
export interface ResolvedLocalPersona {
  readonly descriptor: PersonaDescriptor;
  getToken(): string | undefined;
  cleanup(): Promise<void>;
}

export interface LocalSupabaseStack {
  readonly apiUrl: string;
  readonly publishableKey: string;
  readonly secretKey: string;
}

export interface LocalSeedUserSummary {
  readonly id: string;
  readonly email: string | null;
}

export interface LocalPersonaDeps {
  readSupabaseStatus?(
    projectRoot: string,
    timeoutMs: number,
  ): Promise<Record<string, unknown>>;
  createAdminClient?(apiUrl: string, secretKey: string): SupabaseClient;
  createAnonClient?(apiUrl: string, publishableKey: string): SupabaseClient;
  readFileUtf8?(path: string): Promise<string>;
  env?: Readonly<Record<string, string | undefined>>;
  nowSeconds?(): number;
}

export interface ResolveLocalPersonasOptions {
  readonly projectRoot?: string;
  readonly endpointUrl: string;
  readonly specifiers: readonly string[];
  readonly ephemeralUsers?: boolean;
  readonly envFile?: string;
  readonly scopes?: readonly string[];
  readonly deps?: LocalPersonaDeps;
}

/**
 * Gate 1: Refuse any non-loopback endpoint before inspecting local Supabase or
 * opening sockets. Local persona switching is strictly forbidden against hosted
 * or remote MCP deployments.
 */
export function assertLoopbackEndpoint(
  endpointUrl: string,
  flagName = "--as",
): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    throw new Error(
      `Invalid MCP endpoint URL '${endpointUrl}'. Pass a valid http://127.0.0.1 or http://localhost URL.`,
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !isLoopbackHost(parsed.hostname)
  ) {
    throw new Error(
      `${flagName} signs in local Supabase seed users and refuses non-loopback URL '${endpointUrl}'. Pass --token and --second-token to probe a deployed endpoint.`,
    );
  }
  return parsed;
}

async function defaultReadSupabaseStatus(
  projectRoot: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      "supabase",
      ["status", "--output", "json"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: timeoutMs,
      },
    );
    stdout = result.stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Local Supabase stack did not report status (${detail}). Run \`supabase start\` in this project, then retry.`,
    );
  }
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(
      "Could not parse JSON output from `supabase status --output json`.",
    );
  }
}

/**
 * Gate 2: Resolve local stack credentials ONLY from `supabase status --output json`
 * and verify `API_URL` is a loopback host. Ambient `process.env.SUPABASE_SECRET_KEY`
 * / `SUPABASE_SERVICE_ROLE_KEY` are intentionally ignored so hosted production keys
 * in a developer's shell can never be touched.
 */
export async function resolveLocalSupabaseStack(
  projectRoot: string,
  deps?: LocalPersonaDeps,
  timeoutMs = LOCAL_STATUS_TIMEOUT_MS,
): Promise<LocalSupabaseStack> {
  const status = await (deps?.readSupabaseStatus ?? defaultReadSupabaseStatus)(
    projectRoot,
    timeoutMs,
  );
  const apiUrl =
    typeof status.API_URL === "string" ? status.API_URL.trim() : "";
  if (!apiUrl) {
    throw new Error(
      "Local `supabase status --output json` did not report API_URL. Run `supabase start`, then retry.",
    );
  }
  let parsedApi: URL;
  try {
    parsedApi = new URL(apiUrl);
  } catch {
    throw new Error(`Local Supabase API_URL '${apiUrl}' is not a valid URL.`);
  }
  if (!isLoopbackHost(parsedApi.hostname)) {
    throw new Error(
      `Refusing to use non-loopback Supabase API_URL '${apiUrl}' for local persona sign-in.`,
    );
  }
  const publishableKey =
    (typeof status.PUBLISHABLE_KEY === "string" && status.PUBLISHABLE_KEY) ||
    (typeof status.ANON_KEY === "string" && status.ANON_KEY) ||
    "";
  const secretKey =
    (typeof status.SECRET_KEY === "string" && status.SECRET_KEY) ||
    (typeof status.SERVICE_ROLE_KEY === "string" && status.SERVICE_ROLE_KEY) ||
    "";
  if (!publishableKey || !secretKey) {
    throw new Error(
      "Local Supabase status is missing PUBLISHABLE_KEY/ANON_KEY or SECRET_KEY/SERVICE_ROLE_KEY.",
    );
  }
  return Object.freeze({
    apiUrl: apiUrl.replace(/\/+$/, ""),
    publishableKey,
    secretKey,
  });
}

function defaultCreateClient(url: string, key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function parseDotEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) values[key] = value;
  }
  return values;
}

async function readEnvVariable(
  varName: string,
  options: {
    projectRoot?: string;
    envFile?: string;
    deps?: LocalPersonaDeps;
  },
): Promise<string | undefined> {
  const reader =
    options.deps?.readFileUtf8 ?? ((path: string) => readFile(path, "utf8"));
  const candidateFiles: string[] = [];
  if (options.envFile) {
    candidateFiles.push(
      isAbsolute(options.envFile)
        ? options.envFile
        : resolve(options.projectRoot ?? process.cwd(), options.envFile),
    );
  }
  if (options.projectRoot) {
    candidateFiles.push(
      join(options.projectRoot, "supabase", "functions", ".env.local"),
    );
  }
  for (const filePath of candidateFiles) {
    try {
      const parsed = parseDotEnv(await reader(filePath));
      if (parsed[varName]) return parsed[varName];
    } catch {
      // Optional env file not present.
    }
  }
  const envMap = options.deps?.env ?? process.env;
  const fromEnv = envMap[varName];
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function extractSigningKeysPath(configToml: string): string | undefined {
  let inAuthSection = false;
  for (const line of configToml.replace(/\r\n/g, "\n").split("\n")) {
    const section = /^\s*\[([^\]]+)]\s*(?:#.*)?$/.exec(line);
    if (section) {
      inAuthSection = section[1]?.trim() === "auth";
      continue;
    }
    if (!inAuthSection) continue;
    const match = /^\s*signing_keys_path\s*=\s*["']([^"']+)["']/.exec(line);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

interface LocalPrivateJwk extends JsonWebKey {
  readonly kid?: string;
  readonly alg?: string;
}

async function mintShortLivedLocalJwt(options: {
  projectRoot: string;
  apiUrl: string;
  userId: string;
  email: string | null;
  scopes: readonly string[];
  deps?: LocalPersonaDeps;
}): Promise<string> {
  const reader =
    options.deps?.readFileUtf8 ?? ((path: string) => readFile(path, "utf8"));
  const configPath = join(options.projectRoot, "supabase", "config.toml");
  let configSource = "";
  try {
    configSource = await reader(configPath);
  } catch {
    // Handled below.
  }
  const relativeKeysPath = extractSigningKeysPath(configSource);
  if (!relativeKeysPath) {
    throw new Error(
      "Minting custom-scoped or email-less local test JWTs requires [auth].signing_keys_path in supabase/config.toml. Run `supabase gen signing-key --algorithm ES256`, or resolve scopes from Postgres via `access.resolveScopes`.",
    );
  }
  const resolvedKeysPath = isAbsolute(relativeKeysPath)
    ? relativeKeysPath
    : resolve(dirname(configPath), relativeKeysPath);

  let parsedKeys: unknown;
  try {
    parsedKeys = JSON.parse(await reader(resolvedKeysPath));
  } catch {
    throw new Error(
      `Could not read local signing keys at '${resolvedKeysPath}'. Check [auth].signing_keys_path in supabase/config.toml.`,
    );
  }
  const keyList: LocalPrivateJwk[] = Array.isArray(parsedKeys)
    ? (parsedKeys as LocalPrivateJwk[])
    : parsedKeys &&
        typeof parsedKeys === "object" &&
        Array.isArray((parsedKeys as { keys?: unknown }).keys)
      ? ((parsedKeys as { keys: LocalPrivateJwk[] }).keys ?? [])
      : [];

  const privateKey = keyList.find(
    (jwk) =>
      (jwk.kty === "EC" && jwk.crv === "P-256" && typeof jwk.d === "string") ||
      (jwk.kty === "RSA" && typeof jwk.d === "string"),
  );
  if (!privateKey) {
    throw new Error(
      `No private ES256 or RS256 JWK found in '${resolvedKeysPath}'. Generate one with \`supabase gen signing-key --algorithm ES256\`.`,
    );
  }

  const isEc = privateKey.kty === "EC";
  const alg = isEc ? "ES256" : "RS256";
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "jwk",
    privateKey,
    isEc
      ? { name: "ECDSA", namedCurve: "P-256" }
      : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const now = options.deps?.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
  const header = {
    alg,
    typ: "JWT",
    ...(privateKey.kid ? { kid: privateKey.kid } : {}),
  };
  const payload = {
    iss: `${options.apiUrl}/auth/v1`,
    sub: options.userId,
    aud: "authenticated",
    role: "authenticated",
    ...(options.email ? { email: options.email } : {}),
    ...(options.scopes.length > 0 ? { scope: options.scopes.join(" ") } : {}),
    iat: now,
    exp: now + SHORT_LIVED_JWT_TTL_SECONDS,
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = await globalThis.crypto.subtle.sign(
    isEc ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" },
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function listAllLocalUsers(
  admin: SupabaseClient,
): Promise<LocalSeedUserSummary[]> {
  const users: LocalSeedUserSummary[] = [];
  for (let page = 1; page <= LIST_USERS_MAX_PAGES; page += 1) {
    const result = await admin.auth.admin.listUsers({
      page,
      perPage: LIST_USERS_PAGE_SIZE,
    });
    if (result.error) {
      throw new Error(
        `Could not list local Supabase users: ${result.error.message}`,
      );
    }
    const batch = result.data?.users ?? [];
    for (const entry of batch) {
      users.push({ id: entry.id, email: entry.email ?? null });
    }
    if (batch.length < LIST_USERS_PAGE_SIZE) break;
  }
  return users;
}

/**
 * Strictly read-only seed user discovery for `chumbo dev` startup banners and
 * `--workbench` persona pickers. Never mutates `auth.users` or creates sessions.
 */
export async function listLocalSeedUsers(
  projectRoot: string,
  deps?: LocalPersonaDeps,
): Promise<readonly LocalSeedUserSummary[]> {
  const stack = await resolveLocalSupabaseStack(
    projectRoot,
    deps,
    SEED_LIST_TIMEOUT_MS,
  );
  const admin = (deps?.createAdminClient ?? defaultCreateClient)(
    stack.apiUrl,
    stack.secretKey,
  );
  const result = await admin.auth.admin.listUsers({ page: 1, perPage: 10 });
  if (result.error) return [];
  return Object.freeze(
    (result.data?.users ?? []).map((entry) =>
      Object.freeze({ id: entry.id, email: entry.email ?? null }),
    ),
  );
}

function sanitizeEphemeralSlug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return cleaned || "persona";
}

/**
 * Resolves 1..4 local personas against a loopback MCP endpoint and local
 * Supabase stack without introducing any runtime auth bypass.
 */
export async function resolveLocalPersonas(
  options: ResolveLocalPersonasOptions,
): Promise<readonly ResolvedLocalPersona[]> {
  const specs = options.specifiers
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (specs.length === 0) {
    throw new Error("At least one persona is required for --as.");
  }
  if (specs.length > MAX_LOCAL_PERSONAS) {
    throw new Error(
      `--as accepts at most ${MAX_LOCAL_PERSONAS} personas per run.`,
    );
  }

  // Gate 1: Always require loopback endpoint when --as or --ephemeral-users is used.
  assertLoopbackEndpoint(
    options.endpointUrl,
    options.ephemeralUsers ? "--ephemeral-users" : "--as",
  );

  const requestedScopes = [
    ...new Set((options.scopes ?? []).map((s) => s.trim()).filter(Boolean)),
  ];

  const needsSupabase = specs.some(
    (spec) => spec !== "anon" && spec !== "api-key" && !spec.startsWith("env:"),
  );

  let stack: LocalSupabaseStack | undefined;
  let admin: SupabaseClient | undefined;
  let cachedUsers: LocalSeedUserSummary[] | undefined;

  const ensureSupabase = async (): Promise<{
    stack: LocalSupabaseStack;
    admin: SupabaseClient;
  }> => {
    if (!options.projectRoot) {
      throw new Error(
        "Resolving Supabase seed users with --as requires a local supabase/config.toml project. Run inside your Supabase project, or pass --token and --second-token.",
      );
    }
    if (!stack) {
      stack = await resolveLocalSupabaseStack(
        options.projectRoot,
        options.deps,
      );
      admin = (options.deps?.createAdminClient ?? defaultCreateClient)(
        stack.apiUrl,
        stack.secretKey,
      );
    }
    return { stack, admin: admin! };
  };

  const resolved: ResolvedLocalPersona[] = [];
  try {
    if (needsSupabase) await ensureSupabase();

    for (const specifier of specs) {
      if (specifier === "anon") {
        resolved.push({
          descriptor: Object.freeze({
            specifier,
            kind: "anon",
            scopes: Object.freeze([]),
          }),
          getToken: () => undefined,
          cleanup: async () => {},
        });
        continue;
      }

      if (specifier === "api-key" || specifier.startsWith("env:")) {
        const varName =
          specifier === "api-key" ? "MCP_API_KEY" : specifier.slice(4);
        if (!ENV_VAR_PATTERN.test(varName)) {
          throw new Error(
            `Invalid environment variable specifier '${specifier}'. Use env:VAR_NAME with an alphanumeric identifier.`,
          );
        }
        const secret = await readEnvVariable(varName, {
          projectRoot: options.projectRoot,
          envFile: options.envFile,
          deps: options.deps,
        });
        if (!secret) {
          throw new Error(
            `Environment variable '${varName}' was not found in --env-file, supabase/functions/.env.local, or the shell environment.`,
          );
        }
        const captured = secret;
        resolved.push({
          descriptor: Object.freeze({
            specifier,
            kind: specifier === "api-key" ? "api-key" : "env",
            scopes: Object.freeze([...requestedScopes]),
          }),
          getToken: () => captured,
          cleanup: async () => {},
        });
        continue;
      }

      // Gate 3: Pre-verify existing user in local auth.users BEFORE calling generateLink.
      const { stack: localStack, admin: adminClient } = await ensureSupabase();
      let matched: LocalSeedUserSummary | undefined;
      let isEphemeral = false;

      if (UUID_PATTERN.test(specifier)) {
        const lookup = await adminClient.auth.admin.getUserById(specifier);
        if (!lookup.error && lookup.data?.user) {
          matched = {
            id: lookup.data.user.id,
            email: lookup.data.user.email ?? null,
          };
        }
      } else {
        cachedUsers ??= await listAllLocalUsers(adminClient);
        const needle = specifier.toLowerCase();
        const exact = cachedUsers.find(
          (user) => user.email?.toLowerCase() === needle,
        );
        if (exact) {
          matched = exact;
        } else if (!needle.includes("@")) {
          const aliasMatches = cachedUsers.filter((user) => {
            const email = user.email?.toLowerCase();
            if (!email) return false;
            const atIndex = email.indexOf("@");
            return atIndex > 0 && email.slice(0, atIndex) === needle;
          });
          if (aliasMatches.length === 1) {
            matched = aliasMatches[0];
          } else if (aliasMatches.length > 1) {
            const emails = aliasMatches
              .map((u) => u.email)
              .filter(Boolean)
              .join(", ");
            throw new Error(
              `Persona alias '${specifier}' matched multiple local users (${emails}). Pass the full email address.`,
            );
          }
        }
      }

      if (!matched) {
        if (!options.ephemeralUsers) {
          cachedUsers ??= await listAllLocalUsers(adminClient);
          const available = cachedUsers
            .map((u) => u.email ?? u.id)
            .slice(0, 10)
            .join(", ");
          throw new Error(
            available
              ? `Local seed user '${specifier}' was not found in auth.users. Seed users in local Supabase: ${available} — or pass --ephemeral-users to create temporary users for this run.`
              : `Local seed user '${specifier}' was not found and local auth.users is empty. Seed users in supabase/seed.sql, or pass --ephemeral-users to create temporary users for this run.`,
          );
        }
        const email = specifier.includes("@")
          ? specifier
          : `chumbo-try-${sanitizeEphemeralSlug(specifier)}-${crypto.randomUUID().slice(0, 8)}@chumbo.local`;
        const created = await adminClient.auth.admin.createUser({
          email,
          password: `Chumbo-Try-${crypto.randomUUID()}!`,
          email_confirm: true,
        });
        if (created.error || !created.data?.user) {
          throw new Error(
            `Could not create ephemeral local user for '${specifier}': ${created.error?.message ?? "unknown error"}`,
          );
        }
        matched = {
          id: created.data.user.id,
          email: created.data.user.email ?? email,
        };
        isEphemeral = true;
      }

      let accessToken: string;
      let anonClient: SupabaseClient | undefined;

      if (requestedScopes.length > 0 || !matched.email) {
        accessToken = await mintShortLivedLocalJwt({
          projectRoot: options.projectRoot!,
          apiUrl: localStack.apiUrl,
          userId: matched.id,
          email: matched.email,
          scopes: requestedScopes,
          deps: options.deps,
        });
      } else {
        const link = await adminClient.auth.admin.generateLink({
          type: "magiclink",
          email: matched.email,
        });
        const hashedToken = link.data?.properties?.hashed_token;
        if (link.error || !hashedToken) {
          throw new Error(
            `Could not generate local sign-in link for '${matched.email}': ${link.error?.message ?? "missing hashed_token"}`,
          );
        }
        anonClient = (options.deps?.createAnonClient ?? defaultCreateClient)(
          localStack.apiUrl,
          localStack.publishableKey,
        );
        const verified = await anonClient.auth.verifyOtp({
          token_hash: hashedToken,
          type: "magiclink",
        });
        const sessionToken = verified.data?.session?.access_token;
        if (verified.error || !sessionToken) {
          throw new Error(
            `Could not verify local sign-in token for '${matched.email}': ${verified.error?.message ?? "missing access_token"}`,
          );
        }
        accessToken = sessionToken;
      }

      const capturedToken = accessToken;
      const capturedUserId = matched.id;
      const capturedAnon = anonClient;
      const capturedDelete = isEphemeral;

      resolved.push({
        descriptor: Object.freeze({
          specifier,
          kind: isEphemeral ? "ephemeral-user" : "supabase-user",
          userId: matched.id,
          email: matched.email,
          scopes: Object.freeze([...requestedScopes]),
        }),
        getToken: () => capturedToken,
        cleanup: async () => {
          if (capturedAnon) {
            await capturedAnon.auth.signOut({ scope: "local" }).catch(() => {});
          }
          if (capturedDelete && admin) {
            await admin.auth.admin.deleteUser(capturedUserId).catch(() => {});
          }
        },
      });
    }

    return Object.freeze(resolved);
  } catch (error) {
    await Promise.allSettled(resolved.map((persona) => persona.cleanup()));
    throw error;
  }
}

export function explicitTokenPersona(
  specifier: string,
  token: string,
  userId?: string,
  email?: string | null,
): ResolvedLocalPersona {
  const captured = token;
  return {
    descriptor: Object.freeze({
      specifier,
      kind: "explicit-token",
      ...(userId ? { userId } : {}),
      ...(email !== undefined ? { email } : {}),
      scopes: Object.freeze([]),
    }),
    getToken: () => captured,
    cleanup: async () => {},
  };
}
