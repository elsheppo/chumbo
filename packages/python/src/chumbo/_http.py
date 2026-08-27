from __future__ import annotations

import http.client
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urlsplit


class TransportError(Exception):
    """A safe, bounded transport failure."""


class ResponseTooLargeError(TransportError):
    """The remote response exceeded the inspector's byte limit."""


@dataclass(frozen=True, slots=True)
class HttpResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes


class HttpTransport(Protocol):
    def request(
        self,
        url: str,
        *,
        method: str,
        headers: Mapping[str, str],
        body: bytes | None,
        timeout: float,
        max_bytes: int,
    ) -> HttpResponse: ...


class StdlibTransport:
    """A minimal HTTP transport that deliberately does not follow redirects."""

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
        parsed = urlsplit(url)
        host = parsed.hostname
        if host is None:
            raise TransportError("The endpoint host is invalid.")

        connection_type: type[http.client.HTTPConnection]
        if parsed.scheme == "https":
            connection_type = http.client.HTTPSConnection
        elif parsed.scheme == "http":
            connection_type = http.client.HTTPConnection
        else:
            raise TransportError("The endpoint scheme is not supported.")

        try:
            connection = connection_type(host, port=parsed.port, timeout=timeout)
            path = parsed.path or "/"
            connection.request(method, path, body=body, headers=dict(headers))
            response = connection.getresponse()
            content_length = response.getheader("content-length")
            if content_length is not None:
                try:
                    if int(content_length) > max_bytes:
                        raise ResponseTooLargeError(
                            "The endpoint response exceeded the size limit."
                        )
                except ValueError:
                    pass
            payload = response.read(max_bytes + 1)
            if len(payload) > max_bytes:
                raise ResponseTooLargeError(
                    "The endpoint response exceeded the size limit."
                )
            response_headers = {
                name.lower(): value for name, value in response.getheaders()
            }
            return HttpResponse(response.status, response_headers, payload)
        except ResponseTooLargeError:
            raise
        except (OSError, http.client.HTTPException, ValueError) as error:
            raise TransportError("The endpoint request failed.") from error
        finally:
            if "connection" in locals():
                connection.close()
