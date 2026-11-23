import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  JSON_SCHEMA_INSTANCE_DATA_KEYWORDS,
  JSON_SCHEMA_MAP_KEYWORDS,
} from "./internal/open-output-schema.js";

const SCOPED_SCHEMA_CACHE_LIMIT = 64;

export const DEFAULT_PLAIN_WORD_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "search",
  "list",
  "get",
  "open",
  "create",
  "update",
  "delete",
  "run",
  "execute",
  "capture",
  "status",
  "help",
]);

export interface ToolReferenceRule {
  /** Target canonical tool name, or `""` when retired/external with no in-band tool. */
  readonly tool?: string;
  /** Neutral capability phrase substituted when `tool` is not mounted on this connection. */
  readonly unavailable: string;
}

export interface GuidanceVocabularyOptions {
  /** Known canonical tool names across the server catalog. */
  readonly tools: readonly string[];
  /** Explicit redirects or custom absence phrases keyed by canonical/retired tool name. */
  readonly references?: Readonly<Record<string, ToolReferenceRule>>;
  /** Multi-tool authored phrases collapsed before single-token matching (prevents `"x or x"`). */
  readonly compoundReferences?: Readonly<Record<string, ToolReferenceRule>>;
  /** Tool names that are also common English words (matched only in call/use syntax). */
  readonly plainWordTools?: readonly string[];
  /** Custom fallback phrase generator. Defaults to `${name.replaceAll("_", " ")} (unavailable on this connection)`. */
  readonly defaultUnavailable?: (toolName: string) => string;
}

