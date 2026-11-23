import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { RunStep, RunTimeline, UnlinkedCallGroup } from "./insights.js";
import {
  findPackageProject,
  findSupabaseProject,
  PACKAGE_VERSION,
} from "./project.js";
import { readSurfaceLockfile, resolveLockfilePath } from "./surface-lock.js";
import type {
  SupabaseMcpCapabilityKind,
  SupabaseMcpLifecycleOutcome,
} from "./types.js";

export const RUN_FRICTION_RECEIPT_VERSION = 1 as const;

const MAX_RECEIPT_STEPS = 100;
const MAX_STEP_CAPABILITIES = 8;
const MAX_ERROR_CODES = 16;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/u;
const URI_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export interface RunFrictionReceiptStep {
  readonly kind: "call" | "loop";
  readonly capabilityNames: readonly string[];
  readonly capabilityKinds: readonly SupabaseMcpCapabilityKind[];
  readonly observedCallCount: number;
  readonly cycleCount?: number;
  readonly outcome: SupabaseMcpLifecycleOutcome;
  readonly errorCodes: readonly string[];
  readonly slow: boolean;
}

/** Portable, payload-free JSON receipt accepted by `npx chumbo test scaffold --from-receipt`. */
export interface RunFrictionReceiptV1 {
  readonly schemaVersion: typeof RUN_FRICTION_RECEIPT_VERSION;
  readonly sourceKind: "correlated-run" | "unlinked-window";
  readonly referenceId: string;
  readonly observedCallCount: number;
  readonly observedDurationMs: number;
  /** Exact errorCount for RunTimeline; lower-bound friction step count for UnlinkedCallGroup. */
  readonly observedErrorCount: number;
  readonly targetCallBudget: number;
  readonly clientLabel: string | null;
  readonly steps: readonly RunFrictionReceiptStep[];
}

export interface ExportContractTestOptions {
  readonly runner?: "deno" | "vitest";
  readonly appImportPath?: string;
  readonly projectSlug?: string;
  /** Optional local input schema hints supplied by `npx chumbo test scaffold`. */
  readonly inputSkeletons?: Readonly<Record<string, Record<string, unknown>>>;
}

export interface ExportedContractTest {
  readonly filename: string;
  readonly code: string;
  readonly receipt: RunFrictionReceiptV1;
  readonly cliCommand: string;
}

export interface PlannedScaffoldFile {
  readonly path: string;
  readonly relativePath: string;
  readonly status: "create" | "update" | "unchanged" | "conflict";
  readonly content: string;
}

export interface TestScaffoldPlan {
  readonly projectRoot: string;
  readonly runner: "deno" | "vitest";
  readonly outPath: string;
  readonly receipt: RunFrictionReceiptV1;
  readonly files: readonly PlannedScaffoldFile[];
  readonly code: string;
}

export interface TestScaffoldReport {
  readonly schemaVersion: 1;
  readonly command: "test scaffold";
  readonly status: "planned" | "needs_confirmation" | "complete" | "conflict";
  readonly runner: "deno" | "vitest";
  readonly outPath: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly status: PlannedScaffoldFile["status"];
  }>;
  readonly receipt: RunFrictionReceiptV1;
  readonly nextCommand?: string;
}

function sanitizeCommentText(value: string): string {
  return value
    .replaceAll("*/", "* /")
    .replace(/[\r\n\u0000-\u001f\u007f]+/gu, " ")
    .trim();
}

function slugifyId(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "journey";
}

function isReceipt(
  source: RunTimeline | UnlinkedCallGroup | RunFrictionReceiptV1,
): source is RunFrictionReceiptV1 {
  return (
    "schemaVersion" in source &&
    source.schemaVersion === RUN_FRICTION_RECEIPT_VERSION &&
    "sourceKind" in source
  );
}

/**
 * Converts a payload-free `RunTimeline` or `UnlinkedCallGroup` into a portable
 * `RunFrictionReceiptV1`. Never accepts or includes member PII.
 */
