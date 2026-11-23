import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  comparableResult,
  dataApiGrantsCheck,
  jwtIdentity,
  jwtSubject,
  redactIdentity,
  type ProbeTool,
  type ToolResultRecord,
} from "./doctor-checks.js";
import { stripControl, timedFetch } from "./doctor-http.js";
import { computeCanonicalSurfaceDigest } from "./internal/surface-canonical.js";
import {
  explicitTokenPersona,
  resolveLocalPersonas,
  type LocalPersonaDeps,
  type PersonaDescriptor,
  type ResolvedLocalPersona,
} from "./local-personas.js";
import {
  findPackageProject,
  findSupabaseProject,
  PACKAGE_VERSION,
  resolveTargetLocalEndpoint,
  type SetupTarget,
} from "./project.js";
import {
  estimateCatalogTokens,
  estimateResultTokens,
} from "./surface-tokens.js";

const RESULT_BUDGET_BYTES = 16 * 1024;
const UTF8 = new TextEncoder();

export interface TryGrantRemediation {
  readonly detail: string;
  readonly sql?: string;
}

export interface PersonaRunOutcome {
  readonly persona: PersonaDescriptor;
  readonly httpStatus: number;
  readonly discoveredToolCount: number;
  readonly surfaceDigest?: `sha256:${string}`;
  readonly catalogPromptTokens?: number;
  readonly toolVisible: boolean;
  readonly outcome:
    | "skipped-plan"
    | "not-discovered"
    | "unauthorized"
    | "success"
    | "tool-error"
    | "input-required"
    | "protocol-error";
  readonly durationMs: number;
  readonly encodedBytes?: number;
  readonly over16KiBBudget?: boolean;
  readonly estimatedResultTokens?: number;
  readonly result?: Record<string, unknown>;
  readonly errorMessage?: string;
  readonly grantRemediation?: TryGrantRemediation;
}

export type IsolationVerdict =
  | "isolated-different"
  | "shared-identical"
  | "asymmetric-access"
  | "both-empty"
  | "identity-only-difference"
  | "not-comparable";

export interface PersonaComparison {
  readonly verdict: IsolationVerdict;
  readonly summary: string;
  readonly surfaceToolsOnlyInFirst: readonly string[];
  readonly surfaceToolsOnlyInSecond: readonly string[];
  readonly structuredIdOverlap?: {
    readonly firstCount: number;
    readonly secondCount: number;
    readonly sharedCount: number;
  };
}

export interface TryCommandReport {
  readonly schemaVersion: 1;
  readonly command: "try";
  readonly status: "planned" | "needs_confirmation" | "complete" | "blocked";
  readonly endpoint: string;
  readonly tool: string | null;
  readonly arguments: Record<string, unknown>;
  readonly toolAnnotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
  };
  readonly personas: readonly PersonaRunOutcome[];
  readonly comparison?: PersonaComparison;
  readonly nextCommand?: string;
}

export interface RunTryOptions {
  readonly cwd?: string;
  readonly functionName?: string;
  readonly target?: SetupTarget;
  readonly url?: string;
  readonly tool?: string | null;
  readonly args?: Record<string, unknown>;
  /** Preserves `@file.json` or `-` so nextCommand never inlines stdin/file JSON. */
  readonly rawArgsSource?: string;
  readonly as?: readonly string[];
  readonly token?: string;
  readonly secondToken?: string;
  readonly ephemeralUsers?: boolean;
  readonly envFile?: string;
  readonly scopes?: readonly string[];
  readonly plan?: boolean;
  readonly yes?: boolean;
  readonly json?: boolean;
  readonly isTTY?: boolean;
  readonly confirmWrite?: (question: string) => Promise<boolean>;
  readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly personaDeps?: LocalPersonaDeps;
}

export interface ParsedTryArgsInput {
  readonly tool: string | null;
  readonly argsFlag?: string;
  readonly callArgsFlag?: string;
  readonly cwd?: string;
  readonly readStdin?: () => Promise<string>;
}

export interface ParsedTryArgsResult {
  readonly args: Record<string, unknown>;
  readonly rawArgsSource?: string;
}

