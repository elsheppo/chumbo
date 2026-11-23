import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { collectionResult } from "../src/collections.js";
import { observeResource, requireObserved } from "../src/observations.js";
import { consumePreview, mintPreview, previewLimits } from "../src/previews.js";
import { errorResult, structuredResult, textResult } from "../src/results.js";
import { createSupabaseMcpInternal } from "../src/runtime.js";
import {
  mcpSessionId,
  registerUseWorkspace,
  resolveActiveWorkspace,
  withWorkspaceEcho,
  type WorkspaceDescriptor,
} from "../src/session-state.js";
import { jsonRpcPayloadFromResponseText } from "../src/transport.js";
import {
  createSupabaseMcpStateFactory,
  SupabaseMcpStateUnavailableError,
} from "../src/state.js";
import type {
  RuntimeDependencies,
  SupabaseMcpAuthentication,
  SupabaseMcpContext,
  SupabaseMcpDurableStateOptions,
  SupabaseMcpState,
  VerifiedSupabaseIdentity,
} from "../src/types.js";

const HMAC_KEY = "state-wrappers-test-hmac-key-thirty-two-bytes-long";

interface StoredState {
  valueText: string;
  revision: number;
  expiresAt: number;
}

class MemoryStateBackend {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  readonly rows = new Map<string, StoredState>();
  now = Date.parse("2026-11-23T12:00:00.000Z");
  failOnRpc?: string;

  readonly client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      this.calls.push({ name, args });
      if (this.failOnRpc === name) {
        return { data: null, error: new Error(`injected failure on ${name}`) };
      }
      return { data: [this.execute(name, args)], error: null };
    },
  } as unknown as SupabaseClient<unknown>;

  private locator(args: Record<string, unknown>): string {
    return [args.p_namespace, args.p_caller_key, args.p_object_key].join("|");
  }

  private current(locator: string): StoredState | undefined {
    const row = this.rows.get(locator);
    if (!row || row.expiresAt <= this.now) {
      this.rows.delete(locator);
      return undefined;
    }
    return row;
  }

  private execute(name: string, args: Record<string, unknown>) {
    const locator = this.locator(args);
    const current = this.current(locator);
    if (name === "supa_mcp_state_get") {
      return current
        ? {
            status: "found",
            value_text: current.valueText,
            revision: current.revision,
            expires_at: new Date(current.expiresAt).toISOString(),
          }
        : undefined;
    }
    if (name === "supa_mcp_state_put") {
      const expected = args.p_expected_revision as number | null;
      if (expected === null) {
        if (current) return { status: "conflict", revision: current.revision };
        const next = {
          valueText: String(args.p_value_text),
          revision: 1,
          expiresAt: this.now + Number(args.p_ttl_seconds) * 1000,
        };
        this.rows.set(locator, next);
        return {
          status: "written",
          revision: next.revision,
          expires_at: new Date(next.expiresAt).toISOString(),
        };
      }
      if (!current) return { status: "missing" };
      if (current.revision !== expected) {
        return { status: "conflict", revision: current.revision };
      }
      const next = {
        valueText: String(args.p_value_text),
        revision: current.revision + 1,
        expiresAt: this.now + Number(args.p_ttl_seconds) * 1000,
      };
      this.rows.set(locator, next);
      return {
        status: "written",
        revision: next.revision,
        expires_at: new Date(next.expiresAt).toISOString(),
      };
    }
    if (name === "supa_mcp_state_delete") {
      if (!current) return { status: "missing" };
      if (current.revision !== args.p_expected_revision) {
        return { status: "conflict", revision: current.revision };
      }
      this.rows.delete(locator);
      return { status: "deleted", revision: current.revision };
    }
    throw new Error(`Unexpected RPC ${name}`);
  }
}

const DEFAULT_AUTH: SupabaseMcpAuthentication = {
  mode: "oauth",
  strategy: "oauth",
};

