# Supa MCP

**Your Supabase app, now an MCP.**

Run one command to add a polished end-user MCP server to an existing Supabase
app. It runs as an Edge Function and uses the app's Supabase Auth, Postgres,
and Row Level Security instead of introducing another backend.

This package exposes your application's capabilities to its users. It is not
the official Supabase management MCP used to administer Supabase projects.

## Guided setup

From a repository that already contains `supabase/config.toml`:

```sh
npx supa-mcp setup
```

The installer requires Node 22+ and the Supabase CLI. Deno is recommended for
the generated local type-check and test; when it is unavailable, setup reports
those checks as an explicit next action instead of hanging or pretending they
ran.

The installer asks who should be able to connect and which URL they should
use, previews every file it will write, generates the Edge Function, and runs
its local checks when Deno is available. It then gives you an ordered list of
the remaining migration, deployment, OAuth, routing, and verification actions.

The three access choices are:

1. **Supabase OAuth** — recommended when your app's users will connect their
   accounts from an MCP client.
2. **Bearer token** — useful when your platform already gives clients a
   Supabase user access token.
3. **Public** — anonymous access through the Supabase `anon` role, with a
   generated Postgres rate limiter.

Setup is resumable without a hidden state file:

```sh
npx supa-mcp setup --resume
npx supa-mcp status
```

Both commands inspect the generated project and, when a project ref or URL is
available, the deployed endpoint. Re-running setup does not overwrite an
application-authored capability file.

### What gets generated

```text
supabase/functions/mcp/
├── index.ts
├── capabilities.ts
├── deno.json
├── index_test.ts
└── README.md
```

The initializer also adds the required function gateway setting without
replacing the rest of `supabase/config.toml`:

```toml
[functions.mcp]
verify_jwt = false
```

This does not make an authenticated MCP public. It lets the Edge Function
answer an unauthenticated request with the MCP OAuth challenge before the
function validates the resulting Supabase access token itself.

## Agent and CI setup

Agents should use the non-interactive JSON interface instead of parsing
terminal prose.

Inspect the complete plan without writing:

```sh
npx supa-mcp setup --auth oauth --plan --json
```

Apply it and receive structured next actions:

```sh
npx supa-mcp setup \
  --auth oauth \
  --function mcp \
  --server-name "My app" \
  --yes \
  --json
```

Resume or re-observe after a user completes a dashboard action:

```sh
npx supa-mcp setup --resume --function mcp --yes --json
npx supa-mcp status --function mcp --json
```

JSON output has a versioned envelope and stable step IDs:

```json
{
  "schemaVersion": 1,
  "command": "setup",
  "status": "needs_user_action",
  "functionName": "mcp",
  "auth": "oauth",
  "steps": [
    { "id": "scaffold", "status": "complete" },
    { "id": "local_checks", "status": "complete" },
    { "id": "deploy", "status": "ready" },
    { "id": "configure_oauth", "status": "needs_user_action" },
    { "id": "verify_remote", "status": "ready" }
  ],
  "nextActions": [
    { "id": "deploy", "status": "ready" },
    { "id": "configure_oauth", "status": "needs_user_action" },
    { "id": "verify_remote", "status": "ready" }
  ],
  "resumeCommand": "npx supa-mcp setup --resume --function mcp --auth oauth --yes --json"
}
```

`--json` never prompts. Without `--yes`, a new setup returns
`needs_confirmation` and makes no changes. Failures return a structured
`command_failed` error and a non-zero exit code. Tokens are never included in
the setup report or resume command.

Useful automation flags:

- `--plan`: calculate the full setup plan without writing.
- `--yes`: accept selected or default choices without prompting.
- `--resume`: inspect the existing scaffold and continue idempotently.
- `--skip-checks`: leave Deno checks as a reported next action.
- `--project-ref <ref>`: make deployment and endpoint discovery explicit.
- `--public-url <url>`: make clients see a clean URL such as
  `https://yourapp.com/mcp` while Supabase continues to run the function.
- `--deploy`: deploy the generated function after successful local checks.
- `--apply-migrations`: run `supabase db push --yes` for public mode.
- `--url <url>`: verify an explicit deployed endpoint.

