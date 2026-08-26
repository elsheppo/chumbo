# Identity, scopes, and RLS

Chumbo normalizes a verified request into `ctx`, but it does not replace the
application's authorization model. Authentication selects the principal and
request-scoped client; capability scopes shape discovery; the application's
grants, RLS, RPCs, or APIs remain authoritative for data access.

## Supabase users

OAuth and bearer requests provide a verified Supabase user, JWT claims, and a
`ctx.supabase` client carrying that request's token. Query with this client so
existing grants and RLS select the caller's rows.

Do not accept a user or owner ID from tool input and then query for it. Derive
ownership from the authenticated session and let the existing policy enforce
it. `TO authenticated` alone proves only that a token exists; ownership still
requires the application's row predicate. An update policy normally needs both
`USING` and `WITH CHECK`, plus the SELECT policy required by Postgres updates.

Never authorize from user-editable metadata. If the application uses JWT
claims for authority, use server-controlled app metadata and account for claim
refresh latency.

## Application API keys

A verifier-backed key produces an application-owned `subject`, optional
`clientId`, and scopes. It does not create a Supabase Auth user:

- `ctx.user` is null;
- `ctx.subject` identifies the verified application principal;
- `ctx.supabase` uses the anonymous role;
- the verifier's `supabaseAdmin` exists only while resolving the credential.

Do not leak that admin client into `register` or close over it from a handler.
For privileged reads or mutations, call the application's existing narrow RPC
or data-plane API, or forward the caller credential to an existing
verifier-aware service. Do not create a general service-role path merely to make
the MCP work.

## Multiple authentication strategies

One endpoint may accept a Supabase user token and application-owned keys. Use
`mode: "multi"` with deterministic, non-overlapping key prefixes so a token is
routed to exactly one strategy before verification. A failed prefixed key must
not fall through and be retried as a user token.

Give strategies stable names for logs and policy decisions. Resolve scopes from
the verified principal:

```ts
const app = createSupabaseMcp({
  server: { name: "Directory MCP", version: "1.0.0" },
  resourceUrl,
  auth: {
    mode: "multi",
    strategies: [
      { mode: "oauth", strategy: "supabase-user" },
      {
        mode: "api-key",
        strategy: "directory-key",
        tokenPrefix: "dir_",
        verify: resolveDirectoryKey,
      },
    ],
  },
  access: {
    resolveScopes(ctx) {
      return ctx.authentication.mode === "oauth"
        ? ["directory:owner"]
        : ctx.scopes;
    },
  },
  register,
});
```

The example scope names belong to that application. Chumbo does not define
owner, moderator, administrator, tenant, or plan roles.

## Capability discovery

Register restricted surfaces through the scoped server:

```ts
server
  .withScopes(["directory:moderate"])
  .registerTool("approve_submission", options, handler);
```

The same mechanism applies to tools, Resources, and prompts. Unauthorized
capabilities should be absent from discovery and disabled on direct invocation.
Do not rely on an in-handler role check while advertising the capability to
everyone.

Scope filtering and data-plane authorization solve different problems. Keep
both: discovery should describe what this principal can do, while RLS, grants,
or the existing application API must still reject a bypass.

## Public endpoints and isolation

Public mode uses the anonymous role and must retain the generated
Postgres-backed limiter. Public does not mean service role or unrestricted
tables.

Every request receives a fresh server and request-scoped context. Tests for
identity-sensitive work should issue concurrent requests from distinct users or
principals and prove their discoveries and rows never cross.
