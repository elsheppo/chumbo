import type { ServerContext } from "@modelcontextprotocol/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  mintRunHandle,
  resolveRunHandle,
  RunCorrelationError,
  runCorrelationLimits,
  verifyRunHandle,
  type RunCorrelationKey,
  type RunCorrelationScope,
} from "../src/internal/run-correlation.js";
import { structuredResult } from "../src/results.js";
import { createSupabaseMcpInternal } from "../src/runtime.js";
import type { RuntimeDependencies } from "../src/types.js";

const NOW = Date.UTC(2026, 7, 29, 15);
const CURRENT_KEY = {
  version: "2026-08-b",
  secret: "current-run-correlation-key-with-more-than-32-bytes",
} satisfies RunCorrelationKey;
const PREVIOUS_KEY = {
  version: "2026-08-a",
  secret: "previous-run-correlation-key-with-more-than-32-bytes",
  acceptUntil: NOW + 60_000,
} satisfies RunCorrelationKey;
const SCOPE = {
  installation: "installed-project-01",
  surface: "mjx-main-mcp",
  partition: "user-42",
} satisfies RunCorrelationScope;
const RESOURCE_URL = "https://project.supabase.co/functions/v1/mcp";

function dependencies(): RuntimeDependencies<any> {
  let sequence = 0;
  return {
    async verifyToken() {
      throw new Error("Public proof must not verify credentials.");
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

function protocolRequest(
  runHandle: string,
  carrier: "metadata" | "argument",
): Request {
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
        arguments: carrier === "argument" ? { run_id: runHandle } : {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {
            elicitation: { form: {} },
          },
          ...(carrier === "metadata" ? { "dev.chumbo/run": runHandle } : {}),
        },
      },
    }),
  });
}

async function handle(
  nonce: string,
  overrides: Partial<Parameters<typeof mintRunHandle>[0]> = {},
): Promise<string> {
  return mintRunHandle({
    scope: SCOPE,
    key: CURRENT_KEY,
    now: NOW,
    nonce,
    ...overrides,
  });
}

async function verified(
  runHandle: string,
  overrides: Partial<Parameters<typeof verifyRunHandle>[0]> = {},
) {
  return verifyRunHandle({
    handle: runHandle,
    scope: SCOPE,
    keys: [CURRENT_KEY, PREVIOUS_KEY],
    now: NOW,
    ...overrides,
  });
}

async function expectCode(
  promise: Promise<unknown>,
  code: RunCorrelationError["code"],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "RunCorrelationError",
    code,
  });
}

