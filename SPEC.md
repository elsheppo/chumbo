# Chumbo: Product and Implementation Specification

Status: Guided setup and living reference implemented\
Date: 2026-08-20\
Current package version: `0.10.3`\
License: MIT\
Primary runtime: Supabase Edge Functions (Deno/TypeScript)\
Protocol target: MCP `2026-07-28`, with stateless legacy compatibility where the
official SDK provides it

## 1. Executive decision

`chumbo` will be a small TypeScript package and initializer that
adds an end-user-facing MCP server to an existing Supabase application.

The product promise is:

> A Supabase builder runs one command, deploys one Edge Function, and an end
> user connects an MCP client through the builder's existing Supabase Auth. MCP
> handlers receive a request-scoped Supabase client, so the application's
> existing Row Level Security policies govern every database operation.

The package will compose, not replace:

- `@modelcontextprotocol/server` for MCP protocol behavior;
- `@supabase/server` and Supabase Auth for request identity and Supabase
  clients;
- Supabase OAuth 2.1 Server as the authorization server;
- Supabase Edge Functions as the protected MCP resource server runtime.

Chumbo owns the reusable boundary between an existing Supabase application and
its end-user-facing MCP: protocol wiring, request-scoped identity, guided
setup, diagnostics, result contracts, and optional advanced patterns.

The stable expansion model is one library, not product-tier architecture:

> Chumbo makes one Supabase-native MCP easy and supports increasingly
> advanced patterns – including many MCPs from one function – through the same
> library.

Advanced patterns live in the open-source reference project first. They become
reusable package API only when doing so reduces adopter work without adding
conceptual weight to the ordinary one-server path.

## 2. Problem

Supabase documents how to run a simple MCP server in an Edge Function, but the
current example stops at a public arithmetic tool. A builder who wants to give
their product's end users an MCP endpoint must still solve:

1. modern Streamable HTTP MCP wiring;
2. OAuth protected-resource metadata and `WWW-Authenticate` challenges;
3. delegation to Supabase Auth as the OAuth 2.1 authorization server;
4. request-scoped Supabase JWT validation and client construction;
5. preserving RLS rather than accidentally using a privileged client;
6. Edge Function routing and `config.toml` configuration;
7. local testing, deployment, client connection, and common diagnostics;
8. protocol-version drift as MCP evolves.

Existing GitHub projects demonstrate the pattern, but no widely adopted package
currently owns this complete application-facing happy path. Several existing
projects are examples, old-protocol handlers, broad proposed SDKs, or Supabase
administration servers rather than a maintained adapter for an existing app.

## 3. Target user and job

### Primary user

A developer already building a product on Supabase who wants their users to
connect ChatGPT, Claude, Codex, Cursor, or another remote MCP client to selected
application capabilities.

### Primary job

"Expose my application's existing actions and data through MCP without creating
a second identity system, a second authorization model, or another hosted
service."

### End user

An existing application user who connects an MCP client, signs in through the
application's Supabase Auth flow, grants access, and receives only the data and
actions allowed by the application's existing permissions.

## 4. Positioning

Chumbo is the MCP layer for Supabase apps. It helps application builders expose
their own product capabilities to users and agents through one Supabase-native
MCP endpoint.

Recommended public language:

> Add an end-user MCP server to your Supabase app, with OAuth and RLS already
> wired.

Lead with what builders can create and deploy. Explain neighboring categories
only when a concrete comparison helps the reader make a decision.

## 5. Goals

Version `0.1.0` must:

1. initialize safely inside an existing Supabase repository;
2. generate a deployable Edge Function using the official MCP TypeScript SDK;
3. support the modern MCP `2026-07-28` stateless request model;
4. expose OAuth protected-resource metadata from the MCP endpoint;
5. direct MCP clients to the project's Supabase OAuth authorization server;
6. validate bearer tokens and create request-scoped, RLS-aware Supabase clients;
7. make tools, resources, and prompts straightforward to register;
8. demonstrate one Multi Round-Trip Request (MRTR) input flow;
9. provide deterministic local and cloud verification;
10. prove tenant separation with two users from different organizations;
11. provide a `doctor` command that catches the common configuration failures;
12. publish a pinned, reproducible package and tagged public GitHub release.
13. support a clean public MCP URL without coupling it to the Supabase OAuth
    issuer, and verify the complete proxied discovery route.

## 6. Non-goals

Version `0.1.0` will not:

- implement the MCP wire protocol itself;
- replace or wrap the complete official MCP SDK API;
- create generic MCP tools from every database table;
- expose Supabase service-role access to user handlers by default;
- provide a resident Durable Object, actor affinity, mailbox, alarms, or
  transport sessions; the optional durable-state primitive is bounded
  request-to-request coordination rather than an actor runtime;
- ship graph, vector, WASM, AI inference, or agent orchestration frameworks;
- implement a general OAuth authorization server;
- generate a branded consent UI for every frontend framework;
- require tasks, queues, prompts, resources, or elicitation merely because MCP
  supports them;
- support deprecated Roots, Sampling, or Logging capabilities in new examples;
- guarantee compatibility with every MCP host before it has been tested.

