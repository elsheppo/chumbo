from __future__ import annotations

import http.client
from collections.abc import Mapping
from dataclasses import dataclass, field

import pytest

from chumbo._http import ResponseTooLargeError, StdlibTransport


@dataclass
class RawResponse:
    status: int = 200
    headers: Mapping[str, str] = field(default_factory=dict)
    body: bytes = b"ok"

    def getheader(self, name: str) -> str | None:
        return self.headers.get(name.lower())

    def getheaders(self) -> list[tuple[str, str]]:
        return list(self.headers.items())

    def read(self, amount: int) -> bytes:
        return self.body[:amount]


@dataclass
class FakeConnection:
    response: RawResponse
    requests: list[dict[str, object]] = field(default_factory=list)
    closed: bool = False

    def request(
        self,
        method: str,
        path: str,
        body: bytes | None,
        headers: Mapping[str, str],
    ) -> None:
        self.requests.append(
            {"method": method, "path": path, "body": body, "headers": headers}
        )

    def getresponse(self) -> RawResponse:
        return self.response

    def close(self) -> None:
        self.closed = True


def install_connection(monkeypatch, response: RawResponse) -> FakeConnection:
    connection = FakeConnection(response)
    monkeypatch.setattr(
        http.client,
        "HTTPConnection",
        lambda host, port, timeout: connection,
    )
    return connection


def test_stdlib_transport_reads_a_bounded_response(monkeypatch) -> None:
    connection = install_connection(
        monkeypatch,
        RawResponse(headers={"x-test-header": "present"}),
    )

    response = StdlibTransport().request(
        "http://127.0.0.1:8080/ok",
        method="GET",
        headers={},
        body=None,
        timeout=2,
        max_bytes=10,
    )

    assert response.status == 200
    assert response.body == b"ok"
    assert response.headers["x-test-header"] == "present"
    assert connection.requests[0]["path"] == "/ok"
    assert connection.closed


def test_stdlib_transport_returns_redirect_without_following_it(monkeypatch) -> None:
    connection = install_connection(
        monkeypatch,
        RawResponse(status=307, headers={"location": "https://attacker.example"}),
    )

    response = StdlibTransport().request(
        "http://127.0.0.1:8080/redirect",
        method="GET",
        headers={},
        body=None,
        timeout=2,
        max_bytes=10,
    )

    assert response.status == 307
    assert response.headers["location"] == "https://attacker.example"
    assert len(connection.requests) == 1


def test_stdlib_transport_rejects_response_from_content_length(monkeypatch) -> None:
    connection = install_connection(
        monkeypatch,
        RawResponse(headers={"content-length": "100"}, body=b"x" * 100),
    )

    with pytest.raises(ResponseTooLargeError):
        StdlibTransport().request(
            "http://127.0.0.1:8080/large",
            method="GET",
            headers={},
            body=None,
            timeout=2,
            max_bytes=10,
        )

    assert connection.closed


def test_stdlib_transport_rejects_unbounded_oversized_response(monkeypatch) -> None:
    connection = install_connection(monkeypatch, RawResponse(body=b"x" * 100))

    with pytest.raises(ResponseTooLargeError):
        StdlibTransport().request(
            "http://127.0.0.1:8080/unbounded-large",
            method="GET",
            headers={},
            body=None,
            timeout=2,
            max_bytes=10,
        )

    assert connection.closed
