# Run, deploy, and verify

Treat local infrastructure, function serving, protocol tests, and application
outcomes as separate checks.

## Local loop

From the repository containing `supabase/config.toml`:

1. Start local Supabase:

   ```sh
   supabase start
   ```

2. Serve the function in another terminal:

   ```sh
   npx chumbo dev --function mcp
   ```

3. Run the generated mode-specific contract test:

   ```sh
   deno task --config supabase/functions/mcp/deno.json test
   ```

   API-key mode discovers and invokes the generated starter. OAuth and bearer
   modes prove their unauthenticated rejection, while public mode proves the
   fetch handler boots. After replacing `whoami`, update `index_test.ts` for the
   new capability.

4. Probe the local MCP endpoint:

   ```sh
   npx chumbo doctor \
     --function mcp \
     --url http://127.0.0.1:54321/functions/v1/mcp
   ```

Use the actual function name when it is not `mcp`. Add `--token` for bearer or
API-key discovery. Use a real user token when proving OAuth capabilities and
RLS locally.

5. Invoke one explicitly safe application tool through the updated test or a
   configured MCP client. Check the application result, not just HTTP 200.

## Deploy

```sh
supabase functions deploy mcp --no-verify-jwt
npx chumbo doctor \
  --function mcp \
  --url https://PROJECT_REF.supabase.co/functions/v1/mcp
```

The endpoint is Streamable HTTP at the function URL. Do not append `/sse`.

## Connect a client

For Claude Code:

```sh
claude mcp add --transport http my-app \
  https://PROJECT_REF.supabase.co/functions/v1/mcp
```

OAuth mode opens the application's sign-in and consent flow; public mode needs
no credential. For bearer and API-key modes:

```sh
claude mcp add --transport http my-app \
  https://PROJECT_REF.supabase.co/functions/v1/mcp \
  --header "Authorization: Bearer <credential>"
```

Keep live credentials out of committed project configuration, logs, and copied
diagnostics. Hosted connector products may require OAuth and dynamic client
registration.

## Select verification by risk

| Condition                                            | Evidence to collect                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| Every change                                         | Type-check; generated test; `initialize`; `tools/list`; one relevant `tools/call` |
| Text, structured, hybrid, or Resource result changed | Assert the exact wire shape and empty/error branches that differ                  |
| Auth or RLS changed                                  | Reject invalid credentials and prove two-user isolation where ownership matters   |
| Scoped discovery changed                             | Compare identities and directly reject a hidden capability call                   |
| Multi-auth changed                                   | Prove token routing and failed prefixed-key non-fallback                          |
| Deployment changed                                   | Run `doctor` and a real hosted client smoke against the public URL                |
| Setup, templates, or package exports changed         | Test a clean generated or packed consumer from first install                      |

## Completion signal

The generated test passes; `doctor` reaches the intended endpoint; the real
capability appears for the intended identity; a safe call produces the
application outcome; and the relevant unauthorized or cross-user case fails.
Name anything not tested.
