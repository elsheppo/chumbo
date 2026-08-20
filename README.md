# Supa MCP

**Your Supabase app, now an MCP.**

Run one command to add a polished end-user MCP server to an existing Supabase
app. It runs as an Edge Function and uses the app's Supabase Auth, Postgres,
and Row Level Security instead of introducing another backend.

This package exposes your application's capabilities to its users. It is not
the official Supabase management MCP used to administer Supabase projects.

Start with one server. The same library also supports advanced Supabase-native
patterns—including many MCPs from one Edge Function—without introducing a
second framework or making the basic setup more complicated.

The path from here to "an MCP client is calling my app" is five sections:
setup, write a capability, run it locally, finish your access mode and deploy,
then connect a client. Everything after that is optional depth.

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

The four access choices are:

1. **Supabase OAuth** — recommended when your app's users will connect their
   accounts from an MCP client.
2. **Application API key** — the short path when your app already gives trusted
   clients a key, or just needs one shared secret to start.
3. **Bearer token** — useful when your platform already gives clients a
   Supabase user access token.
4. **Public** — anonymous access through the Supabase `anon` role, with a
   generated Postgres rate limiter.

Unsure which to pick? The
[auth mode decision guide](./docs/reference/auth-modes) compares them in one
page. When in doubt, choose OAuth for a product and API key for a prototype.

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

## Write your MCP capabilities

Edit the generated `capabilities.ts`. The package uses the official MCP SDK's
registration API, so there is no parallel tool framework to learn.

```ts
import {
  structuredResult,
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
      outputSchema: z.object({
        projects: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            status: z.string(),
          }),
        ),
      }),
    },
    async () => {
      const { data, error } = await ctx.supabase
        .from("projects")
        .select("id, name, status")
        .order("name");

      if (error) throw error;
      return structuredResult({ projects: data ?? [] });
    },
  );
}
```

### Choose the result for its real consumer

Use `textResult` when an agent or person is the only meaningful consumer. Use
`structuredResult` with an `outputSchema` for typed composition or UI clients.
Use `renderResult` only when both consumers genuinely matter:

```ts
import { renderResult } from "supa-mcp";

return renderResult({ projects: data }, ({ projects }) =>
  projects.length === 0
    ? "No projects yet.\n\n→ Next: create_project starts one."
    : [
        `## Projects — ${projects.length}`,
        ...projects.map((p) => `- **${p.name}** — ${p.status}`),
        "",
        "→ Next: get_project reads one in full.",
      ].join("\n"),
);
```

Use `resourceResult(text, link)` for large documents registered through MCP
Resources. It returns a concise reading card and link without embedding the
body in the tool response. Do not expose raw database rows as the application
contract by default; preserve only the facts and identifiers the consumer
needs for its next step.

`errorResult(message, nextStep)` appends a `→ Next:` line so errors route the
model to recovery instead of a dead end.

In OAuth and bearer modes, every request receives a new `ctx.supabase` client
carrying the connected user's access token. Queries therefore use the same
grants and RLS policies as the rest of the application. API-key and public
modes receive an anonymous client instead; their capability code owns the
application authorization decision.

Set `instructions` alongside `server` in `createSupabaseMcp` to give clients
server-level usage guidance in the `initialize` result — what the server is
for and where the model should start. Pass a string, or a
`(context) => string` resolver when different callers or row-defined servers
warrant different guidance. Tool descriptions say what one tool does;
instructions say how the server hangs together.

The generated example also demonstrates a resource, a prompt, and an MCP
multi-round-trip confirmation flow. Advanced MCP features remain available
through the underlying official `McpServer`.

## Run it locally

Exercise the function before deploying anything:

```sh
supabase functions serve mcp
deno task --config supabase/functions/mcp/deno.json test
```

The local endpoint is `http://127.0.0.1:54321/functions/v1/mcp`. Probe its MCP
discovery surface directly:

```sh
npx supa-mcp doctor --url http://127.0.0.1:54321/functions/v1/mcp
```

For interactive tool calls against the local endpoint, MCP Inspector
(`npx @modelcontextprotocol/inspector`) speaks Streamable HTTP and shows every
request and result.

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

### Application API keys

For the shortest authenticated path:

