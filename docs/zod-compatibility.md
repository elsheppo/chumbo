# Zod compatibility and browser size

Chumbo uses Zod to construct collection schemas and accepts application schemas
in those helpers. An exact runtime dependency can install a different Zod beside
the application's version, making these schema types incompatible. Zod is
therefore a required peer dependency with range `^4.2.0`, matching the minimum
required by the MCP server SDK. This follows the
[Zod library-author guidance](https://zod.dev/library-authors).

The host supplies Zod 4.2 or newer within major version 4. The development
version remains exactly 4.6.7 in `devDependencies` and the pnpm lockfile. A
required peer also allows package managers with automatic peer installation to
install Chumbo's CLI without a separate setup step.

`pnpm test:zod-consumers` installs an actual npm tarball in temporary npm and
pnpm projects with Zod 4.2.0 and 4.6.7. It verifies that Chumbo resolves the
application's Zod, checks the public declarations with `skipLibCheck: false`,
and exercises collection schema composition, inferred handler arguments,
MCP discovery, a valid invocation, and rejection of invalid input. SDK
transitive dependencies may resolve another compatible Zod; this test verifies
interoperability rather than assuming global deduplication.

The generated Edge Function import map and `supabase/deno.reference.json` use
the exact development version. `pnpm release:check` rejects drift between them.
The latter imports the local source package and is the configuration used by
`pnpm reference:check`. The other reference import maps and their lockfiles
remain attached to the historical published package recorded in
`docs/deployment/hosted-reference.json`; changing them would change a separate
deployment contract.

## Review-queue browser bundle

With Vite 8.2.2, MCP Apps 1.7.5, and otherwise identical application code, the
single-file HTML measurements were:

| Zod   | Locales | HTML bytes | Gzip (rounded) |
| ----- | ------- | ---------: | -------------: |
| 4.2.0 | All     |    325,772 |       78.52 kB |
| 4.6.7 | All     |    459,275 |      112.65 kB |
| 4.6.7 | English |    266,099 |       74.57 kB |

Vite's rendered-module accounting showed unchanged MCP SDK and application
code. Zod's schema and JSON Schema code grew, its compiler contributed a new
55,264 rendered bytes before minification, and its locale modules grew from
182,163 to 260,041 rendered bytes. These module totals precede minification and
are not final HTML size contributions.

The SDK retains the Zod locale namespace, so ordinary tree shaking retains all
translations. The review-queue app is English-only. Its Vite configuration
replaces the resolved Zod locale barrel with an English-only export during this
app's build. It keeps the real English locale and Zod validation implementation;
it does not alter Chumbo's package, server behavior, or consumers' bundlers.
Supporting another UI language requires adding that locale to the build export.

`pnpm reference:app` enforces the original `<400000` byte HTML budget after
JavaScript and CSS have been inlined. It also runs in `pnpm check`, so a size
regression fails without starting Supabase. The integration assertion remains
as a check on the HTML actually returned over MCP Resources.

To validate a dependency upgrade:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm format:check
pnpm reference:check
```

Review the `reference:app` byte/gzip output and the consumer matrix alongside
functional results. A passing version matrix is evidence for the tested
versions, not a guarantee about every future release in the peer range.
