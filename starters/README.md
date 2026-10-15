# Starters

Full-stack Supabase applications with a Chumbo MCP server already built in.
Builders create one with:

```sh
npx chumbo create            # list starters
npx chumbo create team-tasks my-app
```

| Starter                    | Frontend     | Access mode | Shows                                                        |
| -------------------------- | ------------ | ----------- | ------------------------------------------------------------ |
| [`team-tasks`](team-tasks) | Vite + React | OAuth       | Two users, one shared team; each agent sees its user's slice |

The design and verification contract is in [SPEC.md](SPEC.md).

## Maintaining a starter

- Only `capabilities.ts` and the function `README.md` are hand-written inside
  `supabase/functions/<function>/`. After a Chumbo release changes generated
  files, regenerate them: delete `index.ts`, `deno.json`, and `index_test.ts`
  from a scratch copy containing only `supabase/config.toml`, run
  `chumbo init --yes --skip-checks --function <function> --server-name "<serverName>" --auth <auth>`
  (values from `starter.json`), and copy the three files back.
- `_gitignore` becomes `.gitignore` on create (npm drops `.gitignore` files
  from published packages).
- Keep the root `package.json` `chumbo` devDependency equal to the package
  version.

```sh
pnpm test:starters              # catalog, drift, Deno checks, web build
pnpm test:starters:integration  # local Supabase + RLS isolation + browser OAuth flow
```

The integration check needs Docker, the Supabase CLI, Deno, and Chromium or
Chrome (`CHROMIUM_PATH` overrides discovery). Pass `--screenshots <dir>` to
keep consent and workspace screenshots, or `--keep` to leave the stack running.
