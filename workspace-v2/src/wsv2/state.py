from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import time

WINDOW_LABEL_MAX_LENGTH = 80


DEFAULT_STATE_PATH = Path(
    os.environ.get(
        "WSV2_STATE_PATH",
        Path.home() / ".local" / "state" / "ai-workflow" / "workspace-v2.json",
    )
)


def normalize_window_label(value: object) -> str:
    normalized = " ".join(str(value or "").split())
    return normalized[:WINDOW_LABEL_MAX_LENGTH]


def normalize_terminal_status(value: object) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"check", "needs-check", "needs_check", "review"}:
        return "check"
    if normalized in {"idle", "done", "complete", "completed"}:
        return "idle"
    return ""


def normalize_window_id(value: object) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        return ""
    if normalized.startswith("@"):
        normalized = normalized[1:]
    return f"@{normalized}" if normalized.isdigit() else ""


def window_label_key(host_id: str, session_id: str, window_index: int) -> str:
    return f"{host_id}:{session_id}#{window_index}"


def window_stable_key(host_id: str, session_id: str, window_id: object) -> str:
    normalized_id = normalize_window_id(window_id)
    if not normalized_id:
        return ""
    return f"{host_id}:{session_id}{normalized_id}"


def window_metadata_candidate_keys(
    host_id: str,
    session_id: str,
    window_index: int,
    window_id: object = "",
) -> list[str]:
    keys = []
    stable_key = window_stable_key(host_id, session_id, window_id)
    if stable_key:
        keys.append(stable_key)
    keys.append(window_label_key(host_id, session_id, window_index))
    return keys


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

    def window_labels(self) -> dict[str, dict]:
        payload = self._load_payload()
        labels = payload.get("windowLabels") or {}
        if not isinstance(labels, dict):
            return {}
        return {
            str(key): value
            for key, value in labels.items()
            if isinstance(value, dict)
            and (normalize_window_label(value.get("label")) or normalize_terminal_status(value.get("status")))
        }

    def window_label(self, host_id: str, session_id: str, window_index: int, window_id: object = "") -> str:
        labels = self.window_labels()
        for key in window_metadata_candidate_keys(host_id, session_id, window_index, window_id):
            record = labels.get(key)
            label = normalize_window_label(record.get("label") if record else "")
            if label:
                return label
        return ""

    def window_status(self, host_id: str, session_id: str, window_index: int, window_id: object = "") -> str:
        labels = self.window_labels()
        for key in window_metadata_candidate_keys(host_id, session_id, window_index, window_id):
            record = labels.get(key)
            status = normalize_terminal_status(record.get("status") if record else "")
            if status:
                return status
        return ""

    def set_window_label(
        self,
        host_id: str,
        session_id: str,
        window_index: int,
        label: object,
        window_id: object = "",
    ) -> str:
        metadata = self.set_window_metadata(host_id, session_id, window_index, label=label, window_id=window_id)
        return metadata["label"]

    def set_window_status(
        self,
        host_id: str,
        session_id: str,
        window_index: int,
        status: object,
        window_id: object = "",
    ) -> str:
        metadata = self.set_window_metadata(host_id, session_id, window_index, status=status, window_id=window_id)
        return metadata["status"]

    def set_window_metadata(
        self,
        host_id: str,
        session_id: str,
        window_index: int,
        *,
        label: object | None = None,
        status: object | None = None,
        window_id: object = "",
    ) -> dict[str, str]:
        payload = self._load_payload()
        labels = payload.setdefault("windowLabels", {})
        if not isinstance(labels, dict):
            labels = {}
            payload["windowLabels"] = labels

        key = window_stable_key(host_id, session_id, window_id) or window_label_key(host_id, session_id, window_index)
        candidate_keys = window_metadata_candidate_keys(host_id, session_id, window_index, window_id)
        existing = {}
        for candidate_key in candidate_keys:
            record = labels.get(candidate_key)
            if isinstance(record, dict):
                existing = record
                break
        normalized_label = normalize_window_label(label if label is not None else existing.get("label"))
        normalized_status = normalize_terminal_status(status if status is not None else existing.get("status"))
        if normalized_label or normalized_status:
            labels[key] = {"updatedAt": int(time.time())}
            if normalized_label:
                labels[key]["label"] = normalized_label
            if normalized_status:
                labels[key]["status"] = normalized_status
            for candidate_key in candidate_keys:
                if candidate_key != key:
                    labels.pop(candidate_key, None)
        else:
            for candidate_key in candidate_keys:
                labels.pop(candidate_key, None)

        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
        return {"label": normalized_label, "status": normalized_status}

    def mark_recent(self, workspace_target: str) -> None:
        payload = self._load_payload()
        recent = payload.setdefault("recent", {})
        recent[str(workspace_target)] = time.time()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
