# Authenticated interactive review queue

The living reference function at
`supabase/functions/review-queue-app/index.ts` uses public `chumbo@0.8.0`.

- `open_review_queue` is model-visible and points to a bundled `ui://`
  Resource.
- `refresh_review_queue` and `decide_review_item` are visible only to the
  interactive View.
- The opener returns concise text for ordinary MCP clients and exact structured
  data for the View.
- The View calls server tools through the host. It never receives a Supabase
  credential or calls the database directly.
- `createAppWorkspace` gives the View one host-aware inline viewport with an
  internal queue scroller and an optional fullscreen control, so adding items
  does not continually resize the surrounding conversation.
- Every read and mutation uses the request-scoped Supabase client, while RLS
  limits rows to `auth.uid()`.
- A two-user integration fixture proves one user cannot see or decide the
  other's item.
- The official MCP Apps reference host renders the View, hides the app-only
  tools from its model-facing picker, forwards an interactive decision, and
  receives a model-context update from the View.
- The same host connects to the deployed Edge Function after the fixture
  answers its narrow browser-origin preflight. The rendered View reads a
  hosted user-owned row, persists an approval, updates to an empty state, and
  reports the decision back as model context.

## What this proved

The MCP App itself needs no second web deployment, browser-held Supabase
credential, or custom data API. One Edge Function can serve the MCP protocol,
the bundled HTML Resource, and the app-only mutation tools. The host keeps the
authorized MCP connection; every interactive call rebuilds the ordinary
request-scoped Supabase client and therefore retains the caller's RLS boundary.

The real friction was concentrated at two seams:

- the Apps server helpers still target an older MCP SDK generation, so the
  example registers their small metadata contract directly on Chumbo's v2
  server;
- browser-native hosts perform CORS preflights before authentication, so the
  Edge Function must explicitly admit its known host origins and MCP headers.

A third hosted-client prerequisite was proven separately from the Apps
protocol fixture: Supabase Auth's OAuth 2.1 server must be enabled and the
application must own a real sign-in and consent surface. Chumbo publishes the
protected-resource metadata and preserves the resulting identity; it does not
manufacture the application's login experience.

Neither seam changes the application model. The first is version glue. The
second should eventually become a small opt-in Chumbo HTTP configuration,
not a permissive default applied to every server.

The `review_items` table is demonstration data, not a required Chumbo schema.
Replace the fixture with the application object that actually benefits from an
interactive review surface.

## Claude host proof

The public reference was connected under the legacy Claude custom connector
name `Supa MCP review queue`. This is a real OAuth and MCP Apps proof, not a bearer
token substituted into the host:

1. Claude registered itself through Supabase dynamic client registration.
2. Supabase redirected to the application-owned consent page, which displayed
   Claude and the requested scopes.
3. The reference identity approved the request and Claude received its OAuth
   connection.
4. Claude classified `open_review_queue` as one interactive tool and kept
   `refresh_review_queue` plus `decide_review_item` in a separate app-only
   group.
5. A model request opened the bundled View inside Claude with the seeded,
   user-owned row.
6. Clicking `Approve` in the View invoked the app-only tool, persisted the
   decision, and updated the View to `0 pending items` without a page reload.
7. A direct database check confirmed the approved row, and a fresh pending row
   was left for future demonstrations.

The living host identity is `claude-host@supa-mcp.test`. It has no password and
was signed in once through an admin-generated passwordless link. The connector,
its dynamically registered OAuth client, the demo identity, one approved proof
row, and one pending demo row intentionally remain live. They can be managed or
removed from Claude connector settings, Supabase OAuth Apps, Authentication
users, and `review_items`, respectively.

The exact `https://claude.ai` browser origin is admitted by the reference
function. Before it was added, Claude's preflight received the normal 401
challenge and connector creation did not advance. After deployment, the same
preflight received a 204 with the expected MCP headers and connector creation
completed. This is why CORS belongs in host compatibility configuration rather
than in authentication or capability policy.
