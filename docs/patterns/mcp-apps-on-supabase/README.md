# Interactive MCP Apps on Supabase

Use this pattern when a capability is easier to inspect or control through a
small interactive surface than through prose alone. Good candidates include a
review queue, chart, document viewer, bounded explorer, or coupled form. A
short answer does not need an app merely to look richer.

## The architecture

```text
model calls open_review_queue
-> tool result includes useful text and structured UI data
-> tool metadata points to ui://acme/review-queue.html
-> host reads the HTML through resources/read
-> server injects tenant presentation + auto-derived CSP into the View
-> host renders the bundled View in a sandboxed iframe
-> View calls app-only MCP tools through the host with stable request_id
-> the same Edge Function receives the same authorized identity
-> ctx.supabase reads and writes through that user's RLS policies
```

The View does not receive a Supabase access token. It does not call PostgREST
or the Edge Function directly. Privileged actions go through the host's MCP
connection using `callAppTool(...)` (wrapping `app.callServerTool(...)`), so
the Edge Function evaluates the same OAuth scopes and Supabase RLS policies as
any other tool call.

This keeps ownership clear:

- the host owns iframe isolation and connector credentials;
- Chumbo owns HTTP, authentication, request context, scopes, `ui://` Resources,
  tenant presentation injection, and auto-derived CSP;
- Supabase Postgres and RLS own durable application authorization;
- the builder owns the View, result contract, and business behavior;
- the official MCP Apps SDK owns browser-side host communication.

## Server registration with `defineMcpApp` and `registerMcpApp`

Define the app once at module scope with `defineMcpApp` and bind it per
connection with `registerMcpApp`. Chumbo attaches `text/html;profile=mcp-app`,
registers the `ui://` HTML Resource once, and emits both the nested
`_meta.ui.resourceUri` and legacy flat `_meta["ui/resourceUri"]` keys on every
linked tool:

```ts
import {
  buildHubUrl,
  defineMcpApp,
  idempotencyConflictResult,
  registerMcpApp,
  renderResult,
  requestIdFieldSchema,
  resolveAppPresentation,
} from "chumbo";
import { z } from "zod";
import { REVIEW_QUEUE_HTML } from "./generated/apps/review-queue.html.ts";

const reviewQueueApp = defineMcpApp({
  name: "review-queue",
  uri: "ui://acme/review-queue.html",
  title: (p) => `${p.productName} Review Queue`,
  description: "Interactive admin queue for resolving flagged records.",
  scopes: ["review:read"],
  html: REVIEW_QUEUE_HTML,
});

// Inside createSupabaseMcp({ setup(server, ctx) { ... } }):
const presentation = resolveAppPresentation({
  productName: "Acme Workspace",
  hubUrl: "https://acme.example.com",
  brand: {
    logoUrl: "https://cdn.acme.example.com/logo.svg",
  },
});

const queueApp = registerMcpApp(server, reviewQueueApp, { presentation });

queueApp.openTool(
  "open_review_queue",
  {
    description: "Open the workspace interactive review queue.",
    inputSchema: z.object({}),
    outputSchema: queueSchema,
    risk: "read",
  },
  async () => {
    const queue = await readWorkspaceQueue(ctx, presentation.hubUrl);
    return renderResult(queue, renderQueueText);
  },
);

queueApp.appTool(
  "decide_review_flag",
  {
    description: "Resolve or dismiss one open review flag.",
    scopes: ["review:decide"], // Required: mutating appTools never inherit read scopes
    risk: "write",
    inputSchema: z.object({
      flag_id: z.string().uuid(),
      decision: z.enum(["resolved", "dismissed"]),
      decision_note: z.string().max(2000).default(""),
      expected_revision: z.number().int().min(1),
      request_id: requestIdFieldSchema,
    }),
    outputSchema: decisionSchema,
  },
  async (input) => decideReviewFlag(ctx, input),
);
```