An optional Postgres-backed MCP Tasks adapter is a follow-on. It must not delay
the authenticated tool/resource golden path.

## 7. Definition of done

The release is done only when the following end-to-end scenario passes against a
deployed Supabase project:

1. Alice belongs to organization A.
2. Bob belongs to organization B.
3. Both organizations contain private fixture rows protected by RLS.
4. A real remote MCP client is pointed at the deployed MCP URL.
5. Alice receives an OAuth challenge and is redirected to the application's
   Supabase authorization flow.
6. Alice signs in, approves access, and the client obtains access and refresh
   tokens.
7. A tool call executed as Alice returns only organization A rows.
8. A resource read executed as Alice returns only organization A content.
9. Bob completes the same flow and receives only organization B rows.
10. Concurrent Alice and Bob calls do not share identities, clients, cached
    tenant state, or results.
11. Token refresh works without manually replacing a credential.
12. Revocation or an invalid token produces a standards-shaped OAuth challenge,
    not an opaque server error.
13. The same generated project passes local tests, deploys with the documented
    Supabase CLI command, and connects through the official MCP client SDK.

Passing a public `sum` tool or a curl call with a manually copied service key is
not sufficient evidence.

## 8. User experience

### 8.1 Guided setup

Primary command:

```sh
npx chumbo setup
```

Non-interactive equivalent:

```sh
npx chumbo setup \
  --function mcp \
  --auth oauth \
  --server-name my-app \
  --yes \
  --json
```

`init` remains the deterministic file-generation primitive. `setup` composes
it with local checks, optional migration/deployment execution, remote
verification, and an ordered next-action report. `status` provides the same
observation model without mutation.

The setup flow must:

1. locate `supabase/config.toml`;
2. refuse to invent a new Supabase project unless `--create-project` is
   explicitly supplied in a later release;
3. inspect existing target files and never overwrite them silently;
4. print a proposed file plan before mutation;
5. support `--dry-run`;
6. generate or patch only the files listed in the plan;
7. print exact local-run, test, deploy, OAuth-setup, and connection commands;
8. expose a versioned JSON envelope with stable step IDs;
9. never prompt in JSON mode;
10. resume by re-observing project and endpoint state rather than trusting a
    hidden mutable state file.

Interactive prompts:

- authentication mode in plain builder language: `oauth`, `api-key`, `bearer`,
  or `public`;
- confirmation of the complete file plan.

Function name, display name, consent fallback, config patching, migration
application, project ref, and deployment remain explicit flags. This keeps the
human path short and the agent path deterministic.

`oauth` is the recommended end-user choice. `api-key` is the shortest
authenticated application path. `bearer` is useful for automated tests and
developer clients that can inject an existing Supabase JWT. `public` must
require explicit confirmation and should be presented as a demo/webhook mode,
not the normal end-user configuration.

### 8.2 Author capabilities

The intended hand-authored file should remain small:

```ts
import {
  createSupabaseMcp,
  structuredResult,
  type SupabaseMcpContext,
  type SupabaseMcpServer,
} from "chumbo";
import { z } from "zod";

const app = createSupabaseMcp({
  server: { name: "acme", version: "1.0.0" },
  resourceUrl: new URL(`${Deno.env.get("SUPABASE_URL")}/functions/v1/mcp`),
  auth: { mode: "oauth" },
  register(server: SupabaseMcpServer, ctx: SupabaseMcpContext) {
    server.registerTool(
      "list_projects",
      {
        description: "List projects visible to the connected user.",
        inputSchema: z.object({}),
        outputSchema: z.object({
          projects: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              status: z.string(),
            }),
          ),
        }),
      },
      async () => {
        const { data, error } = await ctx.supabase
          .from("projects")
          .select("id, name, status")
          .order("name");

        if (error) throw error;
        return structuredResult({ projects: data ?? [] });
      },
    );
  },
});

if (import.meta.main) Deno.serve(app.fetch);

export default app;
```

The implementation deliberately passes through the official `McpServer`
registration API. Handlers receive request-scoped context, while application
authors do not implement JSON-RPC, OAuth challenges, protocol headers, or
Supabase client construction.

### 8.3 Run locally

```sh
npx chumbo dev
```

The command may delegate to the installed Supabase CLI rather than wrapping its
entire behavior. It should print the resolved MCP URL and client/Inspector
commands.

The generated repository must also remain usable with ordinary commands:

```sh
supabase start
supabase functions serve mcp
deno test supabase/functions/mcp
```

### 8.4 Diagnose

```sh
npx chumbo doctor
```

`doctor` should check, without exposing secrets:

- Supabase repository and CLI availability;
- generated function and import configuration;
- pinned dependency resolution;
- function configuration and auth mode;
- project URL and expected MCP URL;
- OAuth authorization-server discovery metadata;
- MCP protected-resource metadata URL;
- `WWW-Authenticate` challenge shape;
- whether the endpoint advertises the expected protocol version;
- optional live `tools/list` call when credentials are supplied;
- whether a remote response was produced by Chumbo or by an upstream gateway;
- deployed runtime version, auth mode, API-key strategy, and advertised resource
  URL through non-secret response metadata;
