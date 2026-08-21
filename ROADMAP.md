# Supa MCP Roadmap

This document records credible future release cuts. It is prior direction, not
a compatibility promise. A roadmap item ships only after a real application
proves the abstraction and the public package, living reference, and hosted
verification agree.

## Proposed 0.7.0: external JWT identities

- **Status:** Proposed advanced authentication pattern
- **Motivating cases:** applications with an existing third-party identity
  provider and workload-authenticated agents or services

### Outcome

Let a builder deploy Supa MCP on a Supabase Edge Function while retaining an
existing JWT issuer:

```text
Clerk / Auth0 / WorkOS / Firebase / Cognito / company OIDC
or a workload identity issuer
→ short-lived signed JWT
→ Supa MCP verifies the configured issuer and audience
→ verified claims become a normalized principal and capability scopes
→ that identity receives its allowed MCP surface
```

This is an optional advanced mode. Supabase OAuth remains the recommended
end-user path, application API keys remain the shortest non-interactive path,
and the generated beginner flow does not ask about JWT issuers.

### Builder stories

1. **Keep the application's existing login.** A builder already using a
   supported identity provider can let the same access token connect to MCP
   without adding Supabase Auth accounts or an MCP-specific API-key table.
2. **Authenticate machines without permanent secrets.** A builder can accept
   a short-lived workload identity token from an agent, VM, CI job, or service
   instead of distributing a long-lived MCP credential.
3. **Compose identities on one endpoint.** One MCP URL can accept Supabase
   users, prefixed application keys, and configured external JWTs while every
   request still resolves to exactly one strategy.
4. **Reuse the existing capability model.** External identities produce the
   same `principal`, named authentication strategy, scopes, request-specific
   instructions, and `withScopes()` discovery surface as current identities.
5. **Preserve RLS when Supabase already trusts the provider.** Builders using a
   configured Supabase Third-Party Auth integration can explicitly forward the
   verified token to the request-scoped Supabase client rather than rebuilding
   authorization in tool handlers.

### Public API direction

The exact names remain subject to the implementation spike. The intended
contract is first-class JWT authentication, not an API-key verifier carrying a
misleading label and not an unrestricted custom-auth escape hatch.

```ts
createSupabaseMcp({
  server,
  resourceUrl,
  auth: {
    mode: "jwt",
    strategy: "company-identity",
    issuer: "https://identity.example.com",
    audience: "https://example.com/mcp",
    async mapClaims(claims) {
      return {
        subject: claims.sub,
        clientId: typeof claims.azp === "string" ? claims.azp : undefined,
        scopes: applicationScopes(claims),
      };
    },
    supabase: {
      access: "anonymous", // or explicit verified pass-through
    },
  },
  register,
});
```

The package owns:

- OpenID Connect discovery or an explicitly configured JWKS endpoint;
- signature verification with an allowed asymmetric algorithm;
- issuer, audience, expiration, not-before, and key-ID validation;
- bounded JWKS caching and refresh when an issuer rotates keys;
- deterministic strategy selection and fail-closed authentication;
- normalized principal, claims, strategy, and scope context;
- request isolation and MCP discovery/invocation enforcement.

The builder owns:

- the issuer and audience they intend to trust;
- the application meaning of subject, client ID, and claims;
- claim-to-scope mapping;
- the application's actual data-plane authorization;
- configuring Supabase Third-Party Auth when the JWT should participate in
  Supabase RLS.

### Deterministic routing

JWTs do not have the explicit string prefix used by application keys. In
composed mode, the runtime may decode the unverified issuer and audience only
to select one configured verifier. Those unverified claims never grant access.
The selected strategy must then verify the signature and every configured
claim before it creates a principal.

Configuration is rejected when two JWT strategies could claim the same token.
A token that selects a JWT strategy and fails verification is rejected; it is
never retried as Supabase OAuth, bearer, or an application key.

### Supabase data-plane behavior

External JWT authentication and Supabase database identity are related but
separate decisions.

