# Observation before action

Use this advanced pattern when an authenticated MCP must remember what an
exact credential observed across otherwise stateless Edge Function requests.
The motivating case is guarded editing: a caller may change a document only
after reading a version that is still current.

This pattern is optional. Ordinary Supa MCP servers should continue to use the
request-scoped Supabase client and remain stateless.

## The contract

The live path is:

```text
authenticated read
→ load content and resource version from one authoritative snapshot
→ store an observation receipt under an immutable, scoped resource ID
→ later mutation loads that caller's receipt
→ application data plane atomically checks the observed resource version
→ successful mutation advances or invalidates the receipt
```

There are two independent revisions:

- `resourceVersion` belongs to the application document or row. The
  application database must compare it atomically while performing the
  mutation.
- `state.revision` belongs only to the durable observation receipt. Supa MCP
  uses it to prevent concurrent receipt updates from silently overwriting one
  another.

Never treat state CAS as a replacement for RLS or application-level optimistic
concurrency.

## Use immutable, bounded keys

Resolve mutable paths or names before recording an observation. Prefer a key
derived from immutable application identity:

```ts
const receiptKey = `project:${projectId}:document:${documentId}`;
```

Do not derive an unbounded keyspace directly from arbitrary tool input. Supa
MCP bounds every namespace, key, value, revision, and TTL, but capability code
still owns total live cardinality. A safe capability creates receipts only for
real, authorized resources and uses one stable key per resource.

If the policy is narrower than a full-resource read, record that scope in the
receipt:

```ts
{
  resourceVersion: 17,
  observedBlocks: [4, 5],
  observedAt: "2026-08-26T12:00:00.000Z"
}
```

The mutation must then verify both the resource version and the required
scope. Merely describing “read before write” in a tool description is not an
enforcement boundary.

## Preserve safe ordering

The application row and the observation receipt may live in different
databases, so no transaction spans both. Use this order:

1. Load and validate the receipt.
2. Perform the authoritative domain mutation with the receipt's
   `resourceVersion` as an atomic precondition.
3. Only after success, advance or invalidate the receipt.

If step 3 fails after the domain mutation succeeds, report that the mutation
succeeded but require a reread before another mutation. That is a safe false
negative. Advancing the receipt before the domain write could create false
authorization and is unsafe.

Missing or expired state, credential rotation, and state-service failure must
all fail closed for guarded mutations. Return an actionable instruction to
reread or retry; never silently bypass the observation requirement.

## Identity semantics

Supa MCP partitions state by the exact authenticated credential, authentication
mode, and strategy. Different credentials for the same user do not share
receipts. Credential refresh therefore requires a new read. Conversely, two
agents deliberately sharing one credential also share its receipt partition;
use distinct credentials when they require distinct observation histories.

The partition is a deployment-keyed HMAC and is never exposed to capability
code. Capability code receives only `get`, revision-checked `put`, and
revision-checked `delete`.

## Same-project and split-project deployments

The normal deployment keeps authentication, application data, and durable
state in the existing Supabase project. No extra database is required.

An advanced control-plane composition may keep authentication and application
data in project A while project B owns only the private state table:

1. Apply the generated durable-state migration to project B.
2. Store project B's URL and secret key as Edge Function secrets in project A
   under dedicated names.
3. Build `stateOwnerProjectEnv` from only those dedicated secrets and pass it
   as `state.supabase.env`.
4. Keep authentication verification and `ctx.supabase` configured with project
   A. Never put project B's service credential on the capability context.

The split changes only receipt storage. The application data plane remains
authoritative and must still enforce its own authorization and version check.

## Why this is not a Durable Object runtime

This pattern provides durable, caller-isolated coordination state. It does not
provide resident actors, automatic serialized command execution, queues,
alarms, leases, or messaging. Concurrent requests are expected; state CAS and
the domain's atomic precondition decide the winners.

The living example deliberately keeps this policy outside the Supa MCP starter
template. It records full-document observations, rejects blind and stale edits,
and proves that only one concurrent mutation can win.

Source:

- `supabase/functions/observation-before-action/`
- `supabase/migrations/*_observation_before_action_reference.sql`
- `supabase/tests/reference_integration_test.ts`

Official platform references:

- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [Database functions](https://supabase.com/docs/guides/database/functions)
- [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
