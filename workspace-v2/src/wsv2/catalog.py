from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path


DEFAULT_CONFIG_PATH = Path(
    os.environ.get(
        "WSV2_CONFIG_PATH",
        Path.home() / "ai-workflow" / "workspace-switcher" / "workspaces.json",
    )
)


class WorkspaceConfigError(RuntimeError):
    """Raised when the workspace catalog cannot be loaded or resolved."""


@dataclass(slots=True, frozen=True)
class HostRecord:
    id: str
    name: str
    ssh: str | None = None

    @property
    def is_local(self) -> bool:
        return not self.ssh or self.id == "local"


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
        return self.id if self.host.is_local else f"{self.host_id}:{self.id}"

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

    def get_host(self, host_id: str) -> HostRecord:
        for host in self.hosts:
            if host.id == host_id:
                return host
        raise WorkspaceConfigError(f"Unknown host id: {host_id}")

    def resolve_workspace(self, target: str) -> WorkspaceRecord:
        host_id = None
        workspace_id = target
        if ":" in target:
            host_id, workspace_id = target.split(":", 1)

        matches = [
            workspace
            for workspace in self.workspaces
            if workspace.id == workspace_id and (host_id is None or workspace.host_id == host_id)
        ]
        if not matches:
            raise WorkspaceConfigError(f"Unknown workspace target: {target}")
        if len(matches) > 1:
            raise WorkspaceConfigError(f"Ambiguous workspace target: {target}")
        return matches[0]


def _normalize_hosts(raw_hosts: list[dict]) -> tuple[HostRecord, ...]:
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


def _normalize_settings(raw_settings: dict) -> SettingsRecord:
    terminals = raw_settings.get("terminals") or []
    normalized_terminals = tuple(str(item).strip() for item in terminals if str(item).strip())
    terminal = str(raw_settings.get("terminal") or "xfce4-terminal").strip() or "xfce4-terminal"
    shell = str(raw_settings.get("shell") or "/bin/bash").strip() or "/bin/bash"
    return SettingsRecord(terminal=terminal, terminals=normalized_terminals, shell=shell)


def load_config(path: str | Path | None = None) -> WorkspaceConfig:
    config_path = Path(path or DEFAULT_CONFIG_PATH).expanduser()
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise WorkspaceConfigError(f"Workspace config not found: {config_path}") from error
    except json.JSONDecodeError as error:
        raise WorkspaceConfigError(f"Invalid workspace config: {config_path}") from error

    hosts = _normalize_hosts(payload.get("hosts") or [])
    host_lookup = {host.id: host for host in hosts}
    settings = _normalize_settings(payload.get("settings") or {})

    workspaces = []
    for raw_workspace in payload.get("workspaces") or []:
        host_id = str(raw_workspace.get("host") or "local").strip() or "local"
        host = host_lookup.get(host_id, host_lookup["local"])
        raw_path = str(raw_workspace.get("path") or str(Path.home()))
        workspaces.append(
            WorkspaceRecord(
                id=str(raw_workspace.get("id") or "").strip(),
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

    return WorkspaceConfig(
        path=config_path,
        hosts=hosts,
        workspaces=tuple(workspaces),
        settings=settings,
    )
