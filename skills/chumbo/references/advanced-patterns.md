# Advanced patterns

The ordinary path is one stateless Edge Function with builder-authored
capabilities. Use the patterns below only when the application has the named
need. Confirm each API against the project's installed package before writing
code.

## Multiple identities and scoped discovery

One endpoint may accept a Supabase user token and application-owned keys. Use
`mode: "multi"` with deterministic, non-overlapping key prefixes so each token
routes to exactly one strategy before verification. A failed prefixed key must
not fall through and be retried as a user token.

`server.withScopes(...)` removes unavailable tools, Resources, and prompts from
discovery and disables direct invocation for that request:

```ts
server
  .withScopes(["directory:moderate"])
  .registerTool("approve_submission", options, handler);
```

Scopes describe capabilities, not application roles. RLS, grants, or the
existing API still authorize the data and mutation.

See [Different capability surfaces](https://github.com/elsheppo/chumbo/tree/main/docs/patterns/privileged-capabilities).

## Bounded request-to-request state

Most servers should remain stateless. Use opt-in `ctx.state` only for small
coordination facts that must survive disposable requests, such as an
observation receipt or revision marker.

The API exposes namespace-allowlisted `get` and revision-checked `put`/`delete`.
Storage is partitioned by caller credential; the service-role client and raw
partition key do not enter capability context.

It is not an application database, queue, lease service, worker, generalized
transaction layer, or resident actor. Generate a namespace explicitly:

```sh
npx chumbo setup --resume --state-namespace <namespace>
```

See [Observation before action](https://github.com/elsheppo/chumbo/tree/main/docs/patterns/observation-before-action).

## Application observation and correlation

Add these only for a named application consumer:

- `onEvent` emits secret-safe lifecycle facts for invoked capabilities.
- `onSurface` emits a redacted proof of the tool catalog returned by a
  successful `tools/list`.
- `createRunCorrelation` carries a bounded, signed application-run fact across
  selected calls when the application already has a run or work-order model.

They do not authorize requests, retain tool arguments or results, or create an
execution system.

## Protocol and deployment composition

- [Interactive MCP Apps](https://github.com/elsheppo/chumbo/tree/main/docs/patterns/mcp-apps-on-supabase)
  add an embedded interface when a real interaction needs one.
- [Many MCPs from one function](https://github.com/elsheppo/chumbo/tree/main/docs/patterns/many-mcps-one-function)
  lets one deployment resolve several server definitions.
- [Clean client-facing URLs](https://github.com/elsheppo/chumbo/tree/main/docs/reference/clean-urls)
  put the MCP on an application-owned domain. Proxy the full route tree,
  including `/.well-known/...` suffixes.

These compose the official MCP surface; they do not introduce a separate
capability DSL.

## Separate product layers

| Layer                   | Use it for                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Public `chumbo` package | The request runtime, generated Edge Function, capability registration, auth context, results, and diagnostics                |
| Chumbo Cloud            | Builder onboarding, project discovery, explicitly authorized installation, provisioning, and hosted operational coordination |
| `ctx.state`             | Small credential-partitioned coordination records used by request handlers                                                   |
| `@chumbo/durable`       | Separate actor/runtime infrastructure when a workload genuinely needs actor semantics                                        |

Cloud does not become the application's data plane. Durable is not ordinary
request state. Keep builder-authored capabilities in the application project.
