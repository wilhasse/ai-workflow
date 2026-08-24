"""Environment-only configuration with redacted validation output."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from .errors import ConfigurationError


@dataclass(frozen=True)
class SlackConfig:
    bot_token: str
    channel_id: str
    allowed_users: frozenset[str]
    shortcut_allowed_users: frozenset[str]


@dataclass(frozen=True)
class ModelConfig:
    base_url: str
    api_key: str
    text_models: tuple[str, ...]
    vision_models: tuple[str, ...]
    timeout_seconds: float


@dataclass(frozen=True)
class PlaneConfig:
    base_url: str
    api_key: str
    workspace: str
    project_id: str
    project_identifier: str
    state_id: str


@dataclass(frozen=True)
class LimitConfig:
    max_files: int
    max_file_bytes: int
    max_total_bytes: int
    max_text_chars: int
    max_pdf_pages: int


@dataclass(frozen=True)
class AppConfig:
    slack: SlackConfig
    models: ModelConfig
    plane: PlaneConfig
    limits: LimitConfig
    state_db: Path
    work_dir: Path

    def redacted_summary(self) -> dict[str, object]:
        return {
            "slack_dm_channel_id": self.slack.channel_id,
            "slack_allowed_users": len(self.slack.allowed_users),
            "slack_shortcut_allowed_users": len(self.slack.shortcut_allowed_users),
            "cliproxy_base_url": self.models.base_url,
            "text_models": list(self.models.text_models),
            "vision_models": list(self.models.vision_models),
            "plane_base_url": self.plane.base_url,
            "plane_workspace": self.plane.workspace,
            "plane_project_id": self.plane.project_id,
            "plane_project_identifier": self.plane.project_identifier,
            "plane_state_id": self.plane.state_id,
            "state_db": str(self.state_db),
            "work_dir": str(self.work_dir),
        }


def _required(env: Mapping[str, str], name: str, missing: list[str]) -> str:
    value = env.get(name, "").strip()
    if not value:
        missing.append(name)
    return value


def _required_with_alias(
    env: Mapping[str, str], name: str, alias: str, missing: list[str]
) -> str:
    value = env.get(name, "").strip() or env.get(alias, "").strip()
    if not value:
        missing.append(name)
    return value


def _csv(value: str) -> tuple[str, ...]:
    return tuple(part.strip() for part in value.split(",") if part.strip())


def _positive_int(env: Mapping[str, str], name: str, default: int) -> int:
    raw = env.get(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be an integer") from exc
    if value <= 0:
        raise ConfigurationError(f"{name} must be greater than zero")
    return value


def _safe_base_url(name: str, value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ConfigurationError(f"{name} must be an http(s) URL")
    if parsed.username or parsed.password:
        raise ConfigurationError(f"{name} must not contain credentials")
    return value.rstrip("/")


def load_config(environ: Mapping[str, str] | None = None) -> AppConfig:
    env = os.environ if environ is None else environ
    missing: list[str] = []
    slack_token = _required_with_alias(
        env, "SPI_SLACK_BOT_TOKEN", "SLACK_BOT_TOKEN", missing
    )
    slack_channel = _required(env, "SPI_SLACK_CHANNEL_ID", missing)
    allowed_users_raw = _required(env, "SPI_SLACK_ALLOWED_USERS", missing)
    model_key = _required(env, "SPI_CLIPROXY_API_KEY", missing)
    plane_key = _required(env, "SPI_PLANE_API_KEY", missing)
    plane_project = _required(env, "SPI_PLANE_PROJECT_ID", missing)
    plane_state = _required(env, "SPI_PLANE_STATE_ID", missing)
    if missing:
        raise ConfigurationError(
            "Missing required environment variables: " + ", ".join(sorted(missing))
        )

    allowed_users = frozenset(_csv(allowed_users_raw))
    if len(allowed_users) != 1:
        raise ConfigurationError(
            "SPI_SLACK_ALLOWED_USERS must contain exactly one Slack user ID for DM intake"
        )
    shortcut_allowed_users = frozenset(
        _csv(
            env.get("SPI_SLACK_SHORTCUT_ALLOWED_USERS", "").strip() or allowed_users_raw
        )
    )
    if not shortcut_allowed_users:
        raise ConfigurationError(
            "SPI_SLACK_SHORTCUT_ALLOWED_USERS must contain at least one Slack user ID"
        )

    text_models = _csv(
        env.get(
            "SPI_TEXT_MODELS",
            "kimi-k3,qwen3.8-max,deepseek/deepseek-v4-pro",
        )
    )
    vision_models = _csv(
        env.get("SPI_VISION_MODELS", "kimi-k3,qwen3.8-max,gpt-5.6-terra")
    )
    if not text_models or not vision_models:
        raise ConfigurationError(
            "SPI_TEXT_MODELS and SPI_VISION_MODELS cannot be empty"
        )

    state_root = Path(
        env.get(
            "SPI_STATE_ROOT",
            str(Path.home() / ".local" / "state" / "slack-plane-intake"),
        )
    ).expanduser()
    state_db = Path(env.get("SPI_STATE_DB", str(state_root / "intake.sqlite3")))
    work_dir = Path(env.get("SPI_WORK_DIR", str(state_root / "work")))

    try:
        timeout = float(env.get("SPI_HTTP_TIMEOUT_SECONDS", "60"))
    except ValueError as exc:
        raise ConfigurationError("SPI_HTTP_TIMEOUT_SECONDS must be numeric") from exc
    if timeout <= 0:
        raise ConfigurationError("SPI_HTTP_TIMEOUT_SECONDS must be greater than zero")

    return AppConfig(
        slack=SlackConfig(
            slack_token,
            slack_channel,
            allowed_users,
            shortcut_allowed_users,
        ),
        models=ModelConfig(
            base_url=_safe_base_url(
                "SPI_CLIPROXY_BASE_URL",
                env.get("SPI_CLIPROXY_BASE_URL", "http://127.0.0.1:8317/v1"),
            ),
            api_key=model_key,
            text_models=text_models,
            vision_models=vision_models,
            timeout_seconds=timeout,
        ),
        plane=PlaneConfig(
            base_url=_safe_base_url(
                "SPI_PLANE_BASE_URL",
                env.get("SPI_PLANE_BASE_URL", "https://plane.cslog.com.br"),
            ),
            api_key=plane_key,
            workspace=env.get("SPI_PLANE_WORKSPACE", "cslog").strip(),
            project_id=plane_project,
            project_identifier=env.get(
                "SPI_PLANE_PROJECT_IDENTIFIER", "AGENTE"
            ).strip(),
            state_id=plane_state,
        ),
        limits=LimitConfig(
            max_files=_positive_int(env, "SPI_MAX_FILES", 10),
            max_file_bytes=_positive_int(env, "SPI_MAX_FILE_BYTES", 20 * 1024 * 1024),
            max_total_bytes=_positive_int(
                env, "SPI_MAX_TOTAL_BYTES", 100 * 1024 * 1024
            ),
            max_text_chars=_positive_int(env, "SPI_MAX_TEXT_CHARS", 100_000),
            max_pdf_pages=_positive_int(env, "SPI_MAX_PDF_PAGES", 10),
        ),
        state_db=state_db.expanduser().resolve(),
        work_dir=work_dir.expanduser().resolve(),
    )
