from __future__ import annotations

from dataclasses import dataclass
import threading

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")

from gi.repository import Gdk, GLib, Gtk, Pango

from .actions import TerminalStatus, WorkspaceActions


PROGRAM_CLASS = "workspace-v2-popup"
WINDOW_ROLE = "workspace-v2-popup"
WINDOW_TITLE = "Workspace Launcher"


@dataclass(slots=True)
class PopupItem:
    status: TerminalStatus
    recent_score: float


class WorkspacePopup(Gtk.Window):
    def __init__(self, actions: WorkspaceActions) -> None:
        super().__init__(title=WINDOW_TITLE)
        self.actions = actions
        self.recent_scores = self.actions.state.recent_scores()
        self.statuses = self.actions.list_terminal_statuses()
        self.filtered_items: list[PopupItem] = []

        self.set_role(WINDOW_ROLE)
        self.set_type_hint(Gdk.WindowTypeHint.DIALOG)
        self.set_position(Gtk.WindowPosition.CENTER_ALWAYS)
        self.set_modal(True)
        self.set_skip_taskbar_hint(True)
        self.set_keep_above(True)
        self.set_default_size(760, 460)
        self.set_border_width(12)
        self.connect("destroy", Gtk.main_quit)
        self.connect("key-press-event", self._on_window_key_press)

        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        self.add(outer)

        title = Gtk.Label()
        title.set_markup(f"<b>{GLib.markup_escape_text(WINDOW_TITLE)}</b>")
        title.set_xalign(0)
        outer.pack_start(title, False, False, 0)

        self.search_entry = Gtk.SearchEntry()
        self.search_entry.set_placeholder_text("Type a workspace, host, or path")
        self.search_entry.connect("changed", self._on_search_changed)
        self.search_entry.connect("activate", self._on_activate_selected)
        self.search_entry.connect("key-press-event", self._on_search_key_press)
        outer.pack_start(self.search_entry, False, False, 0)

        self.listbox = Gtk.ListBox()
        self.listbox.set_selection_mode(Gtk.SelectionMode.SINGLE)
        self.listbox.connect("row-activated", self._on_row_activated)

        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scroll.add(self.listbox)
        outer.pack_start(scroll, True, True, 0)

        self.message_label = Gtk.Label()
        self.message_label.set_xalign(0)
        self.message_label.set_markup(
            '<span foreground="#7f8c8d">Enter: open workspace   Esc: close   Recent items are shown first.</span>'
        )
        outer.pack_start(self.message_label, False, False, 0)

        self._apply_css()
        self._refresh_rows()
        self._load_statuses_async()
        self.show_all()
        self.present()
        self.search_entry.grab_focus()

    def _apply_css(self) -> None:
        provider = Gtk.CssProvider()
        provider.load_from_data(
            b"""
            window {
                background: #111827;
            }
            entry {
                font-size: 16px;
                padding: 10px;
            }
            list row {
                padding: 8px;
                border-radius: 8px;
            }
            list row:selected {
                background: rgba(96, 165, 250, 0.18);
            }
            """
        )
        Gtk.StyleContext.add_provider_for_screen(
            Gdk.Screen.get_default(),
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
        )

    def _load_statuses_async(self) -> None:
        def worker() -> None:
            statuses = self.actions.list_terminal_statuses()
            GLib.idle_add(self._apply_statuses, statuses)

        threading.Thread(target=worker, daemon=True).start()

    def _apply_statuses(self, statuses: list[TerminalStatus]) -> bool:
        self.statuses = statuses
        self._refresh_rows()
        return False

    def _refresh_rows(self) -> None:
        query = self.search_entry.get_text().strip().lower()
        items = self._sorted_items(query)
        self.filtered_items = items

        for child in self.listbox.get_children():
            child.destroy()

        if not items:
            row = Gtk.ListBoxRow()
            label = Gtk.Label()
            label.set_markup('<span foreground="#9ca3af">No matching workspaces</span>')
            label.set_xalign(0)
            row.add(label)
            row.set_selectable(False)
            self.listbox.add(row)
            self.listbox.show_all()
            return

        for item in items:
            self.listbox.add(self._build_row(item))

        self.listbox.show_all()
        first_row = self.listbox.get_row_at_index(0)
        if first_row:
            self.listbox.select_row(first_row)

    def _sorted_items(self, query: str) -> list[PopupItem]:
        items = [
            PopupItem(status=status, recent_score=self.recent_scores.get(status.recent_key, 0.0))
            for status in self.statuses
        ]

        if query:
            scored = []
            for item in items:
                haystack = " ".join(
                    [
                        item.status.session_id,
                        item.status.workspace_name,
                        item.status.host.name,
                        item.status.host_id,
                        str(item.status.window_index),
                        f"#{item.status.window_index}",
                        item.status.window_name,
                        item.status.display_path,
                    ]
                ).lower()
                if query not in haystack:
                    continue
                status = item.status
                if status.session_id == query or status.workspace_name.lower() == query or str(status.window_index) == query:
                    rank = 0
                elif status.session_id.startswith(query) or status.workspace_name.lower().startswith(query) or status.window_name.lower().startswith(query):
                    rank = 1
                elif status.host_id.startswith(query) or status.host.name.lower().startswith(query):
                    rank = 2
                else:
                    rank = 3
                scored.append((rank, item))

            scored.sort(
                key=lambda pair: (
                    pair[0],
                    -pair[1].recent_score,
                    -(pair[1].status.activity or 0),
                    not pair[1].status.active,
                    pair[1].status.workspace_name.lower(),
                )
            )
            return [item for _, item in scored]

        items.sort(
            key=lambda item: (
                -(item.status.activity or 0),
                -item.recent_score,
                not item.status.active,
                item.status.host_id,
                item.status.workspace_name.lower(),
                item.status.window_index,
            )
        )
        return items

    def _build_row(self, item: PopupItem) -> Gtk.ListBoxRow:
        row = Gtk.ListBoxRow()
        row.workspace_target = item.status.target

        wrapper = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)

        top = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        dot = Gtk.Label()
        dot.set_markup(self._status_dot_markup(item.status))
        top.pack_start(dot, False, False, 0)

        title = Gtk.Label()
        status = item.status
        title.set_markup(
            f'<span foreground="#f9fafb"><b>{GLib.markup_escape_text(status.workspace_name)}</b></span>'
            f' <span foreground="#f59e0b">#{status.window_index}</span>'
            f' <span foreground="#d1d5db">{GLib.markup_escape_text(status.window_name)}</span>'
        )
        title.set_xalign(0)
        title.set_ellipsize(Pango.EllipsizeMode.END)
        top.pack_start(title, True, True, 0)

        host = Gtk.Label()
        host.set_markup(
            f'<span foreground="#93c5fd">{GLib.markup_escape_text(status.host.name)}</span>'
        )
        host.set_xalign(1)
        top.pack_end(host, False, False, 0)
        wrapper.pack_start(top, False, False, 0)

        detail = Gtk.Label()
        detail_parts = [status.session_id, status.display_path]
        if status.discovered:
            detail_parts.insert(0, "discovered")
        if status.activity:
            detail_parts.insert(0, "tmux-active")
        elif item.recent_score:
            detail_parts.insert(0, "recent")
        detail.set_markup(
            '<span foreground="#9ca3af" size="small">'
            + GLib.markup_escape_text("   ".join(detail_parts))
            + "</span>"
        )
        detail.set_xalign(0)
        detail.set_ellipsize(Pango.EllipsizeMode.MIDDLE)
        wrapper.pack_start(detail, False, False, 0)

        row.add(wrapper)
        return row

    def _status_dot_markup(self, status: WorkspaceStatus) -> str:
        if status.reachable is False:
            return '<span foreground="#ef4444">●</span>'
        if status.active:
            return '<span foreground="#22c55e">●</span>'
        if status.reachable is None:
            return '<span foreground="#9ca3af">◌</span>'
        return '<span foreground="#6b7280">○</span>'

    def _on_search_changed(self, _entry: Gtk.SearchEntry) -> None:
        self._refresh_rows()

    def _on_search_key_press(self, _entry: Gtk.SearchEntry, event: Gdk.EventKey) -> bool:
        key_name = Gdk.keyval_name(event.keyval)
        if key_name == "Down":
            self._move_selection(1)
            return True
        if key_name == "Up":
            self._move_selection(-1)
            return True
        if key_name == "Escape":
            self.destroy()
            return True
        return False

    def _on_window_key_press(self, _window: Gtk.Window, event: Gdk.EventKey) -> bool:
        if Gdk.keyval_name(event.keyval) == "Escape":
            self.destroy()
            return True
        return False

    def _move_selection(self, delta: int) -> None:
        selected = self.listbox.get_selected_row()
        current_index = selected.get_index() if selected else -1
        next_index = max(0, min(current_index + delta, len(self.filtered_items) - 1))
        next_row = self.listbox.get_row_at_index(next_index)
        if next_row:
            self.listbox.select_row(next_row)

    def _selected_target(self) -> str | None:
        row = self.listbox.get_selected_row()
        if not row or not getattr(row, "workspace_target", None):
            return None
        return row.workspace_target

    def _on_activate_selected(self, _entry: Gtk.SearchEntry) -> None:
        target = self._selected_target()
        if target:
            self._launch_target(target)

    def _on_row_activated(self, _listbox: Gtk.ListBox, row: Gtk.ListBoxRow) -> None:
        target = getattr(row, "workspace_target", None)
        if target:
            self._launch_target(target)

    def _launch_target(self, target: str) -> None:
        try:
            self.actions.open_workspace(target)
        except Exception as error:  # pragma: no cover - interactive path
            self.message_label.set_markup(
                f'<span foreground="#fca5a5">{GLib.markup_escape_text(str(error))}</span>'
            )
            return
        self.destroy()


def launch_popup(actions: WorkspaceActions) -> None:
    GLib.set_prgname(PROGRAM_CLASS)
    Gdk.set_program_class(PROGRAM_CLASS)
    WorkspacePopup(actions)
    Gtk.main()
