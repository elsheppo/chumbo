import type { ServerContext } from "@modelcontextprotocol/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createRunCorrelation,
  SupabaseMcpRunCorrelationError,
} from "../src/index.js";
import {
  createRunCorrelationInternal,
  mintRunHandle,
} from "../src/internal/run-correlation.js";
import { structuredResult } from "../src/results.js";
import { createSupabaseMcpInternal } from "../src/runtime.js";
import type {
  RuntimeDependencies,
  SupabaseMcpContext,
  SupabaseMcpLifecycleEvent,
  SupabaseMcpRunCorrelation,
  SupabaseMcpRunFact,
} from "../src/types.js";

const NOW = Date.UTC(2026, 7, 29, 20);
const RESOURCE_URL = "https://project.supabase.co/functions/v1/mcp";
const CURRENT_KEY = {
  version: "2026-08-b",
  secret: "current-public-run-correlation-key-more-than-32-bytes",
};
const PREVIOUS_KEY = {
  version: "2026-08-a",
  secret: "previous-public-run-correlation-key-more-than-32-bytes",
  acceptUntil: new Date(NOW + 60_000).toISOString(),
};

function dependencies(): RuntimeDependencies<any> {
  let sequence = 0;
  return {
    async verifyToken() {
      throw new Error("Public fixture must not verify credentials.");
    },
    createClient() {
      return {} as SupabaseClient;
    },
    createAdminClient() {
      return {} as SupabaseClient;
    },
    fetch: globalThis.fetch.bind(globalThis),
    now() {
      return NOW;
    },
    randomUUID() {
      sequence += 1;
      return `trace-${sequence}`;
    },
  };
}

function applicationContext(subject = "user-42"): SupabaseMcpContext {
  const authentication = Object.freeze({
    mode: "api-key" as const,
    strategy: "fixture",
  });
  return Object.freeze({
    request: new Request(RESOURCE_URL),
    supabase: {} as unknown as SupabaseMcpContext["supabase"],
    user: null,
    jwtClaims: null,
    principal: Object.freeze({ subject, authentication }),
    authentication,
    subject,
    scopes: Object.freeze([]),
    hasScope: () => false,
    hasScopes: (required: readonly string[]) => required.length === 0,
    traceId: `fixture-${subject}`,
  });
}

function correlation(
  options: {
    now?: () => number;
    randomUUID?: () => string;
  } = {},
): SupabaseMcpRunCorrelation {
  let sequence = 0;
  return createRunCorrelationInternal(
    {
      currentKey: CURRENT_KEY,
      previousKey: PREVIOUS_KEY,
      scope(context) {
        return {
          installation: "installed-project-01",
          surface: "mjx-main-mcp",
          partition: context.subject ?? "public",
        };
      },
    },
    {
      now: options.now ?? (() => NOW),
      randomUUID:
        options.randomUUID ??
        (() => {
          sequence += 1;
          return `opaque-run-nonce-${String(sequence).padStart(4, "0")}`;
        }),
    },
  );
}

function serverContext(metadata: Record<string, unknown> = {}): ServerContext {
  return { mcpReq: { _meta: metadata } } as unknown as ServerContext;
}

function protocolRequest(options: {
  metadataHandle?: string;
  argumentHandle?: string;
}): Request {
  return new Request(RESOURCE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-method": "tools/call",
      "mcp-name": "correlated",
      "mcp-protocol-version": "2026-07-28",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: {
        name: "correlated",
        arguments: options.argumentHandle
          ? { run_id: options.argumentHandle }
          : {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {
            elicitation: { form: {} },
          },
          ...(options.metadataHandle
            ? { "dev.chumbo/run": options.metadataHandle }
            : {}),
        },
      },
    }),
  });
}

