from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class DorisConfig:
    host: str
    port: int
    user: str
    password: str
    database: str


@dataclass(frozen=True)
class HermesConfig:
    home: Path
    state_db_path: Path
    memory_dir: Path
    generated_dir: Path


@dataclass(frozen=True)
class AppConfig:
    doris: DorisConfig
    hermes: HermesConfig


def _resolve_hermes_home() -> Path:
    raw = os.getenv("HMH_HERMES_HOME") or os.getenv("HERMES_HOME")
    if raw:
        return Path(raw).expanduser().resolve()
    return (Path.home() / ".hermes").resolve()


def load_config() -> AppConfig:
    hermes_home = _resolve_hermes_home()
    generated_dir = Path.cwd() / ".generated"
    return AppConfig(
        doris=DorisConfig(
            host=os.getenv("HMH_DORIS_HOST", "10.1.0.7"),
            port=int(os.getenv("HMH_DORIS_PORT", "9030")),
            user=os.getenv("HMH_DORIS_USER", "root"),
            password=os.getenv("HMH_DORIS_PASSWORD", ""),
            database=os.getenv("HMH_DORIS_DATABASE", "agent_history"),
        ),
        hermes=HermesConfig(
            home=hermes_home,
            state_db_path=Path(
                os.getenv("HMH_HERMES_STATE_DB", str(hermes_home / "state.db"))
            ).expanduser().resolve(),
            memory_dir=Path(
                os.getenv("HMH_HERMES_MEMORY_DIR", str(hermes_home / "memories"))
            ).expanduser().resolve(),
            generated_dir=generated_dir.resolve(),
        ),
    )