/**
 * Validates `--args` / `--call-args` without ever echoing raw argument payloads
 * in error messages.
 */
export async function parseTryArgs(
  input: ParsedTryArgsInput,
): Promise<ParsedTryArgsResult> {
  if (input.argsFlag !== undefined && input.callArgsFlag !== undefined) {
    throw new Error("Pass either --args or --call-args, not both.");
  }
  const raw = input.argsFlag ?? input.callArgsFlag;
  if (raw === undefined) {
    return { args: {} };
  }
  if (!input.tool) {
    throw new Error("--args requires a <tool> name.");
  }

  let jsonText: string;
  let rawArgsSource: string | undefined;
  if (raw === "-") {
    rawArgsSource = "-";
    if (!input.readStdin) {
      throw new Error("Standard input is unavailable for --args -.");
    }
    jsonText = await input.readStdin();
  } else if (raw.startsWith("@") && raw.length > 1) {
    rawArgsSource = raw;
    const filePath = resolve(input.cwd ?? process.cwd(), raw.slice(1));
    try {
      jsonText = await readFile(filePath, "utf8");
    } catch {
      throw new Error(`Could not read JSON arguments file '${raw.slice(1)}'.`);
    }
  } else {
    jsonText = raw;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("--args must be a valid JSON object, @<file.json>, or -.");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("--args must be a valid JSON object, @<file.json>, or -.");
  }
  return {
    args: parsed as Record<string, unknown>,
    ...(rawArgsSource ? { rawArgsSource } : {}),
  };
}

interface ProtocolBody {
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

function modernMcpRequest(
  method: string,
  params: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": {
          name: "chumbo-try",
          version: PACKAGE_VERSION,
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
}

function mcpHeaders(method: string, token?: string, name?: string): Headers {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
  });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (name) headers.set("mcp-name", name);
  return headers;
}

async function readProtocolBody(
  response: Response,
): Promise<ProtocolBody | null> {
  const text = await response.text();
  const payload = response.headers
    .get("content-type")
    ?.includes("text/event-stream")
    ? text
        .split(/\r?\n/)
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length)
    : text;
  if (!payload) return null;
  try {
    return JSON.parse(payload) as ProtocolBody;
  } catch {
    return null;
  }
}

function extractErrorMessage(body: ProtocolBody | null): string | undefined {
  const message = body?.error?.message;
  return typeof message === "string" ? stripControl(message) : undefined;
}

function extractStructuredIds(
  result: Record<string, unknown> | undefined,
): Set<string> | undefined {
  if (
    !result ||
    typeof result.structuredContent !== "object" ||
    !result.structuredContent
  ) {
    return undefined;
  }
  const structured = result.structuredContent as Record<string, unknown>;
  const ids = new Set<string>();
  const scanArray = (list: unknown[]) => {
    for (const entry of list) {
      if (
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        typeof (entry as { id?: unknown }).id === "string"
      ) {
        ids.add((entry as { id: string }).id);
      }
    }
  };
  if (Array.isArray(structured)) {
    scanArray(structured);
  } else {
    for (const value of Object.values(structured)) {
      if (Array.isArray(value)) scanArray(value);
    }
  }
  return ids.size > 0 ? ids : undefined;
}

function buildNextCommand(options: RunTryOptions): string {
  const parts = ["npx chumbo try"];
  if (options.tool) parts.push(options.tool);
  if (options.functionName && options.functionName !== "mcp") {
    parts.push("--function", options.functionName);
  }
  if (options.url) parts.push("--url", options.url);
  if (options.as && options.as.length > 0) {
    parts.push("--as", options.as.join(","));
  }
  if (options.rawArgsSource) {
    parts.push("--args", options.rawArgsSource);
  } else if (options.args && Object.keys(options.args).length > 0) {
    parts.push("--args", `'${JSON.stringify(options.args)}'`);
  }
  parts.push("--yes");
  if (options.json) parts.push("--json");
  return parts.join(" ");
}

