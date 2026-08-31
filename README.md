<p align="center">
  <a href="https://chumbo.dev">
    <img src="https://raw.githubusercontent.com/elsheppo/chumbo/main/docs/assets/readme/chumbo-readme-hero.png" alt="Chumbo. MCP made easy on Supabase." width="100%">
  </a>
</p>

Chumbo turns an existing Supabase application into a Streamable HTTP MCP server
running as a Supabase Edge Function. Your application keeps its Auth, Postgres
data, Row Level Security, Storage, and authorization model. You choose what
agents can do. Chumbo handles the MCP layer around it.

<p align="center">
  <a href="https://chumbo.dev">Website</a> ·
  <a href="./docs/reference/getting-started">Getting started</a> ·
  <a href="./docs/reference/auth-modes">Access modes</a> ·
  <a href="https://www.npmjs.com/package/chumbo">npm</a>
</p>

<img src="https://raw.githubusercontent.com/elsheppo/chumbo/main/docs/assets/readme/chapter-01-start.png" alt="" width="100%">

## Start in one command

From a repository that already contains `supabase/config.toml`:

```sh
npx chumbo setup
```

Setup asks who may connect, previews every file it will write, generates the
Edge Function and tests, and reports the remaining deployment or OAuth steps in
order. It is resumable and does not overwrite application-authored
capabilities.

Requirements: Node 22+, the Supabase CLI, and preferably Deno for the generated
local type-check and tests.

The generated server lives at:

```text
supabase/functions/mcp/
├── index.ts
├── capabilities.ts
├── deno.json
├── index_test.ts
└── README.md
```

### Write one capability

Edit the generated `capabilities.ts`. Chumbo uses the official MCP SDK's
registration API, so your capabilities remain ordinary MCP tools, Resources,
and prompts.

```ts
import {
  textResult,
  type SupabaseMcpContext,
  type SupabaseMcpServer,
} from "chumbo";
import { z } from "zod";

export function registerCapabilities(
  server: SupabaseMcpServer,
  ctx: SupabaseMcpContext,
) {
  server.registerTool(
    "list_tasks",
    {
      description: "List tasks visible to the connected user.",
      inputSchema: z.object({}),
    },
    async () => {
      const { data, error } = await ctx.supabase
        .from("tasks")
        .select("id, title, status")
        .order("title");

      if (error) throw error;
      if (!data?.length) {
        return textResult("No tasks are visible to the connected user.");
      }

      return textResult(
        [
          `## Tasks – ${data.length}`,
          ...data.map(
            (task) => `- **${task.title}** – ${task.status} · ID: ${task.id}`,
          ),
        ].join("\n"),
      );
    },
  );
}
```

The important part is `ctx.supabase`. In OAuth and bearer modes, it is a fresh
client carrying the connected user's access token. The same Postgres grants
and RLS policies used by the rest of the application apply to every tool call.

You choose the application operations worth exposing and shape each result for
its real consumer. Chumbo handles the protocol and request-authority boundary
around that application code.

<img src="https://raw.githubusercontent.com/elsheppo/chumbo/main/docs/assets/readme/chapter-02-ship.png" alt="" width="100%">

## Run, deploy, and verify

Start Supabase, serve the generated function, then prove the real MCP boundary
before deploying. Keep `chumbo dev` running in one terminal:

```sh
supabase start
npx chumbo dev --function mcp
```

For public mode, run `supabase migration up --local` after `supabase start`
and before serving the function so the generated local rate limiter is ready.
For generated API-key mode, put `MCP_API_KEY` in the gitignored file
`supabase/functions/.env.local` and add
`--env-file supabase/functions/.env.local` to the `chumbo dev` command.

In another terminal, run the generated contract test and invoke the starter:

```sh
deno task --config supabase/functions/mcp/deno.json test
npx chumbo doctor \
  --function mcp \
  --url http://127.0.0.1:54321/functions/v1/mcp \
  --call-tool whoami
```

Add `--token <MCP_API_KEY>` to doctor for generated API-key mode or
`--token <LOCAL_USER_JWT>` for bearer or OAuth mode. Chumbo does not add a local
authentication bypass. Doctor reports initialization, tool discovery, and the
explicit tool call separately. If the stack or function is stopped, it prints
the next recovery command. The locally served files are the same files deployed
below.

Then deploy and probe the hosted endpoint:

```sh
supabase functions deploy mcp --no-verify-jwt

