"""Configuration management for Plane Claude Orchestrator."""

import os
from pathlib import Path
from typing import Any

import yaml
from pydantic import Field
from pydantic_settings import BaseSettings


class PlaneConfig(BaseSettings):
    """Plane-related configuration."""

    api_url: str = Field(default="https://plane.cslog.com.br/api/v1")
    api_token: str = Field(default="")
    workspace_slug: str = Field(default="cslog")
    poll_interval: int = Field(default=30)
    project_ids: list[str] = Field(default_factory=list)
    project_identifier: str = Field(default="CSLOG")


class TmuxServiceConfig(BaseSettings):
    """tmux-session-service configuration."""

    url: str = Field(default="http://localhost:5001")
    websocket_url: str = Field(default="ws://localhost:5001")


class AutomationConfig(BaseSettings):
    """Automation-related configuration."""

    repo_path: str = Field(default="/home/cslog/ai-workflow")
    claude_bin: str = Field(default="claude")
    session_prefix: str = Field(default="claude-")
    project_id: str = Field(default="plane-automation")


class TriggerConfig(BaseSettings):
    """Trigger configuration."""

    new_tickets: bool = Field(default=True)
    status_changes: list[dict[str, str]] = Field(default_factory=list)
    comments: bool = Field(default=True)


class APIConfig(BaseSettings):
    """API server configuration."""

    host: str = Field(default="0.0.0.0")
    port: int = Field(default=5002)


class LoggingConfig(BaseSettings):
    """Logging configuration."""

    level: str = Field(default="INFO")
    file: str = Field(default="data/orchestrator.log")


class Config(BaseSettings):
    """Main configuration class."""

    plane: PlaneConfig
    tmux_session_service: TmuxServiceConfig
    automation: AutomationConfig
    triggers: TriggerConfig
    api: APIConfig
    logging: LoggingConfig

    @classmethod
    def load_from_file(cls, config_path: str | Path) -> "Config":
        """Load configuration from YAML file."""
        config_path = Path(config_path).expanduser()

        if not config_path.exists():
            raise FileNotFoundError(f"Config file not found: {config_path}")

        with open(config_path) as f:
            data = yaml.safe_load(f)

        return cls(**data)


def load_config(config_path: str | Path = "config.yaml") -> Config:
    """Load configuration from file or environment."""
    # Try to load from file first
    try:
        return Config.load_from_file(config_path)
    except FileNotFoundError:
        # Fall back to environment variables
        return Config(
            plane=PlaneConfig(),
            tmux_session_service=TmuxServiceConfig(),
            automation=AutomationConfig(),
            triggers=TriggerConfig(),
            api=APIConfig(),
            logging=LoggingConfig(),
        )