function compareTwoPersonas(
  first: PersonaRunOutcome,
  second: PersonaRunOutcome,
  firstTools: ReadonlySet<string>,
  secondTools: ReadonlySet<string>,
  firstIdentities: readonly string[],
  secondIdentities: readonly string[],
  toolName: string | null,
): PersonaComparison {
  const surfaceToolsOnlyInFirst = [...firstTools]
    .filter((name) => !secondTools.has(name))
    .sort();
  const surfaceToolsOnlyInSecond = [...secondTools]
    .filter((name) => !firstTools.has(name))
    .sort();

  if (!toolName) {
    const identical =
      surfaceToolsOnlyInFirst.length === 0 &&
      surfaceToolsOnlyInSecond.length === 0 &&
      first.surfaceDigest === second.surfaceDigest;
    return Object.freeze({
      verdict: identical ? "shared-identical" : "asymmetric-access",
      summary: identical
        ? `Both personas discovered the same ${first.discoveredToolCount} tool(s).`
        : `Surface differs between personas (${surfaceToolsOnlyInFirst.length} only in first, ${surfaceToolsOnlyInSecond.length} only in second).`,
      surfaceToolsOnlyInFirst,
      surfaceToolsOnlyInSecond,
    });
  }

  const firstSuccess = first.outcome === "success";
  const secondSuccess = second.outcome === "success";
  if (firstSuccess !== secondSuccess) {
    return Object.freeze({
      verdict: "asymmetric-access",
      summary: `Asymmetric access: '${first.persona.specifier}' finished with '${first.outcome}' while '${second.persona.specifier}' finished with '${second.outcome}'.`,
      surfaceToolsOnlyInFirst,
      surfaceToolsOnlyInSecond,
    });
  }
  if (!firstSuccess && !secondSuccess) {
    return Object.freeze({
      verdict: "not-comparable",
      summary: `Neither persona succeeded ('${first.outcome}' vs '${second.outcome}'), so result isolation could not be compared.`,
      surfaceToolsOnlyInFirst,
      surfaceToolsOnlyInSecond,
    });
  }

  const left = comparableResult({
    tool: toolName,
    caller: "first user",
    result: first.result,
    errorMessage: first.errorMessage,
  });
  const right = comparableResult({
    tool: toolName,
    caller: "second user",
    result: second.result,
    errorMessage: second.errorMessage,
  });

  if (left === undefined && right === undefined) {
    return Object.freeze({
      verdict: "both-empty",
      summary:
        "Both personas returned empty results. Seed distinct rows per user to verify RLS isolation.",
      surfaceToolsOnlyInFirst,
      surfaceToolsOnlyInSecond,
    });
  }
  if (left === undefined || right === undefined) {
    return Object.freeze({
      verdict: "isolated-different",
      summary:
        "One persona returned non-empty data while the other returned empty data. Heuristic observation for this input, not formal proof of RLS completeness.",
      surfaceToolsOnlyInFirst,
      surfaceToolsOnlyInSecond,
    });
  }

  const firstIds = extractStructuredIds(first.result);
  const secondIds = extractStructuredIds(second.result);
  const structuredIdOverlap =
    firstIds && secondIds
      ? {
          firstCount: firstIds.size,
          secondCount: secondIds.size,
          sharedCount: [...firstIds].filter((id) => secondIds.has(id)).length,
        }
      : undefined;

  if (left === right) {
    return Object.freeze({
      verdict: "shared-identical",
      summary:
        "Both personas received identical non-empty data; confirm whether this table is intentionally shared or missing an RLS policy.",
      surfaceToolsOnlyInFirst,
      surfaceToolsOnlyInSecond,
      ...(structuredIdOverlap ? { structuredIdOverlap } : {}),
    });
  }

  const identities = [...firstIdentities, ...secondIdentities];
  if (redactIdentity(left, identities) === redactIdentity(right, identities)) {
    return Object.freeze({
      verdict: "identity-only-difference",
      summary:
        "Results differed only by each user's own id/email. Seed distinct domain records per user to test row isolation.",
      surfaceToolsOnlyInFirst,
      surfaceToolsOnlyInSecond,
      ...(structuredIdOverlap ? { structuredIdOverlap } : {}),
    });
  }

  const overlapNote = structuredIdOverlap
    ? ` (${structuredIdOverlap.firstCount} id(s) vs ${structuredIdOverlap.secondCount} id(s), ${structuredIdOverlap.sharedCount} shared)`
    : "";
  return Object.freeze({
    verdict: "isolated-different",
    summary: `Each user received distinct non-empty data${overlapNote}. Heuristic observation for this input, not formal proof of RLS completeness.`,
    surfaceToolsOnlyInFirst,
    surfaceToolsOnlyInSecond,
    ...(structuredIdOverlap ? { structuredIdOverlap } : {}),
  });
}

