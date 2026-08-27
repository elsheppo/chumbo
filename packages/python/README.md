# Chumbo for Python

Inspect and diagnose a deployed Chumbo MCP endpoint from Python.

This package provides a small, typed inspection API and the
`chumbo-inspect` command. It verifies that an HTTP endpoint is running the
Chumbo runtime, reports the runtime's observed authentication mode, and checks
the corresponding MCP discovery boundary.

Chumbo's server runtime and guided setup remain TypeScript-first. They deploy
as a Supabase Edge Function through the npm `chumbo` package. This Python
package does not create or deploy a Chumbo server and does not claim runtime
parity with the TypeScript package.

## Install for local review

From this directory:

```sh
uv sync --locked
```

No third-party packages are required at runtime. Python 3.11 through 3.14 is
supported.

## Inspect an endpoint

```sh
uv run chumbo-inspect inspect \
  https://PROJECT_REF.supabase.co/functions/v1/mcp
```

Use JSON for CI or another program:

```sh
uv run chumbo-inspect inspect \
  https://PROJECT_REF.supabase.co/functions/v1/mcp \
  --json
```

For an authenticated discovery check, put the credential in an environment
variable. The command intentionally has no plaintext token argument:

```sh
CHUMBO_INSPECT_TOKEN="..." \
  uv run chumbo-inspect inspect \
  https://PROJECT_REF.supabase.co/functions/v1/mcp \
  --token-env CHUMBO_INSPECT_TOKEN
```

The credential is sent only to the exact endpoint being inspected. It is
never sent to OAuth metadata URLs and never appears in reports or errors.
Authenticated inspection requires HTTPS except for a local loopback endpoint.

The same command is available through the module entrypoint:

```sh
uv run python -m chumbo inspect https://example.com/functions/v1/mcp
```

The Python command is named `chumbo-inspect` so it does not shadow the npm
`chumbo` builder CLI.

## Use the library

```python
from chumbo import inspect_endpoint

report = inspect_endpoint(
    "https://PROJECT_REF.supabase.co/functions/v1/mcp",
    expected_auth="oauth",
)

print(report.observed_auth)
for check in report.checks:
    print(check.name, check.ok, check.detail)
```

`expected_auth` adds a comparison check. It never replaces or rewrites the
authentication mode observed from the deployed Chumbo runtime.

## What is checked

- Endpoint reachability without following redirects
- Chumbo runtime identity and version headers
- Observed authentication mode and strategy
- Advertised resource URL consistency
- Public `tools/list` discovery and generated rate-limit headers
- Protected authentication gates
- Chumbo's endpoint-local OAuth protected-resource metadata
- Authenticated `tools/list` discovery when a credential is supplied

Responses are size-bounded. Malformed protocol responses become failed checks
without including response bodies in public output.

## Development

```sh
uv sync --locked
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run pytest
uv build
```

The `LICENSE` file is an exact package-local copy of the repository's root MIT
license so both wheel and source distribution carry the license text.
