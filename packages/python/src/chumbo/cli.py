from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Sequence

from ._version import __version__
from .inspection import InspectionConfigurationError, inspect_endpoint


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="chumbo-inspect",
        description="Inspect a deployed Chumbo MCP endpoint.",
    )
    parser.add_argument("--version", action="version", version=__version__)
    commands = parser.add_subparsers(dest="command", required=True)
    inspect = commands.add_parser("inspect", help="Inspect one endpoint")
    inspect.add_argument("endpoint")
    inspect.add_argument(
        "--auth",
        dest="expected_auth",
        choices=["oauth", "api-key", "bearer", "public", "multi"],
        help="Expected auth mode to compare with observed runtime truth",
    )
    inspect.add_argument(
        "--token-env",
        metavar="NAME",
        help="Read the endpoint credential from this environment variable",
    )
    inspect.add_argument("--timeout", type=float, default=10.0)
    inspect.add_argument("--json", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    token: str | None = None
    if args.token_env is not None:
        token = os.environ.get(args.token_env)
        if token is None:
            print("error: token environment variable is not set.", file=sys.stderr)
            return 2

    try:
        report = inspect_endpoint(
            args.endpoint,
            token=token,
            expected_auth=args.expected_auth,
            timeout=args.timeout,
        )
    except InspectionConfigurationError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    if args.json:
        print(json.dumps(report.to_dict(), separators=(",", ":"), sort_keys=True))
    else:
        for check in report.checks:
            marker = "✓" if check.ok else "!" if not check.blocking else "✗"
            print(f"{marker} {check.name}: {check.detail}")
    return 0 if report.ok else 1
