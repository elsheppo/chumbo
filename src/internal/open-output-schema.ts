import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z } from "zod";

const OPENED = Symbol.for("dev.chumbo.mcp.openOutputSchema");

/** JSON Schema keywords whose values are maps of child schemas keyed by user-chosen names. */
export const JSON_SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

/** JSON Schema keywords whose values are literal data instances, never schemas to rewrite. */
export const JSON_SCHEMA_INSTANCE_DATA_KEYWORDS = new Set([
  "const",
  "enum",
  "default",
  "examples",
  "example",
]);

/** Closed-object keywords stripped only when their value is `false`. */
const CLOSED_KEYWORDS = new Set([
  "additionalProperties",
  "unevaluatedProperties",
]);

/** Return a deep copy of a JSON Schema in which no object node forbids additional properties. */
export function openJsonSchema<T>(schema: T): T {
  return openNode(schema, false) as T;
}

function openNode(node: unknown, inSchemaMap: boolean): unknown {
  if (Array.isArray(node)) return node.map((entry) => openNode(entry, false));
  if (node === null || typeof node !== "object") return node;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!inSchemaMap) {
      if (CLOSED_KEYWORDS.has(key) && value === false) continue;
      if (JSON_SCHEMA_INSTANCE_DATA_KEYWORDS.has(key)) {
        result[key] = value;
        continue;
      }
    }
    result[key] =
      !inSchemaMap &&
      JSON_SCHEMA_MAP_KEYWORDS.has(key) &&
      value !== null &&
      typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([name, child]) => [
              name,
              openNode(child, false),
            ]),
          )
        : openNode(value, false);
  }
  return result;
}

function freezeSchema<T>(node: T, inSchemaMap: boolean): T {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    for (const entry of node) freezeSchema(entry, false);
  } else {
    for (const [key, value] of Object.entries(node)) {
      if (!inSchemaMap && JSON_SCHEMA_INSTANCE_DATA_KEYWORDS.has(key)) continue;
      freezeSchema(value, !inSchemaMap && JSON_SCHEMA_MAP_KEYWORDS.has(key));
    }
  }
  return Object.freeze(node);
}

const openedBySource = new WeakMap<object, unknown>();

/**
 * Wrap a Standard Schema (or raw Zod shape) so its advertised `output` JSON
 * Schema omits `additionalProperties: false` / `unevaluatedProperties: false`,
 * memoized once per source schema and JSON Schema target.
 */
export function openOutputSchema<Schema extends StandardSchemaWithJSON>(
  schema: Schema,
): Schema;
export function openOutputSchema(schema: unknown): unknown;
export function openOutputSchema(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object") return schema;
  if ((schema as Record<symbol, unknown>)[OPENED]) return schema;
  const cached = openedBySource.get(schema);
  if (cached !== undefined) return cached;

  const standard = (schema as Partial<StandardSchemaWithJSON>)["~standard"];
  if (!standard) {
    const values = Object.values(schema);
    if (
      values.length === 0 ||
      !values.every((v) => v !== null && typeof v === "object" && "_zod" in v)
    ) {
      return schema;
    }
    const wrapped = openOutputSchema(
      z.object(schema as Record<string, z.ZodType>),
    );
    openedBySource.set(schema, wrapped);
    return wrapped;
  }

  type ConverterOptions = Parameters<typeof standard.jsonSchema.output>[0];
  const projectedByTarget = new Map<string, Record<string, unknown>>();

  const projectOutput = (
    options: ConverterOptions,
  ): Record<string, unknown> => {
    const raw = standard.jsonSchema?.output
      ? standard.jsonSchema.output(options)
      : (z.toJSONSchema(schema as unknown as z.ZodType, {
          io: "output",
          ...(options?.target
            ? { target: options.target as "draft-2020-12" }
            : {}),
        }) as Record<string, unknown>);
    if (options?.libraryOptions !== undefined) return openJsonSchema(raw);
    const targetKey = String(options?.target ?? "draft-2020-12");
    let opened = projectedByTarget.get(targetKey);
    if (opened === undefined) {
      opened = freezeSchema(openJsonSchema(raw), false);
      projectedByTarget.set(targetKey, opened);
    }
    return opened;
  };

  const projectInput = (options: ConverterOptions): Record<string, unknown> =>
    standard.jsonSchema?.input
      ? standard.jsonSchema.input(options)
      : (z.toJSONSchema(schema as unknown as z.ZodType, {
          io: "input",
          ...(options?.target
            ? { target: options.target as "draft-2020-12" }
            : {}),
        }) as Record<string, unknown>);

  const wrapped = {
    [OPENED]: true,
    "~standard": {
      version: 1 as const,
      vendor: standard.vendor ?? "chumbo",
      ...(standard.types ? { types: standard.types } : {}),
      validate: (
        value: unknown,
        options?: Parameters<typeof standard.validate>[1],
      ) => standard.validate(value, options),
      jsonSchema: {
        input: projectInput,
        output: projectOutput,
      },
    },
  };
  openedBySource.set(schema, wrapped);
  return wrapped;
}

/**
 * Shallowly clone a `registerTool` config object so its `outputSchema` (if any)
 * advertises an open JSON Schema while preserving server-side validation.
 */
export function withOpenOutputSchema<Config extends Record<string, unknown>>(
  config: Config,
): Config {
  if (!("outputSchema" in config) || config.outputSchema === undefined) {
    return config;
  }
  const opened = openOutputSchema(config.outputSchema);
  if (opened === config.outputSchema) return config;
  return {
    ...config,
    outputSchema: opened,
  };
}
