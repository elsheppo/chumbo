from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field

import pytest

from chumbo import InspectionConfigurationError, inspect_endpoint
from chumbo._http import HttpResponse, TransportError

ENDPOINT = "https://project.supabase.co/functions/v1/mcp"
METADATA_URL = f"{ENDPOINT}/.well-known/oauth-protected-resource"


def response(
    status: int,
    *,
    auth: str = "public",
    body: object | bytes | None = None,
    headers: Mapping[str, str] | None = None,
) -> HttpResponse:
    payload = (
        body
        if isinstance(body, bytes)
        else json.dumps(
            body
            if body is not None
            else {"jsonrpc": "2.0", "id": "test", "result": {"tools": []}}
        ).encode()
    )
    base = {
        "x-chumbo-version": "0.8.0",
        "x-chumbo-auth-mode": auth,
        "x-chumbo-resource-url": ENDPOINT,
    }
    base.update(headers or {})
    return HttpResponse(status, base, payload)


@dataclass
class FakeTransport:
    responses: list[HttpResponse | Exception]
    requests: list[dict[str, object]] = field(default_factory=list)

    def request(
        self,
        url: str,
        *,
        method: str,
        headers: Mapping[str, str],
        body: bytes | None,
        timeout: float,
        max_bytes: int,
    ) -> HttpResponse:
        self.requests.append(
            {
                "url": url,
                "method": method,
                "headers": dict(headers),
                "body": body,
                "timeout": timeout,
                "max_bytes": max_bytes,
            }
        )
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def check(report: object, name: str) -> object:
    return next(item for item in report.checks if item.name == name)


def test_public_endpoint_reports_runtime_and_discovery() -> None:
    transport = FakeTransport([response(200, headers={"x-ratelimit-limit": "60"})])

    report = inspect_endpoint(ENDPOINT, expected_auth="public", transport=transport)

    assert report.ok
    assert report.runtime_version == "0.8.0"
    assert report.observed_auth == "public"
    assert report.resource_url == ENDPOINT
    assert check(report, "tools-list").ok
    assert check(report, "public-rate-limit").ok
    request = transport.requests[0]
    assert request["method"] == "POST"
    assert request["headers"]["mcp-method"] == "tools/list"
    assert json.loads(request["body"])["method"] == "tools/list"


def test_expected_auth_never_overwrites_observed_auth() -> None:
    transport = FakeTransport(
        [response(200, auth="public", headers={"x-ratelimit-limit": "60"})]
    )

    report = inspect_endpoint(ENDPOINT, expected_auth="oauth", transport=transport)

    assert report.observed_auth == "public"
    assert not check(report, "expected-auth-mode").ok
    assert not report.ok


def test_api_key_gate_is_a_successful_unauthenticated_inspection() -> None:
    transport = FakeTransport(
        [
            response(
                401,
                auth="api-key",
                headers={"x-chumbo-auth-strategy": "verifier"},
            )
        ]
    )

    report = inspect_endpoint(ENDPOINT, transport=transport)

    assert report.ok
    assert report.observed_auth == "api-key"
    assert report.auth_strategy == "verifier"
    assert check(report, "protected-auth-gate").ok


def test_oauth_gate_fetches_only_exact_endpoint_metadata_without_token() -> None:
    challenge = response(
        401,
        auth="oauth",
        headers={"www-authenticate": f'Bearer resource_metadata="{METADATA_URL}"'},
    )
    metadata = HttpResponse(
        200,
        {"content-type": "application/json"},
        json.dumps(
            {
                "resource": ENDPOINT,
                "authorization_servers": ["https://project.supabase.co/auth/v1"],
            }
        ).encode(),
    )
    transport = FakeTransport([challenge, metadata])

    report = inspect_endpoint(ENDPOINT, expected_auth="oauth", transport=transport)

    assert report.ok
    assert [request["url"] for request in transport.requests] == [
        ENDPOINT,
        METADATA_URL,
    ]
    assert "authorization" not in transport.requests[1]["headers"]
    assert check(report, "protected-resource-metadata").ok
    assert check(report, "advertised-resource-url").ok


