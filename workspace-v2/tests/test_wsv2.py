from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from wsv2.actions import build_attach_command, build_terminal_command, build_workspace_command
from wsv2.catalog import WorkspaceConfigError, load_config
from wsv2.cli import build_popup_unavailable_message, can_launch_gui_popup, detect_popup_surface
from wsv2.state import LauncherState
from wsv2.tui import build_tui_items, filter_tui_items


def write_legacy_config(tmpdir: Path) -> Path:
    config = {
        'hosts': [
            {'id': 'vm9', 'name': 'Supersaber', 'ssh': 'cslog@10.1.0.9'},
        ],
        'workspaces': [
            {
                'id': 'mysql',
                'name': 'MySQL Tests',
                'path': '~/mysql',
                'host': 'local',
            },
            {
                'id': 'dbtools',
                'name': 'smart-sql',
                'path': '/srv/smart-sql',
                'host': 'vm9',
            },
        ],
        'settings': {
            'terminal': 'xfce4-terminal',
            'terminals': ['xfce4-terminal', 'konsole'],
            'shell': '/bin/bash',
        },
    }
    path = tmpdir / 'workspaces.json'
    path.write_text(json.dumps(config), encoding='utf-8')
    return path


def write_v2_config(tmpdir: Path) -> Path:
    config = {
        'version': 2,
        'self_host_env': 'WSV2_SELF_HOST',
        'hosts': [
            {
                'id': 'vm10',
                'name': 'Main Desktop',
                'ssh': 'cslog@10.1.0.10',
                'hostnames': ['godev4'],
                'legacy_ids': ['local'],
            },
            {
                'id': 'vm9',
                'name': 'Supersaber',
                'ssh': 'cslog@10.1.0.9',
                'hostnames': ['godev3'],
            },
        ],
        'workspaces': [
            {
                'id': 'mysql',
                'name': 'MySQL Tests',
                'path': '~/mysql',
                'host': 'vm10',
            },
            {
                'id': 'dbtools',
                'name': 'smart-sql',
                'path': '/srv/smart-sql',
                'host': 'vm9',
            },
        ],
        'settings': {
            'terminal': 'xfce4-terminal',
            'terminals': ['xfce4-terminal', 'konsole'],
            'shell': '/bin/bash',
        },
    }
    path = tmpdir / 'workspaces.v2.json'
    path.write_text(json.dumps(config), encoding='utf-8')
    return path