`visibility: ["app"]` tells a compatible host not to expose an `appTool` to the
model. It is presentation metadata, never an authorization boundary. On a
scoped app, `registerMcpApp` enforces this at registration time: mutating
`appTool`s (`risk: "write" | "destructive"`) must declare explicit `scopes`,
and the underlying handler should still rely on Postgres RLS and row-level
ownership checks.

## Tenant presentation injection and auto-CSP

When a host reads the `ui://` Resource, `registerMcpApp` injects a script-safe
JSON payload into `<script id="mcp-app-presentation" type="application/json">`
(replacing `__MCP_APP_PRESENTATION__` if present, or inserting before
`</head>`). Special characters such as `<`, `>`, `&`, and line separators are
escaped so tenant metadata cannot break out of the script element.

Chumbo also inspects `presentation.brand.logoUrl` and
`presentation.brand.darkLogoUrl` and automatically merges their validated HTTPS
origins into `_meta.ui.csp.resourceDomains` alongside any static `csp` options.
Keep `connectDomains` empty unless the View genuinely needs direct network
calls – by default, all data flows through host-mediated MCP tools.

Use `buildHubUrl(presentation, "/records/123")` on the server when
building deep links back to the product web app, and read the injected manifest
in the View with `readAppPresentation()` and `applyAppPresentation()`:

```ts
import {
  applyAppPresentation,
  createAppWorkspace,
  readAppPresentation,
} from "chumbo/app";

const presentation = readAppPresentation();
applyAppPresentation(presentation);

const workspace = createAppWorkspace(
  { name: `${presentation.productName} Review Queue`, version: "0.1.0" },
  { root: document.querySelector("main")! },
);
```

## Stable workspace default and idempotent View mutations

An interactive App should behave like a small application surface, not a card
whose iframe grows every time another row renders. Mark the scrollable region
with `data-supa-mcp-scroll`:

```html
<main>
  <header>...</header>
  <section data-supa-mcp-scroll>...</section>
</main>
```

`createAppWorkspace` applies host theme and font tokens, mobile safe areas, a
bounded inline height, internal scrolling, and optional fullscreen negotiation.
Use `workspace.canFullscreen()` before showing an expand control and
`workspace.toggleFullscreen()` to negotiate the change with a supporting host.

For mutations triggered from the View, use `callAppTool` or `createAppMutation`
from `chumbo/app`. When a host-mediated tool call times out or disconnects
after the server may already have committed, the helper enters an `uncertain`
state and preserves the same `request_id` across retries so the server can
deduplicate safely:

```ts
import { createAppMutation } from "chumbo/app";

const decideMutation = createAppMutation(workspace.app, {
  tool: "decide_review_flag",
  timeoutMs: 15_000,
});

const outcome = await decideMutation.run({
  flag_id: flag.id,
  decision: "resolved",
  decision_note: "Updated record summary.",
  expected_revision: flag.revision,
});

if (outcome.status === "uncertain") {
  // Retry with the same request_id rather than generating a new intent.
  await decideMutation.retry();
}
```

On the server, accept `request_id: requestIdFieldSchema`, persist it on the
mutation row (or a dedicated idempotency table), replay the existing result on
an exact match, and return `idempotencyConflictResult(...)` if the same
`request_id` is reused with different parameters. For read-only View calls that
do not need idempotency keys, use `readAppTool`.

## Bundling and local host simulation

Chumbo ships a zero-runtime-bloat workflow for scaffolding, bundling, and
previewing MCP Apps:

```bash
# Scaffold a minimal HTML + TypeScript View and server starter
npx chumbo app add review-queue

# Compile Views into single-file HTML assets and Edge-safe TS modules
npx chumbo app build

# Inspect discovered apps and generated bundles
npx chumbo app list

# Launch the local split-pane MCP App host simulator alongside the function
npx chumbo dev --app review-queue
```

