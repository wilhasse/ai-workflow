from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def activation_module():
    path = ROOT / "scripts/activate-target.py"
    spec = importlib.util.spec_from_file_location("activate_target", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_env(hermes_home: Path) -> Path:
    hermes_home.mkdir()
    env_path = hermes_home / ".env"
    env_path.write_text(
        "SLACK_BOT_TOKEN=xoxb-test\n"
        "SLACK_ALLOWED_USERS=U12345\n"
        "SPI_SLACK_ALLOWED_USERS=U12345\n"
    )
    env_path.chmod(0o600)
    return env_path


def test_activation_resolves_and_saves_one_to_one_dm(
    activation_module, monkeypatch, tmp_path
):
    hermes_home = tmp_path / "hermes"
    env_path = write_env(hermes_home)
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    calls: list[tuple[str, dict[str, str]]] = []

    def slack_call(token: str, method: str, params: dict[str, str]):
        assert token == "xoxb-test"
        calls.append((method, params))
        if method == "auth.test":
            return {"ok": True}, "files:read,im:history,im:write"
        if method == "conversations.open":
            return {"ok": True, "channel": {"id": "D12345"}}, ""
        raise AssertionError(method)

    monkeypatch.setattr(activation_module, "slack_call", slack_call)
    assert activation_module.main([]) == 0
    saved = activation_module.read_env(env_path)
    assert saved["SPI_SLACK_CHANNEL_ID"] == "D12345"
    assert saved["SLACK_ALLOWED_CHANNELS"] == "D12345"
    assert saved["SLACK_HOME_CHANNEL"] == "D12345"
    assert calls == [
        ("auth.test", {}),
        ("conversations.open", {"users": "U12345"}),
    ]


def test_activation_does_not_bind_dm_without_file_scope(
    activation_module, monkeypatch, tmp_path
):
    hermes_home = tmp_path / "hermes"
    env_path = write_env(hermes_home)
    before = env_path.read_text()
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))

    def slack_call(token: str, method: str, params: dict[str, str]):
        assert method == "auth.test"
        return {"ok": True}, "im:history,im:write"

    monkeypatch.setattr(activation_module, "slack_call", slack_call)
    assert activation_module.main([]) == 1
    assert env_path.read_text() == before


def test_activation_validates_optional_history_user_token(
    activation_module, monkeypatch, tmp_path
):
    hermes_home = tmp_path / "hermes"
    env_path = write_env(hermes_home)
    with env_path.open("a") as handle:
        handle.write(
            "SPI_SLACK_HISTORY_USER_ID=U12345\n"
            "SPI_SLACK_HISTORY_USER_TOKEN=xoxp-history\n"
        )
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    calls: list[tuple[str, str]] = []

    def slack_call(token: str, method: str, _params: dict[str, str]):
        calls.append((token, method))
        if token == "xoxb-test" and method == "auth.test":
            return {
                "ok": True,
                "team_id": "T1",
            }, "files:read,im:history,im:write"
        if token == "xoxp-history" and method == "auth.test":
            return {
                "ok": True,
                "team_id": "T1",
                "user_id": "U12345",
            }, "files:read,im:history"
        if method == "conversations.open":
            return {"ok": True, "channel": {"id": "D12345"}}, ""
        raise AssertionError((token, method))

    monkeypatch.setattr(activation_module, "slack_call", slack_call)
    assert activation_module.main([]) == 0
    assert ("xoxp-history", "auth.test") in calls


def test_activation_rejects_history_token_for_another_user(
    activation_module, monkeypatch, tmp_path
):
    hermes_home = tmp_path / "hermes"
    env_path = write_env(hermes_home)
    with env_path.open("a") as handle:
        handle.write(
            "SPI_SLACK_HISTORY_USER_ID=U99999\n"
            "SPI_SLACK_HISTORY_USER_TOKEN=xoxp-history\n"
        )
    before = env_path.read_text()
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))

    def slack_call(_token: str, method: str, _params: dict[str, str]):
        assert method == "auth.test"
        return {"ok": True, "team_id": "T1"}, "files:read,im:history,im:write"

    monkeypatch.setattr(activation_module, "slack_call", slack_call)
    assert activation_module.main([]) == 2
    assert env_path.read_text() == before


