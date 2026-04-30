from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import time
from typing import Any, Iterable


PARK_STATE_PATH = Path.home() / ".local" / "state" / "ai-workflow" / "codex-parked.json"
PANE_FORMAT = (
    "#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}\t"
    "#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}"
)


class CodexParkingError(RuntimeError):
    """Raised when Codex/Claude process parking cannot be completed."""


@dataclass(slots=True, frozen=True)
class AgentTarget:
    session_id: str | None = None
    window_index: int | None = None


def parse_agent_target(value: str | None) -> AgentTarget | None:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw or raw in {"*", "all"}:
        return None

    if "#" in raw:
        session_id, window_raw = raw.rsplit("#", 1)
    elif ":" in raw and raw.rsplit(":", 1)[1].isdigit():
        session_id, window_raw = raw.rsplit(":", 1)
    else:
        return AgentTarget(session_id=raw)

    session_id = session_id.strip()
    if not session_id:
        raise CodexParkingError(f"Invalid tmux target: {value}")
    try:
        window_index = int(window_raw)
    except ValueError as error:
        raise CodexParkingError(f"Invalid tmux window target: {value}") from error
    return AgentTarget(session_id=session_id, window_index=window_index)


def list_agent_processes(
    target: str | AgentTarget | None = None,
    *,
    host_id: str | None = None,
    host_name: str | None = None,
) -> list[dict[str, Any]]:
    target_filter = target if isinstance(target, AgentTarget) else parse_agent_target(target)
    panes = _list_tmux_panes()
    processes = _process_table()
    children = _children_by_parent(processes)
    parked_state = _load_state()
    parked_groups = {
        int(record.get("processGroupId"))
        for record in parked_state.get("records", [])
        if str(record.get("processGroupId") or "").lstrip("-").isdigit()
    }

    rows: list[dict[str, Any]] = []
    for pane in panes:
        if not _target_matches_pane(pane, target_filter):
            continue
        descendant_ids = _descendant_pids(int(pane["panePid"]), children)
        group_matches: dict[int, dict[str, Any]] = {}
        for pid in descendant_ids:
            process = processes.get(pid)
            if not process:
                continue
            kind = _agent_kind(process)
            if not kind:
                continue
            pgid = int(process["pgid"])
            group = group_matches.setdefault(
                pgid,
                {
                    "kinds": set(),
                    "agentPids": set(),
                    "commands": [],
                },
            )
            group["kinds"].add(kind)
            group["agentPids"].add(pid)
            command = str(process.get("args") or process.get("comm") or "")
            if command and command not in group["commands"]:
                group["commands"].append(command)

        for pgid, group in group_matches.items():
            group_pids = sorted(
                pid
                for pid in descendant_ids
                if processes.get(pid) and int(processes[pid]["pgid"]) == pgid
            )
            parked = pgid in parked_groups or any(
                "T" in str(processes.get(pid, {}).get("stat") or "")
                for pid in group_pids
            )
            rows.append(
                {
                    "hostId": host_id,
                    "hostName": host_name,
                    "session": pane["session"],
                    "windowIndex": pane["windowIndex"],
                    "windowName": pane["windowName"],
                    "paneIndex": pane["paneIndex"],
                    "paneId": pane["paneId"],
                    "panePid": pane["panePid"],
                    "cwd": pane["cwd"],
                    "kinds": sorted(group["kinds"]),
                    "agentPids": sorted(group["agentPids"]),
                    "pids": group_pids,
                    "processGroupId": pgid,
                    "parked": parked,
                    "commands": group["commands"][:3],
                    "target": f"{pane['session']}#{pane['windowIndex']}",
                }
            )

    return sorted(
        rows,
        key=lambda row: (
            str(row.get("hostName") or row.get("hostId") or ""),
            str(row.get("session") or ""),
            int(row.get("windowIndex") or 0),
            int(row.get("paneIndex") or 0),
        ),
    )


def park_target(
    target: str | AgentTarget | None = None,
    *,
    host_id: str | None = None,
    host_name: str | None = None,
    reason: str = "manual",
) -> dict[str, Any]:
    rows = list_agent_processes(target, host_id=host_id, host_name=host_name)
    state = _load_state()
    records = [
        record
        for record in state.get("records", [])
        if not _record_matches_target(record, parse_agent_target(target) if isinstance(target, str) else target)
    ]

    changed = 0
    errors: list[str] = []
    current_pgid = os.getpgrp()
    now = time.time()
    for row in rows:
        pgid = int(row["processGroupId"])
        if pgid == current_pgid:
            errors.append(f"skipped current process group {pgid}")
            continue
        try:
            if not row.get("parked"):
                os.killpg(pgid, signal.SIGSTOP)
                changed += 1
        except ProcessLookupError:
            continue
        except PermissionError as error:
            errors.append(f"{row['target']}: {error}")
            continue
        records.append(
            {
                "hostId": host_id,
                "hostName": host_name,
                "session": row["session"],
                "windowIndex": row["windowIndex"],
                "windowName": row["windowName"],
                "paneId": row["paneId"],
                "panePid": row["panePid"],
                "processGroupId": pgid,
                "pids": row["pids"],
                "agentPids": row["agentPids"],
                "kinds": row["kinds"],
                "cwd": row["cwd"],
                "target": row["target"],
                "reason": reason,
                "parkedAt": now,
            }
        )

    state["records"] = _dedupe_records(records)
    _save_state(state)
    time.sleep(0.1)
    refreshed_rows = _safe_list_agent_processes(target, host_id=host_id, host_name=host_name)
    return {"matched": len(rows), "changed": changed, "errors": errors, "rows": refreshed_rows or rows}


