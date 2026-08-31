# Testing and completion

Test the capability at the boundary its users will actually call. Unit tests
are useful for application logic, but compilation or direct handler invocation
alone does not prove an MCP surface, authentication gate, or RLS slice.

## Evidence ladder

Use the relevant levels; identity-sensitive and deployed work needs more than
the first two.

1. Type-check the Edge Function. Validate every input schema and every declared
   output schema; structured and hybrid results require exact output schemas.
2. Assert exact result lanes: text-only, structured-only, intentional hybrid,
   or Resource link without an embedded body.
3. Exercise `initialize`, `tools/list`, and `tools/call` through Streamable
   HTTP.
4. Exercise `resources/list`, Resource templates, and `resources/read` when the
   surface uses them.
5. Exercise `prompts/list` and `prompts/get`, and compare request-aware
   `initialize.instructions`, when the surface uses them.
6. Reject missing, invalid, expired, revoked, and wrong-prefix credentials as
   applicable.
7. Use two real Supabase users to prove RLS isolation. Include concurrent calls
   when identity state is material.
8. Compare ordinary and privileged discovery surfaces.
9. Directly invoke a hidden capability and prove the SDK rejects it before its
   handler or data mutation runs.
10. Prove a failed prefixed API key cannot fall through to another auth
    strategy.
11. Exercise populated, empty, missing, conflicting, failed, and Resource
    branches that materially differ.
12. When deployment is in scope, run `npx chumbo doctor` and a public hosted
    smoke against the deployed URL.

Do not manufacture every case for every tool. Select the cases that could
change authority, result interpretation, or recovery.

## Result assertions

- A `structuredResult` preserves the exact scalar, array, object, nested value,
  or null promised by `outputSchema` and adds no text serialization.
- A `renderResult` has purpose-written text and exact structured data; the text
  is meaningfully smaller or more interpretive than the structure.
- A `resourceResult` contains the reading card and link, never the complete
  body. `resources/read` returns the body with the advertised MIME type.
- Empty successful collections are not mislabeled as errors.
- Recoverable errors provide a cause-appropriate next step; terminal errors do
  not invent one.

## Authority assertions

- Tool arguments cannot select a different owner, principal, or scope.
- Ordinary identities neither discover nor invoke privileged capabilities.
- RLS or the established application data plane independently rejects a direct
  bypass.
- API-key handlers do not receive or construct a service-role client.
- Requests from two identities do not share server registrations, context,
  rows, or instructions.

## Completion report

Report what is proven in product terms:

- identities exercised;
- discovery difference observed;
- successful application outcomes;
- negative access and isolation outcomes;
- result and Resource contracts observed through MCP;
- local or hosted boundary tested.

Name anything not tested. A green type-check is not evidence that users can
connect or that unauthorized callers are excluded.

## Local-first proof

For an undeployed Supabase project, use the production-shaped local path:

```sh
supabase start
npx chumbo dev --function mcp
npx chumbo doctor \
  --function mcp \
  --url http://127.0.0.1:54321/functions/v1/mcp \
  --call-tool <SAFE_TOOL>
```

For public mode, apply the generated rate-limit migration after starting
Supabase and before probing the function:

```sh
supabase migration up --local
```

Add `--token` for the configured protected auth mode. Do not add a development
auth bypass, and do not create a parallel stdio MCP merely because the Edge
Function has not been deployed.

For a generated static API-key server, keep `MCP_API_KEY` in the project's
gitignored local environment file and pass that file through
`chumbo dev --env-file`. Setting the hosted Edge Function secret is a separate
deployment step.