def test_activation_rejects_history_token_without_required_scopes(
    activation_module, monkeypatch, tmp_path, capsys
):
    hermes_home = tmp_path / "hermes"
    env_path = write_env(hermes_home)
    with env_path.open("a") as handle:
        handle.write(
            "SPI_SLACK_HISTORY_USER_ID=U12345\n"
            "SPI_SLACK_HISTORY_USER_TOKEN=xoxp-history\n"
        )
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))

    def slack_call(token: str, method: str, _params: dict[str, str]):
        assert method == "auth.test"
        if token == "xoxb-test":
            return {"ok": True, "team_id": "T1"}, "files:read,im:history,im:write"
        if token == "xoxp-history":
            return {
                "ok": True,
                "team_id": "T1",
                "user_id": "U12345",
            }, "im:history"
        raise AssertionError(token)

    monkeypatch.setattr(activation_module, "slack_call", slack_call)

    assert activation_module.main([]) == 1
    output = capsys.readouterr()
    assert "files:read" in output.err
    assert "xoxp-history" not in output.out + output.err


def test_activation_validates_each_personal_slack_and_plane_identity(
    activation_module, monkeypatch, tmp_path, capsys
):
    hermes_home = tmp_path / "hermes"
    env_path = write_env(hermes_home)
    credentials_path = hermes_home / "slack-plane-users.json"
    credentials_path.write_text(
        json.dumps(
            {
                "U67890": {
                    "slack_user_token": "xoxp-user-two-secret",
                    "plane_api_key": "plane-user-two-secret",
                }
            }
        )
    )
    credentials_path.chmod(0o600)
    with env_path.open("a") as handle:
        handle.write(
            "SPI_SLACK_SHORTCUT_ALLOWED_USERS=U12345,U67890\n"
            f"SPI_USER_CREDENTIALS_FILE={credentials_path}\n"
            "SPI_PLANE_BASE_URL=https://plane.test\n"
            "SPI_PLANE_WORKSPACE=cslog\n"
            "SPI_PLANE_PROJECT_ID=project-id\n"
        )
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    slack_calls: list[tuple[str, str]] = []
    plane_calls: list[tuple[str, str]] = []

    def slack_call(token: str, method: str, _params: dict[str, str]):
        slack_calls.append((token, method))
        if token == "xoxb-test" and method == "auth.test":
            return {
                "ok": True,
                "team_id": "T1",
            }, "files:read,im:history,im:write"
        if token == "xoxp-user-two-secret" and method == "auth.test":
            return {
                "ok": True,
                "team_id": "T1",
                "user_id": "U67890",
            }, "files:read,im:history"
        if method == "conversations.open":
            return {"ok": True, "channel": {"id": "D12345"}}, ""
        raise AssertionError((token, method))

    def plane_call(base_url: str, api_key: str, path: str):
        assert base_url == "https://plane.test"
        assert api_key == "plane-user-two-secret"
        plane_calls.append((api_key, path))
        if path == "/api/v1/users/me/":
            return {"id": "plane-user-two"}
        if path.endswith("/work-items/?limit=1"):
            return {"results": []}
        raise AssertionError(path)

    monkeypatch.setattr(activation_module, "slack_call", slack_call)
    monkeypatch.setattr(activation_module, "plane_call", plane_call)

    assert activation_module.main([]) == 0
    output = capsys.readouterr()
    assert "personal_shortcut_credential_count=1" in output.out
    assert "xoxp-user-two-secret" not in output.out + output.err
    assert "plane-user-two-secret" not in output.out + output.err
    assert ("xoxp-user-two-secret", "auth.test") in slack_calls
    assert len(plane_calls) == 2


def test_activation_rejects_personal_slack_identity_mismatch(
    activation_module, monkeypatch, tmp_path
):
    hermes_home = tmp_path / "hermes"
    env_path = write_env(hermes_home)
    credentials_path = hermes_home / "slack-plane-users.json"
    credentials_path.write_text(
        json.dumps(
            {
                "U67890": {
                    "slack_user_token": "xoxp-wrong-user",
                    "plane_api_key": "plane-user-two",
                }
            }
        )
    )
    credentials_path.chmod(0o600)
    with env_path.open("a") as handle:
        handle.write(
            "SPI_SLACK_SHORTCUT_ALLOWED_USERS=U12345,U67890\n"
            f"SPI_USER_CREDENTIALS_FILE={credentials_path}\n"
            "SPI_PLANE_PROJECT_ID=project-id\n"
        )
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))

    def slack_call(token: str, method: str, _params: dict[str, str]):
        if token == "xoxb-test" and method == "auth.test":
            return {
                "ok": True,
                "team_id": "T1",
            }, "files:read,im:history,im:write"
        if token == "xoxp-wrong-user" and method == "auth.test":
            return {
                "ok": True,
                "team_id": "T1",
                "user_id": "U99999",
            }, "files:read,im:history"
        raise AssertionError((token, method))

    monkeypatch.setattr(activation_module, "slack_call", slack_call)
    assert activation_module.main([]) == 1
