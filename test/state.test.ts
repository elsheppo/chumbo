import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createSupabaseMcpStateFactory,
  durableStateLimits,
  SupabaseMcpStateConflictError,
  SupabaseMcpStateMissingError,
  SupabaseMcpStateUnavailableError,
} from "../src/state.js";
import type {
  SupabaseMcpAuthentication,
  SupabaseMcpDurableStateOptions,
} from "../src/types.js";

const HMAC_KEY = "state-test-key-that-is-at-least-thirty-two-bytes";
const auth = (
  mode: "oauth" | "bearer" | "api-key",
  strategy: string = mode,
): SupabaseMcpAuthentication => ({ mode, strategy });

interface StoredState {
  valueText: string;
  revision: number;
  expiresAt: number;
}

class MemoryStateBackend {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  readonly rows = new Map<string, StoredState>();
  now = Date.parse("2026-08-26T04:00:00.000Z");
  failure?: Error;
  responseOverride?: unknown;

  readonly client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      this.calls.push({ name, args });
      if (this.failure) return { data: null, error: this.failure };
      if (this.responseOverride !== undefined) {
        return { data: this.responseOverride, error: null };
      }
      return { data: [this.execute(name, args)], error: null };
    },
    adminMarker: "must-never-escape",
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
        if (current) {
          return { status: "conflict", revision: current.revision };
        }
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

function options(
  overrides: Partial<SupabaseMcpDurableStateOptions> = {},
): SupabaseMcpDurableStateOptions {
  return {
    hmacKey: HMAC_KEY,
    namespaces: {
      observations: { ttlSeconds: 60, maxTtlSeconds: 120 },
      drafts: { ttlSeconds: 30 },
    },
    ...overrides,
  };
}

async function store(
  backend: MemoryStateBackend,
  credential: string,
  authentication: SupabaseMcpAuthentication = auth("oauth"),
  configured = options(),
) {
  return createSupabaseMcpStateFactory(configured).create(
    { credential, authentication },
    backend.client,
  );
}

