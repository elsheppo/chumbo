# Multi-tenant documents example

This example proves that Edge compute can be shared while every request retains
its own Supabase identity. Alice and Bob receive different rows from the same
MCP tool because `ctx.supabase` carries their respective JWTs and Postgres RLS
evaluates each query independently.

The `csm_*` tables are deliberately namespaced and contain no application data.
Run the migration locally, create two Auth users, add one membership and one
document for each organization, then call `list_documents` with each user's
access token. The integration test automates that fixture lifecycle.
