from __future__ import annotations

import curses
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from .actions import WorkspaceActions, WorkspaceStatus


@dataclass(slots=True)
class TuiItem:
    status: WorkspaceStatus
    searchable_text: str


def build_tui_items(statuses: Iterable[WorkspaceStatus]) -> list[TuiItem]:
    items = []
    for status in statuses:
        workspace = status.workspace
        searchable = " ".join(
            [
                workspace.id,
                workspace.name,
                workspace.host_id,
                workspace.host.name,
                workspace.display_path,
            ]
        ).lower()
        items.append(TuiItem(status=status, searchable_text=searchable))
    return items


def filter_tui_items(items: list[TuiItem], query: str) -> list[TuiItem]:
    if not query:
        return items
    normalized = query.lower()
    ranked: list[tuple[int, TuiItem]] = []
    for item in items:
        workspace = item.status.workspace
        if normalized not in item.searchable_text:
            continue
        if workspace.id == normalized or workspace.name.lower() == normalized:
            rank = 0
        elif workspace.id.startswith(normalized) or workspace.name.lower().startswith(normalized):
            rank = 1
        elif workspace.host_id.startswith(normalized) or workspace.host.name.lower().startswith(normalized):
            rank = 2
        else:
            rank = 3
        ranked.append((rank, item))
    ranked.sort(key=lambda pair: (pair[0], not pair[1].status.active, pair[1].status.workspace.name.lower()))
    return [item for _, item in ranked]


def format_tui_row(status: WorkspaceStatus, width: int) -> str:
    workspace = status.workspace
    if status.reachable is False:
        dot = '!'
    elif status.active:
        dot = '*'
    else:
        dot = '.'
    row = f"{dot} {workspace.name} [{workspace.host.name}] {workspace.id} {workspace.display_path}"
    return row[: max(0, width - 1)]


class WorkspaceTui:
    def __init__(self, actions: WorkspaceActions) -> None:
        self.actions = actions
        self.items = build_tui_items(actions.list_workspace_statuses())
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
                    return filtered[self.index].status.workspace.target
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
            stdscr.addnstr(list_top, 0, 'No matching workspaces', width - 1)
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
