import type {
  CallToolResult,
  RegisteredTool,
  ServerContext,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  capabilityAnnotationsFor,
  capabilityManifest,
  CHUMBO_CAPABILITY_META_KEY,
  type ChumboCapabilityRisk,
  type ChumboCliProjection,
} from "./capabilities.js";
import { withOpenOutputSchema } from "./internal/open-output-schema.js";
import { errorResult } from "./results.js";
import type { SupabaseMcpContext, SupabaseMcpServer } from "./types.js";

export interface ProjectedFieldRule<
  Shape extends z.ZodRawShape,
  Database = unknown,
> {
  /** Scope string (`ctx.hasScope(scope)`), scope array (`ctx.hasScopes(scopes)`), or request-time predicate. */
  readonly allow:
    | string
    | readonly string[]
    | ((context: SupabaseMcpContext<Database>) => boolean | Promise<boolean>);
  /** Concise bullet rendered into the projected tool description when this field is permitted. */
  readonly summary: string;
  /** Companion optional fields in `Shape` included only when this field is permitted (e.g. `version_id` for `source_date`). */
  readonly companionFields?: readonly (keyof Shape & string)[];
}

export interface ProjectInputFieldsConfig<
  Shape extends z.ZodRawShape,
  GuardedKey extends keyof Shape & string,
  Database = unknown,
> {
  /** Base Zod object schema declaring all target, guarded, and companion fields. */
  readonly schema: z.ZodObject<Shape>;
  /** Target identifier fields always exposed when the tool mounts (e.g. `["path"]` or `["id"]`). */
  readonly alwaysInclude: readonly Exclude<keyof Shape & string, GuardedKey>[];
  /** Deterministic evaluation/application order of guarded fields. */
  readonly fields: Readonly<
    Record<GuardedKey, ProjectedFieldRule<Shape, Database>>
  >;
  /** Require at least one guarded field in every call. Defaults to `true`. */
  readonly requireAtLeastOne?: boolean;
  /** Omit the tool from `tools/list` (do not register) when zero guarded fields are permitted. Defaults to `true`. */
  readonly dropWhenEmpty?: boolean;
  /** Render the projected tool title from the active permitted field names. */
  readonly title?: (permittedFields: readonly GuardedKey[]) => string;
  /** Render the projected tool description from active permitted fields and their formatted bullets. */
  readonly description: (input: {
    readonly permittedFields: readonly GuardedKey[];
    readonly bullets: readonly string[];
  }) => string;
}

export interface ValidatedFieldPlan<
  Shape extends z.ZodRawShape,
  GuardedKey extends keyof Shape & string,
> {
  /** Ordered list of guarded fields actually supplied in this call (all verified permitted at call time). */
  readonly fields: readonly GuardedKey[];
  /** Parsed, type-safe input values. */
  readonly input: z.output<z.ZodObject<Shape>>;
}

export type FieldPlanAuthorizationResult<
  Shape extends z.ZodRawShape,
  GuardedKey extends keyof Shape & string,
> =
  | {
      readonly ok: true;
      readonly plan: ValidatedFieldPlan<Shape, GuardedKey>;
    }
  | {
      readonly ok: false;
      readonly result: CallToolResult;
    };

export interface ProjectedToolContract<
  Shape extends z.ZodRawShape,
  GuardedKey extends keyof Shape & string,
  Database = unknown,
> {
  readonly permittedFields: readonly GuardedKey[];
  readonly title?: string;
  readonly description: string;
  /**
   * Standard Schema advertising ONLY `alwaysInclude` + `permittedFields` + active
   * `companionFields` in `tools/list` (`additionalProperties: false`), while
   * validating known fields cleanly so call-time authorization produces actionable
   * domain refusals instead of opaque schema errors.
   */
  readonly inputSchema: StandardSchemaWithJSON<
    z.input<z.ZodObject<Shape>>,
    z.output<z.ZodObject<Shape>>
  >;
  authorize(
    parsedInput: z.output<z.ZodObject<Shape>>,
    toolName: string,
    callTimeContext?: SupabaseMcpContext<Database>,
  ): Promise<FieldPlanAuthorizationResult<Shape, GuardedKey>>;
}

export interface ProjectedCapabilityRegistration<
  Shape extends z.ZodRawShape,
  GuardedKey extends keyof Shape & string,
  Output extends StandardSchemaWithJSON | undefined = undefined,
  Database = unknown,
> extends ProjectInputFieldsConfig<Shape, GuardedKey, Database> {
  readonly id?: string;
  readonly mcpName: string;
  readonly risk: Exclude<ChumboCapabilityRisk, "read">;
  readonly idempotent?: boolean;
  readonly scopes?: readonly string[];
  readonly cli?: ChumboCliProjection;
  readonly outputSchema?: Output;
  readonly annotations?: ToolAnnotations;
  readonly mcpMeta?: Readonly<Record<string, unknown>>;
  readonly handler: (
    plan: ValidatedFieldPlan<Shape, GuardedKey>,
    mcpContext: ServerContext,
  ) => CallToolResult | Promise<CallToolResult>;
}

