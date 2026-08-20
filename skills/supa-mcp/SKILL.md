---
name: supa-mcp
description: Design, implement, review, and test end-user-facing MCP capabilities in Supabase Edge Functions using Supa MCP. Use when translating application operations into tools, Resources, prompts, auth-aware capability surfaces, result contracts, or protocol-level tests. Not for administering Supabase projects.
---

# Supa MCP capability design

Build an MCP surface that expresses the application's real operations and
preserves its existing authority model. Supa MCP owns the protocol and
request-context boundary; the application still owns its capabilities, data
contracts, identities, scopes, and authorization.

## Work from the application inward

Before changing code, inspect the product operation, existing Edge Functions or
APIs, schema, grants, RLS policies, authentication, installed `supa-mcp`
version, and current capability tests. Do not infer a tool surface from table
names alone.

For each proposed capability, state:

- the actor and their intent;
- the authority required;
- the observable application outcome;
- the smallest facts the next reasoning step needs.

Then choose the MCP primitive and result contract deliberately. Read
[capability and tool boundaries](references/capability-and-tool-boundaries.md)
when adding or reorganizing capabilities. Read
[result contracts and Resources](references/result-contracts-and-resources.md)
whenever a tool returns data or a complete document.

## Preserve authority

- Derive caller identity, ownership, and scopes from the verified request
  context, never tool arguments.
- OAuth and bearer handlers query through the request-scoped `ctx.supabase`
  client so the caller's grants and RLS remain effective.
- Application API keys create application principals; they do not become
  fictional Supabase users. Their handlers need the application's existing
  narrow data-plane authority.
- Never expose a service-role or verifier-only admin client to MCP handlers.
- Use `server.withScopes(...)` to remove restricted tools, Resources, and
  prompts from unauthorized discovery. Keep RLS, grants, or the existing API as
  the data-plane boundary against bypasses.
- Public mode retains its generated Postgres-backed rate limit.

Read [identity, scopes, and RLS](references/identity-scopes-and-rls.md) when
authentication, privileged capabilities, multiple identities, or mutations are
involved.

## Use explicit result contracts

- `textResult` is for model-facing text without manufactured structure.
- `structuredResult` is for a real typed consumer and requires an exact
  `outputSchema`.
- `renderResult` is an intentional hybrid and requires an exact
  `outputSchema`; its text interprets or compresses the data instead of
  serializing it again.
- `resourceResult` returns a concise reading card and link. Register the full
  body as an MCP Resource and serve it only through `resources/read`.
- `errorResult` should name a useful next step when recovery exists.

Structure is builder-owned application design, not a mirror of a database row.
Preserve useful identifiers and omit internal columns by default. Recommend a
next tool only when it is genuinely the next useful action; do not manufacture
a tool ontology.

## Prove the real boundary

Compilation is not completion. Exercise discovery and invocation through the
MCP transport, including unauthorized identities and direct calls to hidden
capabilities. For identity-sensitive work, prove row isolation with distinct
real callers and verify that failed authentication cannot fall through to a
different strategy.

Read [testing and completion](references/testing-and-completion.md) before
claiming the capability is finished. Use
[production contrasts](references/production-contrasts.md) when reviewing a
surface or correcting an implementation that technically works but exposes the
wrong abstraction.

## Current package behavior

The project's installed dependency and types are the runtime truth. When an API
detail is uncertain and the public Supa MCP docs MCP is configured and
reachable, query
`https://dxrpeagddrpbezbkgvdv.supabase.co/functions/v1/docs-mcp`: search first,
then read the linked Resource and inspect its `packageVersion` metadata. Do not
apply an API documented by a newer version unless upgrading the project is in
scope. If the docs MCP is unavailable, continue from installed exports and
project documentation. Do not invent package APIs from this skill or replace
current Supa MCP documentation with general Supabase documentation.