```sh
npx supa-mcp setup --auth api-key
supabase secrets set MCP_API_KEY="replace-with-a-long-random-key"
supabase functions deploy mcp --no-verify-jwt
npx supa-mcp doctor --url https://PROJECT_REF.supabase.co/functions/v1/mcp \
  --token "$MCP_API_KEY"
```

Clients send the key as `Authorization: Bearer <key>`. The generated function
loads it only from the `MCP_API_KEY` Edge secret. Capability handlers receive
`ctx.subject === "api-key"`, `ctx.user === null`, and an anonymous Supabase
client. That distinction is deliberate: an application key is not a Supabase
user JWT, so the library does not invent an RLS user for it.

Applications with their own key table can replace the static key with a
verifier. The service-role client exists only inside this callback and is never
exposed to tools:

```ts
auth: {
  mode: "api-key",
  async verify({ token, supabaseAdmin }) {
    const { data } = await supabaseAdmin.rpc("resolve_api_key", {
      presented_key: token,
    });

    return data
      ? { subject: data.owner_id, scopes: data.scopes ?? [] }
      : null;
  },
},
```

Use `ctx.subject`, resolved scopes, and ordinary application queries or RPCs to
implement the authorization model your app already has. Supa MCP does not
prescribe an organization or API-key table schema.

### Supabase users and application keys on one endpoint

Use composed authentication when the same MCP URL must serve interactive
Supabase users and application-owned credentials. Credential selection happens
before verification. A verifier-backed key declares a prefix, so a rejected
application key cannot fall through and be retried as a user token.

```ts
auth: {
  mode: "multi",
  strategies: [
    { mode: "oauth", strategy: "supabase-user" },
    {
      mode: "api-key",
      strategy: "application-key",
      tokenPrefix: "myapp_",
      async verify({ token, supabaseAdmin }) {
        const { data } = await supabaseAdmin.rpc("resolve_api_key", {
          presented_key: token,
        });
        return data
          ? { subject: data.subject, scopes: data.scopes ?? [] }
          : null;
      },
    },
  ],
},
```

Every handler receives a normalized `ctx.authentication` and `ctx.principal`.
For a Supabase user, `ctx.user` and `ctx.jwtClaims` are populated and
`ctx.supabase` carries that user's JWT for RLS. For an application key,
`ctx.user` is `null`, `ctx.subject` comes from the verifier, and `ctx.supabase`
is anonymous. Use the key's explicit scopes and application-owned RPCs or
policies; Supa MCP never turns an API key into a fictional Supabase user.

```ts
server
  .withScopes(["catalog:publish"])
  .registerTool("publish_item", options, handler);
```

The same scope gate filters discovery and invocation for tools, resources, and
prompts. A request-aware `instructions(ctx)` resolver can describe only the
workflow available to the authenticated principal.

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

`doctor` detects generated and inline auth configuration, and a deployed Supa
MCP identifies its runtime version, auth mode, API-key strategy, and advertised
resource URL through non-secret response headers. This lets diagnostics
distinguish the Edge Function from a 401 returned earlier by the Supabase
gateway. Add `--token "$MCP_API_KEY"` for the generated static-key mode,
`--token "$APPLICATION_API_KEY"` for a custom verifier, or
`--token "$USER_JWT"` for OAuth or bearer mode to complete an authenticated
`tools/list` probe.

Without a token, a healthy protected endpoint is reported as ready to test—not
blocked and not fully connection-tested. Generated layout files remain the
recommended happy path; composed functions can organize capability and test
code differently, and missing optional scaffold files are advisory. Use
`doctor --json` for the complete evidence record in automation.

The remote MCP URL is:

```text
https://PROJECT_REF.supabase.co/functions/v1/mcp
```

