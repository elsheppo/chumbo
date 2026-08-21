# Authenticated interactive review queue

The living reference function at
`supabase/functions/review-queue-app/index.ts` uses public `supa-mcp@0.6.1`.

- `open_review_queue` is model-visible and points to a bundled `ui://`
  Resource.
- `refresh_review_queue` and `decide_review_item` are visible only to the
  interactive View.
- The opener returns concise text for ordinary MCP clients and exact structured
  data for the View.
- The View calls server tools through the host. It never receives a Supabase
  credential or calls the database directly.
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
  example registers their small metadata contract directly on Supa MCP's v2
  server;
- browser-native hosts perform CORS preflights before authentication, so the
  Edge Function must explicitly admit its known host origins and MCP headers.

A third hosted-client prerequisite is intentionally outside this fixture:
Supabase Auth's OAuth 2.1 server must be enabled and the application must own a
real sign-in and consent surface. The reference host proof used a temporary
user token so it could test the MCP App protocol independently. Claude and
Codex both correctly refused OAuth discovery while the project's authorization
server was disabled. Supa MCP can publish the protected-resource metadata and
preserve the resulting identity, but it should not manufacture an
application's login or consent experience.

Neither seam changes the application model. The first is version glue. The
second should eventually become a small opt-in Supa MCP HTTP configuration,
not a permissive default applied to every server.

The `review_items` table is demonstration data, not a required Supa MCP schema.
Replace the fixture with the application object that actually benefits from an
interactive review surface.
