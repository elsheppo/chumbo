import type { DoctorCheck } from "./doctor.js";

/** The parts of a `tools/list` entry that doctor inspects. */
export interface ProbeTool {
  name?: unknown;
  description?: unknown;
  inputSchema?: {
    properties?: unknown;
    required?: unknown;
  };
  annotations?: {
    readOnlyHint?: unknown;
  } | null;
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
  const oversized = [
    ...new Set(
      results
        .filter((record) => resultBytes(record) > RESULT_BUDGET_BYTES)
        .map((record) => record.tool),
    ),
  ];

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
  const scope = `${plural(tools.length, "tool")}${results.length > 0 ? ` and ${plural(results.length, "result")}` : ""} checked`;
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
// Data API grants
// ---------------------------------------------------------------------------

function resultText(record: ToolResultRecord): string {
  const parts: string[] = [];
  if (record.errorMessage) parts.push(record.errorMessage);
  const content = record.result?.content;
  if (Array.isArray(content)) {
    for (const entry of content) {
      if (isRecord(entry) && typeof entry.text === "string") {
        parts.push(entry.text);
      }
    }
  }
  const structured = record.result?.structuredContent;
  if (structured !== undefined) parts.push(JSON.stringify(structured));
  return parts.join("\n");
}

const IDENTIFIER = /^[A-Za-z_][\w$]*$/;

function plainIdentifier(value: string): string | undefined {
  const cleaned = value.replace(/^["'`]+|["'`.,;:)]+$/g, "");
  const bare = cleaned.includes(".")
    ? (cleaned.split(".").pop() ?? "").replace(/^"|"$/g, "")
    : cleaned;
  return IDENTIFIER.test(bare) ? bare : undefined;
}

/** Spots Postgres and PostgREST permission failures in tool results. */
export function dataApiGrantsCheck(
  results: readonly ToolResultRecord[],
): DoctorCheck | undefined {
  if (results.length === 0) return undefined;
  const tables = new Set<string>();
  const schemas = new Set<string>();
  const tools = new Set<string>();
  let unnamed = false;
  for (const record of results) {
    const text = resultText(record);
    let hit = false;
    for (const match of text.matchAll(
      /permission denied for (table|relation|view)\s+("?[\w.$]+"?)/gi,
    )) {
      hit = true;
      const table = plainIdentifier(match[2] ?? "");
      if (table) tables.add(table);
      else unnamed = true;
    }
    for (const match of text.matchAll(
      /permission denied for schema\s+("?[\w$]+"?)/gi,
    )) {
      hit = true;
      const schema = plainIdentifier(match[1] ?? "");
      if (schema) schemas.add(schema);
    }
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
  const named = [...tables].slice(0, NAME_LIMIT);
  const subject =
    named.length > 0
      ? `table ${named.map((table) => `'${table}'`).join(", ")}`
      : schemas.size > 0
        ? `schema ${[...schemas].map((schema) => `'${schema}'`).join(", ")}`
        : "a table or schema the tool reads";
  const fix =
    named.length > 0
      ? ` For example: grant select, insert, update, delete on public.${named[0]} to authenticated; (keep row-level security on, and grant only what the tool needs).`
      : schemas.size > 0
        ? ` For example: grant usage on schema ${[...schemas][0]} to authenticated;`
        : " Grant the authenticated role the access the tool needs on that table.";
  return {
    name: "data-api-grants",
    ok: false,
    detail: `${plural(tools.size, "tool")} (${nameList([...tools])}) failed with a Postgres permission error on ${subject}${unnamed && named.length > 0 ? " and others" : ""}. Since 2026-10-30, new tables in the public schema are not exposed to the Data API by default; each needs an explicit grant to the authenticated role.${fix}`,
    blocking: false,
  };
}

// ---------------------------------------------------------------------------
// User isolation helpers
// ---------------------------------------------------------------------------

/** Reads the `sub` claim from a JWT without verifying it. */
export function jwtSubject(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as unknown;
    return isRecord(payload) &&
      typeof payload.sub === "string" &&
      payload.sub !== ""
      ? payload.sub
      : undefined;
  } catch {
    return undefined;
  }
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

/** A usable result: not an error and carrying some content. */
export function comparableResult(
  record: ToolResultRecord | undefined,
): string | undefined {
  const result = record?.result;
  if (!result || record?.errorMessage || result.isError === true) {
    return undefined;
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const hasText = content.some(
    (entry) =>
      !isRecord(entry) ||
      typeof entry.text !== "string" ||
      entry.text.trim() !== "",
  );
  const structured = result.structuredContent;
  const hasStructured =
    structured !== undefined &&
    structured !== null &&
    canonical(structured) !== "{}" &&
    canonical(structured) !== "[]";
  if (!hasText && !hasStructured) return undefined;
  return canonical({ content, structuredContent: structured ?? null });
}
