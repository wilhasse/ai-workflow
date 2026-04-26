from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from .actions import WorkspaceActions, terminal_recent_score
from .session_archive import (
    SessionArchiveError,
    build_record_command,
    find_archive_record,
    format_archive_records,
    list_archive_records,
    load_archive,
    merge_snapshots,
    save_archive,
    scan_configured_hosts,
    scan_local_host,
)
from .tui import select_workspace_tui, write_selected_target


PACKAGE_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = PACKAGE_ROOT / 'scripts' / 'wsv2'


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description='Workspace v2 popup launcher')
    parser.add_argument('--config', help='Path to workspaces.json')
    parser.add_argument('--state', help='Path to launcher state file')

    subparsers = parser.add_subparsers(dest='command')

    list_parser = subparsers.add_parser('list', help='List workspaces with status')
    list_parser.add_argument('--json', action='store_true', help='Emit JSON instead of text')

    open_parser = subparsers.add_parser('open', help='Open or focus a workspace in a GUI terminal')
    open_parser.add_argument('target', help='Workspace id or host:id')
    open_parser.add_argument(
        '--no-focus',
        action='store_true',
        help='Skip searching for an existing window before launching',
    )

    attach_parser = subparsers.add_parser('attach', help='Attach/switch in the current shell or tmux client')
    attach_parser.add_argument('target', help='Workspace id or host:id')

    kill_parser = subparsers.add_parser('kill', help='Kill a workspace tmux session')
    kill_parser.add_argument('target', help='Workspace id or host:id')

    subparsers.add_parser('popup', help='Launch the best available popup surface')
    subparsers.add_parser('tmux-popup', help='Launch the tmux popup selector')

    tui_parser = subparsers.add_parser('tui', help='Run the terminal selector inline')
    tui_parser.add_argument('--select-only', action='store_true', help='Write the selected target and exit')
    tui_parser.add_argument('--output', help='File path for selected target when using --select-only')

    command_parser = subparsers.add_parser('command', help='Print the attach command for a target')
    command_parser.add_argument('target', help='Workspace id or host:id')

    archive_scan_parser = subparsers.add_parser(
        'archive-scan',
        help='Snapshot tmux panes and Codex/Claude resume ids across configured hosts',
    )
    archive_scan_parser.add_argument('--json', action='store_true', help='Emit JSON instead of text')

    local_archive_scan_parser = subparsers.add_parser(
        'archive-scan-local',
        help='Snapshot local tmux panes and Codex/Claude resume ids',
    )
    local_archive_scan_parser.add_argument('--json', action='store_true', help='Emit JSON instead of text')
    local_archive_scan_parser.add_argument('--quiet', action='store_true', help='Suppress text output')
    local_archive_scan_parser.add_argument('--save', action='store_true', help='Update the local archive file')
    local_archive_scan_parser.add_argument('--host-id', default='local', help='Host id to stamp into records')
    local_archive_scan_parser.add_argument('--host-name', help='Human-readable host name')

    archive_list_parser = subparsers.add_parser('archive-list', help='List archived Codex/Claude resume targets')
    archive_list_parser.add_argument('--json', action='store_true', help='Emit JSON instead of text')
    archive_list_parser.add_argument('--active-only', action='store_true', help='Hide inactive historical records')
    archive_list_parser.add_argument('--limit', type=int, default=40, help='Maximum text rows to print')

    archive_command_parser = subparsers.add_parser('archive-command', help='Print a resume command for an archive id')
    archive_command_parser.add_argument('record', help='Archive id or resume id prefix')
    archive_command_parser.add_argument(
        '--tmux',
        action='store_true',
        help='Print a command that recreates a tmux window and resumes there',
    )

    return parser


def build_popup_unavailable_message(details: str | None = None) -> str:
    lines = [
        'workspace-v2 could not find a usable launcher surface.',
        '',
        f"DISPLAY={os.environ.get('DISPLAY', '')}",
        f"WAYLAND_DISPLAY={os.environ.get('WAYLAND_DISPLAY', '')}",
        f"TMUX={'set' if os.environ.get('TMUX') else ''}",
        '',
        'Supported surfaces:',
        '  GUI popup when DISPLAY or WAYLAND_DISPLAY is present',
        '  tmux popup when running inside tmux',
        '  inline TUI when running on a normal TTY',
        '',
        'Fallback commands:',
        '  workspace-v2/scripts/wsv2 list',
        '  workspace-v2/scripts/wsv2 attach <target>',
    ]
    if details:
        lines.extend(['', f'Launcher detail: {details}'])
    return '\n'.join(lines)


