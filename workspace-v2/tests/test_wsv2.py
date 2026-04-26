from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from wsv2.actions import (
    TerminalStatus,
    WorkspaceActions,
    build_attach_command,
    build_terminal_command,
    build_workspace_command,
    terminal_recent_score,
)
from wsv2.catalog import WorkspaceConfigError, load_config
from wsv2.cli import build_popup_unavailable_message, can_launch_gui_popup, detect_popup_surface
from wsv2.session_archive import (
    build_record_command,
    build_records_for_pane,
    merge_snapshots,
)
from wsv2.state import LauncherState
from wsv2.tui import build_tui_items, filter_tui_items
from wsv2.drill import build_simulated_outage_payload, select_probe_targets


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


class TerminalRankingTests(unittest.TestCase):
    def test_terminal_recent_score_uses_selection_or_tmux_activity(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.dict(os.environ, {'WSV2_SELF_HOST': 'vm10'}, clear=True):
            config = load_config(write_v2_config(Path(tmp)))

        workspace = config.resolve_workspace('vm9:dbtools')
        status = TerminalStatus(
            host_id=workspace.host_id,
            host=workspace.host,
            session_id=workspace.id,
            window_index=2,
            window_name='api-task',
            activity=100,
            workspace=workspace,
        )

        self.assertEqual(terminal_recent_score(status, {}), 100)
        self.assertEqual(terminal_recent_score(status, {'vm9:dbtools#2': 200}), 200)
        self.assertEqual(terminal_recent_score(status, {'vm9:dbtools': 300}), 300)

    def test_list_terminal_statuses_orders_manual_selection_before_stale_activity(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.dict(os.environ, {'WSV2_SELF_HOST': 'vm10'}, clear=True):
            config_path = write_v2_config(Path(tmp))
            state_path = Path(tmp) / 'state.json'
            actions = WorkspaceActions(config_path=config_path, state_path=state_path)
            actions.state.mark_recent('vm9:dbtools#2')

            with mock.patch.object(
                actions,
                '_list_local_windows',
                return_value=[
                    {
                        'session_id': 'mysql',
                        'window_index': 1,
                        'window_name': 'node',
                        'window_active': True,
                        'activity': 20,
                        'pane_count': 1,
                    }
                ],
            ), mock.patch.object(
                actions,
                '_list_remote_windows',
                return_value=(
                    [
                        {
                            'session_id': 'dbtools',
                            'window_index': 2,
                            'window_name': 'api-task',
                            'window_active': False,
                            'activity': 10,
                            'pane_count': 1,
                        }
                    ],
                    True,
                ),
            ):
                statuses = actions.list_terminal_statuses()

        self.assertEqual(statuses[0].target, 'vm9:dbtools#2')


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
        mysql = config.resolve_workspace('mysql')
        dbtools = config.resolve_workspace('vm9:dbtools')
        statuses = [
            TerminalStatus(
                host_id=mysql.host_id,
                host=mysql.host,
                session_id=mysql.id,
                window_index=1,
                window_name='bash',
                workspace=mysql,
            ),
            TerminalStatus(
                host_id=dbtools.host_id,
                host=dbtools.host,
                session_id=dbtools.id,
                window_index=2,
                window_name='task-api',
                workspace=dbtools,
            ),
        ]
        items = build_tui_items(statuses)
        filtered = filter_tui_items(items, 'db')
        self.assertEqual(len(filtered), 1)
        self.assertEqual(filtered[0].status.session_id, 'dbtools')


class OutageDrillTests(unittest.TestCase):
    def test_build_simulated_outage_payload_rewrites_down_host_ssh(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = write_v2_config(Path(tmp))
            payload = build_simulated_outage_payload(path, ['vm10'])
        hosts = {host['id']: host for host in payload['hosts']}
        self.assertEqual(hosts['vm10']['ssh'], 'cslog@127.0.0.254')
        self.assertEqual(hosts['vm9']['ssh'], 'cslog@10.1.0.9')

    def test_select_probe_targets_skips_down_hosts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, \
            mock.patch('wsv2.catalog._runtime_identity_tokens', return_value={'godev4'}):
            config = load_config(write_v2_config(Path(tmp)))
        targets = select_probe_targets(config, ['vm10'])
        self.assertEqual([workspace.host_id for workspace in targets], ['vm9'])


class SessionArchiveTests(unittest.TestCase):
    def test_build_records_for_pane_matches_codex_and_claude_by_cwd(self) -> None:
        pane = {
            'session': 'harness',
            'windowIndex': 1,
            'windowName': 'node',
            'windowActive': True,
            'windowActivity': 100,
            'paneId': '%5',
            'paneIndex': 0,
            'paneActive': True,
            'panePid': 111,
            'paneCommand': 'node',
            'cwd': '/home/cslog/ai-workflow',
            'paneTitle': 'ai-workflow',
        }
        records = build_records_for_pane(
            pane,
            claude_sessions=[
                {
                    'resumeId': 'claude-1',
                    'cwd': '/home/cslog/ai-workflow',
                    'pid': 222,
                    'title': 'Claude task',
                    'updatedAt': 200,
                }
            ],
            codex_threads=[
                {
                    'resumeId': 'codex-1',
                    'cwd': '/home/cslog/ai-workflow',
                    'title': 'Codex task',
                    'updatedAt': 300,
                }
            ],
            host_id='vm9',
            host_name='Supersaber',
            now_ms=1000,
            pane_pids={111, 222},
        )

        self.assertEqual({record['kind'] for record in records}, {'claude', 'codex'})
        self.assertTrue(all(record['active'] for record in records))
        self.assertTrue(all(record['tmux']['session'] == 'harness' for record in records))
        resume_commands = [record['resumeCommand'] for record in records]
        self.assertTrue(any('codex resume codex-1' in command for command in resume_commands))

    def test_merge_snapshots_keeps_records_after_pane_disappears(self) -> None:
        first = {
            'hostId': 'vm9',
            'hostName': 'Supersaber',
            'reachable': True,
            'records': [
                {
                    'id': 'cx-old',
                    'kind': 'codex',
                    'resumeId': 'thread-1',
                    'hostId': 'vm9',
                    'hostName': 'Supersaber',
                    'cwd': '/repo',
                    'title': 'Old work',
                    'updatedAt': 100,
                    'firstSeenAt': 1000,
                    'lastSeenAt': 1000,
                    'active': True,
                    'tmux': {'session': 'repo', 'windowIndex': 1},
                }
            ],
        }
        archive = merge_snapshots({}, [first], now_ms=1000)
        second = {
            'hostId': 'vm9',
            'hostName': 'Supersaber',
            'reachable': True,
            'records': [],
        }
        archive = merge_snapshots(archive, [second], now_ms=2000)

        self.assertEqual(len(archive['records']), 1)
        self.assertFalse(archive['records'][0]['active'])
        self.assertEqual(archive['records'][0]['resumeId'], 'thread-1')

    def test_unreachable_scan_does_not_mark_existing_records_inactive(self) -> None:
        archive = {
            'records': [
                {
                    'id': 'cx-live',
                    'kind': 'codex',
                    'resumeId': 'thread-1',
                    'hostId': 'vm10',
                    'hostName': 'Main Desktop',
                    'cwd': '/repo',
                    'title': 'Live work',
                    'updatedAt': 100,
                    'firstSeenAt': 1000,
                    'lastSeenAt': 1000,
                    'active': True,
                    'tmux': {'session': 'repo', 'windowIndex': 1},
                }
            ],
        }
        snapshot = {
            'hostId': 'vm10',
            'hostName': 'Main Desktop',
            'reachable': False,
            'records': [],
        }

        merged = merge_snapshots(archive, [snapshot], now_ms=2000)

        self.assertTrue(merged['records'][0]['active'])

    def test_home_directory_session_does_not_match_every_project_pane(self) -> None:
        pane = {
            'session': 'harness',
            'windowIndex': 1,
            'windowName': 'node',
            'cwd': str(Path.home() / 'ai-workflow'),
        }
        records = build_records_for_pane(
            pane,
            claude_sessions=[
                {
                    'resumeId': 'claude-home',
                    'cwd': str(Path.home()),
                    'title': 'Home session',
                    'updatedAt': 200,
                }
            ],
            codex_threads=[],
            host_id='vm9',
            host_name='Supersaber',
            now_ms=1000,
        )

        self.assertEqual(records, [])

    def test_build_record_command_can_restore_remote_tmux_window(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.dict(os.environ, {'WSV2_SELF_HOST': 'vm10'}, clear=True):
            config = load_config(write_v2_config(Path(tmp)))
        record = {
            'kind': 'codex',
            'resumeId': 'thread-1',
            'hostId': 'vm9',
            'cwd': '/home/cslog/ai-workflow',
            'title': 'Harness task',
            'tmux': {'session': 'harness', 'windowName': 'node'},
        }

        command = build_record_command(record, config, tmux_restore=True)

        self.assertIn('ssh -t -o ServerAliveInterval=60 -o ServerAliveCountMax=3', command)
        self.assertIn('cslog@10.1.0.9', command)
        self.assertIn('tmux new-window', command)
        self.assertIn('codex resume thread-1', command)


if __name__ == '__main__':
    unittest.main()
