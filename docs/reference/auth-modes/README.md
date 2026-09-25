# Choose an access mode

Setup asks one load-bearing question: who may connect. The four answers, in
the order most applications adopt them:

- **API key** – one shared secret in the `MCP_API_KEY` Edge secret, or an
  application-owned verifier against your own key table. Fastest authenticated
  start; no dashboard configuration. Handlers receive an anonymous Supabase
  client, so capability code owns the authorization decision. Pick this for a
  prototype or for trusted server-to-server callers.
- **OAuth** – end users connect their own accounts from an MCP client. The
  default uses a Supabase access token, so existing grants and RLS apply
  unchanged, and requires enabling Authentication → OAuth Server in the
  Supabase Dashboard. An application-owned issuer can instead verify opaque
  access tokens and supply its own authorization. Pick this for a product; it
  is the only mode claude.ai custom connectors can complete on their own.
- **Bearer** – the platform already hands clients a Supabase user access
  token, so no interactive flow is advertised; RLS behavior is identical to
  Supabase-token OAuth. Pick this when your own client software holds the session.
- **Public** – anonymous access through the `anon` role, guarded by a
  generated Postgres rate limiter that fails closed until its migration is
  applied. Pick this only for data you would publish on an unauthenticated
  API.

Public rate limiting is a useful guardrail, not a complete abuse-prevention
boundary. On hosted Supabase, the runtime prefers Cloudflare's
`cf-connecting-ip` request metadata. Its forwarded-IP fallbacks depend on the
trust configuration of any custom proxy or self-hosted gateway in front of the
function. Nonstandard deployments should treat those headers accordingly and
add application-specific abuse controls when the exposure warrants them.

Switching later is cheap: re-run `npx chumbo setup --auth <mode>` and the
scaffold is regenerated around your untouched `capabilities.ts`.

Two rules hold in every mode. Do not accept a user ID as a tool argument, and
do not give end-user handlers a service-role client. With Supabase user tokens,
the request-scoped `ctx.supabase` client carries the caller's RLS authority.
With application keys or opaque OAuth tokens, it uses the `anon` role, and
capability code must enforce the caller's application permissions.

For Supabase-token OAuth and bearer deployments, Chumbo reads the current
publishable and secret-key variables injected by Supabase Edge Functions and
also supports the legacy `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`
variables retained by established projects. Explicit runtime configuration
still takes precedence. User tokens are verified against Supabase's JWKS, with
remote keys cached briefly so ordinary requests do not add a key-network round
trip.

For an application-owned OAuth issuer, configure its `issuer` and a verifier.
Here `authorizationServer` stands for your application's token service:

```ts
auth: {
  mode: "oauth",
  issuer: "https://auth.example.com",
  async verify({ token, resourceUrl, issuer }) {
    const grant = await authorizationServer.verify(token, {
      issuer,
      resource: resourceUrl,
    });
    if (!grant || grant.revoked) return null;
    return {
      subject: grant.subject,
      clientId: grant.clientId,
      scopes: grant.scopes,
      expiresAt: grant.expiresAt, // Unix seconds
    };
  },
},
```

The verifier owns issuer, exact resource, expiry, and revocation checks.
Chumbo checks the returned subject and expiry, then gives the handler an
anonymous Supabase client. The opaque MCP bearer is never used as a Supabase
user token. If `verify` is omitted, Chumbo verifies a Supabase JWT as before.

Invalid credentials remain `invalid_token`. If token verification succeeds but
the runtime cannot construct the request-scoped Supabase client, the caller
receives `server_error` and `onError` reports the `runtime` phase with a
secret-safe configuration message. This distinction keeps credential failures
separate from deployment configuration failures.

Official platform references:

- [Supabase Auth](https://supabase.com/docs/guides/auth)
- [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
