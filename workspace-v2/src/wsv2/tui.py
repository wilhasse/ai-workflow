from __future__ import annotations

import curses
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from .actions import TerminalStatus, WorkspaceActions, terminal_recent_score, terminal_status_rank


SHORTCUT_HELP = 'Enter: switch  Ctrl+G: active only  Alt+L: label  Alt+C: check  Alt+I: idle  Alt+A: active'


@dataclass(slots=True)
class TuiItem:
    status: TerminalStatus
    searchable_text: str
    recent_score: float = 0.0


def is_green_active_terminal(status: TerminalStatus) -> bool:
    return status.active and not status.window_status


def build_tui_items(
    statuses: Iterable[TerminalStatus],
    recent_scores: dict[str, float] | None = None,
) -> list[TuiItem]:
    items = []
    for status in statuses:
        searchable = status.searchable_text
        items.append(
            TuiItem(
                status=status,
                searchable_text=searchable,
                recent_score=terminal_recent_score(status, recent_scores),
            )
        )
    return items


def filter_tui_items(items: list[TuiItem], query: str, *, active_only: bool = False) -> list[TuiItem]:
    if active_only:
        items = [item for item in items if is_green_active_terminal(item.status)]
    if not query:
        return sorted(items, key=_sort_key)
    normalized = query.lower()
    ranked: list[tuple[int, TuiItem]] = []
    for item in items:
        status = item.status
        if normalized not in item.searchable_text:
            continue
        if normalized in {status.session_id.lower(), status.workspace_name.lower(), str(status.window_index)}:
            rank = 0
        elif (
            status.session_id.lower().startswith(normalized)
            or status.workspace_name.lower().startswith(normalized)
            or status.window_name.lower().startswith(normalized)
        ):
            rank = 1
        elif status.host_id.lower().startswith(normalized) or status.host.name.lower().startswith(normalized):
            rank = 2
        else:
            rank = 3
        ranked.append((rank, item))
    ranked.sort(key=lambda pair: (pair[0], _sort_key(pair[1])))
    return [item for _, item in ranked]


def _sort_key(item: TuiItem):
    status = item.status
    return (
        terminal_status_rank(status.window_status),
        not bool(status.window_label),
        -item.recent_score,
        not status.active,
        not status.window_active,
        -(status.activity or 0),
        status.host.name.lower(),
        status.workspace_name.lower(),
        status.window_index,
    )


def format_tui_row(status: TerminalStatus, width: int) -> str:
    if status.reachable is False:
        dot = '!'
    elif status.active:
        dot = '*'
    else:
        dot = '.'
    tab = f"#{status.window_index}" if status.window_index > 0 else "--"
    discovered = " *" if status.discovered else ""
    activity = "active" if status.activity else "inactive"
    flag = f" [{status.window_status}]" if status.window_status else ""
    row = (
        f"{dot} {status.window_name}{flag} {tab} {status.workspace_name}{discovered} "
        f"· {status.host.name} [{activity}]"
    )
    return row[: max(0, width - 1)]


