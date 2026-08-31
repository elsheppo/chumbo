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
  --url http://127.0.0.1:54321/functions/v1/mcp \
  --call-tool whoami
```

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