function makeFactory(
  namespaces: SupabaseMcpDurableStateOptions["namespaces"] = {
    observations: { ttlSeconds: 300, maxTtlSeconds: 600 },
    previews_short: { ttlSeconds: 60 },
    previews_long: { ttlSeconds: 3600 },
    workspace: { ttlSeconds: 3600, maxTtlSeconds: 86_400 },
  },
) {
  return createSupabaseMcpStateFactory({
    hmacKey: HMAC_KEY,
    namespaces,
  });
}

describe("ctx.sessionState, mcpSessionId, and workspace routing", () => {
  it("isolates sessionState across both credentials and session IDs and validates header lengths up to 1024", async () => {
    const backend = new MemoryStateBackend();
    const factory = makeFactory();

    const aliceBase = await factory.create(
      { credential: "alice-token", authentication: DEFAULT_AUTH },
      backend.client,
    );
    const aliceS1 = await factory.create(
      {
        credential: "alice-token",
        authentication: DEFAULT_AUTH,
        sessionId: "session-1",
      },
      backend.client,
    );
    const aliceS2 = await factory.create(
      {
        credential: "alice-token",
        authentication: DEFAULT_AUTH,
        sessionId: "session-2",
      },
      backend.client,
    );
    const bobS1 = await factory.create(
      {
        credential: "bob-token",
        authentication: DEFAULT_AUTH,
        sessionId: "session-1",
      },
      backend.client,
    );

    await aliceS1.put("workspace", "active", {
      value: { id: "ws-alpha" },
      expectedRevision: null,
    });

    expect(await aliceS1.get("workspace", "active")).toMatchObject({
      value: { id: "ws-alpha" },
    });
    expect(await aliceBase.get("workspace", "active")).toBeNull();
    expect(await aliceS2.get("workspace", "active")).toBeNull();
    expect(await bobS1.get("workspace", "active")).toBeNull();

    // Accepts long crun1 session headers up to 1024 visible ASCII chars, rejects control chars.
    const longCrun = `crun1.${"a".repeat(200)}.${"b".repeat(43)}`;
    expect(
      mcpSessionId(
        new Request("https://example.test/mcp", {
          headers: { "mcp-session-id": longCrun },
        }),
      ),
    ).toBe(longCrun);
    expect(
      mcpSessionId(
        new Request("https://example.test/mcp", {
          headers: { "mcp-session-id": "bad session with spaces" },
        }),
      ),
    ).toBeNull();
    expect(
      mcpSessionId(
        new Request("https://example.test/mcp", {
          headers: { "mcp-session-id": "x".repeat(1025) },
        }),
      ),
    ).toBeNull();
  });

  it("handles 2025 sessionful routing, 2026 sessionless fallback, revoked-workspace clearing, and echo budgets", async () => {
    const backend = new MemoryStateBackend();
    const factory = makeFactory();
    const workspaces: WorkspaceDescriptor[] = [
      { id: "ws-1", name: "Alpha" },
      { id: "ws-2", name: "Beta" },
    ];
    let authorized: WorkspaceDescriptor[] = [...workspaces];

    const deps: RuntimeDependencies<any> = {
      async verifyToken(token): Promise<VerifiedSupabaseIdentity> {
        return {
          token,
          userClaims: { id: "alice" },
          jwtClaims: {
            sub: "alice",
            exp: Math.floor(Date.now() / 1000) + 3600,
          },
        };
      },
      createClient: () => ({}) as unknown as SupabaseClient,
      createAdminClient: () => backend.client,
      fetch: globalThis.fetch,
      randomUUID: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    };

    const app = createSupabaseMcpInternal(
      {
        server: { name: "ws-app", version: "1.0.0" },
        resourceUrl: "https://example.test/mcp",
        auth: { mode: "bearer" },
        state: {
          hmacKey: HMAC_KEY,
          namespaces: {
            workspace: { ttlSeconds: 3600, maxTtlSeconds: 86_400 },
          },
        },
        register(server, ctx) {
          registerUseWorkspace(server, ctx, {
            namespace: "workspace",
            listToolName: "list_workspaces",
            listAuthorized: () => authorized,
          });
          server.registerTool(
            "current_workspace",
            { inputSchema: z.object({ workspace: z.string().optional() }) },
            async (args) => {
              const resolved = await resolveActiveWorkspace(ctx, {
                namespace: "workspace",
                listToolName: "list_workspaces",
                explicitId: args.workspace,
                listAuthorized: () => authorized,
              });
              if (!resolved.ok) return resolved.error;
              return withWorkspaceEcho(
                structuredResult({ source: resolved.source }),
                resolved.workspace,
              );
            },
          );
        },
      },
      deps,
    );

    const callTool = async (
      name: string,
      args: Record<string, unknown>,
      sessionId?: string,
    ) => {
      const res = await app.fetch(
        new Request("https://example.test/mcp", {
          method: "POST",
          headers: {
            authorization: "Bearer alice-jwt",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "1",
            method: "tools/call",
            params: { name, arguments: args },
          }),
        }),
      );
      return jsonRpcPayloadFromResponseText(await res.text()) as {
        result?: {
          isError?: boolean;
          content?: Array<{ text?: string }>;
          structuredContent?: Record<string, unknown>;
        };
      };
    };

    // 1. Sessionless 2026 call with >1 workspace returns no_session guidance.
    const noSession = await callTool("current_workspace", {});
    expect(noSession.result?.isError).toBe(true);
    expect(noSession.result?.content?.[0]?.text).toContain("list_workspaces");

    // 2. Explicit workspace argument works even without session.
    const explicit = await callTool("current_workspace", { workspace: "ws-2" });
    expect(explicit.result?.isError).toBeUndefined();
    expect(explicit.result?.structuredContent).toEqual({
      source: "explicit",
      workspace: { id: "ws-2", name: "Beta" },
    });

    // 3. Sessionful use_workspace persists choice for subsequent calls.
    const setRes = await callTool(
      "use_workspace",
      { workspace: "ws-1" },
      "sess-window-1",
    );
    expect(setRes.result?.isError).toBeUndefined();
    const fromSession = await callTool(
      "current_workspace",
      {},
      "sess-window-1",
    );
    expect(fromSession.result?.structuredContent).toEqual({
      source: "session",
      workspace: { id: "ws-1", name: "Alpha" },
    });

    // 4. Revoking ws-1 triggers "removed" even though only ws-2 remains (never silently steers!).
    authorized = [{ id: "ws-2", name: "Beta" }];
    const revoked = await callTool("current_workspace", {}, "sess-window-1");
    expect(revoked.result?.isError).toBe(true);
    expect(revoked.result?.content?.[0]?.text).toContain("no longer available");

    // 5. After stale choice was cleared, autoSelectSingle resolves ws-2 cleanly.
    const autoSingle = await callTool("current_workspace", {}, "sess-window-1");
    expect(autoSingle.result?.structuredContent).toEqual({
      source: "single",
      workspace: { id: "ws-2", name: "Beta" },
    });

    // 6. Prototype-pollution identifiers are rejected.
    const fakeCtx = { sessionId: null } as unknown as SupabaseMcpContext;
    await expect(
      resolveActiveWorkspace(fakeCtx, {
        namespace: "workspace",
        paramName: "__proto__",
        listToolName: "list_workspaces",
        listAuthorized: () => [],
      }),
    ).rejects.toThrow(TypeError);

    // 7. withWorkspaceEcho respects collection byte budgets without throwing.
    const tight = collectionResult({
      items: [{ id: "1", body: "a".repeat(380) }],
      itemSchema: z.object({ id: z.string(), body: z.string() }),
      project: (item) => item,
      mode: "structured",
      limit: 20,
      hasMore: false,
      cursorFor: (item) => item.id,
      tool: "list_items",
      maxBytes: 512,
    });
    const echoed = withWorkspaceEcho(tight, { id: "ws-1", name: "Alpha" });
    expect(echoed).toEqual(tight);
    expect(factory).toBeDefined();
  });
});

