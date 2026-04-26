from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shlex
import sqlite3
import subprocess
import time
from typing import Any, Iterable

from .catalog import HostRecord, WorkspaceConfig, WorkspaceConfigError


PACKAGE_ROOT = Path(__file__).resolve().parents[2]
ARCHIVE_VERSION = 1
DEFAULT_SCAN_LIMIT = 200
DEFAULT_PANE_MATCH_LIMIT = 3


_PANE_FIELDS = (
    "#{session_name}",
    "#{window_index}",
    "#{window_name}",
    "#{window_active}",
    "#{window_activity}",
    "#{pane_id}",
    "#{pane_index}",
    "#{pane_active}",
    "#{pane_pid}",
    "#{pane_current_command}",
    "#{pane_current_path}",
    "#{pane_title}",
)
_PANE_FORMAT = "\t".join(_PANE_FIELDS)


class SessionArchiveError(RuntimeError):
    """Raised when a session archive command cannot be completed."""


def default_archive_path() -> Path:
    env_path = os.environ.get("WSV2_SESSION_ARCHIVE_PATH")
    if env_path:
        return Path(env_path).expanduser()
    return Path.home() / ".local" / "state" / "ai-workflow" / "workspace-session-archive.json"


def scan_local_host(
    *,
    host_id: str = "local",
    host_name: str | None = None,
    now_ms: int | None = None,
) -> dict[str, Any]:
    now_ms = now_ms or _now_ms()
    panes = _list_tmux_panes()
    claude_sessions = _load_claude_sessions()
    codex_threads = _load_codex_threads()
    process_rows = _load_process_rows()
    records: list[dict[str, Any]] = []
    seen_resume_ids: set[tuple[str, str]] = set()

    for pane in panes:
        pane_pids = _descendant_pids(process_rows, pane.get("panePid"))
        pane_records = build_records_for_pane(
            pane,
            claude_sessions=claude_sessions,
            codex_threads=codex_threads,
            host_id=host_id,
            host_name=host_name or host_id,
            now_ms=now_ms,
            pane_pids=pane_pids,
        )
        for record in pane_records:
            records.append(record)
            seen_resume_ids.add((record["kind"], record["resumeId"]))

    # Keep recent resumable sessions visible even when their tmux pane already died.
    for session in claude_sessions[:DEFAULT_SCAN_LIMIT]:
        key = ("claude", str(session["resumeId"]))
        if key not in seen_resume_ids:
            records.append(
                build_archive_record(
                    kind="claude",
                    session=session,
                    pane=None,
                    host_id=host_id,
                    host_name=host_name or host_id,
                    now_ms=now_ms,
                    active=False,
                )
            )

    for thread in codex_threads[:DEFAULT_SCAN_LIMIT]:
        key = ("codex", str(thread["resumeId"]))
        if key not in seen_resume_ids:
            records.append(
                build_archive_record(
                    kind="codex",
                    session=thread,
                    pane=None,
                    host_id=host_id,
                    host_name=host_name or host_id,
                    now_ms=now_ms,
                    active=False,
                )
            )

    records = _dedupe_records(records)
    return {
        "hostId": host_id,
        "hostName": host_name or host_id,
        "scannedAt": now_ms,
        "reachable": True,
        "paneCount": len(panes),
        "claudeSessionCount": len(claude_sessions),
        "codexThreadCount": len(codex_threads),
        "records": sorted(records, key=_record_sort_key),
    }


def build_records_for_pane(
    pane: dict[str, Any],
    *,
    claude_sessions: list[dict[str, Any]],
    codex_threads: list[dict[str, Any]],
    host_id: str,
    host_name: str,
    now_ms: int,
    pane_pids: set[int] | None = None,
    match_limit: int = DEFAULT_PANE_MATCH_LIMIT,
) -> list[dict[str, Any]]:
    pane_pids = pane_pids or set()
    records = []

    for session in _match_candidates_by_cwd(claude_sessions, pane.get("cwd"), pane_pids)[:match_limit]:
        records.append(
            build_archive_record(
                kind="claude",
                session=session,
                pane=pane,
                host_id=host_id,
                host_name=host_name,
                now_ms=now_ms,
                active=True,
            )
        )

    for thread in _match_candidates_by_cwd(codex_threads, pane.get("cwd"), pane_pids)[:match_limit]:
        records.append(
            build_archive_record(
                kind="codex",
                session=thread,
                pane=pane,
                host_id=host_id,
                host_name=host_name,
                now_ms=now_ms,
                active=True,
            )
        )

    return records


