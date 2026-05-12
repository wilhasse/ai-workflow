from __future__ import annotations

import re
import subprocess
from typing import Iterable

from .actions import TerminalStatus
from .state import normalize_window_id


def active_window_title() -> str:
    try:
        active = subprocess.run(
            ["xprop", "-root", "_NET_ACTIVE_WINDOW"],
            capture_output=True,
            text=True,
            timeout=1,
        )
        if active.returncode != 0:
            return ""
        match = re.search(r"window id # (0x[0-9a-fA-F]+)", active.stdout)
        if not match:
            return ""
        title = subprocess.run(
            ["xprop", "-id", match.group(1), "_NET_WM_NAME", "WM_NAME"],
            capture_output=True,
            text=True,
            timeout=1,
        )
        if title.returncode != 0:
            return ""
        for line in title.stdout.splitlines():
            if "_NET_WM_NAME" not in line and not line.startswith("WM_NAME"):
                continue
            value = line.split("=", 1)[-1].strip()
            if value.startswith('"') and value.endswith('"'):
                value = value[1:-1]
            if value:
                return value
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return ""


def terminal_target_from_window_title(title: str, statuses: Iterable[TerminalStatus]) -> str:
    status_list = [status for status in statuses if status.window_index > 0]
    exact_match = _target_from_stable_title(title, status_list)
    if exact_match:
        return exact_match
    return _target_from_session_title(title, status_list)


def terminal_target_from_active_window(statuses: Iterable[TerminalStatus]) -> str:
    return terminal_target_from_window_title(active_window_title(), statuses)


def _target_from_stable_title(title: str, statuses: list[TerminalStatus]) -> str:
    for session_id, window_id in re.findall(r"\b([A-Za-z0-9_.-]+)@(\d+)\b", title):
        normalized_window_id = normalize_window_id(window_id)
        matches = [
            status
            for status in statuses
            if status.session_id == session_id
            and normalize_window_id(status.window_id) == normalized_window_id
        ]
        target = _best_status_target(matches)
        if target:
            return target
    return ""


def _target_from_session_title(title: str, statuses: list[TerminalStatus]) -> str:
    normalized_title = " ".join(str(title or "").split())
    title_match = re.search(
        r"\bTerminal\s*-\s*([A-Za-z0-9_.-]+)\s*:\s*([^—|]+)",
        normalized_title,
    )
    if not title_match:
        return ""
    session_id = title_match.group(1)
    window_text = title_match.group(2).strip().lower()
    candidates = [status for status in statuses if status.session_id == session_id]
    if not candidates:
        return ""

    named_candidates = [
        status
        for status in candidates
        if window_text in _window_title_names(status)
    ]
    candidates = named_candidates or candidates
    return _best_status_target(candidates)


def _window_title_names(status: TerminalStatus) -> set[str]:
    names = {
        str(status.window_index),
        f"#{status.window_index}",
        status.window_name,
        status.tmux_window_name or "",
        status.window_label,
    }
    return {" ".join(str(name or "").split()).lower() for name in names if str(name or "").strip()}


def _best_status_target(statuses: list[TerminalStatus]) -> str:
    if not statuses:
        return ""
    best = sorted(
        statuses,
        key=lambda status: (
            not status.window_active,
            not status.active,
            -(status.activity or 0),
            status.host.name.lower(),
            status.workspace_name.lower(),
            status.window_index,
        ),
    )[0]
    return best.target
