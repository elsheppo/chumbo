# Start a Supa MCP server

Five steps take an existing Supabase repository to an MCP client calling the
application. Each step ends in an observable result.

**1. Generate.** From the repository containing `supabase/config.toml`:

```sh
npx supa-mcp setup
```

Choose the access mode when prompted: OAuth for a product whose users connect
their own accounts, API key for the fastest authenticated start. The
[auth mode guide](../auth-modes) compares all four. Setup writes
`supabase/functions/mcp/`, previews every file first, and prints the ordered
remaining actions.

**2. Implement.** Edit the generated `capabilities.ts`. Query through
`ctx.supabase` so the caller's own grants and RLS apply. Choose `textResult`,
`structuredResult`, `renderResult`, or `resourceResult` according to the real
consumer. Define an `outputSchema` for structured results, and do not mirror a
database row into both result lanes automatically.

**3. Check locally.**

```sh
supabase functions serve mcp
deno task --config supabase/functions/mcp/deno.json test
npx supa-mcp doctor --url http://127.0.0.1:54321/functions/v1/mcp
```

**4. Deploy and verify.**

```sh
supabase functions deploy mcp --no-verify-jwt
npx supa-mcp doctor --url https://PROJECT_REF.supabase.co/functions/v1/mcp
```

Pass `--token` when the endpoint is authenticated to complete a full
`tools/list` probe. For OAuth mode, first enable Authentication → OAuth Server
in the Supabase Dashboard.

**5. Connect a client.** Point an MCP client at the deployed URL and call a
tool as a real user — for example:

```sh
claude mcp add --transport http my-app \
  https://PROJECT_REF.supabase.co/functions/v1/mcp
```

The [client connection guide](../connect-clients) covers Claude Code,
claude.ai, Claude Desktop, Cursor, and MCP Inspector, with the verification
status of each path.

Supa MCP does not choose an application schema or authorization model. Queries
run through the request-scoped Supabase client so the application's grants and
RLS remain authoritative.

Official platform references:

- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [Supabase Auth](https://supabase.com/docs/guides/auth)
