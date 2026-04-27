from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import socket
from typing import Any, Iterable


PACKAGE_ROOT = Path(__file__).resolve().parents[2]
LEGACY_CONFIG_PATH = Path.home() / "ai-workflow" / "workspace-switcher" / "workspaces.json"
V2_CONFIG_PATH = PACKAGE_ROOT / "catalog" / "workspaces.v2.json"
SESSION_ARCHIVE_PATH = Path.home() / ".local" / "state" / "ai-workflow" / "workspace-session-archive.json"


class WorkspaceConfigError(RuntimeError):
    """Raised when the workspace catalog cannot be loaded or resolved."""


@dataclass(slots=True, frozen=True)
class HostRecord:
    id: str
    name: str
    ssh: str | None = None
    hostnames: tuple[str, ...] = ()
    legacy_ids: tuple[str, ...] = ()

    @property
    def ssh_host(self) -> str | None:
        if not self.ssh:
            return None
        target = self.ssh.split("@", 1)[-1].strip()
        return target or None

    def matches_id(self, value: str | None) -> bool:
        if not value:
            return False
        normalized = value.strip().lower()
        if normalized == self.id.lower():
            return True
        return normalized in {item.lower() for item in self.legacy_ids}

    def matches_runtime_identity(self, tokens: Iterable[str]) -> bool:
        normalized_tokens = {token.strip().lower() for token in tokens if token and token.strip()}
        if not normalized_tokens:
            return False

        candidates = {self.id.lower()}
        candidates.update(item.lower() for item in self.hostnames)
        candidates.update(item.lower() for item in self.legacy_ids)

        ssh_host = self.ssh_host
        if ssh_host:
            candidates.add(ssh_host.lower())
            candidates.add(ssh_host.split(".", 1)[0].lower())

        return bool(candidates & normalized_tokens)


@dataclass(slots=True, frozen=True)
class SettingsRecord:
    terminal: str
    terminals: tuple[str, ...]
    shell: str


@dataclass(slots=True, frozen=True)
class WorkspaceRecord:
    id: str
    name: str
    path: str
    raw_path: str
    color: str
    icon: str
    description: str
    host_id: str
    host: HostRecord

    @property
    def target(self) -> str:
        return self.id if self.host_id == "local" else f"{self.host_id}:{self.id}"

    @property
    def display_path(self) -> str:
        home = str(Path.home())
        return self.raw_path.replace(home, "~")


@dataclass(slots=True)
class WorkspaceConfig:
    path: Path
    hosts: tuple[HostRecord, ...]
    workspaces: tuple[WorkspaceRecord, ...]
    settings: SettingsRecord
    self_host_id: str | None = None
    schema_version: int = 1

    def normalize_host_id(self, host_id: str | None) -> str | None:
        if host_id is None:
            return None
        normalized = host_id.strip()
        if not normalized:
            return None
        for host in self.hosts:
            if host.matches_id(normalized):
                return host.id
        return normalized

    def get_host(self, host_id: str) -> HostRecord:
        normalized = self.normalize_host_id(host_id)
        for host in self.hosts:
            if host.id == normalized:
                return host
        raise WorkspaceConfigError(f"Unknown host id: {host_id}")

    def host_runs_local(self, host_or_id: HostRecord | str) -> bool:
        host_id = host_or_id.id if isinstance(host_or_id, HostRecord) else host_or_id
        normalized = self.normalize_host_id(host_id)
        if normalized == "local":
            return True
        return bool(self.self_host_id and normalized == self.self_host_id)

    def resolve_workspace(self, target: str) -> WorkspaceRecord:
        host_id = None
        workspace_id = target
        if ":" in target:
            host_id, workspace_id = target.split(":", 1)

        normalized_host_id = self.normalize_host_id(host_id)
        matches = [
            workspace
            for workspace in self.workspaces
            if workspace.id == workspace_id and (normalized_host_id is None or workspace.host_id == normalized_host_id)
        ]
        if not matches:
            raise WorkspaceConfigError(f"Unknown workspace target: {target}")
        if len(matches) == 1:
            return matches[0]

        if normalized_host_id is None and self.self_host_id:
            self_matches = [workspace for workspace in matches if workspace.host_id == self.self_host_id]
            if len(self_matches) == 1:
                return self_matches[0]

        raise WorkspaceConfigError(f"Ambiguous workspace target: {target}")


def _default_config_path() -> Path:
    env_path = os.environ.get("WSV2_CONFIG_PATH")
    if env_path:
        return Path(env_path).expanduser()

    candidates = [
        V2_CONFIG_PATH,
        Path.home() / "ai-workflow" / "workspace-v2" / "catalog" / "workspaces.v2.json",
        LEGACY_CONFIG_PATH,
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]


