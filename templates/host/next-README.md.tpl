# {{SERVER_NAME}} MCP route

This App Router route exposes application capabilities to end users through
MCP. The route handler in `[[...path]]/route.ts` serves `/{{FUNCTION_NAME}}`
and every path beneath it, including the `/.well-known/...` suffixes MCP
clients use for OAuth discovery.
{{ACCESS_DESCRIPTION}}

Your Supabase project remains the identity and data plane; this route is the
same Chumbo runtime that runs on Supabase Edge Functions, hosted inside your
application server.

## Configure

Pin the runtime as an application dependency:

```sh
{{INSTALL_COMMAND}} chumbo@{{PACKAGE_VERSION}}
```

Provide the Supabase environment in `.env.local` for development and in your
hosting platform's environment for production:

```dotenv
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=your-publishable-or-anon-key
{{HOST_ENV_SETUP}}```

The route also accepts the `NEXT_PUBLIC_`-prefixed names your app may already
define. In production, set `MCP_PUBLIC_URL` to the exact URL clients connect
to, such as `https://yourapp.com/{{FUNCTION_NAME}}`.
{{HOST_MIGRATION_SETUP}}
For agent-assisted development, install the version-matched project guidance:

```sh
npx chumbo skill install
```

## Develop

Run your app's ordinary dev server, then prove the generated starter through
the real MCP boundary from another terminal:

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

Deploy with your application's normal pipeline (Vercel, Cloud Run, or any Node
host). Set the same environment variables in production, including
`MCP_PUBLIC_URL`, then verify the live endpoint:

```sh
npx chumbo doctor --function {{FUNCTION_NAME}} --url https://yourapp.com/{{FUNCTION_NAME}} --json
```

Do not create a service-role client for end-user handlers: that bypasses RLS.
