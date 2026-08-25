from __future__ import annotations

from pathlib import Path

import pytest

from plane_codex_worker.config import ConfigurationError, load_config


def test_loads_plane_secret_from_existing_codex_config_without_exposing_it(
    tmp_path: Path,
):
    codex_config = tmp_path / "config.toml"
    codex_config.write_text(
        """
[mcp_servers.plane.env]
PLANE_API_HOST_URL = "https://plane.cslog.com.br"
PLANE_API_KEY = "top-secret"
PLANE_WORKSPACE_SLUG = "cslog"
""".strip()
    )
    config = load_config(
        {
            "HOME": str(tmp_path),
            "PCW_CODEX_CONFIG": str(codex_config),
            "PCW_PLANE_PROJECT_ID": "project-id",
            "PCW_CODEX_CWD": str(tmp_path),
        }
    )
    assert config.plane_api_key == "top-secret"
    assert config.plane_project_identifier == "AGENTE"
    assert config.redacted_summary()["plane_api_key_present"] is True
    assert "top-secret" not in repr(config.redacted_summary())


def test_rejects_unknown_model_preset(tmp_path: Path):
    with pytest.raises(ConfigurationError, match="PCW_CODEX_PRESET"):
        load_config(
            {
                "HOME": str(tmp_path),
                "PCW_PLANE_API_KEY": "secret",
                "PCW_PLANE_PROJECT_ID": "project-id",
                "PCW_CODEX_CWD": str(tmp_path),
                "PCW_CODEX_PRESET": "arbitrary-provider",
            }
        )


def test_explicit_plane_configuration_does_not_require_codex_plane_mcp(tmp_path: Path):
    (tmp_path / "config.toml").write_text("model = 'gpt-test'\n")
    config = load_config(
        {
            "HOME": str(tmp_path),
            "PCW_CODEX_CONFIG": str(tmp_path / "config.toml"),
            "PCW_PLANE_API_KEY": "secret",
            "PCW_PLANE_PROJECT_ID": "project-id",
            "PCW_CODEX_CWD": str(tmp_path),
        }
    )
    assert config.plane_workspace == "cslog"
