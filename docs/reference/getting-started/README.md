# Start a Supa MCP server

Run `npx supa-mcp setup` from a repository that already contains
`supabase/config.toml`. Choose the access mode that matches the application,
then implement domain capabilities in the generated
`supabase/functions/mcp/capabilities.ts`.

Use `renderResult` for purpose-written model-facing responses. The complete
answer must live in `content[].text`; `structuredContent` carries the same raw
value for typed consumers.

Before deployment, run the generated Deno check and test. After deployment,
run `npx supa-mcp doctor --url <endpoint> --token <token>` when the endpoint is
authenticated.

Supa MCP does not choose an application schema or authorization model. Queries
run through the request-scoped Supabase client so the application's grants and
RLS remain authoritative.

Official platform references:

- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [Supabase Auth](https://supabase.com/docs/guides/auth)
