from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import shlex
import shutil
import subprocess
from typing import Iterable

from .catalog import HostRecord, WorkspaceConfigError, WorkspaceRecord, load_config
from .state import LauncherState


@dataclass(slots=True, frozen=True)
class WorkspaceStatus:
    workspace: WorkspaceRecord
    active: bool = False
    reachable: bool | None = True

    @property
    def recent_key(self) -> str:
        return self.workspace.target


@dataclass(slots=True, frozen=True)
class TerminalStatus:
    host_id: str
    host: HostRecord
    session_id: str
    window_index: int
    window_name: str
    window_active: bool = False
    activity: int = 0
    pane_count: int = 0
    reachable: bool | None = True
    workspace: WorkspaceRecord | None = None

    @property
    def discovered(self) -> bool:
        return self.workspace is None

    @property
    def workspace_name(self) -> str:
        if self.workspace:
            return self.workspace.name
        return _format_discovered_name(self.session_id)

    @property
    def display_path(self) -> str:
        if self.workspace:
            return self.workspace.display_path
        return "Discovered tmux session"

    @property
    def active(self) -> bool:
        return self.reachable is not False and self.window_index > 0

    @property
    def target(self) -> str:
        if self.window_index <= 0 and self.workspace:
            return self.workspace.target
        return f"{self.host_id}:{self.session_id}#{self.window_index}"

    @property
    def recent_key(self) -> str:
        return self.target

    @property
    def searchable_text(self) -> str:
        return " ".join(
            [
                self.host_id,
                self.host.name,
                self.session_id,
                self.workspace_name,
                str(self.window_index),
                f"#{self.window_index}",
                self.window_name,
                self.display_path,
            ]
        ).lower()


@dataclass(slots=True, frozen=True)
class TerminalTarget:
    host_id: str | None
    session_id: str
    window_index: int | None


def _format_discovered_name(session_id: str) -> str:
    parts = [part for part in str(session_id).replace("_", "-").split("-") if part]
    return " ".join(part[:1].upper() + part[1:] for part in parts) or str(session_id)


def parse_terminal_target(target: str) -> TerminalTarget | None:
    if "#" not in target:
        return None
    left, window_raw = target.rsplit("#", 1)
    try:
        window_index = int(window_raw)
    except ValueError:
        return None
    host_id = None
    session_id = left
    if ":" in left:
        host_id, session_id = left.split(":", 1)
    if not session_id:
        return None
    return TerminalTarget(host_id=host_id or None, session_id=session_id, window_index=window_index)


def build_attach_command(
    workspace: WorkspaceRecord,
    *,
    run_local: bool,
    within_tmux: bool = False,
) -> str:
    session_name = shlex.quote(workspace.id)
    work_dir = shlex.quote(workspace.path)

    if run_local and within_tmux:
        return (
            f"tmux has-session -t {session_name} 2>/dev/null || "
            f"tmux new-session -d -s {session_name} -c {work_dir}; "
            f"tmux switch-client -t {session_name}"
        )

    if run_local:
        return (
            f"tmux attach-session -t {session_name} || "
            f"tmux new-session -s {session_name} -c {work_dir}"
        )

    ssh_target = shlex.quote(workspace.host.ssh or "")
    remote_tmux_cmd = (
        f"tmux attach -t {session_name} || "
        f"tmux new -s {session_name} -c {work_dir}"
    )
    return (
        "ssh -t -o ServerAliveInterval=60 -o ServerAliveCountMax=3 "
        f"{ssh_target} {shlex.quote(remote_tmux_cmd)}"
    )


def build_terminal_attach_command(
    host: HostRecord,
    *,
    session_id: str,
    window_index: int | None = None,
    run_local: bool,
    within_tmux: bool = False,
) -> str:
    session_name = shlex.quote(session_id)
    target = shlex.quote(f"{session_id}:{window_index}") if window_index is not None else session_name

    if run_local and within_tmux:
        return (
            f"tmux has-session -t {session_name} 2>/dev/null || "
            f"tmux new-session -d -s {session_name}; "
            f"tmux switch-client -t {target}"
        )

    if run_local:
        return (
            f"tmux select-window -t {target} 2>/dev/null || true; "
            f"tmux attach-session -t {session_name}"
        )

    ssh_target = shlex.quote(host.ssh or "")
    remote_tmux_cmd = (
        f"tmux select-window -t {target} 2>/dev/null || true; "
        f"tmux attach -t {session_name}"
    )
    return (
        "ssh -t -o ServerAliveInterval=60 -o ServerAliveCountMax=3 "
        f"{ssh_target} {shlex.quote(remote_tmux_cmd)}"
    )


