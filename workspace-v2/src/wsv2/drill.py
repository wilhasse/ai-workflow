from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import uuid

from .catalog import WorkspaceConfig, WorkspaceRecord, load_config

UNREACHABLE_SSH_TARGET = 'cslog@127.0.0.254'


@dataclass(slots=True)
class ProbeResult:
    target: str
    host_id: str
    success: bool
    detail: str


def build_simulated_outage_payload(config_path: str | Path, down_host_ids: list[str]) -> dict:
    payload = json.loads(Path(config_path).read_text(encoding='utf-8'))
    for host in payload.get('hosts', []):
        if host.get('id') in down_host_ids and host.get('ssh'):
            host['ssh'] = UNREACHABLE_SSH_TARGET
    return payload


def write_simulated_outage_config(config_path: str | Path, down_host_ids: list[str]) -> str:
    payload = build_simulated_outage_payload(config_path, down_host_ids)
    handle = tempfile.NamedTemporaryFile(prefix='wsv2-outage-', suffix='.json', delete=False)
    Path(handle.name).write_text(json.dumps(payload, indent=2), encoding='utf-8')
    handle.close()
    return handle.name


@contextmanager
def temporary_self_host(host_id: str):
    original = os.environ.get('WSV2_SELF_HOST')
    os.environ['WSV2_SELF_HOST'] = host_id
    try:
        yield
    finally:
        if original is None:
            os.environ.pop('WSV2_SELF_HOST', None)
        else:
            os.environ['WSV2_SELF_HOST'] = original


def select_probe_targets(config: WorkspaceConfig, down_host_ids: list[str]) -> list[WorkspaceRecord]:
    down = set(down_host_ids)
    chosen: dict[str, WorkspaceRecord] = {}
    for workspace in config.workspaces:
        if workspace.host_id in down:
            continue
        if workspace.host_id not in chosen:
            chosen[workspace.host_id] = workspace
    return list(chosen.values())


def _local_probe_command(workspace: WorkspaceRecord) -> str:
    session_name = f'wsv2-probe-{uuid.uuid4().hex[:8]}'
    return (
        f"tmux new-session -d -s {shlex.quote(session_name)} -c {shlex.quote(workspace.path)} && "
        f"tmux kill-session -t {shlex.quote(session_name)}"
    )


def _remote_probe_command(workspace: WorkspaceRecord) -> list[str]:
    session_name = f'wsv2-probe-{uuid.uuid4().hex[:8]}'
    remote_cmd = (
        f"tmux new-session -d -s {shlex.quote(session_name)} -c {shlex.quote(workspace.path)} && "
        f"tmux kill-session -t {shlex.quote(session_name)}"
    )
    return [
        'ssh',
        '-o',
        'ConnectTimeout=5',
        '-o',
        'BatchMode=yes',
        workspace.host.ssh or '',
        remote_cmd,
    ]


def probe_workspace(config: WorkspaceConfig, workspace: WorkspaceRecord) -> ProbeResult:
    if config.host_runs_local(workspace.host_id):
        result = subprocess.run(
            ['bash', '-lc', _local_probe_command(workspace)],
            capture_output=True,
            text=True,
        )
    else:
        result = subprocess.run(
            _remote_probe_command(workspace),
            capture_output=True,
            text=True,
        )
    success = result.returncode == 0
    detail = result.stderr.strip() or result.stdout.strip() or ('ok' if success else 'probe failed')
    return ProbeResult(
        target=workspace.target,
        host_id=workspace.host_id,
        success=success,
        detail=detail,
    )


def run_outage_drill(
    *,
    config_path: str | Path,
    control_host_id: str,
    down_host_ids: list[str],
    explicit_targets: list[str] | None = None,
) -> tuple[WorkspaceConfig, list[ProbeResult], str]:
    simulated_path = write_simulated_outage_config(config_path, down_host_ids)
    with temporary_self_host(control_host_id):
        config = load_config(simulated_path)
        if explicit_targets:
            workspaces = [config.resolve_workspace(target) for target in explicit_targets]
        else:
            workspaces = select_probe_targets(config, down_host_ids)
        results = [probe_workspace(config, workspace) for workspace in workspaces]
    return config, results, simulated_path
