# Start or resume

Setup adds an MCP Edge Function to a repository that already contains a
Supabase project. It owns the generated protocol entrypoint and support files;
the builder owns `capabilities.ts`.

Requirements: Node 22+, the Supabase CLI, and preferably Deno for generated
type-checks and tests.

## Identify what is already present

| You find                                                                                          | Next action                                                           |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `supabase/config.toml`, but no generated MCP function                                             | Preview and run setup                                                 |
| `supabase/functions/<name>/` with `index.ts`, `capabilities.ts`, `deno.json`, and `index_test.ts` | Run `npx chumbo status --json` before editing                         |
| Application-authored capabilities                                                                 | Preserve them; resume setup around them                               |
| Missing generated files or configuration drift                                                    | Run status, then use resumable setup rather than regenerating by hand |

Inspect the existing auth mode, package import, function name, tests, RLS,
grants, RPCs, and application APIs before deciding what to change.

## Preview or run setup

Use the guided flow when a person is present:

```sh
npx chumbo setup
```

For an agent or CI, preview the complete plan before applying it:

```sh
npx chumbo setup --plan --json
npx chumbo setup --auth oauth --yes --json
```

Select auth from the caller relationship, not from whichever mode is quickest
to configure. Read [access and RLS](access-and-rls.md) when the choice is not
already established.

## Install project-local guidance

For agent-assisted development:

```sh
npx chumbo skill install
```

This stores version-matched guidance in the repository for later agent
sessions. It is optional for manual development and the recommended path when
agents will build, debug, or upgrade the server.

## Resume safely

```sh
npx chumbo setup --resume --json
```

Setup may repair generated support files and configuration.
`capabilities.ts` is builder-owned: do not delete or replace it to recover the
starter. An auth-mode change also requires reconciling its secrets, migrations,
OAuth configuration, client URL, and deployed verification.

## First useful outcome

The generated `whoami` tool is a diagnostic starter. Generated tests prove the
scaffold contract appropriate to the selected access mode; only the API-key
starter test discovers and invokes `whoami`. Replace it with one application
operation, update `index_test.ts` for that operation, then prove discovery and
invocation with an appropriate identity.