def unpark_target(
    target: str | AgentTarget | None = None,
    *,
    host_id: str | None = None,
    host_name: str | None = None,
) -> dict[str, Any]:
    target_filter = target if isinstance(target, AgentTarget) else parse_agent_target(target)
    rows = list_agent_processes(target_filter, host_id=host_id, host_name=host_name)
    state = _load_state()
    matching_records = [
        record
        for record in state.get("records", [])
        if _record_matches_target(record, target_filter)
    ]
    parked_rows = [row for row in rows if row.get("parked")]
    pgids = {
        int(row["processGroupId"])
        for row in parked_rows
        if str(row.get("processGroupId") or "").lstrip("-").isdigit()
    }
    pgids.update(
        int(record["processGroupId"])
        for record in matching_records
        if str(record.get("processGroupId") or "").lstrip("-").isdigit()
    )

    changed = 0
    errors: list[str] = []
    for pgid in sorted(pgids):
        try:
            os.killpg(pgid, signal.SIGCONT)
            changed += 1
        except ProcessLookupError:
            continue
        except PermissionError as error:
            errors.append(f"process group {pgid}: {error}")

    errors.extend(_foreground_tmux_panes(parked_rows, matching_records))

    state["records"] = [
        record
        for record in state.get("records", [])
        if not _record_matches_target(record, target_filter)
    ]
    _save_state(state)
    time.sleep(0.2)
    refreshed_rows = _safe_list_agent_processes(target_filter, host_id=host_id, host_name=host_name)
    return {
        "matched": len(pgids),
        "changed": changed,
        "errors": errors,
        "rows": refreshed_rows or rows,
    }


def format_agent_processes(rows: Iterable[dict[str, Any]]) -> str:
    rows = list(rows)
    if not rows:
        return "no Codex/Claude processes found in tmux panes"

    lines = []
    for row in rows:
        status = "PARKED" if row.get("parked") else "active"
        host = row.get("hostName") or row.get("hostId") or "local"
        kinds = "+".join(row.get("kinds") or ["agent"])
        pids = ",".join(str(pid) for pid in row.get("agentPids") or row.get("pids") or [])
        command = _shorten(" ; ".join(row.get("commands") or []), 58)
        lines.append(
            f"{status:<6} {host:<14} {row['session']}#{row['windowIndex']:<3} "
            f"{kinds:<12} pgid={row['processGroupId']:<8} pids={pids:<18} {command}"
        )
    return "\n".join(lines)


def build_remote_wsv2_command(
    subcommand: str,
    target: str | None,
    *,
    host_id: str,
    host_name: str | None = None,
    reason: str | None = None,
    json_output: bool = False,
    all_targets: bool = False,
) -> str:
    script = "~/ai-workflow/workspace-v2/scripts/wsv2"
    parts = [
        "cd ~/ai-workflow",
        "&&",
        f"WSV2_SELF_HOST={shlex.quote(host_id)}",
        script,
        "codex",
        subcommand,
    ]
    if target:
        parts.append(shlex.quote(target))
    if all_targets:
        parts.append("--all")
    parts.append("--local-only")
    parts.extend(["--host-id", shlex.quote(host_id)])
    if host_name:
        parts.extend(["--host-name", shlex.quote(host_name)])
    if reason:
        parts.extend(["--reason", shlex.quote(reason)])
    if json_output:
        parts.append("--json")
    return " ".join(parts)


