# {{SERVER_NAME}} MCP function

This function exposes application capabilities to end users through MCP.
{{ACCESS_DESCRIPTION}}
{{API_KEY_SETUP}}
{{PUBLIC_SETUP}}{{STATE_README}}

The generated `whoami` tool is runnable immediately. Use the generated
contract test to verify the starter through the MCP boundary, then replace that
one tool in `capabilities.ts` with an operation from your application:

```sh
deno task --config supabase/functions/{{FUNCTION_NAME}}/deno.json test
```

`ctx.supabase` is request-scoped. Its database authority follows the access
mode described above. Then let setup re-check the project and report the
remaining actions:

```sh
npx chumbo setup --resume --function {{FUNCTION_NAME}}
```

## Develop

Start the local Supabase stack, then keep the generated function running in one
terminal:

```sh
supabase start
{{LOCAL_MIGRATION_COMMAND}}npx chumbo dev --function {{FUNCTION_NAME}}{{LOCAL_DEV_AUTH}}
```

In another terminal, test and call the starter through Streamable HTTP:

```sh
deno task --config supabase/functions/{{FUNCTION_NAME}}/deno.json test
npx chumbo doctor \
  --function {{FUNCTION_NAME}} \
  --url {{LOCAL_ENDPOINT}} \
  {{LOCAL_DOCTOR_AUTH}}--call-tool whoami
```

Doctor proves MCP initialization, `tools/list`, and the explicit `whoami` call.
It never invokes an arbitrary discovered tool. The generated `index.ts` and
`capabilities.ts` used here are the same files deployed below.

## Explore the full MCP surface

The starter stays deliberately small. Chumbo's
[executable capability showcase](https://github.com/elsheppo/chumbo/tree/main/docs/patterns/model-facing-results)
covers tools, Resources, prompts, elicitation, typed results, hybrids, empty
states, and recoverable errors through the same official MCP registration API.

## Deploy

The gateway JWT check must remain disabled because the function owns its MCP
authentication contract. Authenticated modes still verify every credential
before registering or calling tools.

```sh
supabase functions deploy {{FUNCTION_NAME}} --no-verify-jwt
npx chumbo doctor \
  --function {{FUNCTION_NAME}} \
  --url https://YOUR_PROJECT.supabase.co/functions/v1/{{FUNCTION_NAME}}
```

To give clients a clean URL, configure the Edge Function's advertised identity
and proxy the entire route tree – including its `/.well-known/...` suffixes – to
the Supabase function:

```sh
npx chumbo setup \
  --resume \
  --function {{FUNCTION_NAME}} \
  --public-url https://yourapp.com/mcp
```

The project's Supabase Auth URL remains the OAuth issuer. Run `doctor` against
the clean URL after the proxy is live.

For agents and CI, both continuation and diagnostics have stable JSON output:

```sh
npx chumbo setup --resume --function {{FUNCTION_NAME}} --yes --json
npx chumbo doctor --function {{FUNCTION_NAME}} --url https://YOUR_PROJECT.supabase.co/functions/v1/{{FUNCTION_NAME}} --json
```

For OAuth mode, enable Supabase OAuth Server, configure your application's
authorization/consent path, and enable dynamic client registration if your MCP
clients require it. `--consent minimal` generates a standalone reference
consent function; an existing application can use its own UI instead.

Do not create a service-role client for end-user handlers: that bypasses RLS.
