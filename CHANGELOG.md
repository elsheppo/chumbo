# Changelog

## Unreleased

## 0.7.0 — 2026-08-26

- Allow opt-in durable state to name a separate Supabase environment for its
  private RPC client while preserving same-project behavior by default. OAuth
  verification and request-scoped data access remain on the application
  environment, and cross-project credential separation is regression-tested.
- Emit stable, matching JavaScript and declaration chunk names, and verify the
  actual packed artifact across Node ESM, strict TypeScript, and Deno rather
  than repairing declaration imports inside a generated-project smoke test.
- Add opt-in authenticated durable state with configured namespace allowlists,
  deployment-secret HMAC credential partitioning, bounded JSON/TTL/key inputs,
  and atomic get/CAS-put/CAS-delete Postgres RPCs. Public and ordinary
  stateless scaffolds remain unchanged.
- Add `--state-namespace` setup generation, private service-role-only SQL, a
  secret-safe runtime context, and local Postgres isolation/race/expiry proof.
- Reclaim unreachable expired credential partitions in index-backed batches of
  at most 16 rows during writes, with concurrent writers using `SKIP LOCKED`.
- Make the required RLS integration gate target its multi-tenant example
  schema and fail closed when that local stack is not running, instead of
  allowing a skipped suite to look successful. Give that fixture dedicated
  local ports so it can coexist with the living-reference stack, and allow the
  real Auth fixture enough time to complete on a cold start without making
  fixture provisioning compete with the concurrent RLS assertions. Ignore its
  local CLI metadata just like the living-reference project's metadata, and
  retry only the local Auth client's explicitly retryable transport failures.
- Keep release-candidate imports aligned with the package version without
  rewriting the hosted deployment record before a real deployment. Hosted
  smoke remains the authority for detecting deployment drift.
- Verify hosted Edge Function runtime fingerprints during the living-reference
  smoke instead of treating content synchronization as deployment proof.
- Document current and established Supabase Edge key compatibility plus the
  distinction between invalid credentials and runtime configuration failures.

## 0.6.6 — 2026-08-25

- Treat an empty modern publishable- or secret-key dictionary as absent so an
  established project can fall through to its singular or legacy key. This
  covers projects where Edge injects an empty modern dictionary alongside a
  still-active legacy key.
- Add an assembled OAuth regression for that exact mixed-generation runtime
  environment.

## 0.6.5 — 2026-08-25

- Normalize platform-injected `SUPABASE_PUBLISHABLE_KEYS` and
  `SUPABASE_SECRET_KEYS` JSON dictionaries into the explicit runtime
  environment passed to Supabase clients. Singular modern variables and legacy
  variables converge on the same shape, with explicit configuration retaining
  precedence.
- Resolve the project URL and inline JWKS from Edge runtime variables when an
  application does not pass them explicitly. Malformed JSON reports only the
  affected variable name and expected shape, never its value.
- Exercise the fully assembled OAuth request against the same modern plural-key
  environment supplied by current Supabase Edge projects.

## 0.6.4 — 2026-08-25

- Accept both current Supabase publishable/secret-key configuration and the
  legacy `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` variables still
  injected by established Edge Function projects. Explicit modern
  configuration always wins; credentials are never logged or returned.
- Distinguish rejected credentials from post-verification runtime setup
  failures. Callers receive a safe `server_error`, while `onError` identifies
  the `runtime` phase and retains a secret-safe configuration message for
  operators and coding agents.
- Add fully assembled OAuth request proofs for modern and legacy project key
  configurations, plus a missing-key diagnostic and secret-exclusion case.

## 0.6.3 — 2026-08-25

- Cache remote Supabase JWKS snapshots for one minute per Edge runtime instead
  of rebuilding a network-backed resolver for every authenticated request.
  Failed fetches are evicted immediately, responses are bounded to 64 KiB, and
  inline platform JWKS behavior is unchanged.

## 0.6.2 — 2026-08-22

- Add `supa-mcp/app`, a small browser-side MCP Apps workspace helper that
  applies host theme/font tokens and safe areas, replaces content-driven iframe
  growth with one bounded inline viewport, provides an internal-scroll
  contract, and exposes optional fullscreen negotiation without imposing a UI
  kit.

## 0.6.1 — 2026-08-20

- Bundle an optional project-local Supa MCP agent skill that teaches
  application-oriented capability boundaries, explicit result contracts,
  Supabase-native authority, and protocol-level completion evidence.
- Add `supa-mcp skill install`, `skill status`, and `skill update` with plan,
  confirmation, and stable JSON modes for interactive builders and coding
  agents.
- Preserve existing `AGENTS.md` instructions through a marked managed pointer.
  Record installed file hashes in a managed manifest and refuse to overwrite
  local edits during updates.
- Mention the optional skill in guided setup without installing it
  automatically.

## 0.6.0 — 2026-08-20

- Replace automatic JSON-to-text duplication with explicit result contracts:
  `textResult`, `structuredResult`, `renderResult`, and `resourceResult`.
- Remove `jsonResult` and `toMarkdown`. Structured results now preserve the
  exact JSON value, and builders declare the matching tool `outputSchema`.
