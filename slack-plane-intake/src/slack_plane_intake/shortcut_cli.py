"""Private stdin bridge for Hermes' Slack message-shortcut callback."""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .config import load_config
from .errors import ConfigurationError
from .mcp_server import build_service
from .models import IntakeResult

CALLBACK_ID = "create_agente_ticket"
_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024


class _SlackObject(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)

    id: str = Field(min_length=1)


class _SlackMessage(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)

    ts: str = Field(min_length=1)
    text: str = ""
    user: str = ""
    bot_id: str = ""
    username: str = ""
    subtype: str = ""
    bot_profile: dict[str, Any] | None = None
    files: tuple[dict[str, Any], ...] | None = None
    attachments: tuple[dict[str, Any], ...] | None = None
    blocks: tuple[dict[str, Any], ...] | None = None


class SlackMessageShortcut(BaseModel):
    """Only the transport fields accepted from Slack Bolt's shortcut body."""

    model_config = ConfigDict(extra="ignore", frozen=True)

    type: Literal["message_action"]
    callback_id: Literal["create_agente_ticket"]
    team: _SlackObject
    user: _SlackObject
    channel: _SlackObject
    message: _SlackMessage


def failed_result(message: str) -> IntakeResult:
    return IntakeResult(status="failed", warnings=(message,))


async def process_shortcut(
    body: dict[str, Any], *, service_factory=build_service
) -> IntakeResult:
    try:
        shortcut = SlackMessageShortcut.model_validate(body)
    except ValidationError:
        return failed_result("Invalid Slack message shortcut payload")

    try:
        config = load_config()
    except ConfigurationError as exc:
        return failed_result(str(exc))

    service = service_factory(config)
    try:
        return await service.create_from_slack_shortcut(
            team_id=shortcut.team.id,
            channel_id=shortcut.channel.id,
            invoking_user_id=shortcut.user.id,
            message_payload=shortcut.message.model_dump(mode="python"),
        )
    finally:
        await service.close()


def _read_body() -> tuple[dict[str, Any] | None, IntakeResult | None]:
    raw = sys.stdin.buffer.read(_MAX_PAYLOAD_BYTES + 1)
    if len(raw) > _MAX_PAYLOAD_BYTES:
        return None, failed_result("Slack message shortcut payload is too large")
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None, failed_result("Slack message shortcut payload is not valid JSON")
    if not isinstance(value, dict):
        return None, failed_result("Slack message shortcut payload must be an object")
    return value, None


def main() -> int:
    body, error = _read_body()
    if error is not None:
        result = error
        exit_code = 2
    else:
        try:
            result = asyncio.run(process_shortcut(body or {}))
            exit_code = 0
        except Exception:  # noqa: BLE001 - keep integration failures secret-free
            # Keep exception details out of Slack and stdout; the gateway logs
            # only the subprocess return code and stderr byte count.
            result = failed_result("Unexpected problem-intake failure")
            exit_code = 1
    print(json.dumps(result.model_dump(mode="json"), ensure_ascii=False))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