- common RLS symptom: authenticated call succeeds but returns no rows;
- accidental service-role configuration in a user-facing template.

Diagnostics distinguish required runtime conditions from recommended generated
project hygiene. A missing entrypoint, unpinned runtime, or incorrect gateway
configuration blocks readiness. Alternate capability-file or test-task layouts
are advisory when the function can otherwise run. Remote verification is
graded as reachable, runtime-confirmed, access-protected, credential-accepted,
and MCP-discovered; omitting an optional test credential must not become a
failure or a false claim of authenticated completion.

Each blocking failure must name an immediate recovery command or documentation
section.

### 8.5 Install the project agent skill

```sh
npx chumbo skill install
npx chumbo skill status
npx chumbo skill update
```

The optional skill is versioned inside the npm artifact and installed at
`skills/supa-mcp/`. The legacy installation path remains stable so existing
managed skill installations can update without splitting ownership or losing
their manifest history; the skill itself teaches Chumbo's current API and
commands. It translates application operations into coherent MCP capabilities,
chooses explicit result contracts, preserves request-scoped authority, and
verifies the protocol boundary. It is not a copy of Supabase documentation or
an automatic schema-to-tools generator.

The installer appends one marked pointer to the root `AGENTS.md` while
preserving all existing content. A managed manifest records the installed
package version and exact file hashes. Updates replace or remove a managed file
only when its current hash still matches the manifest; otherwise they report a
conflict without writing. `--plan`, `--yes`, and `--json` follow setup's
non-interactive conventions. Setup may advertise this command but never runs it
implicitly.

## 9. Generated project shape

Proposed default output:

```text
supabase/
├── config.toml
└── functions/
    └── mcp/
        ├── index.ts
        ├── capabilities.ts
        ├── deno.json
        ├── index_test.ts
        └── README.md
```

Responsibilities:

- `index.ts`: constructs and exports the MCP Edge handler.
- `capabilities.ts`: application-authored tools, resources, and prompts.
- `deno.json`: exact pinned imports and test tasks.
- `index_test.ts`: generated transport, context, and example capability tests.
- function `README.md`: project-local usage, URLs, and auth setup.

Do not generate a large framework directory. Shared runtime logic belongs in the
published package. Generated code should remain readable and removable.

## 10. Package shape

Keep one repository and one npm package unless implementation evidence forces a
split.

```text
chumbo/
├── src/
│   ├── runtime.ts
│   ├── types.ts
│   ├── results.ts
│   ├── testing.ts
│   ├── project.ts
│   ├── doctor.ts
│   └── cli.ts
├── templates/
│   ├── function/
│   └── consent/
├── examples/
│   └── multi-tenant/
├── test/
├── package.json
├── README.md
├── SPEC.md
└── LICENSE
```

Expected exports:

```json
{
  ".": "./dist/index.js",
  "./testing": "./dist/testing.js"
}
```

The canonical executable is `chumbo` and exposes `setup`, `doctor`, `dev`, and
`skill` subcommands. The package also retains `supa-mcp` as a transition alias.

## 11. Runtime architecture

```text
MCP client
   |
   | 1. unauthenticated MCP request
   v
Supabase Edge Function / MCP protected resource
   |
   | 2. 401 + WWW-Authenticate(resource_metadata=...)
   v
Protected-resource metadata
   |
   | 3. authorization_servers -> Supabase Auth issuer
   v
Supabase OAuth 2.1 Server
   |
   | 4. application login + consent + PKCE
   | 5. Supabase user access/refresh tokens
   v
MCP client
   |
   | 6. authenticated MCP request
   v
Edge Function request context
   |
   | 7. request-scoped Supabase client carrying user JWT
   v
PostgREST / Postgres RLS / Storage
```

### Ownership boundaries

The official MCP SDK owns:

- protocol versions and era negotiation;
- `server/discover`, required MCP headers, JSON-RPC, and result encoding;
- tool, resource, prompt, MRTR, and cache-hint wire behavior;
- stateless legacy compatibility supplied by `createMcpHandler`;
- OAuth helper types and protected-resource metadata response utilities.

Supabase owns:

- Edge routing and isolate execution;
- OAuth 2.1 authorization-server endpoints;
- user authentication, PKCE token issuance, refresh, and revocation;
- JWT signing and discovery;
- request-scoped Supabase Data API behavior and RLS enforcement.

`chumbo` owns:

- composing the web-standard MCP handler with Supabase request identity;
- protected-resource metadata and OAuth challenge configuration for the Edge
  Function URL;
- safe construction of request-scoped application context;
- ergonomic registration wrappers only where they remove Supabase-specific
  boilerplate;
- scaffolding, tests, diagnostics, and deployment/client instructions.

Application code owns:

- tool/resource/prompt definitions;
- product permissions beyond existing RLS;
- organization semantics;
- consent-screen branding and copy;
- any privileged server-side operation explicitly chosen by the builder.

## 12. Request context

