from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import shlex
import shutil
import subprocess
from typing import Iterable

from .catalog import WorkspaceConfigError, WorkspaceRecord, load_config
from .state import LauncherState


@dataclass(slots=True, frozen=True)
class WorkspaceStatus:
    workspace: WorkspaceRecord
    active: bool = False
    reachable: bool | None = True

    @property
    def recent_key(self) -> str:
        return self.workspace.target


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

    def workspace_command(self, target: str, *, within_tmux: bool = False) -> str:
        workspace = self.resolve_workspace(target)
        return build_attach_command(
            workspace,
            run_local=self.config.host_runs_local(workspace.host_id),
            within_tmux=within_tmux,
        )

    def open_workspace(self, target: str, focus_existing: bool = True) -> str:
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


def _parse_session_names(lines: Iterable[str]) -> set[str]:
    return {line.strip() for line in lines if line.strip()}
