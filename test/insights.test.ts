import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildRunTimeline,
  composeEventSinks,
  createSupabaseInsightsAdapter,
  createTelemetrySink,
} from "../src/insights.js";
import { createRunCorrelationInternal } from "../src/internal/run-correlation.js";
import { planInit } from "../src/project.js";
import { structuredResult } from "../src/results.js";
import { createSupabaseMcpInternal } from "../src/runtime.js";
import type {
  RuntimeDependencies,
  SupabaseMcpLifecycleEvent,
  VerifiedSupabaseIdentity,
} from "../src/types.js";

const RESOURCE_URL = "https://project.supabase.co/functions/v1/mcp";
const SECRET = "self-hosted-run-correlation-hmac-secret-32b+";

function userIdentity(subject: string): VerifiedSupabaseIdentity {
  return {
    token: `tok-${subject}`,
    userClaims: {
      id: subject,
      email: `${subject}@example.test`,
      role: "authenticated",
    },
    jwtClaims: {
      sub: subject,
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    },
  };
}

function runtimeDeps(
  users: Readonly<Record<string, VerifiedSupabaseIdentity>> = {},
  clock = { now: Date.UTC(2026, 10, 20, 12, 0, 0) },
): RuntimeDependencies<any> {
  let seq = 0;
  return {
    async verifyToken(token) {
      const hit = users[token];
      if (!hit) throw new Error("invalid token");
      return hit;
    },
    createClient() {
      return {} as SupabaseClient;
    },
    createAdminClient() {
      return {} as SupabaseClient;
    },
    fetch: globalThis.fetch.bind(globalThis),
    now() {
      const value = clock.now;
      clock.now += 15;
      return value;
    },
    randomUUID() {
      seq += 1;
      return `uuid-opaque-nonce-${String(seq).padStart(4, "0")}`;
    },
  };
}

function mcpPost(
  method: string,
  options: {
    token?: string;
    sessionId?: string;
    params?: Record<string, unknown>;
    metaRun?: string;
    legacySession?: boolean;
  } = {},
): Request {
  const isLegacy = method === "initialize" || Boolean(options.legacySession);
  const headers = new Headers(
    isLegacy
      ? {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        }
      : {
          "content-type": "application/json",
          "mcp-method": method,
          "mcp-protocol-version": "2026-07-28",
        },
  );
  if (!isLegacy && typeof options.params?.name === "string") {
    headers.set("mcp-name", options.params.name);
  }
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.sessionId) headers.set("mcp-session-id", options.sessionId);
  const params =
    method === "initialize"
      ? {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "claude-desktop", version: "1.0.0" },
        }
      : isLegacy
        ? { ...options.params }
        : {
            ...options.params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {
                elicitation: { form: {} },
              },
              ...(options.metaRun ? { "dev.chumbo/run": options.metaRun } : {}),
            },
          };
  return new Request(RESOURCE_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });
}