class WorkspaceConfigTests(unittest.TestCase):
    def test_load_legacy_config_keeps_local_host_behavior(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config = load_config(write_legacy_config(Path(tmp)))

        self.assertEqual(config.hosts[0].id, 'local')
        self.assertEqual(config.self_host_id, 'local')
        mysql = config.resolve_workspace('mysql')
        self.assertTrue(mysql.path.endswith('/mysql'))
        self.assertEqual(mysql.target, 'mysql')
        self.assertTrue(config.host_runs_local(mysql.host_id))

        remote = config.resolve_workspace('vm9:dbtools')
        self.assertEqual(remote.target, 'vm9:dbtools')
        self.assertEqual(remote.host.name, 'Supersaber')
        self.assertFalse(config.host_runs_local(remote.host_id))

    def test_load_v2_config_resolves_self_host_from_runtime_identity(self) -> None:
        with tempfile.TemporaryDirectory() as tmp,             mock.patch('wsv2.catalog._runtime_identity_tokens', return_value={'godev4', 'godev4.local'}):
            config = load_config(write_v2_config(Path(tmp)))

        self.assertEqual(config.schema_version, 2)
        self.assertEqual(config.self_host_id, 'vm10')
        mysql = config.resolve_workspace('mysql')
        self.assertEqual(mysql.target, 'vm10:mysql')
        self.assertTrue(config.host_runs_local('vm10'))
        self.assertFalse(config.host_runs_local('vm9'))
        self.assertEqual(config.resolve_workspace('local:mysql').host_id, 'vm10')

    def test_load_v2_config_allows_env_override_for_self_host(self) -> None:
        with tempfile.TemporaryDirectory() as tmp,             mock.patch.dict(os.environ, {'WSV2_SELF_HOST': 'vm9'}, clear=True):
            config = load_config(write_v2_config(Path(tmp)))

        self.assertEqual(config.self_host_id, 'vm9')
        self.assertTrue(config.host_runs_local('vm9'))
        self.assertFalse(config.host_runs_local('vm10'))

    def test_resolve_workspace_rejects_unknown_targets(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config = load_config(write_legacy_config(Path(tmp)))
        with self.assertRaises(WorkspaceConfigError):
            config.resolve_workspace('missing')


class CommandBuilderTests(unittest.TestCase):
    def test_build_workspace_command_matches_local_and_remote_models(self) -> None:
        with tempfile.TemporaryDirectory() as tmp,             mock.patch('wsv2.catalog._runtime_identity_tokens', return_value={'godev4', 'godev4.local'}):
            config = load_config(write_v2_config(Path(tmp)))

        local_cmd = build_workspace_command(
            config.resolve_workspace('mysql'),
            run_local=config.host_runs_local('vm10'),
        )
        remote_cmd = build_workspace_command(
            config.resolve_workspace('vm9:dbtools'),
            run_local=config.host_runs_local('vm9'),
        )

        self.assertIn('tmux attach-session -t mysql || tmux new-session -s mysql', local_cmd)
        self.assertIn('ssh -t -o ServerAliveInterval=60 -o ServerAliveCountMax=3', remote_cmd)
        self.assertIn('cslog@10.1.0.9', remote_cmd)
        self.assertIn('tmux attach -t dbtools || tmux new -s dbtools', remote_cmd)

    def test_build_attach_command_uses_switch_client_inside_tmux(self) -> None:
        with tempfile.TemporaryDirectory() as tmp,             mock.patch('wsv2.catalog._runtime_identity_tokens', return_value={'godev4', 'godev4.local'}):
            config = load_config(write_v2_config(Path(tmp)))

        command = build_attach_command(
            config.resolve_workspace('mysql'),
            run_local=True,
            within_tmux=True,
        )
        self.assertIn('tmux switch-client -t mysql', command)
        self.assertIn('tmux new-session -d -s mysql', command)

    def test_build_terminal_command_uses_terminal_specific_flags(self) -> None:
        xfce = build_terminal_command('xfce4-terminal', 'echo hi', 'mysql')
        gnome = build_terminal_command('gnome-terminal', 'echo hi', 'mysql')

        self.assertEqual(xfce[:4], ['xfce4-terminal', '--disable-server', '--window', '--title'])
        self.assertEqual(gnome[:3], ['gnome-terminal', '--title', 'mysql'])


class LauncherStateTests(unittest.TestCase):
    def test_mark_recent_persists_timestamp(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'state.json'
            state = LauncherState(path)
            state.mark_recent('vm9:dbtools')
            scores = state.recent_scores()

        self.assertIn('vm9:dbtools', scores)
        self.assertGreater(scores['vm9:dbtools'], 0)


class PopupEnvironmentTests(unittest.TestCase):
    def test_can_launch_gui_popup_requires_display(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertFalse(can_launch_gui_popup())
        with mock.patch.dict(os.environ, {'DISPLAY': ':0'}, clear=True):
            self.assertTrue(can_launch_gui_popup())

    def test_detect_popup_surface_prefers_gui_then_tmux_then_tui(self) -> None:
        with mock.patch.dict(os.environ, {'DISPLAY': ':0'}, clear=True):
            self.assertEqual(detect_popup_surface(stdin_isatty=False, stdout_isatty=False), 'gui')
        with mock.patch.dict(os.environ, {'TMUX': '1'}, clear=True):
            self.assertEqual(detect_popup_surface(stdin_isatty=False, stdout_isatty=False), 'tmux')
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(detect_popup_surface(stdin_isatty=True, stdout_isatty=True), 'tui')
            self.assertEqual(detect_popup_surface(stdin_isatty=False, stdout_isatty=False), 'unsupported')

    def test_popup_unavailable_message_includes_guidance(self) -> None:
        with mock.patch.dict(os.environ, {'TMUX': '1'}, clear=True):
            message = build_popup_unavailable_message()
        self.assertIn('could not find a usable launcher surface', message)
        self.assertIn('workspace-v2/scripts/wsv2 attach <target>', message)
        self.assertIn('TMUX=set', message)


class TuiFilterTests(unittest.TestCase):
    def test_filter_tui_items_matches_prefixes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config = load_config(write_legacy_config(Path(tmp)))
        items = build_tui_items([
            status for status in []
        ])
        statuses = [
            type('Status', (), {'workspace': config.resolve_workspace('mysql'), 'active': False, 'reachable': True})(),
            type('Status', (), {'workspace': config.resolve_workspace('vm9:dbtools'), 'active': True, 'reachable': True})(),
        ]
        items = build_tui_items(statuses)
        filtered = filter_tui_items(items, 'db')
        self.assertEqual(len(filtered), 1)
        self.assertEqual(filtered[0].status.workspace.id, 'dbtools')


if __name__ == '__main__':
    unittest.main()
