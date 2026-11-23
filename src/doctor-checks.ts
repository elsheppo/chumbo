import type { DoctorCheck } from "./doctor.js";
import { extractDeniedPostgresObjects } from "./internal/grant-diagnostics.js";
import type { SetupAuthMode } from "./setup.js";
import {
  estimateCatalogTokens,
  type CatalogTokenReport,
  type EstimateCatalogTokensOptions,
} from "./surface-tokens.js";

/** The parts of a `tools/list` entry that doctor inspects. */
export interface ProbeTool {
  name?: unknown;
  title?: unknown;
  description?: unknown;
  inputSchema?: {
    type?: unknown;
    properties?: unknown;
    required?: unknown;
    [key: string]: unknown;
  };
  outputSchema?: Record<string, unknown>;
  annotations?: {
    title?: unknown;
    readOnlyHint?: unknown;
    destructiveHint?: unknown;
    idempotentHint?: unknown;
    openWorldHint?: unknown;
  } | null;
  _meta?: Record<string, unknown>;
}

export interface DoctorSqlRemediation {
  readonly kind: "supabase-data-api-grants";
  readonly targetRole: "authenticated" | "anon" | "rpc-definer";
  readonly schemas: readonly string[];
  readonly relations: readonly string[];
  readonly sequences: readonly string[];
  readonly affectedTools: readonly string[];
  /** Suggested command: `supabase migration new grant_mcp_data_api_access` */
  readonly migrationCommand: string;
  /** Copy-pasteable, control-stripped, identifier-validated SQL snippet. */
  readonly sql: string;
  readonly notes: readonly string[];
}

/** One tool result doctor obtained, kept so advisory checks can inspect it. */
export interface ToolResultRecord {
  tool: string;
  /** Who made the call: "first user", "second user", or "doctor". */
  caller: string;
  result?: Record<string, unknown>;
  /** The JSON-RPC error message, when the call returned one. */
  errorMessage?: string;
}