export function buildRunFrictionReceipt(
  source: RunTimeline | UnlinkedCallGroup,
): RunFrictionReceiptV1 {
  const isCorrelated = "runId" in source;
  const targetCallBudget = source.steps.reduce(
    (sum, step) => sum + step.capabilityNames.length,
    0,
  );
  const observedErrorCount = isCorrelated
    ? source.errorCount
    : source.steps.filter((step) => step.friction).length;

  return Object.freeze({
    schemaVersion: RUN_FRICTION_RECEIPT_VERSION,
    sourceKind: isCorrelated ? "correlated-run" : "unlinked-window",
    referenceId: isCorrelated ? source.runId : source.windowStart,
    observedCallCount: source.callCount,
    observedDurationMs: source.totalDurationMs,
    observedErrorCount,
    targetCallBudget,
    clientLabel: isCorrelated ? (source.clientLabel ?? null) : null,
    steps: Object.freeze(
      source.steps.map((step: RunStep) =>
        Object.freeze({
          kind: step.kind,
          capabilityNames: Object.freeze([...step.capabilityNames]),
          capabilityKinds: Object.freeze([...step.capabilityKinds]),
          observedCallCount: step.callCount,
          ...(step.cycleCount !== undefined
            ? { cycleCount: step.cycleCount }
            : {}),
          outcome: step.outcome,
          errorCodes: Object.freeze([...step.errorCodes]),
          slow: step.slow,
        }),
      ),
    ),
  });
}

function assertBoundedText(
  value: unknown,
  label: string,
  maxLen = 256,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLen ||
    CONTROL_CHAR_PATTERN.test(value)
  ) {
    throw new Error(
      `${label} must be bounded text without control characters.`,
    );
  }
  return value;
}