npx chumbo doctor \
  --url https://PROJECT_REF.supabase.co/functions/v1/mcp
```

The generated function sets `verify_jwt = false` at the Supabase gateway so the
function can issue the MCP OAuth challenge itself. Protected servers still
authenticate the request inside the Chumbo runtime.

Your MCP URL is:

```text
https://PROJECT_REF.supabase.co/functions/v1/mcp
```

### Choose who can connect

| Access mode | Use it when                                                                          | Request authority                                                   |
| ----------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| **OAuth**   | Your users should connect their own accounts. Recommended for a user-facing product. | Supabase user token and existing RLS                                |
| **API key** | You want the shortest authenticated start or already maintain application keys.      | Application subject and scopes; `ctx.supabase` uses the `anon` role |
| **Bearer**  | Your own client already holds a Supabase user access token.                          | Supabase user token and existing RLS                                |
| **Public**  | The capability is intentionally anonymous.                                           | Supabase `anon` role plus a generated Postgres rate-limit guardrail |

Run `npx chumbo setup` interactively, or choose directly:

```sh
npx chumbo setup --auth oauth
npx chumbo setup --auth api-key
npx chumbo setup --auth bearer
npx chumbo setup --auth public
```

Start with OAuth for an end-user product and API key for a prototype or trusted
machine caller. One endpoint can also compose Supabase-user and application-key
strategies without merging their identities or database behavior.

[Choose an access mode](./docs/reference/auth-modes) explains the tradeoffs.
[Different capability surfaces](./docs/patterns/privileged-capabilities) shows
ordinary and privileged identities receiving different MCP surfaces from one
Edge Function.

### Connect a real client

For Claude Code:

```sh
claude mcp add --transport http my-app \
  https://PROJECT_REF.supabase.co/functions/v1/mcp
```

OAuth mode opens the application's sign-in and consent flow. API-key and bearer
clients send their credential as an `Authorization: Bearer` header.

For claude.ai or Claude Desktop, open **Settings → Connectors → Add custom
connector** and paste the endpoint URL. Hosted custom connectors require OAuth
with dynamic client registration enabled.

Cursor, MCP Inspector, and other Streamable HTTP clients use the same endpoint.
See [Connect your MCP client](./docs/reference/connect-clients) for exact setup
and verified combinations.

<img src="https://raw.githubusercontent.com/elsheppo/chumbo/main/docs/assets/readme/chapter-03-stay-in-control.png" alt="" width="100%">

## What stays in your hands

- **Supabase-native authority.** Auth, RLS, Postgres, Storage, and Edge
  Functions remain authoritative.
- **Request isolation.** Every request receives a new MCP server, normalized
  principal, and Supabase client. Caller identity never lives in shared mutable
  module state.
- **Deliberate authentication.** Supabase users receive an RLS-aware client.
  Application keys retain their application-owned subject and scopes.
- **Rotation-safe verification.** OAuth and bearer requests use Supabase's
  public JWKS. Remote JWKS configuration is cached briefly per runtime to avoid
  adding a key-network round trip to every MCP request while still observing
  signing-key rotation quickly.
- **Protocol-native capabilities.** Tools, Resources, prompts, instructions,
  and multi-round-trip flows use the official MCP SDK surface.
- **Deployable defaults.** Setup is previewable, resumable, conflict-aware, and
  usable non-interactively by agents and CI. `doctor` verifies the real remote
  MCP boundary.
- **No required Chumbo service.** The runtime deploys into an ordinary Supabase
  project. Public mode's default guardrail is Postgres-backed.

The boundary stays simple:

```text
MCP client
    ↓
Supabase Edge Function
    ↓
fresh request-scoped identity and mode-appropriate Supabase client
    ↓