def build_archive_record(
    *,
    kind: str,
    session: dict[str, Any],
    pane: dict[str, Any] | None,
    host_id: str,
    host_name: str,
    now_ms: int,
    active: bool,
) -> dict[str, Any]:
    cwd = str(session.get("cwd") or (pane or {}).get("cwd") or Path.home())
    resume_id = str(session["resumeId"])
    record_id = _record_id(kind, host_id, resume_id)
    title = _compact_title(
        str(
            session.get("title")
            or session.get("firstUserMessage")
            or (pane or {}).get("paneTitle")
            or (pane or {}).get("windowName")
            or resume_id
        )
    )

    record = {
        "id": record_id,
        "kind": kind,
        "resumeId": resume_id,
        "hostId": host_id,
        "hostName": host_name,
        "cwd": cwd,
        "title": title,
        "updatedAt": int(session.get("updatedAt") or session.get("startedAt") or now_ms),
        "activityAt": _pane_activity_ms(pane),
        "startedAt": session.get("startedAt"),
        "firstSeenAt": now_ms,
        "lastSeenAt": now_ms,
        "active": active,
        "resumeCommand": build_local_resume_command(kind, cwd, resume_id),
    }
    if pane:
        record["tmux"] = {
            "session": pane.get("session"),
            "windowIndex": pane.get("windowIndex"),
            "windowName": pane.get("windowName"),
            "windowActive": pane.get("windowActive"),
            "windowActivity": pane.get("windowActivity"),
            "paneId": pane.get("paneId"),
            "paneIndex": pane.get("paneIndex"),
            "paneActive": pane.get("paneActive"),
            "panePid": pane.get("panePid"),
            "paneCommand": pane.get("paneCommand"),
            "paneTitle": pane.get("paneTitle"),
            "paneCwd": pane.get("cwd"),
        }
    else:
        record["tmux"] = None
    return record


def scan_configured_hosts(
    config: WorkspaceConfig,
    *,
    archive_path: str | Path | None = None,
    now_ms: int | None = None,
) -> dict[str, Any]:
    now_ms = now_ms or _now_ms()
    snapshots: list[dict[str, Any]] = []

    for host in config.hosts:
        if config.host_runs_local(host):
            snapshot = scan_local_host(host_id=host.id, host_name=host.name, now_ms=now_ms)
        else:
            snapshot = scan_remote_host(host, now_ms=now_ms)
        _stamp_host_metadata(snapshot, host)
        snapshots.append(snapshot)

    archive = merge_snapshots(load_archive(archive_path), snapshots, now_ms=now_ms)
    save_archive(archive, archive_path)
    return {
        "archivePath": str(Path(archive_path).expanduser() if archive_path else default_archive_path()),
        "updatedAt": now_ms,
        "snapshots": snapshots,
        "records": archive.get("records", []),
    }