Every MCP invocation must receive a new immutable context object. No current
user, organization, token, Supabase client, or authorization decision may be
stored in a mutable module global.

Proposed context:

```ts
export interface SupabaseMcpContext<Database = unknown> {
  request: Request;
  supabase: SupabaseClient<Database>;
  user: {
    id: string;
    email?: string;
  };
  jwtClaims: Record<string, unknown>;
  clientId?: string;
  scopes: readonly string[];
  hasScope(scope: string): boolean;
  hasScopes(scopes: readonly string[]): boolean;
  traceId?: string;
  state?: SupabaseMcpState;
  json(value: unknown): CallToolResult;
}
```

Organization identity is intentionally not a universal built-in field. Apps
model organizations differently. The package may accept a resolver:

```ts
context: {
  async extend(base) {
    return {
      organizationIds: await membershipsFor(base.supabase, base.user.id),
    };
  },
}
```

The resolver runs per request. It must not convert a user-supplied organization
ID into authority without a database-backed membership check.

## 13. Authentication modes

### 13.1 `oauth` (recommended production mode)

- MCP endpoint acts as an OAuth protected resource.
- Supabase Auth acts as the authorization server.
- Missing or invalid access tokens return the correct Bearer challenge.
- Protected-resource metadata advertises the Supabase authorization issuer and
  supported scopes.
- Valid tokens become request-scoped Supabase clients.
- Access and refresh tokens remain managed by the MCP client and Supabase Auth.

The adapter must use the official SDK's web-standard OAuth metadata helpers
where possible. It must not copy protocol response shapes by hand when the SDK
already supplies them.

### 13.2 `bearer`

- Accepts an existing Supabase user access token.
- Intended for automated tests and developer clients with custom headers.
- Preserves RLS exactly like OAuth access tokens.
- Does not pretend to provide interactive MCP authorization discovery.

### 13.3 `api-key`

- Accepts `Authorization: Bearer <application-key>` without advertising OAuth.
- The generated default loads one static key from the `MCP_API_KEY` Edge
  Function secret.
- The request context exposes a stable application principal as `ctx.subject`,
  while `ctx.user` and `ctx.jwtClaims` remain null.
- The default Supabase client remains anonymous. The library must not fabricate
  a Supabase user or imply user-RLS semantics for an application key.
- An advanced verifier may use a service-role client to resolve an existing
  application-owned key table and return subject, client ID, and scopes. The
  privileged client is confined to verification and never exposed to tools.
- The package prescribes neither a key-table schema nor organization roles.

### 13.4 `public`

- No user identity.
- Only appropriate for genuinely public capabilities.
- Generated configuration and documentation must make the absence of RLS user
  context explicit.
- The initializer requires explicit selection; it is never the production
  default.
- New public scaffolds install a private fixed-window Postgres limiter and
  enable it in generated configuration. Existing authenticated scaffolds do
  not receive a migration or additional setup.

### 13.5 Progressive capability scopes

Scopes are an optional capability boundary above authentication and below RLS.
Unscoped registration remains unchanged. Advanced builders can register a
tool, resource, prompt, or resource template through
`server.withScopes([...])`; capabilities missing any required scope are not
advertised or callable for that request.

Token scopes are the initial value. An optional per-request resolver can
replace them with application-owned grants loaded through the existing
RLS-aware client. The package does not prescribe scope names, roles,
organizations, or a grant-table schema. Supabase OAuth's standard identity
scopes must not be presented as arbitrary application permissions.

### 13.6 Privileged access

The default handler context does not expose `supabaseAdmin`. A builder who needs
an internal operation must opt into a separately named privileged capability and
supply an authorization predicate. This prevents an attractive nuisance in an
end-user-facing starter.

### 13.7 Credential-partitioned durable state

Authenticated servers may explicitly configure a bounded namespace allowlist
and deployment-secret HMAC key. The runtime derives an opaque partition from
authentication mode, exact strategy, and the exact presented credential.
Capability code receives only `get`, revision-checked `put`, and
revision-checked `delete`; it never receives the partition, credential, HMAC
key, or service-role client.

The opt-in SQL stores JSON values in a private RLS-enabled table and exposes
three `security invoker` RPCs granted only to `service_role`. Runtime and SQL
both bound namespaces, keys, encoded values, revisions, and TTL. Raw JSON text
is measured before database parsing, read text is measured before runtime
parsing, expiry is deterministic missing state, and writes are atomic CAS.
Each write opportunistically reclaims at most 16 expired rows using the expiry
index and `FOR UPDATE SKIP LOCKED`; cleanup failure rolls back with the write.

Credential rotation deliberately creates a new partition. That false negative
is safer than correlating or accidentally sharing state across credentials.
Applications remain responsible for domain concurrency and authorization;
durable state does not weaken RLS, Files-style version CAS, or another
data-plane precondition.

State revision and resource version are separate concurrency domains. State CAS
protects only the receipt row. A guarded mutation must first validate the
receipt, then atomically compare the observed resource version while changing
the application row, and only after success advance or invalidate the receipt.
If those stores are separate and receipt advancement fails after the domain
write, require a reread; never advance a receipt before the domain write.