- Update the generated capability scaffold and living examples to demonstrate
  text-only, structured-only, deliberate hybrid, recoverable error, and
  large-resource result patterns.
- Move complete living documentation bodies to stable MCP Resources at
  `supa-mcp://docs/{kind}/{slug}`. Documentation tools now return compact
  reading cards and resource links instead of duplicated bodies.

## 0.5.0 — 2026-08-20

- Add composed authentication so one MCP endpoint can accept Supabase OAuth
  users and application-owned API keys without collapsing their authority or
  database behavior into one credential path.
- Route every credential to exactly one named strategy before verification.
  Verifier-backed application keys require a non-overlapping prefix in composed
  mode, and a failed match never falls through to OAuth.
- Add normalized `ctx.authentication` and `ctx.principal` context alongside the
  existing `ctx.user`, `ctx.subject`, `ctx.scopes`, and request-scoped Supabase
  client. Supabase users retain their JWT-backed RLS client; application keys
  retain an anonymous client and application-resolved identity and scopes.
- Add a living privileged-capabilities pattern proving that ordinary users and
  privileged application identities receive different tools, resources,
  prompts, and server instructions from the same endpoint.

## 0.4.0 — 2026-08-18

- Add `instructions` to `createSupabaseMcp`: server-level usage guidance
  returned in the `initialize` result, as a static string or a per-request
  `(context) => string` resolver for row-defined servers. Tool descriptions
  were already surfaced; server instructions previously had no pathway.
- Generated scaffold now sets a starter `instructions` value builders are
  expected to rewrite alongside `capabilities.ts`.
- Restructure the README around the builder journey and add reference
  documents for the five-step quickstart, access-mode selection, and MCP
  client connection with a verification-status matrix.

## 0.3.2 — 2026-08-17

- Make `status` and `doctor` distinguish endpoint reachability, responses proven
  to come from Supa MCP, access-gate behavior, and authenticated MCP discovery.
- Add non-secret runtime fingerprint headers for deployed version, auth mode,
  API-key strategy, and advertised resource URL.
- Recognize verifier-backed and custom application-key setups without
  prescribing the generated `MCP_API_KEY` secret.
- Treat the generated capabilities, Deno task, and contract-test layout as
  recommended diagnostics rather than runtime requirements for composed
  functions.
- Keep an uncredentialed but protected endpoint in a ready-to-test state instead
  of reporting a blocking failure or claiming authenticated verification.

## 0.3.1 — 2026-08-15

- Connect guided setup to the live Supa MCP documentation server with an
  agent-ready handoff and a concrete authenticated-tools implementation prompt.
- Add the open-source living Supabase reference project, including executable
  authenticated, model-facing-result, documentation, and many-MCP patterns.
- Add deterministic Git-to-Supabase content synchronization plus clean-clone
  and hosted deployment verification in CI.
- Align the CLI banner, doctor identity, and generated Deno runtime pin with
  the published package version, with a regression test preventing drift.

## 0.3.0 — 2026-08-15

- Make the model-facing text lane first-class. `content[].text` is the portable
  model-facing channel; because some clients do not surface
  `structuredContent` to the model, the result helpers now treat text as a
  complete standalone payload.
- Add `renderResult(value, render)`: the recommended helper. A required
  renderer composes the complete model-facing markdown; the raw value rides
  along as structured content for typed clients.
- Add `toMarkdown(value)`: a generic legible renderer (bolded keys, list
  rows, one-line rows for flat objects, explicit `(none)` empties).
- `jsonResult(value)` with no text now emits `toMarkdown(value)` instead of
  a raw JSON dump. Passing `text` still replaces the rendering verbatim, but
  is discouraged: it hides the payload from the model — use `renderResult`.
- `errorResult(message, nextStep?)` can append a `→ Next:` recovery line so
  errors never leave the model at a dead end.

## 0.2.0 — 2026-08-14

- Add a first-class `api-key` auth mode with a one-secret generated default.
- Add application-owned API-key verification with isolated admin lookup,
  stable subjects, and optional scopes.
- Teach guided setup, generated tests, status, and doctor to understand the
  API-key path without mistaking it for public access or Supabase user auth.
- Include `ctx.subject` in the request context and generated identity examples.

## 0.1.0 — 2026-08-13

- Launch Supa MCP as an end-user MCP runtime and guided setup experience for
  existing Supabase applications.
- Generate a deployable Edge Function with tools, resources, prompts, and an
  MCP multi-round-trip example on the official SDK.
- Use Supabase Auth, request-scoped clients, and application-owned RLS instead
  of introducing another identity or authorization model.
- Support OAuth, bearer-token, and intentionally public access modes, with a
  generated Postgres rate limiter for public servers.
- Add optional capability scopes without imposing an organization, role, or
  entitlement schema on the application.
- Add resumable setup, status, deployment, auth-aware diagnostics, and stable
  JSON next actions for agents and CI.
- Support clean public MCP URLs while keeping Supabase Auth as the independent
  OAuth issuer, and verify that discovery advertises the client-facing URL.