async function resolveDefaultEndpoint(
  cwd: string,
  functionName: string,
  target?: SetupTarget,
): Promise<{ endpoint: string; supabaseRoot?: string }> {
  let supabaseRoot: string | undefined;
  try {
    supabaseRoot = await findSupabaseProject(cwd);
  } catch {
    supabaseRoot = undefined;
  }
  const effectiveTarget = target ?? (supabaseRoot ? "edge-function" : "node");
  if (effectiveTarget === "edge-function" && supabaseRoot) {
    return {
      endpoint: await resolveTargetLocalEndpoint(
        supabaseRoot,
        functionName,
        "edge-function",
      ),
      supabaseRoot,
    };
  }
  let packageRoot = cwd;
  try {
    packageRoot = await findPackageProject(cwd);
  } catch {
    packageRoot = cwd;
  }
  return {
    endpoint: await resolveTargetLocalEndpoint(
      packageRoot,
      functionName,
      effectiveTarget,
    ),
    ...(supabaseRoot ? { supabaseRoot } : {}),
  };
}

export async function runTry(
  options: RunTryOptions,
): Promise<TryCommandReport> {
  const cwd = options.cwd ?? process.cwd();
  const functionName = options.functionName ?? "mcp";
  const toolName = options.tool ?? null;
  const callArgs = options.args ?? {};
  const fetchFn = options.fetchImpl ?? timedFetch;

  let endpoint = options.url;
  let supabaseRoot: string | undefined;
  if (!endpoint) {
    const resolved = await resolveDefaultEndpoint(
      cwd,
      functionName,
      options.target,
    );
    endpoint = resolved.endpoint;
    supabaseRoot = resolved.supabaseRoot;
  } else {
    try {
      supabaseRoot = await findSupabaseProject(cwd);
    } catch {
      supabaseRoot = undefined;
    }
  }

  let personas: readonly ResolvedLocalPersona[];
  if (options.as && options.as.length > 0) {
    personas = await resolveLocalPersonas({
      projectRoot: supabaseRoot,
      endpointUrl: endpoint,
      specifiers: options.as,
      ephemeralUsers: options.ephemeralUsers,
      envFile: options.envFile,
      scopes: options.scopes,
      deps: options.personaDeps,
    });
  } else if (options.token) {
    const list: ResolvedLocalPersona[] = [
      explicitTokenPersona(
        "first user",
        options.token,
        jwtSubject(options.token),
      ),
    ];
    if (options.secondToken) {
      list.push(
        explicitTokenPersona(
          "second user",
          options.secondToken,
          jwtSubject(options.secondToken),
        ),
      );
    }
    personas = list;
  } else {
    personas = [
      {
        descriptor: Object.freeze({
          specifier: "anon",
          kind: "anon",
          scopes: Object.freeze([]),
        }),
        getToken: () => undefined,
        cleanup: async () => {},
      },
    ];
  }

  try {
    const discoveries: Array<{
      persona: ResolvedLocalPersona;
      httpStatus: number;
      tools: ProbeTool[];
      toolNames: Set<string>;
      surfaceDigest?: `sha256:${string}`;
      catalogPromptTokens?: number;
      matchedTool?: ProbeTool;
      unauthorized: boolean;
      errorMessage?: string;
    }> = [];

    for (const persona of personas) {
      const token = persona.getToken();
      const response = await fetchFn(endpoint, {
        method: "POST",
        headers: mcpHeaders("tools/list", token),
        body: modernMcpRequest("tools/list"),
      });
      const body = await readProtocolBody(response);
      const unauthorized = response.status === 401 || response.status === 403;
      const rawTools = Array.isArray(body?.result?.tools)
        ? (body.result.tools as ProbeTool[])
        : [];
      const canonical =
        response.ok && !body?.error
          ? await computeCanonicalSurfaceDigest(rawTools)
          : null;
      const catalogTokens =
        response.ok && !body?.error
          ? estimateCatalogTokens(rawTools).totalPromptTokens
          : undefined;
      const toolNames = new Set(
        rawTools
          .map((t) => (typeof t.name === "string" ? t.name : ""))
          .filter(Boolean),
      );
      const matchedTool = toolName
        ? rawTools.find((t) => t.name === toolName)
        : undefined;

      discoveries.push({
        persona,
        httpStatus: response.status,
        tools: rawTools,
        toolNames,
        ...(canonical ? { surfaceDigest: canonical.contentDigest } : {}),
        ...(catalogTokens !== undefined
          ? { catalogPromptTokens: catalogTokens }
          : {}),
        ...(matchedTool ? { matchedTool } : {}),
        unauthorized,
        errorMessage: extractErrorMessage(body),
      });
    }

    const firstMatchedTool = discoveries.find(
      (d) => d.matchedTool,
    )?.matchedTool;
    const rawAnn = firstMatchedTool?.annotations as
      | {
          readOnlyHint?: unknown;
          destructiveHint?: unknown;
          idempotentHint?: unknown;
        }
      | null
      | undefined;
    const toolAnnotations =
      rawAnn && typeof rawAnn === "object"
        ? {
            ...(typeof rawAnn.readOnlyHint === "boolean"
              ? { readOnlyHint: rawAnn.readOnlyHint }
              : {}),
            ...(typeof rawAnn.destructiveHint === "boolean"
              ? { destructiveHint: rawAnn.destructiveHint }
              : {}),
            ...(typeof rawAnn.idempotentHint === "boolean"
              ? { idempotentHint: rawAnn.idempotentHint }
              : {}),
          }
        : undefined;

    // Preview plan or non-read-only write gate before invoking tools/call.
    const isReadOnly = toolAnnotations?.readOnlyHint === true;
    const needsWriteConfirmation =
      Boolean(toolName) &&
      Boolean(firstMatchedTool) &&
      !isReadOnly &&
      !options.yes &&
      !options.plan;

    if (options.plan || needsWriteConfirmation) {
      if (needsWriteConfirmation && !options.json) {
        if (options.isTTY && options.confirmWrite) {
          const who = personas.map((p) => p.descriptor.specifier).join(", ");
          const approved = await options.confirmWrite(
            `Tool '${toolName}' is not marked read-only. Call it locally as ${who}?`,
          );
          if (!approved) {
            throw new Error(
              "No tool call executed. Re-run with --yes for non-interactive use.",
            );
          }
        } else {
          throw new Error(
            `Tool '${toolName}' is not marked read-only. Re-run with --yes to invoke it locally.`,
          );
        }
      } else {
        const plannedOutcomes: PersonaRunOutcome[] = discoveries.map((d) => ({
          persona: d.persona.descriptor,
          httpStatus: d.httpStatus,
          discoveredToolCount: d.tools.length,
          ...(d.surfaceDigest ? { surfaceDigest: d.surfaceDigest } : {}),
          ...(d.catalogPromptTokens !== undefined
            ? { catalogPromptTokens: d.catalogPromptTokens }
            : {}),
          toolVisible: Boolean(d.matchedTool),
          outcome: d.unauthorized
            ? "unauthorized"
            : toolName && !d.matchedTool
              ? "not-discovered"
              : "skipped-plan",
          durationMs: 0,
        }));
        return Object.freeze({
          schemaVersion: 1,
          command: "try",
          status: options.plan ? "planned" : "needs_confirmation",
          endpoint,
          tool: toolName,
          arguments: callArgs,
          ...(toolAnnotations ? { toolAnnotations } : {}),
          personas: Object.freeze(plannedOutcomes),
          nextCommand: buildNextCommand(options),
        });
      }
    }

    const outcomes: PersonaRunOutcome[] = [];
    for (const d of discoveries) {
      if (d.unauthorized) {
        outcomes.push({
          persona: d.persona.descriptor,
          httpStatus: d.httpStatus,
          discoveredToolCount: 0,
          toolVisible: false,
          outcome: "unauthorized",
          durationMs: 0,
          errorMessage: d.errorMessage ?? `HTTP ${d.httpStatus}`,
        });
        continue;
      }

      if (!toolName) {
        outcomes.push({
          persona: d.persona.descriptor,
          httpStatus: d.httpStatus,
          discoveredToolCount: d.tools.length,
          ...(d.surfaceDigest ? { surfaceDigest: d.surfaceDigest } : {}),
          ...(d.catalogPromptTokens !== undefined
            ? { catalogPromptTokens: d.catalogPromptTokens }
            : {}),
          toolVisible: false,
          outcome: "success",
          durationMs: 0,
        });
        continue;
      }

      if (!d.matchedTool) {
        outcomes.push({
          persona: d.persona.descriptor,
          httpStatus: d.httpStatus,
          discoveredToolCount: d.tools.length,
          ...(d.surfaceDigest ? { surfaceDigest: d.surfaceDigest } : {}),
          ...(d.catalogPromptTokens !== undefined
            ? { catalogPromptTokens: d.catalogPromptTokens }
            : {}),
          toolVisible: false,
          outcome: "not-discovered",
          durationMs: 0,
        });
        continue;
      }

      const started = Date.now();
      const response = await fetchFn(endpoint, {
        method: "POST",
        headers: mcpHeaders("tools/call", d.persona.getToken(), toolName),
        body: modernMcpRequest("tools/call", {
          name: toolName,
          arguments: callArgs,
        }),
      });
      const durationMs = Math.max(0, Date.now() - started);
      const body = await readProtocolBody(response);
      const errorMessage = extractErrorMessage(body);
      const result = body?.result;
      const encodedBytes = result
        ? UTF8.encode(JSON.stringify(result)).byteLength
        : undefined;
      const estimatedResultTokens = result
        ? estimateResultTokens(result).totalTokens
        : undefined;

      let outcome: PersonaRunOutcome["outcome"];
      if (response.status === 401 || response.status === 403) {
        outcome = "unauthorized";
      } else if (!response.ok || body?.error || !result) {
        outcome = "protocol-error";
      } else if (result.isError === true) {
        outcome = "tool-error";
      } else if (result.status === "input_required") {
        outcome = "input-required";
      } else {
        outcome = "success";
      }

      let grantRemediation: TryGrantRemediation | undefined;
      if (outcome === "tool-error" || outcome === "protocol-error") {
        const record: ToolResultRecord = {
          tool: toolName,
          caller: d.persona.descriptor.specifier,
          ...(result ? { result } : {}),
          ...(errorMessage ? { errorMessage } : {}),
        };
        const grantCheck = dataApiGrantsCheck([record]);
        if (grantCheck && !grantCheck.ok) {
          const checkWithRem = grantCheck as {
            detail: string;
            remediation?: { sql?: string };
          };
          grantRemediation = {
            detail: stripControl(grantCheck.detail),
            ...(checkWithRem.remediation?.sql
              ? { sql: checkWithRem.remediation.sql }
              : {}),
          };
        }
      }

      outcomes.push({
        persona: d.persona.descriptor,
        httpStatus: response.status,
        discoveredToolCount: d.tools.length,
        ...(d.surfaceDigest ? { surfaceDigest: d.surfaceDigest } : {}),
        ...(d.catalogPromptTokens !== undefined
          ? { catalogPromptTokens: d.catalogPromptTokens }
          : {}),
        toolVisible: true,
        outcome,
        durationMs,
        ...(encodedBytes !== undefined
          ? {
              encodedBytes,
              over16KiBBudget: encodedBytes > RESULT_BUDGET_BYTES,
            }
          : {}),
        ...(estimatedResultTokens !== undefined
          ? { estimatedResultTokens }
          : {}),
        ...(result ? { result } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        ...(grantRemediation ? { grantRemediation } : {}),
      });
    }

    let comparison: PersonaComparison | undefined;
    if (outcomes.length >= 2) {
      const first = outcomes[0]!;
      const second = outcomes[1]!;
      const firstToken = discoveries[0]!.persona.getToken();
      const secondToken = discoveries[1]!.persona.getToken();
      const firstIds = [
        ...(firstToken ? jwtIdentity(firstToken) : []),
        ...(first.persona.userId ? [first.persona.userId] : []),
        ...(first.persona.email ? [first.persona.email] : []),
      ];
      const secondIds = [
        ...(secondToken ? jwtIdentity(secondToken) : []),
        ...(second.persona.userId ? [second.persona.userId] : []),
        ...(second.persona.email ? [second.persona.email] : []),
      ];
      comparison = compareTwoPersonas(
        first,
        second,
        discoveries[0]!.toolNames,
        discoveries[1]!.toolNames,
        firstIds,
        secondIds,
        toolName,
      );
    }

    const blocked = outcomes.every(
      (o) => o.outcome === "unauthorized" || o.outcome === "protocol-error",
    );

    return Object.freeze({
      schemaVersion: 1,
      command: "try",
      status: blocked ? "blocked" : "complete",
      endpoint,
      tool: toolName,
      arguments: callArgs,
      ...(toolAnnotations ? { toolAnnotations } : {}),
      personas: Object.freeze(outcomes),
      ...(comparison ? { comparison } : {}),
    });
  } finally {
    await Promise.allSettled(personas.map((persona) => persona.cleanup()));
  }
}

export function formatTryReport(report: TryCommandReport): string {
  const lines: string[] = [
    `Endpoint: ${report.endpoint}`,
    `Tool:     ${report.tool ?? "(surface discovery only)"}${
      report.toolAnnotations?.readOnlyHint !== undefined
        ? ` (readOnlyHint: ${String(report.toolAnnotations.readOnlyHint)})`
        : ""
    } · args: ${JSON.stringify(report.arguments)}`,
    "",
  ];

  report.personas.forEach((entry, index) => {
    const label = entry.persona.email
      ? `${entry.persona.email} (${entry.persona.userId ? `user ${entry.persona.userId.slice(0, 8)}…` : entry.persona.kind})`
      : `${entry.persona.specifier} (${entry.persona.kind})`;
    lines.push(`Persona ${index + 1} — ${label}`);
    const marker =
      entry.outcome === "success" || entry.outcome === "skipped-plan"
        ? "✓"
        : "!";
    const sizePart =
      entry.encodedBytes !== undefined
        ? ` · ${entry.encodedBytes} B (budget 16 KiB${entry.over16KiBBudget ? " — OVER" : ""}) · ~${entry.estimatedResultTokens ?? 0} result tokens`
        : "";
    lines.push(
      `  Status:  ${marker} ${entry.outcome} (${entry.durationMs}ms)${sizePart}`,
    );
    if (entry.catalogPromptTokens !== undefined) {
      lines.push(
        `  Surface: ${entry.discoveredToolCount} tool(s) · ~${entry.catalogPromptTokens} cold-start tokens${entry.surfaceDigest ? ` · ${entry.surfaceDigest.slice(0, 16)}…` : ""}`,
      );
    }
    if (entry.grantRemediation) {
      lines.push(`  Grants:  ${entry.grantRemediation.detail}`);
      if (entry.grantRemediation.sql) {
        lines.push(
          `  SQL:\n    ${entry.grantRemediation.sql.replaceAll("\n", "\n    ")}`,
        );
      }
    }
    lines.push("");
  });

  if (report.comparison) {
    const marker =
      report.comparison.verdict === "isolated-different" ? "✓" : "!";
    lines.push("Isolation comparison:");
    lines.push(
      `  ${marker} ${report.comparison.verdict}: ${report.comparison.summary}`,
    );
  }
  if (report.nextCommand) {
    lines.push("", `Next: ${report.nextCommand}`);
  }
  return lines.join("\n");
}
