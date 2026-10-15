# Agent instructions: Team Tasks

This is a Supabase application with a web app (`web/`) and an MCP server
(`supabase/functions/mcp/`) that share one database and one set of RLS
policies.

## Ground rules

- RLS is the authorization boundary. Never use a service-role or secret key in
  `capabilities.ts` or `web/`. Query through `ctx.supabase` (MCP) or the
  `supabase` client in `web/src/supabase.ts`.
- Edit `supabase/functions/mcp/capabilities.ts`, not the generated
  `index.ts`, `deno.json`, or `index_test.ts`. Run
  `npx chumbo setup --resume --function mcp` to re-check generated wiring.
- Every new table gets `enable row level security` and explicit policies in a
  new migration under `supabase/migrations/`. Never edit an applied migration.
- After schema changes: `supabase db reset && npm run types`.

## Common requests

| Request                       | Change                                                                              | Prove it                                         |
| ----------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------ |
| Add an MCP tool               | `registerTool` in `capabilities.ts`; compact result; `errorResult` with a next step | `npm run check`, `npm test`                      |
| Let agents see a new table    | Migration with RLS + policies, `npm run types`, then a tool in `capabilities.ts`    | Add a case to `supabase/tests/isolation_test.ts` |
| Show something in the web app | `web/src/Workspace.tsx`                                                             | `npm run check`                                  |
| Change who can do what        | Policies in a new migration                                                         | `npm test`                                       |

## Commands

```sh
supabase start        # local stack with demo users alice@ / bob@example.com (password123)
npm run dev           # web app on :5173 and the MCP function
npm run check         # types for function and web
npm test              # contract test + RLS isolation through MCP
```

For deeper Chumbo guidance (result contracts, pagination, auth modes,
deployment), install the version-matched skill: `npx chumbo skill install`.