export function validateRunFrictionReceipt(raw: unknown): RunFrictionReceiptV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Receipt must be a JSON object.");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== RUN_FRICTION_RECEIPT_VERSION) {
    throw new Error("Receipt schemaVersion must be 1.");
  }
  if (
    obj.sourceKind !== "correlated-run" &&
    obj.sourceKind !== "unlinked-window"
  ) {
    throw new Error(
      "Receipt sourceKind must be 'correlated-run' or 'unlinked-window'.",
    );
  }
  const referenceId = assertBoundedText(obj.referenceId, "receipt.referenceId");
  const observedCallCount = Number(obj.observedCallCount);
  const observedDurationMs = Number(obj.observedDurationMs);
  const observedErrorCount = Number(obj.observedErrorCount);
  const targetCallBudget = Number(obj.targetCallBudget);
  if (
    !Number.isSafeInteger(observedCallCount) ||
    observedCallCount < 1 ||
    !Number.isFinite(observedDurationMs) ||
    observedDurationMs < 0 ||
    !Number.isSafeInteger(observedErrorCount) ||
    observedErrorCount < 0 ||
    !Number.isSafeInteger(targetCallBudget) ||
    targetCallBudget < 1
  ) {
    throw new Error(
      "Receipt counts and durations must be valid non-negative numbers.",
    );
  }
  const clientLabel =
    obj.clientLabel === null || obj.clientLabel === undefined
      ? null
      : assertBoundedText(obj.clientLabel, "receipt.clientLabel", 128);
  if (
    !Array.isArray(obj.steps) ||
    obj.steps.length === 0 ||
    obj.steps.length > MAX_RECEIPT_STEPS
  ) {
    throw new Error(
      `Receipt steps must be a non-empty array of at most ${MAX_RECEIPT_STEPS} steps.`,
    );
  }
  const steps: RunFrictionReceiptStep[] = obj.steps.map((entry, idx) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`receipt.steps[${idx}] must be an object.`);
    }
    const item = entry as Record<string, unknown>;
    if (item.kind !== "call" && item.kind !== "loop") {
      throw new Error(`receipt.steps[${idx}].kind must be 'call' or 'loop'.`);
    }
    if (
      !Array.isArray(item.capabilityNames) ||
      item.capabilityNames.length === 0 ||
      item.capabilityNames.length > MAX_STEP_CAPABILITIES ||
      !Array.isArray(item.capabilityKinds) ||
      item.capabilityKinds.length !== item.capabilityNames.length
    ) {
      throw new Error(
        `receipt.steps[${idx}] must have matching non-empty capabilityNames and capabilityKinds.`,
      );
    }
    const capabilityNames = item.capabilityNames.map((name, cIdx) =>
      assertBoundedText(
        name,
        `receipt.steps[${idx}].capabilityNames[${cIdx}]`,
        128,
      ),
    );
    const capabilityKinds = item.capabilityKinds.map((kind, cIdx) => {
      if (kind !== "tool" && kind !== "resource" && kind !== "prompt") {
        throw new Error(
          `receipt.steps[${idx}].capabilityKinds[${cIdx}] must be tool, resource, or prompt.`,
        );
      }
      return kind as SupabaseMcpCapabilityKind;
    });
    const outcome = item.outcome;
    if (
      outcome !== "success" &&
      outcome !== "tool-error" &&
      outcome !== "input-required" &&
      outcome !== "failure"
    ) {
      throw new Error(`receipt.steps[${idx}].outcome is invalid.`);
    }
    const errorCodes = Array.isArray(item.errorCodes)
      ? item.errorCodes
          .slice(0, MAX_ERROR_CODES)
          .map((code, eIdx) =>
            assertBoundedText(
              code,
              `receipt.steps[${idx}].errorCodes[${eIdx}]`,
              64,
            ),
          )
      : [];
    const stepObserved = Number(item.observedCallCount);
    if (!Number.isSafeInteger(stepObserved) || stepObserved < 1) {
      throw new Error(
        `receipt.steps[${idx}].observedCallCount must be a positive integer.`,
      );
    }
    const cycleCount =
      item.cycleCount === undefined ? undefined : Number(item.cycleCount);
    if (
      cycleCount !== undefined &&
      (!Number.isSafeInteger(cycleCount) || cycleCount < 1)
    ) {
      throw new Error(
        `receipt.steps[${idx}].cycleCount must be a positive integer.`,
      );
    }
    return Object.freeze({
      kind: item.kind,
      capabilityNames: Object.freeze(capabilityNames),
      capabilityKinds: Object.freeze(capabilityKinds),
      observedCallCount: stepObserved,
      ...(cycleCount !== undefined ? { cycleCount } : {}),
      outcome,
      errorCodes: Object.freeze(errorCodes),
      slow: Boolean(item.slow),
    });
  });

  return Object.freeze({
    schemaVersion: RUN_FRICTION_RECEIPT_VERSION,
    sourceKind: obj.sourceKind,
    referenceId,
    observedCallCount,
    observedDurationMs,
    observedErrorCount,
    targetCallBudget,
    clientLabel,
    steps: Object.freeze(steps),
  });
}

export function receiptFromStepsShorthand(
  stepNames: readonly string[],
): RunFrictionReceiptV1 {
  const cleaned = stepNames.map((s) => s.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    throw new Error("--steps requires at least one capability name.");
  }
  return validateRunFrictionReceipt({
    schemaVersion: 1,
    sourceKind: "correlated-run",
    referenceId: `manual-${cleaned.slice(0, 3).join("-")}`,
    observedCallCount: cleaned.length,
    observedDurationMs: 0,
    observedErrorCount: 0,
    targetCallBudget: cleaned.length,
    clientLabel: null,
    steps: cleaned.map((name) => ({
      kind: "call",
      capabilityNames: [name],
      capabilityKinds: ["tool"],
      observedCallCount: 1,
      outcome: "success",
      errorCodes: [],
      slow: false,
    })),
  });
}

function formatSkeletonArgs(
  toolName: string,
  skeletons: Readonly<Record<string, Record<string, unknown>>> | undefined,
  indent: string,
): string {
  const skeleton = skeletons?.[toolName];
  if (!skeleton || Object.keys(skeleton).length === 0) {
    return `{\n${indent}  // TODO: fill local seed arguments\n${indent}}`;
  }
  return JSON.stringify(skeleton, null, 2)
    .split("\n")
    .map((line, index) => (index === 0 ? line : `${indent}${line}`))
    .join("\n");
}

