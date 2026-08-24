from __future__ import annotations

import importlib.util
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
