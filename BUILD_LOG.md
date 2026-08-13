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

---

## Iteration 7: Public repository

**Changes**:

- Created the public `elsheppo/create-supabase-mcp` repository using the existing macOS Git credential.
- Pushed the release-candidate commit to `main` with plain Git.
- Observed the first public GitHub Actions run against the exact pushed SHA.

**Result**: `main` is public at `https://github.com/elsheppo/create-supabase-mcp`, tracks `origin/main`, and CI passed on `501f541ef12a9812a0bfde1afecbe86e97e1c281`.
**Diagnosis**: Source publication is complete. Supabase OAuth configuration still requires an authenticated Dashboard or Management API session, and npm publication requires an authenticated npm publisher session.
**Next**:

- Enable cloud OAuth and complete the independent-client authorization flow.
- Publish `create-supabase-mcp@0.1.0`, tag the matching Git commit, and run the public-package Deno quickstart.

---

## Iteration 8: npm publication

**Changes**:

- Authenticated the npm CLI as `elsheppo` and published the exact release-candidate artifact with public access and the `latest` tag.

**Result**: `create-supabase-mcp@0.1.0` is public on npm. The registry reports 21 files, a 94,126-byte unpacked size, SHA-1 `394de2151a0635498aebc0c0fd744337d39538f8`, and SHA-512 integrity `TvsF/b2RaczyJy4zV21GMQBtOGcc1JfWOc8FVW/4e2EL0HTXnDqa32Oom9MkUn8GGBMJXHhLJQzFOoYbaTOQbw==`, matching the locally proven tarball.
**Diagnosis**: Package publication is complete. npm's registry view normalizes the CLI bin path for display, but the published artifact records `gitHead` `c332467f9e33eff1a6078be5c7c8074e1eb0954d`; the Git release must tag that exact source commit. The remaining release proof is installation and Deno resolution from the public registry. The separate hosted OAuth authorization-code flow still depends on enabling OAuth Server in the Supabase Dashboard.
**Next**:

- Install from npm in a clean project and run the complete generated Deno checks.
- Tag and publish the GitHub `v0.1.0` release.
- Enable hosted Supabase OAuth and complete the independent-client PKCE flow.

### Public-registry follow-up

The clean npm install exposed a generated-test defect hidden by the repository smoke harness: `deno task test` failed unless the caller supplied `SUPABASE_URL`, even though the generated README presented it as a direct command. The scaffold now installs a local test URL before dynamically importing the function, and the smoke harness no longer injects the variable externally. This fix ships as `0.1.1`; `0.1.0` remains the immutable initial artifact, while `0.1.1` is the release tag and `latest` plateau.

The second blank-project install pulled `0.1.1` from the public registry, generated both Edge Functions, passed `doctor`, resolved the public npm import under Deno, passed `deno task check`, passed the generated OAuth-challenge test, and typechecked the consent function. The public-package quickstart is verified.

---

## Iteration 9: Progressive access ladder

**Changes**:

- Kept OAuth plus request-scoped RLS as the unchanged starter path.
- Added optional application-resolved scopes, `ctx.hasScope()`, and
  `server.withScopes()` across tools, resources, prompts, and resource
  templates.
- Added deliberately narrow public scopes without inventing a role,
  organization, membership, or entitlement schema.
- Added an opt-in Postgres fixed-window limiter backed by one counter per
  caller/window, standard `429` retry headers, and fail-closed behavior.
- Made the initializer enable that limiter and generate its migration only
  when a builder explicitly selects public mode.

**Design result**: The capability ladder lives behind optional surfaces. The
default generated function and capability file remain unchanged; authenticated
projects receive no new database objects or setup. Public builders get a
guardrail without choosing a rate-limit provider, while experienced builders
can resolve scopes from their own Supabase tables.

**Boundary**: Supabase OAuth currently supplies standard identity scopes rather
than arbitrary application permissions. Application scopes therefore resolve
inside the resource server today. Standards-native OAuth step-up remains a
separate future cut instead of being simulated by the library.

**Verification**: The package gate passes with 26 runtime/generator tests and
both OAuth and public generated-project Deno checks. The migration was applied
twice in one local Supabase Postgres transaction, proving idempotency; `anon`
and `authenticated` had no execute privilege, while `service_role` received an
allow on the first request and a denial above the configured limit. The entire
database probe rolled back.

---

## Iteration 10: Guided human and agent onboarding

**Problem**: The published package had good installation primitives but no
actual wizard. `init` made files and printed three commands. Agents had to
parse prose, could hang at a confirmation prompt, and had no durable vocabulary
for a multi-step setup that crosses local generation, migrations, deployment,
Supabase Dashboard configuration, and remote verification.

**Changes**:

- Added `setup` as a thin conductor over the existing conflict-safe generator.
- Added a plain-language interactive access choice while preserving flags for
  every consequential decision.
- Added `--plan`, `--resume`, `--apply-migrations`, `--deploy`,
  `--project-ref`, `--skip-checks`, and a non-interactive `--json` contract.
- Added versioned reports with stable step IDs, explicit `ready`,
  `needs_user_action`, and `blocked` states, exact commands, and no secrets.
- Added read-only `status` and made remote doctor probes auth-aware across
  OAuth, bearer, and public modes.
- Made resume derive truth from generated files, linked-project state, and the
  endpoint instead of persisting an opaque installer state file.

**Design result**: A first-time builder can run one short wizard. An agent can
plan, apply, stop for a real Dashboard action, and resume without guessing from
terminal text. `init` remains available as the small deterministic primitive;
the onboarding layer does not invade the runtime library.

**Boundary**: Migration and deployment mutations are never implied by JSON or
resume. Public deployment pauses unless `--apply-migrations` is explicit,
because `supabase db push` may include unrelated pending application
migrations. OAuth Dashboard work remains a named user action rather than fake
automation.
