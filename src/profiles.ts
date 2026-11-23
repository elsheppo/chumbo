import { CHUMBO_CAPABILITY_META_KEY } from "./capabilities.js";
import {
  defineToolVocabulary,
  scopedInputSchema,
  type ToolGuidanceVocabulary,
  type ToolReferenceRule,
} from "./guidance.js";
import {
  CHUMBO_CANONICAL_TOOL,
  PRESENTED_TOOL_NAME,
} from "./internal/surface-canonical.js";
import type {
  SupabaseMcpContext,
  SupabaseMcpProfileCatalogLike,
  SupabaseMcpProfileLike,
  SupabaseMcpServer,
} from "./types.js";

export { CHUMBO_CANONICAL_TOOL };

const PROFILE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_PRESENTATION_DESCRIPTION_CHARS = 4096;

export interface ToolAliasPresentation {
  /** Presented MCP tool name exposed on the wire (`tools/list` and `tools/call`). */
  readonly name: string;
  /** Optional context prepended above the native description (never erases native safety/effect prose). */
  readonly descriptionPrefix?: string;
  /** Optional semantic profile description replacing raw plumbing prose (still passed through `scopedGuidance`). */
  readonly description?: string;
}

export interface ChumboProfileDefinition<
  Id extends string = string,
  Database = unknown,
> {
  readonly id: Id;
  /** Finite ceiling of canonical tool names allowed in this profile. */
  readonly tools: readonly string[];
  /** Optional canonicalName -> alias string or `ToolAliasPresentation`. Every key must be in `tools`. */
  readonly aliases?: Readonly<Record<string, string | ToolAliasPresentation>>;
  /** Optional connection-wide system tools always allowed alongside `tools` (e.g. `["send_feedback"]`). */
  readonly systemTools?: readonly string[];
  /** Optional profile-specific server instructions (overrides root `instructions` when active). */
  readonly instructions?:
    | string
    | ((
        context: SupabaseMcpContext<Database>,
      ) => string | undefined | Promise<string | undefined>);
}

export interface DefinedChumboProfile<
  Id extends string = string,
  Database = unknown,
> extends SupabaseMcpProfileLike<Id, Database> {
  readonly id: Id;
  readonly tools: ReadonlySet<string>;
  readonly systemTools: ReadonlySet<string>;
  readonly aliases: ReadonlyMap<string, string>;
  readonly presentedNameFor: (canonicalName: string) => string | undefined;
  readonly canonicalNameFor: (presentedName: string) => string | undefined;
  readonly presentationFor: (
    canonicalName: string,
  ) => ToolAliasPresentation | undefined;
  readonly instructions?: ChumboProfileDefinition<Id, Database>["instructions"];
}

export interface DefinedProfileCatalog<
  Profiles extends Record<string, ChumboProfileDefinition<any, Database>>,
  Database = unknown,
> extends SupabaseMcpProfileCatalogLike<keyof Profiles & string, Database> {
  readonly ids: readonly (keyof Profiles & string)[];
  readonly vocabulary: ToolGuidanceVocabulary;
  get<Id extends keyof Profiles & string>(
    id: Id,
  ): DefinedChumboProfile<Id, Database>;
  /** Parse untrusted env/config string; throws TypeError on unknown profile (never widens to full catalog). */
  parseId(value: string): keyof Profiles & string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateProseField(
  value: string | undefined,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_PRESENTATION_DESCRIPTION_CHARS) {
    throw new TypeError(
      `${label} must be 1 to ${MAX_PRESENTATION_DESCRIPTION_CHARS} non-whitespace characters`,
    );
  }
  return trimmed;
}