def _list_tmux_panes() -> list[dict[str, Any]]:
    try:
        result = subprocess.run(
            ["tmux", "list-panes", "-a", "-F", PANE_FORMAT],
            capture_output=True,
            text=True,
            timeout=5,
            env={**os.environ, "TMUX": ""},
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise CodexParkingError(f"Unable to list tmux panes: {error}") from error

    if result.returncode not in (0, 1):
        raise CodexParkingError(result.stderr.strip() or "Unable to list tmux panes")

    panes = []
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 8:
            continue
        session, window_index, window_name, pane_index, pane_id, pane_pid, command, cwd = parts[:8]
        try:
            panes.append(
                {
                    "session": session,
                    "windowIndex": int(window_index),
                    "windowName": window_name or f"window-{window_index}",
                    "paneIndex": int(pane_index),
                    "paneId": pane_id,
                    "panePid": int(pane_pid),
                    "paneCommand": command,
                    "cwd": cwd,
                }
            )
        except ValueError:
            continue
    return panes


def _process_table() -> dict[int, dict[str, Any]]:
    try:
        result = subprocess.run(
            ["ps", "-eo", "pid=,ppid=,pgid=,stat=,comm=,args="],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise CodexParkingError(f"Unable to inspect process table: {error}") from error

    if result.returncode != 0:
        raise CodexParkingError(result.stderr.strip() or "Unable to inspect process table")

    processes: dict[int, dict[str, Any]] = {}
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 5)
        if len(parts) < 5:
            continue
        pid_raw, ppid_raw, pgid_raw, stat, comm = parts[:5]
        args = parts[5] if len(parts) > 5 else comm
        try:
            pid = int(pid_raw)
            processes[pid] = {
                "pid": pid,
                "ppid": int(ppid_raw),
                "pgid": int(pgid_raw),
                "stat": stat,
                "comm": comm,
                "args": args,
            }
        except ValueError:
            continue
    return processes


def _children_by_parent(processes: dict[int, dict[str, Any]]) -> dict[int, list[int]]:
    children: dict[int, list[int]] = {}
    for process in processes.values():
        children.setdefault(int(process["ppid"]), []).append(int(process["pid"]))
    return children


def _descendant_pids(root_pid: int, children: dict[int, list[int]]) -> set[int]:
    seen = {root_pid}
    stack = [root_pid]
    while stack:
        current = stack.pop()
        for child in children.get(current, []):
            if child in seen:
                continue
            seen.add(child)
            stack.append(child)
    return seen


def _agent_kind(process: dict[str, Any]) -> str | None:
    comm = Path(str(process.get("comm") or "")).name.lower()
    args = str(process.get("args") or "").lower()
    if (
        comm == "codex"
        or "@openai/codex" in args
        or "codex-linux" in args
        or "/usr/bin/codex" in args
        or "/usr/local/bin/codex" in args
        or args.startswith("codex ")
    ):
        return "codex"
    if (
        comm == "claude"
        or "claude-code" in args
        or "@anthropic-ai/claude" in args
        or "/usr/bin/claude" in args
        or "/usr/local/bin/claude" in args
        or args.startswith("claude ")
    ):
        return "claude"
    return None


def _target_matches_pane(pane: dict[str, Any], target: AgentTarget | None) -> bool:
    if target is None:
        return True
    if target.session_id and pane.get("session") != target.session_id:
        return False
    if target.window_index is not None and int(pane.get("windowIndex") or -1) != target.window_index:
        return False
    return True


def _record_matches_target(record: dict[str, Any], target: AgentTarget | None) -> bool:
    if target is None:
        return True
    if target.session_id and record.get("session") != target.session_id:
        return False
    if target.window_index is not None and int(record.get("windowIndex") or -1) != target.window_index:
        return False
    return True


def _safe_list_agent_processes(
    target: str | AgentTarget | None,
    *,
    host_id: str | None = None,
    host_name: str | None = None,
) -> list[dict[str, Any]]:
    try:
        return list_agent_processes(target, host_id=host_id, host_name=host_name)
    except CodexParkingError:
        return []


def _foreground_tmux_panes(rows: Iterable[dict[str, Any]], records: Iterable[dict[str, Any]]) -> list[str]:
    pane_ids = []
    for item in [*rows, *records]:
        pane_id = str(item.get("paneId") or "").strip()
        if pane_id and pane_id not in pane_ids:
            pane_ids.append(pane_id)

    errors = []
    for pane_id in pane_ids:
        try:
            subprocess.run(
                ["tmux", "send-keys", "-t", pane_id, "C-c"],
                capture_output=True,
                text=True,
                timeout=3,
                env={**os.environ, "TMUX": ""},
            )
            time.sleep(0.05)
            result = subprocess.run(
                ["tmux", "send-keys", "-t", pane_id, "fg", "Enter"],
                capture_output=True,
                text=True,
                timeout=3,
                env={**os.environ, "TMUX": ""},
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            errors.append(f"{pane_id}: unable to foreground job: {error}")
            continue
        if result.returncode not in (0, 1):
            errors.append(result.stderr.strip() or f"{pane_id}: unable to foreground job")
    return errors


def _load_state() -> dict[str, Any]:
    try:
        payload = json.loads(PARK_STATE_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {"records": []}
    if not isinstance(payload, dict):
        return {"records": []}
    records = payload.get("records")
    if not isinstance(records, list):
        payload["records"] = []
    return payload


def _save_state(payload: dict[str, Any]) -> None:
    PARK_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp_path = PARK_STATE_PATH.with_suffix(".tmp")
    temp_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    temp_path.replace(PARK_STATE_PATH)


def _dedupe_records(records: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    selected: dict[tuple[str | None, str, int, int], dict[str, Any]] = {}
    for record in records:
        key = (
            record.get("hostId"),
            str(record.get("session") or ""),
            int(record.get("windowIndex") or 0),
            int(record.get("processGroupId") or 0),
        )
        selected[key] = record
    return list(selected.values())


def _shorten(value: str, width: int) -> str:
    value = " ".join(str(value).split())
    if len(value) <= width:
        return value
    return value[: max(0, width - 3)] + "..."
