# Host the MCP where your app runs

A Chumbo app is a web-standard fetch handler: `createSupabaseMcp` returns an
object whose `fetch(request)` accepts a `Request` and resolves to a
`Response`. The Supabase Edge Function is the default home, not a
requirement. Whatever hosts the handler, your Supabase project remains
authoritative for authentication, Postgres data, and Row Level Security.

Setup offers three targets:

| Target          | Generates                                     | Runs on                               |
| --------------- | --------------------------------------------- | ------------------------------------- |
| `edge-function` | A Supabase Edge Function (default)            | Supabase's hosted Deno runtime        |
| `next`          | An App Router route handler plus capabilities | Your Next.js deployment               |
| `node`          | A standalone server entry plus capabilities   | Cloud Run, Fly, Railway, any Node 22+ |

Every target shares the same `capabilities.ts` seam, access modes, result
helpers, and `chumbo doctor` verification loop.

## Next.js applications

From a repository whose `package.json` lists `next`:

```sh
npx chumbo setup --target next
```

Setup generates a colocated scaffold under your App Router directory:

```text
app/mcp/[[...path]]/route.ts   protocol, auth, server configuration
app/mcp/capabilities.ts        application operations
app/mcp/README.md              configuration and verification guidance
```

The optional catch-all route serves `/mcp` and every path beneath it, so the
`/.well-known/...` suffixes MCP clients use for OAuth discovery resolve
without extra routing. The handler reads `SUPABASE_URL` and
`SUPABASE_PUBLISHABLE_KEY`, accepting the `NEXT_PUBLIC_`-prefixed names your
app may already define, and exports `dynamic = "force-dynamic"` so the
endpoint is never statically rendered.

Run your ordinary dev server, then prove the starter through the real MCP
boundary:

```sh
npx chumbo doctor --url http://localhost:3000/mcp --call-tool whoami
```

Deploy with your application's normal pipeline. Set the same environment in
production plus `MCP_PUBLIC_URL=https://yourapp.com/mcp`, then run doctor
against the live URL.

## Standalone Node servers

```sh
npx chumbo setup --target node
```

Setup generates a self-contained server directory:

```text
mcp/index.ts          server entry listening on PORT (default 8080)
mcp/capabilities.ts   application operations
mcp/README.md         configuration and verification guidance
```

The entry serves the app through `chumbo/node`, a small adapter over
`node:http` that streams SSE responses and reconstructs public URLs from
`x-forwarded-proto` and `x-forwarded-host` behind load balancers. Run it
directly – Node 22.18+ executes TypeScript natively:

```sh
node --experimental-strip-types mcp/index.ts
npx chumbo doctor --url http://127.0.0.1:8080/mcp --call-tool whoami
```

Containerize and deploy with your platform's ordinary pipeline; Cloud Run's
`PORT` convention is the default. The same adapter also embeds into an
existing Node server:

```ts
import { toNodeHandler } from "chumbo/node";
import { createServer } from "node:http";

createServer(toNodeHandler(app)).listen(8080);
```

## Environment

Host targets read configuration from process environment variables:

| Variable                   | Required           | Purpose                                   |
| -------------------------- | ------------------ | ----------------------------------------- |
| `SUPABASE_URL`             | always             | Your Supabase project URL                 |
| `SUPABASE_PUBLISHABLE_KEY` | always             | Anonymous client key (or legacy anon key) |
| `MCP_PUBLIC_URL`           | production         | Exact URL clients connect to              |
| `MCP_API_KEY`              | api-key mode       | The generated static application key      |
| `SUPABASE_SECRET_KEY`      | public mode, state | Service-role operations the runtime owns  |
| `CHUMBO_STATE_HMAC_KEY`    | durable state      | Credential-partitioned state identity     |

Public mode's rate limiter and opt-in durable state still live in your
Supabase Postgres. When the repository has no `supabase/` directory, setup
writes their migrations beside the generated scaffold; apply them through the
SQL editor or `psql`.

## Verification is the contract

The Edge Function target generates Deno contract tests. Host targets lean on
doctor as their executable contract instead: it proves MCP initialization,
tool discovery, the authentication gate, and an explicit starter call against
the running server, locally and in production, and needs no Supabase
directory to probe a deployed URL:

```sh
npx chumbo doctor --url https://yourapp.com/mcp --json
```

`npx chumbo setup --resume --target next` re-observes the scaffold and
reports the remaining actions with the same stable step IDs as the Edge
Function path.

## When to prefer the proxy instead

Hosting the runtime in your app buys one deploy unit, your platform's timeout
and scaling profile, and no second toolchain. Keeping the Edge Function and
[proxying a clean URL to it](../clean-urls/README.md) buys generated Deno
contract tests, `chumbo dev`, and Supabase-managed compute. Both are ordinary
Chumbo deployments; doctor verifies either through the URL clients actually
use.

OAuth mode keeps your application's Supabase Auth server as the issuer on
every target, so consent stays in your app's signed-in UI. The generated
fallback consent function remains an Edge Function concern; host targets do
not generate one.
