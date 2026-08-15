# Authenticated tools with RLS

Use this pattern when an MCP should expose the same user-owned application data
as the product UI.

Configure Supa MCP with OAuth for end-user connection flows or bearer mode when
the client already possesses a Supabase user access token. Inside each handler,
query through `ctx.supabase`. Do not accept a user ID as a tool argument and do
not replace the request-scoped client with `service_role`.

The living example exposes `create_project` and `list_projects`. Its
`demo_projects` table grants Data API access to `authenticated`, enables RLS,
and checks `(select auth.uid()) = owner_id` for every operation. The integration
test creates two users and proves that neither can read the other's project.

Failure invariant: a missing or invalid bearer is rejected before capability
execution. A valid user with no rows receives a legible empty state rather than
an authorization error or raw JSON.

Source:

- `supabase/functions/authenticated-tools/`
- `supabase/migrations/*_living_reference_schema.sql`
- `supabase/tests/reference_integration_test.ts`

Official platform references:

- [Supabase Auth](https://supabase.com/docs/guides/auth)
- [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
