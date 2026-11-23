import {
  compareCanonicalText,
  computeCanonicalSurfaceDigest,
  SURFACE_CANONICAL_LIMITS,
} from "./internal/surface-canonical.js";
import {
  estimateCatalogTokens,
  estimateToolTokens,
  SURFACE_TOKEN_LIMITS,
  TOKEN_ESTIMATOR_ID,
} from "./surface-tokens.js";
import type { SupabaseMcpSurfaceTool } from "./types.js";

export const SURFACE_DIFF_DEFAULTS = Object.freeze({
  failOn: Object.freeze([
    "breaking",
    "authority-widening",
    "context-regression",
  ] as const),
  maxTokenDelta: 500,
  maxCatalogTokens: SURFACE_TOKEN_LIMITS.catalogColdStartWarnTokens,
  bloatedToolSchemaTokens: SURFACE_TOKEN_LIMITS.bloatedInputSchemaTokens,
  bloatedToolGrowthTokens: 250,
});

export type SurfaceAuthMode =
  | "oauth"
  | "bearer"
  | "api-key"
  | "public"
  | "multi"
  | "unknown";

export interface LockedToolAuthorityMeta {
  readonly risk?: "read" | "write" | "destructive";
  readonly idempotent?: boolean;
  readonly scopes?: readonly string[];
  readonly visibility?: readonly ("model" | "app")[];
  readonly uiResourceUri?: string;
}

export interface LockedSurfaceContextBudget {
  readonly estimator: typeof TOKEN_ESTIMATOR_ID;
  readonly toolCount: number;
  readonly totalPromptTokens: number;
  readonly totalOutputSchemaTokens: number;
  readonly totalWireBytes: number;
  readonly perToolPromptTokens: Readonly<Record<string, number>>;
}

export interface LockedSurfaceEntry {
  readonly functionName: string;
  readonly profile: string;
  readonly serverName: string;
  readonly authMode: SurfaceAuthMode;
  readonly anonAccessible: boolean;
  /** Exact SHA-256 of JSON.stringify({ schemaVersion: 1, tools }), matching onSurface. */
  readonly contentDigest: `sha256:${string}`;
  readonly contextBudget: LockedSurfaceContextBudget;
  readonly toolAuthority: Readonly<Record<string, LockedToolAuthorityMeta>>;
  readonly tools: readonly SupabaseMcpSurfaceTool[];
}

export interface McpSurfaceLockfileV1 {
  readonly lockfileVersion: 1;
  readonly surfaces: Readonly<Record<string, LockedSurfaceEntry>>;
}

export type SurfaceDiffCategory =
  | "breaking"
  | "authority-widening"
  | "context-regression"
  | "additive";

export type SurfaceDiffRuleCode =
  | "surface-removed"
  | "tool-removed"
  | "input-required-added"
  | "input-property-removed"
  | "input-type-narrowed"
  | "input-enum-narrowed"
  | "input-bounds-tightened"
  | "output-schema-removed"
  | "output-property-removed"
  | "output-type-widened"
  | "surface-anon-opened"
  | "anon-tool-added"
  | "read-only-hint-dropped"
  | "destructive-hint-dropped"
  | "destructive-or-open-world-added"
  | "scope-requirement-widened"
  | "model-visibility-widened"
  | "catalog-token-delta-exceeded"
  | "catalog-token-ceiling-exceeded"
  | "tool-schema-bloated"
  | "surface-added"
  | "tool-added"
  | "input-optional-added"
  | "output-property-added"
  | "prose-updated"
  | "context-reduced";

export interface SurfaceDiffFinding {
  readonly surfaceKey: string;
  readonly category: SurfaceDiffCategory;
  readonly code: SurfaceDiffRuleCode;
  readonly tool?: string;
  readonly schemaPath?: string;
  readonly detail: string;
}

export interface SurfaceSnapshotReport {
  readonly schemaVersion: 1;
  readonly command: "surface snapshot";
  readonly status: "planned" | "needs_confirmation" | "unchanged" | "complete";
  readonly lockfilePath: string;
  readonly surfaces: ReadonlyArray<{
    readonly key: string;
    readonly contentDigest: `sha256:${string}`;
    readonly toolCount: number;
    readonly totalPromptTokens: number;
    readonly changed: boolean;
  }>;
  readonly nextCommand?: string;
}

export interface SurfaceEntryDiff {
  readonly key: string;
  readonly baselineDigest: `sha256:${string}` | null;
  readonly candidateDigest: `sha256:${string}` | null;
  readonly baselinePromptTokens: number;
  readonly candidatePromptTokens: number;
  readonly promptTokenDelta: number;
  readonly findings: readonly SurfaceDiffFinding[];
}

export interface SurfaceDiffReport {
  readonly schemaVersion: 1;
  readonly command: "surface diff";
  readonly status: "unchanged" | "compatible" | "policy_failed";
  readonly exitCode: 0 | 2;
  readonly lockfilePath: string;
  readonly failOn: readonly SurfaceDiffCategory[];
  readonly frozen: boolean;
  readonly summary: {
    readonly breaking: number;
    readonly authorityWidening: number;
    readonly contextRegression: number;
    readonly additive: number;
    readonly promptTokenDelta: number;
  };
  readonly surfaces: readonly SurfaceEntryDiff[];
  readonly nextCommand?: string;
}

export interface DiffSurfaceOptions {
  readonly failOn?: readonly SurfaceDiffCategory[];
  readonly frozen?: boolean;
  readonly maxTokenDelta?: number;
  readonly maxCatalogTokens?: number;
  readonly bloatedToolSchemaTokens?: number;
  readonly bloatedToolGrowthTokens?: number;
  readonly lockfilePath?: string;
}

