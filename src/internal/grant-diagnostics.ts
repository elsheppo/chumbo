const SQL_IDENTIFIER_SEGMENT = /^[A-Za-z_][\w$]*$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;
const LOCAL_DEV_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
  "kong",
  "host.docker.internal",
]);

export interface DeniedPostgresObjects {
  readonly schemas: readonly string[];
  readonly relations: readonly string[];
  readonly sequences: readonly string[];
}

export function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHARACTERS, " ").trim();
}

export function isSafeSqlIdentifier(value: string): boolean {
  return (
    value.length > 0 && value.length <= 63 && SQL_IDENTIFIER_SEGMENT.test(value)
  );
}

/**
 * Validate a 1- or 2-segment Postgres identifier (`table` or `schema.table`)
 * after stripping optional surrounding double quotes. Returns `null` if any
 * segment fails strict identifier validation.
 */
export function normalizeQualifiedSqlIdentifier(
  raw: string,
  defaultSchema = "public",
): {
  readonly schema: string;
  readonly name: string;
  readonly qualified: string;
} | null {
  const cleaned = stripControlChars(raw).replace(/[.,;:!?)]+$/, "");
  if (!cleaned) return null;
  const parts = cleaned
    .split(".")
    .map((part) => part.trim().replace(/^"|"$/g, ""));
  if (parts.length === 1) {
    const name = parts[0]!;
    if (!isSafeSqlIdentifier(defaultSchema) || !isSafeSqlIdentifier(name)) {
      return null;
    }
    return {
      schema: defaultSchema,
      name,
      qualified: `${defaultSchema}.${name}`,
    };
  }
  if (parts.length === 2) {
    const [schema, name] = parts as [string, string];
    if (!isSafeSqlIdentifier(schema) || !isSafeSqlIdentifier(name)) {
      return null;
    }
    return {
      schema,
      name,
      qualified: `${schema}.${name}`,
    };
  }
  return null;
}

export function extractDeniedPostgresObjects(
  messages: Iterable<string>,
): DeniedPostgresObjects {
  const schemas = new Set<string>();
  const relations = new Set<string>();
  const sequences = new Set<string>();

  for (const raw of messages) {
    const text = stripControlChars(raw);
    for (const match of text.matchAll(
      /permission denied for (?:table|relation|view|materialized view)\s+([^\s,;]+)/gi,
    )) {
      const parsed = normalizeQualifiedSqlIdentifier(match[1]!);
      if (parsed) {
        if (parsed.schema !== "public") schemas.add(parsed.schema);
        relations.add(parsed.qualified);
      }
    }
    for (const match of text.matchAll(
      /permission denied for sequence\s+([^\s,;]+)/gi,
    )) {
      const parsed = normalizeQualifiedSqlIdentifier(match[1]!);
      if (parsed) {
        if (parsed.schema !== "public") schemas.add(parsed.schema);
        sequences.add(parsed.qualified);
      }
    }
    for (const match of text.matchAll(
      /permission denied for schema\s+([^\s,;]+)/gi,
    )) {
      const cleaned = stripControlChars(match[1]!)
        .replace(/[.,;:!?)]+$/, "")
        .replace(/^"|"$/g, "");
      if (isSafeSqlIdentifier(cleaned)) {
        schemas.add(cleaned);
      }
    }
  }

  return Object.freeze({
    schemas: Object.freeze([...schemas]),
    relations: Object.freeze([...relations]),
    sequences: Object.freeze([...sequences]),
  });
}

function readEnvVar(name: string): string | undefined {
  const globalAny = globalThis as {
    Deno?: { env?: { get(key: string): string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  try {
    const denoValue = globalAny.Deno?.env?.get(name);
    if (typeof denoValue === "string") return denoValue;
  } catch {
    // Deno without --allow-env may deny env lookup; fall back safely.
  }
  const nodeValue = globalAny.process?.env?.[name];
  return typeof nodeValue === "string" ? nodeValue : undefined;
}

/**
 * Strict local-development runtime check (Deno & Node safe without `node:*`).
 * Always returns `false` on hosted Deno Deploy / Supabase Edge (`DENO_DEPLOYMENT_ID`)
 * and when `NODE_ENV === "production"`.
 */
export function isLocalDevelopmentRuntime(): boolean {
  const denoDeploymentId = readEnvVar("DENO_DEPLOYMENT_ID");
  if (denoDeploymentId && denoDeploymentId.trim().length > 0) return false;
  const nodeEnv = readEnvVar("NODE_ENV")?.trim().toLowerCase();
  if (nodeEnv === "production") return false;
  if (nodeEnv === "development") return true;
  const supabaseUrl = readEnvVar("SUPABASE_URL")?.trim();
  if (!supabaseUrl) return false;
  try {
    const parsed = new URL(supabaseUrl);
    return LOCAL_DEV_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function formatDevGrantStderrHint(message: string): string | null {
  const extracted = extractDeniedPostgresObjects([message]);
  const relation = extracted.relations[0];
  if (relation) {
    return `[chumbo:dev] Postgres 42501 permission denied on table ${relation}. Since 2026-10-30, new public tables need explicit Data API grants in a migration (e.g. \`grant select on table ${relation} to authenticated;\` plus insert/update/delete as needed, with RLS enabled). Run \`npx chumbo doctor\` to inspect.`;
  }
  const schema = extracted.schemas[0];
  if (schema) {
    return `[chumbo:dev] Postgres 42501 permission denied on schema ${schema}. Grant schema usage explicitly in a migration (e.g. \`grant usage on schema ${schema} to authenticated;\`) and ensure RLS is enabled. Run \`npx chumbo doctor\` to inspect.`;
  }
  if (/permission denied/i.test(message)) {
    return `[chumbo:dev] Postgres 42501 permission denied. Since 2026-10-30, new public tables need explicit Data API grants in a migration (with RLS enabled). Run \`npx chumbo doctor\` to inspect.`;
  }
  return null;
}
