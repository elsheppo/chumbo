from __future__ import annotations

import json
import math
import re
import uuid
from collections.abc import Mapping
from contextlib import suppress
from dataclasses import dataclass
from ipaddress import ip_address
from typing import Literal, cast
from urllib.parse import SplitResult, urlsplit, urlunsplit

from ._http import HttpResponse, HttpTransport, StdlibTransport, TransportError
from ._version import __version__

AuthMode = Literal["oauth", "api-key", "bearer", "public", "multi"]

PROTOCOL_VERSION = "2026-07-28"
MAX_RESPONSE_BYTES = 1024 * 1024
_AUTH_MODES = frozenset({"oauth", "api-key", "bearer", "public", "multi"})
_AUTH_STRATEGIES = frozenset({"static", "verifier", "composed"})
_RUNTIME_VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$")
_CHALLENGE_METADATA = re.compile(
    r"resource_metadata=(?:\"([^\"]+)\"|([^,\s]+))", re.IGNORECASE
)


class InspectionConfigurationError(ValueError):
    """The inspection request is invalid before any network access."""


@dataclass(frozen=True, slots=True)
class Check:
    name: str
    ok: bool
    detail: str
    blocking: bool = True

    def to_dict(self) -> dict[str, object]:
        return {
            "name": self.name,
            "ok": self.ok,
            "detail": self.detail,
            "blocking": self.blocking,
        }


@dataclass(frozen=True, slots=True)
class InspectionReport:
    endpoint: str
    status_code: int | None
    runtime_version: str | None
    observed_auth: AuthMode | None
    auth_strategy: str | None
    resource_url: str | None
    checks: tuple[Check, ...]

    @property
    def ok(self) -> bool:
        return bool(self.checks) and all(
            check.ok or not check.blocking for check in self.checks
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "schemaVersion": 1,
            "status": "complete" if self.ok else "blocked",
            "endpoint": self.endpoint,
            "httpStatus": self.status_code,
            "runtimeVersion": self.runtime_version,
            "observedAuth": self.observed_auth,
            "authStrategy": self.auth_strategy,
            "resourceUrl": self.resource_url,
            "checks": [check.to_dict() for check in self.checks],
        }


