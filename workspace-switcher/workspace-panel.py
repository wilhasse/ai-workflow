#!/usr/bin/env python3
"""
Workspace Switcher Panel - GTK panel for managing tmux project sessions
Designed for x2go/XFCE environments with Claude Code workflows
Supports multiple terminal emulators and remote VM workspaces via SSH
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
import threading
import time

CONFIG_FILE = os.path.expanduser("~/ai-workflow/workspace-switcher/workspaces.json")
REFRESH_INTERVAL = 2000  # ms
SSH_HEALTH_INTERVAL = 30  # seconds
SSH_CACHE_TTL = 1  # seconds - short TTL for responsive activity detection


class SSHHealthChecker:
    """Background thread for checking SSH host reachability"""

    def __init__(self, on_status_change):
        self.on_status_change = on_status_change
        self.host_status = {}  # host_id -> {'reachable': bool, 'last_check': timestamp}
        self._running = False
        self._thread = None
        self._hosts = []

    def set_hosts(self, hosts):
        """Update the list of hosts to check"""
        self._hosts = [h for h in hosts if h.get('ssh')]  # Only check remote hosts

    def check_all_now(self):
        """Run immediate health check for all hosts (called from main thread)"""
        def do_check():
            for host in self._hosts:
                host_id = host['id']
                ssh_target = host.get('ssh')
                if not ssh_target:
                    continue
                reachable = self._check_host(ssh_target)
                self.host_status[host_id] = {
                    'reachable': reachable,
                    'last_check': time.time()
                }
                GLib.idle_add(self.on_status_change, host_id, reachable)
        # Run in background to not block UI
        threading.Thread(target=do_check, daemon=True).start()

    def mark_reachable(self, host_id):
        """Mark a host as reachable (called when SSH succeeds)"""
        if host_id and host_id != 'local':
            old_status = self.host_status.get(host_id, {}).get('reachable')
            self.host_status[host_id] = {
                'reachable': True,
                'last_check': time.time()
            }
            if old_status != True:
                GLib.idle_add(self.on_status_change, host_id, True)

    def start(self):
        """Start the health checker thread"""
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        """Stop the health checker thread"""
        self._running = False

    def _run(self):
        """Main loop for health checking"""
        while self._running:
            for host in self._hosts:
                host_id = host['id']
                ssh_target = host.get('ssh')
                if not ssh_target:
                    continue

                reachable = self._check_host(ssh_target)
                old_status = self.host_status.get(host_id, {}).get('reachable')
                self.host_status[host_id] = {
                    'reachable': reachable,
                    'last_check': time.time()
                }

                # Notify on status change
                if old_status != reachable:
                    GLib.idle_add(self.on_status_change, host_id, reachable)

            time.sleep(SSH_HEALTH_INTERVAL)

    def _check_host(self, ssh_target):
        """Check if SSH host is reachable"""
        try:
            result = subprocess.run(
                ['ssh', '-o', 'ConnectTimeout=2', '-o', 'BatchMode=yes', ssh_target, 'exit'],
                capture_output=True,
                timeout=5
            )
            return result.returncode == 0
        except (subprocess.TimeoutExpired, Exception):
            return False

    def get_status(self, host_id):
        """Get cached status for a host"""
        return self.host_status.get(host_id, {}).get('reachable', None)

    def is_local(self, host_id):
        """Check if host is local (no SSH needed)"""
        return host_id == 'local' or host_id is None


class RemoteSessionCache:
    """Cache for remote tmux session queries"""

    def __init__(self):
        self._cache = {}  # host_id -> {'sessions': dict, 'timestamp': float}

    def get(self, host_id):
        """Get cached sessions if not expired"""
        entry = self._cache.get(host_id)
        if entry and (time.time() - entry['timestamp']) < SSH_CACHE_TTL:
            return entry['sessions']
        return None

    def set(self, host_id, sessions):
        """Cache sessions for a host"""
        self._cache[host_id] = {
            'sessions': sessions,
            'timestamp': time.time()
        }

    def invalidate(self, host_id=None):
        """Invalidate cache for a host or all hosts"""
        if host_id:
            self._cache.pop(host_id, None)
        else:
            self._cache.clear()


class WorkspaceButton(Gtk.Button):
    """A styled button representing a workspace/tmux session"""

    def __init__(
        self,
        workspace,
        host_info=None,
        session_info=None,
        on_remove=None,
        on_rename=None,
        on_activate=None,
        activity_recent=False
    ):
        super().__init__()
        self.workspace = workspace
        self.host_info = host_info
        self.session_info = session_info
        self.on_remove_callback = on_remove
        self.on_rename_callback = on_rename
        self.on_activate_callback = on_activate
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
        host = self.workspace.get('host', 'local')

        if host == 'local' or not self.host_info or not self.host_info.get('ssh'):
            subprocess.run(['tmux', 'kill-session', '-t', session_name])
        else:
            ssh_target = self.host_info['ssh']
            subprocess.run(['ssh', ssh_target, f'tmux kill-session -t {session_name}'])

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
        host = ws.get('host', 'local')

        # First, try to find and focus an existing terminal window for this workspace
        # Search by session name (tmux sets window title to "session : window — Konsole")
        if self._focus_existing_window(session_name):
            return  # Window found and focused, done!

        # Get terminal from config
        terminal = self._get_terminal()

        # Build the tmux command based on host type
        if host == 'local' or not self.host_info or not self.host_info.get('ssh'):
            # Local workspace
            result = subprocess.run(['tmux', 'has-session', '-t', session_name],
                                    capture_output=True)
            session_exists = result.returncode == 0

            if session_exists:
                cmd = f"tmux attach-session -t {session_name}"
            else:
                cmd = f"tmux new-session -s {session_name} -c {work_dir}"
        else:
            # Remote workspace via SSH
            ssh_target = self.host_info['ssh']
            # SSH + tmux attach/create in one command (use single quotes to avoid escaping issues)
            tmux_cmd = f"tmux attach -t {session_name} || tmux new -s {session_name} -c {work_dir}"
            cmd = f"ssh -t {ssh_target} '{tmux_cmd}'"

        # Launch terminal with command (use single quotes for outer to allow double quotes in cmd)
        subprocess.Popen([
            terminal,
            '-e', f"bash -c \"{cmd}; exec bash\""
        ])

        # Notify parent to refresh after a delay (so session appears as active)
        if self.on_activate_callback:
            self.on_activate_callback(ws.get('host', 'local'))

    def _focus_existing_window(self, search_term):
        """Try to find and focus a window with the given search term in title. Returns True if found."""
        try:
            # List all windows with wmctrl
            result = subprocess.run(['wmctrl', '-l'], capture_output=True, text=True)
            if result.returncode != 0:
                return False

            # Search for window with matching title (e.g., "dbtools : bash" contains "dbtools")
            for line in result.stdout.strip().split('\n'):
                if search_term in line:
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

    def __init__(self, parent, hosts=None):
        super().__init__(title="Add Workspace", transient_for=parent, flags=0)
        self.add_buttons(
            Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL,
            Gtk.STOCK_OK, Gtk.ResponseType.OK
        )

        self.hosts = hosts or [{'id': 'local', 'name': 'Local', 'ssh': None}]
        self.set_default_size(350, 250)

        box = self.get_content_area()
        box.set_margin_start(10)
        box.set_margin_end(10)
        box.set_margin_top(10)
        box.set_margin_bottom(10)
        box.set_spacing(8)

        # Host field
        host_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        host_label = Gtk.Label(label="Host:")
        host_label.set_width_chars(12)
        host_label.set_xalign(0)
        self.host_combo = Gtk.ComboBoxText()
        for host in self.hosts:
            self.host_combo.append(host['id'], host['name'])
        self.host_combo.set_active(0)
        host_box.pack_start(host_label, False, False, 0)
        host_box.pack_start(self.host_combo, True, True, 0)
        box.pack_start(host_box, False, False, 0)

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
            'description': '',
            'host': self.host_combo.get_active_id() or 'local'
        }


class SettingsDialog(Gtk.Dialog):
    """Dialog for application settings"""

    def __init__(self, parent, config):
        super().__init__(title="Settings", transient_for=parent, flags=0)
        self.add_buttons(
            Gtk.STOCK_CANCEL, Gtk.ResponseType.CANCEL,
            Gtk.STOCK_OK, Gtk.ResponseType.OK
        )

        self.config = config
        self.set_default_size(400, 300)

        box = self.get_content_area()
        box.set_margin_start(10)
        box.set_margin_end(10)
        box.set_margin_top(10)
        box.set_margin_bottom(10)
        box.set_spacing(12)

        # Terminal emulator section
        terminal_frame = Gtk.Frame(label="Terminal")
        terminal_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        terminal_box.set_margin_start(10)
        terminal_box.set_margin_end(10)
        terminal_box.set_margin_top(10)
        terminal_box.set_margin_bottom(10)

        term_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        term_label = Gtk.Label(label="Emulator:")
        term_label.set_width_chars(10)
        term_label.set_xalign(0)

        self.terminal_combo = Gtk.ComboBoxText()
        settings = config.get('settings', {})
        terminals = settings.get('terminals', ['xfce4-terminal', 'konsole', 'gnome-terminal'])
        current_terminal = settings.get('terminal', 'xfce4-terminal')

        for term in terminals:
            self.terminal_combo.append_text(term)

        # Set active terminal
        try:
            idx = terminals.index(current_terminal)
            self.terminal_combo.set_active(idx)
        except ValueError:
            self.terminal_combo.set_active(0)

        term_row.pack_start(term_label, False, False, 0)
        term_row.pack_start(self.terminal_combo, True, True, 0)
        terminal_box.pack_start(term_row, False, False, 0)

        # Shell path
        shell_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        shell_label = Gtk.Label(label="Shell:")
        shell_label.set_width_chars(10)
        shell_label.set_xalign(0)
        self.shell_entry = Gtk.Entry()
        self.shell_entry.set_text(settings.get('shell', '/bin/bash'))
        shell_row.pack_start(shell_label, False, False, 0)
        shell_row.pack_start(self.shell_entry, True, True, 0)
        terminal_box.pack_start(shell_row, False, False, 0)

        terminal_frame.add(terminal_box)
        box.pack_start(terminal_frame, False, False, 0)

        # Hosts section
        hosts_frame = Gtk.Frame(label="Remote Hosts")
        hosts_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        hosts_box.set_margin_start(10)
        hosts_box.set_margin_end(10)
        hosts_box.set_margin_top(10)
        hosts_box.set_margin_bottom(10)

        # Host list
        hosts = config.get('hosts', [])
        self.host_store = Gtk.ListStore(str, str, str)  # id, name, ssh
        for host in hosts:
            self.host_store.append([host['id'], host['name'], host.get('ssh') or ''])

        self.host_tree = Gtk.TreeView(model=self.host_store)

        # Columns
        renderer = Gtk.CellRendererText()
        renderer.set_property('editable', True)
        renderer.connect('edited', self._on_host_name_edited)
        col = Gtk.TreeViewColumn("Name", renderer, text=1)
        col.set_expand(True)
        self.host_tree.append_column(col)

        renderer2 = Gtk.CellRendererText()
        renderer2.set_property('editable', True)
        renderer2.connect('edited', self._on_host_ssh_edited)
        col2 = Gtk.TreeViewColumn("SSH Target", renderer2, text=2)
        col2.set_expand(True)
        self.host_tree.append_column(col2)

        scroll = Gtk.ScrolledWindow()
        scroll.set_min_content_height(100)
        scroll.add(self.host_tree)
        hosts_box.pack_start(scroll, True, True, 0)

        # Add/Remove host buttons
        btn_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        add_host_btn = Gtk.Button(label="Add Host")
        add_host_btn.connect('clicked', self._on_add_host)
        remove_host_btn = Gtk.Button(label="Remove")
        remove_host_btn.connect('clicked', self._on_remove_host)
        btn_box.pack_start(add_host_btn, False, False, 0)
        btn_box.pack_start(remove_host_btn, False, False, 0)
        hosts_box.pack_start(btn_box, False, False, 0)

        hosts_frame.add(hosts_box)
        box.pack_start(hosts_frame, True, True, 0)

        self.show_all()

    def _on_host_name_edited(self, renderer, path, new_text):
        self.host_store[path][1] = new_text

    def _on_host_ssh_edited(self, renderer, path, new_text):
        self.host_store[path][2] = new_text

    def _on_add_host(self, button):
        # Generate unique ID
        existing_ids = [row[0] for row in self.host_store]
        new_id = "host1"
        counter = 1
        while new_id in existing_ids:
            counter += 1
            new_id = f"host{counter}"
        self.host_store.append([new_id, f"Host {counter}", "user@hostname"])

    def _on_remove_host(self, button):
        selection = self.host_tree.get_selection()
        model, iter = selection.get_selected()
        if iter:
            host_id = model[iter][0]
            if host_id != 'local':  # Don't allow removing local
                model.remove(iter)

    def get_settings(self):
        """Return updated settings"""
        settings = self.config.get('settings', {}).copy()
        settings['terminal'] = self.terminal_combo.get_active_text() or 'xfce4-terminal'
        settings['shell'] = self.shell_entry.get_text().strip() or '/bin/bash'
        return settings

    def get_hosts(self):
        """Return updated hosts list"""
        hosts = []
        for row in self.host_store:
            host = {
                'id': row[0],
                'name': row[1],
                'ssh': row[2] if row[2] else None
            }
            hosts.append(host)
        return hosts


class HostTabBar(Gtk.Box):
    """Tab bar for switching between hosts"""

    def __init__(self, hosts, on_host_selected):
        super().__init__(orientation=Gtk.Orientation.HORIZONTAL, spacing=2)
        self.hosts = hosts
        self.on_host_selected = on_host_selected
        self.buttons = {}
        self.health_indicators = {}
        self.workspace_counts = {}
        self.name_labels = {}
        self._active_host = 'local'
        self._pulse_timeout_ids = {}  # host_id -> timeout_id
        self._pulse_color = "#4ade80"  # Green pulse color

        self.set_margin_start(4)
        self.set_margin_end(4)
        self.set_margin_top(4)
        self.set_margin_bottom(4)

        self._build_tabs()

    def _build_tabs(self):
        """Build tab buttons for each host"""
        # Clean up old pulse timeouts
        for timeout_id in self._pulse_timeout_ids.values():
            GLib.source_remove(timeout_id)
        self._pulse_timeout_ids = {}

        for child in self.get_children():
            child.destroy()

        self.buttons = {}
        self.health_indicators = {}
        self.name_labels = {}

        for host in self.hosts:
            host_id = host['id']
            btn = Gtk.Button()
            btn.set_relief(Gtk.ReliefStyle.NONE)

            btn_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)

            # Health indicator dot
            health_dot = Gtk.Label()
            if host.get('ssh'):
                health_dot.set_markup('<span foreground="#7f8c8d">●</span>')  # Gray = unknown
            else:
                health_dot.set_markup('<span foreground="#2ecc71">●</span>')  # Green = local always reachable
            self.health_indicators[host_id] = health_dot
            btn_box.pack_start(health_dot, False, False, 0)

            # Host name (stored for activity pulsing)
            name_label = Gtk.Label()
            name_label.set_text(host['name'])
            self.name_labels[host_id] = (name_label, host['name'])  # (widget, original_name)
            btn_box.pack_start(name_label, False, False, 0)

            # Workspace count badge
            count_label = Gtk.Label()
            count_label.set_markup('<span size="small" foreground="#95a5a6">(0)</span>')
            self.workspace_counts[host_id] = count_label
            btn_box.pack_start(count_label, False, False, 0)

            btn.add(btn_box)
            btn.connect('clicked', self._on_tab_clicked, host_id)
            self.buttons[host_id] = btn
            self.pack_start(btn, False, False, 0)

        self._update_active_style()
        self.show_all()

    def _on_tab_clicked(self, button, host_id):
        self._active_host = host_id
        self._update_active_style()
        self.on_host_selected(host_id)

    def _update_active_style(self):
        """Update visual style to show active tab"""
        for host_id, btn in self.buttons.items():
            ctx = btn.get_style_context()
            if host_id == self._active_host:
                css = """
                button {
                    background-color: alpha(@theme_selected_bg_color, 0.3);
                    border-bottom: 2px solid @theme_selected_bg_color;
                }
                """
            else:
                css = """
                button {
                    background-color: transparent;
                    border-bottom: 2px solid transparent;
                }
                """
            provider = Gtk.CssProvider()
            provider.load_from_data(css.encode())
            ctx.add_provider(provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

    def update_hosts(self, hosts):
        """Update the host list and rebuild tabs"""
        self.hosts = hosts
        self._build_tabs()

    def update_health(self, host_id, reachable):
        """Update health indicator for a host"""
        if host_id in self.health_indicators:
            if reachable:
                self.health_indicators[host_id].set_markup('<span foreground="#2ecc71">●</span>')
            else:
                self.health_indicators[host_id].set_markup('<span foreground="#e74c3c">●</span>')

    def update_workspace_count(self, host_id, count):
        """Update workspace count badge"""
        if host_id in self.workspace_counts:
            self.workspace_counts[host_id].set_markup(
                f'<span size="small" foreground="#95a5a6">({count})</span>'
            )

    def get_active_host(self):
        return self._active_host

    def pulse_activity(self, host_id):
        """Pulse the tab name to indicate activity on that host"""
        if host_id not in self.name_labels:
            return
        if host_id == self._active_host:
            return  # Don't pulse the active tab

        label, original_name = self.name_labels[host_id]

        # Cancel existing pulse if any
        if host_id in self._pulse_timeout_ids:
            GLib.source_remove(self._pulse_timeout_ids[host_id])

        # Set pulsing color
        label.set_markup(f'<span foreground="{self._pulse_color}" weight="bold">{GLib.markup_escape_text(original_name)}</span>')

        # Schedule reset
        def reset_label():
            label.set_text(original_name)
            self._pulse_timeout_ids.pop(host_id, None)
            return False

        self._pulse_timeout_ids[host_id] = GLib.timeout_add(1500, reset_label)


class WorkspaceSwitcher(Gtk.Window):
    """Main workspace switcher panel window"""

    def __init__(self):
        super().__init__(title="Workspaces")

        # Window setup for panel-like behavior
        self.set_default_size(180, 500)
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

        # Load config
        self.config = self._load_full_config()
        self.hosts = self.config.get('hosts', [{'id': 'local', 'name': 'Local', 'ssh': None}])
        self._current_host = 'local'

        # Session cache for remote hosts
        self.remote_session_cache = RemoteSessionCache()

        # SSH health checker
        self.health_checker = SSHHealthChecker(self._on_host_health_changed)
        self.health_checker.set_hosts(self.hosts)

        # Main container
        main_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=0)

        # Header with title and buttons
        header_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
        header_box.set_margin_start(8)
        header_box.set_margin_end(8)
        header_box.set_margin_top(8)
        header_box.set_margin_bottom(4)

        title_label = Gtk.Label()
        title_label.set_markup('<b>Workspaces</b>')
        header_box.pack_start(title_label, True, True, 0)

        # Settings button
        settings_btn = Gtk.Button()
        settings_btn.set_image(Gtk.Image.new_from_icon_name("preferences-system", Gtk.IconSize.SMALL_TOOLBAR))
        settings_btn.set_relief(Gtk.ReliefStyle.NONE)
        settings_btn.set_tooltip_text("Settings")
        settings_btn.connect('clicked', self.on_settings_clicked)
        header_box.pack_end(settings_btn, False, False, 0)

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

        # Host tab bar
        self.host_tab_bar = HostTabBar(self.hosts, self._on_host_tab_selected)
        main_box.pack_start(self.host_tab_bar, False, False, 0)

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
        self.last_host_activity = {}  # host_id -> {session_name: last_activity}
        self.active_sessions = []  # list of (host_id, session_name) with recent activity
        self._footer_pulse_timeout = None
        self.refresh_workspaces()

        # Update workspace counts in tab bar
        self._update_host_workspace_counts()

        # Auto-refresh timer for current tab
        GLib.timeout_add(REFRESH_INTERVAL, self.auto_refresh)

        # Activity monitor for all hosts (check every 2 seconds)
        GLib.timeout_add(2000, self._check_all_hosts_activity)

        # Start health checker and run immediate check
        self.health_checker.start()
        self.health_checker.check_all_now()

        # Handle close
        self.connect('delete-event', self.on_close)

    def _load_full_config(self):
        """Load full config file"""
        try:
            with open(CONFIG_FILE, 'r') as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return {
                'hosts': [{'id': 'local', 'name': 'Local', 'ssh': None}],
                'workspaces': [],
                'settings': {'terminal': 'xfce4-terminal', 'shell': '/bin/bash'}
            }

    def _save_full_config(self, config):
        """Save full config file"""
        with open(CONFIG_FILE, 'w') as f:
            json.dump(config, f, indent=2)

    def _on_host_tab_selected(self, host_id):
        """Handle host tab selection"""
        self._current_host = host_id
        self.remote_session_cache.invalidate(host_id)
        self.refresh_workspaces()

    def _on_host_health_changed(self, host_id, reachable):
        """Handle SSH health status change"""
        self.host_tab_bar.update_health(host_id, reachable)

    def _update_host_workspace_counts(self):
        """Update workspace count badges on host tabs"""
        workspaces = self.config.get('workspaces', [])
        counts = {}
        for ws in workspaces:
            host = ws.get('host', 'local')
            counts[host] = counts.get(host, 0) + 1

        for host in self.hosts:
            self.host_tab_bar.update_workspace_count(host['id'], counts.get(host['id'], 0))

    def on_settings_clicked(self, button):
        """Show settings dialog"""
        dialog = SettingsDialog(self, self.config)
        response = dialog.run()

        if response == Gtk.ResponseType.OK:
            # Update settings
            self.config['settings'] = dialog.get_settings()
            self.config['hosts'] = dialog.get_hosts()
            self._save_full_config(self.config)

            # Reload hosts
            self.hosts = self.config['hosts']
            self.host_tab_bar.update_hosts(self.hosts)
            self.health_checker.set_hosts(self.hosts)
            self._update_host_workspace_counts()

        dialog.destroy()

    def on_close(self, widget, event):
        """Handle window close - actually close the application"""
        self.health_checker.stop()
        Gtk.main_quit()
        return False  # Allow close

    def auto_refresh(self):
        """Periodically refresh session status"""
        self.refresh_workspaces()
        return True  # Keep timer running

    def _on_workspace_activated(self, host_id):
        """Called when a workspace is opened - schedule refresh to update status"""
        # Invalidate cache for this host so next refresh gets fresh data
        self.remote_session_cache.invalidate(host_id)
        # Schedule a refresh after 1 second to give tmux time to create the session
        GLib.timeout_add(1000, self._delayed_refresh)

    def _delayed_refresh(self):
        """Single delayed refresh after workspace activation"""
        self.refresh_workspaces()
        return False  # Don't repeat

    def _check_all_hosts_activity(self):
        """Check all hosts for activity and pulse tabs if new activity detected"""
        def check_in_background():
            new_active_sessions = []
            all_workspaces = self.config.get('workspaces', [])

            for host in self.hosts:
                host_id = host['id']
                host_info = host

                # Get sessions for this host
                sessions = self._get_sessions_for_host(host_id, host_info)

                # Initialize last activity tracking for this host if needed
                if host_id not in self.last_host_activity:
                    self.last_host_activity[host_id] = {}

                last_activities = self.last_host_activity[host_id]
                host_has_new_activity = False

                for session_name, session_info in sessions.items():
                    activity = session_info.get('activity', 0) or 0
                    last_activity = last_activities.get(session_name, 0)

                    # Check if this session has new activity
                    if activity > last_activity and last_activity > 0:
                        # Find workspace name for this session
                        ws = next((w for w in all_workspaces if w['id'] == session_name), None)
                        ws_name = ws['name'] if ws else session_name
                        new_active_sessions.append((host_id, session_name, ws_name))
                        host_has_new_activity = True

                    # Update last known activity for this session
                    if activity > 0:
                        last_activities[session_name] = activity

                # Pulse tab if activity on non-current host
                if host_has_new_activity and host_id != self._current_host:
                    GLib.idle_add(self.host_tab_bar.pulse_activity, host_id)

            # Update active sessions list and footer
            if new_active_sessions:
                self.active_sessions = new_active_sessions
                GLib.idle_add(self._pulse_footer)

        # Run in background thread to not block UI
        threading.Thread(target=check_in_background, daemon=True).start()
        return True  # Keep timer running

    def _pulse_footer(self):
        """Show active session names in footer with pulsing green"""
        if not self.active_sessions:
            self.footer_label.set_markup('<span size="medium" foreground="#7f8c8d">—</span>')
            return

        # Cancel existing pulse timeout
        if self._footer_pulse_timeout:
            GLib.source_remove(self._footer_pulse_timeout)

        # Build list of active session names
        names = [name for (host_id, session_id, name) in self.active_sessions]
        display = "  ".join(names)

        # Show in green
        self.footer_label.set_markup(f'<span size="medium" foreground="#2ecc71" weight="bold">{GLib.markup_escape_text(display)}</span>')

        # Schedule fade back to gray after 2 seconds
        def fade_footer():
            self.footer_label.set_markup(f'<span size="medium" foreground="#7f8c8d">{GLib.markup_escape_text(display)}</span>')
            self._footer_pulse_timeout = None
            return False

        self._footer_pulse_timeout = GLib.timeout_add(2000, fade_footer)

    def _update_footer(self):
        """Update footer - called from refresh_workspaces"""
        if self.active_sessions:
            names = [name for (host_id, session_id, name) in self.active_sessions]
            display = "  ".join(names)
            self.footer_label.set_markup(f'<span size="medium" foreground="#7f8c8d">{GLib.markup_escape_text(display)}</span>')
        else:
            self.footer_label.set_markup('<span size="medium" foreground="#7f8c8d">—</span>')

    def refresh_workspaces(self):
        """Reload workspaces and session info"""
        # Clear existing buttons - destroy them to free memory
        for child in self.workspace_box.get_children():
            child.destroy()

        # Load config
        self.config = self._load_full_config()
        workspaces = self.config.get('workspaces', [])

        # Filter by current host
        workspaces = [ws for ws in workspaces if ws.get('host', 'local') == self._current_host]

        # Get host info
        host_info = next((h for h in self.hosts if h['id'] == self._current_host), None)

        # Get tmux session info
        sessions = self._get_sessions_for_host(self._current_host, host_info)
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
                host_info=host_info,
                session_info=session_info,
                on_remove=self.remove_workspace,
                on_rename=self.rename_workspace,
                on_activate=self._on_workspace_activated,
                activity_recent=activity_recent
            )
            self.workspace_box.pack_start(btn, False, False, 0)

        # Refresh footer (activity counts are updated by _check_all_hosts_activity)
        self._update_footer()

        self.workspace_box.show_all()

    def _get_sessions_for_host(self, host_id, host_info):
        """Get tmux sessions for a specific host"""
        if host_id == 'local' or not host_info or not host_info.get('ssh'):
            return self.get_tmux_sessions()
        else:
            # Check cache first
            cached = self.remote_session_cache.get(host_id)
            if cached is not None:
                return cached

            # Check health before querying
            if self.health_checker.get_status(host_id) == False:
                return {}

            # Query remote tmux
            sessions = self._get_remote_tmux_sessions(host_info['ssh'])
            if sessions is not None:  # Query succeeded (even if empty)
                self.health_checker.mark_reachable(host_id)
                self.remote_session_cache.set(host_id, sessions)
                return sessions
            else:
                return {}  # Connection failed

    def _get_remote_tmux_sessions(self, ssh_target):
        """Get tmux sessions from a remote host via SSH. Returns None on connection failure."""
        sessions = {}
        try:
            # Query both session info and window activity in one SSH call
            # Window activity is more granular than session activity
            cmd = (
                'tmux list-sessions -F "#{session_name}:#{session_windows}:#{session_activity}" 2>/dev/null; '
                'echo "---"; '
                'tmux list-windows -a -F "#{session_name}:#{window_activity}" 2>/dev/null'
            )
            result = subprocess.run(
                ['ssh', '-o', 'ConnectTimeout=3', '-o', 'BatchMode=yes', ssh_target, cmd],
                capture_output=True, text=True, timeout=10
            )
            # returncode 0 = success, 1 = no sessions (tmux not running), both mean SSH worked
            if result.returncode in (0, 1):
                output = result.stdout.strip()
                if '---' in output:
                    sessions_part, windows_part = output.split('---', 1)
                else:
                    sessions_part = output
                    windows_part = ''

                # Parse session info
                for line in sessions_part.strip().split('\n'):
                    if ':' in line:
                        parts = line.rsplit(':', 2)
                        if len(parts) != 3:
                            continue
                        name, windows, activity = parts
                        sessions[name] = {
                            'windows': int(windows) if windows else 0,
                            'activity': int(activity) if activity else 0
                        }

                # Update with max window activity (more accurate than session activity)
                for line in windows_part.strip().split('\n'):
                    if ':' in line:
                        session_name, activity = line.rsplit(':', 1)
                        if session_name in sessions and activity:
                            activity_val = int(activity)
                            if activity_val > sessions[session_name]['activity']:
                                sessions[session_name]['activity'] = activity_val

                return sessions  # Return {} for no sessions, but not None
            else:
                return None  # SSH or other error
        except (subprocess.TimeoutExpired, Exception) as e:
            print(f"Remote tmux query error: {e}")
            return None  # Connection failed

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
        self.config['workspaces'] = workspaces
        self._save_full_config(self.config)
        self._update_host_workspace_counts()

    def remove_workspace(self, workspace_id):
        """Remove a workspace from config, optionally killing tmux session"""
        # Find the workspace to get its host
        workspaces = self.config.get('workspaces', [])
        ws = next((w for w in workspaces if w['id'] == workspace_id), None)
        if not ws:
            return

        host_id = ws.get('host', 'local')
        host_info = next((h for h in self.hosts if h['id'] == host_id), None)

        # Check if tmux session exists
        if host_id == 'local' or not host_info or not host_info.get('ssh'):
            result = subprocess.run(['tmux', 'has-session', '-t', workspace_id],
                                    capture_output=True)
            session_exists = result.returncode == 0
        else:
            result = subprocess.run(
                ['ssh', '-o', 'ConnectTimeout=2', '-o', 'BatchMode=yes', host_info['ssh'],
                 f'tmux has-session -t {workspace_id}'],
                capture_output=True, timeout=5
            )
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
                if host_id == 'local' or not host_info or not host_info.get('ssh'):
                    subprocess.run(['tmux', 'kill-session', '-t', workspace_id])
                else:
                    subprocess.run(['ssh', host_info['ssh'], f'tmux kill-session -t {workspace_id}'])

        workspaces = [w for w in workspaces if w['id'] != workspace_id]
        self.save_config(workspaces)
        self.refresh_workspaces()

    def rename_workspace(self, workspace_id, current_name):
        """Edit a workspace (name and path)"""
        # Get current workspace data
        workspaces = self.config.get('workspaces', [])
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
        dialog.set_default_size(350, 200)

        box = dialog.get_content_area()
        box.set_margin_start(10)
        box.set_margin_end(10)
        box.set_margin_top(10)
        box.set_margin_bottom(10)
        box.set_spacing(8)

        # Host field
        host_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        host_label = Gtk.Label(label="Host:")
        host_label.set_width_chars(6)
        host_label.set_xalign(0)
        host_combo = Gtk.ComboBoxText()
        for host in self.hosts:
            host_combo.append(host['id'], host['name'])
        current_host = current_ws.get('host', 'local')
        host_combo.set_active_id(current_host)
        host_box.pack_start(host_label, False, False, 0)
        host_box.pack_start(host_combo, True, True, 0)
        box.pack_start(host_box, False, False, 0)

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
            new_host = host_combo.get_active_id() or 'local'
            changed = False

            for ws in workspaces:
                if ws['id'] == workspace_id:
                    if new_name and new_name != ws.get('name'):
                        ws['name'] = new_name
                        changed = True
                    if new_path and new_path != ws.get('path'):
                        ws['path'] = new_path
                        changed = True
                    if new_host != ws.get('host', 'local'):
                        ws['host'] = new_host
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
        dialog = AddWorkspaceDialog(self, hosts=self.hosts)
        response = dialog.run()

        if response == Gtk.ResponseType.OK:
            ws = dialog.get_workspace()
            if ws['id'] and ws['name'] and ws['path']:
                workspaces = self.config.get('workspaces', [])
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