Per-record bounds do not create a global storage quota. Capabilities must derive
keys from real, authorized, immutable resource identities and maintain a
bounded live keyspace rather than mapping arbitrary caller input directly into
object keys. The living observation-before-action pattern is the executable
reference for these requirements.

### 13.8 Explicit application-run correlation

Run identity is an optional application-owned boundary above invocation traces
and separate from authentication, MCP transport sessions, and Durable actor
identity. Chumbo never infers a run from a credential, connection, IP address,
`traceparent`, or timing proximity. A caller that supplies no handle retains
invocation-only behavior.

`createRunCorrelation` mints and verifies a canonical HMAC-SHA256 handle scoped
to one installation, MCP surface, and builder-authorized principal, account, or
tenant partition. Configuration contains one current deployment secret and may
contain one previous key with an explicit ISO 8601 verification-overlap end.
The codec bounds key material, identifiers, token size, default and maximum
TTL, clock skew, and canonical encoding. The verified fact exposes only an
opaque digest plus start and expiry times; credentials, application object IDs,
tool inputs, prompts, outputs, and signing material are absent.

Controlled clients carry the handle in `_meta["dev.chumbo/run"]`. Generic MCP
clients may pass the same handle through `run_id` only when a builder chooses to
add that field to a particular tool. A builder-authored domain begin tool may
call `mint`; Chumbo does not add a universal workflow API or change every tool
schema. Matching dual carriers are accepted. Conflicting, malformed, expired,
cross-scope, or unknown-key handles fail before capability code executes.

The runtime and builder capability code share one request-cached verification
result through the official MCP `ServerContext`. Configured lifecycle sinks
receive schema v2 with the bounded run fact or `run: null`. Unconfigured
servers retain schema v1 byte for byte.

The signed handle supplies stateless correlation, not persistence,
authorization, worker execution, early close, revocation, or per-account run
quotas. Applications add Supabase or Durable storage only when those behaviors
are real product requirements.

### 13.9 Effective MCP surface proofs

Applications may opt into `onSurface` to capture what a real caller can
actually discover. The runtime derives one versioned proof only after a
complete successful `tools/list`; authentication rejection, protocol errors,
non-discovery requests, malformed or oversized results, and paginated partial
results emit nothing. Scope-filtered tools remain absent exactly as they are in
the caller's response.

The proof normalizes and bounds the returned tool catalog, explicitly bounds
its server and authentication metadata, caps the complete serialized envelope,
strips arbitrary protocol metadata, and includes a stable SHA-256 digest over
canonical tool content. It may identify the server, Chumbo runtime, requested
protocol version when available, and effective authentication strategy. It
never contains the
principal, effective scopes, credential, headers, request ID, arguments,
results, prompts, errors, or pagination cursors. The builder owns persistence
and delivery; Chumbo adds no account, network, or hosted-service dependency.
An unconfigured runtime does no proof inspection or hashing.

## 14. OAuth metadata routing: resolved implementation spike

The highest-priority technical uncertainty was how the Supabase gateway routes
path-aware RFC 9728 protected-resource metadata for an MCP resource located at:

```text
https://<project-ref>.supabase.co/functions/v1/mcp
```

The official MCP SDK can return web-standard metadata responses and can point a
`WWW-Authenticate` challenge at an arbitrary absolute `resource_metadata` URL.
The deployed spike proved this function-local public URL:

```text
https://<project-ref>.supabase.co/functions/v1/mcp/.well-known/oauth-protected-resource
```

Supabase's hosted gateway invokes the correct function for that suffix but
rewrites the URL seen by Edge Runtime from
`/functions/v1/mcp/.well-known/...` to `/mcp/.well-known/...`. The runtime now
matches both the canonical public path and the stable well-known suffix. A live
deployment returned the advertised challenge and reached the metadata handler;
it currently returns the explicit upstream-unavailable response because OAuth
Server is still disabled on the prototype project.

The remaining release verification is interoperability with:

- the official MCP TypeScript client;
- MCP Inspector;
- at least one independent remote MCP host with interactive OAuth.

This is a release blocker because it is the difference between a manually
header-configured server and an end-user-connectable server.

## 15. Consent UI

Supabase OAuth Server redirects authorization requests to an application-owned
authorization path. The builder must therefore provide a page that:

1. authenticates or recognizes the existing application user;
2. displays the requesting client and requested scopes;
3. allows approval or denial;
4. completes the Supabase OAuth authorization request.

Version `0.1.0` provides an optional minimal, unbranded consent Edge Function
that calls Supabase's `getAuthorizationDetails`, `approveAuthorization`, and
`denyAuthorization` APIs. It is a runnable fallback and a readable integration
reference, not a new consent framework. Existing applications should normally
move those three calls into their signed-in frontend.

The initializer should not modify a framework-specific web application without
an explicit flag. A later release may add Next.js, React Router, SvelteKit, or
other adapters based on demand.

## 16. MCP capabilities

### 16.1 Successful-result composition