`chumbo app build` uses optional dev-time `vite` + `vite-plugin-singlefile` to
emit both a standalone `.html` bundle and an Edge-safe `.html.ts` module so the
Edge Function can import HTML directly without relying on filesystem reads.
`chumbo dev --app` opens a local host simulator that models a 560 px inline
frame, fullscreen toggle, light/dark host CSS variables, safe areas,
`visibility: ["app"]` calls, and strict CSP checks before you deploy.

## Governed review pattern: Contributor `flag_for_review` -> Admin Review Queue

A common enterprise governance pattern separates who can flag a problem from
who can resolve it:

1. **Contributor tool (`flag_for_review`, scope `review:flag`):** Model-facing
   tool available to read/contributor roles. It accepts `record_id`, `reason`,
   `note`, and `request_id`.
2. **No existence leaks:** Before inserting a flag, the RLS policy requires the
   caller to be a member of the target record's workspace. If a contributor
   passes an ID from another workspace or a nonexistent record, the server
   returns a uniform `not_found:` error without revealing whether the record
   exists.
3. **Idempotency and conflict detection:** `(flagged_by, flag_request_id)` is
   unique. Retrying with the same `request_id` and identical `record_id` +
   `reason` returns the existing flag; reusing `request_id` with different
   arguments returns `idempotency_conflict:`.
4. **Admin Review Queue (`open_review_queue` + `ui://` Resource, scope
   `review:read`, and `decide_review_flag`, scope `review:decide`):**
   Contributors cannot read the `ui://` Resource or call the admin tools.
   Workspace admins inspect open flags in the View (with deep links built via
   `buildHubUrl`) and resolve or dismiss them with optimistic concurrency
   (`expected_revision`) and `decision_request_id` idempotency.

See [20261124000000_create_governed_review_flags.sql](../../../supabase/migrations/20261124000000_create_governed_review_flags.sql)
for the complete schema-unopinionated reference migration, RLS policies, and
explicit post-2026-10-30 Data API `GRANT`s, and
[test/governed-review-pattern.test.ts](../../../test/governed-review-pattern.test.ts)
for the end-to-end two-persona test suite.

## Deployment and CORS

When serving static HTML files from a Supabase Edge Function instead of an
imported `.html.ts` module, bundle the file beside the function in
`supabase/config.toml`:

```toml
[functions.review-queue-app]
verify_jwt = false
static_files = [ "./functions/review-queue-app/dist/review-queue.html" ]
```

The HTML travels as text inside an MCP JSON response. It is not a direct
`text/html` page response, so the default Supabase Edge Function URL remains a
valid transport. External scripts, images, APIs, fonts, frames, cameras, or
microphones require explicit MCP Apps CSP or permission metadata. Prefer a
self-contained bundle and host-mediated tools until the application has a real
reason to request more.

A browser-based MCP host also needs an explicit CORS policy at the Edge
Function boundary. Allow only the host origins the application actually uses,
answer their `OPTIONS` preflight before bearer authentication, and include MCP
transport headers such as `mcp-protocol-version` and `mcp-session-id`. CORS is
transport compatibility, not authorization; OAuth, scopes, ownership checks,
and RLS remain unchanged.

## OAuth consent hosting across Supabase plans

The MCP App bundle and the OAuth consent page are different surfaces. The App
bundle travels through `resources/read`, so it works from the ordinary hosted
Edge Function URL on every plan. OAuth consent is a browser page owned by the
builder's application and needs an actual HTML host.

Use the smallest host the application already has:

- put consent in the existing signed-in web app when one exists;
- use an ordinary static host for a free-plan project without a frontend;
- serve it from an Edge Function only when the project has a Supabase custom
  domain, because hosted project URLs rewrite `text/html` to `text/plain`.

Do not make a free-plan OAuth flow depend on the default hosted project domain
acting as a general-purpose static website.

See `review-queue-app-example` for the standalone example Edge Function, View,
two-user RLS proof, and host interoperability notes.