def _normalize_settings(raw_settings: dict) -> SettingsRecord:
    terminals = raw_settings.get("terminals") or []
    normalized_terminals = tuple(str(item).strip() for item in terminals if str(item).strip())
    terminal = str(raw_settings.get("terminal") or "xfce4-terminal").strip() or "xfce4-terminal"
    shell = str(raw_settings.get("shell") or "/bin/bash").strip() or "/bin/bash"
    return SettingsRecord(terminal=terminal, terminals=normalized_terminals, shell=shell)


def _normalize_legacy_hosts(raw_hosts: list[dict]) -> tuple[HostRecord, ...]:
    hosts = []
    saw_local = False
    for raw_host in raw_hosts:
        host = HostRecord(
            id=str(raw_host.get("id") or "").strip() or "local",
            name=str(raw_host.get("name") or raw_host.get("id") or "Local").strip(),
            ssh=str(raw_host["ssh"]).strip() if raw_host.get("ssh") else None,
        )
        if host.id == "local":
            saw_local = True
        hosts.append(host)

    if not saw_local:
        hosts.insert(0, HostRecord(id="local", name="Local", ssh=None))

    return tuple(hosts)


def _normalize_v2_hosts(raw_hosts: list[dict]) -> tuple[HostRecord, ...]:
    hosts = []
    for raw_host in raw_hosts:
        hosts.append(
            HostRecord(
                id=str(raw_host.get("id") or "").strip(),
                name=str(raw_host.get("name") or raw_host.get("id") or "").strip(),
                ssh=str(raw_host["ssh"]).strip() if raw_host.get("ssh") else None,
                hostnames=tuple(
                    str(item).strip()
                    for item in (raw_host.get("hostnames") or [])
                    if str(item).strip()
                ),
                legacy_ids=tuple(
                    str(item).strip()
                    for item in (raw_host.get("legacy_ids") or [])
                    if str(item).strip()
                ),
            )
        )
    return tuple(hosts)


def _runtime_identity_tokens() -> set[str]:
    tokens = set()
    hostnames = [socket.gethostname(), socket.getfqdn(), os.uname().nodename]
    for value in hostnames:
        if not value:
            continue
        tokens.add(value.lower())
        tokens.add(value.split(".", 1)[0].lower())
    return {token for token in tokens if token}


def _resolve_self_host_id(payload: dict, hosts: tuple[HostRecord, ...]) -> str | None:
    env_name = str(payload.get("self_host_env") or "WSV2_SELF_HOST")
    env_value = os.environ.get(env_name)
    if env_value:
        for host in hosts:
            if host.matches_id(env_value):
                return host.id
        raise WorkspaceConfigError(f"{env_name}={env_value} does not match any configured host")

    tokens = _runtime_identity_tokens()
    matches = [host.id for host in hosts if host.matches_runtime_identity(tokens)]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise WorkspaceConfigError(
            f"Unable to resolve a unique self host from runtime identity: {', '.join(matches)}"
        )
    return None


def _resolve_workspace_host(raw_host_id: str, host_lookup: dict[str, HostRecord]) -> HostRecord | None:
    if raw_host_id in host_lookup:
        return host_lookup[raw_host_id]
    for host in host_lookup.values():
        if host.matches_id(raw_host_id):
            return host
    return None


def _normalize_workspaces(
    raw_workspaces: list[dict],
    host_lookup: dict[str, HostRecord],
    *,
    strict_hosts: bool = True,
) -> tuple[WorkspaceRecord, ...]:
    workspaces = []
    for raw_workspace in raw_workspaces:
        host_id = str(raw_workspace.get("host") or "local").strip() or "local"
        host = _resolve_workspace_host(host_id, host_lookup)
        if not host:
            if not strict_hosts:
                continue
            raise WorkspaceConfigError(f"Unknown host id in workspace catalog: {host_id}")
        workspace_id = str(raw_workspace.get("id") or "").strip()
        if not workspace_id:
            continue
        raw_path = str(raw_workspace.get("path") or str(Path.home()))
        workspaces.append(
            WorkspaceRecord(
                id=workspace_id,
                name=str(raw_workspace.get("name") or raw_workspace.get("id") or "").strip(),
                path=os.path.expanduser(raw_path),
                raw_path=raw_path,
                color=str(raw_workspace.get("color") or "#3498db"),
                icon=str(raw_workspace.get("icon") or "folder"),
                description=str(raw_workspace.get("description") or "").strip(),
                host_id=host.id,
                host=host,
            )
        )
    return tuple(workspaces)


