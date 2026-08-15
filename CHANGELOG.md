# Changelog

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
