# Supa MCP Build Record

Date: 2026-08-13
Release target: `supa-mcp@0.1.0`

## Product boundary

Supa MCP turns an existing Supabase application into an end-user MCP server.
It is not the official Supabase management MCP and does not introduce another
identity, tenant, or authorization model.

The generated Edge Function composes the official MCP server package with
Supabase Auth and request-scoped Supabase clients. Application grants and RLS
remain authoritative.

## Free release capability

- Guided, resumable setup for humans and a stable JSON interface for agents.
- OAuth, existing bearer-token, and explicitly public access modes.
- Postgres-backed per-caller rate limiting for public endpoints.
- Application-owned capability scopes without an imposed role schema.
- Tools, resources, prompts, structured results, and a multi-round-trip input
  example through the official MCP registration API.
- Local checks, deployment orchestration, setup status, and auth-aware remote
  diagnostics.
- Request isolation and negative two-user RLS coverage.
- Clean client-facing MCP URLs with an independent Supabase OAuth issuer.

## Clean URL architecture

The Supabase function URL remains the upstream runtime location. Generated
functions use `MCP_PUBLIC_URL` as the protected-resource identity when set and
explicitly use `${SUPABASE_URL}/auth/v1` as the OAuth issuer.

An application route or edge proxy forwards the public MCP path and its suffix
routes to the function:

```text
https://yourapp.com/mcp
https://yourapp.com/mcp/.well-known/oauth-protected-resource
https://yourapp.com/mcp/.well-known/oauth-authorization-server
                         |
                         v
https://PROJECT_REF.supabase.co/functions/v1/mcp[/...]
```

`doctor` verifies that protected-resource discovery advertises the public URL,
so a proxy that merely hides the upstream address cannot produce a false pass.

## Evidence at release candidate

- TypeScript typecheck passed.
- 32 unit and protocol tests passed; the credentialed RLS integration suite is
  optional in ordinary CI.
- The generated OAuth and public projects typechecked and passed their Deno
  contract tests.
- The generated consent function typechecked under Deno.
- The exact npm dry-run contained 24 intended files, 53,941 packed bytes, and
  199,347 unpacked bytes; private strategy notes and repository-only material
  were absent.

## Private direction

The Supabase-connected MCP professionalization and maintenance concept is
recorded locally in `.private/cloud-product-spec.md`. `.private/` is ignored so
the commercial direction is not published in the open-source repository or npm
artifact.
