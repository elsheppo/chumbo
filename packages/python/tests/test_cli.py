from __future__ import annotations

import json

from chumbo import Check, InspectionReport, cli

ENDPOINT = "https://project.supabase.co/functions/v1/mcp"


def report(*, ok: bool) -> InspectionReport:
    return InspectionReport(
        endpoint=ENDPOINT,
        status_code=200,
        runtime_version="0.8.0",
        observed_auth="public",
        auth_strategy=None,
        resource_url=ENDPOINT,
        checks=(Check("tools-list", ok, "safe detail"),),
    )


def test_json_output_and_success_exit(monkeypatch, capsys) -> None:
    monkeypatch.setattr(
        cli, "inspect_endpoint", lambda *args, **kwargs: report(ok=True)
    )

    exit_code = cli.main(["inspect", ENDPOINT, "--json"])

    captured = capsys.readouterr()
    assert exit_code == 0
    assert json.loads(captured.out)["status"] == "complete"
    assert captured.err == ""


def test_failed_check_uses_exit_one(monkeypatch, capsys) -> None:
    monkeypatch.setattr(
        cli, "inspect_endpoint", lambda *args, **kwargs: report(ok=False)
    )

    exit_code = cli.main(["inspect", ENDPOINT])

    captured = capsys.readouterr()
    assert exit_code == 1
    assert "tools-list" in captured.out
    assert captured.err == ""


def test_token_env_is_read_without_printing_value(monkeypatch, capsys) -> None:
    secret = "cli-secret-token"
    observed = {}

    def fake_inspect(*args, **kwargs):
        observed.update(kwargs)
        return report(ok=True)

    monkeypatch.setenv("CHUMBO_TEST_TOKEN", secret)
    monkeypatch.setattr(cli, "inspect_endpoint", fake_inspect)

    exit_code = cli.main(
        ["inspect", ENDPOINT, "--token-env", "CHUMBO_TEST_TOKEN", "--json"]
    )

    captured = capsys.readouterr()
    assert exit_code == 0
    assert observed["token"] == secret
    assert secret not in captured.out
    assert secret not in captured.err


def test_missing_token_env_uses_exit_two_without_naming_variable(
    monkeypatch, capsys
) -> None:
    monkeypatch.delenv("SECRET_ENVIRONMENT_NAME", raising=False)

    exit_code = cli.main(
        ["inspect", ENDPOINT, "--token-env", "SECRET_ENVIRONMENT_NAME"]
    )

    captured = capsys.readouterr()
    assert exit_code == 2
    assert "SECRET_ENVIRONMENT_NAME" not in captured.err
    assert "not set" in captured.err


def test_configuration_error_uses_exit_two(monkeypatch, capsys) -> None:
    secret = "cli-url-secret"

    exit_code = cli.main(
        ["inspect", f"https://user:{secret}@example.com/mcp", "--json"]
    )

    captured = capsys.readouterr()
    assert exit_code == 2
    assert secret not in captured.out
    assert secret not in captured.err
