# Supa MCP agent guide

## What this repository is

Supa MCP turns an existing Supabase application into an end-user-facing MCP
server. The package provides a TypeScript runtime, a guided CLI, and generated
Supabase Edge Function templates. It is not the official Supabase management
MCP, a database-to-tools generator, or a replacement authorization system.

The happy path is deliberately small: a builder runs `npx supa-mcp setup`,
implements application capabilities in the generated `capabilities.ts`,
deploys one Edge Function, and lets existing Supabase or application auth
govern access.

## Product contracts

- Supabase Auth, Postgres grants, RLS, or the builder's application-owned API
  key verifier remain authoritative. Do not impose organization, membership,
  role, or entitlement tables on applications.
- Create a fresh request-scoped Supabase client for each caller. Never share
  caller identity or authorization state across requests.
- The generated server uses Streamable HTTP and the official MCP registration
  APIs. Keep tools, resources, prompts, and multi-round-trip flows available
  without inventing a parallel capability framework.
- `content[].text` must be a complete, legible model-facing result because some
  clients do not surface `structuredContent` to the model. Prefer
  `renderResult`; use `jsonResult` as a prototyping fallback. Give errors and
  empty states a useful next step when one exists.
- Public mode stays intentionally simple but must retain its generated
  Postgres-backed rate-limit guardrail.
- Setup must remain resumable, idempotent, and agent-friendly. `--json` never
  prompts, never leaks tokens, and returns stable step IDs and next actions.

## Repository map

- `src/runtime.ts`: request handling and MCP server lifecycle.
- `src/results.ts`: model-facing and structured tool result helpers.
- `src/setup.ts`, `src/project.ts`, `src/doctor.ts`, `src/cli.ts`: guided setup,
  project inspection, remote verification, and the command-line interface.
- `templates/function/`: generated Edge Function and capability scaffold.
- `templates/migrations/`: optional generated database support such as public
  rate limiting.
- `test/`: unit, protocol, generated-project, and optional RLS integration
  coverage.
- `scripts/generated-smoke.mjs`: clean generated-project contract check.
- `SPEC.md`: detailed product and architecture decisions.

## Working in the repository

Use Node 22 and pnpm 10.11.0.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm format:check
```

`pnpm check` is the ordinary release gate: typecheck, unit/protocol tests,
build, and generated-project smoke. Run `pnpm run test:rls` only when its local
Supabase integration credentials are available; it is intentionally optional
in ordinary CI. Use `npm pack --dry-run` to inspect the public artifact.

When changing public behavior:

- Update exports in `src/index.ts`, focused tests, README examples, and the
  changelog when the public API changes.
- Update templates plus setup/status/doctor behavior when generated projects
  change, then exercise the generated smoke test.
- Add positive and negative isolation coverage for authentication, scopes, RLS,
  or request-lifecycle changes.
- Keep runtime dependency versions pinned and commit the lockfile.
- Preserve handwritten generated `capabilities.ts` files; setup must not
  overwrite application code on resume.

Do not publish npm versions or create GitHub releases without explicit user
authorization. The release workflow publishes the package from a published
GitHub release after running the full check suite.