@pytest.mark.parametrize(
    "advertised",
    [
        "https://attacker.example/metadata",
        "http://project.supabase.co/functions/v1/mcp/.well-known/oauth-protected-resource",
        "https://project.supabase.co:444/functions/v1/mcp/.well-known/oauth-protected-resource",
        f"{ENDPOINT}/wrong-path",
    ],
)
def test_oauth_metadata_must_match_exact_origin_and_chumbo_path(
    advertised: str,
) -> None:
    transport = FakeTransport(
        [
            response(
                401,
                auth="oauth",
                headers={
                    "www-authenticate": f'Bearer resource_metadata="{advertised}"'
                },
            )
        ]
    )

    report = inspect_endpoint(ENDPOINT, transport=transport)

    assert not report.ok
    assert not check(report, "oauth-challenge").ok
    assert len(transport.requests) == 1


def test_authenticated_discovery_sends_token_only_to_endpoint() -> None:
    secret = "super-secret-token"
    transport = FakeTransport([response(200, auth="bearer")])

    report = inspect_endpoint(ENDPOINT, token=secret, transport=transport)

    assert report.ok
    assert transport.requests[0]["headers"]["authorization"] == f"Bearer {secret}"
    public_text = repr(report) + json.dumps(report.to_dict())
    assert secret not in public_text


def test_rejected_token_is_never_reported() -> None:
    secret = "rejected-secret-token"
    transport = FakeTransport([response(401, auth="bearer")])

    report = inspect_endpoint(ENDPOINT, token=secret, transport=transport)

    assert not report.ok
    assert not check(report, "protected-auth-gate").ok
    assert secret not in repr(report)
    assert secret not in json.dumps(report.to_dict())


def test_transport_error_message_cannot_leak_token() -> None:
    secret = "transport-secret-token"
    transport = FakeTransport([TransportError(f"request failed with {secret}")])

    report = inspect_endpoint(ENDPOINT, token=secret, transport=transport)

    assert not report.ok
    assert secret not in repr(report)
    assert secret not in json.dumps(report.to_dict())


def test_untrusted_headers_cannot_leak_token() -> None:
    secret = "header-secret-token"
    transport = FakeTransport(
        [
            HttpResponse(
                500,
                {
                    "x-chumbo-version": secret,
                    "x-chumbo-auth-mode": secret,
                    "x-chumbo-auth-strategy": secret,
                    "x-chumbo-resource-url": f"https://example.com/{secret}",
                    "x-ratelimit-limit": secret,
                },
                secret.encode(),
            )
        ]
    )

    report = inspect_endpoint(ENDPOINT, token=secret, transport=transport)

    output = repr(report) + json.dumps(report.to_dict())
    assert secret not in output
    assert report.runtime_version is None
    assert report.auth_strategy is None
    assert report.resource_url is None


@pytest.mark.parametrize(
    "endpoint",
    [
        "",
        "ftp://example.com/mcp",
        "https://user:password@example.com/mcp",
        "https://example.com/mcp?token=secret",
        "https://example.com/mcp#fragment",
        "https://example.com:invalid/mcp",
        "https://example.com/mcp\nheader",
    ],
)
def test_malformed_endpoint_is_rejected_before_transport(endpoint: str) -> None:
    transport = FakeTransport([])

    with pytest.raises(InspectionConfigurationError):
        inspect_endpoint(endpoint, transport=transport)

    assert transport.requests == []


def test_invalid_input_exception_is_token_free() -> None:
    secret = "url-secret-token"

    with pytest.raises(InspectionConfigurationError) as caught:
        inspect_endpoint(f"https://user:{secret}@example.com/mcp", token=secret)

    assert secret not in str(caught.value)
    assert secret not in repr(caught.value)


