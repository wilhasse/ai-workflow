from __future__ import annotations

from pathlib import Path

import pytest

from plane_codex_worker.config import WorkerConfig


@pytest.fixture
def config(tmp_path: Path) -> WorkerConfig:
    return WorkerConfig(
        plane_base_url="https://plane.test",
        plane_api_key="plane-secret",
        plane_workspace="cslog",
        plane_project_id="project-id",
        plane_project_identifier="AGENTE",
        codex_socket=tmp_path / "control.sock",
        codex_preset="default",
        codex_cwd=tmp_path,
        state_db=tmp_path / "jobs.sqlite3",
        poll_seconds=30,
        turn_poll_seconds=0.001,
        turn_timeout_seconds=1,
        max_issues_per_poll=3,
        max_issue_chars=8000,
        max_result_chars=30000,
        agent_board_url="https://board.test/?view=agent-board",
    )
