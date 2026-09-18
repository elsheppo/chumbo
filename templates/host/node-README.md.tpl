# {{SERVER_NAME}} MCP server

This directory is a standalone Node MCP server built on the Chumbo runtime,
served through `chumbo/node`. It suits Cloud Run, Fly, Railway, or any
container platform: the server listens on `PORT` (default 8080) and serves
`/{{FUNCTION_NAME}}` plus the `/.well-known/...` suffixes MCP clients use for
OAuth discovery.
{{ACCESS_DESCRIPTION}}

Your Supabase project remains the identity and data plane; this is the same
Chumbo runtime that runs on Supabase Edge Functions, hosted in your own
process.

## Configure

Pin the runtime as an application dependency:

```sh
{{INSTALL_COMMAND}} chumbo@{{PACKAGE_VERSION}}
```

Provide the environment locally and in your deployment platform:

```dotenv
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=your-publishable-or-anon-key
{{HOST_ENV_SETUP}}```

In production, set `MCP_PUBLIC_URL` to the exact URL clients connect to, such
as `https://mcp.yourapp.com/{{FUNCTION_NAME}}`.
{{HOST_MIGRATION_SETUP}}
For agent-assisted development, install the version-matched project guidance:

```sh
npx chumbo skill install
```

## Develop

Run the server directly – Node 22.18+ executes TypeScript natively, and older
Node 22 releases accept the flag explicitly:

```sh
node --experimental-strip-types {{FUNCTION_NAME}}/index.ts
```

Then prove the generated starter through the real MCP boundary from another
terminal:

```sh
npx chumbo doctor \
  --function {{FUNCTION_NAME}} \
  --url {{LOCAL_ENDPOINT}} \
  {{LOCAL_DOCTOR_AUTH}}--call-tool whoami
```

Doctor proves MCP initialization, `tools/list`, and the explicit `whoami`
call. Replace that one tool in `capabilities.ts` with an operation from your
application. `ctx.supabase` is request-scoped; its database authority follows
the access mode described above.

## Deploy

Build and deploy with your platform's normal container or Node pipeline. Set
the same environment variables in production, including `MCP_PUBLIC_URL`,
then verify the live endpoint:

```sh
npx chumbo doctor --function {{FUNCTION_NAME}} --url https://mcp.yourapp.com/{{FUNCTION_NAME}} --json
```

Do not create a service-role client for end-user handlers: that bypasses RLS.
