# Many MCPs from one Edge Function

Use this pattern when one deployment should expose several independently named
MCP surfaces. A path such as `/many-mcps/directory` resolves one server row;
`/many-mcps/invoices` resolves another. Supa MCP's `register(server, context)`
runs per request, so tool rows can be read and registered without a new library
mode or a redeployment.

The reference implementation keeps the demonstration servers public and
rate-limited. Production applications can use the same Supa MCP auth modes as a
single server. Authentication of the MCP caller and authorization at any
downstream data plane remain explicit application decisions; the pattern does
not imply that forwarding one shared key proves user-RLS isolation.

The living test proves distinct tool lists, successful execution, and a useful
404 for an unknown server.

Source:

- `supabase/functions/many-mcps/`
- `supabase/seed.sql`
- `supabase/tests/reference_integration_test.ts`

Official platform references:

- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
