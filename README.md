# create-supabase-mcp

Add an end-user MCP server to a Supabase app, with OAuth and Row Level
Security already wired.

```sh
cd your-supabase-project
npx create-supabase-mcp init
supabase functions deploy mcp --no-verify-jwt
```

Your MCP handlers receive a request-scoped `ctx.supabase` client carrying the
connected user's access token. Queries therefore run through the same RLS
policies as the rest of your application.

This is for exposing your application's own capabilities to its users. It is
not the official Supabase management MCP, which lets agents administer a
Supabase project.

## Quickstart

You need an existing Supabase repository with `supabase/config.toml`, Node 22+
for the initializer, and the Supabase CLI.

```sh
npx create-supabase-mcp init
```

The command previews every write and generates:

```text
supabase/functions/mcp/
├── index.ts
├── capabilities.ts
├── deno.json
├── index_test.ts
└── README.md
```

It also adds this required gateway setting without replacing the rest of your
config:

```toml
[functions.mcp]
verify_jwt = false
```

That setting does **not** make the MCP server public. It lets the Edge Function
answer unauthenticated requests with MCP's OAuth discovery challenge. The
function then validates Supabase JWTs itself before MCP dispatch.

Run the generated checks and function:

```sh
deno task --config supabase/functions/mcp/deno.json test
supabase functions serve mcp
```

For a non-interactive initialization:

```sh
npx create-supabase-mcp init \
  --function mcp \
  --server-name "My app" \
  --auth oauth \
  --yes
```

Use `--dry-run` to inspect the file plan without writing. Existing files are
never silently overwritten, and an identical re-run is a no-op.

## Write application capabilities

The package intentionally uses the official MCP SDK's registration API. There
is no parallel tool framework to learn.

```ts
import {
  jsonResult,
  type SupabaseMcpContext,
  type SupabaseMcpServer,
} from "create-supabase-mcp";
import { z } from "zod";

export function registerCapabilities(
  server: SupabaseMcpServer,
  ctx: SupabaseMcpContext,
) {
  server.registerTool(
    "list_projects",
    {
      description: "List projects visible to the connected user.",
      inputSchema: z.object({}),
    },
    async () => {
      const { data, error } = await ctx.supabase
        .from("projects")
        .select("id, name, status")
        .order("name");

      if (error) throw error;
      return jsonResult({ projects: data });
    },
  );
}
```

The generated example also shows a resource, prompt, and MCP 2026-07-28
multi-round-trip confirmation flow. Advanced features remain available through
the underlying `McpServer`.

## Authentication modes

### OAuth

`oauth` is the default for an end-user server. The Edge Function:

1. returns a Bearer challenge pointing to function-local protected-resource
   metadata;
2. advertises the project's Supabase Auth OAuth issuer;
3. validates the resulting Supabase access token;
4. constructs one RLS-scoped client for that request;
5. passes the client and verified identity to every registered capability.

Enable Supabase OAuth Server in **Authentication → OAuth Server**, configure an
application-owned authorization/consent page, and enable dynamic client
registration for clients that need it. Supabase currently supports the
standard identity scopes (`openid`, `email`, `profile`, and `phone`), not custom
application scopes. Use RLS and, where useful, the OAuth token's `client_id`
claim for application authorization.

For a runnable fallback consent screen:

```sh
npx create-supabase-mcp init --consent minimal
supabase functions deploy mcp-consent --no-verify-jwt
```

Point the Supabase OAuth authorization path at the resulting function. Existing
applications should normally integrate the three Supabase authorization calls
into their own signed-in frontend instead. The fallback reads the hosted
`SUPABASE_PUBLISHABLE_KEYS` environment automatically and also accepts the
single-key local CLI environment.

### Bearer

`--auth bearer` accepts an existing Supabase user access token without
advertising an interactive OAuth flow. It is useful for tests, internal client
configuration, and incremental adoption. RLS behavior is identical to OAuth.

### Public

`--auth public` must be selected explicitly. The context uses an anonymous
Supabase client, so only capabilities and rows intentionally available to the
`anon` role can be reached. New public scaffolds also include a private,
Postgres-backed limit of 60 requests per minute per caller. Apply the generated
migration with `supabase db push` before serving or deploying the function.

## Access control (optional)

The starter does not require scopes. Add them only when one MCP connection
should expose fewer capabilities than another:

```ts
export function registerCapabilities(
  server: SupabaseMcpServer,
  ctx: SupabaseMcpContext,
) {
  server
    .withScopes(["projects:read"])
    .registerTool("list_projects", { inputSchema: z.object({}) }, async () =>
      jsonResult({ projects: [] }),
    );

  server
    .withScopes(["projects:write"])
    .registerTool(
      "create_project",
      { inputSchema: z.object({ name: z.string() }) },
      async ({ name }) => jsonResult({ name }),
    );
}
```

