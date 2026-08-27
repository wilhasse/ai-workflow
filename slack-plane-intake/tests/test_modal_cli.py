from __future__ import annotations

import json
import sqlite3
from dataclasses import replace
from pathlib import Path
from typing import ClassVar
from unittest.mock import AsyncMock

import pytest

from slack_plane_intake.config import load_config
from slack_plane_intake.drafts import DraftStore
from slack_plane_intake.errors import SourceValidationError
from slack_plane_intake.modal_cli import process_request
from slack_plane_intake.models import IntakeResult, PlaneProject


class ProjectClientStub:
    configs: ClassVar[list] = []
    projects = (
        PlaneProject(id="project-uuid", identifier="AGENTE", name="AGENTE"),
        PlaneProject(id="project-olos", identifier="OLOS", name="OLOS"),
    )

    def __init__(self, config):
        self.config = config
        self.configs.append(config)

    async def list_projects(self):
        return self.projects

    async def resolve_project_config(self, project_id):
        project = next(
            (project for project in self.projects if project.id == project_id), None
        )
        if project is None:
            raise SourceValidationError("selected project is unavailable")
        return replace(
            self.config,
            project_id=project.id,
            project_identifier=project.identifier,
            state_id=f"state-{project.identifier.lower()}",
        )

    async def close(self):
        return None


@pytest.fixture(autouse=True)
def project_client_stub(monkeypatch):
    ProjectClientStub.configs = []
    monkeypatch.setattr("slack_plane_intake.modal_cli.PlaneClient", ProjectClientStub)
    return ProjectClientStub


def add_request(
    message_ts: str, text: str = "database alert", *, user_id: str = "U1"
) -> dict:
    return {
        "action": "add",
        "shortcut": {
            "type": "message_action",
            "callback_id": "create_agente_ticket",
            "team": {"id": "T1"},
            "user": {"id": user_id},
            "channel": {"id": "D1"},
            "message": {"ts": message_ts, "text": text},
        },
    }


@pytest.mark.asyncio
async def test_modal_adds_messages_then_submits_one_bundle(monkeypatch, required_env):
    required_env["SPI_SLACK_SHORTCUT_ALLOWED_USERS"] = "U1,U2"
    config = load_config(required_env)
    monkeypatch.setattr("slack_plane_intake.modal_cli.load_config", lambda: config)
    first = await process_request(add_request("1724440000.000001"))
    second = await process_request(add_request("1724440001.000001", "screenshot"))

    service = AsyncMock()
    service.create_from_slack_shortcut_messages.return_value = IntakeResult(
        status="created", issue_key="OLOS-1", issue_url="https://plane.test/ws/OLOS-1"
    )
    service_configs = []
    result = await process_request(
        {
            "action": "submit",
            "draft_id": second["draft_id"],
            "team_id": "T1",
            "user_id": "U1",
            "channel_id": "D1",
            "project_id": "project-olos",
            "selected_message_ts": [
                "1724440000.000001",
                "1724440001.000001",
            ],
        },
        service_factory=lambda scoped: service_configs.append(scoped) or service,
    )

    assert first["draft_id"] == second["draft_id"]
    assert second["mode"] == "collector"
    assert len(second["messages"]) == 2
    assert second["initial_message_ts"] == "1724440001.000001"
    assert second["initial_project_id"] == "project-uuid"
    assert [project["label"] for project in second["projects"]] == [
        "AGENTE",
        "OLOS",
    ]
    assert result["issue_key"] == "OLOS-1"
    assert service_configs[0].plane.project_identifier == "OLOS"
    assert service_configs[0].plane.state_id == "state-olos"
    payloads = service.create_from_slack_shortcut_messages.await_args.kwargs[
        "message_payloads"
    ]
    assert [payload["ts"] for payload in payloads] == [
        "1724440000.000001",
        "1724440001.000001",
    ]
    service.close.assert_awaited_once()
    with sqlite3.connect(config.state_db) as connection:
        audit = connection.execute(
            """
            SELECT offered_message_ts_json, selected_message_ts_json,
                   status, issue_key
              FROM shortcut_submission_audit
            """
        ).fetchone()
    assert audit is not None
    assert json.loads(audit[0]) == [
        "1724440000.000001",
        "1724440001.000001",
    ]
    assert json.loads(audit[1]) == [
        "1724440000.000001",
        "1724440001.000001",
    ]
    assert audit[2:] == ("created", "OLOS-1")
    with pytest.raises(SourceValidationError, match="not found or expired"):
        DraftStore(config.state_db).get(
            draft_id=second["draft_id"],
            team_id="T1",
            user_id="U1",
            channel_id="D1",
        )


@pytest.mark.asyncio
async def test_failed_submission_retains_draft(monkeypatch, required_env):
    config = load_config(required_env)
    monkeypatch.setattr("slack_plane_intake.modal_cli.load_config", lambda: config)
    added = await process_request(add_request("1724440000.000001"))
    service = AsyncMock()
    service.create_from_slack_shortcut_messages.return_value = IntakeResult(
        status="failed", warnings=("Plane unavailable",)
    )

    result = await process_request(
        {
            "action": "submit",
            "draft_id": added["draft_id"],
            "team_id": "T1",
            "user_id": "U1",
            "channel_id": "D1",
            "project_id": "project-uuid",
            "selected_message_ts": ["1724440000.000001"],
        },
        service_factory=lambda _config: service,
    )

    assert result["status"] == "failed"
    with sqlite3.connect(config.state_db) as connection:
        audit_status = connection.execute(
            "SELECT status FROM shortcut_submission_audit"
        ).fetchone()
    assert audit_status == ("failed",)
    assert DraftStore(config.state_db).get(
        draft_id=added["draft_id"],
        team_id="T1",
        user_id="U1",
        channel_id="D1",
    )