function renderStepLines(
  receipt: RunFrictionReceiptV1,
  runner: "deno" | "vitest",
  inputSkeletons: Readonly<Record<string, Record<string, unknown>>> | undefined,
): string[] {
  const indent = runner === "vitest" ? "    " : "  ";
  const lines: string[] = [];
  let callIndex = 0;

  for (const step of receipt.steps) {
    const contextTags: string[] = [];
    if (step.kind === "loop" && step.cycleCount) {
      contextTags.push(`observed inside ×${step.cycleCount} loop`);
    }
    if (step.outcome === "tool-error" || step.outcome === "failure") {
      const codes =
        step.errorCodes.length > 0
          ? `: ${step.errorCodes.map((c) => JSON.stringify(sanitizeCommentText(c))).join(", ")}`
          : "";
      contextTags.push(`observed ${step.outcome}${codes}`);
    }
    if (step.slow) {
      contextTags.push("observed slow >10s");
    }
    const tagSuffix =
      contextTags.length > 0 ? ` (${contextTags.join("; ")})` : "";

    for (let i = 0; i < step.capabilityNames.length; i += 1) {
      callIndex += 1;
      const capName = step.capabilityNames[i]!;
      const capKind = step.capabilityKinds[i]!;
      const varName = `step${callIndex}`;
      const safeCommentName = JSON.stringify(sanitizeCommentText(capName));

      lines.push(
        `${indent}// Step ${callIndex}${tagSuffix}: ${capKind} ${safeCommentName}`,
      );

      if (capKind === "tool") {
        const argsBlock = formatSkeletonArgs(capName, inputSkeletons, indent);
        lines.push(
          `${indent}const ${varName} = await caller.callTool(${JSON.stringify(capName)}, ${argsBlock});`,
        );
        lines.push(`${indent}executedCalls.push(${JSON.stringify(capName)});`);
        if (runner === "vitest") {
          lines.push(`${indent}expect(${varName}.isError).not.toBe(true);`);
          lines.push(
            `${indent}expect(${varName}.encodedBytes).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);`,
          );
        } else {
          lines.push(
            `${indent}assert(${varName}.isError !== true, ${JSON.stringify(`${capName} returned a tool error`)});`,
          );
          lines.push(
            `${indent}assert(${varName}.encodedBytes <= RESULT_BUDGET_BYTES, ${JSON.stringify(`${capName} exceeded 16 KiB`)});`,
          );
        }
      } else if (capKind === "resource") {
        if (URI_SCHEME_PATTERN.test(capName)) {
          lines.push(
            `${indent}const ${varName} = await caller.readResource(${JSON.stringify(capName)});`,
          );
        } else {
          lines.push(
            `${indent}const ${varName}Resources = await caller.listResources();`,
          );
          lines.push(
            `${indent}const ${varName}Uri = ${varName}Resources.find((r) => r.name === ${JSON.stringify(capName)})?.uri ?? ${JSON.stringify(`TODO://replace-with-${slugifyId(capName)}-uri`)};`,
          );
          lines.push(
            `${indent}const ${varName} = await caller.readResource(${varName}Uri);`,
          );
        }
        lines.push(`${indent}executedCalls.push(${JSON.stringify(capName)});`);
        if (runner === "vitest") {
          lines.push(
            `${indent}expect(utf8.encode(JSON.stringify(${varName})).byteLength).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);`,
          );
        } else {
          lines.push(
            `${indent}assert(utf8.encode(JSON.stringify(${varName})).byteLength <= RESULT_BUDGET_BYTES, ${JSON.stringify(`${capName} exceeded 16 KiB`)});`,
          );
        }
      } else {
        const argsBlock = formatSkeletonArgs(capName, inputSkeletons, indent);
        lines.push(
          `${indent}const ${varName} = await caller.exchange("prompts/get", { name: ${JSON.stringify(capName)}, arguments: ${argsBlock} });`,
        );
        lines.push(`${indent}executedCalls.push(${JSON.stringify(capName)});`);
        if (runner === "vitest") {
          lines.push(`${indent}expect(${varName}.status).toBe(200);`);
          lines.push(
            `${indent}expect((${varName}.body as { error?: unknown })?.error).toBeUndefined();`,
          );
          lines.push(
            `${indent}expect(utf8.encode(JSON.stringify(${varName}.body)).byteLength).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);`,
          );
        } else {
          lines.push(
            `${indent}assert(${varName}.status === 200, ${JSON.stringify(`${capName} returned non-200 status`)});`,
          );
          lines.push(
            `${indent}assert(!(${varName}.body as { error?: unknown })?.error, ${JSON.stringify(`${capName} returned a JSON-RPC error`)});`,
          );
          lines.push(
            `${indent}assert(utf8.encode(JSON.stringify(${varName}.body)).byteLength <= RESULT_BUDGET_BYTES, ${JSON.stringify(`${capName} exceeded 16 KiB`)});`,
          );
        }
      }

      lines.push("");
    }
  }

  return lines;
}

