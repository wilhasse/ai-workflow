from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from wsv2.actions import build_terminal_command, build_workspace_command
from wsv2.catalog import WorkspaceConfigError, load_config
from wsv2.cli import build_popup_unavailable_message, can_launch_gui_popup
from wsv2.state import LauncherState


def write_config(tmpdir: Path) -> Path:
    config = {
        "hosts": [
            {"id": "vm9", "name": "Supersaber", "ssh": "cslog@10.1.0.9"},
        ],
        "workspaces": [
            {
                "id": "mysql",
                "name": "MySQL Tests",
                "path": "~/mysql",
                "host": "local",
            },
            {
                "id": "dbtools",
                "name": "smart-sql",
                "path": "/srv/smart-sql",
                "host": "vm9",
            },
        ],
        "settings": {
            "terminal": "xfce4-terminal",
            "terminals": ["xfce4-terminal", "konsole"],
            "shell": "/bin/bash",
        },
    }
    path = tmpdir / "workspaces.json"
    path.write_text(json.dumps(config), encoding="utf-8")
    return path


class WorkspaceConfigTests(unittest.TestCase):
    def test_load_config_inserts_local_host_and_expands_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config = load_config(write_config(Path(tmp)))

        self.assertEqual(config.hosts[0].id, "local")
        mysql = config.resolve_workspace("mysql")
        self.assertTrue(mysql.path.endswith("/mysql"))
        self.assertEqual(mysql.target, "mysql")

        remote = config.resolve_workspace("vm9:dbtools")
        self.assertEqual(remote.target, "vm9:dbtools")
        self.assertEqual(remote.host.name, "Supersaber")

    def test_resolve_workspace_rejects_unknown_targets(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config = load_config(write_config(Path(tmp)))
        with self.assertRaises(WorkspaceConfigError):
            config.resolve_workspace("missing")


class CommandBuilderTests(unittest.TestCase):
    def test_build_workspace_command_matches_local_and_remote_models(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config = load_config(write_config(Path(tmp)))

        local_cmd = build_workspace_command(config.resolve_workspace("mysql"))
        remote_cmd = build_workspace_command(config.resolve_workspace("vm9:dbtools"))

        self.assertIn("tmux attach-session -t mysql || tmux new-session -s mysql", local_cmd)
        self.assertIn("ssh -t -o ServerAliveInterval=60 -o ServerAliveCountMax=3", remote_cmd)
        self.assertIn("cslog@10.1.0.9", remote_cmd)
        self.assertIn("tmux attach -t dbtools || tmux new -s dbtools", remote_cmd)

    def test_build_terminal_command_uses_terminal_specific_flags(self) -> None:
        xfce = build_terminal_command("xfce4-terminal", "echo hi", "mysql")
        gnome = build_terminal_command("gnome-terminal", "echo hi", "mysql")

        self.assertEqual(xfce[:4], ["xfce4-terminal", "--disable-server", "--window", "--title"])
        self.assertEqual(gnome[:3], ["gnome-terminal", "--title", "mysql"])


class LauncherStateTests(unittest.TestCase):
    def test_mark_recent_persists_timestamp(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            state = LauncherState(path)
            state.mark_recent("vm9:dbtools")
            scores = state.recent_scores()

        self.assertIn("vm9:dbtools", scores)
        self.assertGreater(scores["vm9:dbtools"], 0)


class PopupEnvironmentTests(unittest.TestCase):
    def test_can_launch_gui_popup_requires_display(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertFalse(can_launch_gui_popup())
        with mock.patch.dict(os.environ, {"DISPLAY": ":0"}, clear=True):
            self.assertTrue(can_launch_gui_popup())

    def test_popup_unavailable_message_includes_guidance(self) -> None:
        with mock.patch.dict(os.environ, {"TMUX": "1"}, clear=True):
            message = build_popup_unavailable_message()
        self.assertIn("needs a GUI session", message)
        self.assertIn("workspace-v2/scripts/wsv2 open <target>", message)
        self.assertIn("TMUX=set", message)


if __name__ == "__main__":
    unittest.main()
