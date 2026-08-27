from __future__ import annotations

import json
from pathlib import Path

import pytest

from slack_plane_intake.config import load_config
from slack_plane_intake.errors import ConfigurationError


def test_missing_config_lists_names_without_values():
    with pytest.raises(ConfigurationError) as raised:
        load_config({})
    message = str(raised.value)
    assert "SPI_SLACK_BOT_TOKEN" in message
    assert "SPI_PLANE_API_KEY" in message
    assert "secret" not in message.lower()


def test_load_config_uses_decided_model_routes(required_env):
    config = load_config(required_env)
    assert config.models.text_models == (
        "kimi-k3",
        "qwen3.8-max",
        "deepseek/deepseek-v4-pro",
    )
    assert config.models.vision_models == (
        "kimi-k3",
        "qwen3.8-max",
        "gpt-5.6-terra",
    )
    assert config.plane.base_url == "https://plane.cslog.com.br"
    assert config.plane.workspace == "cslog"
    assert config.plane.project_identifier == "AGENTE"
    summary = config.redacted_summary()
    rendered = repr(summary)
    assert "model-secret" not in rendered
    assert "plane-secret" not in rendered
    assert "xoxb-test-secret" not in rendered


def test_standard_hermes_slack_token_is_an_accepted_alias(required_env):
    token = required_env.pop("SPI_SLACK_BOT_TOKEN")
    required_env["SLACK_BOT_TOKEN"] = token
    assert load_config(required_env).slack.bot_token == token


def test_dm_intake_requires_exactly_one_allowed_user(required_env):
    required_env["SPI_SLACK_ALLOWED_USERS"] = "U1,U2"
    with pytest.raises(ConfigurationError, match="exactly one"):
        load_config(required_env)


def test_shortcut_allowlist_can_add_users_without_expanding_dm_access(required_env):
    required_env["SPI_SLACK_SHORTCUT_ALLOWED_USERS"] = "U1,U2,U3,U4"
    config = load_config(required_env)

    assert config.slack.allowed_users == frozenset({"U1"})
    assert config.slack.shortcut_allowed_users == frozenset({"U1", "U2", "U3", "U4"})
    assert config.redacted_summary()["slack_shortcut_allowed_users"] == 4


def test_shortcut_allowlist_defaults_to_dm_owner(required_env):
    config = load_config(required_env)

    assert config.slack.shortcut_allowed_users == config.slack.allowed_users


def test_history_picker_requires_matching_user_token_pair(required_env):
    required_env["SPI_SLACK_HISTORY_USER_ID"] = "U1"
    with pytest.raises(ConfigurationError, match="configured together"):
        load_config(required_env)


def test_history_picker_is_bound_to_an_authorized_user_and_redacted(required_env):
    required_env["SPI_SLACK_SHORTCUT_ALLOWED_USERS"] = "U1,U2"
    required_env["SPI_SLACK_HISTORY_USER_ID"] = "U1"
    required_env["SPI_SLACK_HISTORY_USER_TOKEN"] = "xoxp-history-secret"

    config = load_config(required_env)

    assert config.slack.history_user_id == "U1"
    assert config.slack.history_user_token == "xoxp-history-secret"
    assert config.redacted_summary()["slack_history_picker_enabled"] is True
    assert "xoxp-history-secret" not in repr(config.redacted_summary())


def test_history_picker_rejects_user_outside_shortcut_allowlist(required_env):
    required_env["SPI_SLACK_HISTORY_USER_ID"] = "U2"
    required_env["SPI_SLACK_HISTORY_USER_TOKEN"] = "xoxp-history-secret"
    with pytest.raises(ConfigurationError, match="must be in"):
        load_config(required_env)


def test_personal_credentials_scope_slack_and_plane_by_shortcut_user(required_env):
    required_env["SPI_SLACK_SHORTCUT_ALLOWED_USERS"] = "U1,U2"
    path = Path(required_env["SPI_STATE_ROOT"]).parent / "users.json"
    path.write_text(
        json.dumps(
            {
                "U2": {
                    "slack_user_token": "xoxp-user-two",
                    "plane_api_key": "plane-user-two",
                }
            }
        )
    )
    path.chmod(0o600)
    required_env["SPI_USER_CREDENTIALS_FILE"] = str(path)

    config = load_config(required_env)
    scoped = config.for_shortcut_user("U2")

    assert scoped.slack.history_user_id == "U2"
    assert scoped.slack.history_user_token == "xoxp-user-two"
    assert scoped.plane.api_key == "plane-user-two"
    assert config.plane.api_key == "plane-secret"
    assert config.for_shortcut_user("U1") is config
    summary = config.redacted_summary()
    assert summary["shortcut_personal_credential_count"] == 1
    assert "xoxp-user-two" not in repr(summary)
    assert "plane-user-two" not in repr(summary)


def test_personal_credentials_require_private_file_and_authorized_user(required_env):
    required_env["SPI_SLACK_SHORTCUT_ALLOWED_USERS"] = "U1,U2"
    path = Path(required_env["SPI_STATE_ROOT"]).parent / "users.json"
    path.write_text(
        json.dumps(
            {
                "U3": {
                    "slack_user_token": "xoxp-user-three",
                    "plane_api_key": "plane-user-three",
                }
            }
        )
    )
    path.chmod(0o644)
    required_env["SPI_USER_CREDENTIALS_FILE"] = str(path)

    with pytest.raises(ConfigurationError, match="mode 0600"):
        load_config(required_env)

    path.chmod(0o600)
    with pytest.raises(ConfigurationError, match="unauthorized") as raised:
        load_config(required_env)
    assert "xoxp-user-three" not in str(raised.value)
    assert "plane-user-three" not in str(raised.value)


def test_personal_credentials_reject_extra_fields(required_env):
    path = Path(required_env["SPI_STATE_ROOT"]).parent / "users.json"
    path.write_text(
        json.dumps(
            {
                "U1": {
                    "slack_user_token": "xoxp-user-one",
                    "plane_api_key": "plane-user-one",
                    "unexpected": "value",
                }
            }
        )
    )
    path.chmod(0o600)
    required_env["SPI_USER_CREDENTIALS_FILE"] = str(path)

    with pytest.raises(ConfigurationError, match="contain only"):
        load_config(required_env)


def test_rejects_credentials_embedded_in_base_url(required_env):
    required_env["SPI_PLANE_BASE_URL"] = "https://user:pass@plane.example"
    with pytest.raises(ConfigurationError, match="must not contain credentials"):
        load_config(required_env)