describe("Chumbo 0.14.0 self-hosted Insights & run correlation", () => {
  it("preserves Step 1 on capability.finished when a tool lazily mints a run handle", async () => {
    const clock = { now: Date.UTC(2026, 10, 20, 12, 0, 0) };
    let nonceSeq = 0;
    const runs = createRunCorrelationInternal(
      {
        currentKey: { version: "v1", secret: SECRET },
        argumentName: "conversation",
        onInvalidHandle: "ignore",
        scope: (ctx) => ({
          installation: "self-hosted",
          surface: "default",
          partition: ctx.subject ?? "anon",
        }),
      },
      {
        now: () => clock.now,
        randomUUID: () => `minted-step1-nonce-${++nonceSeq}`,
      },
    );

    const events: SupabaseMcpLifecycleEvent[] = [];
    const app = createSupabaseMcpInternal(
      {
        server: { name: "notes", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "oauth", issuer: "https://project.supabase.co/auth/v1" },
        runCorrelation: runs,
        register(server, context) {
          server.registerTool(
            "search_notes",
            { inputSchema: z.object({ conversation: z.string().optional() }) },
            async (args, serverContext) => {
              const existing = await runs.resolve(context, {
                serverContext,
                toolArguments: args,
              });
              if (existing) {
                return structuredResult({
                  runId: existing.id,
                  conversation: args.conversation ?? null,
                });
              }
              const minted = await runs.mint(context);
              return structuredResult({
                runId: minted.run.id,
                conversation: minted.handle,
              });
            },
          );
        },
        onEvent(event) {
          events.push(event);
        },
      },
      runtimeDeps({ "tok-alice": userIdentity("alice") }, clock),
    );

    const firstRes = await app.fetch(
      mcpPost("tools/call", {
        token: "tok-alice",
        params: { name: "search_notes", arguments: {} },
      }),
    );
    expect(firstRes.status).toBe(200);
    const firstBody = await firstRes.json();
    const handle = firstBody.result.structuredContent.conversation as string;
    const expectedRunId = firstBody.result.structuredContent.runId as string;
    expect(handle).toMatch(/^crun1\./);

    const secondRes = await app.fetch(
      mcpPost("tools/call", {
        token: "tok-alice",
        params: { name: "search_notes", arguments: { conversation: handle } },
      }),
    );
    expect(secondRes.status).toBe(200);

    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      type: "capability.started",
      schemaVersion: 2,
      run: null,
    });
    expect(events[1]).toMatchObject({
      type: "capability.finished",
      schemaVersion: 2,
      run: { id: expectedRunId },
      outcome: "success",
    });
    expect(events[3]).toMatchObject({
      type: "capability.finished",
      schemaVersion: 2,
      run: { id: expectedRunId },
      outcome: "success",
    });
  });

  it("degrades invalid or expired handles with runRejected when onInvalidHandle is ignore", async () => {
    const clock = { now: Date.UTC(2026, 10, 20, 12, 0, 0) };
    const runs = createRunCorrelationInternal(
      {
        currentKey: { version: "v1", secret: SECRET },
        onInvalidHandle: "ignore",
        scope: (ctx) => ({
          installation: "self-hosted",
          surface: "default",
          partition: ctx.subject ?? "anon",
        }),
      },
      {
        now: () => clock.now,
        randomUUID: () => "expired-test-nonce-0001",
      },
    );
    const events: SupabaseMcpLifecycleEvent[] = [];
    const app = createSupabaseMcpInternal(
      {
        server: { name: "notes", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        runCorrelation: runs,
        register(server) {
          server.registerTool("ping", { inputSchema: z.object({}) }, async () =>
            structuredResult({ ok: true }),
          );
        },
        onEvent(event) {
          events.push(event);
        },
      },
      runtimeDeps({}, clock),
    );

    const res = await app.fetch(
      mcpPost("tools/call", {
        metaRun: "not-a-valid-handle",
        params: { name: "ping", arguments: {} },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.structuredContent).toEqual({ ok: true });
    expect(events[1]).toMatchObject({
      type: "capability.finished",
      schemaVersion: 2,
      run: null,
      runRejected: "invalid_token",
      outcome: "success",
    });
  });

  it("issues HMAC-signed Mcp-Session-Id on initialize and isolates sessions per member", async () => {
    const clock = { now: Date.UTC(2026, 10, 20, 12, 0, 0) };
    let seq = 0;
    const runs = createRunCorrelationInternal(
      {
        currentKey: { version: "v1", secret: SECRET },
        sessionHeader: true,
        scope: (ctx) => ({
          installation: "self-hosted",
          surface: "default",
          partition: ctx.subject ?? "anon",
        }),
      },
      {
        now: () => clock.now,
        randomUUID: () => `session-nonce-${String(++seq).padStart(4, "0")}`,
      },
    );

    const events: SupabaseMcpLifecycleEvent[] = [];
    const app = createSupabaseMcpInternal(
      {
        server: { name: "notes", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "oauth", issuer: "https://project.supabase.co/auth/v1" },
        runCorrelation: runs,
        register(server) {
          server.registerTool("ping", { inputSchema: z.object({}) }, async () =>
            structuredResult({ ok: true }),
          );
        },
        onEvent(event) {
          events.push(event);
        },
      },
      runtimeDeps(
        {
          "tok-alice": userIdentity("alice"),
          "tok-bob": userIdentity("bob"),
        },
        clock,
      ),
    );

    const initAlice = await app.fetch(
      mcpPost("initialize", { token: "tok-alice" }),
    );
    expect(initAlice.status).toBe(200);
    const aliceSession = initAlice.headers.get("mcp-session-id");
    expect(aliceSession).toMatch(/^crun1\./);

    const callAlice = await app.fetch(
      mcpPost("tools/call", {
        token: "tok-alice",
        sessionId: aliceSession!,
        legacySession: true,
        params: { name: "ping", arguments: {} },
      }),
    );
    expect(callAlice.status).toBe(200);
    await callAlice.text();

    // Bob trying to echo Alice's session header must NOT join Alice's run
    const callBobWithAliceSession = await app.fetch(
      mcpPost("tools/call", {
        token: "tok-bob",
        sessionId: aliceSession!,
        legacySession: true,
        params: { name: "ping", arguments: {} },
      }),
    );
    expect(callBobWithAliceSession.status).toBe(200);
    await callBobWithAliceSession.text();

    const finished = events.filter(
      (event) => event.type === "capability.finished",
    );
    expect(finished).toHaveLength(2);
    expect(finished[0]).toMatchObject({
      schemaVersion: 2,
      run: { id: expect.stringMatching(/^run_/) },
      sessionId: expect.stringMatching(/^run_/),
    });
    expect(finished[1]).toMatchObject({
      schemaVersion: 2,
      run: null,
      runRejected: "invalid_session",
    });
  });

  it("composes sinks without payload leakage and builds clean run timelines", async () => {
    const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const fakeSupabase = {
      async rpc(fn: string, args: Record<string, unknown>) {
        rpcCalls.push({ fn, args });
        return { data: true, error: null };
      },
    } as unknown as SupabaseClient;

    const secondaryEvents: SupabaseMcpLifecycleEvent[] = [];
    const sink = composeEventSinks(
      createTelemetrySink({ supabase: fakeSupabase }),
      async (event) => {
        secondaryEvents.push(event);
      },
    );

    const sentinelArg = "SECRET_PROMPT_SENTINEL_99182";
    const sentinelResult = "SECRET_RESULT_SENTINEL_44821";
    const sentinelError = "SECRET_THROW_SENTINEL_77310";

    const app = createSupabaseMcpInternal(
      {
        server: { name: "vault", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "oauth", issuer: "https://project.supabase.co/auth/v1" },
        register(server) {
          server.registerTool(
            "write_secret",
            { inputSchema: z.object({ prompt: z.string() }) },
            async ({ prompt }) => {
              if (prompt.includes("THROW")) throw new Error(sentinelError);
              return structuredResult({ secret: sentinelResult });
            },
          );
        },
        onEvent: sink,
      },
      runtimeDeps({ "tok-alice": userIdentity("alice") }),
    );

    await app.fetch(
      mcpPost("tools/call", {
        token: "tok-alice",
        params: { name: "write_secret", arguments: { prompt: sentinelArg } },
      }),
    );
    await app.fetch(
      mcpPost("tools/call", {
        token: "tok-alice",
        params: {
          name: "write_secret",
          arguments: { prompt: `THROW_${sentinelArg}` },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(rpcCalls.length).toBeGreaterThanOrEqual(4);
    expect(secondaryEvents.length).toBeGreaterThanOrEqual(4);
    const serialized = JSON.stringify(rpcCalls);
    expect(serialized).not.toContain(sentinelArg);
    expect(serialized).not.toContain(sentinelResult);
    expect(serialized).not.toContain(sentinelError);
    expect(serialized).toContain('"requested_subject":"alice"');

    const timeline = buildRunTimeline([
      {
        occurredAt: "2026-11-20T12:00:00.000Z",
        capabilityKind: "tool",
        capabilityName: "search_notes",
        durationMs: 110,
        outcome: "success",
        runId: "run_1",
      },
      {
        occurredAt: "2026-11-20T12:00:05.000Z",
        capabilityKind: "tool",
        capabilityName: "search_notes",
        durationMs: 120,
        outcome: "tool-error",
        errorCode: "permission_denied",
        runId: "run_1",
      },
    ]);
    expect(timeline.runs).toHaveLength(1);
    expect(timeline.runs[0]!.steps[0]).toMatchObject({
      kind: "loop",
      label: "Repeated: Search notes (×2)",
      friction: true,
    });
    expect(typeof createSupabaseInsightsAdapter).toBe("function");
  });

  it("scaffolds telemetry migration and standalone dashboard with --insights", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chumbo-insights-init-"));
    try {
      await mkdir(join(dir, "supabase"), { recursive: true });
      await writeFile(
        join(dir, "supabase", "config.toml"),
        'project_id = "insights-demo"\n\n[api]\nport = 54321\n',
      );
      const files = await planInit({
        cwd: dir,
        functionName: "mcp",
        serverName: "Demo",
        auth: "oauth",
        consent: "none",
        patchConfig: true,
        insights: true,
      });
      const migration = files.find((f) =>
        f.path.endsWith("20261120000000_create_chumbo_telemetry_v2.sql"),
      );
      const dashboard = files.find((f) =>
        f.path.endsWith(join("insights", "index.html")),
      );
      const entry = files.find((f) =>
        f.path.endsWith(join("supabase", "functions", "mcp", "index.ts")),
      );
      expect(migration).toBeDefined();
      expect(migration!.content).toContain(
        "pg_extension where extname = 'pg_cron'",
      );
      expect(migration!.content).toContain(
        "create or replace function chumbo_telemetry.insights_is_admin(uid uuid)",
      );
      expect(dashboard).toBeDefined();
      expect(dashboard!.content).toContain("chumbo_insights_runs");
      expect(entry!.content).toContain('from "chumbo/insights"');
      expect(entry!.content).toContain("sessionHeader: true");

      const templateOnDisk = await readFile(
        new URL("../templates/migrations/telemetry.sql.tpl", import.meta.url),
        "utf8",
      );
      expect(migration!.content).toBe(templateOnDisk);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