describe("observeResource and requireObserved", () => {
  it("enforces 3-step CAS ordering and recovers safely when Step 3 fails post-commit", async () => {
    const backend = new MemoryStateBackend();
    const state = await makeFactory().create(
      { credential: "alice", authentication: DEFAULT_AUTH },
      backend.client,
    );

    // Step 1: fails closed when state is undefined or resource was never observed.
    let mutateCalls = 0;
    const unavail = await requireObserved(undefined, {
      namespace: "observations",
      resourceKey: "doc:1",
      readToolName: "read_document",
      mutate: async () => {
        mutateCalls += 1;
        return { status: "committed", value: "nope", nextVersion: 2 };
      },
    });
    expect(unavail).toMatchObject({
      ok: false,
      phase: "observation",
      reason: "state_unavailable",
    });

    const missing = await requireObserved(state, {
      namespace: "observations",
      resourceKey: "doc:1",
      readToolName: "read_document",
      mutate: async () => {
        mutateCalls += 1;
        return { status: "committed", value: "nope", nextVersion: 2 };
      },
    });
    expect(missing).toMatchObject({
      ok: false,
      phase: "observation",
      reason: "not_observed",
    });
    expect(mutateCalls).toBe(0);

    // Observe version 1 with partial scope.
    await observeResource(state, {
      namespace: "observations",
      resourceKey: "doc:1",
      resourceVersion: 1,
      scope: "summary",
    });

    // Insufficient scope fails closed before mutate.
    const badScope = await requireObserved(state, {
      namespace: "observations",
      resourceKey: "doc:1",
      readToolName: "read_document",
      verifyScope: (r) => r.scope === "full",
      mutate: async () => {
        mutateCalls += 1;
        return { status: "committed", value: "nope", nextVersion: 2 };
      },
    });
    expect(badScope).toMatchObject({
      ok: false,
      phase: "observation",
      reason: "insufficient_scope",
    });
    expect(mutateCalls).toBe(0);

    // Full observation -> Step 2 commits -> Step 3 advances receipt to version 2.
    await observeResource(state, {
      namespace: "observations",
      resourceKey: "doc:1",
      resourceVersion: 1,
      scope: "full",
    });
    const ok = await requireObserved(state, {
      namespace: "observations",
      resourceKey: "doc:1",
      readToolName: "read_document",
      mutate: async ({ observedVersion }) => {
        expect(observedVersion).toBe(1);
        return {
          status: "committed",
          value: { updated: true },
          nextVersion: 2,
        };
      },
    });
    expect(ok).toEqual({
      ok: true,
      value: { updated: true },
      receiptAdvanced: true,
      rereadRequired: false,
    });

    // Step 2 rejection preserves receipt untouched.
    const rejected = await requireObserved(state, {
      namespace: "observations",
      resourceKey: "doc:1",
      readToolName: "read_document",
      mutate: async ({ observedVersion }) => {
        expect(observedVersion).toBe(2);
        return {
          status: "rejected",
          reason: "version_conflict",
          error: errorResult("Stale version."),
        };
      },
    });
    expect(rejected).toMatchObject({
      ok: false,
      phase: "mutation",
      reason: "version_conflict",
    });

    // Step 3 failure after Step 2 commit returns safe false negative (ok: true, rereadRequired: true).
    const step3Committed = await requireObserved(state, {
      namespace: "observations",
      resourceKey: "doc:1",
      readToolName: "read_document",
      mutate: async () => {
        backend.failOnRpc = "supa_mcp_state_put";
        return { status: "committed", value: { id: "doc:1" }, nextVersion: 3 };
      },
    });
    expect(step3Committed).toEqual({
      ok: true,
      value: { id: "doc:1" },
      receiptAdvanced: false,
      rereadRequired: true,
    });

    backend.failOnRpc = undefined;
    await expect(
      observeResource(undefined, {
        namespace: "observations",
        resourceKey: "doc:1",
        resourceVersion: 1,
      }),
    ).rejects.toBeInstanceOf(SupabaseMcpStateUnavailableError);
  });
});