@pytest.mark.asyncio
async def test_submission_rejects_project_not_available_to_plane_user(
    monkeypatch, required_env
):
    config = load_config(required_env)
    monkeypatch.setattr("slack_plane_intake.modal_cli.load_config", lambda: config)
    added = await process_request(add_request("1724440000.000001"))
    service = AsyncMock()

    result = await process_request(
        {
            "action": "submit",
            "draft_id": added["draft_id"],
            "team_id": "T1",
            "user_id": "U1",
            "channel_id": "D1",
            "project_id": "forged-project",
            "selected_message_ts": ["1724440000.000001"],
        },
        service_factory=lambda _config: service,
    )

    assert result == {
        "status": "failed",
        "warnings": ["selected project is unavailable"],
    }
    service.create_from_slack_shortcut_messages.assert_not_awaited()


@pytest.mark.asyncio
async def test_history_picker_populates_real_multi_message_modal_in_one_action(
    monkeypatch, required_env
):
    required_env["SPI_SLACK_HISTORY_USER_ID"] = "U1"
    required_env["SPI_SLACK_HISTORY_USER_TOKEN"] = "xoxp-history"
    config = load_config(required_env)
    monkeypatch.setattr("slack_plane_intake.modal_cli.load_config", lambda: config)
    slack = AsyncMock()
    slack.fetch_shortcut_history_payloads.return_value = (
        {
            "ts": "1724440000.000001",
            "user": "U2",
            "username": "Benatti",
            "text": "problem",
            "files": [],
        },
        {
            "ts": "1724440001.000001",
            "user": "U2",
            "username": "Benatti",
            "text": "",
            "files": [{"id": "F1", "url_private": "secret-like-url"}],
        },
        {
            "ts": "1724440002.000001",
            "user": "U1",
            "username": "Willian",
            "text": "please create a ticket",
            "files": [],
        },
    )
    monkeypatch.setattr(
        "slack_plane_intake.modal_cli.SlackClient",
        lambda *_args, **_kwargs: slack,
    )

    result = await process_request(
        add_request("1724440002.000001", "please create a ticket")
    )

    assert result["status"] == "ready"
    assert result["mode"] == "history"
    assert result["initial_message_ts"] == "1724440002.000001"
    assert len(result["messages"]) == 3
    assert "Benatti" in result["messages"][0]["label"]
    assert "·" in result["messages"][0]["label"]
    assert "Willian" in result["messages"][2]["label"]
    slack.fetch_shortcut_history_payloads.assert_awaited_once()
    slack.close.assert_awaited_once()
    snapshot = DraftStore(config.state_db).get(
        draft_id=result["draft_id"],
        team_id="T1",
        user_id="U1",
        channel_id="D1",
    )
    assert [message.message_ts for message in snapshot.messages] == [
        "1724440000.000001",
        "1724440001.000001",
        "1724440002.000001",
    ]
    assert "url_private" not in snapshot.messages[1].payload["files"][0]


@pytest.mark.asyncio
async def test_personal_credentials_route_history_and_plane_by_invoking_user(
    monkeypatch, required_env, project_client_stub
):
    required_env["SPI_SLACK_SHORTCUT_ALLOWED_USERS"] = "U1,U2"
    credentials_path = Path(required_env["SPI_STATE_ROOT"]).parent / "users.json"
    credentials_path.write_text(
        json.dumps(
            {
                "U2": {
                    "slack_user_token": "xoxp-user-two",
                    "plane_api_key": "plane-user-two",
                }
            }
        )
    )
    credentials_path.chmod(0o600)
    required_env["SPI_USER_CREDENTIALS_FILE"] = str(credentials_path)
    config = load_config(required_env)
    monkeypatch.setattr("slack_plane_intake.modal_cli.load_config", lambda: config)

    slack = AsyncMock()
    slack.fetch_shortcut_history_payloads.return_value = (
        {
            "ts": "1724440000.000001",
            "user": "U2",
            "username": "Second User",
            "text": "personal request",
            "files": [],
        },
    )
    received_slack_configs = []

    def slack_factory(slack_config, *_args, **_kwargs):
        received_slack_configs.append(slack_config)
        return slack

    monkeypatch.setattr("slack_plane_intake.modal_cli.SlackClient", slack_factory)
    added = await process_request(
        add_request("1724440000.000001", "personal request", user_id="U2")
    )

    service = AsyncMock()
    service.create_from_slack_shortcut_messages.return_value = IntakeResult(
        status="created", issue_key="AGENTE-8"
    )
    received_service_configs = []
    result = await process_request(
        {
            "action": "submit",
            "draft_id": added["draft_id"],
            "team_id": "T1",
            "user_id": "U2",
            "channel_id": "D1",
            "project_id": "project-uuid",
            "selected_message_ts": ["1724440000.000001"],
        },
        service_factory=lambda scoped: (
            received_service_configs.append(scoped) or service
        ),
    )

    assert result["issue_key"] == "AGENTE-8"
    assert received_slack_configs[0].history_user_id == "U2"
    assert received_slack_configs[0].history_user_token == "xoxp-user-two"
    assert received_service_configs[0].plane.api_key == "plane-user-two"
    assert received_service_configs[0].plane.project_identifier == "AGENTE"
    assert received_service_configs[0].slack.history_user_token == "xoxp-user-two"
    assert [item.api_key for item in project_client_stub.configs] == [
        "plane-user-two",
        "plane-user-two",
    ]
