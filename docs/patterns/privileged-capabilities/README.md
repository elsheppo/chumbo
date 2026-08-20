# Different capability surfaces on one endpoint

Use this pattern when an application has more than one legitimate way to
connect to the same MCP—for example, interactive Supabase users and
application-owned API keys—and those identities should discover different
capabilities.

This is an authentication and capability-composition pattern, not a role
system. Supa MCP does not define `owner`, `admin`, or any application table.
The example uses a readable user/owner distinction, but builders choose their
own identities and scope vocabulary.

## The contract

1. Put the Supabase user strategy and application-key strategy in one `multi`
   auth configuration.
2. Give verifier-backed application keys a unique prefix. Matching happens
   before verification, and failure never falls through to another strategy.
3. Resolve application scopes in `access.resolveScopes`.
4. Register restricted tools, resources, and prompts through
   `server.withScopes(...)`.
5. Generate request-aware server instructions from the same context.

Supabase user requests receive `ctx.user`, JWT claims, and a request-scoped
Supabase client that preserves RLS. Application-key requests receive the
verifier's stable `ctx.subject` and scopes, with an anonymous client. The
application can call narrow RPCs or other data-plane APIs for privileged work;
the library does not leak its verifier-only admin client into handlers.

```ts
const app = createSupabaseMcp({
  server: { name: "Catalog MCP", version: "1.0.0" },
  resourceUrl,
  auth: {
    mode: "multi",
    strategies: [
      { mode: "oauth", strategy: "supabase-user" },
      {
        mode: "api-key",
        strategy: "application-key",
        tokenPrefix: "catalog_",
        verify: resolveApplicationKey,
      },
    ],
  },
  access: { resolveScopes },
  instructions: (ctx) =>
    ctx.hasScope("catalog:publish")
      ? "You may read and publish catalog items."
      : "You may read catalog items.",
  register(server) {
    server.withScopes(["catalog:read"]).registerTool("list_catalog", read);
    server
      .withScopes(["catalog:publish"])
      .registerTool("publish_item", publish);
  },
});
```

The scope gate controls both discovery and invocation. A caller without
`catalog:publish` cannot list or call `publish_item`; the registered capability
is disabled inside that request's isolated server instance.

See the runnable `privileged-capabilities-example` for the complete Edge
Function, key table, and two-identity integration proof.
