from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from slack_plane_intake.models import IntakeResult
from slack_plane_intake.shortcut_cli import process_shortcut


def shortcut_body() -> dict:
    return {
        "type": "message_action",
        "callback_id": "create_agente_ticket",
        "team": {"id": "T1", "domain": "example"},
        "user": {"id": "U1", "name": "alice"},
        "channel": {"id": "CALERTS", "name": "alerts"},
        "message": {
            "ts": "1724440000.123456",
            "bot_id": "BALERT",
            "username": "Monitor",
            "text": "database unavailable",
        },
        "response_url": "https://hooks.slack.com/actions/redacted",
    }


@pytest.mark.asyncio
async def test_valid_shortcut_calls_service_with_transport_identifiers(monkeypatch):
    service = AsyncMock()
    service.create_from_slack_shortcut.return_value = IntakeResult(
        status="created",
        issue_key="AGENTE-1",
        issue_url="https://plane.test/cslog/browse/AGENTE-1",
    )
    monkeypatch.setattr("slack_plane_intake.shortcut_cli.load_config", lambda: object())

    result = await process_shortcut(
        shortcut_body(), service_factory=lambda _config: service
    )

    assert result.issue_key == "AGENTE-1"
    service.create_from_slack_shortcut.assert_awaited_once()
    call = service.create_from_slack_shortcut.await_args.kwargs
    assert call["team_id"] == "T1"
    assert call["channel_id"] == "CALERTS"
    assert call["invoking_user_id"] == "U1"
    assert call["message_payload"]["bot_id"] == "BALERT"
    service.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_wrong_callback_is_rejected_before_service_creation():
    body = shortcut_body()
    body["callback_id"] = "other_action"
    service_factory = AsyncMock()

    result = await process_shortcut(body, service_factory=service_factory)

    assert result.status == "failed"
    assert result.warnings == ("Invalid Slack message shortcut payload",)
    service_factory.assert_not_called()
