"""Private stdin bridge for durable Slack modal ticket drafts."""

from __future__ import annotations

import asyncio
import json
import sys
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

from pydantic import ValidationError

from .config import load_config
from .drafts import DraftSnapshot, DraftStore
from .errors import (
    ConfigurationError,
    ExternalServiceError,
    IntakeError,
    SourceValidationError,
)
from .mcp_server import build_service
from .models import PlaneProject
from .plane_client import PlaneClient
from .shortcut_models import (
    ModalAddRequest,
    ModalSubmitRequest,
    SlackMessage,
    sanitized_message_payload,
)
from .slack_client import SlackClient, is_im_channel

_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024
_MAX_PROJECT_OPTIONS = 100
_DEFAULT_PROJECT_IDENTIFIER = "DELTA"
_DISPLAY_TIMEZONE = ZoneInfo("America/Sao_Paulo")


def _failed(message: str) -> dict[str, Any]:
    return {"status": "failed", "warnings": [message]}


def _preview_label(index: int, payload: dict[str, Any]) -> str:
    text = " ".join(str(payload.get("text") or "").split())
    if not text:
        file_count = len(payload.get("files") or ())
        text = f"{file_count} anexo(s)" if file_count else "Mensagem"

    bot_profile = payload.get("bot_profile")
    if not isinstance(bot_profile, dict):
        bot_profile = {}
    author = " ".join(
        str(
            payload.get("username")
            or bot_profile.get("name")
            or payload.get("user")
            or payload.get("bot_id")
            or "Autor desconhecido"
        ).split()
    )
    try:
        posted_at = datetime.fromtimestamp(float(str(payload["ts"])), tz=UTC)
        local_time = posted_at.astimezone(_DISPLAY_TIMEZONE).strftime("%d/%m %H:%M")
    except (KeyError, TypeError, ValueError, OverflowError):
        local_time = f"Mensagem {index}"
    return f"{local_time} · {author} · {text}"[:75]


def _preview(
    snapshot: DraftSnapshot,
    *,
    mode: str,
    initial_message_ts: str,
    projects: tuple[PlaneProject, ...],
    initial_project_id: str,
) -> dict[str, Any]:
    if not projects:
        raise ExternalServiceError(
            "No writable Plane project is available to this user"
        )
    if len(projects) > _MAX_PROJECT_OPTIONS:
        raise ExternalServiceError(
            "Plane returned too many projects for the Slack project selector"
        )
    default_project = next(
        (
            project
            for project in projects
            if project.identifier.casefold() == _DEFAULT_PROJECT_IDENTIFIER.casefold()
        ),
        None,
    )
    if default_project is not None:
        initial_project_id = default_project.id
    elif initial_project_id not in {project.id for project in projects}:
        initial_project_id = projects[0].id
    messages = []
    for index, draft_message in enumerate(snapshot.messages, start=1):
        payload = draft_message.payload
        messages.append(
            {
                "message_ts": draft_message.message_ts,
                "label": _preview_label(index, payload),
            }
        )
    return {
        "status": "ready",
        "draft_id": snapshot.draft_id,
        "team_id": snapshot.team_id,
        "user_id": snapshot.user_id,
        "channel_id": snapshot.channel_id,
        "mode": mode,
        "initial_message_ts": initial_message_ts,
        "initial_project_id": initial_project_id,
        "projects": [
            {
                "id": project.id,
                "label": (
                    project.identifier
                    if project.identifier.casefold() == project.name.casefold()
                    else f"{project.identifier} — {project.name}"
                )[:75],
            }
            for project in projects
        ],
        "messages": messages,
    }


async def _list_projects(config, plane_client_factory) -> tuple[PlaneProject, ...]:
    plane = plane_client_factory(config.plane)
    try:
        return await plane.list_projects()
    finally:
        await plane.close()


async def _select_project(config, project_id: str, plane_client_factory):
    plane = plane_client_factory(config.plane)
    try:
        plane_config = await plane.resolve_project_config(project_id)
    finally:
        await plane.close()
    return replace(config, plane=plane_config)


