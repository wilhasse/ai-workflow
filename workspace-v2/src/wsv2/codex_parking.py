from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import time
import re
from typing import Any, Iterable

from .session_archive import build_local_resume_command, scan_local_host


PARK_STATE_PATH = Path.home() / ".local" / "state" / "ai-workflow" / "codex-parked.json"
RESUME_CAPTURE_LINES = 200
KNOWN_RESUME_FLAGS = {
    "codex": (
        "--dangerously-bypass-approvals-and-sandbox",
        "--full-auto",
    ),
    "claude": (
        "--dangerously-skip-permissions",
    ),
}
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
    state_records = [
        record
        for record in parked_state.get("records", [])
        if _record_matches_target(record, target_filter)
    ]
    legacy_parked_groups = {
        int(record.get("processGroupId"))
        for record in state_records
        if str(record.get("processGroupId") or "").lstrip("-").isdigit()
        and not record.get("resumeCommand")
    }

    rows: list[dict[str, Any]] = []
    active_keys: set[tuple[Any, ...]] = set()
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
            parked = pgid in legacy_parked_groups or any(
                "T" in str(processes.get(pid, {}).get("stat") or "")
                for pid in group_pids
            )
            row = {
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
            rows.append(row)
            active_keys.add(_state_record_key(row))

    for record in state_records:
        if _state_record_key(record) in active_keys:
            continue
        rows.append(_parked_record_to_row(record))

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
    active_rows = [row for row in rows if not row.get("parked")]
    state = _load_state()
    target_filter = target if isinstance(target, AgentTarget) else parse_agent_target(target)
    records = [
        record
        for record in state.get("records", [])
        if not _record_matches_target(record, target_filter)
    ]
    resume_candidates = _resume_candidates_for_rows(active_rows, host_id=host_id, host_name=host_name)

    changed = 0
    errors: list[str] = []
    now = time.time()
    for row in active_rows:
        before_candidates = resume_candidates.get(_row_identity(row), [])
        interrupt_errors = _interrupt_agent_row(row)
        if interrupt_errors:
            errors.extend(interrupt_errors)
            continue
        changed += 1
        parsed_records = _resume_records_from_pane_output(
            row,
            host_id=host_id,
            host_name=host_name,
            reason=reason,
            parked_at=now,
        )
        selected_records = parsed_records or [
            _archive_record_to_park_record(candidate, row, reason=reason, parked_at=now)
            for candidate in before_candidates
        ]
        if not selected_records:
            errors.append(f"{row['target']}: interrupted agent but no resume id was captured")
            continue
        records.extend(selected_records)

    state["records"] = _dedupe_records(records)
    _save_state(state)
    time.sleep(0.2)
    refreshed_rows = _safe_list_agent_processes(target, host_id=host_id, host_name=host_name)
    return {"matched": len(active_rows), "changed": changed, "errors": errors, "rows": refreshed_rows or rows}


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
    resume_records = [record for record in matching_records if record.get("resumeCommand")]
    legacy_records = [record for record in matching_records if not record.get("resumeCommand")]
    parked_rows = [row for row in rows if row.get("parked") and not row.get("resumeCommand")]
    pgids = {
        int(row["processGroupId"])
        for row in parked_rows
        if str(row.get("processGroupId") or "").lstrip("-").isdigit()
    }
    pgids.update(
        int(record["processGroupId"])
        for record in legacy_records
        if str(record.get("processGroupId") or "").lstrip("-").isdigit()
    )

    changed = 0
    errors: list[str] = []
    resumed_keys: set[tuple[Any, ...]] = set()
    for record in resume_records:
        try:
            _launch_resume_record(record)
            changed += 1
            resumed_keys.add(_state_record_key(record))
        except CodexParkingError as error:
            errors.append(f"{record.get('target') or record.get('session')}: {error}")

    for pgid in sorted(pgids):
        try:
            os.killpg(pgid, signal.SIGCONT)
            changed += 1
        except ProcessLookupError:
            continue
        except PermissionError as error:
            errors.append(f"process group {pgid}: {error}")

    errors.extend(_foreground_tmux_panes(parked_rows, legacy_records))

    state["records"] = [
        record
        for record in state.get("records", [])
        if not (
            _record_matches_target(record, target_filter)
            and (_state_record_key(record) in resumed_keys or not record.get("resumeCommand"))
        )
    ]
    _save_state(state)
    time.sleep(0.2)
    refreshed_rows = _safe_list_agent_processes(target_filter, host_id=host_id, host_name=host_name)
    return {
        "matched": len(resume_records) + len(pgids),
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
        pgid = row.get("processGroupId")
        pgid_label = str(pgid) if pgid not in (None, "") else "-"
        lines.append(
            f"{status:<6} {host:<14} {row['session']}#{row['windowIndex']:<3} "
            f"{kinds:<12} pgid={pgid_label:<8} pids={pids:<18} {command}"
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


def _resume_candidates_for_rows(
    rows: Iterable[dict[str, Any]],
    *,
    host_id: str | None,
    host_name: str | None,
) -> dict[tuple[str, int, str], list[dict[str, Any]]]:
    try:
        snapshot = scan_local_host(host_id=host_id or "local", host_name=host_name or host_id or "local")
    except Exception:
        return {}

    candidates: dict[tuple[str, int, str], list[dict[str, Any]]] = {}
    rows = list(rows)
    for row in rows:
        pane_id = str(row.get("paneId") or "")
        kinds = set(row.get("kinds") or [])
        matches = []
        for record in snapshot.get("records", []):
            tmux_data = record.get("tmux") or {}
            if pane_id and str(tmux_data.get("paneId") or "") != pane_id:
                continue
            if record.get("kind") not in kinds:
                continue
            matches.append(record)
        candidates[_row_identity(row)] = matches[:1]
    return candidates


def _interrupt_agent_row(row: dict[str, Any]) -> list[str]:
    pane_id = str(row.get("paneId") or "").strip()
    pgid = row.get("processGroupId")
    if not pane_id:
        return [f"{row.get('target')}: missing tmux pane id"]
    errors = []
    for attempt in range(2):
        try:
            result = subprocess.run(
                ["tmux", "send-keys", "-t", pane_id, "C-c"],
                capture_output=True,
                text=True,
                timeout=3,
                env={**os.environ, "TMUX": ""},
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            return [f"{row.get('target')}: unable to interrupt agent: {error}"]
        if result.returncode not in (0, 1):
            return [result.stderr.strip() or f"{row.get('target')}: unable to interrupt agent"]
        time.sleep(0.35)
        if _process_group_exited(pgid):
            return []
    if pgid not in (None, "") and not _process_group_exited(pgid):
        return [f"{row.get('target')}: agent still running after Ctrl-C"]
    return errors


def _resume_records_from_pane_output(
    row: dict[str, Any],
    *,
    host_id: str | None,
    host_name: str | None,
    reason: str,
    parked_at: float,
) -> list[dict[str, Any]]:
    pane_text = _capture_pane_text(str(row.get("paneId") or ""))
    if not pane_text:
        return []
    records = []
    for kind, resume_id in _extract_resume_commands(pane_text):
        if kind not in set(row.get("kinds") or []):
            continue
        record = _base_park_record(row, reason=reason, parked_at=parked_at)
        record.update(
            {
                "kind": kind,
                "kinds": [kind],
                "resumeId": resume_id,
                "resumeCommand": _build_resume_command(kind, str(row.get("cwd") or Path.home()), resume_id, row),
                "resumeSource": "pane-output",
                "parkMode": "resume-command",
            }
        )
        records.append(record)
    return _dedupe_records(records)


def _capture_pane_text(pane_id: str) -> str:
    if not pane_id:
        return ""
    try:
        result = subprocess.run(
            ["tmux", "capture-pane", "-p", "-t", pane_id, "-S", f"-{RESUME_CAPTURE_LINES}"],
            capture_output=True,
            text=True,
            timeout=3,
            env={**os.environ, "TMUX": ""},
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    if result.returncode not in (0, 1):
        return ""
    return result.stdout


def _extract_resume_commands(text: str) -> list[tuple[str, str]]:
    patterns = (
        ("codex", re.compile(r"\bcodex\s+resume\s+([A-Za-z0-9._:@/-]+)")),
        ("claude", re.compile(r"\bclaude\s+(?:--resume|resume)\s+([A-Za-z0-9._:@/-]+)")),
    )
    matches: list[tuple[int, str, str]] = []
    for kind, pattern in patterns:
        for match in pattern.finditer(text):
            matches.append((match.start(), kind, match.group(1).rstrip(".,;:")))
    matches.sort(key=lambda item: item[0], reverse=True)

    selected: dict[str, str] = {}
    for _, kind, resume_id in matches:
        selected.setdefault(kind, resume_id)
    return [(kind, resume_id) for kind, resume_id in selected.items()]


def _archive_record_to_park_record(
    candidate: dict[str, Any],
    row: dict[str, Any],
    *,
    reason: str,
    parked_at: float,
) -> dict[str, Any]:
    kind = str(candidate.get("kind") or (row.get("kinds") or ["agent"])[0])
    resume_id = str(candidate.get("resumeId") or "")
    record = _base_park_record(row, reason=reason, parked_at=parked_at)
    record.update(
        {
            "kind": kind,
            "kinds": [kind],
            "resumeId": resume_id,
            "resumeCommand": str(
                _build_resume_command(kind, str(row.get("cwd") or Path.home()), resume_id, row)
                if _resume_flags_from_row(kind, row)
                else candidate.get("resumeCommand")
                or build_local_resume_command(kind, str(row.get("cwd") or Path.home()), resume_id)
            ),
            "resumeSource": "archive",
            "parkMode": "resume-command",
            "title": candidate.get("title"),
        }
    )
    return record


def _base_park_record(row: dict[str, Any], *, reason: str, parked_at: float) -> dict[str, Any]:
    return {
        "hostId": row.get("hostId"),
        "hostName": row.get("hostName"),
        "session": row.get("session"),
        "windowIndex": row.get("windowIndex"),
        "windowName": row.get("windowName"),
        "paneId": row.get("paneId"),
        "panePid": row.get("panePid"),
        "processGroupId": row.get("processGroupId"),
        "pids": row.get("pids") or [],
        "agentPids": row.get("agentPids") or [],
        "kinds": row.get("kinds") or [],
        "cwd": row.get("cwd"),
        "target": row.get("target"),
        "reason": reason,
        "parkedAt": parked_at,
    }


def _build_resume_command(kind: str, cwd: str, resume_id: str, row: dict[str, Any]) -> str:
    flags = _resume_flags_from_row(kind, row)
    if not flags:
        return build_local_resume_command(kind, cwd, resume_id)
    quoted_id = shlex.quote(resume_id)
    if kind == "codex":
        resume = " ".join(["codex", "resume", *flags, quoted_id])
    elif kind == "claude":
        resume = " ".join(["claude", *flags, "--resume", quoted_id])
    else:
        return build_local_resume_command(kind, cwd, resume_id)
    return f"cd {shlex.quote(cwd)} && {resume}"


def _resume_flags_from_row(kind: str, row: dict[str, Any]) -> list[str]:
    command_blob = " ".join(str(command) for command in row.get("commands") or [])
    return [flag for flag in KNOWN_RESUME_FLAGS.get(kind, ()) if flag in command_blob]


def _launch_resume_record(record: dict[str, Any]) -> None:
    command = str(record.get("resumeCommand") or "").strip()
    if not command:
        raise CodexParkingError("missing resume command")
    target = _record_tmux_target(record)
    if not target or not _tmux_target_exists(target):
        _launch_resume_in_tmux_window(record, command)
        return

    _send_tmux_keys([target, "C-c"], literal=False)
    time.sleep(0.05)
    _send_tmux_keys([target, command], literal=True)
    _send_tmux_keys([target, "Enter"], literal=False)


def _tmux_target_exists(target: str) -> bool:
    try:
        result = subprocess.run(
            ["tmux", "display-message", "-p", "-t", target, "#{pane_id}"],
            capture_output=True,
            text=True,
            timeout=3,
            env={**os.environ, "TMUX": ""},
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def _tmux_session_exists(session: str) -> bool:
    try:
        result = subprocess.run(
            ["tmux", "has-session", "-t", session],
            capture_output=True,
            text=True,
            timeout=3,
            env={**os.environ, "TMUX": ""},
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def _launch_resume_in_tmux_window(record: dict[str, Any], command: str) -> None:
    session = str(record.get("session") or "").strip()
    if not session:
        raise CodexParkingError("missing tmux session")
    cwd = str(record.get("cwd") or Path.home())
    window_name = _safe_tmux_window_name(
        str(record.get("windowName") or record.get("kind") or "resume")
    )
    if not _tmux_session_exists(session):
        tmux_command = ["tmux", "new-session", "-d", "-s", session, "-c", cwd, command]
    else:
        tmux_command = ["tmux", "new-window", "-d", "-t", session, "-n", window_name, "-c", cwd, command]
    try:
        result = subprocess.run(
            tmux_command,
            capture_output=True,
            text=True,
            timeout=5,
            env={**os.environ, "TMUX": ""},
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise CodexParkingError(str(error)) from error
    if result.returncode not in (0, 1):
        raise CodexParkingError(result.stderr.strip() or "tmux resume launch failed")


def _send_tmux_keys(args: list[str], *, literal: bool) -> None:
    target, *keys = args
    command = ["tmux", "send-keys", "-t", target]
    if literal:
        command.append("-l")
    command.extend(keys)
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=3,
            env={**os.environ, "TMUX": ""},
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise CodexParkingError(str(error)) from error
    if result.returncode not in (0, 1):
        raise CodexParkingError(result.stderr.strip() or "tmux send-keys failed")


def _record_tmux_target(record: dict[str, Any]) -> str | None:
    pane_id = str(record.get("paneId") or "").strip()
    if pane_id:
        return pane_id
    session = str(record.get("session") or "").strip()
    if not session:
        return None
    window_index = record.get("windowIndex")
    if str(window_index).lstrip("-").isdigit():
        return f"{session}:{int(window_index)}"
    return session


def _parked_record_to_row(record: dict[str, Any]) -> dict[str, Any]:
    kind = str(record.get("kind") or "")
    kinds = [kind] if kind else list(record.get("kinds") or ["agent"])
    return {
        "hostId": record.get("hostId"),
        "hostName": record.get("hostName"),
        "session": record.get("session"),
        "windowIndex": int(record.get("windowIndex") or 0),
        "windowName": record.get("windowName") or "parked",
        "paneIndex": int(record.get("paneIndex") or 0),
        "paneId": record.get("paneId"),
        "panePid": record.get("panePid"),
        "cwd": record.get("cwd"),
        "kinds": kinds,
        "agentPids": record.get("agentPids") or [],
        "pids": record.get("pids") or [],
        "processGroupId": record.get("processGroupId"),
        "parked": True,
        "resumeCommand": record.get("resumeCommand"),
        "resumeId": record.get("resumeId"),
        "commands": [str(record.get("resumeCommand") or "")],
        "target": record.get("target") or f"{record.get('session')}#{record.get('windowIndex')}",
    }


def _row_identity(row: dict[str, Any]) -> tuple[str, int, str]:
    return (
        str(row.get("session") or ""),
        int(row.get("windowIndex") or 0),
        str(row.get("paneId") or ""),
    )


def _state_record_key(record: dict[str, Any]) -> tuple[Any, ...]:
    return (
        record.get("hostId"),
        str(record.get("session") or ""),
        int(record.get("windowIndex") or 0),
        str(record.get("paneId") or ""),
        str(record.get("resumeId") or record.get("processGroupId") or ""),
        str(record.get("kind") or "+".join(record.get("kinds") or [])),
    )


def _process_group_exited(pgid: Any) -> bool:
    try:
        pgid_int = int(pgid)
    except (TypeError, ValueError):
        return False
    try:
        os.killpg(pgid_int, 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    return False


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
    selected: dict[tuple[Any, ...], dict[str, Any]] = {}
    for record in records:
        selected[_state_record_key(record)] = record
    return list(selected.values())


def _shorten(value: str, width: int) -> str:
    value = " ".join(str(value).split())
    if len(value) <= width:
        return value
    return value[: max(0, width - 3)] + "..."


def _safe_tmux_window_name(value: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch in ("-", "_", ".") else "-" for ch in value.strip())
    safe = "-".join(part for part in safe.split("-") if part)
    return (safe or "resume")[:32]
