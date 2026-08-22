# Interactive MCP Apps on Supabase

Use this pattern when a capability is easier to inspect or control through a
small interactive surface than through prose alone. Good candidates include a
review queue, chart, document viewer, bounded explorer, or coupled form. A
short answer does not need an app merely to look richer.

## The architecture

```text
model calls open_review_queue
→ tool result includes useful text and structured UI data
→ tool metadata points to ui://supa-mcp/review-queue.html
→ host reads the HTML through resources/read
→ host renders the bundled View in a sandboxed iframe
→ View calls app-only MCP tools through the host
→ the same Edge Function receives the same authorized identity
→ ctx.supabase reads and writes through that user's RLS policies
```

The View does not receive a Supabase access token. It does not call PostgREST
or the Edge Function directly. Privileged actions go through
`app.callServerTool(...)`, and the host uses the MCP connection the user
already authorized.

This keeps ownership clear:

- the host owns iframe isolation and connector credentials;
- Supa MCP owns HTTP, authentication, request context, scopes, and Resources;
- Supabase Postgres and RLS own durable application authorization;
- the builder owns the View, result contract, and business behavior;
- the official MCP Apps SDK owns browser-side host communication.

## Server registration

An app starts with an ordinary Supa MCP tool and Resource linked by a stable
`ui://` URI:

```ts
const appUri = "ui://my-app/review-queue.html";
const appMime = "text/html;profile=mcp-app";

server.withScopes(["review:read"]).registerTool(
  "open_review_queue",
  {
    description: "Open the signed-in user's interactive review queue.",
    inputSchema: z.object({}),
    outputSchema: queueSchema,
    _meta: {
      ui: { resourceUri: appUri, visibility: ["model"] },
      "ui/resourceUri": appUri,
    },
  },
  async () => renderResult(await readQueue(ctx), renderQueueText),
);

server
  .withScopes(["review:read"])
  .registerResource(
    "review-queue-app",
    appUri,
    { mimeType: appMime },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: appMime,
          text: await Deno.readTextFile(
            new URL("./dist/review-queue.html", import.meta.url),
          ),
          _meta: { ui: { csp: {}, prefersBorder: true } },
        },
      ],
    }),
  );
```

The legacy flat metadata key remains beside the preferred nested form while
older hosts still require it.

## App-only tools

UI mechanics should not clutter the model's tool surface:

```ts
server.withScopes(["review:decide"]).registerTool(
  "decide_review_item",
  {
    description: "Approve or reject one pending review item.",
    inputSchema: decisionSchema,
    outputSchema: queueSchema,
    _meta: {
      ui: { resourceUri: appUri, visibility: ["app"] },
      "ui/resourceUri": appUri,
    },
  },
  decideReviewItem,
);
```

`visibility: ["app"]` tells a compatible host not to expose this tool to the
model. It is not an authorization boundary. Keep the scope gate, ownership
predicate, and RLS policy even though the tool is intended only for the View.

## Stable workspace default

An interactive App should behave like a small application surface, not a card
whose iframe grows every time another row or image renders. Supa MCP packages a
thin browser helper for that host-specific work:

```ts
import { createAppWorkspace } from "supa-mcp/app";

const workspace = createAppWorkspace(
  { name: "My review queue", version: "0.1.0" },
  { root: document.querySelector("main")! },
);
const { app } = workspace;

app.ontoolresult = renderResult;
await workspace.connect();
```

Mark the part that should scroll inside the stable frame:

```html
<main>
  <header>...</header>
  <section data-supa-mcp-scroll>...</section>
</main>
```

The default applies host theme and font tokens, mobile safe areas, a bounded
inline height, internal scrolling, and optional fullscreen negotiation. It
does not provide colors, components, typography, or application layout. If no
scroll region is marked, the complete root scrolls rather than clipping.

Use `workspace.canFullscreen()` before showing an expand control and
`workspace.toggleFullscreen()` to negotiate the change with a supporting
host. The host always makes the final presentation decision.

## Bundle and deployment

The living example uses `supa-mcp/app` over the official
`@modelcontextprotocol/ext-apps` browser SDK and produces one HTML file with
Vite and `vite-plugin-singlefile`.
Supabase CLI bundles that file beside the function:

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

The living reference admits its local reference host and `https://claude.ai`
by exact origin. It deliberately does not use `*`: a builder should add only
hosts they have actually chosen to support, and the server should still reject
every unauthenticated or unauthorized MCP request after preflight succeeds.

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

The living reference temporarily publishes its small consent page through
GitHub Pages. That is reference-project scaffolding, not a Supa MCP runtime
dependency or recommended application architecture. When the Supa MCP website
is deployed, the route moves there and the temporary Pages site is removed.

During this experiment, both an Edge Function HTML response and a public
Storage HTML object on the default hosted project domain were observed arriving
as sandboxed `text/plain`. The Edge Function behavior is a documented platform
limit; the Storage result is an observation from this reference project. In
either case, do not make a free-plan OAuth flow depend on the project domain
acting as a general-purpose static website.

The official MCP Apps server helpers currently target the older MCP SDK server
package. The living example registers metadata directly against Supa MCP's v2
server rather than pulling two server SDK generations into one Edge Function.
The browser View still uses the official Apps SDK.

See `review-queue-app-example` for the complete schema, View, Edge Function,
two-user RLS proof, and host interoperability notes.