export interface BuildLockedSurfaceEntryInput {
  readonly functionName: string;
  readonly profile?: string;
  readonly serverName: string;
  readonly authMode?: SurfaceAuthMode;
  readonly anonAccessible?: boolean;
  readonly tools: readonly unknown[];
  readonly toolAuthority?: Readonly<Record<string, LockedToolAuthorityMeta>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CAPABILITY_META_KEY = "dev.chumbo/capability";

function extractToolAuthorityFromRaw(
  rawTool: unknown,
): LockedToolAuthorityMeta | undefined {
  if (!isRecord(rawTool) || !isRecord(rawTool._meta)) return undefined;
  const meta = rawTool._meta;
  const cap = isRecord(meta[CAPABILITY_META_KEY])
    ? meta[CAPABILITY_META_KEY]
    : undefined;
  const ui = isRecord(meta.ui) ? meta.ui : undefined;

  let risk: LockedToolAuthorityMeta["risk"];
  if (
    cap &&
    (cap.risk === "read" || cap.risk === "write" || cap.risk === "destructive")
  ) {
    risk = cap.risk;
  }
  const idempotent =
    cap && typeof cap.idempotent === "boolean" ? cap.idempotent : undefined;
  let scopes: readonly string[] | undefined;
  if (cap && Array.isArray(cap.scopes)) {
    const normalized = [
      ...new Set(
        cap.scopes.filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.trim().length > 0,
        ),
      ),
    ].sort(compareCanonicalText);
    scopes = Object.freeze(normalized);
  }

  let visibility: readonly ("model" | "app")[] | undefined;
  if (ui && Array.isArray(ui.visibility)) {
    const vis = [
      ...new Set(
        ui.visibility.filter(
          (entry): entry is "model" | "app" =>
            entry === "model" || entry === "app",
        ),
      ),
    ].sort(compareCanonicalText);
    if (vis.length > 0) visibility = Object.freeze(vis);
  }

  const uiResourceUri =
    ui && typeof ui.resourceUri === "string" && ui.resourceUri.length > 0
      ? ui.resourceUri
      : typeof meta["ui/resourceUri"] === "string" &&
          meta["ui/resourceUri"].length > 0
        ? meta["ui/resourceUri"]
        : undefined;

  if (
    risk === undefined &&
    idempotent === undefined &&
    scopes === undefined &&
    visibility === undefined &&
    uiResourceUri === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    ...(risk !== undefined ? { risk } : {}),
    ...(idempotent !== undefined ? { idempotent } : {}),
    ...(scopes !== undefined ? { scopes } : {}),
    ...(visibility !== undefined ? { visibility } : {}),
    ...(uiResourceUri !== undefined ? { uiResourceUri } : {}),
  });
}

function normalizeToolAuthorityMeta(
  meta: LockedToolAuthorityMeta,
): LockedToolAuthorityMeta | undefined {
  const scopes =
    meta.scopes !== undefined
      ? Object.freeze(
          [...new Set(meta.scopes.filter((s) => s.length > 0))].sort(
            compareCanonicalText,
          ),
        )
      : undefined;
  const visibility =
    meta.visibility !== undefined && meta.visibility.length > 0
      ? Object.freeze([...new Set(meta.visibility)].sort(compareCanonicalText))
      : undefined;
  if (
    meta.risk === undefined &&
    meta.idempotent === undefined &&
    scopes === undefined &&
    visibility === undefined &&
    meta.uiResourceUri === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    ...(meta.risk !== undefined ? { risk: meta.risk } : {}),
    ...(meta.idempotent !== undefined ? { idempotent: meta.idempotent } : {}),
    ...(scopes !== undefined ? { scopes } : {}),
    ...(visibility !== undefined ? { visibility } : {}),
    ...(meta.uiResourceUri !== undefined
      ? { uiResourceUri: meta.uiResourceUri }
      : {}),
  });
}

/**
 * Builds a canonical, deterministic `LockedSurfaceEntry` whose `contentDigest`
 * matches `SupabaseMcpSurfaceProof.contentDigest` emitted by `onSurface` bit-for-bit.
 */
export async function buildLockedSurfaceEntry(
  input: BuildLockedSurfaceEntryInput,
): Promise<LockedSurfaceEntry> {
  const canonical = await computeCanonicalSurfaceDigest(input.tools);
  if (!canonical) {
    throw new Error(
      `MCP tool surface for '${input.functionName}' exceeded canonical surface bounds or contained invalid tool entries.`,
    );
  }
  const profile = input.profile?.trim() || "default";
  const authMode: SurfaceAuthMode = input.authMode ?? "oauth";
  const anonAccessible = input.anonAccessible ?? authMode === "public";

  const rawAuthorityByName = new Map<string, LockedToolAuthorityMeta>();
  for (const rawTool of input.tools) {
    if (!isRecord(rawTool) || typeof rawTool.name !== "string") continue;
    const extracted = extractToolAuthorityFromRaw(rawTool);
    if (extracted) rawAuthorityByName.set(rawTool.name, extracted);
  }
  if (input.toolAuthority) {
    for (const [name, meta] of Object.entries(input.toolAuthority)) {
      const normalized = normalizeToolAuthorityMeta(meta);
      if (normalized) rawAuthorityByName.set(name, normalized);
    }
  }

  const sortedAuthority: Record<string, LockedToolAuthorityMeta> = {};
  for (const tool of canonical.tools) {
    const meta = rawAuthorityByName.get(tool.name);
    if (meta) sortedAuthority[tool.name] = meta;
  }

  const tokenReport = estimateCatalogTokens(canonical.tools);
  const perToolByName = new Map(
    tokenReport.tools.map((entry) => [entry.name, entry.promptTokens] as const),
  );
  const perToolPromptTokens: Record<string, number> = {};
  for (const tool of canonical.tools) {
    perToolPromptTokens[tool.name] = perToolByName.get(tool.name) ?? 0;
  }

  return Object.freeze({
    functionName: input.functionName,
    profile,
    serverName: input.serverName,
    authMode,
    anonAccessible,
    contentDigest: canonical.contentDigest,
    contextBudget: Object.freeze({
      estimator: TOKEN_ESTIMATOR_ID,
      toolCount: tokenReport.toolCount,
      totalPromptTokens: tokenReport.totalPromptTokens,
      totalOutputSchemaTokens: tokenReport.totalOutputSchemaTokens,
      totalWireBytes: tokenReport.totalWireBytes,
      perToolPromptTokens: Object.freeze(perToolPromptTokens),
    }),
    toolAuthority: Object.freeze(sortedAuthority),
    tools: canonical.tools,
  });
}

