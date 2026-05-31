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
    build_terminal_attach_command,
    build_terminal_command,
    build_workspace_command,
    create_tmux_window_from_terminal,
    terminal_recent_score,
    terminal_sort_key,
)
from wsv2.catalog import HostRecord, WorkspaceConfigError, load_config
from wsv2.cli import build_popup_unavailable_message, can_launch_gui_popup, detect_popup_surface
from wsv2.codex_parking import (
    _agent_kind,
    _agent_row_inactive,
    _foreground_tmux_panes,
    build_remote_wsv2_command,
    format_agent_processes,
    parse_agent_target,
    park_target,
    unpark_target,
)
from wsv2.session_archive import (
    build_record_command,
    build_records_for_pane,
    format_archive_records,
    merge_snapshots,
    scan_local_host,
    select_restore_records,
)
from wsv2.state import LauncherState
from wsv2.tui import build_tui_items, filter_tui_items, format_tui_row
from wsv2.drill import build_simulated_outage_payload, select_probe_targets
from wsv2.window_focus import terminal_target_from_window_title


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

    def test_default_v2_config_merges_legacy_and_archived_workspaces(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = Path(tmp)
            config_path = write_v2_config(tmpdir)
            legacy_path = tmpdir / 'legacy-workspaces.json'
            archive_path = tmpdir / 'workspace-session-archive.json'
            legacy_path.write_text(
                json.dumps(
                    {
                        'workspaces': [
                            {
                                'id': 'legacy-local',
                                'name': 'Legacy Local',
                                'path': '/legacy/local',
                                'host': 'local',
                            }
                        ]
                    }
                ),
                encoding='utf-8',
            )
            archive_path.write_text(
                json.dumps(
                    {
                        'records': [
                            {
                                'hostId': 'vm10',
                                'cwd': '/archive/docker',
                                'updatedAt': 100,
                                'lastSeenAt': 200,
                                'tmux': {'session': 'archived-docker'},
                            }
                        ]
                    }
                ),
                encoding='utf-8',
            )

            with mock.patch.dict(
                os.environ,
                {
                    'WSV2_SELF_HOST': 'vm10',
                    'WSV2_CONFIG_PATH': str(config_path),
                    'WSV2_LEGACY_CONFIG_PATH': str(legacy_path),
                    'WSV2_SESSION_ARCHIVE_PATH': str(archive_path),
                },
                clear=True,
            ):
                config = load_config()

        workspaces = {(workspace.host_id, workspace.id): workspace for workspace in config.workspaces}
        self.assertIn(('vm10', 'legacy-local'), workspaces)
        self.assertEqual(workspaces[('vm10', 'legacy-local')].path, '/legacy/local')
        self.assertIn(('vm10', 'archived-docker'), workspaces)
        self.assertEqual(workspaces[('vm10', 'archived-docker')].path, '/archive/docker')

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

    def test_terminal_attach_command_targets_selected_window(self) -> None:
        with tempfile.TemporaryDirectory() as tmp,             mock.patch('wsv2.catalog._runtime_identity_tokens', return_value={'godev4', 'godev4.local'}):
            config = load_config(write_v2_config(Path(tmp)))

        local_command = build_terminal_attach_command(
            config.get_host('vm10'),
            session_id='dbtools',
            window_index=3,
            run_local=True,
        )
        remote_command = build_terminal_attach_command(
            config.get_host('vm9'),
            session_id='dbtools',
            window_index=3,
            run_local=False,
        )

        self.assertIn('tmux attach-session -t dbtools:3', local_command)
        self.assertIn('tmux attach -t dbtools:3', remote_command)

        stable_command = build_terminal_attach_command(
            config.get_host('vm10'),
            session_id='dbtools',
            window_index=3,
            window_id='@44',
            run_local=True,
        )
        self.assertIn('tmux select-window -t @44', stable_command)
        self.assertIn('tmux attach-session -t dbtools', stable_command)

    def test_create_tmux_window_from_terminal_uses_current_pane_cwd(self) -> None:
        host = HostRecord(id='vm10', name='Main Desktop')
        with mock.patch(
            'wsv2.actions.subprocess.run',
            side_effect=[
                mock.Mock(returncode=0, stdout='/home/cslog/siscob_trunk\n', stderr=''),
                mock.Mock(returncode=0, stdout='@99|13\n', stderr=''),
            ],
        ) as run:
            window_id, window_index = create_tmux_window_from_terminal(
                host,
                session_id='siscob-trunk',
                window_index=7,
                window_id='@311',
                run_local=True,
            )

        self.assertEqual((window_id, window_index), ('@99', 13))
        self.assertEqual(
            run.call_args_list[1].args[0],
            [
                'tmux',
                'new-window',
                '-P',
                '-F',
                '#{window_id}|#{window_index}',
                '-t',
                'siscob-trunk:',
                '-c',
                '/home/cslog/siscob_trunk',
            ],
        )

    def test_build_terminal_command_uses_terminal_specific_flags(self) -> None:
        xfce = build_terminal_command('xfce4-terminal', 'echo hi', 'mysql')
        gnome = build_terminal_command('gnome-terminal', 'echo hi', 'mysql')

        self.assertEqual(xfce[:4], ['xfce4-terminal', '--disable-server', '--window', '--title'])
        self.assertEqual(gnome[:3], ['gnome-terminal', '--title', 'mysql'])


class WindowFocusTests(unittest.TestCase):
    def test_stable_terminal_title_selects_matching_window_id(self) -> None:
        host = HostRecord(id='vm10', name='Main Desktop')
        statuses = [
            TerminalStatus(
                host_id='vm10',
                host=host,
                session_id='fattor-servers',
                window_index=3,
                window_id='@200',
                window_name='dbtools',
                window_active=True,
                activity=500,
            ),
            TerminalStatus(
                host_id='vm10',
                host=host,
                session_id='ai-workflow',
                window_index=1,
                window_id='@168',
                window_name='node',
                window_active=False,
                activity=100,
            ),
        ]

        self.assertEqual(
            terminal_target_from_window_title('ai-workflow@168', statuses),
            'vm10:ai-workflow@168',
        )

    def test_legacy_terminal_title_selects_window_name_or_index(self) -> None:
        host = HostRecord(id='vm10', name='Main Desktop')
        statuses = [
            TerminalStatus(
                host_id='vm10',
                host=host,
                session_id='docker',
                window_index=1,
                window_id='@10',
                window_name='api',
                tmux_window_name='api',
                activity=100,
            ),
            TerminalStatus(
                host_id='vm10',
                host=host,
                session_id='docker',
                window_index=2,
                window_id='@11',
                window_name='node',
                tmux_window_name='node',
                window_active=True,
                activity=50,
            ),
        ]

        self.assertEqual(
            terminal_target_from_window_title('Terminal - docker : node', statuses),
            'vm10:docker@11',
        )
        self.assertEqual(
            terminal_target_from_window_title('Terminal - docker : #1', statuses),
            'vm10:docker@10',
        )


class LauncherStateTests(unittest.TestCase):
    def test_mark_recent_persists_timestamp(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'state.json'
            state = LauncherState(path)
            state.mark_recent('vm9:dbtools')
            scores = state.recent_scores()

        self.assertIn('vm9:dbtools', scores)
        self.assertGreater(scores['vm9:dbtools'], 0)

    def test_boolean_preferences_persist(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'state.json'
            state = LauncherState(path)
            self.assertFalse(state.preference_bool('activeOnly'))
            state.set_preference_bool('activeOnly', True)
            reloaded = LauncherState(path)
            self.assertTrue(reloaded.preference_bool('activeOnly'))

    def test_window_label_preserves_recent_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'state.json'
            state = LauncherState(path)
            state.mark_recent('vm9:dbtools#2')
            label = state.set_window_label('vm9', 'dbtools', 2, '  RENAC   calls  ')

            payload = json.loads(path.read_text(encoding='utf-8'))

        self.assertEqual(label, 'RENAC calls')
        self.assertIn('vm9:dbtools#2', payload['recent'])
        self.assertEqual(payload['windowLabels']['vm9:dbtools#2']['label'], 'RENAC calls')

    def test_empty_window_label_clears_record(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'state.json'
            state = LauncherState(path)
            state.set_window_label('vm9', 'dbtools', 2, 'api task')
            state.set_window_label('vm9', 'dbtools', 2, '   ')

            labels = state.window_labels()

        self.assertNotIn('vm9:dbtools#2', labels)

    def test_window_status_preserves_label_and_can_clear(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'state.json'
            state = LauncherState(path)
            state.set_window_label('vm9', 'dbtools', 2, 'RENAC calls')
            status = state.set_window_status('vm9', 'dbtools', 2, 'done')
            state.set_window_label('vm9', 'dbtools', 2, '')
            labels_after_label_clear = state.window_labels()
            state.set_window_status('vm9', 'dbtools', 2, '')
            labels_after_status_clear = state.window_labels()

        self.assertEqual(status, 'idle')
        self.assertEqual(labels_after_label_clear['vm9:dbtools#2']['status'], 'idle')
        self.assertNotIn('label', labels_after_label_clear['vm9:dbtools#2'])
        self.assertNotIn('vm9:dbtools#2', labels_after_status_clear)

    def test_stable_window_metadata_migrates_legacy_index_record(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'state.json'
            state = LauncherState(path)
            state.set_window_metadata('vm9', 'dbtools', 2, label='RENAC calls', status='check')
            metadata = state.set_window_metadata('vm9', 'dbtools', 2, status='idle', window_id='@42')

            labels = state.window_labels()
            shifted_label = state.window_label('vm9', 'dbtools', 7, '@42')

        self.assertEqual(metadata, {'label': 'RENAC calls', 'status': 'idle'})
        self.assertIn('vm9:dbtools@42', labels)
        self.assertNotIn('vm9:dbtools#2', labels)
        self.assertEqual(labels['vm9:dbtools@42']['label'], 'RENAC calls')
        self.assertEqual(shifted_label, 'RENAC calls')


class CodexParkingTests(unittest.TestCase):
    def test_parse_agent_target_accepts_session_and_window_forms(self) -> None:
        session_target = parse_agent_target('docker')
        window_hash_target = parse_agent_target('docker#4')
        window_colon_target = parse_agent_target('docker:6')
        window_id_target = parse_agent_target('docker@42')

        self.assertEqual(session_target.session_id, 'docker')
        self.assertIsNone(session_target.window_index)
        self.assertEqual(window_hash_target.session_id, 'docker')
        self.assertEqual(window_hash_target.window_index, 4)
        self.assertEqual(window_colon_target.session_id, 'docker')
        self.assertEqual(window_colon_target.window_index, 6)
        self.assertEqual(window_id_target.session_id, 'docker')
        self.assertEqual(window_id_target.window_id, '@42')
        self.assertIsNone(parse_agent_target('all'))

    def test_format_agent_processes_marks_parked_rows(self) -> None:
        output = format_agent_processes(
            [
                {
                    'parked': True,
                    'hostName': 'Main Desktop',
                    'session': 'docker',
                    'windowIndex': 1,
                    'kinds': ['codex'],
                    'processGroupId': 123,
                    'agentPids': [124],
                    'commands': ['codex resume 019d'],
                }
            ]
        )

        self.assertIn('PARKED', output)
        self.assertIn('docker#1', output)
        self.assertIn('codex', output)

    def test_agent_detection_ignores_shell_snapshot_metadata(self) -> None:
        self.assertIsNone(
            _agent_kind(
                {
                    'comm': 'bash',
                    'args': "export CLAUDE_PLUGIN_DATA='/home/cslog/.claude/plugins/data/codex-openai-codex'",
                }
            )
        )
        self.assertEqual(_agent_kind({'comm': 'node', 'args': 'node /usr/bin/codex'}), 'codex')

    def test_park_target_saves_resume_command_and_interrupts_pane(self) -> None:
        row = {
            'session': 'docker',
            'windowIndex': 1,
            'windowName': 'node',
            'paneId': '%1',
            'panePid': 100,
            'processGroupId': 123,
            'pids': [123, 124],
            'agentPids': [124],
            'kinds': ['codex'],
            'cwd': '/work',
            'target': 'docker#1',
            'parked': False,
        }
        candidate = {
            'kind': 'codex',
            'resumeId': '019d',
            'resumeCommand': 'cd /work && codex resume 019d',
            'title': 'Codex session',
        }
        with mock.patch('wsv2.codex_parking.list_agent_processes', return_value=[row]), \
            mock.patch('wsv2.codex_parking._load_state', return_value={'records': []}), \
            mock.patch('wsv2.codex_parking._save_state') as save_state, \
            mock.patch(
                'wsv2.codex_parking._resume_candidates_for_rows',
                return_value={('docker', '1', '%1'): [candidate]},
            ), \
            mock.patch('wsv2.codex_parking._interrupt_agent_row', return_value=[]) as interrupt, \
            mock.patch('wsv2.codex_parking._resume_records_from_pane_output', return_value=[]):
            result = park_target('docker#1', host_id='vm10', host_name='Main Desktop')

        self.assertEqual(result['changed'], 1)
        interrupt.assert_called_once_with(row)
        self.assertEqual(save_state.call_args.args[0]['records'][0]['processGroupId'], 123)
        self.assertEqual(save_state.call_args.args[0]['records'][0]['resumeCommand'], 'cd /work && codex resume 019d')

    def test_unpark_target_continues_live_and_recorded_groups(self) -> None:
        row = {
            'session': 'docker',
            'windowIndex': 1,
            'processGroupId': 123,
            'target': 'docker#1',
            'parked': True,
        }
        state = {
            'records': [
                {'session': 'docker', 'windowIndex': 1, 'processGroupId': 456},
                {'session': 'dbtools', 'windowIndex': 1, 'processGroupId': 789},
            ]
        }
        with mock.patch('wsv2.codex_parking.list_agent_processes', return_value=[row]), \
            mock.patch('wsv2.codex_parking._load_state', return_value=state), \
            mock.patch('wsv2.codex_parking._save_state') as save_state, \
            mock.patch('wsv2.codex_parking.os.killpg') as killpg:
            result = unpark_target('docker#1')

        self.assertEqual(result['changed'], 2)
        self.assertEqual([call.args[0] for call in killpg.call_args_list], [123, 456])
        self.assertEqual(save_state.call_args.args[0]['records'][0]['session'], 'dbtools')

    def test_unpark_target_launches_saved_resume_command(self) -> None:
        state = {
            'records': [
                {
                    'session': 'docker',
                    'windowIndex': 1,
                    'paneId': '%1',
                    'kind': 'codex',
                    'resumeId': '019d',
                    'resumeCommand': 'cd /work && codex resume 019d',
                }
            ]
        }
        with mock.patch('wsv2.codex_parking.list_agent_processes', return_value=[]), \
            mock.patch('wsv2.codex_parking._load_state', return_value=state), \
            mock.patch('wsv2.codex_parking._save_state') as save_state, \
            mock.patch('wsv2.codex_parking._launch_resume_record') as launch:
            result = unpark_target('docker#1')

        self.assertEqual(result['changed'], 1)
        launch.assert_called_once()
        self.assertEqual(save_state.call_args.args[0]['records'], [])

    def test_remote_command_preserves_all_flag(self) -> None:
        command = build_remote_wsv2_command(
            'park',
            None,
            host_id='vm10',
            host_name='Main Desktop',
            json_output=True,
            all_targets=True,
        )

        self.assertIn('codex park --all --local-only', command)
        self.assertIn('--json', command)

    def test_foreground_tmux_panes_sends_fg_once_per_pane(self) -> None:
        with mock.patch('wsv2.codex_parking.subprocess.run') as run:
            run.return_value.returncode = 0
            errors = _foreground_tmux_panes(
                [{'paneId': '%1'}, {'paneId': '%1'}],
                [{'paneId': '%2'}],
        )

        self.assertEqual(errors, [])
        self.assertEqual(len(run.call_args_list), 4)
        self.assertEqual(run.call_args_list[0].args[0], ['tmux', 'send-keys', '-t', '%1', 'C-c'])
        self.assertEqual(run.call_args_list[1].args[0][:4], ['tmux', 'send-keys', '-t', '%1'])
        self.assertEqual(run.call_args_list[1].args[0][-2:], ['fg', 'Enter'])

    def test_agent_row_inactive_ignores_lingering_non_agent_process_group(self) -> None:
        row = {'agentPids': [123], 'processGroupId': 123}
        with mock.patch(
            'wsv2.codex_parking._process_table',
            return_value={
                456: {
                    'pid': 456,
                    'ppid': 1,
                    'pgid': 123,
                    'stat': 'S',
                    'comm': 'bash',
                    'args': 'bash',
                },
            },
        ):
            self.assertTrue(_agent_row_inactive(row))

    def test_agent_row_inactive_keeps_running_agent_active(self) -> None:
        row = {'agentPids': [123], 'processGroupId': 123}
        with mock.patch(
            'wsv2.codex_parking._process_table',
            return_value={
                123: {
                    'pid': 123,
                    'ppid': 100,
                    'pgid': 123,
                    'stat': 'S',
                    'comm': 'codex',
                    'args': 'codex --dangerously-bypass-approvals-and-sandbox',
                },
            },
        ):
            self.assertFalse(_agent_row_inactive(row))

    def test_agent_row_inactive_treats_stopped_agent_as_inactive(self) -> None:
        row = {'agentPids': [123], 'processGroupId': 123}
        with mock.patch(
            'wsv2.codex_parking._process_table',
            return_value={
                123: {
                    'pid': 123,
                    'ppid': 100,
                    'pgid': 123,
                    'stat': 'T',
                    'comm': 'codex',
                    'args': 'codex --dangerously-bypass-approvals-and-sandbox',
                },
            },
        ):
            self.assertTrue(_agent_row_inactive(row))


class TerminalRankingTests(unittest.TestCase):
    def test_terminal_recent_score_uses_tmux_activity_not_selection(self) -> None:
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
        self.assertEqual(terminal_recent_score(status, {'vm9:dbtools#2': 200}), 100)
        self.assertEqual(terminal_recent_score(status, {'vm9:dbtools': 300}), 100)

    def test_terminal_sort_prioritizes_labeled_tabs_before_recent_unlabeled_tabs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.dict(os.environ, {'WSV2_SELF_HOST': 'vm10'}, clear=True):
            config = load_config(write_v2_config(Path(tmp)))

        workspace = config.resolve_workspace('vm9:dbtools')
        labeled = TerminalStatus(
            host_id=workspace.host_id,
            host=workspace.host,
            session_id=workspace.id,
            window_index=2,
            window_name='RENAC calls',
            tmux_window_name='bash',
            window_label='RENAC calls',
            activity=10,
            workspace=workspace,
        )
        unlabeled = TerminalStatus(
            host_id=workspace.host_id,
            host=workspace.host,
            session_id=workspace.id,
            window_index=3,
            window_name='node',
            activity=1000,
            workspace=workspace,
        )

        self.assertEqual(sorted([unlabeled, labeled], key=terminal_sort_key), [labeled, unlabeled])

    def test_terminal_sort_places_check_first_without_demoting_idle(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.dict(os.environ, {'WSV2_SELF_HOST': 'vm10'}, clear=True):
            config = load_config(write_v2_config(Path(tmp)))

        workspace = config.resolve_workspace('vm9:dbtools')
        active = TerminalStatus(
            host_id=workspace.host_id,
            host=workspace.host,
            session_id=workspace.id,
            window_index=2,
            window_name='active task',
            window_label='active task',
            activity=100,
            workspace=workspace,
        )
        check = TerminalStatus(
            host_id=workspace.host_id,
            host=workspace.host,
            session_id=workspace.id,
            window_index=3,
            window_name='check task',
            window_status='check',
            activity=1,
            workspace=workspace,
        )
        idle = TerminalStatus(
            host_id=workspace.host_id,
            host=workspace.host,
            session_id=workspace.id,
            window_index=4,
            window_name='idle task',
            window_label='idle task',
            window_status='idle',
            activity=1000,
            workspace=workspace,
        )

        self.assertEqual(sorted([active, check, idle], key=terminal_sort_key), [check, idle, active])

    def test_list_terminal_statuses_orders_activity_before_manual_selection(self) -> None:
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
                        'window_id': '@24',
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
                            'window_id': '@42',
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

        self.assertEqual(statuses[0].target, 'vm10:mysql@24')

    def test_list_terminal_statuses_prefers_window_label_for_display(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.dict(os.environ, {'WSV2_SELF_HOST': 'vm10'}, clear=True):
            config_path = write_v2_config(Path(tmp))
            state_path = Path(tmp) / 'state.json'
            actions = WorkspaceActions(config_path=config_path, state_path=state_path)
            actions.state.set_window_metadata('vm9', 'dbtools', 2, label='RENAC calls', status='check')

            with mock.patch.object(actions, '_list_local_windows', return_value=[]), \
                mock.patch.object(
                    actions,
                    '_list_remote_windows',
                    return_value=(
                        [
                            {
                                'session_id': 'dbtools',
                                'window_index': 2,
                                'window_id': '@42',
                                'window_name': 'codex bash',
                                'window_active': False,
                                'activity': 10,
                                'pane_count': 1,
                            }
                        ],
                        True,
                    ),
                ):
                statuses = actions.list_terminal_statuses()

        status = next(item for item in statuses if item.target == 'vm9:dbtools@42')
        self.assertEqual(status.window_name, 'RENAC calls')
        self.assertEqual(status.tmux_window_name, 'codex bash')
        self.assertEqual(status.window_label, 'RENAC calls')
        self.assertEqual(status.window_status, 'check')

    def test_set_terminal_metadata_parks_and_unparks_idle_terminal(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.dict(os.environ, {'WSV2_SELF_HOST': 'vm10'}, clear=True):
            config_path = write_v2_config(Path(tmp))
            state_path = Path(tmp) / 'state.json'
            actions = WorkspaceActions(config_path=config_path, state_path=state_path)
            workspace = actions.config.resolve_workspace('mysql')
            active = TerminalStatus(
                host_id=workspace.host_id,
                host=workspace.host,
                session_id=workspace.id,
                window_index=1,
                window_id='@42',
                window_name='codex bash',
                workspace=workspace,
            )
            idle = TerminalStatus(
                host_id=workspace.host_id,
                host=workspace.host,
                session_id=workspace.id,
                window_index=1,
                window_id='@42',
                window_name='codex bash',
                window_status='idle',
                workspace=workspace,
            )

            with mock.patch('wsv2.actions.park_target') as park, \
                mock.patch('wsv2.actions.unpark_target') as unpark:
                actions.set_terminal_metadata(active, status='idle')
                actions.set_terminal_metadata(idle, status='')

        park.assert_called_once_with(
            'mysql@42',
            host_id='vm10',
            host_name='Main Desktop',
            reason='idle-status',
        )
        unpark.assert_called_once_with('mysql@42', host_id='vm10', host_name='Main Desktop')


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

    def test_filter_tui_items_matches_terminal_and_tab_terms(self) -> None:
        host = HostRecord(id='vm10', name='Main Desktop')
        statuses = [
            TerminalStatus(
                host_id=host.id,
                host=host,
                session_id='siscob-trunk',
                window_index=7,
                window_id='@311',
                window_name='Vitor Tel',
                window_status='idle',
            ),
            TerminalStatus(
                host_id=host.id,
                host=host,
                session_id='siscob-trunk',
                window_index=8,
                window_id='@312',
                window_name='other',
            ),
        ]
        items = build_tui_items(statuses)

        filtered = filter_tui_items(items, 'siscob-trunk #7', active_only=True)

        self.assertEqual(len(filtered), 1)
        self.assertEqual(filtered[0].status.target, 'vm10:siscob-trunk@311')

    def test_filter_tui_items_can_show_only_active_terminals(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config = load_config(write_legacy_config(Path(tmp)))
        workspace = config.resolve_workspace('mysql')
        inactive = TerminalStatus(
            host_id=workspace.host_id,
            host=workspace.host,
            session_id=workspace.id,
            window_index=0,
            window_name=workspace.name,
            workspace=workspace,
        )
        active = TerminalStatus(
            host_id=workspace.host_id,
            host=workspace.host,
            session_id=workspace.id,
            window_index=1,
            window_name='bash',
            workspace=workspace,
        )
        flagged = TerminalStatus(
            host_id=workspace.host_id,
            host=workspace.host,
            session_id=workspace.id,
            window_index=2,
            window_name='needs-review',
            window_status='check',
            workspace=workspace,
        )
        items = build_tui_items([inactive, flagged, active])

        filtered = filter_tui_items(items, '', active_only=True)

        self.assertEqual([item.status.window_index for item in filtered], [2, 1])

    def test_format_tui_row_puts_terminal_label_first(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config = load_config(write_legacy_config(Path(tmp)))
        workspace = config.resolve_workspace('vm9:dbtools')
        row = format_tui_row(
            TerminalStatus(
                host_id=workspace.host_id,
                host=workspace.host,
                session_id=workspace.id,
                window_index=2,
                window_name='RENAC calls',
                workspace=workspace,
            ),
            120,
        )

        self.assertLess(row.index('RENAC calls'), row.index('#2'))
        self.assertLess(row.index('#2'), row.index('smart-sql'))

    def test_filter_tui_items_prioritizes_labeled_tabs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config = load_config(write_legacy_config(Path(tmp)))
        workspace = config.resolve_workspace('vm9:dbtools')
        labeled = TerminalStatus(
            host_id=workspace.host_id,
            host=workspace.host,
            session_id=workspace.id,
            window_index=2,
            window_name='RENAC calls',
            window_label='RENAC calls',
            activity=1,
            workspace=workspace,
        )
        unlabeled = TerminalStatus(
            host_id=workspace.host_id,
            host=workspace.host,
            session_id=workspace.id,
            window_index=3,
            window_name='codex bash',
            activity=1000,
            workspace=workspace,
        )
        items = build_tui_items([unlabeled, labeled])

        filtered = filter_tui_items(items, '')

        self.assertEqual([item.status.window_index for item in filtered], [2, 3])


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

    def test_scan_local_host_prefers_exact_agent_rows_over_cwd_matches(self) -> None:
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
        row = {
            'session': 'harness',
            'windowIndex': 1,
            'windowId': '@8',
            'windowName': 'node',
            'paneIndex': 0,
            'paneId': '%5',
            'panePid': 111,
            'cwd': '/home/cslog/ai-workflow',
            'kinds': ['codex'],
            'parked': False,
            'commands': [
                'node /usr/bin/codex --dangerously-bypass-approvals-and-sandbox '
                'resume --dangerously-bypass-approvals-and-sandbox codex-exact'
            ],
            'target': 'harness@8',
        }

        with mock.patch('wsv2.session_archive._list_tmux_panes', return_value=[pane]), \
            mock.patch('wsv2.session_archive._load_claude_sessions', return_value=[]), \
            mock.patch(
                'wsv2.session_archive._load_codex_threads',
                return_value=[
                    {'resumeId': 'codex-old-1', 'cwd': '/home/cslog/ai-workflow', 'title': 'Old 1', 'updatedAt': 100},
                    {'resumeId': 'codex-exact', 'cwd': '/home/cslog/ai-workflow', 'title': 'Exact', 'updatedAt': 300},
                    {'resumeId': 'codex-old-2', 'cwd': '/home/cslog/ai-workflow', 'title': 'Old 2', 'updatedAt': 200},
                ],
            ), \
            mock.patch('wsv2.session_archive._list_agent_rows', return_value=[row]):
            snapshot = scan_local_host(host_id='vm10', host_name='Main Desktop', now_ms=1000)

        active_records = [record for record in snapshot['records'] if record['active']]
        self.assertEqual(len(active_records), 1)
        self.assertEqual(active_records[0]['resumeId'], 'codex-exact')
        self.assertEqual(active_records[0]['matchSource'], 'process-command')
        self.assertIn('--dangerously-bypass-approvals-and-sandbox codex-exact', active_records[0]['resumeCommand'])

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
        self.assertEqual(archive['records'][0]['lastActiveAt'], 1000)

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

    def test_merge_preserves_tmux_metadata_when_reboot_scan_sees_only_history(self) -> None:
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
                    'lastActiveAt': 1000,
                    'active': True,
                    'tmux': {'session': 'repo', 'windowIndex': 1},
                    'resumeCommand': 'cd /repo && codex resume thread-1',
                }
            ],
        }
        snapshot = {
            'hostId': 'vm10',
            'hostName': 'Main Desktop',
            'reachable': True,
            'records': [
                {
                    'id': 'cx-live',
                    'kind': 'codex',
                    'resumeId': 'thread-1',
                    'hostId': 'vm10',
                    'hostName': 'Main Desktop',
                    'cwd': '/repo',
                    'title': 'Live work',
                    'updatedAt': 200,
                    'firstSeenAt': 2000,
                    'lastSeenAt': 2000,
                    'active': False,
                    'tmux': None,
                    'resumeCommand': 'cd /repo && codex resume thread-1',
                }
            ],
        }

        merged = merge_snapshots(archive, [snapshot], now_ms=2000)

        self.assertFalse(merged['records'][0]['active'])
        self.assertEqual(merged['records'][0]['tmux'], {'session': 'repo', 'windowIndex': 1})
        self.assertEqual(merged['records'][0]['lastActiveAt'], 1000)

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

    def test_build_record_command_can_launch_detached_without_attach(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.dict(os.environ, {'WSV2_SELF_HOST': 'vm10'}, clear=True):
            config = load_config(write_v2_config(Path(tmp)))
        record = {
            'kind': 'codex',
            'resumeId': 'thread-1',
            'hostId': 'vm10',
            'cwd': '/home/cslog/ai-workflow',
            'title': 'Harness task',
            'resumeCommand': 'cd /home/cslog/ai-workflow && codex resume --full-auto thread-1',
            'tmux': {'session': 'harness', 'windowName': 'node', 'windowIndex': 2},
        }

        command = build_record_command(record, config, tmux_restore=True, attach=False)

        self.assertIn('tmux new-session -d -s harness', command)
        self.assertIn('tmux new-window -d -t harness', command)
        self.assertNotIn('attach-session', command)
        self.assertIn('codex resume --full-auto thread-1', command)

    def test_select_restore_records_keeps_recent_last_active_records(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.dict(os.environ, {'WSV2_SELF_HOST': 'vm10'}, clear=True):
            tmpdir = Path(tmp)
            config = load_config(write_v2_config(tmpdir))
            archive_path = tmpdir / 'archive.json'
            archive_path.write_text(
                json.dumps(
                    {
                        'records': [
                            {
                                'id': 'cx-recent',
                                'kind': 'codex',
                                'resumeId': 'thread-1',
                                'hostId': 'vm10',
                                'cwd': '/repo',
                                'active': False,
                                'lastActiveAt': 7_000,
                                'tmux': {'session': 'repo', 'windowIndex': 1},
                            },
                            {
                                'id': 'cx-old',
                                'kind': 'codex',
                                'resumeId': 'thread-2',
                                'hostId': 'vm10',
                                'cwd': '/repo',
                                'active': False,
                                'lastActiveAt': 1_000,
                                'tmux': {'session': 'repo', 'windowIndex': 2},
                            },
                        ]
                    }
                ),
                encoding='utf-8',
            )

            records = select_restore_records(
                config,
                archive_path=archive_path,
                host='self',
                since_hours=1 / 1000,
                now_ms=10_000,
            )

        self.assertEqual([record['id'] for record in records], ['cx-recent'])

    def test_select_restore_records_prefers_active_records_before_recent_inactive(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.dict(os.environ, {'WSV2_SELF_HOST': 'vm10'}, clear=True):
            tmpdir = Path(tmp)
            config = load_config(write_v2_config(tmpdir))
            archive_path = tmpdir / 'archive.json'
            archive_path.write_text(
                json.dumps(
                    {
                        'records': [
                            {
                                'id': 'cx-active',
                                'kind': 'codex',
                                'resumeId': 'thread-1',
                                'hostId': 'vm10',
                                'cwd': '/repo',
                                'active': True,
                                'lastActiveAt': 7_000,
                                'tmux': {'session': 'repo', 'windowIndex': 1},
                            },
                            {
                                'id': 'cx-recent-inactive',
                                'kind': 'codex',
                                'resumeId': 'thread-2',
                                'hostId': 'vm10',
                                'cwd': '/repo',
                                'active': False,
                                'lastActiveAt': 9_000,
                                'tmux': {'session': 'repo', 'windowIndex': 2},
                            },
                        ]
                    }
                ),
                encoding='utf-8',
            )

            records = select_restore_records(
                config,
                archive_path=archive_path,
                host='self',
                since_hours=1,
                now_ms=10_000,
            )

        self.assertEqual([record['id'] for record in records], ['cx-active'])

    def test_archive_list_output_includes_raw_resume_id(self) -> None:
        output = format_archive_records(
            [
                {
                    'id': 'cx-short',
                    'kind': 'codex',
                    'resumeId': '019d8215-10f6-7471-b88b-a32f42e71b12',
                    'hostName': 'Supersaber',
                    'cwd': '/home/cslog/ai-workflow',
                    'title': 'Recoverable Codex work',
                    'active': True,
                    'tmux': {'session': 'harness', 'windowIndex': 2},
                }
            ]
        )

        self.assertIn('cx-short', output)
        self.assertIn('resume=019d8215-10f6-7471-b88b-a32f42e71b12', output)
        self.assertIn('harness#2', output)


if __name__ == '__main__':
    unittest.main()
