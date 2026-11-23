import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunTimeline, UnlinkedCallGroup } from "../src/insights.js";
import { buildLockedSurfaceEntry } from "../src/surface-diff.js";
import { writeSurfaceLockfile } from "../src/surface-lock.js";
import {
  buildRunFrictionReceipt,
  exportRunAsContractTest,
  runTestScaffold,
  validateRunFrictionReceipt,
} from "../src/test-scaffold.js";

const SAMPLE_FRICTION_RUN: RunTimeline = {
  runId: "run_sample_avery_2",
  startedAt: "2026-08-29T18:10:00.000Z",
  endedAt: "2026-08-29T18:10:15.000Z",
  totalDurationMs: 1_940,
  callCount: 14,
  hasFriction: true,
  hasSlowStep: false,
  errorCount: 1,
  inputRequiredCount: 0,
  clientLabel: "Claude Desktop */ console.log('pwned'); /*",
  steps: [
    {
      kind: "loop",
      label: "Back and forth: Search notes → Archive note (×7)",
      capabilityNames: ["search_notes", "archive_note"],
      capabilityKinds: ["tool", "tool"],
      callCount: 14,
      cycleCount: 7,
      startedAt: "2026-08-29T18:10:00.000Z",
      endedAt: "2026-08-29T18:10:15.000Z",
      durationMs: 1_940,
      outcome: "tool-error",
      friction: true,
      slow: false,
      inputRequired: false,
      errorCodes: ["permission_denied"],
    },
  ],
};

const SAMPLE_MULTI_KIND_RUN: RunTimeline = {
  runId: "run_sample_avery_1",
  startedAt: "2026-08-30T14:40:00.000Z",
  endedAt: "2026-08-30T14:40:12.000Z",
  totalDurationMs: 464,
  callCount: 4,
  hasFriction: false,
  hasSlowStep: false,
  errorCount: 0,
  inputRequiredCount: 0,
  clientLabel: "Claude Desktop",
  steps: [
    {
      kind: "call",
      label: "Workspace context",
      capabilityNames: ["workspace_context"],
      capabilityKinds: ["resource"],
      callCount: 1,
      startedAt: "2026-08-30T14:40:00.000Z",
      endedAt: "2026-08-30T14:40:00.000Z",
      durationMs: 92,
      outcome: "success",
      friction: false,
      slow: false,
      inputRequired: false,
      errorCodes: [],
    },
    {
      kind: "call",
      label: "Review queue UI",
      capabilityNames: ["ui://review/queue.html"],
      capabilityKinds: ["resource"],
      callCount: 1,
      startedAt: "2026-08-30T14:40:02.000Z",
      endedAt: "2026-08-30T14:40:02.000Z",
      durationMs: 40,
      outcome: "success",
      friction: false,
      slow: false,
      inputRequired: false,
      errorCodes: [],
    },
    {
      kind: "call",
      label: "Weekly review",
      capabilityNames: ["weekly_review"],
      capabilityKinds: ["prompt"],
      callCount: 1,
      startedAt: "2026-08-30T14:40:04.000Z",
      endedAt: "2026-08-30T14:40:04.000Z",
      durationMs: 110,
      outcome: "success",
      friction: false,
      slow: false,
      inputRequired: false,
      errorCodes: [],
    },
    {
      kind: "call",
      label: "Search notes",
      capabilityNames: ["search_notes"],
      capabilityKinds: ["tool"],
      callCount: 1,
      startedAt: "2026-08-30T14:40:08.000Z",
      endedAt: "2026-08-30T14:40:08.000Z",
      durationMs: 148,
      outcome: "success",
      friction: false,
      slow: false,
      inputRequired: false,
      errorCodes: [],
    },
  ],
};