export function surfaceLockKey(
  functionName: string,
  profile = "default",
): string {
  const normalizedProfile = profile.trim() || "default";
  return normalizedProfile === "default"
    ? functionName
    : `${functionName}:${normalizedProfile}`;
}

// ---------------------------------------------------------------------------
// JSON Schema Contravariant (Input) & Covariant (Output) Helpers
// ---------------------------------------------------------------------------

const JSON_SCHEMA_PRIMITIVES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);

function primitiveTypeOfValue(value: unknown): string | undefined {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  if (isRecord(value)) return "object";
  return undefined;
}

/**
 * Returns the explicit set of allowed JSON Schema types at `schema`, or `null`
 * when `schema` leaves `type` unconstrained.
 */
function schemaTypeSet(
  schema: Record<string, unknown>,
  depth = 0,
): Set<string> | null {
  if (depth > SURFACE_CANONICAL_LIMITS.maxJsonDepth) return null;
  if (
    typeof schema.type === "string" &&
    JSON_SCHEMA_PRIMITIVES.has(schema.type)
  ) {
    return new Set([schema.type]);
  }
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter(
      (entry): entry is string =>
        typeof entry === "string" && JSON_SCHEMA_PRIMITIVES.has(entry),
    );
    return types.length > 0 ? new Set(types) : null;
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches) || branches.length === 0) continue;
    const union = new Set<string>();
    for (const branch of branches) {
      if (!isRecord(branch)) return null;
      const sub = schemaTypeSet(branch, depth + 1);
      if (!sub) return null;
      for (const t of sub) union.add(t);
    }
    return union;
  }
  if ("const" in schema) {
    const inferred = primitiveTypeOfValue(schema.const);
    return inferred ? new Set([inferred]) : null;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const inferred = new Set<string>();
    for (const item of schema.enum) {
      const t = primitiveTypeOfValue(item);
      if (!t) return null;
      inferred.add(t);
    }
    return inferred;
  }
  return null;
}

/** Whether `superset` accepts every JSON value type accepted by `subset`. */
function typesCover(
  superset: Set<string> | null,
  subset: Set<string> | null,
): boolean {
  if (superset === null) return true; // Unconstrained accepts everything.
  if (subset === null) return false; // Constrained does not cover unconstrained.
  for (const t of subset) {
    if (superset.has(t)) continue;
    if (t === "integer" && superset.has("number")) continue;
    return false;
  }
  return true;
}

function formatTypeSet(types: Set<string> | null): string {
  return types === null
    ? "any"
    : [...types].sort(compareCanonicalText).join(" | ");
}

function enumValueSet(schema: Record<string, unknown>): Set<string> | null {
  if (Array.isArray(schema.enum)) {
    return new Set(schema.enum.map((entry) => JSON.stringify(entry)));
  }
  if ("const" in schema && schema.const !== undefined) {
    return new Set([JSON.stringify(schema.const)]);
  }
  return null;
}

function requiredSetOf(schema: Record<string, unknown>): Set<string> {
  if (!Array.isArray(schema.required)) return new Set();
  return new Set(
    schema.required.filter(
      (entry): entry is string => typeof entry === "string",
    ),
  );
}

function propertiesMapOf(
  schema: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  if (!isRecord(schema.properties)) return {};
  const result: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    if (isRecord(value)) result[key] = value;
  }
  return result;
}

