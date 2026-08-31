# Chumbo agent guide

## What this repository is

Chumbo turns an existing Supabase application into an end-user-facing MCP
server. The package provides a TypeScript runtime, a guided CLI, and generated
Supabase Edge Function templates.

The happy path is deliberately small: a builder runs `npx chumbo setup`,
implements application capabilities in the generated `capabilities.ts`,
deploys one Edge Function, and lets existing Supabase or application auth
govern access.

## Keep the value clear

Chumbo makes one Supabase-native MCP easy and supports increasingly advanced
patterns – including many MCPs from one function – through the same library. The
default path stays small: one builder's app exposes builder-authored
capabilities to that app's users. Advanced patterns must remain optional and
must not burden that setup.

The package owns the reusable boundary between an existing Supabase app and
MCP: protocol/runtime wiring, request-scoped identity, simple auth modes,
guided setup, diagnostics, and result helpers. The repository also owns a
living Supabase reference project whose tested patterns show how to compose
that same API with Supabase-native capabilities.

Do not impose application architecture merely because an advanced pattern can
use it. In particular, Chumbo does not prescribe:

- downstream API proxying, credential storage, or credential brokerage;
- database introspection that guesses and generates an application's tools;
- application schemas, organization models, or entitlement conventions;
- domain-specific tool behavior or purpose-written renderers.

Row-defined servers, path-based resolution, queued work, Storage resources,
Cron, Realtime, and search are valid Chumbo patterns when they use the same
public library and come with executable evidence. Keep application intelligence
in generated `capabilities.ts` or pattern code. Promote an abstraction into the
package API only when it simplifies real adopters without imposing a new
architecture on the ordinary one-MCP path.

## Brand voice

- Chumbo is the brand. "The MCP layer for Supabase apps" is the category, and
  "MCP made easy on Supabase" is the core promise.
- Lead with what builders can create and deploy. Avoid defensive comparisons
  to neighboring products unless the distinction helps a concrete decision.
- Public prose does not use em dashes. Use a spaced en dash – like this – when
  a sentence needs a dash.
- Keep the name warm and memorable while the supporting language stays
  concrete, technically credible, and free of inflated AI claims.

## Product contracts

- Supabase Auth, Postgres grants, RLS, or the builder's application-owned API
  key verifier remain authoritative. Do not impose organization, membership,
  role, or entitlement tables on applications.
- Create a fresh request-scoped Supabase client for each caller. Never share
  caller identity or authorization state across requests.
- The generated server uses Streamable HTTP and the official MCP registration
  APIs. Keep tools, resources, prompts, and multi-round-trip flows available
  without inventing a parallel capability framework.
- Design each result for its real consumer. Use `textResult` for agent-facing
  text, `structuredResult` plus `outputSchema` for typed clients,
  `renderResult` only for a deliberate hybrid, and `resourceResult` for large
  content served through MCP Resources. Never mirror a database row by default.
  Give errors and empty states a useful next step when one exists.
- Public mode stays intentionally simple but must retain its generated
  Postgres-backed rate-limit guardrail.
- Credential-partitioned durable state is an authenticated, explicit opt-in.
  Capability code receives only bounded get/CAS-put/CAS-delete operations for
  configured namespaces; the service-role client and caller partition never
  enter the handler context. This is state coordination, not an actor runtime
  or replacement for application-owned data-plane concurrency.
- Setup must remain resumable, idempotent, and agent-friendly. `--json` never
  prompts, never leaks tokens, and returns stable step IDs and next actions.

## Repository map

- `src/runtime.ts`: request handling and MCP server lifecycle.
- `src/results.ts`: model-facing and structured tool result helpers.
- `src/setup.ts`, `src/project.ts`, `src/doctor.ts`, `src/cli.ts`: guided setup,
  project inspection, remote verification, and the command-line interface.
- `templates/function/`: generated Edge Function and capability scaffold.
- `skills/chumbo/`: versioned project-local agent skill bundled in the npm
  artifact.
- `templates/migrations/`: optional generated database support such as public
  rate limiting.
- `test/`: unit, protocol, generated-project, and optional RLS integration
  coverage.
- `scripts/generated-smoke.mjs`: clean generated-project contract check.
- `supabase/`: living reference project, migrations, functions, and protocol
  integration tests.
- `docs/` and `examples/`: Git-authoritative instructions and runnable pattern
  metadata synced into the reference project's searchable database.
- `scripts/sync-reference-content.mjs`: one-way Git → Supabase content sync.
- `SPEC.md`: detailed product and architecture decisions.

## Working in the repository

Use Node 22 and pnpm 10.11.0.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm format:check
pnpm reference:check
```

`pnpm check` is the ordinary release gate: typecheck, unit/protocol tests,
build, and generated-project smoke. Run `pnpm run test:rls` only when its local
Supabase integration credentials are available; it is intentionally optional
in ordinary CI. `pnpm reference:check` rebuilds the living Supabase project,
syncs the Git corpus, and executes every published pattern against the actual
MCP boundary. Use `npm pack --dry-run` to inspect the public artifact.

For remote work against the living reference project, use
`scripts/supabase-reference` instead of the bare Supabase CLI. The wrapper pins
the public project ref and the repository's non-secret CLI profile. Authenticate
that profile once with `scripts/supabase-reference login --name supa-mcp`; its
token is stored separately from the default Supabase CLI account.

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
- Preserve existing `AGENTS.md` content and locally edited installed skill
  files. Skill updates own only their marked pointer and manifest-hashed files.
- Validate changes under `skills/chumbo/` with the skill-creator validator
  and the isolated install/update fixtures.

Do not publish npm versions or create GitHub releases without explicit user
authorization. The release workflow publishes the package from a published
GitHub release after running the full check suite.