def _optional_json_file(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def _legacy_config_candidates(config_path: Path) -> list[Path]:
    env_path = os.environ.get("WSV2_LEGACY_CONFIG_PATH")
    candidates = []
    if env_path:
        candidates.append(Path(env_path).expanduser())
    candidates.extend(
        [
            PACKAGE_ROOT.parent / "workspace-switcher" / "workspaces.json",
            Path.home() / "ai-workflow" / "workspace-switcher" / "workspaces.json",
            LEGACY_CONFIG_PATH,
        ]
    )
    return _dedupe_paths(path for path in candidates if path != config_path)


def _dedupe_paths(paths: Iterable[Path]) -> list[Path]:
    seen = set()
    deduped = []
    for path in paths:
        key = str(path.expanduser())
        if key in seen:
            continue
        seen.add(key)
        deduped.append(Path(key))
    return deduped


def _load_legacy_workspaces(config_path: Path, host_lookup: dict[str, HostRecord]) -> tuple[WorkspaceRecord, ...]:
    for candidate in _legacy_config_candidates(config_path):
        payload = _optional_json_file(candidate)
        if payload is None:
            continue
        return _normalize_workspaces(payload.get("workspaces") or [], host_lookup, strict_hosts=False)
    return ()


def _archive_path() -> Path:
    env_path = os.environ.get("WSV2_SESSION_ARCHIVE_PATH")
    if env_path:
        return Path(env_path).expanduser()
    return SESSION_ARCHIVE_PATH


def _include_archive_workspaces() -> bool:
    value = os.environ.get("WSV2_INCLUDE_ARCHIVE_WORKSPACES", "1").strip().lower()
    return value not in {"0", "false", "no", "off"}


def _format_archived_workspace_name(session_id: str) -> str:
    return (session_id.replace("-", " ").replace("_", " ").strip() or session_id).title()


def _load_archive_workspaces(host_lookup: dict[str, HostRecord]) -> tuple[WorkspaceRecord, ...]:
    if not _include_archive_workspaces():
        return ()
    payload = _optional_json_file(_archive_path())
    if payload is None:
        return ()

    selected: dict[tuple[str, str], tuple[int, dict[str, Any]]] = {}
    for record in payload.get("records") or []:
        tmux_data = record.get("tmux") or {}
        session_id = str(tmux_data.get("session") or "").strip()
        if not session_id:
            continue
        host = _resolve_workspace_host(str(record.get("hostId") or ""), host_lookup)
        if not host:
            continue
        score = max(
            int(record.get("activityAt") or 0),
            int(record.get("lastSeenAt") or 0),
            int(record.get("updatedAt") or 0),
        )
        key = (host.id, session_id)
        if key not in selected or score > selected[key][0]:
            selected[key] = (score, record)

    raw_workspaces = []
    for (host_id, session_id), (_, record) in selected.items():
        raw_workspaces.append(
            {
                "id": session_id,
                "name": _format_archived_workspace_name(session_id),
                "path": record.get("cwd") or (record.get("tmux") or {}).get("paneCwd") or str(Path.home()),
                "host": host_id,
                "color": "#64748b",
                "icon": "terminal",
                "description": "Archived tmux session",
            }
        )
    return _normalize_workspaces(raw_workspaces, host_lookup, strict_hosts=False)


def _merge_workspaces(*groups: Iterable[WorkspaceRecord]) -> tuple[WorkspaceRecord, ...]:
    merged: list[WorkspaceRecord] = []
    seen: set[tuple[str, str]] = set()
    for group in groups:
        for workspace in group:
            key = (workspace.host_id, workspace.id)
            if key in seen:
                continue
            seen.add(key)
            merged.append(workspace)
    return tuple(merged)


def load_config(path: str | Path | None = None) -> WorkspaceConfig:
    explicit_path = path is not None
    config_path = Path(path or _default_config_path()).expanduser()
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise WorkspaceConfigError(f"Workspace config not found: {config_path}") from error
    except json.JSONDecodeError as error:
        raise WorkspaceConfigError(f"Invalid workspace config: {config_path}") from error

    schema_version = int(payload.get("version") or 1)
    settings = _normalize_settings(payload.get("settings") or {})

    if schema_version >= 2:
        hosts = _normalize_v2_hosts(payload.get("hosts") or [])
        if not hosts:
            raise WorkspaceConfigError("V2 workspace catalog has no hosts")
        self_host_id = _resolve_self_host_id(payload, hosts)
    else:
        hosts = _normalize_legacy_hosts(payload.get("hosts") or [])
        self_host_id = "local"

    host_lookup = {host.id: host for host in hosts}
    workspaces = _normalize_workspaces(payload.get("workspaces") or [], host_lookup)
    if schema_version >= 2 and not explicit_path:
        workspaces = _merge_workspaces(
            workspaces,
            _load_legacy_workspaces(config_path, host_lookup),
            _load_archive_workspaces(host_lookup),
        )

    return WorkspaceConfig(
        path=config_path,
        hosts=hosts,
        workspaces=workspaces,
        settings=settings,
        self_host_id=self_host_id,
        schema_version=schema_version,
    )
