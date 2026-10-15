# Team Tasks

A small team task app on Supabase with an MCP server already built in. People
use the web app; their agents connect to the same data through MCP, signed in
as them, and Row Level Security decides what each one can see and change.

```text
web/ (Vite + React)        ──┐
                             ├── Supabase Auth + Postgres + RLS
supabase/functions/mcp/  ────┘   (one set of policies for both)
```

Created with [Chumbo](https://chumbo.dev): `npx chumbo create team-tasks`.

## Run it locally (5 minutes)

Requirements: Node 22+, Docker, the [Supabase CLI](https://supabase.com/docs/guides/local-development),
and [Deno](https://deno.com) for the function checks.

```sh
npm run setup      # install the web app
supabase start     # Postgres, Auth, and the OAuth 2.1 server, with demo data
npm run dev        # web app + MCP function
```

Open <http://127.0.0.1:5173> and sign in:

| User                | Password      | Teams                       |
| ------------------- | ------------- | --------------------------- |
| `alice@example.com` | `password123` | Alice's Studio, Launch Crew |
| `bob@example.com`   | `password123` | Bob's Garage, Launch Crew   |

## Connect an agent

The **Connect an agent** panel shows the MCP URL and copyable commands. For
example, with Claude Code:

```sh
claude mcp add --transport http team-tasks http://127.0.0.1:54321/functions/v1/mcp
```

The client discovers the OAuth server, registers itself, and opens the web
app's `/oauth/consent` page. Sign in as Alice and approve. Ask the agent to
"list my tasks" and it sees Alice's two teams. Connect a second client as Bob
and it sees Bob's. Tasks the agent creates in **Launch Crew** appear for both
people in the web app.

## What's inside

| Path                                     | What it is                                                          |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `supabase/migrations/`                   | Schema and RLS policies. The authorization boundary for app and MCP |
| `supabase/seed.sql`                      | Alice, Bob, their teams and tasks (local only)                      |
| `supabase/functions/mcp/capabilities.ts` | The four MCP tools. The file you edit                               |
| `supabase/functions/mcp/index.ts`        | Generated MCP wiring (OAuth, transport). Leave as generated         |
| `supabase/tests/isolation_test.ts`       | Proves each user's agent sees only their own data                   |
| `web/src/Consent.tsx`                    | OAuth consent page for MCP clients                                  |
| `web/src/ConnectPanel.tsx`               | MCP URL and client setup snippets                                   |

MCP tools: `list_teams`, `list_tasks` (paginated), `create_task`, `update_task`.

## Check and test

```sh
npm run check            # Deno type-check of the function + web typecheck
npm test                 # OAuth contract test + RLS isolation (needs `supabase start`)
npm run types            # regenerate database types after changing migrations
```

## Make it yours

- **Add a tool:** register it in `supabase/functions/mcp/capabilities.ts` and
  query through `ctx.supabase`. Add a case to `supabase/tests/isolation_test.ts`.
- **Add a table:** write a migration with RLS enabled and policies, run
  `supabase db reset` and `npm run types`.
- **Agent-assisted:** `npx chumbo skill install` adds Chumbo's version-matched
  guidance for your coding agent. See `AGENTS.md`.

## Deploy

1. Create a Supabase project, then `supabase link --project-ref <ref>` and
   `supabase db push`. (Do not run `seed.sql` in production.)
2. In the dashboard, enable **Authentication → OAuth Server**, allow dynamic
   client registration, and set the authorization path to `/oauth/consent`.
   Set **Authentication → URL Configuration → Site URL** to your web app's URL.
3. `npm run deploy:mcp` deploys the function
   (`supabase functions deploy mcp --no-verify-jwt`; the function verifies
   tokens itself).
4. Build the web app with `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_PUBLISHABLE_KEY` set to the project's values, then deploy
   `web/dist` to any static host with a single-page-app fallback
   (`web/public/_redirects` covers Netlify and Cloudflare Pages).
5. Verify: `npx chumbo doctor --url https://<ref>.supabase.co/functions/v1/mcp`.