Builders may add bounded MCP content before or after a successful authored
tool result without reconstructing it. Composition preserves the original
content ordering, `structuredContent`, `_meta`, Resources, and unknown valid
top-level fields. The package validates and bounds only the added content.

Optional `resultMiddleware` runs in declaration order for successful tool
results registered through the ordinary official MCP API, including scoped
registrations. Every middleware receives the same immutable snapshot of the
authored result plus the request context and tool name. Middleware can return
only additive `prepend` or `append` blocks. It does not run for tool errors,
input-required results, or thrown handler failures. Invalid additions and
middleware failures leave the last valid composition intact and reach the
application error hook without changing the tool outcome.

Added result text is model-facing content. It is not a system message, cannot
force another tool call, and does not create a workflow engine.

### Required in `0.1.0`

- tools: registration, list, call, structured results, protocol errors;
- resources: static resources, templates, list/read, cache hints;
- prompts: registration, list/get;
- MRTR: one input-required/elicitation example using the official SDK;
- modern discovery and stateless requests;
- official SDK's stateless legacy compatibility unless tests show it harms the
  Edge deployment or auth flow.

### Optional after `0.1.0`

- `io.modelcontextprotocol/tasks` adapter backed by a Postgres table and a
  Supabase Queue/worker;
- `subscriptions/listen` integration;
- client-specific connection helpers;
- typed database generation integration;
- ChatGPT Apps UI resources.

The library must not re-expose every MCP method with a parallel API. Application
authors can access the underlying official `McpServer` when they need an
advanced capability.

## 17. Error model

Errors must remain useful at three layers:

1. HTTP/OAuth errors for clients and authorization discovery;
2. MCP protocol errors handled by the official SDK;
3. application tool errors readable by the model and end user.

Defaults:

- missing/invalid token: `401` plus standards-shaped Bearer challenge;
- insufficient scopes: `403` with `insufficient_scope`;
- invalid arguments: ordinary MCP tool error with concise correction guidance;
- RLS empty result: not automatically treated as an authorization error;
- database or Storage failure: sanitized tool error plus server-side trace ID;
- unknown exception: no secret, SQL text, JWT, or service key in the response.

The package should provide a narrow error hook for Sentry or another logger but
must not prescribe an observability vendor.

## 18. Multi-tenancy and RLS contract

RLS separates database rows, not Edge compute or in-memory state. The package
must document and test these rules:

- create Supabase clients per request;
- never store the current user or organization in module globals;
- module-level caches must use verified tenant and version keys;
- cached application data is outside RLS once loaded into memory;
- service-role clients bypass RLS and are never the default user context;
- views must be security-invoker or otherwise explicitly governed;
- OAuth `client_id` and application claims may refine RLS, but user-editable
  metadata must not become authorization authority.

The example app must contain a negative cross-tenant test, not just two positive
reads.

## 19. Tests and evidence

### 19.1 Unit tests

- deterministic CLI plans;
- dry-run produces no writes;
- conflict handling and idempotent re-run;
- request-context isolation under concurrent requests;
- OAuth metadata and challenge generation;
- invalid, expired, and insufficient-scope tokens;
- no privileged client in default context;
- no credential, HMAC key, state partition, or privileged state client in the
  handler context, errors, or responses;
- state isolation across users, rotated credentials, API keys, namespaces, and
  keys; atomic CAS/delete races; TTL and encoded-size boundaries;
- result helpers preserve MCP content and structured content;
- error redaction.

### 19.2 Generated-project tests

- Deno type-check;
- local Edge Function boot;
- `server/discover` for modern clients;
- stateless legacy connection when enabled;
- tools list/call;
- resources list/read;
- prompts list/get;
- one MRTR retry;
- malformed header/body mismatch handled by the official SDK;
- two independent requests require no shared session.

### 19.3 Local Supabase integration

Seed:

- Alice, Bob;
- organization A, organization B;
- separate memberships and private rows;
- RLS policies used by the example MCP capability.

Assertions:

- Alice cannot read or mutate B;
- Bob cannot read or mutate A;
- concurrent requests retain the correct user context;
- a privileged test path is isolated from the public runtime API.

### 19.4 Cloud OAuth integration

Use a dedicated test Supabase project. Verify:

- OAuth authorization-server discovery;
- protected-resource discovery through the MCP challenge;
- PKCE authorization and consent;
- access-token call;
- refresh-token call;
- revoke/expire behavior;
- real RLS results;
- a real remote MCP client connection.

Cloud tests that create OAuth clients or users must use dedicated fixtures and
clean up only their own identified records.

### 19.5 Protocol conformance

Use the official MCP conformance suite where it applies. Do not claim protocol
compliance solely because the official SDK is a dependency: the adapter's HTTP
routing, auth middleware ordering, response handling, and Edge gateway can still
break compliant behavior.

### 19.6 Current release-candidate evidence

As of 2026-08-11:

- 17 unit/protocol tests pass, including modern discovery, tools, resources,
  prompts, MRTR retry, legacy stateless serving, malformed modern requests,
  OAuth challenges, token redaction, gateway-rewritten metadata paths, doctor,
  and concurrent identity isolation;
