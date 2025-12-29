#!/usr/bin/env python3
"""
Workspace Switcher Panel - GTK panel for managing tmux project sessions
Designed for x2go/XFCE environments with Claude Code workflows
"""

import gi
gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
from gi.repository import Gtk, Gdk, GLib, Pango
import subprocess
import json
import os
import signal
import sys

CONFIG_FILE = os.path.expanduser("~/ai-workflow/workspace-switcher/workspaces.json")
REFRESH_INTERVAL = 2000  # ms

class WorkspaceButton(Gtk.Button):
    """A styled button representing a workspace/tmux session"""

    def __init__(
        self,
        workspace,
        session_info=None,
        on_remove=None,
        on_rename=None,
        activity_recent=False
    ):
        super().__init__()
        self.workspace = workspace
        self.session_info = session_info
        self.on_remove_callback = on_remove
        self.on_rename_callback = on_rename
        self._activity_timeout_id = None
        self._escaped_name = GLib.markup_escape_text(workspace["name"])
        self._base_color = "#2c3e50" if session_info else "#7f8c8d"
        self._pulse_color = "#4ade80"

        # Main container
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        box.set_margin_start(8)
        box.set_margin_end(8)
        box.set_margin_top(4)
        box.set_margin_bottom(4)

        # Top row: name + status indicator
        top_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)

        # Status indicator (green if session exists)
        self.status_dot = Gtk.Label()
        if session_info:
            self.status_dot.set_markup('<span foreground="#2ecc71">●</span>')
            self.set_tooltip_text(f"{workspace['name']}\n{session_info['windows']} window(s)\nClick to attach")
        else:
            self.status_dot.set_markup('<span foreground="#7f8c8d">○</span>')
            self.set_tooltip_text(f"{workspace['name']}\nNo session\nClick to create")

        top_box.pack_start(self.status_dot, False, False, 0)

        # Workspace name - brighter if session active
        self.name_label = Gtk.Label()
        self._base_name_markup = f'<span foreground="{self._base_color}">{self._escaped_name}</span>'
        self.name_label.set_markup(self._base_name_markup)
        self.name_label.set_ellipsize(Pango.EllipsizeMode.END)
        self.name_label.set_max_width_chars(12)
        top_box.pack_start(self.name_label, True, True, 0)

        # Window count badge
        if session_info and session_info['windows'] > 0:
            badge = Gtk.Label()
            badge.set_markup(f'<span size="small" foreground="#95a5a6">{session_info["windows"]}</span>')
            top_box.pack_end(badge, False, False, 0)

        box.pack_start(top_box, True, True, 0)

        # Path hint (small, muted)
        path_label = Gtk.Label()
        short_path = workspace['path'].replace(os.path.expanduser('~'), '~')
        if len(short_path) > 20:
            short_path = '...' + short_path[-17:]
        path_label.set_markup(f'<span size="x-small" foreground="#7f8c8d">{short_path}</span>')
        box.pack_start(path_label, False, False, 0)

        self.add(box)

        # Apply color styling
        self._apply_color(workspace.get('color', '#3498db'))

        if activity_recent:
            self._pulse_activity()

        # Connect click handler
        self.connect('clicked', self.on_clicked)

        # Right-click context menu
        self.connect('button-press-event', self.on_button_press)
        self.connect('destroy', self._on_destroy)

    def on_button_press(self, widget, event):
        """Handle right-click for context menu"""
        if event.button == 3:  # Right click
            menu = Gtk.Menu()

            # Edit item
            rename_item = Gtk.MenuItem(label="Edit...")
            rename_item.connect('activate', self.on_rename_clicked)
            menu.append(rename_item)

            # Separator
            menu.append(Gtk.SeparatorMenuItem())

            # Remove item
            remove_item = Gtk.MenuItem(label=f"Remove '{self.workspace['name']}'")
            remove_item.connect('activate', self.on_remove_clicked)
            menu.append(remove_item)

            # Kill session item (if session exists)
            if self.session_info:
                kill_item = Gtk.MenuItem(label="Kill tmux session")
                kill_item.connect('activate', self.on_kill_session)
                menu.append(kill_item)

            menu.show_all()
            menu.popup_at_pointer(event)
            return True
        return False

    def on_rename_clicked(self, menu_item):
        """Rename this workspace"""
        if self.on_rename_callback:
            self.on_rename_callback(self.workspace['id'], self.workspace['name'])

    def on_remove_clicked(self, menu_item):
        """Remove this workspace from config"""
        if self.on_remove_callback:
            self.on_remove_callback(self.workspace['id'])

    def on_kill_session(self, menu_item):
        """Kill the tmux session for this workspace"""
        session_name = self.workspace['id']
        subprocess.run(['tmux', 'kill-session', '-t', session_name])

    def _apply_color(self, color):
        """Apply workspace color to button"""
        css = f"""
        button {{
            border-left: 3px solid {color};
            border-radius: 4px;
            padding: 2px 4px;
        }}
        button:hover {{
            background-color: alpha({color}, 0.1);
        }}
        """
        provider = Gtk.CssProvider()
        provider.load_from_data(css.encode())
        self.get_style_context().add_provider(provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

    def _pulse_activity(self):
        """Temporarily highlight the workspace name when activity is detected."""
        if self._activity_timeout_id:
            GLib.source_remove(self._activity_timeout_id)
            self._activity_timeout_id = None

        self._set_name_color(self._pulse_color)

        def clear_pulse():
            self._restore_name_color()
            self._activity_timeout_id = None
            return False

        self._activity_timeout_id = GLib.timeout_add(700, clear_pulse)

    def _set_name_color(self, color):
        self.name_label.set_markup(f'<span foreground="{color}">{self._escaped_name}</span>')

    def _restore_name_color(self):
        self._set_name_color(self._base_color)

    def _on_destroy(self, widget):
        if self._activity_timeout_id:
            GLib.source_remove(self._activity_timeout_id)
            self._activity_timeout_id = None

    def on_clicked(self, button):
        """Handle button click - focus existing window or create new one"""
        ws = self.workspace
        session_name = ws['id']
        work_dir = ws['path']
        window_title = f'{ws["name"]} - Workspace'

        # First, try to find and focus an existing terminal window for this workspace
        if self._focus_existing_window(window_title):
            return  # Window found and focused, done!

        # No existing window, check if tmux session exists
        result = subprocess.run(['tmux', 'has-session', '-t', session_name],
                                capture_output=True)
        session_exists = result.returncode == 0

        if session_exists:
            # Attach to existing session in new terminal
            cmd = f"tmux attach-session -t {session_name}"
        else:
            # Create new session and attach
            cmd = f"tmux new-session -s {session_name} -c {work_dir}"

        # Get terminal from config
        terminal = self._get_terminal()

        # Launch terminal with tmux command
        subprocess.Popen([
            terminal,
            '--title', window_title,
            '-e', f'bash -c "{cmd}; exec bash"'
        ])

    def _focus_existing_window(self, title):
        """Try to find and focus a window with the given title. Returns True if found."""
        try:
            # List all windows with wmctrl
            result = subprocess.run(['wmctrl', '-l'], capture_output=True, text=True)
            if result.returncode != 0:
                return False

            # Search for window with matching title
            for line in result.stdout.strip().split('\n'):
                if title in line:
                    # Extract window ID (first column)
                    window_id = line.split()[0]
                    # Activate (focus) the window
                    subprocess.run(['wmctrl', '-i', '-a', window_id])
                    return True
            return False
        except FileNotFoundError:
            # wmctrl not installed
            return False

    def _get_terminal(self):
        """Get configured terminal emulator"""
        try:
            with open(CONFIG_FILE, 'r') as f:
                config = json.load(f)
                return config.get('settings', {}).get('terminal', 'xfce4-terminal')
        except:
            return 'xfce4-terminal'


class AddWorkspaceDialog(Gtk.Dialog):
    """Dialog to add a new workspace"""

    def __init__(self, parent):
        super().__init__(title="Add Workspace", transient_for=parent, flags=0)
        self.add_buttons(
            Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL,
            Gtk.STOCK_OK, Gtk.ResponseType.OK
        )

        self.set_default_size(350, 200)

        box = self.get_content_area()
        box.set_margin_start(10)
        box.set_margin_end(10)
        box.set_margin_top(10)
        box.set_margin_bottom(10)
        box.set_spacing(8)

        # ID field
        id_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        id_label = Gtk.Label(label="ID:")
        id_label.set_width_chars(12)
        id_label.set_xalign(0)
        self.id_entry = Gtk.Entry()
        self.id_entry.set_placeholder_text("project-name")
        id_box.pack_start(id_label, False, False, 0)
        id_box.pack_start(self.id_entry, True, True, 0)
        box.pack_start(id_box, False, False, 0)

        # Name field
        name_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        name_label = Gtk.Label(label="Display Name:")
        name_label.set_width_chars(12)
        name_label.set_xalign(0)
        self.name_entry = Gtk.Entry()
        self.name_entry.set_placeholder_text("My Project")
        name_box.pack_start(name_label, False, False, 0)
        name_box.pack_start(self.name_entry, True, True, 0)
        box.pack_start(name_box, False, False, 0)

        # Path field with browse button
        path_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        path_label = Gtk.Label(label="Path:")
        path_label.set_width_chars(12)
        path_label.set_xalign(0)
        self.path_entry = Gtk.Entry()
        self.path_entry.set_placeholder_text("/home/user/project")
        browse_btn = Gtk.Button(label="...")
        browse_btn.connect('clicked', self.on_browse)
        path_box.pack_start(path_label, False, False, 0)
        path_box.pack_start(self.path_entry, True, True, 0)
        path_box.pack_start(browse_btn, False, False, 0)
        box.pack_start(path_box, False, False, 0)

        # Color picker
        color_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        color_label = Gtk.Label(label="Color:")
        color_label.set_width_chars(12)
        color_label.set_xalign(0)
        self.color_button = Gtk.ColorButton()
        rgba = Gdk.RGBA()
        rgba.parse("#3498db")
        self.color_button.set_rgba(rgba)
        color_box.pack_start(color_label, False, False, 0)
        color_box.pack_start(self.color_button, False, False, 0)
        box.pack_start(color_box, False, False, 0)

        self.show_all()

    def on_browse(self, button):
        dialog = Gtk.FileChooserDialog(
            title="Select Project Directory",
            parent=self,
            action=Gtk.FileChooserAction.SELECT_FOLDER
        )
        dialog.add_buttons(
            Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL,
            Gtk.STOCK_OPEN, Gtk.ResponseType.OK
        )

        if dialog.run() == Gtk.ResponseType.OK:
            self.path_entry.set_text(dialog.get_filename())
        dialog.destroy()

    def get_workspace(self):
        """Return the workspace data"""
        rgba = self.color_button.get_rgba()
        color = "#{:02x}{:02x}{:02x}".format(
            int(rgba.red * 255),
            int(rgba.green * 255),
            int(rgba.blue * 255)
        )
        return {
            'id': self.id_entry.get_text().strip().lower().replace(' ', '-'),
            'name': self.name_entry.get_text().strip(),
            'path': self.path_entry.get_text().strip(),
            'color': color,
            'icon': 'folder',
            'description': ''
        }


class WorkspaceSwitcher(Gtk.Window):
    """Main workspace switcher panel window"""

    def __init__(self):
        super().__init__(title="Workspaces")

        # Window setup for panel-like behavior
        self.set_default_size(180, 400)
        self.set_keep_above(True)
        self.set_decorated(True)
        self.set_resizable(True)
        self.set_type_hint(Gdk.WindowTypeHint.UTILITY)

        # Position on right side of screen
        display = Gdk.Display.get_default()
        monitor = display.get_primary_monitor() or display.get_monitor(0)
        if monitor:
            geometry = monitor.get_geometry()
            self.move(geometry.x + geometry.width - 200, geometry.y + 50)

        # Main container
        main_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)

        # Header with title and add button
        header_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
        header_box.set_margin_start(8)
        header_box.set_margin_end(8)
        header_box.set_margin_top(8)
        header_box.set_margin_bottom(4)

        title_label = Gtk.Label()
        title_label.set_markup('<b>Workspaces</b>')
        header_box.pack_start(title_label, True, True, 0)

        # Add workspace button
        add_btn = Gtk.Button()
        add_btn.set_image(Gtk.Image.new_from_icon_name("list-add", Gtk.IconSize.SMALL_TOOLBAR))
        add_btn.set_relief(Gtk.ReliefStyle.NONE)
        add_btn.set_tooltip_text("Add workspace")
        add_btn.connect('clicked', self.on_add_workspace)
        header_box.pack_end(add_btn, False, False, 0)

        # Refresh button
        refresh_btn = Gtk.Button()
        refresh_btn.set_image(Gtk.Image.new_from_icon_name("view-refresh", Gtk.IconSize.SMALL_TOOLBAR))
        refresh_btn.set_relief(Gtk.ReliefStyle.NONE)
        refresh_btn.set_tooltip_text("Refresh sessions")
        refresh_btn.connect('clicked', lambda b: self.refresh_workspaces())
        header_box.pack_end(refresh_btn, False, False, 0)

        main_box.pack_start(header_box, False, False, 0)

        # Separator
        main_box.pack_start(Gtk.Separator(), False, False, 4)

        # Scrollable workspace list
        scroll = Gtk.ScrolledWindow()
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)

        self.workspace_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        self.workspace_box.set_margin_start(4)
        self.workspace_box.set_margin_end(4)
        self.workspace_box.set_margin_top(4)
        self.workspace_box.set_margin_bottom(4)

        scroll.add(self.workspace_box)
        main_box.pack_start(scroll, True, True, 0)

        # Footer with session count
        self.footer_label = Gtk.Label()
        self.footer_label.set_markup('<span size="small" foreground="#7f8c8d">Loading...</span>')
        main_box.pack_end(self.footer_label, False, False, 8)

        self.add(main_box)

        # Load workspaces
        self.last_session_activity = {}
        self.refresh_workspaces()

        # Auto-refresh timer
        GLib.timeout_add(REFRESH_INTERVAL, self.auto_refresh)

        # Handle close
        self.connect('delete-event', self.on_close)

    def on_close(self, widget, event):
        """Handle window close - actually close the application"""
        Gtk.main_quit()
        return False  # Allow close

    def auto_refresh(self):
        """Periodically refresh session status"""
        self.refresh_workspaces()
        return True  # Keep timer running

    def refresh_workspaces(self):
        """Reload workspaces and session info"""
        # Clear existing buttons - destroy them to free memory
        for child in self.workspace_box.get_children():
            child.destroy()

        # Load config
        workspaces = self.load_config()

        # Get tmux session info
        sessions = self.get_tmux_sessions()
        self.last_session_activity = {
            key: value
            for key, value in self.last_session_activity.items()
            if key in sessions
        }

        # Create buttons
        active_count = 0
        for ws in workspaces:
            session_info = sessions.get(ws['id'])
            activity_recent = False
            if session_info:
                active_count += 1
                activity = session_info.get('activity')
                previous_activity = self.last_session_activity.get(ws['id'])
                if activity is not None and previous_activity is not None and activity > previous_activity:
                    activity_recent = True
                if activity is not None:
                    self.last_session_activity[ws['id']] = activity
            btn = WorkspaceButton(
                ws,
                session_info,
                on_remove=self.remove_workspace,
                on_rename=self.rename_workspace,
                activity_recent=activity_recent
            )
            self.workspace_box.pack_start(btn, False, False, 0)

        # Update footer
        total = len(workspaces)
        self.footer_label.set_markup(
            f'<span size="small" foreground="#7f8c8d">{active_count}/{total} active</span>'
        )

        self.workspace_box.show_all()

    def load_config(self):
        """Load workspaces from config file"""
        try:
            with open(CONFIG_FILE, 'r') as f:
                config = json.load(f)
                return config.get('workspaces', [])
        except FileNotFoundError:
            return []
        except json.JSONDecodeError:
            return []

    def save_config(self, workspaces):
        """Save workspaces to config file"""
        try:
            with open(CONFIG_FILE, 'r') as f:
                config = json.load(f)
        except:
            config = {'settings': {'terminal': 'xfce4-terminal'}}

        config['workspaces'] = workspaces

        with open(CONFIG_FILE, 'w') as f:
            json.dump(config, f, indent=2)

    def remove_workspace(self, workspace_id):
        """Remove a workspace from config, optionally killing tmux session"""
        # Check if tmux session exists
        result = subprocess.run(['tmux', 'has-session', '-t', workspace_id],
                                capture_output=True)
        session_exists = result.returncode == 0

        if session_exists:
            # Ask user if they want to kill the session too
            dialog = Gtk.MessageDialog(
                transient_for=self,
                flags=0,
                message_type=Gtk.MessageType.QUESTION,
                buttons=Gtk.ButtonsType.YES_NO,
                text=f"Kill tmux session '{workspace_id}'?"
            )
            dialog.format_secondary_text(
                "A tmux session is running for this workspace. Kill it too?"
            )
            response = dialog.run()
            dialog.destroy()

            if response == Gtk.ResponseType.YES:
                subprocess.run(['tmux', 'kill-session', '-t', workspace_id])

        workspaces = self.load_config()
        workspaces = [ws for ws in workspaces if ws['id'] != workspace_id]
        self.save_config(workspaces)
        self.refresh_workspaces()

    def rename_workspace(self, workspace_id, current_name):
        """Edit a workspace (name and path)"""
        # Get current workspace data
        workspaces = self.load_config()
        current_ws = next((ws for ws in workspaces if ws['id'] == workspace_id), None)
        if not current_ws:
            return

        dialog = Gtk.Dialog(
            title="Edit Workspace",
            transient_for=self,
            flags=0
        )
        dialog.add_buttons(
            Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL,
            Gtk.STOCK_OK, Gtk.ResponseType.OK
        )
        dialog.set_default_size(350, 150)

        box = dialog.get_content_area()
        box.set_margin_start(10)
        box.set_margin_end(10)
        box.set_margin_top(10)
        box.set_margin_bottom(10)
        box.set_spacing(8)

        # Name field
        name_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        name_label = Gtk.Label(label="Name:")
        name_label.set_width_chars(6)
        name_label.set_xalign(0)
        name_entry = Gtk.Entry()
        name_entry.set_text(current_name)
        name_entry.select_region(0, -1)
        name_box.pack_start(name_label, False, False, 0)
        name_box.pack_start(name_entry, True, True, 0)
        box.pack_start(name_box, False, False, 0)

        # Path field with browse button
        path_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        path_label = Gtk.Label(label="Path:")
        path_label.set_width_chars(6)
        path_label.set_xalign(0)
        path_entry = Gtk.Entry()
        path_entry.set_text(current_ws.get('path', ''))

        def on_browse(button):
            file_dialog = Gtk.FileChooserDialog(
                title="Select Project Directory",
                parent=dialog,
                action=Gtk.FileChooserAction.SELECT_FOLDER
            )
            file_dialog.add_buttons(
                Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL,
                Gtk.STOCK_OPEN, Gtk.ResponseType.OK
            )
            if file_dialog.run() == Gtk.ResponseType.OK:
                path_entry.set_text(file_dialog.get_filename())
            file_dialog.destroy()

        browse_btn = Gtk.Button(label="...")
        browse_btn.connect('clicked', on_browse)
        path_box.pack_start(path_label, False, False, 0)
        path_box.pack_start(path_entry, True, True, 0)
        path_box.pack_start(browse_btn, False, False, 0)
        box.pack_start(path_box, False, False, 0)

        name_entry.connect('activate', lambda e: dialog.response(Gtk.ResponseType.OK))

        dialog.show_all()
        response = dialog.run()

        if response == Gtk.ResponseType.OK:
            new_name = name_entry.get_text().strip()
            new_path = path_entry.get_text().strip()
            changed = False

            for ws in workspaces:
                if ws['id'] == workspace_id:
                    if new_name and new_name != ws.get('name'):
                        ws['name'] = new_name
                        changed = True
                    if new_path and new_path != ws.get('path'):
                        ws['path'] = new_path
                        changed = True
                    break

            if changed:
                self.save_config(workspaces)
                self.refresh_workspaces()

        dialog.destroy()

    def get_tmux_sessions(self):
        """Get info about running tmux sessions"""
        sessions = {}
        try:
            result = subprocess.run(
                ['tmux', 'list-sessions', '-F', '#{session_name}:#{session_windows}:#{session_activity}'],
                capture_output=True, text=True,
                env={**os.environ, 'TMUX': ''}  # Ensure we can query from outside tmux
            )
            if result.returncode == 0:
                for line in result.stdout.strip().split('\n'):
                    if ':' in line:
                        parts = line.rsplit(':', 2)
                        if len(parts) != 3:
                            continue
                        name, windows, activity = parts
                        sessions[name] = {
                            'windows': int(windows),
                            'activity': int(activity)
                        }
            windows_result = subprocess.run(
                ['tmux', 'list-windows', '-a', '-F', '#{session_name}:#{window_activity}'],
                capture_output=True, text=True,
                env={**os.environ, 'TMUX': ''}
            )
            if windows_result.returncode == 0:
                for line in windows_result.stdout.strip().split('\n'):
                    if ':' not in line:
                        continue
                    session_name, activity = line.rsplit(':', 1)
                    if not activity:
                        continue
                    session_info = sessions.get(session_name)
                    if session_info is None:
                        continue
                    activity_value = int(activity)
                    if activity_value > session_info['activity']:
                        session_info['activity'] = activity_value
        except Exception as e:
            print(f"tmux detection error: {e}")  # Debug logging
        return sessions

    def on_add_workspace(self, button):
        """Show dialog to add new workspace"""
        dialog = AddWorkspaceDialog(self)
        response = dialog.run()

        if response == Gtk.ResponseType.OK:
            ws = dialog.get_workspace()
            if ws['id'] and ws['name'] and ws['path']:
                workspaces = self.load_config()
                workspaces.append(ws)
                self.save_config(workspaces)
                self.refresh_workspaces()

        dialog.destroy()


def main():
    # Handle Ctrl+C gracefully
    signal.signal(signal.SIGINT, signal.SIG_DFL)

    win = WorkspaceSwitcher()
    win.connect('destroy', Gtk.main_quit)
    win.show_all()
    Gtk.main()


if __name__ == '__main__':
    main()
