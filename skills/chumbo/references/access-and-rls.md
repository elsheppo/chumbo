# Access and RLS

Keep three decisions separate:

1. **Authentication** identifies the caller and creates the request context.
2. **Capability discovery** determines which tools, Resources, and prompts that
   caller can see and invoke.
3. **Application authorization** uses grants, RLS, RPCs, or APIs to decide what
   data and effects the caller may actually reach.

## Access modes

| Mode    | Caller                                                            | `ctx.supabase`                                                                      |
| ------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| OAuth   | A user signs in through the application's Supabase Auth flow      | Fresh client carrying that user's token                                             |
| Bearer  | The calling application already has a Supabase user token         | Fresh client carrying that user's token                                             |
| API key | A static key or application verifier returns a subject and scopes | Anonymous client; application-owned checks or narrow APIs authorize privileged work |
| Public  | No authenticated principal                                        | Anonymous client with the generated Postgres rate limiter                           |

OAuth and bearer preserve normal user RLS semantics. API keys do not become
fictional Supabase users.

## Supabase users

Query through the request-scoped client so existing grants and RLS select the
caller's rows. Derive ownership from the authenticated session rather than a
model-supplied owner ID.

`TO authenticated` proves only that a valid token exists. Ownership still
needs the application's row predicate. Updates commonly need both `USING` and
`WITH CHECK`, plus the SELECT policy Postgres requires for matching rows.

Use server-controlled app metadata for authority-sensitive claims. User-editable
metadata is not an authorization source.

## Application API keys

A verifier-backed key can provide `ctx.subject`, `ctx.clientId`, and scopes.
`ctx.user` remains null. The verifier may temporarily receive an admin client
to resolve the credential, but capability handlers do not receive that client.

Reuse an existing narrow RPC, API, or verifier-aware service when possible. If
none exists, add a purpose-built application operation with its own authority
checks. A general service-role client in MCP handlers would bypass the
application boundary.

## Public endpoints

Public means anonymous, not unrestricted. Keep the generated database-backed
rate limiter and expose only data that the application would publish through
an unauthenticated API.

For multi-auth, identity-specific discovery, and `server.withScopes(...)`, read
[advanced patterns](advanced-patterns.md#multiple-identities-and-scoped-discovery).