your capabilities, application checks, grants, and RLS policies
```

### Choose the result for its consumer

| Helper                            | Use it for                                                              |
| --------------------------------- | ----------------------------------------------------------------------- |
| `textResult(text)`                | Purpose-written output for agents and people                            |
| `structuredResult(value)`         | Typed clients or UI consumers; declare the matching tool `outputSchema` |
| `renderResult(value, render)`     | A deliberate text and structured-data hybrid                            |
| `resourceResult(text, link)`      | A concise reading card whose full body is served through MCP Resources  |
| `errorResult(message, nextStep?)` | A failure that tells the agent how to recover                           |
| `appendResultText(result, text)`  | Optional model-facing guidance after a successful authored result       |
| `prependResultText(result, text)` | Optional model-facing context before a successful authored result       |

Shape each result around the consumer's next reasoning or interaction step.
Preserve useful identifiers, omit internal fields, and use Resources or
pagination for large payloads.

Successful results can carry an optional follow-up without rebuilding their
structured data or metadata:

```ts
return appendResultText(
  structuredResult({ draftId: draft.id }),
  "Optional follow-up: call review_draft with this draftId when you want to review it.",
);
```

For cross-cutting guidance, `resultMiddleware` may return bounded `prepend` or
`append` content for successful tools. Every middleware receives the same
read-only authored-result snapshot, and a middleware failure leaves that
result unchanged and reaches `onError` with `phase: "results"`.

This guidance is ordinary model-facing tool-result content. It is not a system
message and cannot require the client to call another tool.

The [capability and result showcase](./docs/patterns/model-facing-results)
keeps tools, Resources, prompts, elicitation, and all result patterns
executable without loading them into the generated starter.

<img src="https://raw.githubusercontent.com/elsheppo/chumbo/main/docs/assets/readme/chapter-04-go-deeper.png" alt="" width="100%">

## Observe capability execution

Add `onEvent` when your application needs audit, usage, or operational data.
Chumbo emits versioned `capability.started` and `capability.finished` events for
invoked tools, Resources, and prompts. Each event contains the request trace,
server and capability identity, normalized principal and authentication,
timestamp, and terminal outcome. Arguments, results, credentials, and thrown
exception text are excluded by construction.

```ts
const app = createSupabaseMcp({
  // server, resourceUrl, auth, and register...
  onEvent(event) {
    return applicationEvents.write(event);
  },
  onError({ phase, error, traceId }) {
    applicationLogger.error({ phase, error, traceId });
  },
});
```

The sink is optional and application-owned. Chumbo observes a returned promise
for failure but does not await it, so a slow or unavailable sink never changes
the MCP response. Use the deployment platform's background-work primitive when
delivery must continue after the response. Sink failures reach `onError` with
`phase: "events"` and never recursively produce another event.

### Capture the advertised tool surface

Add `onSurface` when your application needs durable evidence of the tool
catalog an authenticated client can actually discover:

```ts
const app = createSupabaseMcp({
  // server, resourceUrl, auth, and register...
  onSurface(proof) {
    return applicationSurfaceProofs.write(proof);
  },
});
```

Chumbo calls the sink only after a complete successful `tools/list`. The
versioned proof contains normalized tool names, descriptions, supported
annotations, input and output schemas, truthful server/runtime/auth metadata,
the requested protocol version when available, and a stable SHA-256 content
digest. Tools disabled for the current request are
absent, so protected callers can prove different effective surfaces without
exporting the caller, scopes, credentials, headers, arguments, results,
prompts, errors, cursors, or arbitrary `_meta`.

The callback is optional and application-owned. Its returned promise is
observed but not awaited, and failures reach `onError` with `phase: "surface"`
without changing discovery. When `onSurface` is absent, the runtime performs no
request cloning, response inspection, hashing, delivery, account, or network
work for surface proofs.

### Correlate an application run

Some products need several tool calls to belong to one application-defined run
or work order. Configure `createRunCorrelation` only for that advanced case:

```ts
import { createRunCorrelation, createSupabaseMcp, textResult } from "chumbo";
import { z } from "zod";

const runs = createRunCorrelation({
  currentKey: {
    version: "2026-08",
    secret: Deno.env.get("CHUMBO_RUN_HMAC_KEY")!,
  },
  scope(ctx) {
    return {
      installation: "my-supabase-project",
      surface: "primary-mcp",
      partition: ctx.subject ?? "public",
    };
  },
});

