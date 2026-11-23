import type {
  RegisteredTool,
  StandardSchemaWithJSON,
  ToolAnnotations,
  ToolCallback,
} from "@modelcontextprotocol/server";
import { withOpenOutputSchema } from "./internal/open-output-schema.js";
import { RESERVED_CLI_ROOT_COMMANDS, type SupabaseMcpServer } from "./types.js";

export const CHUMBO_CAPABILITY_META_KEY = "dev.chumbo/capability";

export type ChumboCapabilityRisk = "read" | "write" | "destructive";
export type ChumboCliPresentation = "auto" | "text" | "json";

export interface ChumboCliProjection {
  /** Domain-oriented command path, excluding the project-branded binary name. */
  readonly command: readonly [string, ...string[]];
  readonly description?: string;
  readonly presentation?: ChumboCliPresentation;
  readonly examples?: readonly string[];
}

export interface ChumboCapabilityManifestV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly mcpName: string;
  readonly risk: ChumboCapabilityRisk;
  readonly idempotent: boolean;
  readonly scopes: readonly string[];
  readonly cli?: ChumboCliProjection;
}

export interface ChumboCapabilityDefinition<
  Input extends StandardSchemaWithJSON | undefined =
    | StandardSchemaWithJSON
    | undefined,
  Output extends StandardSchemaWithJSON | undefined =
    | StandardSchemaWithJSON
    | undefined,
> {
  /** Stable capability identifier; defaults to `mcpName` when omitted. */
  readonly id?: string;
  readonly mcpName: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema?: Input;
  readonly outputSchema?: Output;
  readonly scopes?: readonly string[];
  readonly risk: ChumboCapabilityRisk;
  readonly idempotent?: boolean;
  /** Optional CLI projection; falls back to `run <mcpName>` when omitted. */
  readonly cli?: ChumboCliProjection;
  readonly annotations?: ToolAnnotations;
  readonly mcpMeta?: Readonly<Record<string, unknown>>;
  readonly handler: ToolCallback<Input>;
}

export interface DefinedChumboCapability<
  Input extends StandardSchemaWithJSON | undefined =
    | StandardSchemaWithJSON
    | undefined,
  Output extends StandardSchemaWithJSON | undefined =
    | StandardSchemaWithJSON
    | undefined,
> extends ChumboCapabilityDefinition<Input, Output> {
  readonly id: string;
  readonly manifest: ChumboCapabilityManifestV1;
}

const stableId = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const commandSegment = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const reservedCliRoots = new Set<string>(RESERVED_CLI_ROOT_COMMANDS);

function normalizedScopes(scopes: readonly string[] | undefined): string[] {
  const result = [...new Set((scopes ?? []).map((scope) => scope.trim()))];
  if (result.some((scope) => !scope || /\s/u.test(scope))) {
    throw new TypeError("Capability scopes must be non-empty tokens");
  }
  return result;
}

function validateDefinition(
  definition: ChumboCapabilityDefinition,
): ChumboCapabilityManifestV1 {
  if (!stableId.test(definition.mcpName)) {
    throw new TypeError(
      "Capability MCP name must be a stable lowercase identifier",
    );
  }
  const resolvedId = definition.id ?? definition.mcpName;
  if (!stableId.test(resolvedId)) {
    throw new TypeError(
      "Capability id must be a stable lowercase identifier using dots, dashes, or underscores",
    );
  }
  if (!definition.description.trim()) {
    throw new TypeError("Capability description is required");
  }
  if (definition.cli !== undefined) {
    if (
      definition.cli.command.length === 0 ||
      definition.cli.command.some((segment) => !commandSegment.test(segment))
    ) {
      throw new TypeError(
        "Capability CLI command must contain lowercase kebab-case segments",
      );
    }
    const rootSegment = definition.cli.command[0];
    if (reservedCliRoots.has(rootSegment)) {
      throw new TypeError(
        `Capability CLI command cannot shadow reserved CLI command '${rootSegment}'`,
      );
    }
  }
  const readOnly = definition.annotations?.readOnlyHint;
  const destructive = definition.annotations?.destructiveHint;
  const idempotent = definition.idempotent ?? false;
  if (definition.risk === "read" && (readOnly === false || destructive)) {
    throw new TypeError(
      "Read capability has conflicting MCP safety annotations",
    );
  }
  if (definition.risk !== "read" && readOnly) {
    throw new TypeError("Write capability cannot be annotated as read-only");
  }
  if (definition.risk === "destructive" && destructive === false) {
    throw new TypeError(
      "Destructive capability cannot disable the destructive annotation",
    );
  }
  if (definition.annotations?.idempotentHint !== undefined) {
    if (definition.annotations.idempotentHint !== idempotent) {
      throw new TypeError(
        "Capability idempotency conflicts with its MCP annotation",
      );
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    id: resolvedId,
    mcpName: definition.mcpName,
    risk: definition.risk,
    idempotent,
    scopes: Object.freeze(normalizedScopes(definition.scopes)),
    ...(definition.cli !== undefined
      ? {
          cli: Object.freeze({
            command: Object.freeze([...definition.cli.command]) as [
              string,
              ...string[],
            ],
            ...(definition.cli.description
              ? { description: definition.cli.description }
              : {}),
            presentation: definition.cli.presentation ?? "auto",
            ...(definition.cli.examples
              ? { examples: Object.freeze([...definition.cli.examples]) }
              : {}),
          }),
        }
      : {}),
  });
}

export function capabilityManifest(
  definition: ChumboCapabilityDefinition,
): ChumboCapabilityManifestV1 {
  return validateDefinition(definition);
}

export function defineCapability<
  Input extends StandardSchemaWithJSON | undefined,
  Output extends StandardSchemaWithJSON | undefined = undefined,
>(
  definition: ChumboCapabilityDefinition<Input, Output>,
): DefinedChumboCapability<Input, Output> {
  const manifest = validateDefinition(definition);
  return Object.freeze({ ...definition, id: manifest.id, manifest });
}

export function capabilityAnnotationsFor(capability: {
  readonly title?: string;
  readonly risk: ChumboCapabilityRisk;
  readonly annotations?: ToolAnnotations;
  readonly manifest: Pick<ChumboCapabilityManifestV1, "idempotent">;
}): ToolAnnotations {
  return {
    ...capability.annotations,
    title: capability.annotations?.title ?? capability.title,
    readOnlyHint: capability.risk === "read",
    destructiveHint: capability.risk === "destructive",
    idempotentHint: capability.manifest.idempotent,
  };
}

/** Lower shared capability metadata to an ordinary MCP tool registration. */
export function registerCapability<
  Input extends StandardSchemaWithJSON | undefined,
  Output extends StandardSchemaWithJSON | undefined,
>(
  server: SupabaseMcpServer,
  capability: DefinedChumboCapability<Input, Output>,
): RegisteredTool {
  const target = server.withScopes(capability.manifest.scopes);
  const config = withOpenOutputSchema({
    ...(capability.title ? { title: capability.title } : {}),
    description: capability.description,
    ...(capability.inputSchema ? { inputSchema: capability.inputSchema } : {}),
    ...(capability.outputSchema
      ? { outputSchema: capability.outputSchema }
      : {}),
    annotations: capabilityAnnotationsFor(capability),
    _meta: {
      ...capability.mcpMeta,
      [CHUMBO_CAPABILITY_META_KEY]: capability.manifest,
    },
  });
  return target.registerTool(capability.mcpName, config, capability.handler);
}
