# Changelog

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