const RESULT_BUDGET_BYTES = 16 * 1024;
const NAME_LIMIT = 5;
const ISOLATION_TOOL_LIMIT = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolName(tool: ProbeTool): string {
  return typeof tool.name === "string" && tool.name ? tool.name : "(unnamed)";
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function nameList(names: readonly string[]): string {
  const shown = names.slice(0, NAME_LIMIT).map((name) => `'${name}'`);
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

// ---------------------------------------------------------------------------
// Tool surface lint
// ---------------------------------------------------------------------------

function propertiesOf(tool: ProbeTool): Record<string, unknown> {
  return isRecord(tool.inputSchema?.properties)
    ? tool.inputSchema.properties
    : {};
}

function requiredOf(tool: ProbeTool): string[] {
  const required = tool.inputSchema?.required;
  return Array.isArray(required)
    ? required.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function resultBytes(record: ToolResultRecord): number {
  return new TextEncoder().encode(JSON.stringify(record.result ?? {})).length;
}

/** Deterministic lint of the discovered tool surface. Never blocking. */
export function toolSurfaceCheck(
  tools: readonly ProbeTool[],
  results: readonly ToolResultRecord[],
): DoctorCheck {
  const weakDescription: string[] = [];
  const missingAnnotations: string[] = [];
  const undescribed: string[] = [];
  let undescribedProperties = 0;
  for (const tool of tools) {
    const name = toolName(tool);
    const description =
      typeof tool.description === "string" ? tool.description.trim() : "";
    if (description.length < 20) weakDescription.push(name);
    if (typeof tool.annotations?.readOnlyHint !== "boolean") {
      missingAnnotations.push(name);
    }
    const missing = Object.values(propertiesOf(tool)).filter((schema) => {
      const text = isRecord(schema) ? schema.description : undefined;
      return typeof text !== "string" || text.trim() === "";
    }).length;
    if (missing > 0) {
      undescribed.push(name);
      undescribedProperties += missing;
    }
  }
  // One result per tool, however many callers produced one.
  const perTool = new Map<string, ToolResultRecord>();
  for (const record of results) {
    const known = perTool.get(record.tool);
    if (!known || resultBytes(record) > resultBytes(known)) {
      perTool.set(record.tool, record);
    }
  }
  const oversized = [...perTool.values()]
    .filter((record) => resultBytes(record) > RESULT_BUDGET_BYTES)
    .map((record) => record.tool);
  const missingReadingCard = [...perTool.values()]
    .filter((record) => {
      const content = record.result?.content;
      if (!Array.isArray(content)) return false;
      const hasResourceLink = content.some(
        (entry) => isRecord(entry) && entry.type === "resource_link",
      );
      if (!hasResourceLink) return false;
      const hasTextCard = content.some(
        (entry) =>
          isRecord(entry) &&
          entry.type === "text" &&
          typeof entry.text === "string" &&
          entry.text.trim().length > 0,
      );
      return !hasTextCard;
    })
    .map((record) => record.tool);

  const findings: string[] = [];
  if (weakDescription.length > 0) {
    findings.push(
      `${plural(weakDescription.length, "tool")} without a description of at least 20 characters (${nameList(weakDescription)}); say what each tool returns and when to use it`,
    );
  }
  if (missingAnnotations.length > 0) {
    findings.push(
      `${plural(missingAnnotations.length, "tool")} without a readOnlyHint annotation (${nameList(missingAnnotations)}); mark read-only tools with readOnlyHint: true`,
    );
  }
  if (undescribed.length > 0) {
    findings.push(
      `${plural(undescribedProperties, "input property", "input properties")} without a description across ${plural(undescribed.length, "tool")} (${nameList(undescribed)}); describe each input so agents fill it correctly`,
    );
  }
  if (oversized.length > 0) {
    findings.push(
      `${plural(oversized.length, "result")} larger than 16 KiB (${nameList(oversized)}); return a page of rows or serve the full content as an MCP Resource`,
    );
  }
  if (missingReadingCard.length > 0) {
    findings.push(
      `${plural(missingReadingCard.length, "result")} with a resource_link and no text reading card (${nameList(missingReadingCard)}); include concise summary text with resourceResult() so hosts that cannot open MCP resources still work`,
    );
  }
  const scope = `${plural(tools.length, "tool")}${perTool.size > 0 ? ` and ${plural(perTool.size, "result")}` : ""} checked`;
  return {
    name: "tool-surface",
    ok: findings.length === 0,
    detail:
      findings.length === 0
        ? `${scope}; no issues found`
        : `${scope}. ${findings.join("; ")}.`,
    blocking: false,
  };
}

// ---------------------------------------------------------------------------
// Context budget check
// ---------------------------------------------------------------------------

function formatKiB(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

/** Deterministic cold-start token & schema bloat check. Never blocking. */
export function contextBudgetCheck(
  tools: readonly ProbeTool[],
  options?: EstimateCatalogTokensOptions,
): DoctorCheck {
  const report: CatalogTokenReport = estimateCatalogTokens(tools, options);
  const ok =
    !report.overColdStartBudget &&
    report.bloatedInputTools.length === 0 &&
    report.bloatedOutputTools.length === 0;
  const largest = report.tools[0];
  if (ok) {
    const largestNote = largest
      ? `; largest: '${largest.name}' (~${largest.promptTokens.toLocaleString("en-US")} tokens)`
      : "";
    return {
      name: "context-budget",
      ok: true,
      detail: `~${report.totalPromptTokens.toLocaleString("en-US")} cold-start tokens across ${plural(report.toolCount, "tool")} (${formatKiB(report.totalWireBytes)} wire)${largestNote}`,
      blocking: false,
      metrics: report,
    };
  }

  const parts: string[] = [
    `~${report.totalPromptTokens.toLocaleString("en-US")} cold-start tokens across ${plural(report.toolCount, "tool")}${report.overColdStartBudget ? ` (exceeds ${report.maxCatalogTokens.toLocaleString("en-US")}-token budget; ${formatKiB(report.totalWireBytes)} wire)` : ` (${formatKiB(report.totalWireBytes)} wire)`}`,
  ];
  if (report.bloatedInputTools.length > 0) {
    const detailed = report.bloatedInputTools
      .slice(0, NAME_LIMIT)
      .map((name) => {
        const match = report.tools.find((tool) => tool.name === name);
        return `'${name}' ~${(match?.inputSchemaTokens ?? 0).toLocaleString("en-US")} tokens`;
      });
    parts.push(
      `${plural(report.bloatedInputTools.length, "bloated inputSchema", "bloated inputSchemas")} (${detailed.join(", ")})`,
    );
  }
  if (report.bloatedOutputTools.length > 0) {
    const detailed = report.bloatedOutputTools
      .slice(0, NAME_LIMIT)
      .map((name) => {
        const match = report.tools.find((tool) => tool.name === name);
        return `'${name}' ~${(match?.outputSchemaTokens ?? 0).toLocaleString("en-US")} tokens`;
      });
    parts.push(
      `${plural(report.bloatedOutputTools.length, "bloated outputSchema", "bloated outputSchemas")} (${detailed.join(", ")})`,
    );
  }
  return {
    name: "context-budget",
    ok: false,
    detail: `${parts.join("; ")}. Narrow schemas with projectInputFields or split surfaces with capability profiles.`,
    blocking: false,
    metrics: report,
  };
}

// ---------------------------------------------------------------------------
// Data API grants
// ---------------------------------------------------------------------------

/** Text of a failed call only. Successful data is never scanned. */
function errorText(record: ToolResultRecord): string {
  const parts: string[] = [];
  if (record.errorMessage) parts.push(record.errorMessage);
  if (record.result?.isError === true) {
    const content = record.result.content;
    if (Array.isArray(content)) {
      for (const entry of content) {
        if (isRecord(entry) && typeof entry.text === "string") {
          parts.push(entry.text);
        }
      }
    }
    if (record.result.structuredContent !== undefined) {
      parts.push(JSON.stringify(record.result.structuredContent));
    }
  }
  return parts.join("\n");
}

export interface DataApiGrantsContext {
  readonly auth?: SetupAuthMode | "multi";
  readonly tools?: readonly ProbeTool[];
}

function buildGrantSqlRemediation(input: {
  readonly auth: SetupAuthMode | "multi" | undefined;
  readonly schemas: readonly string[];
  readonly relations: readonly string[];
  readonly sequences: readonly string[];
  readonly affectedTools: readonly string[];
  readonly probeTools: readonly ProbeTool[];
}): DoctorSqlRemediation {
  const toolMap = new Map<string, ProbeTool>();
  for (const tool of input.probeTools) {
    if (typeof tool.name === "string" && tool.name) {
      toolMap.set(tool.name, tool);
    }
  }
  const writeTools = input.affectedTools.filter(
    (name) => toolMap.get(name)?.annotations?.readOnlyHint !== true,
  );
  const hasWrites = writeTools.length > 0;
  const migrationCommand = "supabase migration new grant_mcp_data_api_access";

  const lines: string[] = [];
  const notes: string[] = [];

  // API-key mode (and public writes) must never grant direct anon table privileges.
  if (input.auth === "api-key" || (input.auth === "public" && hasWrites)) {
    const targetRel = input.relations[0] ?? "<schema>.<table>";
    lines.push(
      "-- API-key and public write handlers use the anonymous PostgREST role.",
      "-- Do not grant direct anon table writes on private tables.",
      `-- Expose a narrow SECURITY DEFINER RPC function instead, or switch to user-scoped oauth/bearer auth:`,
      `-- CREATE OR REPLACE FUNCTION public.mcp_action(...) RETURNS ... LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ ... $$;`,
      `-- REVOKE ALL ON FUNCTION public.mcp_action(...) FROM PUBLIC;`,
      `-- GRANT EXECUTE ON FUNCTION public.mcp_action(...) TO anon;`,
    );
    notes.push(
      input.auth === "api-key"
        ? `ctx.supabase in api-key mode carries no Supabase user JWT (uses anon). Use a narrow SECURITY DEFINER RPC for ${targetRel}, or switch to oauth/bearer for per-user RLS.`
        : `Do not grant write privileges to anon on ${targetRel}. Route public mutations through a narrow SECURITY DEFINER function with explicit input validation.`,
    );
    return {
      kind: "supabase-data-api-grants",
      targetRole: "rpc-definer",
      schemas: [...input.schemas],
      relations: [...input.relations],
      sequences: [...input.sequences],
      affectedTools: [...input.affectedTools],
      migrationCommand,
      sql: lines.join("\n"),
      notes,
    };
  }

  const targetRole: "authenticated" | "anon" =
    input.auth === "public" ? "anon" : "authenticated";

  if (targetRole === "anon") {
    lines.push(
      "-- Warning: anon grants expose rows matched by anon RLS policies to unauthenticated PostgREST callers.",
    );
    notes.push(
      "Verify that anon RLS policies expose only intentionally public rows.",
    );
  }

  for (const schema of input.schemas) {
    if (schema !== "public") {
      lines.push(`GRANT USAGE ON SCHEMA ${schema} TO ${targetRole};`);
    }
  }

  if (input.relations.length > 0) {
    for (const relation of input.relations) {
      lines.push(`ALTER TABLE ${relation} ENABLE ROW LEVEL SECURITY;`);
      lines.push(`GRANT SELECT ON TABLE ${relation} TO ${targetRole};`);
      if (hasWrites && targetRole === "authenticated") {
        lines.push(
          `-- Uncomment only the write privileges ${nameList(writeTools)} performs:`,
          `-- GRANT INSERT, UPDATE, DELETE ON TABLE ${relation} TO authenticated;`,
        );
      }
    }
    notes.push(
      `Ensure RLS policies on ${input.relations.join(", ")} restrict rows to auth.uid() or the caller's tenant.`,
    );
  } else if (input.schemas.length > 0) {
    if (input.schemas.every((schema) => schema === "public")) {
      lines.push(`GRANT USAGE ON SCHEMA public TO ${targetRole};`);
    }
    notes.push(
      `Grant table-level SELECT (and narrow write privileges if needed) on tables inside ${input.schemas.join(", ")} with RLS enabled.`,
    );
  } else {
    lines.push(
      `-- Replace <schema>.<table> with the table your tool queries:`,
      `-- ALTER TABLE <schema>.<table> ENABLE ROW LEVEL SECURITY;`,
      `-- GRANT SELECT ON TABLE <schema>.<table> TO ${targetRole};`,
    );
    notes.push(
      "Identify the denied table from Supabase Postgres logs and add explicit grants with RLS enabled in a migration.",
    );
  }

  for (const sequence of input.sequences) {
    lines.push(`GRANT USAGE, SELECT ON SEQUENCE ${sequence} TO ${targetRole};`);
  }

  return {
    kind: "supabase-data-api-grants",
    targetRole,
    schemas: [...input.schemas],
    relations: [...input.relations],
    sequences: [...input.sequences],
    affectedTools: [...input.affectedTools],
    migrationCommand,
    sql: lines.join("\n"),
    notes,
  };
}

/** Spots Postgres and PostgREST permission failures in failed tool calls. */
export function dataApiGrantsCheck(
  results: readonly ToolResultRecord[],
  context?: DataApiGrantsContext,
): DoctorCheck | undefined {
  if (results.length === 0) return undefined;
  const tables = new Set<string>();
  const schemas = new Set<string>();
  const sequences = new Set<string>();
  const tools = new Set<string>();
  let unnamed = false;
  for (const record of results) {
    const text = errorText(record);
    if (!text) continue;
    const extracted = extractDeniedPostgresObjects([text]);
    let hit =
      extracted.relations.length > 0 ||
      extracted.schemas.length > 0 ||
      extracted.sequences.length > 0;
    for (const rel of extracted.relations) tables.add(rel);
    for (const schema of extracted.schemas) schemas.add(schema);
    for (const seq of extracted.sequences) sequences.add(seq);
    if (!hit && (/\b42501\b/.test(text) || /permission denied/i.test(text))) {
      hit = true;
      unnamed = true;
    }
    if (hit) tools.add(record.tool);
  }
  if (tools.size === 0) {
    return {
      name: "data-api-grants",
      ok: true,
      detail: `no permission errors in ${plural(results.length, "tool result")}`,
      blocking: false,
    };
  }
  const remediation = buildGrantSqlRemediation({
    auth: context?.auth,
    schemas: [...schemas],
    relations: [...tables],
    sequences: [...sequences],
    affectedTools: [...tools],
    probeTools: context?.tools ?? [],
  });
  const named = [...tables].slice(0, NAME_LIMIT);
  const subject =
    named.length > 0
      ? `table ${named.map((table) => `'${table}'`).join(", ")}`
      : schemas.size > 0
        ? `schema ${[...schemas].map((schema) => `'${schema}'`).join(", ")}`
        : "a table or schema the tool reads";
  const fix =
    remediation.targetRole === "rpc-definer"
      ? ` ${remediation.notes[0] ?? "Use a narrow SECURITY DEFINER RPC or switch to user-scoped oauth/bearer auth."}`
      : named.length > 0
        ? ` To let ${remediation.targetRole === "anon" ? "public callers" : "signed-in users"} read it, run: grant select on table ${named[0]} to ${remediation.targetRole};${remediation.targetRole === "authenticated" ? " Writes need insert, update, or delete as appropriate." : ""} Keep row-level security on.`
        : schemas.size > 0
          ? ` For example: grant usage on schema ${[...schemas][0]} to ${remediation.targetRole};`
          : ` Grant the ${remediation.targetRole} role the access the tool needs on that table.`;
  return {
    name: "data-api-grants",
    ok: false,
    detail: `${plural(tools.size, "tool")} (${nameList([...tools])}) failed with a Postgres permission error on ${subject}${unnamed && named.length > 0 ? " and others" : ""}. From 2026-10-30, new tables in the public schema are not exposed to the Data API until granted to a role, including tables recreated by a local supabase db reset and by preview branches. Put the grant in a migration (${remediation.migrationCommand}).${fix}`,
    blocking: false,
    remediation,
  };
}

// ---------------------------------------------------------------------------
// User isolation helpers
// ---------------------------------------------------------------------------

function jwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as unknown;
    return isRecord(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the `sub` claim from a JWT without verifying it. */
export function jwtSubject(token: string): string | undefined {
  const sub = jwtPayload(token)?.sub;
  return typeof sub === "string" && sub !== "" ? sub : undefined;
}

/** The sub and email claims of a JWT, for redacting identity from results. */
export function jwtIdentity(token: string): string[] {
  const payload = jwtPayload(token);
  return [payload?.sub, payload?.email].filter(
    (value): value is string => typeof value === "string" && value !== "",
  );
}

/** Read-only tools that can be called with no arguments. */
export function isolationCandidates(tools: readonly ProbeTool[]): {
  selected: string[];
  skipped: number;
} {
  const eligible = tools
    .filter(
      (tool) =>
        tool.annotations?.readOnlyHint === true &&
        requiredOf(tool).length === 0 &&
        typeof tool.name === "string" &&
        tool.name !== "",
    )
    .map(toolName);
  return {
    selected: eligible.slice(0, ISOLATION_TOOL_LIMIT),
    skipped: Math.max(0, eligible.length - ISOLATION_TOOL_LIMIT),
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function emptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.every(emptyValue);
  if (isRecord(value)) return Object.values(value).every(emptyValue);
  return false;
}

function textValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * A usable result: not an error and carrying data. Empty results ([], {},
 * "", empty content, an empty items list) have nothing to compare.
 */
export function comparableResult(
  record: ToolResultRecord | undefined,
): string | undefined {
  const result = record?.result;
  if (!result || record?.errorMessage || result.isError === true) {
    return undefined;
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const values = content.map((entry) =>
    isRecord(entry) && typeof entry.text === "string"
      ? textValue(entry.text)
      : entry,
  );
  if (emptyValue(values) && emptyValue(result.structuredContent)) {
    return undefined;
  }
  return canonical({
    content,
    structuredContent: result.structuredContent ?? null,
  });
}

/** Replaces each identity value with one placeholder before comparing. */
export function redactIdentity(
  canonicalResult: string,
  identities: readonly string[],
): string {
  let redacted = canonicalResult;
  for (const identity of identities) {
    redacted = redacted.split(identity).join("<user>");
  }
  return redacted;
}
