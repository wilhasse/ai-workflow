from __future__ import annotations

from dataclasses import dataclass
import threading
import time

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")

from gi.repository import Gdk, GLib, Gtk, Pango

from .actions import TerminalStatus, WorkspaceActions, terminal_recent_score, terminal_sort_key


PROGRAM_CLASS = "workspace-v2-popup"
WINDOW_ROLE = "workspace-v2-popup"
WINDOW_TITLE = "Workspace Launcher"
SHORTCUT_HELP = "↑↓ Navigate · Enter Open · Alt+L Label · Alt+C Check · Alt+I Idle · Alt+A Active"


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
        self.set_default_size(860, 680)
        self.set_border_width(12)
        self.connect("destroy", Gtk.main_quit)
        self.connect("key-press-event", self._on_window_key_press)

        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        self.add(outer)

        title = Gtk.Label()
        title.set_markup(f"<b>{GLib.markup_escape_text(WINDOW_TITLE)}</b>")
        title.set_xalign(0)
        outer.pack_start(title, False, False, 0)

        shortcut_help = Gtk.Label()
        shortcut_help.set_markup(
            f'<span foreground="#8fa1b6" size="small">{GLib.markup_escape_text(SHORTCUT_HELP)}</span>'
        )
        shortcut_help.set_xalign(0)
        outer.pack_start(shortcut_help, False, False, 0)

        self.search_entry = Gtk.SearchEntry()
        self.search_entry.set_placeholder_text("Type a tab label, workspace, host, or path")
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
                background: #05070d;
                color: #c2ccd8;
            }
            entry {
                background: #080c13;
                color: #d4dde8;
                border: 1px solid #263244;
                border-radius: 6px;
                font-size: 16px;
                padding: 10px;
            }
            list {
                background: #05070d;
            }
            list row {
                background: #070a10;
                border: 1px solid #121a28;
                padding: 8px;
                border-radius: 6px;
            }
            list row:selected {
                background: #182235;
                border-color: #30405a;
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

    def _refresh_rows(self, preferred_target: str | None = None) -> None:
        selected_target = preferred_target or self._selected_target()
        query = self.search_entry.get_text().strip().lower()
        items = self._sorted_items(query)
        self.filtered_items = items
        label = "terminal" if len(items) == 1 else "terminals"
        self.message_label.set_markup(
            f'<span foreground="#7f8c8d">Showing {len(items)} {label}. Enter: open   Esc: close   Recent items are shown first.</span>'
        )

        for child in self.listbox.get_children():
            child.destroy()

        if not items:
            row = Gtk.ListBoxRow()
            label = Gtk.Label()
            label.set_markup('<span foreground="#9ca3af">No matching terminals</span>')
            label.set_xalign(0)
            row.add(label)
            row.set_selectable(False)
            self.listbox.add(row)
            self.listbox.show_all()
            return

        selected_row = None
        for item in items:
            row = self._build_row(item)
            if selected_target and item.status.target == selected_target:
                selected_row = row
            self.listbox.add(row)

        self.listbox.show_all()
        self.listbox.select_row(selected_row or self.listbox.get_row_at_index(0))

    def _sorted_items(self, query: str) -> list[PopupItem]:
        items = [
            PopupItem(status=status, recent_score=terminal_recent_score(status, self.recent_scores))
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
                        item.status.window_status,
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
                    terminal_sort_key(pair[1].status, self.recent_scores),
                    pair[1].status.workspace_name.lower(),
                )
            )
            return [item for _, item in scored]

        items.sort(key=lambda item: terminal_sort_key(item.status, self.recent_scores))
        return items

    def _build_row(self, item: PopupItem) -> Gtk.ListBoxRow:
        row = Gtk.ListBoxRow()
        row.workspace_target = item.status.target
        row.terminal_status = item.status

        wrapper = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)

        top = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        dot = Gtk.Label()
        dot.set_markup(self._status_dot_markup(item.status))
        top.pack_start(dot, False, False, 0)

        title = Gtk.Label()
        status = item.status
        tab = f"#{status.window_index}" if status.window_index > 0 else "--"
        discovered = " *" if status.discovered else ""
        flag = ""
        if status.window_status:
            flag_color = "#facc15" if status.window_status == "check" else "#94a3b8"
            flag = (
                f' <span foreground="{flag_color}">'
                f'{GLib.markup_escape_text(f"[{status.window_status}]")}</span>'
            )
        title.set_markup(
            f'<span foreground="#d5dde8"><b>{GLib.markup_escape_text(status.window_name)}</b></span>'
            f' <span foreground="#c5a15c">{GLib.markup_escape_text(tab)}</span>'
            f'{flag}'
            f' <span foreground="#aeb8c6">{GLib.markup_escape_text(status.workspace_name + discovered)}</span>'
        )
        title.set_xalign(0)
        title.set_ellipsize(Pango.EllipsizeMode.END)
        top.pack_start(title, True, True, 0)

        host = Gtk.Label()
        host.set_markup(
            f'<span foreground="#8fa1b6">{GLib.markup_escape_text(status.host.name)}</span>'
        )
        host.set_xalign(1)
        top.pack_end(host, False, False, 0)
        wrapper.pack_start(top, False, False, 0)

        detail = Gtk.Label()
        detail_parts = [status.host.name, status.session_id, status.display_path]
        if status.window_status:
            detail_parts.insert(0, status.window_status)
        if status.tmux_window_name and status.tmux_window_name != status.window_name:
            detail_parts.insert(0, f"tmux {status.tmux_window_name}")
        if item.recent_score:
            detail_parts.insert(0, f"recent {self._relative_time(item.recent_score)}")
        detail.set_markup(
            '<span foreground="#7e8a99" size="small">'
            + GLib.markup_escape_text("   ".join(detail_parts))
            + "</span>"
        )
        detail.set_xalign(0)
        detail.set_ellipsize(Pango.EllipsizeMode.MIDDLE)
        wrapper.pack_start(detail, False, False, 0)

        row.add(wrapper)
        return row

    def _relative_time(self, timestamp: float) -> str:
        if not timestamp:
            return "never"
        diff = max(0, int(time.time()) - int(timestamp))
        if diff < 60:
            return "just now"
        minutes = diff // 60
        if minutes < 60:
            return f"{minutes}m ago"
        hours = minutes // 60
        if hours < 24:
            return f"{hours}h ago"
        return f"{hours // 24}d ago"

    def _status_dot_markup(self, status: TerminalStatus) -> str:
        if status.reachable is False:
            return '<span foreground="#c45f5f">●</span>'
        if status.window_status == "check":
            return '<span foreground="#facc15">●</span>'
        if status.window_status == "idle":
            return '<span foreground="#7e8a99">●</span>'
        if status.active:
            return '<span foreground="#6ea979">●</span>'
        if status.reachable is None:
            return '<span foreground="#7e8a99">◌</span>'
        return '<span foreground="#556070">○</span>'

    def _on_search_changed(self, _entry: Gtk.SearchEntry) -> None:
        self._refresh_rows()

    def _on_search_key_press(self, _entry: Gtk.SearchEntry, event: Gdk.EventKey) -> bool:
        if self._handle_edit_shortcut(event):
            return True
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
        if self._handle_edit_shortcut(event):
            return True
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

    def _selected_status(self) -> TerminalStatus | None:
        row = self.listbox.get_selected_row()
        if not row:
            return None
        status = getattr(row, "terminal_status", None)
        return status if isinstance(status, TerminalStatus) else None

    def _handle_edit_shortcut(self, event: Gdk.EventKey) -> bool:
        if not event.state & Gdk.ModifierType.MOD1_MASK:
            return False
        key_name = (Gdk.keyval_name(event.keyval) or "").lower()
        if key_name == "l":
            self._rename_selected()
            return True
        if key_name == "c":
            self._set_selected_status("check")
            return True
        if key_name == "i":
            self._set_selected_status("idle")
            return True
        if key_name == "a":
            self._set_selected_status("")
            return True
        return False

    def _rename_selected(self) -> None:
        status = self._selected_status()
        if not status:
            return
        if status.window_index <= 0:
            self._set_message("Open or create this workspace before labeling its terminal.", error=True)
            return

        dialog = Gtk.Dialog(title="Label terminal", transient_for=self, flags=Gtk.DialogFlags.MODAL)
        dialog.add_buttons(Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL, Gtk.STOCK_SAVE, Gtk.ResponseType.OK)
        dialog.set_default_response(Gtk.ResponseType.OK)

        content = dialog.get_content_area()
        content.set_margin_start(12)
        content.set_margin_end(12)
        content.set_margin_top(12)
        content.set_margin_bottom(12)
        content.set_spacing(8)

        label = Gtk.Label()
        label.set_xalign(0)
        label.set_markup(
            "<b>Brief terminal name</b>\n"
            f'<span foreground="#8fa1b6" size="small">'
            f'{GLib.markup_escape_text(status.workspace_name)} #{status.window_index}'
            "</span>"
        )
        content.pack_start(label, False, False, 0)

        entry = Gtk.Entry()
        entry.set_placeholder_text(status.tmux_window_name or status.window_name)
        entry.set_text(status.window_label)
        entry.set_activates_default(True)
        content.pack_start(entry, False, False, 0)

        dialog.show_all()
        entry.grab_focus()
        entry.select_region(0, -1)
        response = dialog.run()
        value = entry.get_text()
        dialog.destroy()

        if response != Gtk.ResponseType.OK:
            return
        self._set_selected_metadata(status, label=value)

    def _set_selected_status(self, status_value: str) -> None:
        status = self._selected_status()
        if not status:
            return
        if status.window_index <= 0:
            self._set_message("Open or create this workspace before flagging its terminal.", error=True)
            return
        self._set_selected_metadata(status, status_value=status_value)

    def _set_selected_metadata(
        self,
        terminal: TerminalStatus,
        *,
        label: object | None = None,
        status_value: object | None = None,
    ) -> None:
        metadata = self.actions.state.set_window_metadata(
            terminal.host_id,
            terminal.session_id,
            terminal.window_index,
            label=label,
            status=status_value,
        )
        self.recent_scores = self.actions.state.recent_scores()
        self.statuses = self.actions.list_terminal_statuses()
        self._refresh_rows(preferred_target=terminal.target)
        label_text = metadata.get("label") or "unlabeled"
        status_text = metadata.get("status") or "active"
        self._set_message(
            f"Updated {terminal.workspace_name} #{terminal.window_index}: {label_text}, {status_text}."
        )

    def _set_message(self, text: str, *, error: bool = False) -> None:
        color = "#fca5a5" if error else "#7f8c8d"
        self.message_label.set_markup(
            f'<span foreground="{color}">{GLib.markup_escape_text(text)}</span>'
        )

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
