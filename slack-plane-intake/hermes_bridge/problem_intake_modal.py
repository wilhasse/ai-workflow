"""Slack-native multi-message modal bridge for CSLOG's Plane intake."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

from .problem_intake_shortcut import CALLBACK_ID as _SHORTCUT_CALLBACK_ID
from .problem_intake_shortcut import (
    _allowed_users,
    _format_result,
    _identity,
    _response_data,
    _send_private_response,
    _shortcut_python,
    _timeout_seconds,
)

logger = logging.getLogger(__name__)

CALLBACK_ID = _SHORTCUT_CALLBACK_ID
MODAL_CALLBACK_ID = "create_agente_ticket_modal"
_MESSAGES_BLOCK_ID = "messages"
_MESSAGES_ACTION_ID = "selected_messages"
_PROJECT_BLOCK_ID = "project"
_PROJECT_ACTION_ID = "selected_project"
_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024
_MAX_OUTPUT_BYTES = 1024 * 1024


def _plain_text(value: str) -> dict[str, str]:
    return {"type": "plain_text", "text": value, "emoji": True}


def _loading_view() -> dict[str, Any]:
    return {
        "type": "modal",
        "callback_id": MODAL_CALLBACK_ID,
        "title": _plain_text("Ticket Plane"),
        "close": _plain_text("Fechar"),
        "blocks": [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": ":hourglass_flowing_sand: Adicionando mensagem ao rascunho…",
                },
            }
        ],
    }


def _error_view(message: str) -> dict[str, Any]:
    clean = " ".join(message.split())[:500]
    return {
        "type": "modal",
        "callback_id": MODAL_CALLBACK_ID,
        "title": _plain_text("Ticket Plane"),
        "close": _plain_text("Fechar"),
        "blocks": [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": f":x: {clean or 'Não foi possível abrir o rascunho.'}",
                },
            }
        ],
    }


def _ready_view(result: dict[str, Any]) -> dict[str, Any]:
    messages = result.get("messages")
    if not isinstance(messages, list) or not messages:
        raise ValueError("modal draft has no messages")

    projects = result.get("projects")
    if not isinstance(projects, list) or not 1 <= len(projects) <= 100:
        raise ValueError("modal has no valid Plane projects")
    project_options = []
    for project in projects:
        if not isinstance(project, dict):
            raise TypeError("invalid Plane project option")
        project_id = str(project.get("id") or "")
        label = " ".join(str(project.get("label") or "Projeto").split())[:75]
        if not project_id or not label:
            raise ValueError("invalid Plane project option")
        project_options.append({"text": _plain_text(label), "value": project_id})
    initial_project_id = str(result.get("initial_project_id") or "")
    initial_projects = [
        option for option in project_options if option["value"] == initial_project_id
    ]
    if len(initial_projects) != 1:
        raise ValueError("initial Plane project is missing from the modal")

    options = []
    offered = []
    for message in messages[:10]:
        if not isinstance(message, dict):
            raise TypeError("invalid modal draft message")
        message_ts = str(message.get("message_ts") or "")
        label = " ".join(str(message.get("label") or "Mensagem").split())[:75]
        if not message_ts or not label:
            raise ValueError("invalid modal draft option")
        option = {"text": _plain_text(label), "value": message_ts}
        options.append(option)
        offered.append(message_ts)

    metadata = json.dumps(
        {
            "draft_id": result.get("draft_id"),
            "team_id": result.get("team_id"),
            "user_id": result.get("user_id"),
            "channel_id": result.get("channel_id"),
            "offered_message_ts": offered,
        },
        separators=(",", ":"),
    )
    if len(metadata.encode("utf-8")) > 3000:
        raise ValueError("modal metadata is too large")
    count = len(options)
    history_mode = result.get("mode") == "history"
    if history_mode:
        initial_message_ts = str(result.get("initial_message_ts") or "")
        if not any(option["value"] == initial_message_ts for option in options):
            raise ValueError("history modal anchor is missing from the draft")
        initial_options = options
        instructions = (
            f"*{count} mensagem(ns) próximas, em uma janela de 15 minutos.*\n"
            "Todas começam marcadas. Desmarque apenas as mensagens que não "
            "pertencem ao mesmo pedido."
        )
        close_text = "Cancelar"
    else:
        initial_options = options
        instructions = (
            f"*{count} mensagem(ns) no rascunho.*\n"
            "Feche para adicionar outras com o mesmo atalho, ou "
            "selecione abaixo e crie um único ticket."
        )
        close_text = "Continuar depois"
    return {
        "type": "modal",
        "callback_id": MODAL_CALLBACK_ID,
        "private_metadata": metadata,
        "title": _plain_text("Ticket Plane"),
        "submit": _plain_text("Criar ticket"),
        "close": _plain_text(close_text),
        "blocks": [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": instructions,
                },
            },
            {
                "type": "input",
                "block_id": _PROJECT_BLOCK_ID,
                "label": _plain_text("Projeto Plane"),
                "element": {
                    "type": "static_select",
                    "action_id": _PROJECT_ACTION_ID,
                    "placeholder": _plain_text("Selecione o projeto"),
                    "options": project_options,
                    "initial_option": initial_projects[0],
                },
            },
            {
                "type": "input",
                "block_id": _MESSAGES_BLOCK_ID,
                "label": _plain_text("Mensagens do ticket"),
                "element": {
                    "type": "checkboxes",
                    "action_id": _MESSAGES_ACTION_ID,
                    "options": options,
                    "initial_options": initial_options,
                },
            },
        ],
    }


def _warning(result: dict[str, Any]) -> str:
    warnings = result.get("warnings")
    if isinstance(warnings, list) and warnings:
        return " ".join(str(warnings[0]).split())[:500]
    return "Não foi possível preparar o rascunho."


async def _run_modal(request: dict[str, Any]) -> dict[str, Any]:
    python = _shortcut_python()
    if (
        not python.is_absolute()
        or not python.is_file()
        or not os.access(python, os.X_OK)
    ):
        return {
            "status": "failed",
            "warnings": ["Problem-intake modal runtime is unavailable"],
        }

    raw = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode()
    if len(raw) > _MAX_PAYLOAD_BYTES:
        return {
            "status": "failed",
            "warnings": ["Slack modal payload is too large"],
        }
    process = await asyncio.create_subprocess_exec(
        str(python),
        "-m",
        "slack_plane_intake.modal_cli",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(raw), timeout=_timeout_seconds()
        )
    except TimeoutError:
        process.kill()
        await process.wait()
        return {"status": "failed", "warnings": ["Problem-intake modal timed out"]}
    if process.returncode:
        logger.error(
            "[Slack] Problem-intake modal subprocess exited %s (stderr_bytes=%d)",
            process.returncode,
            len(stderr),
        )
    if len(stdout) > _MAX_OUTPUT_BYTES:
        return {
            "status": "failed",
            "warnings": ["Problem-intake modal returned too much data"],
        }
    try:
        result = json.loads(stdout)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {
            "status": "failed",
            "warnings": ["Problem-intake modal returned an invalid result"],
        }
    if not isinstance(result, dict):
        return {
            "status": "failed",
            "warnings": ["Problem-intake modal returned an invalid result"],
        }
    return result


async def handle_message_shortcut(adapter: Any, body: dict[str, Any]) -> None:
    """Open a modal, then durably add the selected Slack message."""
    user_id = _identity(body, "user")
    if not user_id or user_id not in _allowed_users():
        await _send_private_response(
            adapter,
            body,
            ":no_entry: Você não está autorizado a criar tickets por este atalho.",
        )
        logger.warning("[Slack] Rejected unauthorized problem-intake shortcut")
        return

    trigger_id = str(body.get("trigger_id") or "")
    team_id = _identity(body, "team")
    channel_id = _identity(body, "channel")
    if not trigger_id or not team_id or not channel_id:
        await _send_private_response(
            adapter, body, ":x: O Slack não enviou os dados necessários ao modal."
        )
        return
    try:
        client = adapter._get_client(channel_id, team_id=team_id)
        opened = await client.views_open(trigger_id=trigger_id, view=_loading_view())
        opened_view = _response_data(opened).get("view") or {}
        view_id = str(opened_view.get("id") or "")
        view_hash = str(opened_view.get("hash") or "")
        if not view_id:
            raise RuntimeError("Slack did not return a modal view ID")

        result = await _run_modal({"action": "add", "shortcut": body})
        if result.get("status") == "ready":
            updated_view = _ready_view(result)
        else:
            updated_view = _error_view(_warning(result))
        update_args: dict[str, Any] = {"view_id": view_id, "view": updated_view}
        if view_hash:
            update_args["hash"] = view_hash
        await client.views_update(**update_args)
    except Exception as exc:
        logger.exception(
            "[Slack] Problem-intake modal open failed: %s",
            type(exc).__name__,
        )
        await _send_private_response(
            adapter, body, ":x: Não foi possível abrir o rascunho do ticket."
        )


def _submission_request(
    body: dict[str, Any],
) -> tuple[dict[str, Any], str, str]:
    user_id = _identity(body, "user")
    team_id = _identity(body, "team")
    view = body.get("view") or {}
    if not isinstance(view, dict):
        return {}, "Modal inválido; abra o atalho novamente.", _MESSAGES_BLOCK_ID
    try:
        metadata = json.loads(str(view.get("private_metadata") or ""))
    except json.JSONDecodeError:
        return {}, "Rascunho inválido; abra o atalho novamente.", _MESSAGES_BLOCK_ID
    if not isinstance(metadata, dict):
        return {}, "Rascunho inválido; abra o atalho novamente.", _MESSAGES_BLOCK_ID
    if user_id not in _allowed_users() or user_id != str(metadata.get("user_id") or ""):
        return (
            {},
            "Você não está autorizado a enviar este rascunho.",
            _MESSAGES_BLOCK_ID,
        )
    if team_id != str(metadata.get("team_id") or ""):
        return (
            {},
            "O workspace do rascunho não corresponde ao Slack atual.",
            _MESSAGES_BLOCK_ID,
        )

    state = view.get("state") or {}
    if not isinstance(state, dict):
        return {}, "A seleção do modal é inválida.", _MESSAGES_BLOCK_ID
    values = state.get("values") or {}
    if not isinstance(values, dict):
        return {}, "A seleção do modal é inválida.", _MESSAGES_BLOCK_ID
    project_block = values.get(_PROJECT_BLOCK_ID) or {}
    if not isinstance(project_block, dict):
        return {}, "A seleção de projeto é inválida.", _PROJECT_BLOCK_ID
    project_action = project_block.get(_PROJECT_ACTION_ID) or {}
    if not isinstance(project_action, dict):
        return {}, "A seleção de projeto é inválida.", _PROJECT_BLOCK_ID
    selected_project = project_action.get("selected_option") or {}
    if not isinstance(selected_project, dict):
        return {}, "Selecione um projeto Plane.", _PROJECT_BLOCK_ID
    project_id = str(selected_project.get("value") or "")
    if not project_id:
        return {}, "Selecione um projeto Plane.", _PROJECT_BLOCK_ID
    block = values.get(_MESSAGES_BLOCK_ID) or {}
    if not isinstance(block, dict):
        return {}, "A seleção do modal é inválida.", _MESSAGES_BLOCK_ID
    action = block.get(_MESSAGES_ACTION_ID) or {}
    if not isinstance(action, dict):
        return {}, "A seleção do modal é inválida.", _MESSAGES_BLOCK_ID
    selected_options = action.get("selected_options") or ()
    selected = tuple(
        str(option.get("value") or "")
        for option in selected_options
        if isinstance(option, dict) and option.get("value")
    )
    offered = tuple(str(value) for value in metadata.get("offered_message_ts") or ())
    if not selected:
        return {}, "Selecione pelo menos uma mensagem.", _MESSAGES_BLOCK_ID
    if len(set(selected)) != len(selected) or any(
        value not in offered for value in selected
    ):
        return (
            {},
            "A seleção não corresponde a este rascunho.",
            _MESSAGES_BLOCK_ID,
        )
    return (
        {
            "action": "submit",
            "draft_id": str(metadata.get("draft_id") or ""),
            "team_id": team_id,
            "user_id": user_id,
            "channel_id": str(metadata.get("channel_id") or ""),
            "project_id": project_id,
            "selected_message_ts": list(selected),
        },
        "",
        "",
    )


async def handle_modal_submission(ack: Any, adapter: Any, body: dict[str, Any]) -> None:
    """Validate locally, acknowledge immediately, then create one Plane ticket."""
    request, error, error_block = _submission_request(body)
    if error:
        await ack(
            response_action="errors",
            errors={error_block: error},
        )
        return
    await ack()

    response_body = dict(body)
    response_body["channel"] = {"id": request["channel_id"]}
    await _send_private_response(
        adapter,
        response_body,
        ":hourglass_flowing_sand: Criando um ticket no Plane…",
    )
    try:
        result = await _run_modal(request)
    except Exception as exc:
        logger.exception(
            "[Slack] Problem-intake modal submission failed: %s",
            type(exc).__name__,
        )
        result = {
            "status": "failed",
            "warnings": ["Unexpected problem-intake modal failure"],
        }
    delivered = await _send_private_response(
        adapter, response_body, _format_result(result)
    )
    if not delivered:
        logger.error("[Slack] Problem-intake modal result could not be delivered")