describe("test-scaffold and Insights RunTimeline bridge", () => {
  it("collapses ×7 loops into TARGET_MAX_CALLS = 2, escapes malicious clientLabel, and wires createTestAuthHarness", () => {
    const exported = exportRunAsContractTest(SAMPLE_FRICTION_RUN, {
      runner: "vitest",
    });
    expect(exported.receipt.targetCallBudget).toBe(2);
    expect(exported.receipt.observedCallCount).toBe(14);
    expect(exported.receipt.observedErrorCount).toBe(1);
    expect(exported.code).toContain("const TARGET_MAX_CALLS = 2;");
    expect(exported.code).toContain("createTestAuthHarness");
    expect(exported.code).toContain("SUPABASE_JWKS");
    expect(exported.code).toContain("CHUMBO_TEST_USER_TOKEN");
    expect(exported.code).toContain('caller.callTool("search_notes"');
    expect(exported.code).toContain('caller.callTool("archive_note"');
    expect(exported.code).not.toContain("*/ console.log");
  });

  it("handles bare resource names via listResources(), scheme URIs directly, prompts via exchange(), and UnlinkedCallGroup bounds", () => {
    const denoExport = exportRunAsContractTest(SAMPLE_MULTI_KIND_RUN, {
      runner: "deno",
    });
    expect(denoExport.filename).toBe("run_sample_avery_1_test.ts");
    expect(denoExport.code).toContain("Deno.test(");
    expect(denoExport.code).toContain("caller.listResources()");
    expect(denoExport.code).toContain('r.name === "workspace_context"');
    expect(denoExport.code).toContain(
      'caller.readResource("ui://review/queue.html")',
    );
    expect(denoExport.code).toContain(
      'caller.exchange("prompts/get", { name: "weekly_review"',
    );
    expect(denoExport.code).toContain(
      "utf8.encode(JSON.stringify(step1)).byteLength <= RESULT_BUDGET_BYTES",
    );

    const unlinked: UnlinkedCallGroup = {
      windowStart: "2026-08-28T11:00:00.000Z",
      windowEnd: "2026-08-28T11:30:00.000Z",
      callCount: 5,
      rejectedHandleCount: 1,
      totalDurationMs: 12_000,
      hasFriction: true,
      hasSlowStep: true,
      steps: [
        {
          kind: "loop",
          label: "Repeated: Archive note (×3)",
          capabilityNames: ["archive_note"],
          capabilityKinds: ["tool"],
          callCount: 3,
          cycleCount: 3,
          startedAt: "2026-08-28T11:01:00.000Z",
          endedAt: "2026-08-28T11:02:00.000Z",
          durationMs: 12_000,
          outcome: "tool-error",
          friction: true,
          slow: true,
          inputRequired: false,
          errorCodes: ["permission_denied"],
        },
      ],
    };
    const receipt = buildRunFrictionReceipt(unlinked);
    expect(receipt.sourceKind).toBe("unlinked-window");
    expect(receipt.clientLabel).toBeNull();
    expect(receipt.observedErrorCount).toBe(1);
    expect(receipt.targetCallBudget).toBe(1);
    expect(validateRunFrictionReceipt(receipt)).toEqual(receipt);
  });

  it("enriches input skeletons from mcp-surface.lock.json, upgrades legacy deno.json, and halts on file conflict", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "chumbo-scaffold-test-"));
    try {
      const fnDir = join(tempRoot, "supabase", "functions", "mcp");
      await mkdir(fnDir, { recursive: true });
      await writeFile(
        join(tempRoot, "supabase", "config.toml"),
        'project_id = "scaffold-test"\n',
      );
      await writeFile(
        join(fnDir, "deno.json"),
        `${JSON.stringify(
          {
            imports: { chumbo: "npm:chumbo@0.14.0" },
            tasks: {
              check: "deno check index.ts capabilities.ts",
              test: "deno test --allow-env --allow-net index_test.ts",
            },
          },
          null,
          2,
        )}\n`,
      );

      const locked = await buildLockedSurfaceEntry({
        functionName: "mcp",
        serverName: "scaffold-test",
        tools: [
          {
            name: "search_notes",
            description: "Search notes.",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
                limit: { type: "integer", default: 10 },
              },
            },
            annotations: { readOnlyHint: true },
          },
        ],
      });
      await writeSurfaceLockfile(join(tempRoot, "mcp-surface.lock.json"), {
        lockfileVersion: 1,
        surfaces: { mcp: locked },
      });

      const receiptPath = join(tempRoot, "run.receipt.json");
      await writeFile(
        receiptPath,
        JSON.stringify(buildRunFrictionReceipt(SAMPLE_FRICTION_RUN)),
      );

      // 1. --json without --yes -> needs_confirmation (no writes)
      const needsConfirm = await runTestScaffold({
        cwd: tempRoot,
        fromReceipt: receiptPath,
        json: true,
      });
      expect(needsConfirm.exitCode).toBe(0);
      expect(needsConfirm.report.status).toBe("needs_confirmation");
      expect(needsConfirm.report.files.map((f) => f.status)).toEqual([
        "create",
        "update",
      ]);

      // 2. --yes writes journey test + upgrades legacy deno.json
      const applied = await runTestScaffold({
        cwd: tempRoot,
        fromReceipt: receiptPath,
        yes: true,
        json: true,
      });
      expect(applied.exitCode).toBe(0);
      expect(applied.report.status).toBe("complete");

      const writtenTest = await readFile(
        join(tempRoot, applied.report.outPath),
        "utf8",
      );
      expect(writtenTest).toContain('"query": ""');
      expect(writtenTest).toContain('"limit": 10');

      const upgradedDeno = JSON.parse(
        await readFile(join(fnDir, "deno.json"), "utf8"),
      ) as { imports: Record<string, string>; tasks: Record<string, string> };
      expect(upgradedDeno.imports["chumbo/testing"]).toBe(
        "npm:chumbo@0.14.0/testing",
      );
      expect(upgradedDeno.tasks.test).toBe(
        "deno test --allow-env --allow-net .",
      );

      // 3. Re-running on existing file returns conflict (exit 1) and preserves edits
      const conflict = await runTestScaffold({
        cwd: tempRoot,
        fromReceipt: receiptPath,
        yes: true,
        json: true,
      });
      expect(conflict.exitCode).toBe(1);
      expect(conflict.report.status).toBe("conflict");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
