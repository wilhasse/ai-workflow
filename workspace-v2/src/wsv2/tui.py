from __future__ import annotations

import curses
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from .actions import TerminalStatus, WorkspaceActions, terminal_recent_score


@dataclass(slots=True)
class TuiItem:
    status: TerminalStatus
    searchable_text: str
    recent_score: float = 0.0


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


def filter_tui_items(items: list[TuiItem], query: str) -> list[TuiItem]:
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
    row = (
        f"{dot} {status.host.name} / {status.workspace_name}{discovered} "
        f"· {tab} {status.window_name} [{activity}]"
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

    def run(self) -> str | None:
        return curses.wrapper(self._main)

    def _main(self, stdscr) -> str | None:
        curses.curs_set(0)
        stdscr.keypad(True)

        while True:
            filtered = filter_tui_items(self.items, self.query)
            if self.index >= len(filtered):
                self.index = max(0, len(filtered) - 1)
            self._draw(stdscr, filtered)

            key = stdscr.getch()
            if key == 27:
                return None
            if key in (curses.KEY_ENTER, 10, 13):
                if filtered:
                    return filtered[self.index].status.target
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
        list_top = 3
        visible_rows = max(1, height - list_top - 2)

        if self.index < self.scroll:
            self.scroll = self.index
        elif self.index >= self.scroll + visible_rows:
            self.scroll = self.index - visible_rows + 1

        stdscr.addnstr(0, 0, 'Workspace Launcher', width - 1, curses.A_BOLD)
        stdscr.addnstr(1, 0, f'Search: {self.query}', width - 1)

        if not filtered:
            stdscr.addnstr(list_top, 0, 'No matching tmux windows', width - 1)
        else:
            for row_offset, item in enumerate(filtered[self.scroll:self.scroll + visible_rows]):
                row = list_top + row_offset
                attr = curses.A_REVERSE if self.scroll + row_offset == self.index else curses.A_NORMAL
                stdscr.addnstr(row, 0, format_tui_row(item.status, width), width - 1, attr)

        stdscr.addnstr(height - 1, 0, 'Enter: switch  Esc: close  Ctrl+U: clear', width - 1)
        stdscr.refresh()


def select_workspace_tui(actions: WorkspaceActions) -> str | None:
    return WorkspaceTui(actions).run()


def write_selected_target(output_path: str, target: str | None) -> None:
    Path(output_path).write_text(target or '', encoding='utf-8')
