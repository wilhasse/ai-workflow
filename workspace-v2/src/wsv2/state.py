from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import time


DEFAULT_STATE_PATH = Path(
    os.environ.get(
        "WSV2_STATE_PATH",
        Path.home() / ".local" / "state" / "ai-workflow" / "workspace-v2.json",
    )
)


@dataclass(slots=True)
class LauncherState:
    path: Path = DEFAULT_STATE_PATH

    def __post_init__(self) -> None:
        self.path = Path(self.path).expanduser()

    def _load_payload(self) -> dict:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"recent": {}}
        except json.JSONDecodeError:
            return {"recent": {}}

    def recent_scores(self) -> dict[str, float]:
        payload = self._load_payload()
        recent = payload.get("recent") or {}
        return {str(key): float(value) for key, value in recent.items()}

    def mark_recent(self, workspace_target: str) -> None:
        payload = self._load_payload()
        recent = payload.setdefault("recent", {})
        recent[str(workspace_target)] = time.time()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