def scan_remote_host(host: HostRecord, *, now_ms: int | None = None) -> dict[str, Any]:
    now_ms = now_ms or _now_ms()
    if not host.ssh:
        return _unreachable_snapshot(host, now_ms, "host has no ssh target")

    script_path = Path(os.environ.get("WSV2_REMOTE_SCRIPT_PATH") or PACKAGE_ROOT / "scripts" / "wsv2")
    remote_cmd = " ".join(
        [
            f"WSV2_SELF_HOST={shlex.quote(host.id)}",
            shlex.quote(str(script_path)),
            "archive-scan-local",
            "--json",
            "--host-id",
            shlex.quote(host.id),
            "--host-name",
            shlex.quote(host.name),
        ]
    )
    try:
        result = subprocess.run(
            [
                "ssh",
                "-o",
                "ConnectTimeout=3",
                "-o",
                "BatchMode=yes",
                host.ssh,
                remote_cmd,
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return _unreachable_snapshot(host, now_ms, str(error))

    if result.returncode != 0:
        detail = (result.stderr or result.stdout or f"ssh exited {result.returncode}").strip()
        return _unreachable_snapshot(host, now_ms, detail)

    try:
        snapshot = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        return _unreachable_snapshot(host, now_ms, f"invalid remote archive JSON: {error}")

    snapshot.setdefault("hostId", host.id)
    snapshot.setdefault("hostName", host.name)
    snapshot.setdefault("scannedAt", now_ms)
    snapshot.setdefault("reachable", True)
    return snapshot


def merge_snapshots(
    archive: dict[str, Any] | None,
    snapshots: Iterable[dict[str, Any]],
    *,
    now_ms: int | None = None,
) -> dict[str, Any]:
    now_ms = now_ms or _now_ms()
    existing_records = {
        str(record["id"]): dict(record)
        for record in (archive or {}).get("records", [])
        if record.get("id")
    }
    snapshots = list(snapshots)
    scanned_hosts = {
        snapshot.get("hostId")
        for snapshot in snapshots
        if snapshot.get("hostId") and snapshot.get("reachable") is not False
    }

    for record in existing_records.values():
        if record.get("hostId") in scanned_hosts:
            record["active"] = False

    for snapshot in snapshots:
        if snapshot.get("reachable") is False:
            continue
        for record in snapshot.get("records", []):
            record = dict(record)
            previous = existing_records.get(record["id"])
            if previous:
                record["firstSeenAt"] = previous.get("firstSeenAt") or record.get("firstSeenAt") or now_ms
                record["lastSeenAt"] = max(int(previous.get("lastSeenAt") or 0), int(record.get("lastSeenAt") or now_ms))
                if not record.get("title") and previous.get("title"):
                    record["title"] = previous["title"]
            existing_records[record["id"]] = record

    records = sorted(existing_records.values(), key=_record_sort_key)
    return {
        "version": ARCHIVE_VERSION,
        "updatedAt": now_ms,
        "records": records,
        "lastSnapshots": snapshots,
    }


def load_archive(path: str | Path | None = None) -> dict[str, Any]:
    archive_path = Path(path).expanduser() if path else default_archive_path()
    try:
        return json.loads(archive_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"version": ARCHIVE_VERSION, "records": []}
    except json.JSONDecodeError as error:
        raise SessionArchiveError(f"Invalid session archive: {archive_path}") from error


def save_archive(payload: dict[str, Any], path: str | Path | None = None) -> None:
    archive_path = Path(path).expanduser() if path else default_archive_path()
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    archive_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def list_archive_records(
    *,
    archive_path: str | Path | None = None,
    include_inactive: bool = True,
) -> list[dict[str, Any]]:
    archive = load_archive(archive_path)
    records = archive.get("records", [])
    if not include_inactive:
        records = [record for record in records if record.get("active")]
    return sorted(records, key=_record_sort_key)


def find_archive_record(records: Iterable[dict[str, Any]], token: str) -> dict[str, Any]:
    token = token.strip()
    if not token:
        raise SessionArchiveError("Missing archive record id")

    matches = [
        record
        for record in records
        if str(record.get("id", "")).startswith(token)
        or str(record.get("resumeId", "")).startswith(token)
    ]
    if not matches:
        raise SessionArchiveError(f"No archive record matches: {token}")
    if len(matches) > 1:
        ids = ", ".join(str(record.get("id")) for record in matches[:8])
        raise SessionArchiveError(f"Archive record id is ambiguous: {token} ({ids})")
    return matches[0]


def build_local_resume_command(kind: str, cwd: str, resume_id: str) -> str:
    if kind == "claude":
        resume = f"claude --resume {shlex.quote(resume_id)}"
    elif kind == "codex":
        resume = f"codex resume {shlex.quote(resume_id)}"
    else:
        raise SessionArchiveError(f"Unsupported session kind: {kind}")
    return f"cd {shlex.quote(cwd)} && {resume}"


def build_record_command(
    record: dict[str, Any],
    config: WorkspaceConfig,
    *,
    tmux_restore: bool = False,
) -> str:
    host_id = str(record.get("hostId") or "")
    try:
        host = config.get_host(host_id)
    except WorkspaceConfigError:
        host = None

    local_command = build_local_resume_command(
        str(record.get("kind")),
        str(record.get("cwd") or Path.home()),
        str(record.get("resumeId")),
    )
    if tmux_restore:
        local_command = build_tmux_restore_command(record, local_command)

    if host and config.host_runs_local(host):
        return local_command
    ssh_target = host.ssh if host else record.get("hostSsh")
    if not ssh_target:
        raise SessionArchiveError(f"No ssh target known for host: {host_id}")
    return (
        "ssh -t -o ServerAliveInterval=60 -o ServerAliveCountMax=3 "
        f"{shlex.quote(str(ssh_target))} {shlex.quote(local_command)}"
    )


def build_tmux_restore_command(record: dict[str, Any], local_resume_command: str) -> str:
    cwd = str(record.get("cwd") or Path.home())
    tmux_data = record.get("tmux") or {}
    session = str(tmux_data.get("session") or _fallback_session_name(cwd))
    window_name = _safe_tmux_window_name(
        str(tmux_data.get("windowName") or record.get("title") or record.get("kind") or "resume")
    )
    quoted_session = shlex.quote(session)
    return (
        f"tmux has-session -t {quoted_session} 2>/dev/null || "
        f"tmux new-session -d -s {quoted_session} -c {shlex.quote(cwd)}; "
        f"tmux new-window -t {quoted_session} -n {shlex.quote(window_name)} "
        f"-c {shlex.quote(cwd)} {shlex.quote(local_resume_command)}; "
        f"tmux attach-session -t {quoted_session}"
    )


def format_archive_records(records: Iterable[dict[str, Any]], *, limit: int | None = None) -> str:
    lines = []
    selected = list(records)
    if limit is not None:
        selected = selected[:limit]
    for record in selected:
        tmux_data = record.get("tmux") or {}
        active = "*" if record.get("active") else "."
        tmux_label = "--"
        if tmux_data:
            tmux_label = f"{tmux_data.get('session')}#{tmux_data.get('windowIndex')}"
        title = _compact_title(str(record.get("title") or ""), limit=54)
        cwd = str(record.get("cwd") or "")
        lines.append(
            f"{active} {record.get('id', ''):<14} {record.get('kind', ''):<6} "
            f"{record.get('hostName') or record.get('hostId'):<14} {tmux_label:<20} "
            f"{title:<54} {cwd}"
        )
    return "\n".join(lines)


def _stamp_host_metadata(snapshot: dict[str, Any], host: HostRecord) -> None:
    for record in snapshot.get("records", []):
        record["hostId"] = host.id
        record["hostName"] = host.name
        if host.ssh:
            record["hostSsh"] = host.ssh


def _unreachable_snapshot(host: HostRecord, now_ms: int, error: str) -> dict[str, Any]:
    return {
        "hostId": host.id,
        "hostName": host.name,
        "scannedAt": now_ms,
        "reachable": False,
        "error": error,
        "records": [],
    }


def _list_tmux_panes() -> list[dict[str, Any]]:
    try:
        result = subprocess.run(
            ["tmux", "list-panes", "-a", "-F", _PANE_FORMAT],
            capture_output=True,
            text=True,
            timeout=5,
            env={**os.environ, "TMUX": ""},
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if result.returncode not in (0, 1):
        return []
    return _parse_tmux_panes(result.stdout.splitlines())


def _parse_tmux_panes(lines: Iterable[str]) -> list[dict[str, Any]]:
    panes = []
    for line in lines:
        if not line.strip():
            continue
        parts = line.split("\t", len(_PANE_FIELDS) - 1)
        if len(parts) < len(_PANE_FIELDS):
            continue
        (
            session,
            window_index,
            window_name,
            window_active,
            window_activity,
            pane_id,
            pane_index,
            pane_active,
            pane_pid,
            pane_command,
            cwd,
            pane_title,
        ) = parts
        panes.append(
            {
                "session": session,
                "windowIndex": _int_or_none(window_index) or 0,
                "windowName": window_name or f"window-{window_index}",
                "windowActive": window_active == "1",
                "windowActivity": _int_or_none(window_activity) or 0,
                "paneId": pane_id,
                "paneIndex": _int_or_none(pane_index) or 0,
                "paneActive": pane_active == "1",
                "panePid": _int_or_none(pane_pid),
                "paneCommand": pane_command,
                "cwd": cwd,
                "paneTitle": pane_title,
            }
        )
    return panes


def _load_claude_sessions() -> list[dict[str, Any]]:
    session_dir = Path.home() / ".claude" / "sessions"
    sessions = []
    for path in session_dir.glob("*.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        resume_id = payload.get("sessionId")
        if not resume_id:
            continue
        mtime_ms = int(path.stat().st_mtime * 1000)
        sessions.append(
            {
                "resumeId": str(resume_id),
                "cwd": str(payload.get("cwd") or Path.home()),
                "pid": _int_or_none(payload.get("pid")),
                "title": str(payload.get("title") or payload.get("entrypoint") or "Claude session"),
                "entrypoint": payload.get("entrypoint"),
                "startedAt": _int_or_none(payload.get("startedAt")) or mtime_ms,
                "updatedAt": _int_or_none(payload.get("updatedAt")) or mtime_ms,
            }
        )
    return sorted(sessions, key=lambda item: int(item.get("updatedAt") or 0), reverse=True)


def _load_codex_threads() -> list[dict[str, Any]]:
    db_path = Path.home() / ".codex" / "state_5.sqlite"
    if not db_path.exists():
        return []
    try:
        connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=2)
    except sqlite3.Error:
        return []
    try:
        rows = connection.execute(
            """
            select
                id,
                cwd,
                title,
                first_user_message,
                created_at,
                updated_at,
                created_at_ms,
                updated_at_ms,
                model,
                reasoning_effort
            from threads
            where archived = 0
            order by coalesce(updated_at_ms, updated_at * 1000, created_at_ms, created_at * 1000) desc
            limit ?
            """,
            (DEFAULT_SCAN_LIMIT,),
        ).fetchall()
    except sqlite3.Error:
        return []
    finally:
        connection.close()

    threads = []
    for row in rows:
        (
            thread_id,
            cwd,
            title,
            first_user_message,
            created_at,
            updated_at,
            created_at_ms,
            updated_at_ms,
            model,
            reasoning_effort,
        ) = row
        threads.append(
            {
                "resumeId": str(thread_id),
                "cwd": str(cwd or Path.home()),
                "title": str(title or first_user_message or "Codex session"),
                "firstUserMessage": str(first_user_message or ""),
                "startedAt": _int_or_none(created_at_ms) or ((_int_or_none(created_at) or 0) * 1000),
                "updatedAt": _int_or_none(updated_at_ms) or ((_int_or_none(updated_at) or 0) * 1000),
                "model": model,
                "reasoningEffort": reasoning_effort,
            }
        )
    return threads


def _load_process_rows() -> list[dict[str, Any]]:
    try:
        result = subprocess.run(
            ["ps", "-eo", "pid=,ppid=,comm=,args="],
            capture_output=True,
            text=True,
            timeout=4,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if result.returncode != 0:
        return []

    rows = []
    for line in result.stdout.splitlines():
        parts = line.strip().split(maxsplit=3)
        if len(parts) < 3:
            continue
        rows.append(
            {
                "pid": _int_or_none(parts[0]),
                "ppid": _int_or_none(parts[1]),
                "comm": parts[2],
                "args": parts[3] if len(parts) > 3 else parts[2],
            }
        )
    return rows


def _descendant_pids(rows: list[dict[str, Any]], root_pid: int | None) -> set[int]:
    if not root_pid:
        return set()
    children: dict[int, list[int]] = {}
    for row in rows:
        pid = row.get("pid")
        ppid = row.get("ppid")
        if pid is None or ppid is None:
            continue
        children.setdefault(int(ppid), []).append(int(pid))

    descendants = {int(root_pid)}
    queue = [int(root_pid)]
    while queue:
        current = queue.pop(0)
        for child in children.get(current, []):
            if child in descendants:
                continue
            descendants.add(child)
            queue.append(child)
    return descendants


def _match_candidates_by_cwd(
    candidates: list[dict[str, Any]],
    pane_cwd: str | None,
    pane_pids: set[int] | None = None,
) -> list[dict[str, Any]]:
    pane_pids = pane_pids or set()
    scored = []
    for candidate in candidates:
        score = _path_match_score(str(candidate.get("cwd") or ""), pane_cwd or "")
        pid = candidate.get("pid")
        if pid is not None and int(pid) in pane_pids:
            score += 100
        if score <= 0:
            continue
        scored.append((score, int(candidate.get("updatedAt") or 0), candidate))
    scored.sort(key=lambda item: (-item[0], -item[1]))
    return [candidate for _, _, candidate in scored]


def _path_match_score(left: str, right: str) -> int:
    left = _normalize_path(left)
    right = _normalize_path(right)
    if not left or not right:
        return 0
    if left == right:
        return 50
    if _is_broad_home_path(left) or _is_broad_home_path(right):
        return 0
    if left.startswith(f"{right}/"):
        return 20
    if right.startswith(f"{left}/") and len(Path(left).parts) >= 4:
        return 20
    return 0


def _normalize_path(value: str) -> str:
    if not value:
        return ""
    return str(Path(value).expanduser()).rstrip("/")


def _record_id(kind: str, host_id: str, resume_id: str) -> str:
    digest = hashlib.sha1(f"{kind}|{host_id}|{resume_id}".encode("utf-8")).hexdigest()[:12]
    prefix = "cx" if kind == "codex" else "cl"
    return f"{prefix}-{digest}"


def _record_sort_key(record: dict[str, Any]):
    recent_at = max(
        int(record.get("updatedAt") or 0),
        int(record.get("activityAt") or 0),
        int(record.get("lastSeenAt") or 0) if not record.get("updatedAt") else 0,
    )
    return (
        -recent_at,
        not bool(record.get("active")),
        -int(record.get("updatedAt") or 0),
        -int(record.get("activityAt") or 0),
        str(record.get("hostName") or record.get("hostId") or "").lower(),
        str(record.get("title") or "").lower(),
    )


def _compact_title(value: str, *, limit: int = 120) -> str:
    title = " ".join(value.split())
    if len(title) <= limit:
        return title
    return f"{title[: max(0, limit - 1)]}..."


def _safe_tmux_window_name(value: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch in ("-", "_", ".") else "-" for ch in value.strip())
    safe = "-".join(part for part in safe.split("-") if part)
    return (safe or "resume")[:32]


def _fallback_session_name(cwd: str) -> str:
    name = Path(cwd).name or "workspace"
    return _safe_tmux_window_name(name)


def _dedupe_records(records: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    selected: dict[str, dict[str, Any]] = {}
    for record in records:
        current = selected.get(str(record.get("id")))
        if current is None or _dedupe_rank(record) > _dedupe_rank(current):
            selected[str(record.get("id"))] = record
    return list(selected.values())


def _dedupe_rank(record: dict[str, Any]) -> tuple[int, int, int, int]:
    return (
        1 if record.get("active") else 0,
        int(record.get("activityAt") or 0),
        int(record.get("updatedAt") or 0),
        int(record.get("lastSeenAt") or 0),
    )


def _pane_activity_ms(pane: dict[str, Any] | None) -> int:
    if not pane:
        return 0
    value = _int_or_none(pane.get("windowActivity")) or 0
    return value * 1000 if value < 10_000_000_000 else value


def _is_broad_home_path(value: str) -> bool:
    try:
        home = str(Path.home()).rstrip("/")
    except RuntimeError:
        return False
    return value.rstrip("/") == home


def _int_or_none(value: Any) -> int | None:
    try:
        if value is None or value == "":
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def _now_ms() -> int:
    return int(time.time() * 1000)
