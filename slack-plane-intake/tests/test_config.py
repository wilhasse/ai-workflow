from __future__ import annotations

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
    summary = config.redacted_summary()
    rendered = repr(summary)
    assert "model-secret" not in rendered
    assert "plane-secret" not in rendered
    assert "xoxb-test-secret" not in rendered


def test_standard_hermes_slack_token_is_an_accepted_alias(required_env):
    token = required_env.pop("SPI_SLACK_BOT_TOKEN")
    required_env["SLACK_BOT_TOKEN"] = token
    assert load_config(required_env).slack.bot_token == token


def test_rejects_credentials_embedded_in_base_url(required_env):
    required_env["SPI_PLANE_BASE_URL"] = "https://user:pass@plane.example"
    with pytest.raises(ConfigurationError, match="must not contain credentials"):
        load_config(required_env)
