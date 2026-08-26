import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  createSupabaseMcpStateFactory,
  SupabaseMcpStateConflictError,
  SupabaseMcpStateMissingError,
} from "../src/state.js";

const url = process.env.SUPABASE_INTEGRATION_URL;
const publishableKey = process.env.SUPABASE_INTEGRATION_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_INTEGRATION_SECRET_KEY;
const dbUrl = process.env.SUPABASE_INTEGRATION_DB_URL;
const enabled = Boolean(url && publishableKey && secretKey && dbUrl);

interface RawPutRow {
  status: string;
  revision: number;
  reclaimed_count: number;
}

interface RawLocator {
  callerKey: string;
  objectKey: string;
}

const retentionLiveLocator = {
  callerKey: "f".repeat(64),
  objectKey: "retention-live-row",
};

function randomCallerKey(): string {
  const value = crypto.randomUUID().replaceAll("-", "");
  return `${value}${value}`;
}

async function rawPut(
  admin: SupabaseClient,
  objectKey: string,
): Promise<{ locator: RawLocator; row: RawPutRow }> {
  const locator = { callerKey: randomCallerKey(), objectKey };
  const { data, error } = await admin.rpc("supa_mcp_state_put", {
    p_namespace: "integration",
    p_caller_key: locator.callerKey,
    p_object_key: locator.objectKey,
    p_value_text: JSON.stringify({ sweep: objectKey }),
    p_expected_revision: null,
    p_ttl_seconds: 60,
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as RawPutRow | undefined;
  expect(row).toMatchObject({ status: "written", revision: 1 });
  expect(row?.reclaimed_count).toBeGreaterThanOrEqual(0);
  expect(row?.reclaimed_count).toBeLessThanOrEqual(16);
  return { locator, row: row! };
}

async function rawDelete(
  admin: SupabaseClient,
  locator: RawLocator,
): Promise<void> {
  const { error } = await admin.rpc("supa_mcp_state_delete", {
    p_namespace: "integration",
    p_caller_key: locator.callerKey,
    p_object_key: locator.objectKey,
    p_expected_revision: 1,
  });
  if (error) throw error;
}

function seedExpiredPartitions(): void {
  const sql = `
    truncate table private.supa_mcp_state;
    insert into private.supa_mcp_state (
      namespace,
      caller_key,
      object_key,
      value,
      value_bytes,
      revision,
      expires_at,
      updated_at
    )
    select
      'integration',
      lpad(to_hex(item), 64, '0'),
      'retired-object-' || item,
      '{"retired":true}'::jsonb,
      octet_length('{"retired":true}'::jsonb::text),
      1,
      clock_timestamp() - interval '1 second',
      clock_timestamp()
    from generate_series(1, 33) as item;

    insert into private.supa_mcp_state (
      namespace,
      caller_key,
      object_key,
      value,
      value_bytes,
      revision,
      expires_at,
      updated_at
    ) values (
      'integration',
      '${"f".repeat(64)}',
      'retention-live-row',
      '{"live":true}'::jsonb,
      octet_length('{"live":true}'::jsonb::text),
      1,
      clock_timestamp() + interval '5 minutes',
      clock_timestamp()
    );
  `;
  const result = spawnSync(
    "psql",
    [dbUrl!, "--no-psqlrc", "--set=ON_ERROR_STOP=1", "--quiet"],
    {
      encoding: "utf8",
      input: sql,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new Error("Could not prepare the local retention fixture.");
  }
}

describe.skipIf(!enabled)("real Postgres durable state", () => {
  it("enforces grants, credential isolation, atomic CAS, expiry, and delete", async () => {
    const admin = createClient(url!, secretKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const anonymous = createClient(url!, publishableKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const denied = await anonymous.rpc("supa_mcp_state_get", {
      p_namespace: "integration",
      p_caller_key: "a".repeat(64),
      p_object_key: "denied",
    });
    expect(denied.data).toBeNull();
    expect(denied.error?.message).toMatch(/permission denied/i);

    const directTable = await anonymous
      .schema("private")
      .from("supa_mcp_state")
      .select("namespace");
    expect(directTable.data).toBeNull();
    expect(directTable.error).not.toBeNull();

    const factory = createSupabaseMcpStateFactory({
      hmacKey: "integration-key-at-least-thirty-two-random-bytes",
      namespaces: {
        integration: { ttlSeconds: 30, maxTtlSeconds: 60 },
      },
    });
    const suffix = crypto.randomUUID();
    const first = await factory.create(
      {
        credential: `first-${suffix}`,
        authentication: { mode: "bearer", strategy: "integration" },
      },
      admin,
    );
    const second = await factory.create(
      {
        credential: `second-${suffix}`,
        authentication: { mode: "bearer", strategy: "integration" },
      },
      admin,
    );
    const key = `race-${suffix}`;

    const created = await first.put("integration", key, {
      value: { state: "created" },
      expectedRevision: null,
    });
    expect(created.revision).toBe(1);
    expect(await second.get("integration", key)).toBeNull();

    const race = await Promise.allSettled([
      first.put("integration", key, {
        value: { state: "alpha" },
        expectedRevision: 1,
      }),
      first.put("integration", key, {
        value: { state: "beta" },
        expectedRevision: 1,
      }),
    ]);
    expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    const rejected = race.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: expect.any(SupabaseMcpStateConflictError),
    });
    const current = await first.get("integration", key);
    expect(current?.revision).toBe(2);

    await expect(
      first.delete("integration", key, { expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(SupabaseMcpStateConflictError);
    expect(
      await first.delete("integration", key, { expectedRevision: 2 }),
    ).toBe(true);
    expect(await first.get("integration", key)).toBeNull();

    const expiringKey = `expiry-${suffix}`;
    await first.put("integration", expiringKey, {
      value: { expires: true },
      expectedRevision: null,
      ttlSeconds: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await first.get("integration", expiringKey)).toBeNull();
    await expect(
      first.put("integration", expiringKey, {
        value: { stale: true },
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(SupabaseMcpStateMissingError);
  }, 30_000);

  it("reclaims unreachable expired partitions in bounded concurrent batches", async () => {
    const admin = createClient(url!, secretKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    seedExpiredPartitions();
    const sweepLocators: RawLocator[] = [];
    const suffix = crypto.randomUUID();

    const first = await rawPut(admin, `sweep-first-${suffix}`);
    sweepLocators.push(first.locator);
    expect(first.row.reclaimed_count).toBe(16);

    const concurrent = await Promise.all([
      rawPut(admin, `sweep-concurrent-a-${suffix}`),
      rawPut(admin, `sweep-concurrent-b-${suffix}`),
    ]);
    sweepLocators.push(...concurrent.map((result) => result.locator));
    expect(
      concurrent.reduce((sum, result) => sum + result.row.reclaimed_count, 0),
    ).toBe(17);
    expect(concurrent.every((result) => result.row.reclaimed_count <= 16)).toBe(
      true,
    );

    const exhausted = await rawPut(admin, `sweep-exhausted-${suffix}`);
    sweepLocators.push(exhausted.locator);
    expect(exhausted.row.reclaimed_count).toBe(0);
    const live = await admin.rpc("supa_mcp_state_get", {
      p_namespace: "integration",
      p_caller_key: retentionLiveLocator.callerKey,
      p_object_key: retentionLiveLocator.objectKey,
    });
    expect(live.error).toBeNull();
    expect(Array.isArray(live.data) ? live.data[0] : live.data).toMatchObject({
      status: "found",
      revision: 1,
    });

    await Promise.all(
      [...sweepLocators, retentionLiveLocator].map((locator) =>
        rawDelete(admin, locator),
      ),
    );
  }, 30_000);
});