export function exportRunAsContractTest(
  source: RunTimeline | UnlinkedCallGroup | RunFrictionReceiptV1,
  options?: ExportContractTestOptions,
): ExportedContractTest {
  const receipt = isReceipt(source) ? source : buildRunFrictionReceipt(source);
  const runner = options?.runner ?? "vitest";
  const slug = slugifyId(receipt.referenceId);
  const filename =
    runner === "deno"
      ? `${slug.replaceAll("-", "_")}_test.ts`
      : `${slug}.journey.test.ts`;
  const appImportPath =
    options?.appImportPath ??
    (runner === "deno"
      ? "../index.ts"
      : "../../supabase/functions/mcp/index.ts");

  const sequenceLabel = sanitizeCommentText(
    receipt.steps.flatMap((s) => s.capabilityNames).join(" -> "),
  );
  const refComment = JSON.stringify(sanitizeCommentText(receipt.referenceId));
  const durationLabel =
    receipt.observedDurationMs < 1_000
      ? `${Math.round(receipt.observedDurationMs)}ms`
      : `${(receipt.observedDurationMs / 1_000).toFixed(2)}s`;
  const clientNote = receipt.clientLabel
    ? `, client: ${JSON.stringify(sanitizeCommentText(receipt.clientLabel))}`
    : "";
  const errorNote =
    receipt.observedErrorCount > 0
      ? `, ${receipt.observedErrorCount} error(s)`
      : "";
  const testTitle = `journey contract: ${sequenceLabel} (${sanitizeCommentText(receipt.referenceId)})`;
  const stepLines = renderStepLines(receipt, runner, options?.inputSkeletons);

  let code: string;
  if (runner === "vitest") {
    code = [
      `// Generated from payload-free Chumbo Insights run receipt (${refComment}).`,
      `// Observed: ${receipt.observedCallCount} call(s) in ${durationLabel}${errorNote}${clientNote}.`,
      "// Prompts, tool arguments, and results were never recorded — supply local seed values below.",
      'import { describe, expect, it } from "vitest";',
      'import { createMcpTestClient, createTestAuthHarness } from "chumbo/testing";',
      "",
      "const RESULT_BUDGET_BYTES = 16 * 1024;",
      `const TARGET_MAX_CALLS = ${receipt.targetCallBudget};`,
      "const utf8 = new TextEncoder();",
      "",
      "const authHarness = await createTestAuthHarness({",
      '  supabaseUrl: "http://127.0.0.1:54321",',
      "});",
      'process.env.SUPABASE_URL ??= "http://127.0.0.1:54321";',
      'process.env.SUPABASE_PUBLISHABLE_KEY ??= "test-publishable-key";',
      "if (!process.env.CHUMBO_TEST_USER_TOKEN) {",
      "  process.env.SUPABASE_JWKS ??= JSON.stringify(authHarness.jwks);",
      "}",
      `const { default: app } = await import(${JSON.stringify(appImportPath)});`,
      "",
      `describe(${JSON.stringify(testTitle)}, () => {`,
      `  it(${JSON.stringify(`completes in <= ${receipt.targetCallBudget} call(s) without errors or oversized payloads`)}, async () => {`,
      "    const client = createMcpTestClient(app, { authHarness });",
      "    const caller = client.asUser({",
      '      id: "00000000-0000-4000-8000-000000000001",',
      '      email: "alice@example.test",',
      "      ...(process.env.CHUMBO_TEST_USER_TOKEN",
      "        ? { token: process.env.CHUMBO_TEST_USER_TOKEN }",
      "        : {}),",
      "    });",
      "",
      "    const executedCalls: string[] = [];",
      "",
      ...stepLines,
      "    expect(executedCalls.length).toBeLessThanOrEqual(TARGET_MAX_CALLS);",
      "  });",
      "});",
      "",
    ].join("\n");
  } else {
    code = [
      `// Generated from payload-free Chumbo Insights run receipt (${refComment}).`,
      `// Observed: ${receipt.observedCallCount} call(s) in ${durationLabel}${errorNote}${clientNote}.`,
      "// Prompts, tool arguments, and results were never recorded — supply local seed values below.",
      'import { createMcpTestClient, createTestAuthHarness } from "chumbo/testing";',
      "",
      "const RESULT_BUDGET_BYTES = 16 * 1024;",
      `const TARGET_MAX_CALLS = ${receipt.targetCallBudget};`,
      "const utf8 = new TextEncoder();",
      "",
      "function assert(condition: unknown, message: string): asserts condition {",
      "  if (!condition) throw new Error(message);",
      "}",
      "",
      "const authHarness = await createTestAuthHarness({",
      '  supabaseUrl: "http://127.0.0.1:54321",',
      "});",
      "Deno.env.set(",
      '  "SUPABASE_URL",',
      '  Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321",',
      ");",
      "Deno.env.set(",
      '  "SUPABASE_PUBLISHABLE_KEY",',
      '  Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "test-publishable-key",',
      ");",
      'const liveToken = Deno.env.get("CHUMBO_TEST_USER_TOKEN");',
      "if (!liveToken) {",
      '  Deno.env.set("SUPABASE_JWKS", JSON.stringify(authHarness.jwks));',
      "}",
      `const { default: app } = await import(${JSON.stringify(appImportPath)});`,
      "",
      `Deno.test(${JSON.stringify(testTitle)}, async () => {`,
      "  const client = createMcpTestClient(app, { authHarness });",
      "  const caller = client.asUser({",
      '    id: "00000000-0000-4000-8000-000000000001",',
      '    email: "alice@example.test",',
      "    ...(liveToken ? { token: liveToken } : {}),",
      "  });",
      "",
      "  const executedCalls: string[] = [];",
      "",
      ...stepLines,
      "  assert(",
      "    executedCalls.length <= TARGET_MAX_CALLS,",
      "    `Expected <= ${TARGET_MAX_CALLS} calls, observed ${executedCalls.length}`,",
      "  );",
      "});",
      "",
    ].join("\n");
  }

  return Object.freeze({
    filename,
    code,
    receipt,
    cliCommand: `npx chumbo test scaffold --from-receipt ./${slug}.receipt.json --runner ${runner} --yes`,
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function skeletonValueForSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return "";
  }
  const obj = schema as Record<string, unknown>;
  if ("default" in obj) return obj.default;
  if (Array.isArray(obj.enum) && obj.enum.length > 0) return obj.enum[0];
  const type = Array.isArray(obj.type) ? obj.type[0] : obj.type;
  if (type === "number" || type === "integer") return 1;
  if (type === "boolean") return false;
  if (type === "array") return [];
  if (type === "object") return {};
  return "";
}

async function loadInputSkeletonsFromLockfile(
  lockfilePath: string,
): Promise<Record<string, Record<string, unknown>>> {
  if (!(await pathExists(lockfilePath))) return {};
  try {
    const lockfile = await readSurfaceLockfile(lockfilePath);
    const skeletons: Record<string, Record<string, unknown>> = {};
    for (const entry of Object.values(lockfile.surfaces)) {
      for (const tool of entry.tools) {
        const props = (
          tool.inputSchema as { properties?: Record<string, unknown> }
        ).properties;
        if (!props || typeof props !== "object") continue;
        const fields: Record<string, unknown> = {};
        for (const [key, propSchema] of Object.entries(props)) {
          fields[key] = skeletonValueForSchema(propSchema);
        }
        skeletons[tool.name] = fields;
      }
    }
    return skeletons;
  } catch {
    return {};
  }
}

function upgradeLegacyDenoConfig(source: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(source) as Record<string, unknown>;
  } catch {
    return source;
  }
  let changed = false;
  const imports =
    parsed.imports &&
    typeof parsed.imports === "object" &&
    !Array.isArray(parsed.imports)
      ? ({ ...(parsed.imports as Record<string, string>) } as Record<
          string,
          string
        >)
      : {};
  if (!imports["chumbo/testing"]) {
    const chumboSpec = imports.chumbo ?? `npm:chumbo@${PACKAGE_VERSION}`;
    imports["chumbo/testing"] = `${chumboSpec}/testing`;
    parsed.imports = imports;
    changed = true;
  }
  const tasks =
    parsed.tasks &&
    typeof parsed.tasks === "object" &&
    !Array.isArray(parsed.tasks)
      ? ({ ...(parsed.tasks as Record<string, string>) } as Record<
          string,
          string
        >)
      : {};
  if (
    typeof tasks.test === "string" &&
    /\bindex_test\.ts\s*$/.test(tasks.test)
  ) {
    tasks.test = tasks.test.replace(/\bindex_test\.ts\s*$/, ".");
    parsed.tasks = tasks;
    changed = true;
  }
  return changed ? `${JSON.stringify(parsed, null, 2)}\n` : source;
}