class WorkspaceTui:
    def __init__(self, actions: WorkspaceActions) -> None:
        self.actions = actions
        self.recent_scores = actions.state.recent_scores()
        self.items = build_tui_items(actions.list_terminal_statuses(), self.recent_scores)
        self.query = ''
        self.index = 0
        self.scroll = 0
        self.message = ''
        self.active_only = actions.state.preference_bool('activeOnly')

    def run(self) -> str | None:
        return curses.wrapper(self._main)

    def _main(self, stdscr) -> str | None:
        curses.curs_set(0)
        stdscr.keypad(True)

        while True:
            filtered = filter_tui_items(self.items, self.query, active_only=self.active_only)
            if self.index >= len(filtered):
                self.index = max(0, len(filtered) - 1)
            self._draw(stdscr, filtered)

            key = stdscr.getch()
            if key == 27:
                alt_key = self._read_alt_key(stdscr)
                if alt_key is None:
                    return None
                if self._handle_alt_shortcut(stdscr, filtered, alt_key):
                    continue
            if key in (curses.KEY_ENTER, 10, 13):
                if filtered:
                    return filtered[self.index].status.target
                continue
            if key == 7:
                self.active_only = not self.active_only
                self.actions.state.set_preference_bool('activeOnly', self.active_only)
                self.index = 0
                self.scroll = 0
                self.message = (
                    'Green active terminal filter on.'
                    if self.active_only
                    else 'Green active terminal filter off.'
                )
                continue
            if key == curses.KEY_UP:
                self.index = max(0, self.index - 1)
                continue
            if key == curses.KEY_DOWN:
                self.index = min(max(0, len(filtered) - 1), self.index + 1)
                continue
            if key in (curses.KEY_BACKSPACE, 127, 8):
                self.query = self.query[:-1]
                self.index = 0
                self.scroll = 0
                continue
            if key == 21:
                self.query = ''
                self.index = 0
                self.scroll = 0
                continue
            if 32 <= key <= 126:
                self.query += chr(key)
                self.index = 0
                self.scroll = 0
                continue

    def _draw(self, stdscr, filtered: list[TuiItem]) -> None:
        stdscr.erase()
        height, width = stdscr.getmaxyx()
        list_top = 4
        visible_rows = max(1, height - list_top - 2)

        if self.index < self.scroll:
            self.scroll = self.index
        elif self.index >= self.scroll + visible_rows:
            self.scroll = self.index - visible_rows + 1

        stdscr.addnstr(0, 0, 'Workspace Launcher', width - 1, curses.A_BOLD)
        stdscr.addnstr(1, 0, SHORTCUT_HELP, width - 1)
        mode = 'active only' if self.active_only else 'all terminals'
        stdscr.addnstr(2, 0, f'Search: {self.query}  Mode: {mode}', width - 1)
        if self.message:
            stdscr.addnstr(3, 0, self.message, width - 1)

        if not filtered:
            stdscr.addnstr(list_top, 0, 'No matching tmux windows', width - 1)
        else:
            for row_offset, item in enumerate(filtered[self.scroll:self.scroll + visible_rows]):
                row = list_top + row_offset
                attr = curses.A_REVERSE if self.scroll + row_offset == self.index else curses.A_NORMAL
                stdscr.addnstr(row, 0, format_tui_row(item.status, width), width - 1, attr)

        stdscr.addnstr(height - 1, 0, 'Esc: close  Ctrl+U: clear  Ctrl+G: active only  Type to filter terminals', width - 1)
        stdscr.refresh()

    def _read_alt_key(self, stdscr) -> int | None:
        stdscr.timeout(80)
        try:
            key = stdscr.getch()
        finally:
            stdscr.timeout(-1)
        return None if key == -1 else key

    def _handle_alt_shortcut(self, stdscr, filtered: list[TuiItem], key: int) -> bool:
        if not filtered:
            return True
        char = chr(key).lower() if 0 <= key <= 255 else ''
        status = filtered[self.index].status
        if char == 'l':
            self._prompt_label(stdscr, status)
            return True
        if char == 'c':
            self._set_terminal_metadata(status, status_value='check')
            return True
        if char == 'i':
            self._set_terminal_metadata(status, status_value='idle')
            return True
        if char == 'a':
            self._set_terminal_metadata(status, status_value='')
            return True
        return False

    def _prompt_label(self, stdscr, status: TerminalStatus) -> None:
        if status.window_index <= 0:
            self.message = 'Open or create this workspace before labeling its terminal.'
            return
        height, width = stdscr.getmaxyx()
        prompt = f'Label for {status.workspace_name} #{status.window_index}: '
        footer_row = height - 1
        stdscr.move(footer_row, 0)
        stdscr.clrtoeol()
        stdscr.addnstr(footer_row, 0, prompt, max(0, width - 1))
        curses.curs_set(1)
        curses.echo()
        try:
            value = stdscr.getstr(footer_row, min(len(prompt), max(0, width - 1)), 80)
        except (curses.error, KeyboardInterrupt):
            self.message = 'Label edit canceled.'
            return
        finally:
            curses.noecho()
            curses.curs_set(0)
        self._set_terminal_metadata(status, label=value.decode('utf-8', errors='ignore'))

    def _set_terminal_metadata(
        self,
        status: TerminalStatus,
        *,
        label: object | None = None,
        status_value: object | None = None,
    ) -> None:
        if status.window_index <= 0:
            self.message = 'Open or create this workspace before editing it.'
            return
        metadata = self.actions.set_terminal_metadata(
            status,
            label=label,
            status=status_value,
        )
        self.recent_scores = self.actions.state.recent_scores()
        self.items = build_tui_items(self.actions.list_terminal_statuses(), self.recent_scores)
        label_text = metadata.get('label') or 'unlabeled'
        status_text = metadata.get('status') or 'active'
        self.message = (
            f'Updated {status.workspace_name} #{status.window_index}: {label_text}, {status_text}.'
        )


def select_workspace_tui(actions: WorkspaceActions) -> str | None:
    return WorkspaceTui(actions).run()


def write_selected_target(output_path: str, target: str | None) -> None:
    Path(output_path).write_text(target or '', encoding='utf-8')