async function isFieldAllowed<Shape extends z.ZodRawShape, Database>(
  rule: ProjectedFieldRule<Shape, Database>,
  context: SupabaseMcpContext<Database>,
): Promise<boolean> {
  if (typeof rule.allow === "string") {
    return context.hasScope(rule.allow);
  }
  if (typeof rule.allow === "function") {
    return Boolean(await rule.allow(context));
  }
  return context.hasScopes(rule.allow);
}

async function resolvePermittedFields<
  Shape extends z.ZodRawShape,
  GuardedKey extends keyof Shape & string,
  Database,
>(
  fields: Readonly<Record<GuardedKey, ProjectedFieldRule<Shape, Database>>>,
  orderedKeys: readonly GuardedKey[],
  context: SupabaseMcpContext<Database>,
): Promise<GuardedKey[]> {
  const permitted: GuardedKey[] = [];
  for (const key of orderedKeys) {
    if (await isFieldAllowed(fields[key], context)) {
      permitted.push(key);
    }
  }
  return permitted;
}

/**
 * Compile a permission-projected input contract for `context`, returning `null`
 * when zero guarded fields are permitted and `dropWhenEmpty` is `true` (default).
 */
export async function projectInputFields<
  Shape extends z.ZodRawShape,
  GuardedKey extends keyof Shape & string,
  Database = unknown,
>(
  context: SupabaseMcpContext<Database>,
  config: ProjectInputFieldsConfig<Shape, GuardedKey, Database>,
): Promise<ProjectedToolContract<Shape, GuardedKey, Database> | null> {
  const baseShape = config.schema.shape;
  const orderedGuardedKeys = Object.keys(config.fields) as GuardedKey[];
  if (orderedGuardedKeys.length === 0) {
    throw new RangeError(
      "projectInputFields requires at least one guarded field",
    );
  }
  for (const key of config.alwaysInclude) {
    if (!(key in baseShape)) {
      throw new TypeError(
        `alwaysInclude field '${key}' does not exist in base schema`,
      );
    }
  }

  const companionOwners = new Map<string, GuardedKey[]>();
  for (const key of orderedGuardedKeys) {
    if (!(key in baseShape)) {
      throw new TypeError(
        `Guarded field '${key}' does not exist in base schema`,
      );
    }
    for (const companion of config.fields[key].companionFields ?? []) {
      if (!(companion in baseShape)) {
        throw new TypeError(
          `Companion field '${companion}' does not exist in base schema`,
        );
      }
      let owners = companionOwners.get(companion);
      if (!owners) {
        owners = [];
        companionOwners.set(companion, owners);
      }
      owners.push(key);
    }
  }

  const permittedFields = Object.freeze(
    await resolvePermittedFields(config.fields, orderedGuardedKeys, context),
  );
  if (permittedFields.length === 0 && config.dropWhenEmpty !== false) {
    return null;
  }

  const projectedShape: Record<string, z.core.$ZodType> = {};
  for (const alwaysKey of config.alwaysInclude) {
    projectedShape[alwaysKey] = baseShape[alwaysKey]!;
  }
  for (const guardedKey of permittedFields) {
    projectedShape[guardedKey] = baseShape[guardedKey]!;
    for (const companion of config.fields[guardedKey].companionFields ?? []) {
      projectedShape[companion] = baseShape[companion]!;
    }
  }

  const advertisedStrictSchema = z.object(projectedShape).strict();
  const fullStrictSchema = config.schema.strict();
  const fullStandard = fullStrictSchema["~standard"];
  const advertisedStandard = advertisedStrictSchema["~standard"];

  type ConverterOptions = Parameters<
    typeof advertisedStandard.jsonSchema.input
  >[0];
  const inputSchema: StandardSchemaWithJSON<
    z.input<z.ZodObject<Shape>>,
    z.output<z.ZodObject<Shape>>
  > = {
    "~standard": {
      version: 1 as const,
      vendor: fullStandard.vendor,
      ...(fullStandard.types ? { types: fullStandard.types } : {}),
      validate: (
        value: unknown,
        options?: Parameters<typeof fullStandard.validate>[1],
      ) => fullStandard.validate(value, options),
      jsonSchema: {
        input: (options: ConverterOptions) =>
          advertisedStandard.jsonSchema.input(options),
        output: (options: ConverterOptions) =>
          advertisedStandard.jsonSchema.output(options),
      },
    },
  };

  const bullets = Object.freeze(
    permittedFields.map(
      (field) => `- ${field}: ${config.fields[field].summary}`,
    ),
  );
  const title = config.title ? config.title(permittedFields) : undefined;
  const description = config.description({ permittedFields, bullets });

  const authorize = async (
    parsedInput: z.output<z.ZodObject<Shape>>,
    toolName: string,
    callTimeContext: SupabaseMcpContext<Database> = context,
  ): Promise<FieldPlanAuthorizationResult<Shape, GuardedKey>> => {
    const record = parsedInput as Record<string, unknown>;
    const freshPermitted = await resolvePermittedFields(
      config.fields,
      orderedGuardedKeys,
      callTimeContext,
    );
    const freshPermittedSet = new Set<string>(freshPermitted);

    const supplied = orderedGuardedKeys.filter(
      (key) => record[key] !== undefined,
    );

    if (config.requireAtLeastOne !== false && supplied.length === 0) {
      const targetList =
        freshPermitted.length > 0
          ? freshPermitted.join(", ")
          : orderedGuardedKeys.join(", ");
      return {
        ok: false,
        result: errorResult(
          `${toolName} requires at least one of ${targetList}.`,
          "Supply at least one permitted field; nothing was changed.",
        ),
      };
    }

    for (const [companion, owners] of companionOwners.entries()) {
      if (
        record[companion] !== undefined &&
        !owners.some((owner) => supplied.includes(owner))
      ) {
        const ownerLabel = owners.join(" or ");
        return {
          ok: false,
          result: errorResult(
            `${companion} applies only when ${ownerLabel} is supplied. Nothing was changed.`,
            `Include ${ownerLabel} or omit ${companion}.`,
          ),
        };
      }
    }

    const refused = supplied.filter((key) => !freshPermittedSet.has(key));
    if (refused.length > 0) {
      const recovery =
        freshPermitted.length > 0
          ? `Resend with only permitted fields (${freshPermitted.join(", ")}).`
          : `This connection currently has no edit permission for ${toolName}.`;
      return {
        ok: false,
        result: errorResult(
          `${toolName} cannot change ${refused.join(", ")} on this connection. Nothing was changed.`,
          recovery,
        ),
      };
    }

    return {
      ok: true,
      plan: Object.freeze({
        fields: Object.freeze(supplied),
        input: parsedInput,
      }),
    };
  };

  return Object.freeze({
    permittedFields,
    ...(title !== undefined ? { title } : {}),
    description,
    inputSchema,
    authorize,
  });
}