export async function planTestScaffold(options: {
  cwd?: string;
  functionName?: string;
  receipt: RunFrictionReceiptV1;
  runner?: "deno" | "vitest";
  out?: string;
  lockfile?: string;
}): Promise<TestScaffoldPlan> {
  const cwd = options.cwd ?? process.cwd();
  const functionName = options.functionName ?? "mcp";
  let projectRoot: string;
  let hasSupabase = false;
  try {
    projectRoot = await findSupabaseProject(cwd);
    hasSupabase = true;
  } catch {
    try {
      projectRoot = await findPackageProject(cwd);
    } catch {
      projectRoot = resolve(cwd);
    }
  }

  const runner: "deno" | "vitest" =
    options.runner ?? (hasSupabase ? "deno" : "vitest");
  const lockfilePath = resolveLockfilePath(projectRoot, options.lockfile);
  const inputSkeletons = await loadInputSkeletonsFromLockfile(lockfilePath);

  const exported = exportRunAsContractTest(options.receipt, {
    runner,
    inputSkeletons,
  });

  const outPath = options.out
    ? isAbsolute(options.out)
      ? options.out
      : resolve(projectRoot, options.out)
    : runner === "deno"
      ? join(
          projectRoot,
          "supabase",
          "functions",
          functionName,
          "journeys",
          exported.filename,
        )
      : join(projectRoot, "test", "journeys", exported.filename);

  const files: PlannedScaffoldFile[] = [];
  const exists = await pathExists(outPath);
  files.push({
    path: outPath,
    relativePath: relative(projectRoot, outPath) || outPath,
    status: exists ? "conflict" : "create",
    content: exported.code,
  });

  if (runner === "deno") {
    const denoJsonPath = join(
      projectRoot,
      "supabase",
      "functions",
      functionName,
      "deno.json",
    );
    if (await pathExists(denoJsonPath)) {
      const current = await readFile(denoJsonPath, "utf8");
      const upgraded = upgradeLegacyDenoConfig(current);
      if (upgraded !== current) {
        files.push({
          path: denoJsonPath,
          relativePath: relative(projectRoot, denoJsonPath),
          status: "update",
          content: upgraded,
        });
      }
    }
  }

  return Object.freeze({
    projectRoot,
    runner,
    outPath,
    receipt: options.receipt,
    files: Object.freeze(files),
    code: exported.code,
  });
}

