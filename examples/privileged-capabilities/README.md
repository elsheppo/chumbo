# User and owner capability surfaces

The living reference function at
`supabase/functions/privileged-capabilities/index.ts` uses public
`chumbo@0.8.0` and one MCP endpoint.

- A real Supabase Auth user receives `catalog:read`, an RLS-aware Supabase
  client, the `list_catalog` tool, and the `catalog-guide` resource.
- A verified `supa_ref_...` application key receives `catalog:publish`, an
  anonymous Supabase client, the `preview_publication` tool, and the
  `plan_publication` prompt.
- A rejected `supa_ref_...` key returns 401 and is never retried as OAuth.
- Direct invocation of a capability outside the caller's scopes fails before
  its handler runs.

The API-key table exists only to make the reference executable. It is not a
schema recommendation. Replace it with the key system and scope vocabulary
your Supabase application already owns.