async def process_request(
    body: dict[str, Any], *, service_factory=build_service, plane_client_factory=None
) -> dict[str, Any]:
    try:
        config = load_config()
    except ConfigurationError as exc:
        return _failed(str(exc))

    store = DraftStore(config.state_db)
    project_factory = plane_client_factory or PlaneClient
    try:
        action = body.get("action")
        if action == "add":
            request = ModalAddRequest.model_validate(body)
            shortcut = request.shortcut
            if shortcut.user.id not in config.slack.shortcut_allowed_users:
                raise SourceValidationError(
                    "Slack user is not allowed to create problem tickets"
                )
            scoped_config = config.for_shortcut_user(shortcut.user.id)
            projects = await _list_projects(scoped_config, project_factory)
            if (not is_im_channel(shortcut.channel.id)) or (
                scoped_config.slack.history_user_token
                and shortcut.user.id == scoped_config.slack.history_user_id
            ):
                slack = SlackClient(
                    scoped_config.slack,
                    scoped_config.limits,
                    scoped_config.work_dir,
                )
                try:
                    history_payloads = await slack.fetch_shortcut_history_payloads(
                        team_id=shortcut.team.id,
                        channel_id=shortcut.channel.id,
                        invoking_user_id=shortcut.user.id,
                        selected_message_payload=shortcut.message.model_dump(
                            mode="python"
                        ),
                    )
                finally:
                    await slack.close()
                cleaned = tuple(
                    sanitized_message_payload(
                        SlackMessage.model_validate(message_payload)
                    )
                    for message_payload in history_payloads
                )
                snapshot = store.replace(
                    team_id=shortcut.team.id,
                    user_id=shortcut.user.id,
                    channel_id=shortcut.channel.id,
                    messages=tuple(
                        (str(message["ts"]), message) for message in cleaned
                    ),
                )
                return _preview(
                    snapshot,
                    mode="history",
                    initial_message_ts=shortcut.message.ts,
                    projects=projects,
                    initial_project_id=scoped_config.plane.project_id,
                )

            message_payload = sanitized_message_payload(shortcut.message)
            snapshot = store.add(
                team_id=shortcut.team.id,
                user_id=shortcut.user.id,
                channel_id=shortcut.channel.id,
                message_ts=shortcut.message.ts,
                payload=message_payload,
            )
            return _preview(
                snapshot,
                mode="collector",
                initial_message_ts=shortcut.message.ts,
                projects=projects,
                initial_project_id=scoped_config.plane.project_id,
            )

        if action == "submit":
            request = ModalSubmitRequest.model_validate(body)
            if request.user_id not in config.slack.shortcut_allowed_users:
                raise SourceValidationError(
                    "Slack user is not allowed to create problem tickets"
                )
            scoped_config = config.for_shortcut_user(request.user_id)
            scoped_config = await _select_project(
                scoped_config, request.project_id, project_factory
            )
            offered_snapshot = store.get(
                draft_id=request.draft_id,
                team_id=request.team_id,
                user_id=request.user_id,
                channel_id=request.channel_id,
            )
            snapshot = store.select(
                draft_id=request.draft_id,
                team_id=request.team_id,
                user_id=request.user_id,
                channel_id=request.channel_id,
                selected_message_ts=request.selected_message_ts,
            )
            submission_id = store.begin_submission_audit(
                snapshot=offered_snapshot,
                selected_message_ts=request.selected_message_ts,
            )
            try:
                service = service_factory(scoped_config)
                try:
                    result = await service.create_from_slack_shortcut_messages(
                        team_id=snapshot.team_id,
                        channel_id=snapshot.channel_id,
                        invoking_user_id=snapshot.user_id,
                        message_payloads=tuple(
                            message.payload for message in snapshot.messages
                        ),
                    )
                finally:
                    await service.close()
            except Exception:
                store.finish_submission_audit(submission_id, status="failed")
                raise
            store.finish_submission_audit(
                submission_id,
                status=result.status,
                issue_key=result.issue_key,
            )
            if result.status in {"created", "partial", "existing"}:
                store.clear(
                    draft_id=snapshot.draft_id,
                    team_id=snapshot.team_id,
                    user_id=snapshot.user_id,
                    channel_id=snapshot.channel_id,
                )
            return result.model_dump(mode="json")

        return _failed("Unsupported Slack modal action")
    except ValidationError:
        return _failed("Invalid Slack modal payload")
    except IntakeError as exc:
        return _failed(str(exc))


def _read_body() -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    raw = sys.stdin.buffer.read(_MAX_PAYLOAD_BYTES + 1)
    if len(raw) > _MAX_PAYLOAD_BYTES:
        return None, _failed("Slack modal payload is too large")
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None, _failed("Slack modal payload is not valid JSON")
    if not isinstance(value, dict):
        return None, _failed("Slack modal payload must be an object")
    return value, None


def main() -> int:
    body, error = _read_body()
    if error is not None:
        result = error
        exit_code = 2
    else:
        try:
            result = asyncio.run(process_request(body or {}))
            exit_code = 0
        except Exception:  # noqa: BLE001 - keep integration failures secret-free
            result = _failed("Unexpected Slack modal failure")
            exit_code = 1
    print(json.dumps(result, ensure_ascii=False))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
