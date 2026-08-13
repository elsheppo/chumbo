# Build Log

> **Feature**: `create-supabase-mcp` v0.1 — a generated, end-user-facing MCP server for existing Supabase apps
> **Spec**: `SPEC.md`
> **Success metric**: installable package and CLI, generated Edge Function, OAuth discovery, user JWT/RLS isolation, MCP tools/resources/prompts/elicitation, clean-project proof, cloud proof, and public release

---

## Iteration 0: Experiment baseline

**State**: The MJX spike proved that MCP Streamable HTTP can run inside a Supabase Edge Function and that the WASM graph engine can execute there. The result was experiment code and findings, not a reusable builder package.
**Slices remaining**: runtime API, generator CLI, auth/RLS membrane, MCP capability examples, tests, cloud proof, packaging, publication.
**Next**: Extract the smallest stable runtime and scaffold into a standalone package.

---

## Iteration 1: Runtime and generator

**Changes**:

- Added a pinned TypeScript runtime around the official MCP and Supabase server packages.
- Added `init`, `doctor`, and `dev` commands plus conflict-safe templates.
- Added OAuth, bearer, and explicit public auth modes without an admin client.

**Result**: Typecheck and 12 protocol/unit tests pass. The generated Edge Function typechecks, boots, serves MCP, and passes its generated test.
**Diagnosis**: The package boundary works; the remaining high-risk claim was whether concurrent user-scoped clients truly preserve RLS isolation.
**Next**:

- Exercise the runtime against real Supabase Auth and Postgres RLS with multiple users.

---

## Iteration 2: Real RLS isolation

**Changes**:

- Added a namespaced multi-tenant schema and deterministic Alice/Bob fixtures.
- Added concurrent positive and negative tenant-read assertions through user-scoped clients.
- Added explicit Data API grants required by the example schema.

**Result**: 1/1 integration test passes against the local Supabase stack; Alice and Bob see only their own organization rows under concurrency. Supabase DB advisors report no warnings or errors.
**Diagnosis**: The core end-user authorization claim is real. Release risk has moved to generated OAuth/consent behavior and live cloud topology.
**Next**:

- Make `doctor` prove unauthenticated OAuth discovery and authenticated MCP access together.
- Typecheck the optional consent scaffold, then run the complete package gate.

---

## Iteration 3: Release-edge hardening

**Changes**:

- Updated `doctor` to probe the OAuth challenge and protected-resource metadata before an authenticated `tools/list`.
- Handled the already-consented OAuth response and disabled implicit browser redirects in the consent scaffold.
- Added the consent function to generated-project typechecking and externalized Node built-ins in the neutral bundle.

**Result**: The full package gate passes: TypeScript typecheck, 12 protocol/unit tests, warning-free ESM build, generated MCP Deno typecheck/test, generated consent-function Deno typecheck, and local doctor.
**Diagnosis**: Source and generated-project behavior are stable. The remaining release risks are tarball completeness, clean install behavior, and the deployed Supabase OAuth path.
**Next**:

- Inspect and install the exact npm tarball from a clean temporary project.
- Deploy the generated function and prove discovery plus authenticated MCP access in the prototype cloud project.

---

## Iteration 4: Exact tarball and Edge entrypoint

**Changes**:

- Packed the exact npm artifact and installed it into an empty consumer project.
- Ran the installed CLI and imported the installed runtime for a real MCP `tools/list` exchange.
- Added guarded `Deno.serve` startup to the MCP and consent templates after cloud-oriented inspection exposed that handler-only modules would not listen in Supabase Edge Runtime.

**Result**: The 27 KB tarball contains only the intended runtime, CLI, templates, docs, and license. Clean install, generation, doctor, runtime import, and `tools/list` pass. The Edge startup fix is pending the full gate and live deployment.
**Diagnosis**: Package distribution is sound, and the first cloud review prevented a test-only false positive. Supabase OAuth Server is currently disabled on the prototype project, so discovery cannot succeed until project configuration is enabled.
**Next**:

- Re-run the full gate with the actual Edge startup path.
- Deploy the vendored build artifact through the connected Supabase project and smoke it before publication.

---

## Iteration 5: Hosted gateway route normalization

**Changes**:

- Deployed the built runtime as an isolated cloud smoke function with gateway JWT verification disabled.
- Confirmed the live MCP 401 challenge and captured Supabase Edge Runtime's forwarded request URL.
- Updated metadata routing for the hosted gateway, which strips `/functions/v1` from the URL before invoking the function.

**Result**: The live function starts and emits a correct function-local OAuth challenge. Before the fix, the advertised metadata URL reached the function but was misclassified as an MCP call because its internal pathname was `/FUNCTION/.well-known/...` rather than the public `/functions/v1/FUNCTION/.well-known/...` path.
**Diagnosis**: Function-local metadata is architecturally viable; the runtime needed a platform normalization rule that source-only tests could not reveal. Supabase OAuth Server remains disabled, so metadata will return the expected upstream failure until enabled.
**Next**:

- Add the rewritten hosted path to protocol tests, rebuild, redeploy, and verify the metadata route reaches the OAuth upstream.

---

## Iteration 6: Release-candidate proof

**Changes**:

- Promoted the cloud-discovered route and Edge startup fixes into the standalone repository.
- Exercised the exact package from its real repository, including a frozen install, generated-project gates, local Supabase RLS concurrency, and an installed-tarball consumer.
- Updated the optional consent scaffold to read Supabase's hosted publishable-key dictionary as well as the local CLI and legacy single-key environments.

**Result**: The release gate passes with 18 unit/protocol tests plus the Alice/Bob RLS integration test. Local database advisors report no issues. The 28,069-byte tarball contains 21 intended files; its installed CLI, `doctor`, Node runtime, MCP `tools/list` exchange, and generated consent-function typecheck all pass from an empty consumer project. The generated public-package Deno import correctly remains unavailable until `create-supabase-mcp@0.1.0` exists on npm.
**Diagnosis**: Code, generated output, tenant isolation, and package composition have reached the v0.1 plateau. The remaining work is external release state: enable and exercise Supabase OAuth, authenticate the GitHub and npm publishers, then rerun the post-publication Deno quickstart.
**Next**:

- Commit the standalone release candidate.
- Complete the live OAuth authorization-code flow through an independent MCP client.
- Publish GitHub and npm releases and verify the public quickstart.