export async function runTestScaffold(options: {
  cwd?: string;
  functionName?: string;
  fromReceipt?: string;
  steps?: readonly string[];
  runner?: "deno" | "vitest";
  out?: string;
  lockfile?: string;
  plan?: boolean;
  yes?: boolean;
  json?: boolean;
  isTTY?: boolean;
  readStdin?: () => Promise<string>;
  confirmWrite?: (question: string) => Promise<boolean>;
}): Promise<{ readonly report: TestScaffoldReport; readonly exitCode: 0 | 1 }> {
  let receipt: RunFrictionReceiptV1;
  if (options.fromReceipt) {
    let rawText: string;
    if (options.fromReceipt === "-") {
      if (!options.readStdin) {
        throw new Error("Standard input is unavailable for --from-receipt -.");
      }
      rawText = await options.readStdin();
    } else {
      const filePath = resolve(
        options.cwd ?? process.cwd(),
        options.fromReceipt,
      );
      rawText = await readFile(filePath, "utf8");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new Error("--from-receipt must contain valid JSON.");
    }
    receipt = validateRunFrictionReceipt(parsed);
  } else if (options.steps && options.steps.length > 0) {
    receipt = receiptFromStepsShorthand(options.steps);
  } else {
    throw new Error(
      "Pass --from-receipt <path|-> or --steps <cap1,cap2,...> to scaffold a journey contract test.",
    );
  }

  const plan = await planTestScaffold({
    cwd: options.cwd,
    functionName: options.functionName,
    receipt,
    runner: options.runner,
    out: options.out,
    lockfile: options.lockfile,
  });

  const fileSummary = plan.files.map((file) => ({
    path: file.relativePath,
    status: file.status,
  }));
  const relOut = relative(plan.projectRoot, plan.outPath) || plan.outPath;

  if (plan.files.some((file) => file.status === "conflict")) {
    return {
      exitCode: 1,
      report: Object.freeze({
        schemaVersion: 1,
        command: "test scaffold",
        status: "conflict",
        runner: plan.runner,
        outPath: relOut,
        files: fileSummary,
        receipt: plan.receipt,
      }),
    };
  }

  if (options.plan) {
    return {
      exitCode: 0,
      report: Object.freeze({
        schemaVersion: 1,
        command: "test scaffold",
        status: "planned",
        runner: plan.runner,
        outPath: relOut,
        files: fileSummary,
        receipt: plan.receipt,
        nextCommand: `npx chumbo test scaffold --runner ${plan.runner} --out ${relOut} --yes${options.json ? " --json" : ""}`,
      }),
    };
  }

  if (!options.yes) {
    if (options.json) {
      return {
        exitCode: 0,
        report: Object.freeze({
          schemaVersion: 1,
          command: "test scaffold",
          status: "needs_confirmation",
          runner: plan.runner,
          outPath: relOut,
          files: fileSummary,
          receipt: plan.receipt,
          nextCommand: `npx chumbo test scaffold --runner ${plan.runner} --out ${relOut} --yes --json`,
        }),
      };
    }
    if (options.isTTY && options.confirmWrite) {
      const approved = await options.confirmWrite(
        `Write ${relOut} (${plan.files.length} file(s))?`,
      );
      if (!approved) {
        throw new Error(
          "No files changed. Re-run with --yes for non-interactive use.",
        );
      }
    } else {
      throw new Error(
        "No files changed. Re-run with --yes for non-interactive use.",
      );
    }
  }

  for (const file of plan.files) {
    if (file.status === "unchanged") continue;
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, "utf8");
  }

  return {
    exitCode: 0,
    report: Object.freeze({
      schemaVersion: 1,
      command: "test scaffold",
      status: "complete",
      runner: plan.runner,
      outPath: relOut,
      files: fileSummary,
      receipt: plan.receipt,
    }),
  };
}