def can_launch_gui_popup() -> bool:
    return bool(os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY'))


def detect_popup_surface(*, stdin_isatty: bool | None = None, stdout_isatty: bool | None = None) -> str:
    if can_launch_gui_popup():
        return 'gui'
    if os.environ.get('TMUX'):
        return 'tmux'
    if stdin_isatty is None:
        stdin_isatty = sys.stdin.isatty()
    if stdout_isatty is None:
        stdout_isatty = sys.stdout.isatty()
    if stdin_isatty and stdout_isatty:
        return 'tui'
    return 'unsupported'


def run_tui(actions: WorkspaceActions, *, select_only: bool = False, output_path: str | None = None) -> int:
    target = select_workspace_tui(actions)
    if select_only:
        if not output_path:
            raise SystemExit('--select-only requires --output')
        write_selected_target(output_path, target)
        return 0
    if not target:
        return 0
    actions.attach_workspace(target)
    return 0


def run_tmux_popup(actions: WorkspaceActions) -> int:
    if not os.environ.get('TMUX'):
        print('tmux-popup requires an active tmux client', file=sys.stderr)
        return 2

    with tempfile.NamedTemporaryFile(prefix='wsv2-', suffix='.target', delete=False) as handle:
        output_path = handle.name

    popup_cmd = (
        f"{SCRIPT_PATH} tui --select-only --output {output_path}"
    )
    try:
        subprocess.run(
            [
                'tmux',
                'display-popup',
                '-E',
                '-w',
                '80%',
                '-h',
                '75%',
                '-T',
                'Workspace Launcher',
                popup_cmd,
            ],
            check=False,
        )
        selected = Path(output_path).read_text(encoding='utf-8').strip()
    finally:
        Path(output_path).unlink(missing_ok=True)

    if not selected:
        return 0
    actions.attach_workspace(selected)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    command = args.command or 'popup'
    actions = WorkspaceActions(config_path=args.config, state_path=args.state)

    if command == 'popup':
        surface = detect_popup_surface()
        if surface == 'gui':
            try:
                from .popup import launch_popup

                launch_popup(actions)
                return 0
            except RuntimeError as error:
                print(build_popup_unavailable_message(str(error)), file=sys.stderr)
                return 2
        if surface == 'tmux':
            return run_tmux_popup(actions)
        if surface == 'tui':
            return run_tui(actions)
        print(build_popup_unavailable_message(), file=sys.stderr)
        return 2

    if command == 'tmux-popup':
        return run_tmux_popup(actions)

    if command == 'tui':
        return run_tui(actions, select_only=args.select_only, output_path=args.output)

    if command == 'list':
        statuses = actions.list_terminal_statuses()
        recent_scores = actions.state.recent_scores()
        if args.json:
            payload = [
                {
                    'session': status.session_id,
                    'workspaceName': status.workspace_name,
                    'host': status.host_id,
                    'hostName': status.host.name,
                    'windowIndex': status.window_index,
                    'windowName': status.window_name,
                    'windowActive': status.window_active,
                    'activity': status.activity,
                    'recentAt': terminal_recent_score(status, recent_scores),
                    'paneCount': status.pane_count,
                    'active': status.active,
                    'reachable': status.reachable,
                    'discovered': status.discovered,
                    'target': status.target,
                }
                for status in statuses
            ]
            print(json.dumps(payload, indent=2))
            return 0

        for status in statuses:
            if status.reachable is False:
                dot = '!'
            elif status.active:
                dot = '*'
            else:
                dot = '.'
            tab = f"#{status.window_index}" if status.window_index > 0 else '--'
            discovered = ' *' if status.discovered else ''
            print(
                f"{dot} {status.host.name:<14} / {status.workspace_name:<18}{discovered} "
                f"{tab:<4} {status.window_name:<18} "
                f"{status.target}"
            )
        return 0

    if command == 'open':
        result = actions.open_workspace(args.target, focus_existing=not args.no_focus)
        print(result)
        return 0

    if command == 'attach':
        return actions.attach_workspace(args.target)

    if command == 'kill':
        if not actions.kill_workspace(args.target):
            print('session not found or could not be killed', file=sys.stderr)
            return 1
        print('killed')
        return 0

    if command == 'command':
        print(actions.workspace_command(args.target, within_tmux=False))
        return 0

    if command == 'archive-scan':
        try:
            payload = scan_configured_hosts(actions.config)
        except SessionArchiveError as error:
            print(str(error), file=sys.stderr)
            return 1
        if args.json:
            print(json.dumps(payload, indent=2))
            return 0
        reachable = sum(1 for item in payload['snapshots'] if item.get('reachable') is not False)
        total = len(payload['snapshots'])
        records = payload.get('records', [])
        print(f"archived {len(records)} resume targets from {reachable}/{total} reachable hosts")
        print(f"archive: {payload['archivePath']}")
        if records:
            print(format_archive_records(records, limit=20))
        return 0

    if command == 'archive-scan-local':
        snapshot = scan_local_host(
            host_id=args.host_id,
            host_name=args.host_name or args.host_id,
        )
        if args.save:
            archive = load_archive()
            save_archive(merge_snapshots(archive, [snapshot]))
        if args.quiet:
            return 0
        if args.json:
            print(json.dumps(snapshot, indent=2))
            return 0
        print(
            f"found {len(snapshot.get('records', []))} resume targets "
            f"from {snapshot.get('paneCount', 0)} tmux panes"
        )
        if snapshot.get('records'):
            print(format_archive_records(snapshot['records'], limit=20))
        return 0

    if command == 'archive-list':
        try:
            records = list_archive_records(include_inactive=not args.active_only)
        except SessionArchiveError as error:
            print(str(error), file=sys.stderr)
            return 1
        if args.json:
            print(json.dumps(records, indent=2))
            return 0
        output = format_archive_records(records, limit=args.limit)
        if output:
            print(output)
        return 0

    if command == 'archive-command':
        try:
            record = find_archive_record(list_archive_records(), args.record)
            print(build_record_command(record, actions.config, tmux_restore=args.tmux))
        except SessionArchiveError as error:
            print(str(error), file=sys.stderr)
            return 1
        return 0

    parser.print_help()
    return 1


if __name__ == '__main__':  # pragma: no cover
    raise SystemExit(main())