/**
 * Register a mutating capability whose advertised `inputSchema` and `description`
 * expose only fields permitted for `context`, while re-evaluating field permissions
 * atomically at call time before `handler` executes.
 */
export async function registerProjectedCapability<
  Shape extends z.ZodRawShape,
  GuardedKey extends keyof Shape & string,
  Output extends StandardSchemaWithJSON | undefined = undefined,
  Database = unknown,
>(
  server: SupabaseMcpServer,
  context: SupabaseMcpContext<Database>,
  config: ProjectedCapabilityRegistration<Shape, GuardedKey, Output, Database>,
): Promise<RegisteredTool | null> {
  const projected = await projectInputFields(context, config);
  if (!projected) return null;

  const manifest = capabilityManifest({
    ...(config.id ? { id: config.id } : {}),
    mcpName: config.mcpName,
    ...(projected.title ? { title: projected.title } : {}),
    description: projected.description,
    inputSchema: projected.inputSchema,
    ...(config.outputSchema ? { outputSchema: config.outputSchema } : {}),
    ...(config.scopes ? { scopes: config.scopes } : {}),
    risk: config.risk,
    ...(config.idempotent !== undefined
      ? { idempotent: config.idempotent }
      : {}),
    ...(config.cli ? { cli: config.cli } : {}),
    ...(config.annotations ? { annotations: config.annotations } : {}),
    handler: async () => ({ content: [] }),
  });

  const target = server.withScopes(manifest.scopes);
  const toolConfig = withOpenOutputSchema({
    ...(projected.title ? { title: projected.title } : {}),
    description: projected.description,
    inputSchema: projected.inputSchema,
    ...(config.outputSchema ? { outputSchema: config.outputSchema } : {}),
    annotations: capabilityAnnotationsFor({
      title: projected.title,
      risk: config.risk,
      annotations: config.annotations,
      manifest,
    }),
    _meta: {
      ...config.mcpMeta,
      [CHUMBO_CAPABILITY_META_KEY]: manifest,
    },
  });

  return target.registerTool(
    config.mcpName,
    toolConfig,
    async (parsedInput, mcpContext) => {
      const check = await projected.authorize(
        parsedInput,
        config.mcpName,
        context,
      );
      if (!check.ok) return check.result;
      return config.handler(check.plan, mcpContext);
    },
  );
}