async function expectCode(
  promise: Promise<unknown>,
  code: SupabaseMcpRunCorrelationError["code"],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("public run correlation runtime", () => {
  it("shares one verified run fact between capability code and lifecycle v2", async () => {
    const runs = correlation();
    const minted = await runs.mint(applicationContext("public"));
    const events: SupabaseMcpLifecycleEvent[] = [];
    const handlerFacts: (SupabaseMcpRunFact | null)[] = [];
    const app = createSupabaseMcpInternal(
      {
        server: { name: "run-aware", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        runCorrelation: runs,
        register(server, context) {
          server.registerTool(
            "correlated",
            { inputSchema: z.object({ run_id: z.string().optional() }) },
            async (arguments_, mcpContext) => {
              const run = await runs.resolve(context, {
                serverContext: mcpContext,
                toolArguments: arguments_,
              });
              handlerFacts.push(run);
              return structuredResult({ runId: run?.id ?? null });
            },
          );
        },
        onEvent(event) {
          events.push(event);
        },
      },
      dependencies(),
    );

    const metadataResponse = await app.fetch(
      protocolRequest({ metadataHandle: minted.handle }),
    );
    const argumentResponse = await app.fetch(
      protocolRequest({ argumentHandle: minted.handle }),
    );
    expect(metadataResponse.status, await metadataResponse.clone().text()).toBe(
      200,
    );
    expect(argumentResponse.status, await argumentResponse.clone().text()).toBe(
      200,
    );
    const metadataBody = await metadataResponse.json();
    const argumentBody = await argumentResponse.json();
    expect(metadataBody.result.structuredContent).toEqual({
      runId: minted.run.id,
    });
    expect(argumentBody.result.structuredContent).toEqual({
      runId: minted.run.id,
    });
    expect(handlerFacts).toEqual([minted.run, minted.run]);
    expect(events).toHaveLength(4);
    expect(events).toEqual(
      events.map((event) =>
        expect.objectContaining({
          schemaVersion: 2,
          run: minted.run,
        }),
      ),
    );
    expect(JSON.stringify(events)).not.toContain("opaque-run-nonce-0001");
    expect(Object.isFrozen(events[0])).toBe(true);
    expect(
      Object.isFrozen(events[0] && "run" in events[0] ? events[0].run : null),
    ).toBe(true);
  });

  it("emits lifecycle v2 with run null when a configured caller supplies no handle", async () => {
    const runs = correlation();
    const events: SupabaseMcpLifecycleEvent[] = [];
    let handlerRun: SupabaseMcpRunFact | null | undefined;
    const app = createSupabaseMcpInternal(
      {
        server: { name: "run-optional", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        runCorrelation: runs,
        register(server, context) {
          server.registerTool(
            "correlated",
            { inputSchema: z.object({ run_id: z.string().optional() }) },
            async (arguments_, mcpContext) => {
              handlerRun = await runs.resolve(context, {
                serverContext: mcpContext,
                toolArguments: arguments_,
              });
              return structuredResult({ ok: true });
            },
          );
        },
        onEvent(event) {
          events.push(event);
        },
      },
      dependencies(),
    );

    const response = await app.fetch(protocolRequest({}));
    expect(response.status, await response.clone().text()).toBe(200);
    expect(handlerRun).toBeNull();
    expect(events).toMatchObject([
      { schemaVersion: 2, type: "capability.started", run: null },
      { schemaVersion: 2, type: "capability.finished", run: null },
    ]);
  });

  it("rejects conflicting or malformed handles before application code even without an event sink", async () => {
    const runs = correlation();
    const first = await runs.mint(applicationContext());
    const second = await runs.mint(applicationContext());
    let calls = 0;
    const app = createSupabaseMcpInternal(
      {
        server: { name: "run-guard", version: "1.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        runCorrelation: runs,
        register(server) {
          server.registerTool(
            "correlated",
            { inputSchema: z.object({ run_id: z.string().optional() }) },
            async () => {
              calls += 1;
              return structuredResult({ shouldNotRun: true });
            },
          );
        },
      },
      dependencies(),
    );

    const conflict = await app.fetch(
      protocolRequest({
        metadataHandle: first.handle,
        argumentHandle: second.handle,
      }),
    );
    const malformed = await app.fetch(
      protocolRequest({ metadataHandle: "not-a-run-handle" }),
    );
    expect(calls).toBe(0);
    const conflictBody = await conflict.json();
    const malformedBody = await malformed.json();
    expect(conflictBody.result?.isError ?? conflictBody.error).toBeTruthy();
    expect(malformedBody.result?.isError ?? malformedBody.error).toBeTruthy();
  });

  it("separates 500 interleaved public resolutions and rejects cross-principal reuse", async () => {
    const runs = correlation();
    const userA = applicationContext("user-a");
    const userB = applicationContext("user-b");
    const first = await runs.mint(userA);
    const second = await runs.mint(userA);
    const observed = await Promise.all(
      Array.from({ length: 500 }, async (_, index) => {
        const selected = index % 2 === 0 ? first : second;
        const metadata =
          index % 4 < 2 ? { "dev.chumbo/run": selected.handle } : {};
        return runs.resolve(userA, {
          serverContext: serverContext(metadata),
          ...(index % 4 >= 2
            ? { toolArguments: { run_id: selected.handle } }
            : {}),
        });
      }),
    );

    expect(observed.filter((run) => run?.id === first.run.id)).toHaveLength(
      250,
    );
    expect(observed.filter((run) => run?.id === second.run.id)).toHaveLength(
      250,
    );
    await expectCode(
      runs.resolve(userB, {
        serverContext: serverContext({ "dev.chumbo/run": first.handle }),
      }),
      "invalid_token",
    );
  });

  it("enforces exact expiry through the public resolver", async () => {
    let now = NOW;
    const runs = correlation({ now: () => now });
    const context = applicationContext();
    const minted = await runs.mint(context, { ttlSeconds: 1 });
    now += 1_000;

    await expectCode(
      runs.resolve(context, {
        serverContext: serverContext({ "dev.chumbo/run": minted.handle }),
      }),
      "expired",
    );
  });

  it("accepts a previous public key only inside its declared overlap", async () => {
    let now = NOW;
    const runs = correlation({ now: () => now });
    const context = applicationContext();
    const oldHandle = await mintRunHandle({
      scope: {
        installation: "installed-project-01",
        surface: "mjx-main-mcp",
        partition: "user-42",
      },
      key: {
        version: PREVIOUS_KEY.version,
        secret: PREVIOUS_KEY.secret,
        acceptUntil: Date.parse(PREVIOUS_KEY.acceptUntil),
      },
      now,
      nonce: "previous-key-run-nonce",
      ttlSeconds: 600,
    });

    await expect(
      runs.resolve(context, {
        serverContext: serverContext({ "dev.chumbo/run": oldHandle }),
      }),
    ).resolves.toMatchObject({ schemaVersion: 1 });
    now = Date.parse(PREVIOUS_KEY.acceptUntil);
    await expectCode(
      runs.resolve(context, {
        serverContext: serverContext({ "dev.chumbo/run": oldHandle }),
      }),
      "expired",
    );
  });

  it("exports an immutable public factory with typed configuration failures", async () => {
    const runs = createRunCorrelation({
      currentKey: CURRENT_KEY,
      maxTtlSeconds: 60,
      scope(context) {
        return {
          installation: "public-factory-installation",
          surface: "public-factory-surface",
          partition: context.subject ?? "public",
        };
      },
    });
    const context = applicationContext();
    const minted = await runs.mint(context);
    const resolved = await runs.resolve(context, {
      serverContext: serverContext({ "dev.chumbo/run": minted.handle }),
    });

    expect(Object.isFrozen(runs)).toBe(true);
    expect(Object.isFrozen(minted)).toBe(true);
    expect(minted.handle).toMatch(/^crun1\./);
    expect(resolved).toEqual(minted.run);
    expect(() =>
      createRunCorrelation({
        currentKey: { version: "bad", secret: "too-short" },
        scope: () => ({
          installation: "fixture",
          surface: "fixture",
          partition: "fixture",
        }),
      }),
    ).toThrowError(
      expect.objectContaining<Partial<SupabaseMcpRunCorrelationError>>({
        name: "SupabaseMcpRunCorrelationError",
        code: "invalid_key",
      }),
    );
  });
});
