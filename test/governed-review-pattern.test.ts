import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildHubUrl,
  createSupabaseMcp,
  defineMcpApp,
  errorResult,
  idempotencyConflictResult,
  MCP_APP_MIME_TYPE,
  MCP_APP_PRESENTATION_PLACEHOLDER,
  MCP_APP_PRESENTATION_SCRIPT_ID,
  observeResource,
  registerMcpApp,
  renderResult,
  requestIdFieldSchema,
  requireObserved,
  resolveAppPresentation,
  structuredResult,
  SupabaseMcpStateConflictError,
  SupabaseMcpStateMissingError,
  SupabaseMcpStateUnavailableError,
  type JsonValue,
  type SupabaseMcpState,
  type SupabaseMcpStateValue,
} from "../src/index.js";
import { createMcpTestClient, createTestAuthHarness } from "../src/testing.js";

const WORKSPACE_ACME = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_OTHER = "22222222-2222-4222-8222-222222222222";
const RECORD_ACME_1 = "33333333-3333-4333-8333-333333333331";
const RECORD_OTHER_1 = "44444444-4444-4444-8444-444444444441";
const RECORD_MISSING = "55555555-5555-4555-8555-555555555555";

interface ReferenceRecord {
  readonly id: string;
  readonly workspaceId: string;
  title: string;
  summary: string;
  version: number;
}

interface ReviewFlag {
  readonly id: string;
  readonly workspaceId: string;
  readonly recordId: string;
  readonly flaggedBy: string;
  readonly flagRequestId: string;
  readonly reason:
    | "inaccurate"
    | "outdated"
    | "sensitive"
    | "duplicate"
    | "other";
  readonly note: string;
  status: "open" | "resolved" | "dismissed";
  decidedBy: string | null;
  decisionNote: string;
  decisionRequestId: string | null;
  revision: number;
}

function createInMemoryState(): {
  state: SupabaseMcpState;
  failNextPut(): void;
} {
  const entries = new Map<string, { value: JsonValue; revision: number }>();
  let shouldFailNextPut = false;

  const keyFor = (namespace: string, key: string): string =>
    `${namespace}\u0000${key}`;

  const defaultExpiresAt = new Date(Date.now() + 900_000).toISOString();

  const state: SupabaseMcpState = {
    async get<T extends JsonValue = JsonValue>(
      namespace: string,
      key: string,
    ): Promise<SupabaseMcpStateValue<T> | null> {
      const stored = entries.get(keyFor(namespace, key));
      if (!stored) return null;
      return {
        value: stored.value as T,
        revision: stored.revision,
        expiresAt: defaultExpiresAt,
      };
    },
    async put<T extends JsonValue = JsonValue>(
      namespace: string,
      key: string,
      options: {
        readonly value: T;
        readonly expectedRevision: number | null;
        readonly ttlSeconds?: number;
      },
    ): Promise<SupabaseMcpStateValue<T>> {
      if (shouldFailNextPut) {
        shouldFailNextPut = false;
        throw new SupabaseMcpStateUnavailableError();
      }
      const compound = keyFor(namespace, key);
      const current = entries.get(compound);
      if (options.expectedRevision === null) {
        if (current) {
          throw new SupabaseMcpStateConflictError(current.revision);
        }
        const next = { value: options.value as JsonValue, revision: 1 };
        entries.set(compound, next);
        return {
          value: options.value,
          revision: 1,
          expiresAt: defaultExpiresAt,
        };
      }
      if (!current) {
        throw new SupabaseMcpStateMissingError();
      }
      if (current.revision !== options.expectedRevision) {
        throw new SupabaseMcpStateConflictError(current.revision);
      }
      const nextRevision = current.revision + 1;
      entries.set(compound, {
        value: options.value as JsonValue,
        revision: nextRevision,
      });
      return {
        value: options.value,
        revision: nextRevision,
        expiresAt: defaultExpiresAt,
      };
    },
    async delete(
      namespace: string,
      key: string,
      options: { readonly expectedRevision: number },
    ): Promise<boolean> {
      const compound = keyFor(namespace, key);
      const current = entries.get(compound);
      if (!current) return false;
      if (current.revision !== options.expectedRevision) {
        throw new SupabaseMcpStateConflictError(current.revision);
      }
      entries.delete(compound);
      return true;
    },
  };

  return {
    state,
    failNextPut() {
      shouldFailNextPut = true;
    },
  };
}

