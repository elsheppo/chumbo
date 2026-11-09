# Start a Chumbo server

Five steps take an existing Supabase repository to an MCP client calling the
application. Each step ends in an observable result.

**1. Generate.** From the repository containing `supabase/config.toml`:

```sh
npx chumbo setup
```

Choose the access mode when prompted: OAuth for a product whose users connect
their own accounts, API key for the fastest authenticated start. The
[auth mode guide](../auth-modes) compares all four. Setup writes
`supabase/functions/mcp/`, previews every file first, and prints the ordered
remaining actions.

**2. Implement.** The generated `capabilities.ts` starts with one runnable
`whoami` tool. Replace that tool with one application operation and query
through `ctx.supabase` so the caller's own grants and RLS apply. The
[capability and result showcase](../../patterns/model-facing-results) keeps
tools, Resources, prompts, elicitation, and alternative result contracts
executable without loading them into the starter.

**3. Check locally.**

```sh
supabase start
npx chumbo dev --function mcp
```

For public mode, run `supabase migration up --local` after `supabase start`
and before serving the function so the generated local rate limiter is ready.
For generated API-key mode, put `MCP_API_KEY` in the gitignored file
`supabase/functions/.env.local` and serve with
`--env-file supabase/functions/.env.local`.

With the function still running, use another terminal:

```sh
deno task --config supabase/functions/mcp/deno.json test
npx chumbo doctor \
  --function mcp \
  --url http://127.0.0.1:API_PORT/functions/v1/mcp \
  --call-tool whoami
```

Use the exact Local MCP URL printed by `chumbo dev`. `API_PORT` comes from
`[api].port` in `supabase/config.toml` and defaults to `54321` when omitted.

Add `--token <MCP_API_KEY>` to doctor for generated API-key mode or
`--token <LOCAL_USER_JWT>` for bearer/OAuth mode. This initializes MCP, lists
the available tools, and invokes only the tool you explicitly name. Local and
deployed development use the same Edge Function and capability source.

**4. Deploy and verify.**

```sh
supabase functions deploy mcp --no-verify-jwt
npx chumbo doctor --url https://PROJECT_REF.supabase.co/functions/v1/mcp
```

Pass `--token` when the endpoint is authenticated to complete initialization
and `tools/list`. Add `--call-tool <SAFE_TOOL>` only when doctor should invoke a
specific tool. For OAuth mode, first enable Authentication → OAuth Server in
the Supabase Dashboard.

**Verify any Supabase MCP.** `chumbo doctor` also works against servers that
are not built with Chumbo, including one built from Supabase's guide with
`withSupabase` and `withOAuthProtectedResource`:

```sh
npx chumbo doctor \
  --url https://PROJECT_REF.supabase.co/functions/v1/mcp \
  --token <USER_A_JWT> \
  --second-token <USER_B_JWT>
```

It follows the 401 challenge to the protected-resource metadata, then checks
the authorization server's metadata where MCP clients look, that its issuer
matches what your server advertises exactly (a Supabase custom domain is the
usual cause of a mismatch), whether clients can register themselves, and that
the project publishes asymmetric signing keys. Supabase's MCP guide requires
ES256 or RS256 keys, so a legacy HS256 project cannot use it; rotate under
Project Settings → JWT Keys.

With two tokens it calls read-only tools that need no input as both users and
flags any tool that returns the same data to each; mark read-only tools with
`readOnlyHint` so doctor can compare them. This is a heuristic, not proof. It
also reports Postgres permission errors from failed tool calls: from
2026-10-30, new tables in `public` need an explicit `grant` to the
`authenticated` role, including tables recreated by a local `supabase db reset`
and by preview branches (see [Breaking Change: Tables not exposed to Data and GraphQL API automatically](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)). Finally, it lints the tool surface.

Discovery sends only GET requests and never registers a client. With
`--second-token`, doctor calls only tools the server marks `readOnlyHint: true`
and trusts that mark. `--call-tool` calls exactly the tool you name.

**5. Connect a client.** Point an MCP client at the deployed URL and call a
tool as a real user – for example:

```sh
claude mcp add --transport http my-app \
  https://PROJECT_REF.supabase.co/functions/v1/mcp
```

The [client connection guide](../connect-clients) covers Claude Code,
claude.ai, Claude Desktop, Cursor, and MCP Inspector, with the verification
status of each path.

Chumbo does not choose an application schema or authorization model. Queries
run through the request-scoped Supabase client so the application's grants and
RLS remain authoritative.

Official platform references:

- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [Supabase Auth](https://supabase.com/docs/guides/auth)