export interface ToolGuidanceVocabulary {
  readonly knownTools: ReadonlySet<string>;
  readonly plainWordTools: ReadonlySet<string>;
  rewrite(
    text: string,
    mounted: ReadonlySet<string>,
    aliases?: ReadonlyMap<string, string>,
  ): string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function defaultUnavailablePhrase(toolName: string): string {
  return `${toolName.replaceAll("_", " ")} (unavailable on this connection)`;
}

export function defineToolVocabulary(
  options: GuidanceVocabularyOptions,
): ToolGuidanceVocabulary {
  const unavailableFor = options.defaultUnavailable ?? defaultUnavailablePhrase;
  const rules = new Map<string, Required<ToolReferenceRule>>();

  for (const rawName of options.tools) {
    const name = rawName.trim();
    if (!name) continue;
    rules.set(name, {
      tool: name,
      unavailable: unavailableFor(name),
    });
  }

  if (options.references) {
    for (const [rawName, rule] of Object.entries(options.references)) {
      const name = rawName.trim();
      if (!name) continue;
      rules.set(name, {
        tool: rule.tool ?? "",
        unavailable: rule.unavailable,
      });
    }
  }

  const plainWords = new Set<string>([
    ...DEFAULT_PLAIN_WORD_TOOLS,
    ...(options.plainWordTools ?? [])
      .map((item) => item.trim())
      .filter(Boolean),
  ]);

  const compoundEntries = Object.entries(options.compoundReferences ?? {}).sort(
    ([left], [right]) => right.length - left.length,
  );

  const sortedTokens = [...rules.keys()].sort((a, b) => b.length - a.length);
  const plainAlts = sortedTokens
    .filter((token) => plainWords.has(token))
    .map(escapeRegExp);
  const identifierAlts = sortedTokens
    .filter((token) => !plainWords.has(token))
    .map(escapeRegExp);

  // Build one single-pass regex so an alias that coincides with another tool's
  // canonical name is never re-matched in a second pass.
  const branches: string[] = [];
  if (identifierAlts.length > 0) {
    branches.push(
      `(?<![A-Za-z0-9_.-])(?<ident>${identifierAlts.join("|")})(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])`,
    );
  }
  if (plainAlts.length > 0) {
    const plainGroup = plainAlts.join("|");
    branches.push(`\`(?<backtick>${plainGroup})\``);
    branches.push(`(?<![A-Za-z0-9_.:'-])(?<call>${plainGroup})(?=\\()`);
    branches.push(
      `\\b(?<verb>call|use|using|with|via|run)(?<space>\\s+)(?<verbTool>${plainGroup})(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])`,
    );
  }
  const combinedPattern =
    branches.length > 0 ? new RegExp(branches.join("|"), "gu") : null;

  const resolveReplacement = (
    rule: { readonly tool?: string; readonly unavailable: string },
    mounted: ReadonlySet<string>,
    aliases?: ReadonlyMap<string, string>,
  ): { readonly text: string; readonly isMounted: boolean } => {
    const canonicalTarget = rule.tool ?? "";
    if (!canonicalTarget) {
      return { text: rule.unavailable, isMounted: false };
    }
    const presented = aliases?.get(canonicalTarget) ?? canonicalTarget;
    if (mounted.has(presented)) {
      return { text: presented, isMounted: true };
    }
    return { text: rule.unavailable, isMounted: false };
  };

  return Object.freeze({
    knownTools: new Set(rules.keys()),
    plainWordTools: plainWords,
    rewrite(
      text: string,
      mounted: ReadonlySet<string>,
      aliases?: ReadonlyMap<string, string>,
    ): string {
      if (!text) return text;
      let working = text;
      for (const [phrase, rule] of compoundEntries) {
        if (!working.includes(phrase)) continue;
        const resolved = resolveReplacement(rule, mounted, aliases);
        working = working.replaceAll(phrase, resolved.text);
      }
      if (!combinedPattern) return working;
      return working.replace(combinedPattern, (...args) => {
        const groups = args.at(-1) as Record<string, string | undefined>;
        if (groups.ident !== undefined) {
          const rule = rules.get(groups.ident)!;
          return resolveReplacement(rule, mounted, aliases).text;
        }
        if (groups.backtick !== undefined) {
          const rule = rules.get(groups.backtick)!;
          const resolved = resolveReplacement(rule, mounted, aliases);
          return resolved.isMounted ? `\`${resolved.text}\`` : resolved.text;
        }
        if (groups.call !== undefined) {
          const rule = rules.get(groups.call)!;
          return resolveReplacement(rule, mounted, aliases).text;
        }
        if (groups.verbTool !== undefined) {
          const rule = rules.get(groups.verbTool)!;
          const resolved = resolveReplacement(rule, mounted, aliases);
          return `${groups.verb ?? ""}${groups.space ?? " "}${resolved.text}`;
        }
        return args[0] as string;
      });
    },
  });
}

export function scopedGuidance(
  text: string,
  vocabulary: ToolGuidanceVocabulary,
  mounted: ReadonlySet<string>,
  aliases?: ReadonlyMap<string, string>,
): string {
  return vocabulary.rewrite(text, mounted, aliases);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isZodRawShape(value: unknown): value is Record<string, z.ZodType> {
  if (!isObject(value) || Array.isArray(value)) return false;
  if ("~standard" in value) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const entries = Object.values(value);
  return (
    entries.length > 0 &&
    entries.every((entry) => isObject(entry) && "_zod" in entry)
  );
}

export function rewriteSchemaDescriptions(
  node: unknown,
  describe: (text: string) => string,
  inSchemaMap = false,
): unknown {
  if (Array.isArray(node)) {
    return node.map((entry) =>
      rewriteSchemaDescriptions(entry, describe, false),
    );
  }
  if (!isObject(node)) return node;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!inSchemaMap) {
      if (JSON_SCHEMA_INSTANCE_DATA_KEYWORDS.has(key)) {
        result[key] = value;
        continue;
      }
      if (key === "description" && typeof value === "string") {
        result[key] = describe(value);
        continue;
      }
    }
    result[key] =
      !inSchemaMap &&
      JSON_SCHEMA_MAP_KEYWORDS.has(key) &&
      isObject(value) &&
      !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).map(([propOrDefName, child]) => [
              propOrDefName,
              rewriteSchemaDescriptions(child, describe, false),
            ]),
          )
        : rewriteSchemaDescriptions(value, describe, false);
  }
  return result;
}

/**
 * Transform `description` strings across a Standard Schema's advertised JSON
 * Schema while preserving its native `validate` runtime and TypeScript types.
 */
export function mapInputSchemaDescriptions<
  Schema extends StandardSchemaWithJSON,