The safe default is an anonymous request-scoped Supabase client. The verified
principal and scopes can call the application's narrow RPCs or existing data
plane, just like a verifier-backed application key. Supa MCP must not
manufacture a Supabase user from arbitrary JWT claims.

Supabase also supports configured Third-Party Auth integrations for providers
including Clerk, Firebase Auth, Auth0, AWS Cognito, and WorkOS. When the
builder has configured one of those integrations and its token claims satisfy
Supabase's requirements, an explicit pass-through option may create the
request-scoped client with that exact token so grants and RLS remain
authoritative. Pass-through is opt-in and must not be inferred from the issuer
name.

A general workload token, such as a Google Cloud service identity token, does
not automatically become a Supabase RLS user. It still gains a verified MCP
principal and capability surface, while its handlers use an application-owned
data boundary.

Current Supabase reference:
[Third-party authentication](https://supabase.com/docs/guides/auth/third-party/overview).

### Delivery sequence

1. **Prove the verification seam.** Build a focused spike using one ordinary
   OIDC issuer and one workload issuer. Record Edge-runtime library size,
   verification latency, JWKS caching behavior, and key rotation behavior.
2. **Define the public types.** Add the JWT strategy, normalized provider-
   neutral claims, explicit Supabase-client behavior, and configuration-time
   ambiguity checks.
3. **Integrate composed authentication.** Route Supabase tokens, prefixed
   application keys, and external JWTs deterministically without fallback.
4. **Add generated and diagnostic affordances.** Teach `status` and `doctor`
   to identify the advanced mode and report missing issuer, audience, or
   remote-verification evidence. Do not add it to the default interactive
   decision ladder unless adoption demonstrates that it belongs there.
5. **Add a living reference pattern.** Demonstrate two signed identities
   receiving different tools, Resources, prompts, and instructions through
   one deployed Edge Function.
6. **Prove both data-plane cases.** Run one RLS integration using a configured
   Supabase third-party provider and one workload-identity integration using
   a narrow application operation with no fictional Supabase user.
7. **Dogfood from the public artifact.** Install the release candidate in a
   clean held-out Supabase project and verify a real remote MCP client before
   publishing `0.7.0`.

### Release evidence

The release is not complete until tests prove:

- valid signature, issuer, audience, expiry, and not-before handling;
- rejection of unsigned tokens, disallowed algorithms, wrong audiences,
  wrong issuers, expired tokens, premature tokens, and unknown keys;
- successful bounded refresh after a signing-key rotation;
- ambiguous multi-strategy configurations fail during application creation;
- a failed selected JWT never falls through to another auth strategy;
- claim mapping produces the expected subject, client ID, scopes, and
  request-specific instructions;
- unauthorized tools, Resources, prompts, and templates are absent from
  discovery and reject direct invocation;
- concurrent requests from different issuers do not share claims, scopes,
  clients, or rows;
- explicit third-party-token pass-through preserves a real RLS boundary;
- the anonymous data-plane default cannot bypass RLS or obtain a privileged
  client;
- generated checks, package tests, reference checks, hosted smoke, package
  dry-run, and clean public-artifact installation all pass.

### Non-goals

Version `0.7.0` will not:

- mint JWTs, host an identity provider, or implement login and consent pages
  for external issuers;
- store user sessions, workload credentials, or downstream provider secrets;
- prescribe claim names, roles, organizations, entitlements, or scope
  conventions;
- turn Supa MCP into a credential broker, IAM product, or generic policy
  engine;
- support non-JWT schemes such as AWS SigV4 under this API;
- treat an arbitrary verified JWT as a Supabase Auth user;
- make the advanced mode part of the beginner setup path.

### Decision to make before implementation

The spike must choose whether the public API should expose a constrained
declarative OIDC/JWKS strategy only, or additionally allow a custom JWT
verifier behind the same normalized result contract. The default should remain
declarative. A custom hook earns inclusion only if a real issuer cannot be
represented safely with issuer, audience, JWKS, and claim mapping.