export function defineProfile<const Id extends string, Database = unknown>(
  definition: ChumboProfileDefinition<Id, Database>,
): DefinedChumboProfile<Id, Database> {
  if (!PROFILE_ID_PATTERN.test(definition.id)) {
    throw new TypeError(
      `Invalid profile id '${definition.id}': must be lowercase alphanumeric with dots, dashes, or underscores`,
    );
  }
  const tools = new Set<string>();
  for (const name of definition.tools) {
    if (!MCP_TOOL_NAME_PATTERN.test(name)) {
      throw new TypeError(
        `Invalid canonical tool name '${name}' in profile '${definition.id}'`,
      );
    }
    if (tools.has(name)) {
      throw new TypeError(
        `Duplicate canonical tool '${name}' in profile '${definition.id}'`,
      );
    }
    tools.add(name);
  }

  const systemTools = new Set<string>();
  for (const name of definition.systemTools ?? []) {
    if (!MCP_TOOL_NAME_PATTERN.test(name)) {
      throw new TypeError(
        `Invalid system tool name '${name}' in profile '${definition.id}'`,
      );
    }
    if (systemTools.has(name) || tools.has(name)) {
      throw new TypeError(
        `Duplicate or overlapping system tool '${name}' in profile '${definition.id}'`,
      );
    }
    systemTools.add(name);
  }

  const presentations = new Map<string, ToolAliasPresentation>();
  const aliases = new Map<string, string>();
  if (definition.aliases) {
    for (const [canonical, rawSpec] of Object.entries(definition.aliases)) {
      if (!tools.has(canonical)) {
        throw new TypeError(
          `Profile '${definition.id}' defines an alias for '${canonical}', which is not in its tools ceiling`,
        );
      }
      const spec: ToolAliasPresentation =
        typeof rawSpec === "string"
          ? { name: rawSpec }
          : {
              name: rawSpec.name,
              ...(rawSpec.descriptionPrefix !== undefined
                ? {
                    descriptionPrefix: validateProseField(
                      rawSpec.descriptionPrefix,
                      `Alias descriptionPrefix for '${canonical}'`,
                    ),
                  }
                : {}),
              ...(rawSpec.description !== undefined
                ? {
                    description: validateProseField(
                      rawSpec.description,
                      `Alias description for '${canonical}'`,
                    ),
                  }
                : {}),
            };
      if (!MCP_TOOL_NAME_PATTERN.test(spec.name)) {
        throw new TypeError(
          `Invalid alias tool name '${spec.name}' for '${canonical}' in profile '${definition.id}'`,
        );
      }
      presentations.set(canonical, Object.freeze(spec));
      if (spec.name !== canonical) {
        aliases.set(canonical, spec.name);
      }
    }
  }

  const canonicalToPresented = new Map<string, string>();
  const presentedToCanonical = new Map<string, string>();

  for (const sysTool of systemTools) {
    canonicalToPresented.set(sysTool, sysTool);
    presentedToCanonical.set(sysTool, sysTool);
  }
  for (const canonical of tools) {
    const presented = presentations.get(canonical)?.name ?? canonical;
    if (presentedToCanonical.has(presented)) {
      const existingOwner = presentedToCanonical.get(presented)!;
      throw new TypeError(
        `Profile '${definition.id}' maps both '${existingOwner}' and '${canonical}' to presented tool name '${presented}'`,
      );
    }
    canonicalToPresented.set(canonical, presented);
    presentedToCanonical.set(presented, canonical);
  }

  return Object.freeze({
    id: definition.id,
    tools,
    systemTools,
    aliases,
    presentedNameFor: (canonicalName: string) =>
      canonicalToPresented.get(canonicalName),
    canonicalNameFor: (presentedName: string) =>
      presentedToCanonical.get(presentedName),
    presentationFor: (canonicalName: string) =>
      presentations.get(canonicalName),
    ...(definition.instructions !== undefined
      ? { instructions: definition.instructions }
      : {}),
  });
}

export function defineProfiles<
  const Profiles extends Record<
    string,
    Omit<ChumboProfileDefinition<string, Database>, "id">
  >,
  Database = unknown,
>(
  profiles: Profiles,
  options?: {
    readonly allTools?: readonly string[];
    readonly references?: Readonly<Record<string, ToolReferenceRule>>;
    readonly compoundReferences?: Readonly<Record<string, ToolReferenceRule>>;
    readonly plainWordTools?: readonly string[];
    readonly defaultUnavailable?: (toolName: string) => string;
  },
): DefinedProfileCatalog<
  { [K in keyof Profiles & string]: Profiles[K] & { readonly id: K } },
  Database
> {
  const entries = Object.entries(profiles);
  if (entries.length === 0) {
    throw new RangeError("defineProfiles requires at least one profile");
  }
  const byId = new Map<string, DefinedChumboProfile<string, Database>>();
  const unionTools = new Set<string>(options?.allTools ?? []);

  for (const [id, spec] of entries) {
    const compiled = defineProfile({ ...spec, id });
    byId.set(id, compiled);
    for (const tool of compiled.tools) unionTools.add(tool);
    for (const sysTool of compiled.systemTools) unionTools.add(sysTool);
  }

  const vocabulary = defineToolVocabulary({
    tools: [...unionTools],
    ...(options?.references ? { references: options.references } : {}),
    ...(options?.compoundReferences
      ? { compoundReferences: options.compoundReferences }
      : {}),
    ...(options?.plainWordTools
      ? { plainWordTools: options.plainWordTools }
      : {}),
    ...(options?.defaultUnavailable
      ? { defaultUnavailable: options.defaultUnavailable }
      : {}),
  });

  const ids = Object.freeze([...byId.keys()]) as readonly (keyof Profiles &
    string)[];
  const validList = ids.join(", ");

  return Object.freeze({
    ids,
    vocabulary,
    get<Id extends keyof Profiles & string>(id: Id) {
      const found = byId.get(id);
      if (!found) {
        throw new TypeError(
          `Unknown capability profile '${String(id)}' (expected one of: ${validList})`,
        );
      }
      return found as DefinedChumboProfile<Id, Database>;
    },
    parseId(value: string) {
      const trimmed = typeof value === "string" ? value.trim() : "";
      if (!byId.has(trimmed)) {
        throw new TypeError(
          `Unknown capability profile '${String(value)}' (expected one of: ${validList})`,
        );
      }
      return trimmed as keyof Profiles & string;
    },
  });
}