Public deployment deliberately requires both mutation flags because
`supabase db push` may include other pending application migrations:

```sh
npx supa-mcp setup \
  --resume \
  --auth public \
  --apply-migrations \
  --deploy \
  --yes \
  --json
```

## Write your MCP capabilities

Edit the generated `capabilities.ts`. The package uses the official MCP SDK's
registration API, so there is no parallel tool framework to learn.

```ts
import {
  jsonResult,
  type SupabaseMcpContext,
  type SupabaseMcpServer,
} from "supa-mcp";
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

Every request receives a new `ctx.supabase` client carrying the connected
user's access token. Queries therefore use the same grants and RLS policies as
the rest of the application.

The generated example also demonstrates a resource, a prompt, and an MCP
multi-round-trip confirmation flow. Advanced MCP features remain available
through the underlying official `McpServer`.

## Finish each access mode

### OAuth for end users

OAuth is the default and recommended path. The Edge Function:

1. returns a Bearer challenge pointing to protected-resource metadata;
2. advertises the project's Supabase Auth OAuth issuer;
3. validates the Supabase access token;
4. creates one RLS-scoped client for that request;
5. exposes the registered MCP capabilities.

Enable **Authentication → OAuth Server** in the Supabase Dashboard. Configure
an application-owned authorization/consent path and enable dynamic client
registration when the intended MCP clients need it.

If the app does not yet have a consent UI, generate the small fallback:

```sh
npx supa-mcp setup --consent minimal
```

Existing applications should normally integrate Supabase's authorization
details, approve, and deny calls into their own signed-in frontend. The
fallback is a runnable bridge, not a replacement for the app's eventual UX.

### Existing bearer tokens

```sh
npx supa-mcp setup --auth bearer
```

Bearer mode accepts an existing Supabase user access token without advertising
an interactive OAuth flow. RLS behavior is the same as OAuth.

### Intentionally public MCP

```sh
npx supa-mcp setup --auth public
```

Public mode uses the Supabase anonymous client, so only capabilities and rows
available to the `anon` role can be reached. It generates a private,
Postgres-backed fixed-window limiter with a default of 60 requests per minute
per caller. The endpoint fails closed until that migration is applied.

## Deploy and verify

Setup can perform deployment when explicitly requested:

```sh
npx supa-mcp setup \
  --resume \
  --project-ref PROJECT_REF \
  --deploy \
  --yes
```

Or run the underlying commands yourself:

```sh
supabase functions deploy mcp --no-verify-jwt

npx supa-mcp doctor \
  --function mcp \
  --url https://PROJECT_REF.supabase.co/functions/v1/mcp
```

`doctor` detects the generated auth mode. It checks OAuth discovery, bearer
gating, or public tools and rate-limit headers as appropriate. Add
`--token "$USER_JWT"` to OAuth or bearer mode for an authenticated
`tools/list` probe. Use `doctor --json` in automation.

The remote MCP URL is:

```text
https://PROJECT_REF.supabase.co/functions/v1/mcp
```

That URL works immediately. A product-facing server can instead use a clean
URL without moving the Edge Function:

```sh
npx supa-mcp setup \
  --resume \
  --project-ref PROJECT_REF \
  --public-url https://yourapp.com/mcp \
  --deploy \
  --yes
```

Supa MCP sets `MCP_PUBLIC_URL` so OAuth discovery advertises the clean URL,
while the authorization issuer remains the project's Supabase Auth server.
Your app or edge provider must proxy both `/mcp` and every path below it to the
Supabase function; the suffix paths serve MCP authorization metadata.

### Clean URL on an existing Next.js site

This uses the domain your app already has, so it needs no new DNS record. Add
an external rewrite to `next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/mcp/:path*",
        destination: "https://PROJECT_REF.supabase.co/functions/v1/mcp/:path*",
      },
    ];
  },
};

export default nextConfig;
```

Deploy the site, then verify the public route rather than the upstream URL:

```sh
npx supa-mcp doctor --url https://yourapp.com/mcp
```

### Dedicated MCP subdomain

For `https://mcp.yourapp.com`, the domain's DNS or hosting provider must route
that hostname. A small Cloudflare Worker can forward the complete route tree:

```ts
const upstream = "https://PROJECT_REF.supabase.co/functions/v1/mcp";

export default {
  async fetch(request: Request) {
    const incoming = new URL(request.url);
    const suffix = incoming.pathname === "/" ? "" : incoming.pathname;
    const target = new URL(`${upstream}${suffix}${incoming.search}`);
    const headers = new Headers(request.headers);
    headers.delete("host");

    return fetch(target, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      redirect: "manual",
    });
  },
};
```

Supa MCP cannot create a DNS record without access to that provider, but setup
reports the exact remaining route and verifies it once it exists.

## Optional capability scopes

The starter does not require scopes. Add them only when one MCP connection
should expose fewer capabilities than another:

```ts
server
  .withScopes(["projects:read"])
  .registerTool("list_projects", { inputSchema: z.object({}) }, async () =>
    jsonResult({ projects: [] }),
  );
```

Scoped tools, resources, prompts, and resource templates are omitted from
discovery unless the request has every required scope. `ctx.hasScope()` and
`ctx.hasScopes()` support finer application decisions.

Applications that store grants in their own tables can resolve scopes through
the existing request-scoped client:

```ts
createSupabaseMcp({
  // server, resourceUrl, auth, and register options
  access: {
    async resolveScopes(ctx) {
      const { data, error } = await ctx.supabase.rpc("my_mcp_scopes");
      if (error) throw error;
      return data;
    },
  },
});
```

Scope names and storage remain application-owned. The package does not add an
organization, membership, role, or entitlement model. RLS remains the
row-level authority.

## RLS and multi-tenancy

Edge compute is shared; authorization state is not. The runtime creates a new
MCP server, context, and Supabase client for every request. It stores no
current user, organization, token, or tenant result in mutable module state.

RLS must still express the application's real ownership model. A simple
user-owned table might use:

```sql
create policy "Users read their own items"
on public.items
for select
to authenticated
using ((select auth.uid()) = user_id);
```

That is only an example. Do not add a service-role client to end-user handlers.
The [multi-tenant example](./examples/multi-tenant) includes explicit grants,
RLS policies, and a two-user negative isolation test.

## Command reference

| Command  | Purpose                                                           |
| -------- | ----------------------------------------------------------------- |
| `setup`  | Guide or automate the complete installation ladder                |
| `status` | Inspect local setup and optionally probe the remote endpoint      |
| `init`   | Generate files only; useful as a low-level primitive              |
| `doctor` | Diagnose generated files, gateway config, auth, and MCP discovery |
| `dev`    | Delegate to `supabase functions serve`                            |

Use `npx supa-mcp --help` for all flags.

## Troubleshooting

**Setup is waiting for approval in automation.** Add `--yes --json`. JSON mode
never opens an interactive prompt; without `--yes`, it returns a plan with
`needs_confirmation`.

**The endpoint says `Missing authorization header` without MCP metadata.** The
Supabase gateway is intercepting the request. Ensure the function has
`verify_jwt = false` and deploy it with `--no-verify-jwt`.

**OAuth discovery returns 502.** Enable Supabase OAuth Server and verify the
project's authorization-server metadata endpoint is available.

**Authentication works but tools return no rows.** Inspect table grants and
RLS policies. Correct RLS can return an empty result without an authorization
error.

**Public mode returns `rate_limit_unavailable`.** Apply the generated migration
with `supabase db push` and confirm the function has its managed Supabase secret
environment.

**Setup reports a file conflict.** An existing target differs from the
generated template. Merge or move it explicitly. Once a generated scaffold is
recognized, `setup --resume` leaves application-authored capabilities alone.

## Development

Version 0.1.0 pins the runtime dependencies in each generated Deno project.
The package test suite covers MCP discovery, scopes, public rate limiting,
concurrent request isolation, generated OAuth/public projects, structured CLI
output, and real two-user Postgres RLS when integration credentials are
available.

```sh
pnpm install
pnpm check
pnpm run test:rls
npm pack --dry-run
```

See [SPEC.md](./SPEC.md) for the detailed protocol and architecture contract.
Released under the [MIT License](./LICENSE).