describe("governed review pattern: contributor flag_for_review -> admin ui:// review queue", () => {
  it("enforces scope gates, no-existence-leak RLS, idempotency, presentation injection, auto-CSP, and revision CAS", async () => {
    const authHarness = await createTestAuthHarness({
      supabaseUrl: "https://acme-ref.supabase.co",
      resourceUrl: "https://acme-ref.supabase.co/functions/v1/mcp",
    });

    const memberships = new Map<
      string,
      { readonly workspaceId: string; readonly role: "contributor" | "admin" }
    >([
      [
        "user-contributor",
        { workspaceId: WORKSPACE_ACME, role: "contributor" },
      ],
      ["user-admin", { workspaceId: WORKSPACE_ACME, role: "admin" }],
      ["user-other-admin", { workspaceId: WORKSPACE_OTHER, role: "admin" }],
    ]);

    const records = new Map<string, ReferenceRecord>([
      [
        RECORD_ACME_1,
        {
          id: RECORD_ACME_1,
          workspaceId: WORKSPACE_ACME,
          title: "Q4 Retention Policy",
          summary: "Draft policy summary.",
          version: 1,
        },
      ],
      [
        RECORD_OTHER_1,
        {
          id: RECORD_OTHER_1,
          workspaceId: WORKSPACE_OTHER,
          title: "Confidential Other Tenant Record",
          summary: "Private summary.",
          version: 1,
        },
      ],
    ]);

    const flags: ReviewFlag[] = [];
    let flagCounter = 0;

    const reviewQueueApp = defineMcpApp({
      name: "review-queue",
      uri: "ui://acme/review-queue.html",
      title: (p) => `${p.productName} Review Queue`,
      description: "Interactive admin review queue for flagged records.",
      scopes: ["review:read"],
      html: [
        "<!doctype html>",
        "<html>",
        "<head>",
        `<script id="${MCP_APP_PRESENTATION_SCRIPT_ID}" type="application/json">${MCP_APP_PRESENTATION_PLACEHOLDER}</script>`,
        "</head>",
        "<body><main><section data-supa-mcp-scroll></section></main></body>",
        "</html>",
      ].join("\n"),
    });

    const presentation = resolveAppPresentation({
      productName: "Acme Workspace",
      hubUrl: "https://acme.example.com",
      brand: {
        logoUrl: "https://cdn.acme.example.com/logo.svg",
      },
    });

    const mcpApp = createSupabaseMcp({
      server: { name: "governed-review-reference", version: "1.0.0" },
      resourceUrl: authHarness.resourceUrl,
      auth: { mode: "oauth", scopes: ["review:flag"] },
      supabase: { env: authHarness.supabaseEnv },
      register(server, ctx) {
        const subject = ctx.subject ?? "";
        const membership = memberships.get(subject);

        // Contributor-accessible flagging tool (model-facing).
        server.withScopes(["review:flag"]).registerTool(
          "flag_for_review",
          {
            description:
              "Flag an accessible workspace record for admin review.",
            inputSchema: z.object({
              record_id: z.string().uuid(),
              reason: z.enum([
                "inaccurate",
                "outdated",
                "sensitive",
                "duplicate",
                "other",
              ]),
              note: z.string().max(2000).default(""),
              request_id: requestIdFieldSchema,
            }),
          },
          async (input) => {
            // Replay or conflict check on (flagged_by, flag_request_id).
            const existing = flags.find(
              (f) =>
                f.flaggedBy === subject && f.flagRequestId === input.request_id,
            );
            if (existing) {
              if (
                existing.recordId !== input.record_id ||
                existing.reason !== input.reason
              ) {
                return idempotencyConflictResult("request_id");
              }
              return structuredResult({
                flag: existing,
                replayed: true,
              });
            }

            // RLS check: record must exist AND belong to the caller's workspace.
            const record = records.get(input.record_id);
            if (
              !membership ||
              !record ||
              record.workspaceId !== membership.workspaceId
            ) {
              return errorResult(
                "not_found: Record not found.",
                "Verify the record_id from a record you can read before retrying.",
              );
            }

            flagCounter += 1;
            const created: ReviewFlag = {
              id: `66666666-6666-4666-8666-66666666660${flagCounter}`,
              workspaceId: record.workspaceId,
              recordId: record.id,
              flaggedBy: subject,
              flagRequestId: input.request_id,
              reason: input.reason,
              note: input.note,
              status: "open",
              decidedBy: null,
              decisionNote: "",
              decisionRequestId: null,
              revision: 1,
            };
            flags.push(created);

            return structuredResult({
              flag: created,
              replayed: false,
            });
          },
        );

        // Admin Review Queue MCP App.
        const queueApp = registerMcpApp(server, reviewQueueApp, {
          presentation,
        });

        queueApp.openTool(
          "open_review_queue",
          {
            description: "Open the workspace interactive review queue.",
            inputSchema: z.object({}),
            risk: "read",
          },
          async () => {
            const visibleFlags =
              membership?.role === "admin"
                ? flags.filter((f) => f.workspaceId === membership.workspaceId)
                : [];
            const items = visibleFlags.map((flag) => ({
              ...flag,
              recordTitle: records.get(flag.recordId)?.title ?? "Unknown",
              recordUrl: buildHubUrl(presentation, `/records/${flag.recordId}`),
            }));
            return renderResult(
              {
                productName: presentation.productName,
                hubUrl: presentation.hubUrl,
                items,
              },
              (data) =>
                `${data.productName} review queue (${data.items.length} item(s)).`,
            );
          },
        );

        queueApp.appTool(
          "decide_review_flag",
          {
            description: "Resolve or dismiss one open review flag.",
            scopes: ["review:decide"],
            risk: "write",
            inputSchema: z.object({
              flag_id: z.string().uuid(),
              decision: z.enum(["resolved", "dismissed"]),
              decision_note: z.string().max(2000).default(""),
              expected_revision: z.number().int().min(1),
              request_id: requestIdFieldSchema,
            }),
          },
          async (input) => {
            if (membership?.role !== "admin") {
              return errorResult(
                "not_found: Review flag not found.",
                "Only workspace admins can decide review flags.",
              );
            }

            const flag = flags.find(
              (f) =>
                f.id === input.flag_id &&
                f.workspaceId === membership.workspaceId,
            );
            if (!flag) {
              return errorResult(
                "not_found: Review flag not found.",
                "Refresh the review queue to inspect open flags.",
              );
            }

            if (flag.decisionRequestId === input.request_id) {
              if (flag.status !== input.decision) {
                return idempotencyConflictResult("request_id");
              }
              return structuredResult({ flag, replayed: true });
            }

            if (flag.revision !== input.expected_revision) {
              return errorResult(
                `state_changed: Review flag revision is ${flag.revision}, expected ${input.expected_revision}.`,
                "Refresh the review queue before submitting another decision.",
              );
            }

            flag.status = input.decision;
            flag.decidedBy = subject;
            flag.decisionNote = input.decision_note;
            flag.decisionRequestId = input.request_id;
            flag.revision += 1;

            return structuredResult({ flag, replayed: false });
          },
        );
      },
    });

    const client = createMcpTestClient(mcpApp, { authHarness });
    const contributor = client.asUser({
      id: "user-contributor",
      email: "contributor@acme.example.com",
      scopes: ["review:flag"],
    });
    const admin = client.asUser({
      id: "user-admin",
      email: "admin@acme.example.com",
      scopes: ["review:flag", "review:read", "review:decide"],
    });
    const otherAdmin = client.asUser({
      id: "user-other-admin",
      email: "admin@other.example.com",
      scopes: ["review:flag", "review:read", "review:decide"],
    });

    // 1. Contributor flags a visible record; retry with same request_id is idempotent.
    const flagRequestId = "77777777-7777-4777-8777-777777777701";
    const firstFlag = await contributor.callTool<{
      flag: ReviewFlag;
      replayed: boolean;
    }>("flag_for_review", {
      record_id: RECORD_ACME_1,
      reason: "outdated",
      note: "Retention window changed to 90 days.",
      request_id: flagRequestId,
    });
    expect(firstFlag.isError).not.toBe(true);
    expect(firstFlag.structuredContent?.replayed).toBe(false);
    expect(firstFlag.structuredContent?.flag.status).toBe("open");
    expect(firstFlag.structuredContent?.flag.revision).toBe(1);
    const createdFlagId = firstFlag.structuredContent!.flag.id;

    const replayFlag = await contributor.callTool<{
      flag: ReviewFlag;
      replayed: boolean;
    }>("flag_for_review", {
      record_id: RECORD_ACME_1,
      reason: "outdated",
      note: "Retention window changed to 90 days.",
      request_id: flagRequestId,
    });
    expect(replayFlag.isError).not.toBe(true);
    expect(replayFlag.structuredContent?.replayed).toBe(true);
    expect(replayFlag.structuredContent?.flag.id).toBe(createdFlagId);
    expect(flags).toHaveLength(1);

    // 2. Reusing request_id with different reason returns idempotency_conflict.
    const conflictFlag = await contributor.callTool("flag_for_review", {
      record_id: RECORD_ACME_1,
      reason: "sensitive",
      note: "Changed reason on reused key.",
      request_id: flagRequestId,
    });
    expect(conflictFlag.isError).toBe(true);
    expect(conflictFlag.text).toContain("idempotency_conflict:");

    // 3. Flagging an unreadable cross-tenant record and a nonexistent record
    // produce the exact same not_found error (no existence leak).
    const crossTenantFlag = await contributor.callTool("flag_for_review", {
      record_id: RECORD_OTHER_1,
      reason: "inaccurate",
      request_id: "77777777-7777-4777-8777-777777777702",
    });
    const missingRecordFlag = await contributor.callTool("flag_for_review", {
      record_id: RECORD_MISSING,
      reason: "inaccurate",
      request_id: "77777777-7777-4777-8777-777777777703",
    });
    expect(crossTenantFlag.isError).toBe(true);
    expect(missingRecordFlag.isError).toBe(true);
    expect(crossTenantFlag.text).toContain("not_found:");
    expect(crossTenantFlag.text).toBe(missingRecordFlag.text);

    // 4. Contributor cannot discover or invoke admin resource or admin tools.
    expect(await contributor.listResources()).toEqual([]);
    expect((await contributor.listTools()).map((t) => t.name)).toEqual([
      "flag_for_review",
    ]);

    const contributorRead = await contributor.exchange(
      "resources/read",
      { uri: "ui://acme/review-queue.html" },
      { headers: { "mcp-name": "ui://acme/review-queue.html" } },
    );
    expect((contributorRead.body as { error?: unknown })?.error).toBeDefined();

    const contributorOpen = await contributor.exchange(
      "tools/call",
      {
        name: "open_review_queue",
        arguments: {},
      },
      { headers: { "mcp-name": "open_review_queue" } },
    );
    expect((contributorOpen.body as { error?: unknown })?.error).toBeDefined();

    const contributorDecide = await contributor.exchange(
      "tools/call",
      {
        name: "decide_review_flag",
        arguments: {
          flag_id: createdFlagId,
          decision: "resolved",
          expected_revision: 1,
          request_id: "77777777-7777-4777-8777-777777777704",
        },
      },
      { headers: { "mcp-name": "decide_review_flag" } },
    );
    expect(
      (contributorDecide.body as { error?: unknown })?.error,
    ).toBeDefined();

    // 5. Admin opens the review queue and reads the ui:// HTML resource with
    // injected presentation and auto-derived CSP logo origin.
    const queueResult = await admin.callTool<{
      productName: string;
      hubUrl: string;
      items: Array<ReviewFlag & { recordUrl: string }>;
    }>("open_review_queue", {});
    expect(queueResult.isError).not.toBe(true);
    expect(queueResult.text).toContain(
      "Acme Workspace review queue (1 item(s)).",
    );
    expect(queueResult.structuredContent?.items).toHaveLength(1);
    expect(queueResult.structuredContent?.items[0]?.recordUrl).toBe(
      `https://acme.example.com/records/${RECORD_ACME_1}`,
    );

    const htmlResource = await admin.readResource(
      "ui://acme/review-queue.html",
      { headers: { "mcp-name": "ui://acme/review-queue.html" } },
    );
    const firstContent = htmlResource.contents[0];
    expect(firstContent?.mimeType).toBe(MCP_APP_MIME_TYPE);
    expect(htmlResource.text).toContain('"productName":"Acme Workspace"');
    expect(htmlResource.text).toContain('"hubUrl":"https://acme.example.com"');
    const resourceMeta = firstContent?._meta as
      | { ui?: { csp?: { resourceDomains?: string[] } } }
      | undefined;
    expect(resourceMeta?.ui?.csp?.resourceDomains).toContain(
      "https://cdn.acme.example.com",
    );

    // 6. Cross-workspace admin sees zero Acme flags and cannot decide Acme's flag.
    const otherQueue = await otherAdmin.callTool<{ items: ReviewFlag[] }>(
      "open_review_queue",
      {},
    );
    expect(otherQueue.structuredContent?.items).toHaveLength(0);

    const otherDecide = await otherAdmin.callTool("decide_review_flag", {
      flag_id: createdFlagId,
      decision: "dismissed",
      expected_revision: 1,
      request_id: "77777777-7777-4777-8777-777777777705",
    });
    expect(otherDecide.isError).toBe(true);
    expect(otherDecide.text).toContain("not_found:");

    // 7. Workspace admin resolves the flag, retries idempotently, rejects
    // mismatched decision on same request_id, and rejects stale expected_revision.
    const decideReqId = "77777777-7777-4777-8777-777777777706";
    const resolved = await admin.callTool<{
      flag: ReviewFlag;
      replayed: boolean;
    }>("decide_review_flag", {
      flag_id: createdFlagId,
      decision: "resolved",
      decision_note: "Updated retention window to 90 days.",
      expected_revision: 1,
      request_id: decideReqId,
    });
    expect(resolved.isError).not.toBe(true);
    expect(resolved.structuredContent?.replayed).toBe(false);
    expect(resolved.structuredContent?.flag.status).toBe("resolved");
    expect(resolved.structuredContent?.flag.revision).toBe(2);

    const replayedDecision = await admin.callTool<{
      flag: ReviewFlag;
      replayed: boolean;
    }>("decide_review_flag", {
      flag_id: createdFlagId,
      decision: "resolved",
      decision_note: "Updated retention window to 90 days.",
      expected_revision: 1,
      request_id: decideReqId,
    });
    expect(replayedDecision.isError).not.toBe(true);
    expect(replayedDecision.structuredContent?.replayed).toBe(true);
    expect(replayedDecision.structuredContent?.flag.revision).toBe(2);

    const conflictDecision = await admin.callTool("decide_review_flag", {
      flag_id: createdFlagId,
      decision: "dismissed",
      expected_revision: 1,
      request_id: decideReqId,
    });
    expect(conflictDecision.isError).toBe(true);
    expect(conflictDecision.text).toContain("idempotency_conflict:");

    const staleDecision = await admin.callTool("decide_review_flag", {
      flag_id: createdFlagId,
      decision: "dismissed",
      expected_revision: 1,
      request_id: "77777777-7777-4777-8777-777777777707",
    });
    expect(staleDecision.isError).toBe(true);
    expect(staleDecision.text).toContain("state_changed:");
  });
});