- generated MCP and consent functions pass Deno typechecking, and the generated
  MCP test passes;
- a real local Supabase Alice/Bob integration passes positive and negative RLS
  assertions concurrently;
- the exact npm tarball installs and answers MCP from an empty consumer project;
- the deployed cloud function returns the correct challenge and passes
  authenticated `tools/list` plus `whoami` with a real Supabase user JWT;
- the disposable cloud user was removed after the smoke test.

Interactive PKCE, refresh, revocation, independent-client compatibility, public
npm installation, and release publication remain open release gates.

## 20. Compatibility policy

Initial pinned dependencies observed on 2026-08-11:

- `@modelcontextprotocol/server@2.0.0`;
- `@supabase/server@1.4.1` (public beta under SemVer);
- Zod 4 compatible with the MCP SDK's Standard Schema support;
- a pinned Supabase CLI version in integration CI.

Implementation must re-check current versions and changelogs before installing.
The repository commits all lockfiles.

Version policy:

- package patch: bug fixes and compatible upstream bumps;
- package minor: new adapters, auth modes, CLI features, or generated optional
  files;
- package major: generated-code contract or public runtime API breaks;
- upstream MCP protocol changes are absorbed through the official SDK whenever
  possible;
- generated projects pin a known-good package version rather than `latest`.

## 21. CLI mutation rules

The initializer is operating inside someone else's application repository. It
must:

- inspect before writing;
- use an explicit file plan;
- preserve unrelated `config.toml` content and formatting where practical;
- never delete application files; a skill update may remove only an obsolete
  file it owns whose hash still matches its managed manifest;
- never overwrite a non-generated capability file without confirmation;
- mark generated files clearly without making them unpleasant to edit;
- create a recoverable backup or patch preview for modifications to existing
  files;
- return non-zero on partial failure and list exactly what changed;
- never print secrets;
- offer an idempotent `init` re-run, a repository-derived `setup --resume`, and
  read-only `status` and `doctor` commands;
- emit JSON only on stdout in machine mode and keep subprocess output captured;
- return stable statuses and next commands without serializing tokens.

The skill installer additionally preserves every byte of `AGENTS.md` outside
its marked block, writes its manifest last, refuses malformed or path-escaping
manifests, and does not overwrite locally edited managed files.

## 22. Documentation requirements

The public README must get a builder from an existing repository to a local tool
call quickly, then clearly separate the production OAuth path.

Required documentation:

1. five-minute local quickstart;
2. production end-user OAuth setup;
3. writing tools with request-scoped `ctx.supabase`;
4. resources and prompts;
5. RLS and multi-tenancy model;
6. consent-page integration;
7. deploy and connect;
8. client compatibility matrix based on real tests;
9. troubleshooting by observable symptom;
10. architecture and extension boundaries;
11. package version and upstream compatibility policy;
12. migration notes for every release that changes generated code.

Do not lead the README with protocol history. Lead with the outcome and the
working commands.

## 23. Release artifact

Version `0.1.0` requires:

- public GitHub repository;
- MIT license;
- npm package with provenance where practical;
- exact dependency lockfile;
- GitHub Actions for type-check, unit tests, generated-project test, and build;
- one reproducible cloud smoke workflow with secrets documented but not stored;
- tagged GitHub release and changelog;
- example Supabase project;
- verified quickstart from a clean checkout;
- no credentials, project secrets, access tokens, or real user data in history.

## 24. Implementation sequence

### Plateau 1: deployed modern MCP skeleton

- Create repository/package/CI skeleton.
- Pin official MCP and Supabase server dependencies.
- Serve one tool through `createMcpHandler` in a Supabase Edge Function.
- Verify modern and stateless legacy behavior through official clients.
- Record the exact Edge routing behavior.

Exit: fresh checkout deploys a public test tool without handwritten MCP wire
code.

### Plateau 2: protected resource and Supabase identity

- Serve protected-resource metadata.
- Compose Supabase OAuth issuer metadata.
- Return correct OAuth challenges.
- Validate Supabase OAuth JWTs.
- Construct request-scoped RLS-aware clients.
- Prove two-user isolation locally.

Exit: automated bearer-token integration passes with separate Alice/Bob rows.

### Plateau 3: real interactive OAuth

- Add minimal consent UI/example.
- Enable and configure Supabase OAuth Server in a dedicated cloud project.
- Connect official MCP client and one independent real host.
- Verify PKCE, refresh, revocation, and RLS.

Exit: the complete end-user definition of done passes.

### Plateau 4: EZ Mode initializer

- Implement guided `setup`, deterministic `init`, read-only `status`,
  auth-aware `doctor`, and minimal `dev` delegation.
- Generate capability and test files.
- Add conflict-safe mutation and dry run.
- Run human and machine setup paths against clean and existing Supabase
  fixtures.

Exit: a new builder reaches the proven runtime without copying repository code.

### Plateau 5: breadth and release

- Add resource, prompt, and MRTR examples.
- Run conformance and deployment regression corpus.
- Tighten README and troubleshooting.
- Publish `0.1.0` and verify installation from npm rather than a workspace.