def build_workspace_command(workspace: WorkspaceRecord, *, run_local: bool) -> str:
    return build_attach_command(workspace, run_local=run_local, within_tmux=False)


def build_terminal_command(terminal: str, inner_command: str, title: str) -> list[str]:
    script = f"{inner_command}; exec bash"
    name = Path(terminal).name
    if name == "xfce4-terminal":
        return [
            terminal,
            "--disable-server",
            "--window",
            "--title",
            title,
            "-x",
            "bash",
            "-lc",
            script,
        ]
    if name == "gnome-terminal":
        return [terminal, "--title", title, "--", "bash", "-lc", script]
    if name == "konsole":
        return [terminal, "--separate", "-e", "bash", "-lc", script]
    escaped_script = script.replace('"', r'\"')
    return [terminal, "-e", f'bash -lc "{escaped_script}"']


class WorkspaceActions:
    def __init__(
        self,
        config_path: str | Path | None = None,
        state_path: str | Path | None = None,
    ) -> None:
        self.config_path = config_path
        self.state = LauncherState(state_path) if state_path else LauncherState()
        self.config = load_config(config_path)

    def reload_config(self):
        self.config = load_config(self.config_path)
        return self.config

    def resolve_workspace(self, target: str) -> WorkspaceRecord:
        return self.config.resolve_workspace(target)

    def list_workspace_statuses(self) -> list[WorkspaceStatus]:
        host_sessions: dict[str, set[str]] = {}
        host_reachability: dict[str, bool | None] = {}

        for host in self.config.hosts:
            if self.config.host_runs_local(host):
                host_sessions[host.id] = self._list_local_sessions()
                host_reachability[host.id] = True
                continue

            sessions, reachable = self._list_remote_sessions(host.ssh or "")
            host_sessions[host.id] = sessions
            host_reachability[host.id] = reachable

        return [
            WorkspaceStatus(
                workspace=workspace,
                active=workspace.id in host_sessions.get(workspace.host_id, set()),
                reachable=host_reachability.get(workspace.host_id, None),
            )
            for workspace in self.config.workspaces
        ]

    def list_terminal_statuses(self) -> list[TerminalStatus]:
        statuses: list[TerminalStatus] = []
        workspace_lookup = {(workspace.host_id, workspace.id): workspace for workspace in self.config.workspaces}
        workspace_by_session: dict[str, WorkspaceRecord] = {}
        for workspace in self.config.workspaces:
            workspace_by_session.setdefault(workspace.id, workspace)

        for host in self.config.hosts:
            if self.config.host_runs_local(host):
                windows, reachable = self._list_local_windows(), True
            else:
                windows, reachable = self._list_remote_windows(host.ssh or "")
            if reachable is False:
                for workspace in [item for item in self.config.workspaces if item.host_id == host.id]:
                    statuses.append(
                        TerminalStatus(
                            host_id=host.id,
                            host=host,
                            session_id=workspace.id,
                            window_index=0,
                            window_name=workspace.name,
                            reachable=False,
                            workspace=workspace,
                        )
                    )
                continue

            seen_configured: set[str] = set()
            for window in windows:
                workspace = workspace_lookup.get((host.id, window["session_id"]))
                if workspace is None:
                    workspace = workspace_by_session.get(window["session_id"])
                if workspace:
                    seen_configured.add(workspace.id)
                statuses.append(
                    TerminalStatus(
                        host_id=host.id,
                        host=host,
                        session_id=window["session_id"],
                        window_index=window["window_index"],
                        window_name=window["window_name"],
                        window_active=window["window_active"],
                        activity=window["activity"],
                        pane_count=window["pane_count"],
                        reachable=True,
                        workspace=workspace,
                    )
                )

            # Keep inactive configured workspaces visible for launch/create behavior.
            active_sessions = {window["session_id"] for window in windows}
            for workspace in [item for item in self.config.workspaces if item.host_id == host.id]:
                if workspace.id in active_sessions:
                    continue
                statuses.append(
                    TerminalStatus(
                        host_id=host.id,
                        host=host,
                        session_id=workspace.id,
                        window_index=0,
                        window_name=workspace.name,
                        reachable=True,
                        workspace=workspace,
                    )
                )

        return sorted(
            statuses,
            key=lambda status: (
                -(status.activity or 0),
                not status.window_active,
                status.host.name.lower(),
                status.workspace_name.lower(),
                status.window_index,
            ),
        )

    def workspace_command(self, target: str, *, within_tmux: bool = False) -> str:
        terminal_target = parse_terminal_target(target)
        if terminal_target:
            host_id = self.config.normalize_host_id(terminal_target.host_id) or self.config.self_host_id
            if not host_id:
                raise WorkspaceConfigError(f"Host is required for terminal target: {target}")
            host = self.config.get_host(host_id)
            return build_terminal_attach_command(
                host,
                session_id=terminal_target.session_id,
                window_index=terminal_target.window_index,
                run_local=self.config.host_runs_local(host_id),
                within_tmux=within_tmux,
            )

        workspace = self.resolve_workspace(target)
        return build_attach_command(
            workspace,
            run_local=self.config.host_runs_local(workspace.host_id),
            within_tmux=within_tmux,
        )

    def open_workspace(self, target: str, focus_existing: bool = True) -> str:
        terminal_target = parse_terminal_target(target)
        if terminal_target:
            host_id = self.config.normalize_host_id(terminal_target.host_id) or self.config.self_host_id
            if not host_id:
                raise WorkspaceConfigError(f"Host is required for terminal target: {target}")
            title = f"{terminal_target.session_id}:{terminal_target.window_index}"
            if focus_existing and self.focus_workspace_window(terminal_target.session_id):
                self.state.mark_recent(target)
                return "focused"
            terminal = self._resolve_terminal()
            command = self.workspace_command(target, within_tmux=False)
            subprocess.Popen(build_terminal_command(terminal, command, title))
            self.state.mark_recent(target)
            return "launched"

        workspace = self.resolve_workspace(target)
        if focus_existing and self.focus_workspace_window(workspace.id):
            self.state.mark_recent(workspace.target)
            return "focused"

        terminal = self._resolve_terminal()
        command = self.workspace_command(target, within_tmux=False)
        subprocess.Popen(build_terminal_command(terminal, command, workspace.id))
        self.state.mark_recent(workspace.target)
        return "launched"

    def attach_workspace(self, target: str, *, replace_process: bool = True) -> int:
        terminal_target = parse_terminal_target(target)
        if terminal_target:
            command = self.workspace_command(
                target,
                within_tmux=bool(os.environ.get("TMUX")),
            )
            self.state.mark_recent(target)
        else:
            workspace = self.resolve_workspace(target)
            command = self.workspace_command(
                target,
                within_tmux=bool(os.environ.get("TMUX")) and self.config.host_runs_local(workspace.host_id),
            )
            self.state.mark_recent(workspace.target)
        if replace_process:
            os.execvp("bash", ["bash", "-lc", command])
            raise AssertionError("os.execvp should not return")
        result = subprocess.run(["bash", "-lc", command])
        return result.returncode

    def kill_workspace(self, target: str) -> bool:
        workspace = self.resolve_workspace(target)
        session_name = workspace.id
        if self.config.host_runs_local(workspace.host_id):
            result = subprocess.run(
                ["tmux", "kill-session", "-t", session_name],
                capture_output=True,
                text=True,
            )
            return result.returncode == 0

        result = subprocess.run(
            ["ssh", workspace.host.ssh or "", f"tmux kill-session -t {shlex.quote(session_name)}"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.returncode == 0

    def focus_workspace_window(self, session_id: str) -> bool:
        wmctrl_path = shutil.which("wmctrl")
        if not wmctrl_path:
            return False

        try:
            result = subprocess.run(
                [wmctrl_path, "-l"],
                capture_output=True,
                text=True,
                timeout=2,
            )
        except (subprocess.TimeoutExpired, OSError):
            return False

        if result.returncode != 0:
            return False

        search_terms = (f"{session_id} :", session_id)
        for line in result.stdout.splitlines():
            if any(term in line for term in search_terms):
                window_id = line.split(maxsplit=1)[0]
                subprocess.run([wmctrl_path, "-i", "-a", window_id], capture_output=True)
                return True
        return False

    def _resolve_terminal(self) -> str:
        candidates: list[str] = [self.config.settings.terminal]
        candidates.extend(self.config.settings.terminals)
        candidates.extend(["xfce4-terminal", "konsole", "gnome-terminal", "x-terminal-emulator"])

        seen: set[str] = set()
        for candidate in candidates:
            candidate = candidate.strip()
            if not candidate or candidate in seen:
                continue
            seen.add(candidate)
            if shutil.which(candidate):
                return candidate
        raise WorkspaceConfigError("No supported terminal emulator found in PATH")

    def _list_local_sessions(self) -> set[str]:
        try:
            result = subprocess.run(
                ["tmux", "list-sessions", "-F", "#S"],
                capture_output=True,
                text=True,
                timeout=4,
                env={**os.environ, "TMUX": ""},
            )
        except (subprocess.TimeoutExpired, OSError):
            return set()

        if result.returncode not in (0, 1):
            return set()
        return _parse_session_names(result.stdout.splitlines())

    def _list_remote_sessions(self, ssh_target: str) -> tuple[set[str], bool]:
        try:
            result = subprocess.run(
                [
                    "ssh",
                    "-o",
                    "ConnectTimeout=2",
                    "-o",
                    "BatchMode=yes",
                    ssh_target,
                    'tmux list-sessions -F "#{session_name}" 2>/dev/null || true',
                ],
                capture_output=True,
                text=True,
                timeout=5,
            )
        except (subprocess.TimeoutExpired, OSError):
            return set(), False

        if result.returncode != 0:
            return set(), False
        return _parse_session_names(result.stdout.splitlines()), True

    def _list_local_windows(self) -> list[dict]:
        try:
            result = subprocess.run(
                ["tmux", "list-windows", "-a", "-F", _WINDOW_FORMAT],
                capture_output=True,
                text=True,
                timeout=5,
                env={**os.environ, "TMUX": ""},
            )
        except (subprocess.TimeoutExpired, OSError):
            return []
        if result.returncode not in (0, 1):
            return []
        return _parse_windows(result.stdout.splitlines())

    def _list_remote_windows(self, ssh_target: str) -> tuple[list[dict], bool]:
        try:
            result = subprocess.run(
                [
                    "ssh",
                    "-o",
                    "ConnectTimeout=2",
                    "-o",
                    "BatchMode=yes",
                    ssh_target,
                    f"tmux list-windows -a -F {shlex.quote(_WINDOW_FORMAT)} 2>/dev/null || true",
                ],
                capture_output=True,
                text=True,
                timeout=8,
            )
        except (subprocess.TimeoutExpired, OSError):
            return [], False
        if result.returncode != 0:
            return [], False
        return _parse_windows(result.stdout.splitlines()), True


_WINDOW_FORMAT = "#{session_name}|#{window_index}|#{window_name}|#{window_active}|#{window_activity}|#{window_panes}"


def _parse_session_names(lines: Iterable[str]) -> set[str]:
    return {line.strip() for line in lines if line.strip()}


def _parse_windows(lines: Iterable[str]) -> list[dict]:
    windows = []
    for line in lines:
        if not line.strip() or "|" not in line:
            continue
        parts = line.split("|")
        if len(parts) < 6:
            continue
        session_id, index, name, active, activity, panes = parts[:6]
        try:
            window_index = int(index)
        except ValueError:
            continue
        try:
            activity_value = int(activity) if activity else 0
        except ValueError:
            activity_value = 0
        try:
            pane_count = int(panes) if panes else 0
        except ValueError:
            pane_count = 0
        windows.append(
            {
                "session_id": session_id,
                "window_index": window_index,
                "window_name": name or f"window-{window_index}",
                "window_active": active == "1",
                "activity": activity_value,
                "pane_count": pane_count,
            }
        )
    return windows
