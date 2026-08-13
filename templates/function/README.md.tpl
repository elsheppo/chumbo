# {{SERVER_NAME}} MCP function

This function exposes application capabilities to end users through MCP. A
request's `ctx.supabase` client carries that user's Supabase access token, so
your existing Row Level Security policies decide which rows are visible.

## Develop

```sh
supabase functions serve {{FUNCTION_NAME}}
deno task --config supabase/functions/{{FUNCTION_NAME}}/deno.json test
```

## Deploy

The gateway JWT check must remain disabled so the function can serve OAuth
discovery and standards-shaped challenges. The function still verifies every
user JWT itself.

```sh
supabase functions deploy {{FUNCTION_NAME}} --no-verify-jwt
create-supabase-mcp doctor \
  --function {{FUNCTION_NAME}} \
  --url https://YOUR_PROJECT.supabase.co/functions/v1/{{FUNCTION_NAME}}
```

For OAuth mode, enable Supabase OAuth Server, configure your application's
authorization/consent path, and enable dynamic client registration if your MCP
clients require it. `--consent minimal` generates a standalone reference
consent function; an existing application can use its own UI instead.

Edit `capabilities.ts` to expose your app. Do not create a service-role client
for end-user handlers: that bypasses RLS.