const app = createSupabaseMcp({
  // server, resourceUrl, auth...
  runCorrelation: runs,
  register(server, ctx) {
    server.registerTool(
      "draft_post",
      {
        inputSchema: z.object({
          run_id: z.string().optional(),
          idea: z.string(),
        }),
      },
      async (args, mcpCtx) => {
        const run = await runs.resolve(ctx, {
          serverContext: mcpCtx,
          toolArguments: args,
        });
        return textResult(run ? `Drafted in ${run.id}.` : "Drafted.");
      },
    );
  },
});
```

A builder-authored begin tool can call `runs.mint(ctx)` and return its opaque
`handle`. Generic MCP clients pass that handle through `run_id` only on the
tools that deliberately expose the field. A client you control may instead
send the same handle in `_meta["dev.chumbo/run"]`. Matching carriers are
accepted. Disagreement or an invalid handle stops before application code.

When configured, lifecycle events use schema v2 and contain the same bounded
opaque run fact or `run: null`. Without `runCorrelation`, Chumbo continues to
emit lifecycle v1 exactly as before. A run handle is correlation, not
authorization or execution. Auth, scopes, grants, RLS, and your application's
data-plane checks remain authoritative.

### Opt into small durable state

Most Chumbo servers should remain stateless. An authenticated capability that
genuinely needs request-to-request coordination can explicitly generate one
allowlisted namespace:

```sh
npx chumbo setup \
  --auth oauth \
  --state-namespace file-ide.observations
```

This adds one opt-in migration and state configuration. Apply the migration and
set a unique deployment secret of at least 32 random bytes:

```sh
supabase db push
supabase secrets set \
  CHUMBO_STATE_HMAC_KEY="replace-with-at-least-32-random-bytes"
```

Capability code then receives only `get`, revision-checked `put`, and
revision-checked `delete`:

```ts
const receipt = await ctx.state?.get(
  "file-ide.observations",
  `project:${projectId}:document:${documentId}`,
);
```

The runtime derives an opaque partition from the exact credential with a
deployment-secret HMAC and keeps its service-role state client
closure-confined. Public mode never receives state. Same-project storage is the
default. Advanced compositions can set `state.supabase.env` to keep receipts in
a separate Supabase project without moving authentication or `ctx.supabase`
there.

State CAS protects coordination records, not application rows. Use immutable,
scoped resource IDs, keep the capability's total keyspace bounded, and retain
RLS or an atomic application-level version precondition for real mutations.

See [Observation before action](./docs/patterns/observation-before-action) for
the complete executable read-before-edit pattern, safe cross-database ordering,
credential-rotation behavior, and split-project runbook. This is coordination
storage, not a resident actor or Durable Object runtime.

### Advanced patterns

The ordinary path remains one Edge Function with builder-authored capabilities.
The same library also supports more demanding applications without changing
that starting point:

- [Many MCPs from one function](./docs/patterns/many-mcps-one-function)
- [Authenticated tools with RLS](./docs/patterns/authenticated-tools)
- [Observation before action](./docs/patterns/observation-before-action)
- [Different capability surfaces](./docs/patterns/privileged-capabilities)
- [Interactive MCP Apps on Supabase](./docs/patterns/mcp-apps-on-supabase)
- [Clean client-facing URLs](./docs/reference/clean-urls)
- Project-local capability guidance with `npx chumbo skill install`

These are composition patterns, not additional frameworks or required product
architecture.

### Reference project

This repository includes an open-source Supabase reference project. Its
patterns run through the real MCP transport against local Postgres. The suite
covers two-user RLS isolation, explicit result contracts, many row-defined MCP
surfaces, composed user and application identities, and interactive MCP Apps.

The public documentation MCP is available at:

```text
https://dxrpeagddrpbezbkgvdv.supabase.co/functions/v1/docs-mcp
```

Its tools search Chumbo's own guides and return complete documents through MCP
Resources. It links to official Supabase documentation for the platform
underneath instead of reproducing it.

To rebuild the reference project from a clean clone:

```sh
pnpm install --frozen-lockfile
pnpm reference:check
```

## Documentation

- [Five-step getting started guide](./docs/reference/getting-started)
- [Choose an access mode](./docs/reference/auth-modes)
- [Connect an MCP client](./docs/reference/connect-clients)
- [Give an MCP a clean product URL](./docs/reference/clean-urls)
- [Runnable patterns](./docs/patterns)
- [Examples](./examples)
- [Architecture and protocol contract](./SPEC.md)
- [Roadmap](./ROADMAP.md)
- [Changelog](./CHANGELOG.md)

For automation, use `npx chumbo setup --plan --json` to inspect changes and
`--yes --json` to apply them without prompts. Run `npx chumbo --help` for the
complete command reference.

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm format:check
pnpm reference:check
npm pack --dry-run
```

Released under the [MIT License](./LICENSE).