Exit: public release artifacts and clean-install verification pass.

## 25. Risks and mitigations

### Supabase OAuth Server is public beta

Risk: endpoint behavior or setup may change.\
Mitigation: isolate OAuth composition, pin tested versions, run cloud smoke, and
state the beta dependency in the README.

### MCP `2026-07-28` is newly released

Risk: hosts and SDKs will adopt it unevenly.\
Mitigation: use the official TypeScript SDK's dual-era handler, test real hosts,
and publish a dated compatibility matrix.

### OAuth metadata routing under `/functions/v1/*`

Risk: root well-known URL assumptions may not match Supabase gateway routing.\
Mitigation: make the protected-resource URL explicit in the challenge and prove
it through live clients before designing the public API around it.

### Consent UI fragmentation

Risk: every builder uses a different frontend stack.\
Mitigation: provide a framework-neutral flow and minimal examples, while keeping
framework adapters outside the core release gate.

### Scope creep into an MCP framework

Risk: tools, tasks, UI, queues, schemas, and database generation expand the
project beyond its useful seam.\
Mitigation: measure every feature against the one-command OAuth/RLS outcome and
expose the official MCP server for advanced use rather than cloning its API.

### Accidental RLS bypass

Risk: examples using service-role clients are copied into production.\
Mitigation: omit admin access from default context, include negative tenant
tests, and make privileged operations an explicitly named opt-in.

## 26. Resolved decisions and remaining release questions

Resolved:

1. Use the function-local protected-resource URL and normalize Supabase's hosted
   `/functions/v1` rewrite inside the runtime.
2. Use `verifyCredentials` and `createContextClient` from
   `@supabase/server/core`; do not duplicate JWT parsing.
3. Serve modern MCP and official stateless legacy compatibility by default.
4. Host the optional minimal consent UI as a second Supabase Edge Function.
5. Keep one combined runtime/CLI package; the packed artifact is 27 KB and its
   clean-consumer proof passes.
6. Use the unscoped `chumbo` name and position it explicitly as an
   end-user application MCP, not the Supabase management MCP.

Still to verify before release:

1. Which independent MCP hosts complete dynamic registration and PKCE against
   the enabled Supabase OAuth Server without pre-registration?
2. Does refresh and revocation behave correctly through those hosts?

## 27. Source-grounded facts and references

Observed as of 2026-08-11:

- Supabase Edge Functions are TypeScript/Deno functions and support npm imports.
- Supabase Auth can act as an OAuth 2.1/OIDC provider for MCP, with PKCE,
  authorization-server discovery, refresh tokens, and Supabase JWTs governed by
  existing RLS.
- Supabase OAuth Server is public beta.
- MCP `2026-07-28` removes the required handshake/session model and introduces
  stateless per-request metadata and `server/discover`.
- `@modelcontextprotocol/server@2.0.0` supports Deno and provides
  `createMcpHandler`, which can serve modern and stateless legacy requests.
- The official SDK provides web-standard OAuth protected-resource metadata
  helpers; the Supabase adapter must still prove routing under the Edge Function
  URL.
- `@supabase/server@1.4.1` provides stateless header-based auth and request-
  scoped Supabase client context and is itself a public-beta package under
  SemVer.
- Supabase's current MCP Edge Function example uses `mcp-lite` and a public sum
  tool; it does not provide the complete end-user OAuth/RLS application path.

Primary references:

- Supabase MCP authentication:
  https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication
- Supabase OAuth Server: https://supabase.com/docs/guides/auth/oauth-server
- Supabase Edge Function authentication:
  https://supabase.com/docs/guides/functions/auth
- Supabase MCP Edge example:
  https://supabase.com/docs/guides/functions/examples/mcp-server-mcp-lite
- Official MCP TypeScript SDK:
  https://github.com/modelcontextprotocol/typescript-sdk
- Official SDK protocol versions:
  https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md
- Official SDK authorization guide:
  https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/authorization.md
- MCP `2026-07-28` release:
  https://blog.modelcontextprotocol.io/posts/2026-07-28/
- Supabase server utilities: https://github.com/supabase/server

## 28. Next-agent procedure

1. Re-read this specification and preserve its product boundary.
2. Re-check npm versions and Supabase/MCP changelogs; both key packages are
   newly released.
3. Create the package skeleton and lock dependencies.
4. Implement Plateau 1 only: official `createMcpHandler`, one tool, one deployed
   Edge Function, automated modern/legacy clients.
5. Inspect actual HTTP requests and responses, especially route paths and
   protocol headers.
6. Move immediately to the protected-resource metadata routing spike; do not
   spend time polishing a public tool registry first.
7. Record observed behavior and update the open questions before expanding the
   CLI surface.

## 29. Bottom line

The repository succeeds when it removes the Supabase-specific distance between
"I have an application with users and RLS" and "my users can connect their AI
client to it through MCP."

The hard and valuable part is not tool registration. It is making OAuth
discovery, Edge routing, request identity, RLS, generated configuration, and
real-client verification feel like one coherent Supabase feature.
