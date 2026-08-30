# Chumbo Roadmap

This document records credible future release cuts. It is prior direction, not
a compatibility promise. A roadmap item ships only after a real application
proves the abstraction and the public package, living reference, and hosted
verification agree.

## 0.8.0: Chumbo identity transition

- **Status:** Shipped on 2026-08-26
- **Outcome:** `chumbo` is the canonical npm package and CLI. The existing
  `supa-mcp` command remains available as a transition alias, and established
  technical identifiers remain stable where changing them would break deployed
  projects or durable state continuity.

## 0.7.0: opt-in durable MCP state

- **Status:** Shipped on 2026-08-26
- **Motivating cases:** MCP capabilities that need small, durable coordination
  across otherwise disposable Edge Function requests

### Outcome

Protected MCPs may opt into bounded, namespace-allowlisted state backed by
private Postgres functions. Each exact caller credential receives a
deployment-keyed HMAC partition, while capability code receives only `get`,
revision-checked `put`, and revision-checked `delete`. Stateless behavior
remains the default.

Authentication and request-scoped application data stay on the application's
Supabase environment. Builders may optionally configure `state.supabase.env`
when the private state RPCs belong to a separate Supabase project; the
service-role client remains closure-confined in both configurations.

This release is coordination storage, not a resident actor or Durable Object
runtime. It does not add leases, queues, alarms, actor messaging, generalized
transactions, or background execution.

## Candidate: external JWT identities

- **Status:** Proposed advanced authentication pattern
- **Motivating cases:** applications with an existing third-party identity
  provider and workload-authenticated agents or services

### Outcome

Let a builder deploy Chumbo on a Supabase Edge Function while retaining an
existing JWT issuer:

```text
Clerk / Auth0 / WorkOS / Firebase / Cognito / company OIDC
or a workload identity issuer
→ short-lived signed JWT
→ Chumbo verifies the configured issuer and audience
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
plane, just like a verifier-backed application key. Chumbo must not
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
   publishing the external-JWT release.

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

The external-JWT release will not:

- mint JWTs, host an identity provider, or implement login and consent pages
  for external issuers;
- store user sessions, workload credentials, or downstream provider secrets;
- prescribe claim names, roles, organizations, entitlements, or scope
  conventions;
- turn Chumbo into a credential broker, IAM product, or generic policy
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

## Candidate: durable MCP Tasks

- **Status:** Proposed next core capability after identity federation
- **Motivating cases:** work that cannot or should not complete inside one Edge
  Function request

### Outcome

Map MCP's durable task lifecycle onto Supabase-native persistence and Queues:

```text
agent starts work
→ Chumbo verifies identity and capability
→ task and job are persisted
→ a worker executes the application-owned operation
→ the agent reads status and the durable result
```

This makes long imports, image processing, reports, bulk mutations, and other
asynchronous application work feel like one coherent MCP capability instead of
a custom collection of polling tools.

The package may own:

- protocol registration for task creation, status, cancellation, and results;
- a small optional Postgres and Supabase Queues adapter;
- task IDs, request correlation, idempotency, and terminal-state handling;
- result delivery through explicit result contracts or MCP Resources;
- request-scoped authorization for creating, discovering, and controlling a
  task.

The builder continues to own:

- the work performed by the job;
- the worker or Edge Function that performs it;
- application retry and compensation behavior;
- which identities may create, inspect, cancel, or receive each result;
- whether authority is re-evaluated at execution time or deliberately captured
  when the task is accepted.

Bearer credentials must not become durable queue payloads. Task records retain
the minimum application principal and audit information needed for the chosen
authority model, while database grants, RLS, and narrow worker operations
remain authoritative.

Start with a living reference implementation using
[Supabase Queues](https://supabase.com/docs/guides/queues). Promote an adapter
into the runtime only after the example identifies repeated protocol and state
machinery that builders should not rewrite.

### Release evidence

- Create, inspect, cancel, complete, fail, and read-result paths work through
  the real MCP transport.
- Duplicate creation or delivery does not execute one logical task twice.
- Ordinary identities cannot discover or control another identity's tasks.
- Cancellation and revocation semantics are explicit rather than implied.
- A complete result can outlive the initiating Edge request without retaining
  its bearer token.
- Concurrent workers cannot produce contradictory terminal states.
- A hosted reference proves the complete agent → queue → worker → result loop.

### Non-goals

The durable-Tasks release will not provide a general workflow engine, prescribe the
worker runtime, or hide an application's business retries behind a false
exactly-once guarantee.

## Candidate: MCP Apps on Supabase

- **Status:** Hosted living pattern proven; reusable runtime surface under
  review
- **Motivating cases:** capabilities that are easier to understand or control
  through an interactive interface than through text alone

### Outcome

Make a tool-linked MCP App straightforward to host beside the MCP Edge
Function:

```text
agent calls a tool
→ result points to an application UI resource
→ bundled HTML loads through resources/read
→ the UI calls app-only tools through the authorized host connection
→ those calls retain the same Supabase identity, scopes, and RLS boundary
```

The useful Chumbo seam is not a new frontend framework. It is the deployment
and protocol glue that currently makes an otherwise small app difficult:

- register the application resource and its relationship to a tool;
- provide a generated minimal HTML application fixture;
- support Edge Function or Storage-backed asset delivery;
- make resource metadata, content types, CSP, and public URLs explicit;
- preserve the authenticated application boundary for interactive actions;
- verify the tool call, resource load, and app action in local and hosted
  smoke tests.

The first experiment uses a single-file browser bundle carried inside the MCP
Resource response. This avoids a second web origin, browser-held Supabase
credentials, and direct HTML serving. Storage remains useful for public or
signed media, but is not required for the application shell.

Tool visibility is presentation metadata, not authorization. App-only tools
must still use ordinary Chumbo scopes and application-owned RLS or policy.

The first reference should be intentionally small and production-shaped. A
builder should be able to replace its HTML and framework without replacing
Chumbo's runtime or deployment model.

### Evidence now in hand

- one deployed Edge Function serves the MCP endpoint, authenticated app tools,
  and a self-contained HTML Resource;
- an ordinary tool exposes concise model text, exact View data, and the linked
  App Resource without exposing app-only mutation tools to the model picker;
- app actions traverse the host's existing OAuth connection and persist
  through the request-scoped RLS-aware Supabase client;
- two hosted users cannot read or decide each other's rows;
- the official MCP Apps reference host renders the public Edge Function,
  executes a decision, receives updated UI state, and receives model context;
- Claude dynamically registers through Supabase OAuth, distinguishes the one
  model-visible interactive tool from two app-only tools, renders the bundled
  View, and persists a decision through the app-only path;
- browser hosts require an explicit origin-aware preflight policy at the HTTP
  boundary. A future Chumbo abstraction should make that opt-in and visible.
- hosted clients that initiate OAuth also require the Supabase project's OAuth
  server plus an application-owned authorization UI. Chumbo should diagnose
  that prerequisite clearly; it should not generate or own the product's login
  and consent experience.
- OAuth setup guidance must be plan-aware: use the builder's existing
  frontend, a free static host, or a paid custom domain. The default hosted
  Edge Function URL cannot serve the consent page as HTML.

### Non-goals

The MCP Apps release will not become an application builder, component library,
design system, browser automation suite, or general MCP testing product.

## Candidate: production operations

- **Status:** Capability lifecycle v1 shipped in `0.9.0`; optional explicit
  run-correlation extension implemented in the next package candidate
- **Motivating cases:** builders need to understand who invoked a capability,
  what happened, and how much work the request consumed

### Outcome

Expose a small stable lifecycle-event surface around the existing trace ID:

- authentication accepted or rejected;
- capability discovery and direct invocation decisions;
- tool, Resource, prompt, and Task start, finish, and failure;
- principal, authentication strategy, capability name, duration, result size,
  and terminal status;
- builder-defined audit, usage, and rate-limit hooks.

Events should be structured, redact credentials by construction, and flow to a
builder-provided sink. A living pattern can demonstrate Postgres audit rows and
Supabase's existing logging surface, but the runtime should not require either
storage choice.

This release should also make oversized result warnings and per-principal
usage decisions possible without installing a second policy framework.

### Non-goals

The production-operations release will not ship a hosted observability product, silently collect
telemetry, retain model prompts by default, or replace an application's billing
and entitlement system.

## Advanced living-pattern backlog

The following ideas should begin as executable reference patterns, not version
promises or new core abstractions:

- **Storage-backed Resources:** private and public documents or media with
  correct MIME types, cache hints, signed delivery, and RLS-aware access.
- **Realtime capability updates:** notify a connected surface when a Resource
  changes or a durable Task completes, without treating Realtime as required
  transport machinery.
- **Database-backed actors:** after two real adopters need more than bounded
  CAS state, evaluate an actor layer with addressable mailboxes, per-actor
  serialized transitions, transactional outbox results, Cron-backed alarms,
  and private Realtime delivery. Edge Functions remain disposable workers;
  Postgres owns durability and ordering. Do not label the current state API an
  actor runtime or add queues/leases/messages before that evidence exists.
- **Cron-triggered agent workflows:** scheduled SQL, database functions, or
  Edge Function calls that prepare work an MCP identity can later inspect.
- **Many MCPs from one function:** continue hardening the existing row-defined
  reference without creating a separate fleet framework.
- **Managed capability surfaces:** prove one application-owned catalog whose
  named profiles and custom selections resolve to different MCP surfaces for
  different users or tenants. The reference should keep profile selection
  separate from authority: compute the effective surface from selected tools,
  application grants, and authorized dependency closure; then prove the same
  decision in discovery and direct invocation. RLS may govern profile,
  selection, and grant rows, but Chumbo must not prescribe those tables,
  role names, or an administration UI.
- **Application-key pairing:** simple one-key onboarding and rotation for
  clients that cannot complete OAuth, proven through a real application.
- **Explicit run-aware capabilities (package candidate):** let an application
  mint one bounded,
  opaque handle for a logical run or work order, carry it through controlled
  request metadata or an explicit field on selected tools, and use the verified
  digest as a lifecycle-v2 and state-key dimension. Unconfigured servers retain
  lifecycle v1, and no handle means invocation-only behavior. Never infer a run
  from an MCP session, credential, connection, IP address, `traceparent`, or
  timing proximity. Keep run identity distinct from authentication, invocation
  trace identity, and any future Durable actor identity; early close,
  revocation, and distinct-run quotas remain application-owned storage
  concerns.
- **Custom domains and proxy routes:** deployment recipes for a clean MCP URL
  while keeping the authorization issuer and protected-resource metadata
  correct.
- **External JWT data planes:** one third-party identity using Supabase RLS and
  one workload identity using a narrow application operation, as required by
  the external-JWT release evidence.

The promotion rule is deliberate:

```text
real application need
→ living pattern
→ hosted and held-out evidence
→ repeated adopter friction
→ smallest useful package abstraction
```

Chumbo should not wrap every Supabase feature. It should own the reusable MCP
boundary and teach builders how existing Supabase capabilities compose behind
it.

## Directional sequence

```text
shipped: bounded durable MCP state and Chumbo identity transition
next candidates: external identity federation and durable agent work
later candidates: interactive MCP Apps and production visibility hooks
```

The sequence is directional. A living pattern may advance without forcing a
runtime release, and real dogfooding evidence may change the order.