def _safe_url(value: str, *, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise InspectionConfigurationError(f"{label} must be a non-empty URL.")
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise InspectionConfigurationError(f"{label} contains invalid characters.")
    try:
        parsed = urlsplit(value.strip())
        _ = parsed.port
    except ValueError:
        raise InspectionConfigurationError(f"{label} is not a valid URL.") from None
    if parsed.scheme.lower() not in {"http", "https"} or parsed.hostname is None:
        raise InspectionConfigurationError(f"{label} must use HTTP or HTTPS.")
    if parsed.username is not None or parsed.password is not None:
        raise InspectionConfigurationError(f"{label} must not include credentials.")
    if parsed.query or parsed.fragment:
        raise InspectionConfigurationError(
            f"{label} must not include a query string or fragment."
        )
    netloc = _normalized_netloc(parsed)
    path = parsed.path.rstrip("/")
    return urlunsplit((parsed.scheme.lower(), netloc, path, "", ""))


def _normalized_netloc(parsed: SplitResult) -> str:
    hostname = cast(str, parsed.hostname).lower()
    if ":" in hostname:
        hostname = f"[{hostname}]"
    port = parsed.port
    default_port = 443 if parsed.scheme.lower() == "https" else 80
    return (
        f"{hostname}:{port}" if port is not None and port != default_port else hostname
    )


def _origin(value: str) -> tuple[str, str, int]:
    parsed = urlsplit(value)
    default_port = 443 if parsed.scheme == "https" else 80
    return (
        parsed.scheme,
        cast(str, parsed.hostname).lower(),
        parsed.port or default_port,
    )


def _is_loopback_endpoint(value: str) -> bool:
    hostname = cast(str, urlsplit(value).hostname).lower()
    if hostname == "localhost":
        return True
    with suppress(ValueError):
        return ip_address(hostname).is_loopback
    return False


def _metadata_url(endpoint: str) -> str:
    return f"{endpoint}/.well-known/oauth-protected-resource"


def _header(headers: Mapping[str, str], current: str, legacy: str) -> str | None:
    return headers.get(current) or headers.get(legacy)


def _runtime_version(value: str | None) -> str | None:
    if value is None or len(value) > 80 or _RUNTIME_VERSION.fullmatch(value) is None:
        return None
    return value


def _auth_strategy(value: str | None) -> str | None:
    return value if value in _AUTH_STRATEGIES else None


def _request_body() -> bytes:
    return json.dumps(
        {
            "jsonrpc": "2.0",
            "id": str(uuid.uuid4()),
            "method": "tools/list",
            "params": {
                "_meta": {
                    "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
                    "io.modelcontextprotocol/clientInfo": {
                        "name": "chumbo-python-inspector",
                        "version": __version__,
                    },
                    "io.modelcontextprotocol/clientCapabilities": {},
                }
            },
        },
        separators=(",", ":"),
    ).encode()


def _json_object(response: HttpResponse) -> dict[str, object] | None:
    try:
        value = json.loads(response.body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return cast(dict[str, object], value) if isinstance(value, dict) else None


def _tools_list_ok(response: HttpResponse) -> bool:
    body = _json_object(response)
    if body is None or body.get("jsonrpc") != "2.0":
        return False
    result = body.get("result")
    return isinstance(result, dict) and isinstance(result.get("tools"), list)


def _challenge_metadata_url(value: str | None) -> str | None:
    if value is None:
        return None
    match = _CHALLENGE_METADATA.search(value)
    if match is None:
        return None
    return match.group(1) or match.group(2)


def _metadata_checks(
    endpoint: str,
    response: HttpResponse,
    *,
    transport: HttpTransport,
    timeout: float,
) -> list[Check]:
    checks: list[Check] = []
    advertised = _challenge_metadata_url(response.headers.get("www-authenticate"))
    expected = _metadata_url(endpoint)
    if advertised is None:
        return [Check("oauth-challenge", False, "Missing resource metadata URL.")]

    try:
        normalized = _safe_url(advertised, label="OAuth metadata URL")
    except InspectionConfigurationError:
        return [Check("oauth-challenge", False, "Invalid resource metadata URL.")]

    exact_origin = _origin(normalized) == _origin(endpoint)
    exact_path = normalized == expected
    checks.append(
        Check(
            "oauth-challenge",
            exact_origin and exact_path,
            "Endpoint-local resource metadata advertised."
            if exact_origin and exact_path
            else "Resource metadata URL is not the endpoint-local Chumbo URL.",
        )
    )
    if not exact_origin or not exact_path:
        return checks

    try:
        metadata_response = transport.request(
            normalized,
            method="GET",
            headers={"accept": "application/json"},
            body=None,
            timeout=timeout,
            max_bytes=MAX_RESPONSE_BYTES,
        )
    except TransportError:
        checks.append(
            Check(
                "protected-resource-metadata",
                False,
                "Resource metadata request failed.",
            )
        )
        return checks

    metadata = _json_object(metadata_response)
    resource = metadata.get("resource") if metadata is not None else None
    servers = metadata.get("authorization_servers") if metadata is not None else None
    valid = (
        200 <= metadata_response.status < 300
        and isinstance(resource, str)
        and isinstance(servers, list)
        and all(isinstance(server, str) for server in servers)
    )
    checks.append(
        Check(
            "protected-resource-metadata",
            valid,
            f"HTTP {metadata_response.status} with valid metadata."
            if valid
            else f"HTTP {metadata_response.status} with malformed metadata.",
        )
    )
    advertised_resource_ok = False
    if isinstance(resource, str):
        with suppress(InspectionConfigurationError):
            advertised_resource_ok = (
                _safe_url(resource, label="Advertised resource URL") == endpoint
            )
    checks.append(
        Check(
            "advertised-resource-url",
            advertised_resource_ok,
            "Advertised resource matches the inspected endpoint."
            if advertised_resource_ok
            else "Advertised resource does not match the inspected endpoint.",
        )
    )
    return checks


def inspect_endpoint(
    endpoint: str,
    *,
    token: str | None = None,
    expected_auth: AuthMode | None = None,
    timeout: float = 10.0,
    transport: HttpTransport | None = None,
) -> InspectionReport:
    """Inspect a deployed Chumbo endpoint without mutating it.

    Caller expectations are reported as a comparison check and never replace
    authentication data observed from the runtime.
    """

    normalized_endpoint = _safe_url(endpoint, label="Endpoint")
    if token is not None:
        if not token.strip():
            raise InspectionConfigurationError("Token must not be empty.")
        if any(ord(character) < 32 or ord(character) == 127 for character in token):
            raise InspectionConfigurationError("Token contains invalid characters.")
        if urlsplit(
            normalized_endpoint
        ).scheme != "https" and not _is_loopback_endpoint(normalized_endpoint):
            raise InspectionConfigurationError(
                "Credentials require HTTPS except on a loopback endpoint."
            )
    if expected_auth is not None and expected_auth not in _AUTH_MODES:
        raise InspectionConfigurationError("Expected auth mode is not supported.")
    if (
        not isinstance(timeout, int | float)
        or not math.isfinite(timeout)
        or timeout <= 0
    ):
        raise InspectionConfigurationError("Timeout must be a positive number.")

    client = transport or StdlibTransport()
    headers = {
        "accept": "application/json",
        "content-type": "application/json",
        "mcp-protocol-version": PROTOCOL_VERSION,
        "mcp-method": "tools/list",
    }
    if token is not None:
        headers["authorization"] = f"Bearer {token}"

    try:
        response = client.request(
            normalized_endpoint,
            method="POST",
            headers=headers,
            body=_request_body(),
            timeout=float(timeout),
            max_bytes=MAX_RESPONSE_BYTES,
        )
    except TransportError:
        return InspectionReport(
            endpoint=normalized_endpoint,
            status_code=None,
            runtime_version=None,
            observed_auth=None,
            auth_strategy=None,
            resource_url=None,
            checks=(Check("endpoint-reachable", False, "Endpoint request failed."),),
        )

    checks = [
        Check("endpoint-reachable", True, f"HTTP {response.status}."),
    ]
    if 300 <= response.status < 400:
        checks.append(Check("redirect-refused", False, "Endpoint returned a redirect."))

    normalized_headers = {
        str(name).lower(): str(value) for name, value in response.headers.items()
    }
    response = HttpResponse(response.status, normalized_headers, response.body)
    raw_runtime_version = _header(
        response.headers, "x-chumbo-version", "x-supa-mcp-version"
    )
    runtime_version = _runtime_version(raw_runtime_version)
    raw_auth = _header(response.headers, "x-chumbo-auth-mode", "x-supa-mcp-auth-mode")
    observed_auth = cast(AuthMode, raw_auth) if raw_auth in _AUTH_MODES else None
    auth_strategy = _auth_strategy(
        _header(
            response.headers,
            "x-chumbo-auth-strategy",
            "x-supa-mcp-auth-strategy",
        )
    )
    raw_resource_url = _header(
        response.headers, "x-chumbo-resource-url", "x-supa-mcp-resource-url"
    )
    resource_url: str | None = None
    if raw_resource_url is not None:
        with suppress(InspectionConfigurationError):
            candidate_resource_url = _safe_url(
                raw_resource_url, label="Runtime resource URL"
            )
            if candidate_resource_url == normalized_endpoint:
                resource_url = candidate_resource_url

    checks.append(
        Check(
            "runtime-reached",
            runtime_version is not None,
            f"Chumbo {runtime_version}."
            if runtime_version is not None
            else (
                "Response did not identify the Chumbo runtime."
                if raw_runtime_version is None
                else "Runtime version header was malformed."
            ),
        )
    )
    checks.append(
        Check(
            "observed-auth-mode",
            observed_auth is not None,
            observed_auth or "Runtime did not advertise a recognized auth mode.",
        )
    )
    if expected_auth is not None:
        matches = observed_auth == expected_auth
        checks.append(
            Check(
                "expected-auth-mode",
                matches,
                "Observed auth matches the expected mode."
                if matches
                else "Observed auth does not match the expected mode.",
            )
        )

    resource_matches = False
    if resource_url is not None:
        resource_matches = resource_url == normalized_endpoint
    checks.append(
        Check(
            "runtime-resource-url",
            resource_matches,
            "Runtime resource matches the inspected endpoint."
            if resource_matches
            else "Runtime resource does not match the inspected endpoint.",
        )
    )

    if response.status == 200:
        discovery_ok = _tools_list_ok(response)
        checks.append(
            Check(
                "tools-list",
                discovery_ok,
                "MCP tools discovery succeeded."
                if discovery_ok
                else "MCP tools discovery response was malformed.",
            )
        )
        if observed_auth == "public":
            raw_limit = response.headers.get("x-ratelimit-limit")
            try:
                limit = int(raw_limit) if raw_limit is not None else None
            except ValueError:
                limit = None
            checks.append(
                Check(
                    "public-rate-limit",
                    limit is not None and limit > 0,
                    f"{limit} requests per window."
                    if limit is not None and limit > 0
                    else "Missing public rate-limit header.",
                )
            )
    elif response.status == 401 and observed_auth in {
        "oauth",
        "api-key",
        "bearer",
        "multi",
    }:
        checks.append(
            Check(
                "protected-auth-gate",
                token is None,
                "Protected endpoint rejected an unauthenticated request."
                if token is None
                else "Supplied credential was rejected.",
            )
        )
        if token is None and observed_auth in {"oauth", "multi"}:
            checks.extend(
                _metadata_checks(
                    normalized_endpoint,
                    response,
                    transport=client,
                    timeout=float(timeout),
                )
            )
    else:
        checks.append(
            Check(
                "tools-list",
                False,
                f"Unexpected HTTP {response.status} from tools discovery.",
            )
        )

    return InspectionReport(
        endpoint=normalized_endpoint,
        status_code=response.status,
        runtime_version=runtime_version,
        observed_auth=observed_auth,
        auth_strategy=auth_strategy,
        resource_url=resource_url,
        checks=tuple(checks),
    )
