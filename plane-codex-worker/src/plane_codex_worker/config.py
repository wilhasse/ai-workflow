"""Environment configuration with a read-only Codex config fallback for Plane."""

from __future__ import annotations

import os
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit


class ConfigurationError(ValueError):
    """Raised when the worker cannot construct a safe runtime configuration."""


@dataclass(frozen=True)
class WorkerConfig:
    plane_base_url: str
    plane_api_key: str
    plane_workspace: str
    plane_project_id: str
    plane_project_identifier: str
    codex_socket: Path
    codex_preset: str
    codex_cwd: Path
    state_db: Path
    poll_seconds: float
    turn_poll_seconds: float
    turn_timeout_seconds: float
    max_issues_per_poll: int
    max_issue_chars: int
    max_result_chars: int
    agent_board_url: str

    def redacted_summary(self) -> dict[str, object]:
        return {
            "plane_base_url": self.plane_base_url,
            "plane_workspace": self.plane_workspace,
            "plane_project_id": self.plane_project_id,
            "plane_project_identifier": self.plane_project_identifier,
            "plane_api_key_present": bool(self.plane_api_key),
            "codex_socket": str(self.codex_socket),
            "codex_preset": self.codex_preset,
            "codex_cwd": str(self.codex_cwd),
            "state_db": str(self.state_db),
            "poll_seconds": self.poll_seconds,
            "turn_timeout_seconds": self.turn_timeout_seconds,
            "max_issues_per_poll": self.max_issues_per_poll,
            "agent_board_url": self.agent_board_url,
        }


def _safe_url(name: str, value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ConfigurationError(f"{name} must be an http(s) URL")
    if parsed.username or parsed.password:
        raise ConfigurationError(f"{name} must not contain credentials")
    return value.rstrip("/")


def _positive_float(env: Mapping[str, str], name: str, default: float) -> float:
    try:
        value = float(env.get(name, str(default)))
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be numeric") from exc
    if value <= 0:
        raise ConfigurationError(f"{name} must be greater than zero")
    return value


def _positive_int(env: Mapping[str, str], name: str, default: int) -> int:
    try:
        value = int(env.get(name, str(default)))
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be an integer") from exc
    if value <= 0:
        raise ConfigurationError(f"{name} must be greater than zero")
    return value


def _codex_plane_environment(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    try:
        with path.open("rb") as handle:
            payload = tomllib.load(handle)
        values = payload["mcp_servers"]["plane"]["env"]
    except (KeyError, TypeError):
        return {}
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise ConfigurationError(f"Cannot read Plane settings from {path}") from exc
    return {
        str(key): str(value)
        for key, value in values.items()
        if isinstance(value, (str, int, float, bool))
    }


def load_config(environ: Mapping[str, str] | None = None) -> WorkerConfig:
    env = os.environ if environ is None else environ
    home = Path(env.get("HOME", str(Path.home()))).expanduser()
    codex_config = Path(
        env.get("PCW_CODEX_CONFIG", str(home / ".codex" / "config.toml"))
    ).expanduser()
    plane_env = _codex_plane_environment(codex_config)

    plane_api_key = (
        env.get("PCW_PLANE_API_KEY", "").strip()
        or plane_env.get("PLANE_API_KEY", "").strip()
    )
    if not plane_api_key:
        raise ConfigurationError(
            "PCW_PLANE_API_KEY is required when Codex Plane MCP has no API key"
        )
    project_id = env.get("PCW_PLANE_PROJECT_ID", "").strip()
    if not project_id:
        raise ConfigurationError("PCW_PLANE_PROJECT_ID is required")

    codex_socket = Path(
        env.get(
            "PCW_CODEX_SOCKET",
            str(home / "ai-workflow" / "runtime" / "codex-control" / "control.sock"),
        )
    ).expanduser()
    codex_cwd = Path(env.get("PCW_CODEX_CWD", str(home))).expanduser().resolve()
    if not codex_cwd.is_dir():
        raise ConfigurationError(f"PCW_CODEX_CWD is not a directory: {codex_cwd}")
    preset = env.get("PCW_CODEX_PRESET", "default").strip()
    if preset not in {"default", "k3", "qwen"}:
        raise ConfigurationError("PCW_CODEX_PRESET must be default, k3, or qwen")

    state_root = Path(
        env.get(
            "PCW_STATE_ROOT",
            str(home / ".local" / "state" / "plane-codex-worker"),
        )
    ).expanduser()
    return WorkerConfig(
        plane_base_url=_safe_url(
            "PCW_PLANE_BASE_URL",
            env.get("PCW_PLANE_BASE_URL", "").strip()
            or plane_env.get("PLANE_API_HOST_URL", "https://plane.cslog.com.br"),
        ),
        plane_api_key=plane_api_key,
        plane_workspace=env.get("PCW_PLANE_WORKSPACE", "").strip()
        or plane_env.get("PLANE_WORKSPACE_SLUG", "").strip()
        or "cslog",
        plane_project_id=project_id,
        plane_project_identifier=env.get(
            "PCW_PLANE_PROJECT_IDENTIFIER", "AGENTE"
        ).strip(),
        codex_socket=codex_socket.resolve(),
        codex_preset=preset,
        codex_cwd=codex_cwd,
        state_db=Path(env.get("PCW_STATE_DB", str(state_root / "jobs.sqlite3")))
        .expanduser()
        .resolve(),
        poll_seconds=_positive_float(env, "PCW_POLL_SECONDS", 30),
        turn_poll_seconds=_positive_float(env, "PCW_TURN_POLL_SECONDS", 2),
        turn_timeout_seconds=_positive_float(env, "PCW_TURN_TIMEOUT_SECONDS", 1800),
        max_issues_per_poll=_positive_int(env, "PCW_MAX_ISSUES_PER_POLL", 3),
        max_issue_chars=_positive_int(env, "PCW_MAX_ISSUE_CHARS", 8000),
        max_result_chars=_positive_int(env, "PCW_MAX_RESULT_CHARS", 30000),
        agent_board_url=_safe_url(
            "PCW_AGENT_BOARD_URL",
            env.get(
                "PCW_AGENT_BOARD_URL",
                "https://10.1.0.10/?view=agent-board",
            ),
        ),
    )