Capabilities registered normally remain available normally. Scoped tools,
resources, prompts, and resource templates are omitted from discovery unless
the request has every required scope. `ctx.hasScope()` and `ctx.hasScopes()`
are available for finer application decisions.

OAuth and bearer modes begin with scopes carried by the verified token. Public
mode can declare deliberately narrow scopes with `auth.scopes`. Applications
that keep grants in their own tables can resolve the authoritative scope list
through the request's existing RLS-aware client:

```ts
createSupabaseMcp({
  // ordinary server, resourceUrl, auth, and register options
  access: {
    async resolveScopes(ctx) {
      const { data, error } = await ctx.supabase.rpc("my_mcp_scopes");
      if (error) throw error;
      return data;
    },
  },
});
```

Scope names and storage belong to the application. The package does not add an
organization, role, or entitlement model, and RLS remains the row-level
authority.

## Deploy and diagnose

```sh
supabase functions deploy mcp --no-verify-jwt

npx create-supabase-mcp doctor \
  --function mcp \
  --url https://PROJECT_REF.supabase.co/functions/v1/mcp
```

`doctor` verifies generated files, dependency pins, the gateway setting, the
OAuth challenge, and protected-resource metadata. Add `--token "$USER_JWT"`
to make an authenticated `tools/list` request.

The MCP endpoint is:

```text
https://PROJECT_REF.supabase.co/functions/v1/mcp
```

Connect that URL from an MCP client. The client follows the 401 challenge to
the function-local metadata document, discovers Supabase Auth, completes PKCE,
and retries with the user's access token.

## RLS and multi-tenancy

Edge compute is shared; authorization state is not. The runtime creates a new
MCP server, context object, and Supabase client for every request. It stores no
current user, organization, token, or tenant result in mutable module state.

RLS still needs to express your application's actual ownership model. A simple
user-owned table might use:

```sql
create policy "Users read their own items"
on public.items
for select
to authenticated
using ((select auth.uid()) = user_id);
```

That is only an example: teams, organizations, grants, and ownership columns
remain application-defined.

Do not introduce a service-role client into end-user handlers. Cached rows are
outside RLS after they enter memory, so any application cache must use a
verified tenant and version in its key.

The [multi-tenant example](./examples/multi-tenant) includes namespaced tables,
explicit Data API grants, RLS policies, and a two-user negative isolation test.

## Public API

```ts
createSupabaseMcp(options): SupabaseMcpApp
jsonResult(value, text?)
textResult(text)
errorResult(message)
```

`CreateSupabaseMcpOptions` accepts:

- `server`: official MCP implementation name and version;
- `resourceUrl`: the deployed MCP URL;
- `auth`: `oauth`, `bearer`, or `public`;
- `access.resolveScopes`: optional application-owned scope resolution;
- `register(server, ctx)`: per-request capability registration;
- `supabase.env`: optional environment overrides for non-Supabase runtimes;
- `protocol`: legacy compatibility and response-mode controls;
- `onError`: a narrow redacted logging hook.

The returned object has `fetch`, `close`, and MCP notification methods and can
be exported directly from a Supabase Edge Function.

## Compatibility

Version 0.2.0 pins:

- MCP TypeScript SDK `2.0.0` and protocol `2026-07-28`;
- stateless compatibility for 2025-era Streamable HTTP clients;
- `@supabase/server` `1.4.1`;
- Supabase JS `2.105.4`;
- Zod `4.2.0`.

The automated suite covers modern discovery, scoped tools/resources/prompts,
public rate limiting, multi-round-trip input, OAuth challenges, Deno-generated
output, concurrent request isolation, and real two-user Postgres RLS.

## Troubleshooting

**The endpoint returns `Missing authorization header` without
`resource_metadata`.** The gateway is intercepting requests. Ensure
`[functions.mcp] verify_jwt = false` and deploy with `--no-verify-jwt`.

**OAuth discovery returns 502.** Confirm Supabase OAuth Server is enabled and
that `https://PROJECT_REF.supabase.co/.well-known/oauth-authorization-server/auth/v1`
returns JSON whose issuer ends in `/auth/v1`.

**Authentication succeeds but tools return no rows.** The runtime is working;
inspect table grants and RLS policies. RLS can correctly return an empty result
without producing an authorization error.

**Public mode returns `rate_limit_unavailable`.** Apply the generated migration
with `supabase db push` and confirm the Edge Function has access to the
project's managed secret key environment.

**Dynamic registration fails.** Enable it in Supabase OAuth Server settings,
and verify the client's redirect URI is complete and exact.

**`init` reports a conflict.** It found an existing target file with different
contents and refused to replace it. Move or merge that file explicitly, then
run the initializer again.

## Development

```sh
pnpm install
pnpm check
pnpm run test:rls # requires the documented integration environment variables
npm pack --dry-run
```

The detailed product contract and architectural decisions remain in
[SPEC.md](./SPEC.md). Released under the [MIT License](./LICENSE).
