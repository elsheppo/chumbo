# {{SERVER_NAME}} MCP function

This function exposes application capabilities to end users through MCP.
{{ACCESS_DESCRIPTION}}
{{PUBLIC_SETUP}}

Edit `capabilities.ts` to expose your app, then let the setup command re-check
the project and report the remaining actions:

```sh
npx supa-mcp setup --resume --function {{FUNCTION_NAME}}
```

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
npx supa-mcp doctor \
  --function {{FUNCTION_NAME}} \
  --url https://YOUR_PROJECT.supabase.co/functions/v1/{{FUNCTION_NAME}}
```

To give clients a clean URL, configure the Edge Function's advertised identity
and proxy the entire route tree—including its `/.well-known/...` suffixes—to
the Supabase function:

```sh
npx supa-mcp setup \
  --resume \
  --function {{FUNCTION_NAME}} \
  --public-url https://yourapp.com/mcp
```

The project's Supabase Auth URL remains the OAuth issuer. Run `doctor` against
the clean URL after the proxy is live.

For agents and CI, both continuation and diagnostics have stable JSON output:

```sh
npx supa-mcp setup --resume --function {{FUNCTION_NAME}} --yes --json
npx supa-mcp doctor --function {{FUNCTION_NAME}} --url https://YOUR_PROJECT.supabase.co/functions/v1/{{FUNCTION_NAME}} --json
```

For OAuth mode, enable Supabase OAuth Server, configure your application's
authorization/consent path, and enable dynamic client registration if your MCP
clients require it. `--consent minimal` generates a standalone reference
consent function; an existing application can use its own UI instead.

Do not create a service-role client for end-user handlers: that bypasses RLS.