/**
 * Filter, rename, and scope-rewrite tool registrations on a `SupabaseMcpServer`
 * according to a declarative `DefinedChumboProfile`. Preserves `withScopes(...)`
 * intersection (`effective = authorized ∩ profile`) and tags aliased registrations
 * with `CHUMBO_CANONICAL_TOOL` for redacted lifecycle tracking.
 */
export function withProfile<Database = unknown>(
  server: SupabaseMcpServer,
  profile: DefinedChumboProfile<string, Database>,
  options?: { readonly vocabulary?: ToolGuidanceVocabulary },
): SupabaseMcpServer {
  const mountedPresented = new Set<string>();
  for (const tool of profile.tools) {
    mountedPresented.add(profile.presentedNameFor(tool) ?? tool);
  }
  for (const sysTool of profile.systemTools) {
    mountedPresented.add(sysTool);
  }

  const effectiveVocabulary =
    options?.vocabulary ??
    (profile.aliases.size > 0
      ? defineToolVocabulary({
          tools: [...profile.tools, ...profile.systemTools],
        })
      : undefined);

  return new Proxy(server, {
    get(target, property, receiver) {
      if (property === "withScopes") {
        return (scopes: readonly string[]) =>
          withProfile(target.withScopes(scopes), profile, {
            ...(effectiveVocabulary ? { vocabulary: effectiveVocabulary } : {}),
          });
      }
      if (property === PRESENTED_TOOL_NAME) {
        return (canonicalName: string) =>
          profile.presentedNameFor(canonicalName);
      }
      if (property !== "registerTool") {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (
        canonicalName: string,
        rawConfig: Record<string, unknown>,
        ...rest: unknown[]
      ) => {
        if (
          !profile.tools.has(canonicalName) &&
          !profile.systemTools.has(canonicalName)
        ) {
          return undefined;
        }
        const presentedName =
          profile.presentedNameFor(canonicalName) ?? canonicalName;
        const presentation = profile.presentationFor(canonicalName);
        const config = isPlainRecord(rawConfig) ? rawConfig : {};

        const baseDescription =
          presentation?.description ??
          (typeof config.description === "string" ? config.description : "");
        const prefixedDescription = presentation?.descriptionPrefix
          ? `${presentation.descriptionPrefix}\n\n${baseDescription}`.trim()
          : baseDescription;
        const rewrittenDescription = effectiveVocabulary
          ? effectiveVocabulary.rewrite(
              prefixedDescription,
              mountedPresented,
              profile.aliases,
            )
          : prefixedDescription;

        const rewrittenInputSchema =
          config.inputSchema !== undefined && effectiveVocabulary
            ? scopedInputSchema(
                config.inputSchema,
                effectiveVocabulary,
                mountedPresented,
                profile.aliases,
              )
            : config.inputSchema;

        let nextMeta = config._meta;
        if (presentedName !== canonicalName && isPlainRecord(config._meta)) {
          const maybeManifest = config._meta[CHUMBO_CAPABILITY_META_KEY];
          if (isPlainRecord(maybeManifest)) {
            nextMeta = {
              ...config._meta,
              [CHUMBO_CAPABILITY_META_KEY]: Object.freeze({
                ...maybeManifest,
                mcpName: presentedName,
                id:
                  maybeManifest.id === canonicalName
                    ? presentedName
                    : maybeManifest.id,
              }),
            };
          }
        }

        const projectedConfig: Record<PropertyKey, unknown> = {
          ...config,
          ...(rewrittenDescription
            ? { description: rewrittenDescription }
            : {}),
          ...(rewrittenInputSchema !== undefined
            ? { inputSchema: rewrittenInputSchema }
            : {}),
          ...(nextMeta !== undefined ? { _meta: nextMeta } : {}),
          ...(presentedName !== canonicalName
            ? { [CHUMBO_CANONICAL_TOOL]: canonicalName }
            : {}),
        };

        return Reflect.apply(
          target.registerTool as unknown as (...args: unknown[]) => unknown,
          target,
          [presentedName, projectedConfig, ...rest],
        );
      };
    },
  });
}