function numericField(
  schema: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = schema[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

interface SchemaDiffState {
  readonly surfaceKey: string;
  readonly toolName: string;
  readonly findings: SurfaceDiffFinding[];
  proseChanged: boolean;
}

function diffInputSchemaNode(
  base: Record<string, unknown>,
  cand: Record<string, unknown>,
  path: string,
  state: SchemaDiffState,
  depth = 0,
): void {
  if (depth > SURFACE_CANONICAL_LIMITS.maxJsonDepth) return;

  if (base.description !== cand.description || base.title !== cand.title) {
    state.proseChanged = true;
  }

  // 1. Contravariant type check: candidate must cover all types baseline accepted.
  const baseTypes = schemaTypeSet(base);
  const candTypes = schemaTypeSet(cand);
  if (!typesCover(candTypes, baseTypes)) {
    state.findings.push(
      Object.freeze({
        surfaceKey: state.surfaceKey,
        category: "breaking",
        code: "input-type-narrowed",
        tool: state.toolName,
        schemaPath: path,
        detail: `Tool '${state.toolName}' narrowed input type at ${path} from '${formatTypeSet(baseTypes)}' to '${formatTypeSet(candTypes)}'.`,
      }),
    );
  } else if (!typesCover(baseTypes, candTypes)) {
    state.findings.push(
      Object.freeze({
        surfaceKey: state.surfaceKey,
        category: "additive",
        code: "input-optional-added",
        tool: state.toolName,
        schemaPath: path,
        detail: `Tool '${state.toolName}' widened input type at ${path} from '${formatTypeSet(baseTypes)}' to '${formatTypeSet(candTypes)}'.`,
      }),
    );
  }

  // 2. Contravariant enum/const check.
  const baseEnum = enumValueSet(base);
  const candEnum = enumValueSet(cand);
  if (candEnum !== null && baseEnum === null) {
    state.findings.push(
      Object.freeze({
        surfaceKey: state.surfaceKey,
        category: "breaking",
        code: "input-enum-narrowed",
        tool: state.toolName,
        schemaPath: path,
        detail: `Tool '${state.toolName}' restricted previously unconstrained input at ${path} to enum [${[...candEnum].join(", ")}].`,
      }),
    );
  } else if (baseEnum !== null && candEnum !== null) {
    const removed = [...baseEnum].filter((item) => !candEnum.has(item));
    const added = [...candEnum].filter((item) => !baseEnum.has(item));
    if (removed.length > 0) {
      state.findings.push(
        Object.freeze({
          surfaceKey: state.surfaceKey,
          category: "breaking",
          code: "input-enum-narrowed",
          tool: state.toolName,
          schemaPath: path,
          detail: `Tool '${state.toolName}' removed allowed input enum value(s) ${removed.join(", ")} at ${path}.`,
        }),
      );
    } else if (added.length > 0) {
      state.findings.push(
        Object.freeze({
          surfaceKey: state.surfaceKey,
          category: "additive",
          code: "input-optional-added",
          tool: state.toolName,
          schemaPath: path,
          detail: `Tool '${state.toolName}' added allowed input enum value(s) ${added.join(", ")} at ${path}.`,
        }),
      );
    }
  } else if (
    baseEnum !== null &&
    candEnum === null &&
    typesCover(candTypes, baseTypes)
  ) {
    state.findings.push(
      Object.freeze({
        surfaceKey: state.surfaceKey,
        category: "additive",
        code: "input-optional-added",
        tool: state.toolName,
        schemaPath: path,
        detail: `Tool '${state.toolName}' relaxed enum constraint at ${path}.`,
      }),
    );
  }

  // 3. Input bounds & pattern tightening.
  const tightenedReasons: string[] = [];
  for (const key of [
    "minimum",
    "exclusiveMinimum",
    "minLength",
    "minItems",
  ] as const) {
    const b = numericField(base, key);
    const c = numericField(cand, key);
    if (c !== undefined && (b === undefined || c > b)) {
      tightenedReasons.push(`${key} ${b ?? "unbounded"} -> ${c}`);
    }
  }
  for (const key of [
    "maximum",
    "exclusiveMaximum",
    "maxLength",
    "maxItems",
  ] as const) {
    const b = numericField(base, key);
    const c = numericField(cand, key);
    if (c !== undefined && (b === undefined || c < b)) {
      tightenedReasons.push(`${key} ${b ?? "unbounded"} -> ${c}`);
    }
  }
  const basePattern =
    typeof base.pattern === "string" ? base.pattern : undefined;
  const candPattern =
    typeof cand.pattern === "string" ? cand.pattern : undefined;
  if (candPattern !== undefined && candPattern !== basePattern) {
    tightenedReasons.push(
      basePattern === undefined
        ? `added pattern ${JSON.stringify(candPattern)}`
        : `changed pattern ${JSON.stringify(basePattern)} -> ${JSON.stringify(candPattern)}`,
    );
  }
  if (tightenedReasons.length > 0) {
    state.findings.push(
      Object.freeze({
        surfaceKey: state.surfaceKey,
        category: "breaking",
        code: "input-bounds-tightened",
        tool: state.toolName,
        schemaPath: path,
        detail: `Tool '${state.toolName}' tightened input bounds at ${path} (${tightenedReasons.join("; ")}).`,
      }),
    );
  }

  // 4. Object properties & required set.
  const baseProps = propertiesMapOf(base);
  const candProps = propertiesMapOf(cand);
  const baseReq = requiredSetOf(base);
  const candReq = requiredSetOf(cand);
  const allPropKeys = [
    ...new Set([...Object.keys(baseProps), ...Object.keys(candProps)]),
  ].sort(compareCanonicalText);

  // Check required additions even if property had no entry in `properties`.
  for (const reqKey of [...candReq].sort(compareCanonicalText)) {
    if (baseReq.has(reqKey)) continue;
    const candProp = candProps[reqKey];
    const hasDefault = candProp !== undefined && "default" in candProp;
    if (!hasDefault) {
      state.findings.push(
        Object.freeze({
          surfaceKey: state.surfaceKey,
          category: "breaking",
          code: "input-required-added",
          tool: state.toolName,
          schemaPath: `${path}.properties.${reqKey}`,
          detail: `Tool '${state.toolName}' made input '${reqKey}' required without a default at ${path}.properties.${reqKey}.`,
        }),
      );
    }
  }

  for (const key of allPropKeys) {
    const propPath = `${path}.properties.${key}`;
    const bProp = baseProps[key];
    const cProp = candProps[key];
    if (bProp && !cProp) {
      if (cand.additionalProperties !== true) {
        state.findings.push(
          Object.freeze({
            surfaceKey: state.surfaceKey,
            category: "breaking",
            code: "input-property-removed",
            tool: state.toolName,
            schemaPath: propPath,
            detail: `Tool '${state.toolName}' removed accepted input property '${key}' at ${propPath}.`,
          }),
        );
      }
      continue;
    }
    if (!bProp && cProp) {
      const hasDefault = "default" in cProp;
      if (!candReq.has(key) || hasDefault) {
        state.findings.push(
          Object.freeze({
            surfaceKey: state.surfaceKey,
            category: "additive",
            code: "input-optional-added",
            tool: state.toolName,
            schemaPath: propPath,
            detail: `Tool '${state.toolName}' added optional input property '${key}' at ${propPath}.`,
          }),
        );
      }
      continue;
    }
    if (bProp && cProp) {
      if (baseReq.has(key) && !candReq.has(key)) {
        state.findings.push(
          Object.freeze({
            surfaceKey: state.surfaceKey,
            category: "additive",
            code: "input-optional-added",
            tool: state.toolName,
            schemaPath: propPath,
            detail: `Tool '${state.toolName}' relaxed required input '${key}' to optional at ${propPath}.`,
          }),
        );
      }
      diffInputSchemaNode(bProp, cProp, propPath, state, depth + 1);
    }
  }

  if (isRecord(base.items) && isRecord(cand.items)) {
    diffInputSchemaNode(
      base.items,
      cand.items,
      `${path}.items`,
      state,
      depth + 1,
    );
  }
}

function diffOutputSchemaNode(
  base: Record<string, unknown>,
  cand: Record<string, unknown>,
  path: string,
  state: SchemaDiffState,
  depth = 0,
): void {
  if (depth > SURFACE_CANONICAL_LIMITS.maxJsonDepth) return;

  if (base.description !== cand.description || base.title !== cand.title) {
    state.proseChanged = true;
  }

  // 1. Covariant type check: baseline must cover all types candidate may emit.
  const baseTypes = schemaTypeSet(base);
  const candTypes = schemaTypeSet(cand);
  if (!typesCover(baseTypes, candTypes)) {
    state.findings.push(
      Object.freeze({
        surfaceKey: state.surfaceKey,
        category: "breaking",
        code: "output-type-widened",
        tool: state.toolName,
        schemaPath: path,
        detail: `Tool '${state.toolName}' widened or changed output type at ${path} from '${formatTypeSet(baseTypes)}' to '${formatTypeSet(candTypes)}'.`,
      }),
    );
  }

  // 2. Covariant enum check: candidate enum must be a subset of baseline enum.
  const baseEnum = enumValueSet(base);
  const candEnum = enumValueSet(cand);
  if (baseEnum !== null && candEnum === null) {
    state.findings.push(
      Object.freeze({
        surfaceKey: state.surfaceKey,
        category: "breaking",
        code: "output-type-widened",
        tool: state.toolName,
        schemaPath: path,
        detail: `Tool '${state.toolName}' dropped output enum guarantee at ${path}.`,
      }),
    );
  } else if (baseEnum !== null && candEnum !== null) {
    const addedVariants = [...candEnum].filter((item) => !baseEnum.has(item));
    if (addedVariants.length > 0) {
      state.findings.push(
        Object.freeze({
          surfaceKey: state.surfaceKey,
          category: "breaking",
          code: "output-type-widened",
          tool: state.toolName,
          schemaPath: path,
          detail: `Tool '${state.toolName}' widened output enum with variant(s) ${addedVariants.join(", ")} at ${path}.`,
        }),
      );
    }
  }

  // 3. Object properties & required guarantees.
  const baseProps = propertiesMapOf(base);
  const candProps = propertiesMapOf(cand);
  const baseReq = requiredSetOf(base);
  const candReq = requiredSetOf(cand);
  const allPropKeys = [
    ...new Set([...Object.keys(baseProps), ...Object.keys(candProps)]),
  ].sort(compareCanonicalText);

  for (const reqKey of [...baseReq].sort(compareCanonicalText)) {
    if (!candReq.has(reqKey) && candProps[reqKey] !== undefined) {
      state.findings.push(
        Object.freeze({
          surfaceKey: state.surfaceKey,
          category: "breaking",
          code: "output-property-removed",
          tool: state.toolName,
          schemaPath: `${path}.properties.${reqKey}`,
          detail: `Tool '${state.toolName}' dropped required guarantee on output property '${reqKey}' at ${path}.properties.${reqKey}.`,
        }),
      );
    }
  }

  for (const key of allPropKeys) {
    const propPath = `${path}.properties.${key}`;
    const bProp = baseProps[key];
    const cProp = candProps[key];
    if (bProp && !cProp) {
      state.findings.push(
        Object.freeze({
          surfaceKey: state.surfaceKey,
          category: "breaking",
          code: "output-property-removed",
          tool: state.toolName,
          schemaPath: propPath,
          detail: `Tool '${state.toolName}' removed output property '${key}' at ${propPath}.`,
        }),
      );
      continue;
    }
    if (!bProp && cProp) {
      state.findings.push(
        Object.freeze({
          surfaceKey: state.surfaceKey,
          category: "additive",
          code: "output-property-added",
          tool: state.toolName,
          schemaPath: propPath,
          detail: `Tool '${state.toolName}' added output property '${key}' at ${propPath}.`,
        }),
      );
      continue;
    }
    if (bProp && cProp) {
      diffOutputSchemaNode(bProp, cProp, propPath, state, depth + 1);
    }
  }

  if (isRecord(base.items) && isRecord(cand.items)) {
    diffOutputSchemaNode(
      base.items,
      cand.items,
      `${path}.items`,
      state,
      depth + 1,
    );
  }
}

// ---------------------------------------------------------------------------
// Surface & Lockfile Diff Engine
// ---------------------------------------------------------------------------

function isAppOnlyVisibility(
  meta: LockedToolAuthorityMeta | undefined,
): boolean {
  const vis = meta?.visibility;
  return Boolean(vis && vis.includes("app") && !vis.includes("model"));
}

function isDestructiveOrOpenWorldTool(
  tool: SupabaseMcpSurfaceTool,
  authority: LockedToolAuthorityMeta | undefined,
): { matched: boolean; reason: string } {
  if (tool.annotations?.destructiveHint === true) {
    return { matched: true, reason: "destructiveHint: true" };
  }
  if (authority?.risk === "destructive") {
    return { matched: true, reason: "risk: 'destructive'" };
  }
  if (tool.annotations?.openWorldHint === true) {
    return { matched: true, reason: "openWorldHint: true" };
  }
  return { matched: false, reason: "" };
}

export function diffLockedSurfaceEntries(
  surfaceKey: string,
  baseline: LockedSurfaceEntry | null,
  candidate: LockedSurfaceEntry | null,
  options?: DiffSurfaceOptions,
): SurfaceEntryDiff {
  const maxTokenDelta =
    options?.maxTokenDelta ?? SURFACE_DIFF_DEFAULTS.maxTokenDelta;
  const maxCatalogTokens =
    options?.maxCatalogTokens ?? SURFACE_DIFF_DEFAULTS.maxCatalogTokens;
  const bloatedLimit =
    options?.bloatedToolSchemaTokens ??
    SURFACE_DIFF_DEFAULTS.bloatedToolSchemaTokens;
  const bloatedGrowth =
    options?.bloatedToolGrowthTokens ??
    SURFACE_DIFF_DEFAULTS.bloatedToolGrowthTokens;

  const findings: SurfaceDiffFinding[] = [];

  if (baseline && !candidate) {
    findings.push(
      Object.freeze({
        surfaceKey,
        category: "breaking",
        code: "surface-removed",
        detail: `Locked surface '${surfaceKey}' was removed.`,
      }),
    );
    return Object.freeze({
      key: surfaceKey,
      baselineDigest: baseline.contentDigest,
      candidateDigest: null,
      baselinePromptTokens: baseline.contextBudget.totalPromptTokens,
      candidatePromptTokens: 0,
      promptTokenDelta: -baseline.contextBudget.totalPromptTokens,
      findings: Object.freeze(findings),
    });
  }

  if (!baseline && candidate) {
    findings.push(
      Object.freeze({
        surfaceKey,
        category: "additive",
        code: "surface-added",
        detail: `New surface '${surfaceKey}' added (${candidate.tools.length} tool(s), ~${candidate.contextBudget.totalPromptTokens} prompt tokens).`,
      }),
    );
    if (candidate.anonAccessible) {
      findings.push(
        Object.freeze({
          surfaceKey,
          category: "authority-widening",
          code: "surface-anon-opened",
          detail: `New surface '${surfaceKey}' is anonymously accessible (authMode: '${candidate.authMode}').`,
        }),
      );
      for (const tool of candidate.tools) {
        findings.push(
          Object.freeze({
            surfaceKey,
            category: "authority-widening",
            code: "anon-tool-added",
            tool: tool.name,
            detail: `Tool '${tool.name}' is exposed on anonymous surface '${surfaceKey}'.`,
          }),
        );
      }
    }
    for (const tool of candidate.tools) {
      const auth = candidate.toolAuthority[tool.name];
      const destructive = isDestructiveOrOpenWorldTool(tool, auth);
      if (destructive.matched) {
        findings.push(
          Object.freeze({
            surfaceKey,
            category: "authority-widening",
            code: "destructive-or-open-world-added",
            tool: tool.name,
            detail: `New tool '${tool.name}' introduces ${destructive.reason} on surface '${surfaceKey}'.`,
          }),
        );
      }
      const tokens = estimateToolTokens(tool, {
        bloatedInputSchemaTokens: bloatedLimit,
        bloatedOutputSchemaTokens: bloatedLimit,
      });
      if (tokens.bloatedInputSchema || tokens.bloatedOutputSchema) {
        findings.push(
          Object.freeze({
            surfaceKey,
            category: "context-regression",
            code: "tool-schema-bloated",
            tool: tool.name,
            detail: `Tool '${tool.name}' has a bloated schema (input ~${tokens.inputSchemaTokens} tokens, output ~${tokens.outputSchemaTokens} tokens; limit ${bloatedLimit}).`,
          }),
        );
      }
    }
    if (candidate.contextBudget.totalPromptTokens > maxCatalogTokens) {
      findings.push(
        Object.freeze({
          surfaceKey,
          category: "context-regression",
          code: "catalog-token-ceiling-exceeded",
          detail: `Surface '${surfaceKey}' consumes ~${candidate.contextBudget.totalPromptTokens} cold-start tokens, exceeding ceiling ${maxCatalogTokens}.`,
        }),
      );
    }
    return Object.freeze({
      key: surfaceKey,
      baselineDigest: null,
      candidateDigest: candidate.contentDigest,
      baselinePromptTokens: 0,
      candidatePromptTokens: candidate.contextBudget.totalPromptTokens,
      promptTokenDelta: candidate.contextBudget.totalPromptTokens,
      findings: Object.freeze(findings),
    });
  }

  if (!baseline || !candidate) {
    return Object.freeze({
      key: surfaceKey,
      baselineDigest: null,
      candidateDigest: null,
      baselinePromptTokens: 0,
      candidatePromptTokens: 0,
      promptTokenDelta: 0,
      findings: Object.freeze([]),
    });
  }

  // Both baseline and candidate exist.
  if (!baseline.anonAccessible && candidate.anonAccessible) {
    findings.push(
      Object.freeze({
        surfaceKey,
        category: "authority-widening",
        code: "surface-anon-opened",
        detail: `Surface '${surfaceKey}' changed from protected ('${baseline.authMode}') to anonymous ('${candidate.authMode}').`,
      }),
    );
  }

  const baseByName = new Map(
    baseline.tools.map((tool) => [tool.name, tool] as const),
  );
  const candByName = new Map(
    candidate.tools.map((tool) => [tool.name, tool] as const),
  );
  const allToolNames = [
    ...new Set([...baseByName.keys(), ...candByName.keys()]),
  ].sort(compareCanonicalText);

  for (const name of allToolNames) {
    const baseTool = baseByName.get(name);
    const candTool = candByName.get(name);
    const baseAuth = baseline.toolAuthority[name];
    const candAuth = candidate.toolAuthority[name];

    if (baseTool && !candTool) {
      findings.push(
        Object.freeze({
          surfaceKey,
          category: "breaking",
          code: "tool-removed",
          tool: name,
          detail: `Tool '${name}' was removed from surface '${surfaceKey}'.`,
        }),
      );
      continue;
    }

    if (!baseTool && candTool) {
      findings.push(
        Object.freeze({
          surfaceKey,
          category: "additive",
          code: "tool-added",
          tool: name,
          detail: `Tool '${name}' was added to surface '${surfaceKey}'.`,
        }),
      );
      if (candidate.anonAccessible) {
        findings.push(
          Object.freeze({
            surfaceKey,
            category: "authority-widening",
            code: "anon-tool-added",
            tool: name,
            detail: `New tool '${name}' is anonymously accessible on surface '${surfaceKey}'.`,
          }),
        );
      }
      const destructive = isDestructiveOrOpenWorldTool(candTool, candAuth);
      if (destructive.matched) {
        findings.push(
          Object.freeze({
            surfaceKey,
            category: "authority-widening",
            code: "destructive-or-open-world-added",
            tool: name,
            detail: `New tool '${name}' introduces ${destructive.reason}.`,
          }),
        );
      } else if (typeof candTool.annotations?.readOnlyHint !== "boolean") {
        findings.push(
          Object.freeze({
            surfaceKey,
            category: "authority-widening",
            code: "destructive-or-open-world-added",
            tool: name,
            detail: `New tool '${name}' omits an explicit boolean readOnlyHint safety annotation.`,
          }),
        );
      }
      const candTokens = estimateToolTokens(candTool, {
        bloatedInputSchemaTokens: bloatedLimit,
        bloatedOutputSchemaTokens: bloatedLimit,
      });
      if (candTokens.bloatedInputSchema || candTokens.bloatedOutputSchema) {
        findings.push(
          Object.freeze({
            surfaceKey,
            category: "context-regression",
            code: "tool-schema-bloated",
            tool: name,
            detail: `New tool '${name}' has a bloated schema (input ~${candTokens.inputSchemaTokens} tokens, output ~${candTokens.outputSchemaTokens} tokens; limit ${bloatedLimit}).`,
          }),
        );
      }
      continue;
    }

    if (!baseTool || !candTool) continue;

    const toolFindingsStart = findings.length;

    // 1. Tool-level authority-widening checks.
    if (
      baseTool.annotations?.readOnlyHint === true &&
      candTool.annotations?.readOnlyHint !== true
    ) {
      findings.push(
        Object.freeze({
          surfaceKey,
          category: "authority-widening",
          code: "read-only-hint-dropped",
          tool: name,
          detail: `Tool '${name}' dropped readOnlyHint: true.`,
        }),
      );
    }

    if (
      baseTool.annotations?.destructiveHint === true &&
      candTool.annotations?.destructiveHint !== true &&
      candTool.annotations?.readOnlyHint !== true
    ) {
      findings.push(
        Object.freeze({
          surfaceKey,
          category: "authority-widening",
          code: "destructive-hint-dropped",
          tool: name,
          detail: `Tool '${name}' dropped destructiveHint: true while remaining non-read-only.`,
        }),
      );
    }

    const gainedDestructive =
      (baseTool.annotations?.destructiveHint !== true &&
        candTool.annotations?.destructiveHint === true) ||
      (baseAuth?.risk !== "destructive" && candAuth?.risk === "destructive");
    const gainedOpenWorld =
      baseTool.annotations?.openWorldHint !== true &&
      candTool.annotations?.openWorldHint === true;
    if (gainedDestructive || gainedOpenWorld) {
      findings.push(
        Object.freeze({
          surfaceKey,
          category: "authority-widening",
          code: "destructive-or-open-world-added",
          tool: name,
          detail: `Tool '${name}' gained ${gainedDestructive ? "destructive" : "openWorldHint"} authority.`,
        }),
      );
    }

    const baseScopes = new Set(baseAuth?.scopes ?? []);
    const candScopes = new Set(candAuth?.scopes ?? []);
    if (baseScopes.size > 0) {
      const droppedScopes = [...baseScopes]
        .filter((scope) => !candScopes.has(scope))
        .sort(compareCanonicalText);
      if (droppedScopes.length > 0) {
        findings.push(
          Object.freeze({
            surfaceKey,
            category: "authority-widening",
            code: "scope-requirement-widened",
            tool: name,
            detail: `Tool '${name}' dropped required scope(s): ${droppedScopes.join(", ")}.`,
          }),
        );
      }
    }

    if (isAppOnlyVisibility(baseAuth) && !isAppOnlyVisibility(candAuth)) {
      findings.push(
        Object.freeze({
          surfaceKey,
          category: "authority-widening",
          code: "model-visibility-widened",
          tool: name,
          detail: `Tool '${name}' widened visibility from app-only (["app"]) to model-callable.`,
        }),
      );
    }

    // 2. Contravariant inputSchema & covariant outputSchema diff.
    const schemaState: SchemaDiffState = {
      surfaceKey,
      toolName: name,
      findings,
      proseChanged:
        baseTool.title !== candTool.title ||
        baseTool.description !== candTool.description ||
        baseTool.annotations?.title !== candTool.annotations?.title,
    };

    diffInputSchemaNode(
      baseTool.inputSchema as Record<string, unknown>,
      candTool.inputSchema as Record<string, unknown>,
      "$",
      schemaState,
    );

    if (
      baseTool.outputSchema !== undefined &&
      candTool.outputSchema === undefined
    ) {
      findings.push(
        Object.freeze({
          surfaceKey,
          category: "breaking",
          code: "output-schema-removed",
          tool: name,
          schemaPath: "$",
          detail: `Tool '${name}' removed its advertised outputSchema.`,
        }),
      );
    } else if (
      baseTool.outputSchema === undefined &&
      candTool.outputSchema !== undefined
    ) {
      findings.push(
        Object.freeze({
          surfaceKey,
          category: "additive",
          code: "output-property-added",
          tool: name,
          schemaPath: "$",
          detail: `Tool '${name}' added an outputSchema.`,
        }),
      );
    } else if (
      baseTool.outputSchema !== undefined &&
      candTool.outputSchema !== undefined
    ) {
      diffOutputSchemaNode(
        baseTool.outputSchema as Record<string, unknown>,
        candTool.outputSchema as Record<string, unknown>,
        "$",
        schemaState,
      );
    }

    // 3. Per-tool schema bloat check.
    const baseTokens = estimateToolTokens(baseTool, {
      bloatedInputSchemaTokens: bloatedLimit,
      bloatedOutputSchemaTokens: bloatedLimit,
    });
    const candTokens = estimateToolTokens(candTool, {
      bloatedInputSchemaTokens: bloatedLimit,
      bloatedOutputSchemaTokens: bloatedLimit,
    });
    const inputBloatTriggered =
      (!baseTokens.bloatedInputSchema && candTokens.bloatedInputSchema) ||
      (baseTokens.bloatedInputSchema &&
        candTokens.inputSchemaTokens - baseTokens.inputSchemaTokens >
          bloatedGrowth);
    const outputBloatTriggered =
      (!baseTokens.bloatedOutputSchema && candTokens.bloatedOutputSchema) ||
      (baseTokens.bloatedOutputSchema &&
        candTokens.outputSchemaTokens - baseTokens.outputSchemaTokens >
          bloatedGrowth);
    if (inputBloatTriggered || outputBloatTriggered) {
      findings.push(
        Object.freeze({
          surfaceKey,
          category: "context-regression",
          code: "tool-schema-bloated",
          tool: name,
          detail: `Tool '${name}' schema grew to input ~${candTokens.inputSchemaTokens} tokens (was ~${baseTokens.inputSchemaTokens}), output ~${candTokens.outputSchemaTokens} tokens (was ~${baseTokens.outputSchemaTokens}).`,
        }),
      );
    }

    if (schemaState.proseChanged) {
      findings.push(
        Object.freeze({
          surfaceKey,
          category: "additive",
          code: "prose-updated",
          tool: name,
          detail: `Tool '${name}' updated title or description text.`,
        }),
      );
    } else if (
      findings.length === toolFindingsStart &&
      JSON.stringify(baseTool) !== JSON.stringify(candTool)
    ) {
      findings.push(
        Object.freeze({
          surfaceKey,
          category: "additive",
          code: "prose-updated",
          tool: name,
          detail: `Tool '${name}' updated non-breaking metadata or schema defaults.`,
        }),
      );
    }
  }

  // 4. Surface-wide cold-start token regression & reduction checks.
  const baselinePromptTokens = baseline.contextBudget.totalPromptTokens;
  const candidatePromptTokens = candidate.contextBudget.totalPromptTokens;
  const promptTokenDelta = candidatePromptTokens - baselinePromptTokens;

  if (promptTokenDelta > maxTokenDelta) {
    findings.push(
      Object.freeze({
        surfaceKey,
        category: "context-regression",
        code: "catalog-token-delta-exceeded",
        detail: `Surface '${surfaceKey}' cold-start prompt tokens increased by +${promptTokenDelta} (~${baselinePromptTokens} -> ~${candidatePromptTokens}, max delta +${maxTokenDelta}).`,
      }),
    );
  }

  if (
    candidatePromptTokens > maxCatalogTokens &&
    (baselinePromptTokens <= maxCatalogTokens || promptTokenDelta > 0)
  ) {
    findings.push(
      Object.freeze({
        surfaceKey,
        category: "context-regression",
        code: "catalog-token-ceiling-exceeded",
        detail: `Surface '${surfaceKey}' cold-start catalog (~${candidatePromptTokens} tokens) exceeds ceiling ${maxCatalogTokens}.`,
      }),
    );
  }

  const hasSevereFinding = findings.some(
    (item) =>
      item.category === "breaking" || item.category === "authority-widening",
  );
  if (promptTokenDelta < 0 && !hasSevereFinding) {
    findings.push(
      Object.freeze({
        surfaceKey,
        category: "additive",
        code: "context-reduced",
        detail: `Surface '${surfaceKey}' reduced cold-start context by ${Math.abs(promptTokenDelta)} tokens (~${baselinePromptTokens} -> ~${candidatePromptTokens}).`,
      }),
    );
  }

  return Object.freeze({
    key: surfaceKey,
    baselineDigest: baseline.contentDigest,
    candidateDigest: candidate.contentDigest,
    baselinePromptTokens,
    candidatePromptTokens,
    promptTokenDelta,
    findings: Object.freeze(findings),
  });
}

function unwrapSurfaces(
  source: McpSurfaceLockfileV1 | Readonly<Record<string, LockedSurfaceEntry>>,
): Readonly<Record<string, LockedSurfaceEntry>> {
  if (
    "lockfileVersion" in source &&
    source.lockfileVersion === 1 &&
    isRecord(source.surfaces)
  ) {
    return source.surfaces;
  }
  return source as Readonly<Record<string, LockedSurfaceEntry>>;
}

export function diffSurfaceSnapshots(
  baseline: McpSurfaceLockfileV1 | Readonly<Record<string, LockedSurfaceEntry>>,
  candidate:
    | McpSurfaceLockfileV1
    | Readonly<Record<string, LockedSurfaceEntry>>,
  options?: DiffSurfaceOptions,
): SurfaceDiffReport {
  const failOn: readonly SurfaceDiffCategory[] = Object.freeze([
    ...(options?.failOn ?? SURFACE_DIFF_DEFAULTS.failOn),
  ]);
  const failOnSet = new Set<SurfaceDiffCategory>(failOn);
  const frozen = Boolean(options?.frozen);
  const lockfilePath = options?.lockfilePath ?? "mcp-surface.lock.json";

  const baseMap = unwrapSurfaces(baseline);
  const candMap = unwrapSurfaces(candidate);
  const keys = [
    ...new Set([...Object.keys(baseMap), ...Object.keys(candMap)]),
  ].sort(compareCanonicalText);

  const surfaces: SurfaceEntryDiff[] = [];
  let breaking = 0;
  let authorityWidening = 0;
  let contextRegression = 0;
  let additive = 0;
  let promptTokenDelta = 0;
  let anyDrift = false;
  let failedByCategory = false;

  for (const key of keys) {
    const baseEntry = baseMap[key] ?? null;
    const candEntry = candMap[key] ?? null;
    const diff = diffLockedSurfaceEntries(key, baseEntry, candEntry, options);
    surfaces.push(diff);
    promptTokenDelta += diff.promptTokenDelta;

    if (
      diff.baselineDigest !== diff.candidateDigest ||
      diff.findings.length > 0 ||
      JSON.stringify(baseEntry?.toolAuthority ?? {}) !==
        JSON.stringify(candEntry?.toolAuthority ?? {})
    ) {
      anyDrift = true;
    }

    for (const finding of diff.findings) {
      if (finding.category === "breaking") breaking += 1;
      else if (finding.category === "authority-widening")
        authorityWidening += 1;
      else if (finding.category === "context-regression")
        contextRegression += 1;
      else additive += 1;

      if (failOnSet.has(finding.category)) {
        failedByCategory = true;
      }
    }
  }

  const policyFailed = failedByCategory || (frozen && anyDrift);
  const status: SurfaceDiffReport["status"] = !anyDrift
    ? "unchanged"
    : policyFailed
      ? "policy_failed"
      : "compatible";
  const exitCode: 0 | 2 = policyFailed ? 2 : 0;

  return Object.freeze({
    schemaVersion: 1,
    command: "surface diff",
    status,
    exitCode,
    lockfilePath,
    failOn,
    frozen,
    summary: Object.freeze({
      breaking,
      authorityWidening,
      contextRegression,
      additive,
      promptTokenDelta,
    }),
    surfaces: Object.freeze(surfaces),
    ...(anyDrift ? { nextCommand: "npx chumbo surface snapshot --yes" } : {}),
  });
}