describe("mintPreview and consumePreview", () => {
  it("clamps TTLs via namespaceOptions, binds canonical payload + scope, burns tampered tokens, and allows at most 1 concurrent winner", async () => {
    const backend = new MemoryStateBackend();
    const state: SupabaseMcpState = await makeFactory().create(
      { credential: "alice", authentication: DEFAULT_AUTH },
      backend.client,
    );

    // 1. Short namespace (ttlSeconds: 60) defaults to 60s without throwing 1..60 error.
    const shortPreview = await mintPreview(state, {
      namespace: "previews_short",
      tool: "delete_item",
      payload: { id: "item-1" },
    });
    expect(shortPreview.token).toMatch(previewLimits.tokenPattern);
    const shortPutCall = backend.calls.find(
      (call) =>
        call.name === "supa_mcp_state_put" &&
        call.args.p_namespace === "previews_short",
    );
    expect(shortPutCall?.args.p_ttl_seconds).toBe(60);
    // Raw payload is never stored in state rows.
    expect(String(shortPutCall?.args.p_value_text)).not.toContain("item-1");

    // 2. Long namespace (ttlSeconds: 3600) defaults to 300s and rejects explicit >900s.
    await mintPreview(state, {
      namespace: "previews_long",
      tool: "delete_item",
      payload: { id: "item-2" },
    });
    const longPutCall = backend.calls.find(
      (call) =>
        call.name === "supa_mcp_state_put" &&
        call.args.p_namespace === "previews_long",
    );
    expect(longPutCall?.args.p_ttl_seconds).toBe(300);

    await expect(
      mintPreview(state, {
        namespace: "previews_long",
        tool: "delete_item",
        payload: { id: "item-2" },
        ttlSeconds: 901,
      }),
    ).rejects.toBeInstanceOf(RangeError);

    // 3. Canonical key-order invariance + scope mismatch burns the token immediately.
    const scoped = await mintPreview(state, {
      namespace: "previews_short",
      tool: "transfer",
      scope: "tenant-a",
      payload: { amount: 50, currency: "USD" },
      summary: { label: "Transfer $50" },
    });
    const wrongScope = await consumePreview(state, {
      namespace: "previews_short",
      tool: "transfer",
      scope: "tenant-b",
      token: scoped.token,
      payload: { currency: "USD", amount: 50 },
    });
    expect(wrongScope).toMatchObject({
      ok: false,
      reason: "payload_mismatch",
    });
    // Token was burned on mismatch, so retrying with original scope fails as missing_or_consumed.
    const burnedReplay = await consumePreview(state, {
      namespace: "previews_short",
      tool: "transfer",
      scope: "tenant-a",
      token: scoped.token,
      payload: { amount: 50, currency: "USD" },
    });
    expect(burnedReplay).toMatchObject({
      ok: false,
      reason: "missing_or_consumed",
    });

    // 4. 10-way concurrent consumePreview race: at most 1 winner!
    const raceToken = await mintPreview(state, {
      namespace: "previews_short",
      tool: "publish",
      payload: { b: 2, a: 1 },
    });
    const race = await Promise.all(
      Array.from({ length: 10 }, () =>
        consumePreview(state, {
          namespace: "previews_short",
          tool: "publish",
          token: raceToken.token,
          payload: { a: 1, b: 2 },
        }),
      ),
    );
    const winners = race.filter((result) => result.ok);
    const losers = race.filter((result) => !result.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(9);
    for (const loser of losers) {
      if (!loser.ok) expect(loser.reason).toBe("missing_or_consumed");
    }

    // 5. Malformed token fails before touching Postgres.
    const callsBefore = backend.calls.length;
    const bad = await consumePreview(state, {
      namespace: "previews_short",
      tool: "publish",
      token: "not-a-valid-token",
      payload: {},
    });
    expect(bad).toMatchObject({ ok: false, reason: "invalid_token" });
    expect(backend.calls.length).toBe(callsBefore);
  });
});