describe("explicit run correlation proof", () => {
  it("preserves both carriers through the real Streamable HTTP tool boundary", async () => {
    const runHandle = await handle("run-real-mcp-boundary");
    const app = createSupabaseMcpInternal(
      {
        server: { name: "run-proof", version: "0.0.0" },
        resourceUrl: RESOURCE_URL,
        auth: { mode: "public" },
        register(server) {
          server.registerTool(
            "correlated",
            {
              inputSchema: z.object({ run_id: z.string().optional() }),
            },
            async (arguments_, context: ServerContext) => {
              const resolved = resolveRunHandle({
                requestMeta: context.mcpReq._meta,
                toolArguments: arguments_,
              });
              const fact = await verified(resolved!);
              return structuredResult({ runId: fact.id });
            },
          );
        },
      },
      dependencies(),
    );

    const metadataResponse = await app.fetch(
      protocolRequest(runHandle, "metadata"),
    );
    const argumentResponse = await app.fetch(
      protocolRequest(runHandle, "argument"),
    );
    expect(metadataResponse.status, await metadataResponse.clone().text()).toBe(
      200,
    );
    expect(argumentResponse.status, await argumentResponse.clone().text()).toBe(
      200,
    );
    const metadataBody = await metadataResponse.json();
    const argumentBody = await argumentResponse.json();
    expect(metadataBody.result.structuredContent).toEqual(
      argumentBody.result.structuredContent,
    );
    expect(metadataBody.result.structuredContent.runId).toMatch(/^run_/);
  });

  it("uses the same opaque run through controlled metadata or an explicit tool argument", async () => {
    const runHandle = await handle("run-social-post-0001");

    const controlled = resolveRunHandle({
      requestMeta: { "dev.chumbo/run": runHandle },
      toolArguments: { draft: "ignored business input" },
    });
    const generic = resolveRunHandle({
      requestMeta: {},
      toolArguments: { run_id: runHandle, draft: "ignored business input" },
    });

    expect(controlled).toBe(runHandle);
    expect(generic).toBe(runHandle);
    const controlledFact = await verified(controlled!);
    const genericFact = await verified(generic!);
    expect(controlledFact).toEqual(genericFact);
    expect(controlledFact).toMatchObject({
      schemaVersion: 1,
      id: expect.stringMatching(/^run_[A-Za-z0-9_-]+$/),
      startedAt: "2026-08-29T15:00:00.000Z",
      expiresAt: "2026-08-29T19:00:00.000Z",
    });
    expect(JSON.stringify(controlledFact)).not.toContain(
      "run-social-post-0001",
    );
  });

  it("keeps 500 interleaved calls in two explicit runs instead of inventing a session boundary", async () => {
    const firstHandle = await handle("run-batch-alpha-0001");
    const secondHandle = await handle("run-batch-bravo-0002");
    const observed = await Promise.all(
      Array.from({ length: 500 }, async (_, index) => {
        const expectedHandle = index % 2 === 0 ? firstHandle : secondHandle;
        const carrier =
          index % 4 < 2
            ? { requestMeta: { "dev.chumbo/run": expectedHandle } }
            : { toolArguments: { run_id: expectedHandle } };
        const resolved = resolveRunHandle(carrier);
        return (await verified(resolved!)).id;
      }),
    );
    const firstId = (await verified(firstHandle)).id;
    const secondId = (await verified(secondHandle)).id;

    expect(firstId).not.toBe(secondId);
    expect(observed.filter((id) => id === firstId)).toHaveLength(250);
    expect(observed.filter((id) => id === secondId)).toHaveLength(250);
    expect(new Set(observed)).toEqual(new Set([firstId, secondId]));
  });

  it("lets a headless workspace partition guarded state by run under one credential", async () => {
    const first = await verified(await handle("file-ide-run-alpha"));
    const second = await verified(await handle("file-ide-run-bravo"));
    const documentPath = "docs/launch-plan.md";
    const observationKey = (runId: string) =>
      `${runId}:observation:${documentPath}`;

    expect(observationKey(first.id)).not.toBe(observationKey(second.id));
    expect(first.id).not.toBe(second.id);
  });

  it("treats missing correlation as truthful invocation-only telemetry and rejects carrier disagreement", async () => {
    const firstHandle = await handle("run-carrier-alpha");
    const secondHandle = await handle("run-carrier-bravo");

    expect(resolveRunHandle({ requestMeta: {}, toolArguments: {} })).toBeNull();
    expect(() =>
      resolveRunHandle({
        requestMeta: { "dev.chumbo/run": firstHandle },
        toolArguments: { run_id: secondHandle },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RunCorrelationError>>({
        code: "ambiguous_carrier",
      }),
    );
    expect(() =>
      resolveRunHandle({ toolArguments: { run_id: 42 } }),
    ).toThrowError(
      expect.objectContaining<Partial<RunCorrelationError>>({
        code: "invalid_carrier",
      }),
    );
  });

  it("binds handles to installation, surface, and authorized partition", async () => {
    const runHandle = await handle("run-scoped-value-0001");

    await expectCode(
      verified(runHandle, {
        scope: { ...SCOPE, installation: "another-installation" },
      }),
      "invalid_token",
    );
    await expectCode(
      verified(runHandle, { scope: { ...SCOPE, surface: "admin-mcp" } }),
      "invalid_token",
    );
    await expectCode(
      verified(runHandle, { scope: { ...SCOPE, partition: "user-43" } }),
      "invalid_token",
    );
  });

  it("accepts a previous key only during an explicit rotation overlap", async () => {
    const oldHandle = await handle("run-before-rotation", {
      key: PREVIOUS_KEY,
      ttlSeconds: 600,
    });
    const newHandle = await handle("run-after-rotation");

    await expect(verified(oldHandle)).resolves.toMatchObject({
      schemaVersion: 1,
    });
    await expect(verified(newHandle)).resolves.toMatchObject({
      schemaVersion: 1,
    });
    await expectCode(
      verified(oldHandle, { now: PREVIOUS_KEY.acceptUntil! + 1 }),
      "expired",
    );
    await expectCode(
      verified(oldHandle, { keys: [CURRENT_KEY] }),
      "unknown_key",
    );
  });

  it("rejects expired, future, tampered, oversized, and malformed handles", async () => {
    const shortHandle = await handle("run-short-lived-0001", {
      ttlSeconds: 1,
    });
    await expectCode(verified(shortHandle, { now: NOW + 1_000 }), "expired");

    const futureHandle = await handle("run-future-start-0001", {
      now: NOW + runCorrelationLimits.clockSkewMs + 1,
    });
    await expectCode(verified(futureHandle), "invalid_token");

    const validHandle = await handle("run-tamper-proof-0001");
    const tampered = `${validHandle.slice(0, -1)}${validHandle.endsWith("A") ? "B" : "A"}`;
    await expectCode(verified(tampered), "invalid_token");
    await expectCode(verified("not-a-run-handle"), "invalid_token");
    await expectCode(
      verified("x".repeat(runCorrelationLimits.tokenBytes + 1)),
      "invalid_token",
    );
  });

  it("bounds secrets, identifiers, TTL, and duplicate rotation versions", async () => {
    await expectCode(
      handle("run-invalid-secret", {
        key: { version: "short", secret: "too-short" },
      }),
      "invalid_key",
    );
    await expectCode(
      handle("run-invalid-ttl", {
        ttlSeconds: runCorrelationLimits.maxTtlSeconds + 1,
      }),
      "invalid_token",
    );
    await expectCode(handle("tiny"), "invalid_token");

    const runHandle = await handle("run-duplicate-version");
    await expectCode(
      verified(runHandle, {
        keys: [CURRENT_KEY, { ...CURRENT_KEY, secret: PREVIOUS_KEY.secret }],
      }),
      "invalid_key",
    );
  });
});