>(schema: Schema, describe: (text: string) => string): Schema;
export function mapInputSchemaDescriptions<Schema>(
  schema: Schema,
  describe: (text: string) => string,
): Schema;
export function mapInputSchemaDescriptions(
  schema: unknown,
  describe: (text: string) => string,
): unknown {
  if (!isObject(schema)) return schema;
  if (isZodRawShape(schema)) {
    return mapInputSchemaDescriptions(z.object(schema), describe);
  }
  const standard = (schema as Partial<StandardSchemaWithJSON>)["~standard"];
  if (!standard) return schema;

  type ConverterOptions = Parameters<typeof standard.jsonSchema.input>[0];
  const inputCache = new Map<string, Record<string, unknown>>();
  const outputCache = new Map<string, Record<string, unknown>>();

  const project = (
    io: "input" | "output",
    cache: Map<string, Record<string, unknown>>,
    options: ConverterOptions,
  ): Record<string, unknown> => {
    const converter =
      io === "input" ? standard.jsonSchema?.input : standard.jsonSchema?.output;
    const raw = converter
      ? converter(options)
      : (z.toJSONSchema(schema as unknown as z.ZodType, {
          io,
          ...(options?.target
            ? { target: options.target as "draft-2020-12" }
            : {}),
        }) as Record<string, unknown>);
    if (options?.libraryOptions !== undefined) {
      return rewriteSchemaDescriptions(raw, describe, false) as Record<
        string,
        unknown
      >;
    }
    const targetKey = String(options?.target ?? "draft-2020-12");
    let projected = cache.get(targetKey);
    if (projected === undefined) {
      projected = rewriteSchemaDescriptions(raw, describe, false) as Record<
        string,
        unknown
      >;
      cache.set(targetKey, projected);
    }
    return structuredClone(projected);
  };

  return {
    "~standard": {
      version: 1 as const,
      vendor: standard.vendor ?? "chumbo",
      ...(standard.types ? { types: standard.types } : {}),
      validate: (
        value: unknown,
        options?: Parameters<typeof standard.validate>[1],
      ) => standard.validate(value, options),
      jsonSchema: {
        input: (options: ConverterOptions) =>
          project("input", inputCache, options),
        output: (options: ConverterOptions) =>
          project("output", outputCache, options),
      },
    },
  };
}

const scopedSchemasCache = new WeakMap<
  object,
  Map<string, WeakMap<object, unknown>>
>();

function toolSetCacheKey(
  mounted: ReadonlySet<string>,
  aliases?: ReadonlyMap<string, string>,
): string {
  const mountedPart = [...mounted].sort().join("\n");
  if (!aliases || aliases.size === 0) return mountedPart;
  const aliasPart = [...aliases.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([from, to]) => `${from}=>${to}`)
    .join("\n");
  return `${mountedPart}\u0000${aliasPart}`;
}

export function scopedInputSchema<Schema extends StandardSchemaWithJSON>(
  schema: Schema,
  vocabulary: ToolGuidanceVocabulary,
  mounted: ReadonlySet<string>,
  aliases?: ReadonlyMap<string, string>,
): Schema;
export function scopedInputSchema<Schema>(
  schema: Schema,
  vocabulary: ToolGuidanceVocabulary,
  mounted: ReadonlySet<string>,
  aliases?: ReadonlyMap<string, string>,
): Schema;
export function scopedInputSchema(
  schema: unknown,
  vocabulary: ToolGuidanceVocabulary,
  mounted: ReadonlySet<string>,
  aliases?: ReadonlyMap<string, string>,
): unknown {
  if (!isObject(schema)) return schema;
  const key = toolSetCacheKey(mounted, aliases);
  let byKey = scopedSchemasCache.get(schema);
  if (!byKey) {
    byKey = new Map();
    scopedSchemasCache.set(schema, byKey);
  }
  let byVocab = byKey.get(key);
  if (byVocab) {
    const existing = byVocab.get(vocabulary);
    if (existing !== undefined) return existing;
  } else {
    if (byKey.size >= SCOPED_SCHEMA_CACHE_LIMIT) {
      const oldest = byKey.keys().next().value;
      if (typeof oldest === "string") byKey.delete(oldest);
    }
    byVocab = new WeakMap();
    byKey.set(key, byVocab);
  }
  const projected = mapInputSchemaDescriptions(schema, (text) =>
    vocabulary.rewrite(text, mounted, aliases),
  );
  byVocab.set(vocabulary, projected);
  return projected;
}