describe("observation-before-action: observeResource and requireObserved", () => {
  it("enforces read -> observe -> CAS mutation, rejects blind/stale writes, and recovers safely when Step 3 fails", async () => {
    const authHarness = await createTestAuthHarness({
      supabaseUrl: "https://acme-obs.supabase.co",
      resourceUrl: "https://acme-obs.supabase.co/functions/v1/mcp",
    });

    const record: ReferenceRecord = {
      id: RECORD_ACME_1,
      workspaceId: WORKSPACE_ACME,
      title: "Q4 Retention Policy",
      summary: "Version 1 summary.",
      version: 1,
    };

    const { state, failNextPut } = createInMemoryState();

    const mcpApp = createSupabaseMcp({
      server: { name: "observation-reference", version: "1.0.0" },
      resourceUrl: authHarness.resourceUrl,
      auth: { mode: "oauth", scopes: ["records:read"] },
      supabase: { env: authHarness.supabaseEnv },
      register(server) {
        server.withScopes(["records:read"]).registerTool(
          "read_record",
          {
            description:
              "Read the authoritative record and record an observation.",
            inputSchema: z.object({ record_id: z.string().uuid() }),
          },
          async ({ record_id }) => {
            if (record_id !== record.id) {
              return errorResult("not_found: Record not found.");
            }
            await observeResource(state, {
              namespace: "records",
              resourceKey: `workspace:${record.workspaceId}:record:${record.id}`,
              resourceVersion: record.version,
              scope: "full",
              ttlSeconds: 900,
            });
            return structuredResult({
              record: { ...record },
            });
          },
        );

        server.withScopes(["records:write"]).registerTool(
          "update_record",
          {
            description: "Update a record after observing its current version.",
            inputSchema: z.object({
              record_id: z.string().uuid(),
              summary: z.string().min(1),
            }),
          },
          async ({ record_id, summary }) => {
            const guarded = await requireObserved(state, {
              namespace: "records",
              resourceKey: `workspace:${record.workspaceId}:record:${record_id}`,
              readToolName: "read_record",
              verifyScope: (receipt) => receipt.scope === "full",
              async mutate({ observedVersion }) {
                if (record_id !== record.id) {
                  return {
                    status: "rejected",
                    reason: "not_found",
                    error: errorResult("not_found: Record not found."),
                  };
                }
                if (record.version !== observedVersion) {
                  return {
                    status: "rejected",
                    reason: "stale_version",
                    error: errorResult(
                      `state_changed: Record version is ${record.version}, observed ${observedVersion}.`,
                      "Call read_record before retrying.",
                    ),
                  };
                }
                record.summary = summary;
                record.version += 1;
                return {
                  status: "committed",
                  value: { ...record },
                  nextVersion: record.version,
                };
              },
            });

            if (!guarded.ok) {
              return guarded.error;
            }
            return structuredResult({
              record: guarded.value,
              receiptAdvanced: guarded.receiptAdvanced,
              rereadRequired: guarded.rereadRequired,
            });
          },
        );
      },
    });

    const client = createMcpTestClient(mcpApp, { authHarness });
    const editor = client.asUser({
      id: "user-editor",
      email: "editor@acme.example.com",
      scopes: ["records:read", "records:write"],
    });

    // 1. Blind mutation before reading fails closed and does not mutate the record.
    const blindWrite = await editor.callTool("update_record", {
      record_id: RECORD_ACME_1,
      summary: "Blind overwrite attempt.",
    });
    expect(blindWrite.isError).toBe(true);
    expect(blindWrite.text).toContain("read_record");
    expect(record.version).toBe(1);

    // 2. Read records observation; guarded update commits 1 -> 2 and advances receipt.
    const read1 = await editor.callTool("read_record", {
      record_id: RECORD_ACME_1,
    });
    expect(read1.isError).not.toBe(true);

    const write1 = await editor.callTool<{
      record: ReferenceRecord;
      receiptAdvanced: boolean;
      rereadRequired: boolean;
    }>("update_record", {
      record_id: RECORD_ACME_1,
      summary: "Version 2 summary.",
    });
    expect(write1.isError).not.toBe(true);
    expect(write1.structuredContent?.record.version).toBe(2);
    expect(write1.structuredContent?.receiptAdvanced).toBe(true);
    expect(write1.structuredContent?.rereadRequired).toBe(false);

    // 3. Out-of-band concurrent edit bumps version 2 -> 3; guarded write rejects stale version.
    record.summary = "Concurrent update from another session.";
    record.version = 3;

    const staleWrite = await editor.callTool("update_record", {
      record_id: RECORD_ACME_1,
      summary: "Stale write attempt.",
    });
    expect(staleWrite.isError).toBe(true);
    expect(staleWrite.text).toContain("state_changed:");
    expect(record.version).toBe(3);

    // 4. Re-read refreshes receipt to version 3; simulate Step 3 state outage after
    // Step 2 commits 3 -> 4. Must return ok with rereadRequired: true (safe false negative).
    const read2 = await editor.callTool("read_record", {
      record_id: RECORD_ACME_1,
    });
    expect(read2.isError).not.toBe(true);

    failNextPut();
    const step3OutageWrite = await editor.callTool<{
      record: ReferenceRecord;
      receiptAdvanced: boolean;
      rereadRequired: boolean;
    }>("update_record", {
      record_id: RECORD_ACME_1,
      summary: "Version 4 summary.",
    });
    expect(step3OutageWrite.isError).not.toBe(true);
    expect(step3OutageWrite.structuredContent?.record.version).toBe(4);
    expect(step3OutageWrite.structuredContent?.receiptAdvanced).toBe(false);
    expect(step3OutageWrite.structuredContent?.rereadRequired).toBe(true);

    // Next write without rereading still fails closed because the receipt stayed at version 3.
    const followUpWithoutReread = await editor.callTool("update_record", {
      record_id: RECORD_ACME_1,
      summary: "Version 5 without reread.",
    });
    expect(followUpWithoutReread.isError).toBe(true);
    expect(followUpWithoutReread.text).toContain("state_changed:");
    expect(record.version).toBe(4);
  });
});