describe("credential-partitioned durable state", () => {
  it("isolates principals, rotated tokens, API keys, namespaces, and keys", async () => {
    const backend = new MemoryStateBackend();
    const aliceFirst = await store(backend, "alice-token-1");
    const aliceRotated = await store(backend, "alice-token-2");
    const bob = await store(backend, "bob-token");
    const apiKeyOne = await store(
      backend,
      "app_key_one",
      auth("api-key", "application-key"),
    );
    const apiKeyTwo = await store(
      backend,
      "app_key_two",
      auth("api-key", "application-key"),
    );

    await aliceFirst.put("observations", "/notes.md", {
      value: { version: "v1" },
      expectedRevision: null,
    });
    await apiKeyOne.put("observations", "/notes.md", {
      value: { version: "api-v1" },
      expectedRevision: null,
    });

    expect(await aliceFirst.get("observations", "/notes.md")).toMatchObject({
      value: { version: "v1" },
      revision: 1,
    });
    expect(await aliceRotated.get("observations", "/notes.md")).toBeNull();
    expect(await bob.get("observations", "/notes.md")).toBeNull();
    expect(await apiKeyTwo.get("observations", "/notes.md")).toBeNull();
    expect(await apiKeyOne.get("observations", "/notes.md")).toMatchObject({
      value: { version: "api-v1" },
    });
    expect(await aliceFirst.get("drafts", "/notes.md")).toBeNull();
    expect(await aliceFirst.get("observations", "/other.md")).toBeNull();

    const serializedCalls = JSON.stringify(backend.calls);
    for (const secret of [
      HMAC_KEY,
      "alice-token-1",
      "alice-token-2",
      "bob-token",
      "app_key_one",
      "app_key_two",
    ]) {
      expect(serializedCalls).not.toContain(secret);
    }
    const callerKeys = new Set(
      backend.calls.map((call) => String(call.args.p_caller_key)),
    );
    expect(callerKeys.size).toBe(5);
    for (const callerKey of callerKeys) {
      expect(callerKey).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("prevents cross-deployment credential correlation", async () => {
    const first = new MemoryStateBackend();
    const second = new MemoryStateBackend();
    const firstStore = await store(first, "same-token");
    const secondStore = await store(
      second,
      "same-token",
      auth("oauth"),
      options({ hmacKey: `${HMAC_KEY}-different-deployment` }),
    );
    await firstStore.get("observations", "same-key");
    await secondStore.get("observations", "same-key");
    expect(first.calls[0]?.args.p_caller_key).not.toBe(
      second.calls[0]?.args.p_caller_key,
    );
  });

  it("serializes a compare-and-swap race and revision-checks delete", async () => {
    const backend = new MemoryStateBackend();
    const state = await store(backend, "writer-token");
    const created = await state.put("observations", "/race.md", {
      value: { winner: "none" },
      expectedRevision: null,
    });
    expect(created.revision).toBe(1);

    const race = await Promise.allSettled([
      state.put("observations", "/race.md", {
        value: { winner: "first" },
        expectedRevision: 1,
      }),
      state.put("observations", "/race.md", {
        value: { winner: "second" },
        expectedRevision: 1,
      }),
    ]);
    expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    const rejection = race.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({
      reason: expect.any(SupabaseMcpStateConflictError),
    });
    const current = await state.get("observations", "/race.md");
    expect(current?.revision).toBe(2);

    await expect(
      state.delete("observations", "/race.md", { expectedRevision: 1 }),
    ).rejects.toMatchObject({
      code: "state_conflict",
      actualRevision: 2,
    });
    expect(
      await state.delete("observations", "/race.md", {
        expectedRevision: 2,
      }),
    ).toBe(true);
    expect(
      await state.delete("observations", "/race.md", {
        expectedRevision: 2,
      }),
    ).toBe(false);
  });

  it("treats expiry as missing and enforces TTL boundaries", async () => {
    const backend = new MemoryStateBackend();
    const state = await store(backend, "ttl-token");
    await expect(
      state.put("observations", "zero", {
        value: null,
        expectedRevision: null,
        ttlSeconds: 0,
      }),
    ).rejects.toThrow("TTL");
    await expect(
      state.put("observations", "too-long", {
        value: null,
        expectedRevision: null,
        ttlSeconds: 121,
      }),
    ).rejects.toThrow("TTL");

    await state.put("observations", "short", {
      value: { alive: true },
      expectedRevision: null,
      ttlSeconds: 1,
    });
    backend.now += 999;
    expect(await state.get("observations", "short")).not.toBeNull();
    backend.now += 1;
    expect(await state.get("observations", "short")).toBeNull();
    await expect(
      state.put("observations", "short", {
        value: { alive: false },
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(SupabaseMcpStateMissingError);
    expect(
      await state.put("observations", "short", {
        value: { alive: true },
        expectedRevision: null,
        ttlSeconds: 120,
      }),
    ).toMatchObject({ revision: 1 });
  });

  it("bounds namespace, key, JSON, and encoded value inputs before RPC", async () => {
    expect(() =>
      createSupabaseMcpStateFactory(
        options({ namespaces: { "../escape": { ttlSeconds: 60 } } }),
      ),
    ).toThrow("namespaces");
    expect(() =>
      createSupabaseMcpStateFactory(options({ hmacKey: "too-short" })),
    ).toThrow("hmacKey");

    const backend = new MemoryStateBackend();
    const state = await store(backend, "bounded-token");
    await expect(state.get("missing", "key")).rejects.toThrow("not configured");
    await expect(state.get("observations", " bad ")).rejects.toThrow("keys");
    await expect(state.get("observations", "bad\u0000key")).rejects.toThrow(
      "keys",
    );
    await expect(state.get("observations", "e\u0301")).rejects.toThrow("NFC");
    await expect(state.get("observations", "é".repeat(257))).rejects.toThrow(
      "512 bytes",
    );

    const boundary = "a".repeat(durableStateLimits.valueBytes - 2);
    await expect(
      state.put("observations", "boundary", {
        value: boundary,
        expectedRevision: null,
      }),
    ).resolves.toMatchObject({ revision: 1 });
    await expect(
      state.put("observations", "over", {
        value: `${boundary}a`,
        expectedRevision: null,
      }),
    ).rejects.toThrow(`${durableStateLimits.valueBytes}`);
    await expect(
      state.put("observations", "not-json", {
        value: BigInt(1) as never,
        expectedRevision: null,
      }),
    ).rejects.toThrow("valid JSON");
  });

  it("fails closed with generic errors for backend and oversized reads", async () => {
    const backend = new MemoryStateBackend();
    const state = await store(backend, "secret-caller-token");
    backend.failure = new Error(
      "database failed with service-role=secret-admin-value",
    );
    await expect(state.get("observations", "safe-key")).rejects.toEqual(
      new SupabaseMcpStateUnavailableError(),
    );

    backend.failure = undefined;
    backend.responseOverride = [
      {
        status: "found",
        value_text: `"${"x".repeat(durableStateLimits.valueBytes)}"`,
        revision: 1,
        expires_at: "2026-08-26T05:00:00.000Z",
      },
    ];
    await expect(state.get("observations", "safe-key")).rejects.toEqual(
      new SupabaseMcpStateUnavailableError(),
    );
  });
});
