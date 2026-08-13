# Changelog

## 0.3.0 — 2026-08-13

- Add a guided, resumable `setup` command over the existing initializer.
- Add read-only `status`, auth-aware remote diagnostics, and versioned JSON
  reports with stable setup step IDs for agents and CI.
- Add explicit opt-in migration and deployment execution without hiding
  dashboard actions or pending application migrations.
- Rewrite onboarding around a progressive human and agent installation ladder.

## 0.2.0 — 2026-08-13

- Add optional application-resolved scopes and scoped capability discovery.
- Add `ctx.hasScope()`, `ctx.hasScopes()`, and `server.withScopes()` without
  changing unscoped registration.
- Guard new public scaffolds with a Postgres-backed, per-caller rate limit.
- Keep OAuth as the unchanged default and generate no access-control storage
  for authenticated projects.

## 0.1.1 — 2026-08-13

- Make the generated Deno test self-contained when run directly from a clean project.

## 0.1.0 — 2026-08-11

- Initial release.
- Request-scoped Supabase Auth and RLS context for MCP Edge Functions.
- OAuth protected-resource discovery and Bearer challenges.
- Modern MCP 2026-07-28 with stateless legacy compatibility.
- `init`, `doctor`, and `dev` commands.
- Tool, resource, prompt, and multi-round-trip examples.