That URL works immediately. To serve clients a clean URL such as
`https://yourapp.com/mcp` instead, see
[Clean URLs](#clean-urls-for-a-product-facing-server) below—it changes what
clients see, not where the function runs.

## Connect your MCP client

This is the payoff. Once `doctor` reports the deployed endpoint healthy, point
a real client at it.

**Claude Code**

```sh
claude mcp add --transport http my-app \
  https://PROJECT_REF.supabase.co/functions/v1/mcp
```

In OAuth mode, run `/mcp` inside Claude Code to complete the browser sign-in.
In API-key or bearer mode, attach the credential instead:

```sh
claude mcp add --transport http my-app \
  https://PROJECT_REF.supabase.co/functions/v1/mcp \
  --header "Authorization: Bearer $MCP_API_KEY"
```

**Claude (claude.ai and the desktop app)** — Settings → Connectors → Add
custom connector, then paste the endpoint URL. This path requires OAuth mode
with dynamic client registration enabled, because claude.ai registers itself
as an OAuth client against your Supabase Auth server.

**Cursor** — add the server to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "my-app": {
      "url": "https://PROJECT_REF.supabase.co/functions/v1/mcp"
    }
  }
}
```

Then ask the connected assistant something only your app can answer, such as
_"List my projects."_ Watching the model call a tool you wrote three sections
ago, as the signed-in user, is the whole point of this package.

Per-client details and the verification status of each combination live in
[Connect your MCP client](./docs/reference/connect-clients).

## Living patterns and documentation MCP

This repository is also a runnable Supabase reference project. Its database is
designed around the cases the project teaches, and each pattern is exercised
through a real MCP request:

- [Authenticated tools with RLS](./docs/patterns/authenticated-tools) proves
  two connected users receive only their own rows.
- [Model-facing results](./docs/patterns/model-facing-results) proves populated,
  empty, and error responses remain useful in `content[].text`.
- [Many MCPs from one function](./docs/patterns/many-mcps-one-function) proves
  one deployment can resolve distinct row-defined tool surfaces per request.

The public documentation MCP exposes `search_docs`, `get_pattern`,
`get_example`, and `get_setup_steps`. It contains Supa MCP-owned instructions
and links out to official Supabase documentation for the platform underneath;
it does not attempt to duplicate Supabase's docs.

Connect an MCP client or coding agent directly to:

```text
https://dxrpeagddrpbezbkgvdv.supabase.co/functions/v1/docs-mcp
```

Then ask: `Inspect this project and implement the authenticated-tools pattern.`

Git is authoritative. `pnpm reference:content` syncs the Markdown and metadata
under `docs/` and `examples/` into searchable Postgres rows. The database is a
deployed representation, never a second editorial source.

To rebuild the complete project from a clean clone:

```sh
pnpm install --frozen-lockfile
pnpm reference:check
```

That command starts local Supabase when needed, resets only this reference
project, applies migrations and seed data, syncs the corpus, type-checks every
Edge Function against the published npm package, and runs the protocol-level
integration suite.

The public reference deployment also exposes:

- `https://dxrpeagddrpbezbkgvdv.supabase.co/functions/v1/authenticated-tools`
- `https://dxrpeagddrpbezbkgvdv.supabase.co/functions/v1/model-facing-results`
- `https://dxrpeagddrpbezbkgvdv.supabase.co/functions/v1/many-mcps/directory`
- `https://dxrpeagddrpbezbkgvdv.supabase.co/functions/v1/many-mcps/invoices`

## Clean URLs for a product-facing server

A product-facing server can use a clean URL without moving the Edge Function:

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

## Optional capability scopes

The starter does not require scopes. Add them only when one MCP connection
should expose fewer capabilities than another:

```ts
server
  .withScopes(["projects:read"])
  .registerTool("list_projects", { inputSchema: z.object({}) }, async () =>
    textResult("No projects are currently visible."),
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

| Command  | Purpose                                                          |
| -------- | ---------------------------------------------------------------- |
| `setup`  | Guide or automate the complete installation ladder               |
| `status` | Inspect local setup and optionally probe the remote endpoint     |
| `init`   | Generate files only; useful as a low-level primitive             |
| `doctor` | Diagnose local config, runtime identity, auth, and MCP discovery |
| `dev`    | Delegate to `supabase functions serve`                           |

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

Version 0.5.0 pins the runtime dependencies in each generated Deno project.
The package test suite covers MCP discovery, scopes, public rate limiting,
API-key authentication, concurrent request isolation, generated
OAuth/API-key/public projects, structured CLI output, and real two-user
Postgres RLS when integration credentials are available.

```sh
pnpm install
pnpm check
pnpm reference:check
pnpm run test:rls
npm pack --dry-run
```

See [SPEC.md](./SPEC.md) for the detailed protocol and architecture contract.
Released under the [MIT License](./LICENSE).
