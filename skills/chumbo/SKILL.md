---
name: chumbo
description: Turn existing Supabase applications into end-user-facing Streamable HTTP MCP servers. Use for installing, configuring, developing, debugging, testing, deploying, or upgrading the chumbo package, including when a user asks generically to add MCP capabilities to a Supabase app. Covers tools, Resources, prompts, MCP Apps, authentication, RLS, and result design.
---

# Build MCP servers for Supabase apps

Chumbo is a TypeScript runtime and CLI that adds MCP to an existing Supabase
application. `npx chumbo setup` generates a Supabase Edge Function that handles
Streamable HTTP, authentication, and per-request context. The builder edits one
file, `capabilities.ts`, to expose application operations as ordinary MCP tools,
Resources, and prompts. Server metadata and request-aware instructions are
configured through `createSupabaseMcp` in `index.ts` when needed.

```text
MCP client
  -> supabase/functions/mcp/index.ts          protocol, auth, server configuration
  -> supabase/functions/mcp/capabilities.ts   application operations
  -> existing APIs, Postgres, Storage, grants, and RLS
```

In OAuth and bearer modes, `ctx.supabase` is a fresh client carrying the
connected user's access token. Existing Postgres grants and RLS policies keep
the same authority they have in the rest of the application. No hosted Chumbo
service is required.

## Choose your course

| You need to                                                        | Read                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Add MCP to a Supabase repository or resume setup                   | [Start or resume](references/start.md)                             |
| Design or revise a tool, Resource, or prompt                       | [Build capabilities](references/build-capabilities.md)             |
| Choose OAuth, bearer, API-key, or public access                    | [Access and RLS](references/access-and-rls.md)                     |
| Choose model-facing text, structured data, a hybrid, or a Resource | [Design results](references/results.md)                            |
| Run locally, deploy, connect a client, or prove completion         | [Run, deploy, and verify](references/run-deploy-verify.md)         |
| Diagnose connection, auth, discovery, RLS, or version problems     | [Troubleshoot and upgrade](references/troubleshoot-and-upgrade.md) |

Read only the guide needed for the current course. Optional state, telemetry,
run correlation, MCP Apps, multi-auth, many-server composition, Cloud, and
Durable are collected under [advanced patterns](references/advanced-patterns.md).

## Ordinary path: one app, one Edge Function

### 1. Generate the server

From a repository containing `supabase/config.toml`:

```sh
npx chumbo setup
npx chumbo skill install
```

Setup previews its writes, asks who may connect, generates the function and
contract test, and reports the remaining steps. Installing the project-local
skill gives later agent sessions version-matched guidance. Setup is resumable
and does not overwrite builder-authored `capabilities.ts`.

### 2. Replace the starter with one real operation

The generated `whoami` tool is a diagnostic starter. Replace it with a
capability from the application rather than exposing database mechanics, then
update `index_test.ts` to discover and invoke the replacement. For example:

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
        data
          .map((task) => `- ${task.title} – ${task.status} (${task.id})`)
          .join("\n"),
      );
    },
  );
}
```

The tool describes a user-visible operation. Identity comes from `ctx`; it is
not accepted as a tool argument.

### 3. Run the local proof loop

Use separate terminals because the server command streams until stopped:

```sh
supabase start
npx chumbo dev --function mcp
deno task --config supabase/functions/mcp/deno.json test
npx chumbo doctor \
  --function mcp \
  --url http://127.0.0.1:54321/functions/v1/mcp
```

Supply `--token` when the selected access mode requires one. Generated tests
prove the mode-specific scaffold contract: API-key mode invokes the starter,
OAuth and bearer modes prove their unauthenticated rejection, and public mode
proves the fetch handler boots. Separately discover and invoke one real
application capability with an appropriate identity.

### 4. Deploy and connect

```sh
supabase functions deploy mcp --no-verify-jwt
npx chumbo doctor \
  --function mcp \
  --url https://PROJECT_REF.supabase.co/functions/v1/mcp

claude mcp add --transport http my-app \
  https://PROJECT_REF.supabase.co/functions/v1/mcp
```

The command above fits OAuth or public mode. API-key and bearer clients must
send their credential:

```sh
claude mcp add --transport http my-app \
  https://PROJECT_REF.supabase.co/functions/v1/mcp \
  --header "Authorization: Bearer <credential>"
```

Keep live credentials out of committed project configuration, logs, and copied
diagnostic output.

The generated function disables the Supabase gateway JWT check because the
function owns the MCP authentication challenge. Protected modes still verify
every credential inside the runtime.

## Choose who connects

| Mode    | Use it when                                                            | Handler authority                                                   |
| ------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| OAuth   | End users connect their own accounts                                   | Supabase user token and existing RLS                                |
| Bearer  | An application-controlled client already holds a Supabase access token | Supabase user token and existing RLS                                |
| API key | A trusted machine or application-owned principal connects              | Verified subject and scopes; `ctx.supabase` uses the anonymous role |
| Public  | The capability is intentionally anonymous                              | Anonymous role plus the generated Postgres rate limiter             |

OAuth is the ordinary choice for a user-facing product. API key is the shortest
authenticated start for a prototype or trusted machine caller.

## Rules that matter on every path

- Keep application behavior in `capabilities.ts`; let the generated entrypoint
  own protocol and authentication plumbing.
- Model application operations, not tables. Reuse existing RPCs, APIs, grants,
  and RLS instead of creating a parallel backend.
- Derive caller identity and authority from the verified request context, not
  from model-supplied identity, role, or scope fields.
- Choose each result for its actual consumer. Do not mirror raw rows or
  duplicate large values into text and structured output by default.
- Preserve builder-authored files when resuming setup or upgrading.
- Treat compilation as the first check, not completion. Exercise the real MCP
  transport and the relevant positive and negative authority cases.

## Advanced usage

Ignore these paths unless the application has the corresponding need:

- multiple auth strategies or identity-specific discovery;
- credential-partitioned request-to-request state;
- lifecycle events, advertised-surface proofs, or application-run correlation;
- MCP Apps, clean public URLs, or many MCPs from one function;
- Chumbo Cloud provisioning or the separate Durable runtime.

Read [advanced patterns](references/advanced-patterns.md) to select one of these
compositions without adding its concepts to the ordinary starter.

## Use the project's actual version

The installed dependency, Deno import, and TypeScript types define what the
project can use. Deployed response headers describe what is live. When public
documentation is available through the docs MCP, inspect the returned
`packageVersion` before applying an API to an older project:

```text
https://dxrpeagddrpbezbkgvdv.supabase.co/functions/v1/docs-mcp
```

## Success

The generated test passes; `doctor` reaches the intended endpoint; one real
application capability appears in discovery; an explicitly safe call produces
the intended application outcome; and the relevant unauthorized or cross-user
case fails correctly. State anything not exercised.