def test_token_requires_https_except_for_loopback() -> None:
    transport = FakeTransport([])

    with pytest.raises(InspectionConfigurationError, match="HTTPS"):
        inspect_endpoint(
            "http://example.com/mcp", token="long-enough-secret", transport=transport
        )

    assert transport.requests == []


@pytest.mark.parametrize(
    "endpoint",
    ["http://localhost:8080/mcp", "http://127.0.0.1:8080/mcp", "http://[::1]:8080/mcp"],
)
def test_loopback_allows_local_authenticated_inspection(endpoint: str) -> None:
    transport = FakeTransport([response(200, auth="bearer")])

    inspect_endpoint(endpoint, token="local-development-secret", transport=transport)

    assert transport.requests[0]["headers"]["authorization"] == (
        "Bearer local-development-secret"
    )


def test_token_control_characters_are_rejected_before_transport() -> None:
    transport = FakeTransport([])

    with pytest.raises(InspectionConfigurationError, match="invalid characters"):
        inspect_endpoint(ENDPOINT, token="secret\nheader", transport=transport)

    assert transport.requests == []


@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        json.dumps([]).encode(),
        json.dumps({"jsonrpc": "2.0", "result": {}}).encode(),
        json.dumps({"jsonrpc": "1.0", "result": {"tools": []}}).encode(),
    ],
)
def test_malformed_protocol_response_is_a_failed_check(body: bytes) -> None:
    transport = FakeTransport(
        [response(200, body=body, headers={"x-ratelimit-limit": "60"})]
    )

    report = inspect_endpoint(ENDPOINT, transport=transport)

    assert not report.ok
    assert not check(report, "tools-list").ok


def test_http_failure_is_reported_without_response_body() -> None:
    secret = "upstream-secret"
    transport = FakeTransport([response(503, body=secret.encode())])

    report = inspect_endpoint(ENDPOINT, transport=transport)

    output = repr(report) + json.dumps(report.to_dict())
    assert not report.ok
    assert secret not in output
    assert "HTTP 503" in check(report, "tools-list").detail


def test_redirect_is_not_followed() -> None:
    transport = FakeTransport(
        [response(307, headers={"location": "https://attacker.example/mcp"})]
    )

    report = inspect_endpoint(ENDPOINT, transport=transport)

    assert not report.ok
    assert not check(report, "redirect-refused").ok
    assert len(transport.requests) == 1


def test_malformed_oauth_metadata_fails_without_raw_body() -> None:
    secret = "metadata-secret"
    challenge = response(
        401,
        auth="oauth",
        headers={"www-authenticate": f'Bearer resource_metadata="{METADATA_URL}"'},
    )
    transport = FakeTransport(
        [challenge, HttpResponse(200, {}, f"not-json-{secret}".encode())]
    )

    report = inspect_endpoint(ENDPOINT, transport=transport)

    assert not report.ok
    assert secret not in repr(report)
    assert not check(report, "protected-resource-metadata").ok


def test_legacy_runtime_headers_are_supported_during_rename_transition() -> None:
    transport = FakeTransport(
        [
            HttpResponse(
                401,
                {
                    "x-supa-mcp-version": "0.8.0",
                    "x-supa-mcp-auth-mode": "api-key",
                    "x-supa-mcp-auth-strategy": "static",
                    "x-supa-mcp-resource-url": ENDPOINT,
                },
                b"{}",
            )
        ]
    )

    report = inspect_endpoint(ENDPOINT, transport=transport)

    assert report.ok
    assert report.runtime_version == "0.8.0"
    assert report.observed_auth == "api-key"
    assert report.auth_strategy == "static"


def test_explicit_default_port_normalizes_to_runtime_resource() -> None:
    endpoint = "https://project.supabase.co:443/functions/v1/mcp/"
    transport = FakeTransport([response(200, headers={"x-ratelimit-limit": "60"})])

    report = inspect_endpoint(endpoint, transport=transport)

    assert report.ok
    assert report.endpoint == ENDPOINT
