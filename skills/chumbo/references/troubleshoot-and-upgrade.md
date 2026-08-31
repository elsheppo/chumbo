# Troubleshoot and upgrade

Start with observable symptoms instead of rewriting auth or transport code:

```sh
npx chumbo doctor --function mcp --url <mcp-url> --json
```

Add `--token` only when it is appropriate to exercise that identity. Keep
credentials out of logs, committed files, issue text, and copied diagnostics.

## Symptom map

| Symptom                          | Inspect                                                                            | Likely next action                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 401 without a credential         | `runtime-auth-mode`, `oauth-challenge`, or the API-key/bearer gate                 | Expected for protected modes; retry with the configured identity                                 |
| 401 with a credential            | Auth mode, token issuer/resource, key prefix, environment                          | Use the credential type expected by this deployment; do not bypass auth with service role        |
| 503 or HTML/upstream response    | `runtime-reached`, proxy, gateway, function boot output                            | Fix the first layer before the runtime; confirm function name and environment                    |
| Missing tools                    | `authenticated-tools-list`, caller scopes, registration branches, deployed version | Discover as the same identity; correct scope resolution or deploy the intended source            |
| Successful call returns no rows  | Actual user, grants, SELECT policy, ownership predicate, environment               | Fix or explain the RLS/empty-state contract rather than treating every empty result as forbidden |
| `/sse` URL fails                 | Saved client endpoint                                                              | Use `/functions/v1/<function-name>` without `/sse`                                               |
| Local port conflict              | `supabase status` and serving terminal                                             | Reuse the intended running project or stop/reconfigure the known owner deliberately              |
| Local and hosted behavior differ | `runtime-version`, `runtime-auth-mode`, `runtime-resource-url`                     | Reconcile package/import, deployment, and public URL before changing capability code             |

## OAuth resource or audience mismatch

The public MCP URL is the OAuth resource identifier. Do not confuse it with an
MCP Resource, which is content exposed through `resources/read`.

Preserve the public URL through:

1. the MCP endpoint and clean proxy URL;
2. `WWW-Authenticate` and protected-resource metadata;
3. the authorization request's `resource` parameter;
4. token exchange and refresh;
5. any token-vending or connector mediation;
6. token audience validation;
7. saved connector configuration and documentation.

Changing only the visible endpoint leaves the migration incomplete. Reconnect
clients that retain old metadata or tokens, then run `doctor` against the
public URL.

## Upstream failures

If `runtime-reached` is false, inspect the proxy, Supabase gateway, function
boot, or deployment before debugging capability registration. Confirm:

- the function name and URL;
- `verify_jwt = false` for the generated function;
- required environment variables and generated migrations;
- an available exact package import;
- local serving output or hosted function logs.

## Version truths

Four versions may differ legitimately:

1. the package or Deno import installed in the project;
2. the CLI that generated or inspects the scaffold;
3. the `packageVersion` attached to public documentation;
4. the runtime version observed from the deployed endpoint.

The installed types govern source changes. The response headers govern claims
about what is live.

## Upgrade coherently

When an upgrade is intended:

1. choose the exact target version;
2. update the npm dependency or Deno import;
3. run `npx chumbo skill update` for project-local guidance;
4. preserve `capabilities.ts`;
5. run generated checks and protocol tests;
6. deploy the intended function;
7. run `doctor` against the public URL;
8. reconnect clients only if endpoint or OAuth resource identity changed.

Do not upgrade merely to erase a harmless difference between projects. Do not
claim a deployed upgrade from source or lockfile changes alone.
