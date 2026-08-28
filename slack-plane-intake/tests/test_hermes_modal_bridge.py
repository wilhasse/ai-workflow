from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path
from unittest.mock import AsyncMock

import pytest


@pytest.fixture
def bridge(monkeypatch):
    package = types.ModuleType("hermes_bridge")
    package.__path__ = [str(Path(__file__).resolve().parents[1] / "hermes_bridge")]
    monkeypatch.setitem(sys.modules, "hermes_bridge", package)
    shortcut = types.ModuleType("hermes_bridge.problem_intake_shortcut")
    shortcut.CALLBACK_ID = "create_agente_ticket"
    shortcut._allowed_users = lambda: {"U1"}
    shortcut._format_result = lambda result: str(result.get("status"))
    shortcut._identity = lambda body, name: str((body.get(name) or {}).get("id") or "")
    shortcut._response_data = lambda response: (
        response if isinstance(response, dict) else response.data
    )
    shortcut._send_private_response = AsyncMock(return_value=True)
    shortcut._shortcut_python = lambda: None
    shortcut._timeout_seconds = lambda: 30.0
    monkeypatch.setitem(sys.modules, "hermes_bridge.problem_intake_shortcut", shortcut)
    sys.modules.pop("hermes_bridge.problem_intake_modal", None)
    return importlib.import_module("hermes_bridge.problem_intake_modal")


def ready_result() -> dict:
    return {
        "status": "ready",
        "draft_id": "draft1",
        "team_id": "T1",
        "user_id": "U1",
        "channel_id": "D1",
        "initial_message_ts": "1724440001.000001",
        "initial_project_id": "P-DELTA",
        "projects": [
            {"id": "P-AGENTE", "label": "AGENTE"},
            {"id": "P-DELTA", "label": "DELTA"},
            {"id": "P-OLOS", "label": "OLOS"},
        ],
        "messages": [
            {"message_ts": "1724440000.000001", "label": "1. first"},
            {"message_ts": "1724440001.000001", "label": "2. second"},
        ],
    }


def submission_body(
    bridge, selected: list[str], *, project_id: str = "P-AGENTE"
) -> dict:
    view = bridge._ready_view(ready_result())
    view["state"] = {
        "values": {
            "project": {"selected_project": {"selected_option": {"value": project_id}}},
            "messages": {
                "selected_messages": {
                    "selected_options": [{"value": value} for value in selected]
                }
            },
        }
    }
    return {"team": {"id": "T1"}, "user": {"id": "U1"}, "view": view}


def test_collector_modal_selects_all_and_metadata_contains_no_message_text(bridge):
    view = bridge._ready_view(ready_result())
    message_element = view["blocks"][2]["element"]
    project_element = view["blocks"][1]["element"]

    assert view["callback_id"] == "create_agente_ticket_modal"
    assert view["title"]["text"] == "Ticket Plane"
    assert message_element["type"] == "multi_static_select"
    assert message_element["max_selected_items"] == 20
    assert message_element["initial_options"] == message_element["options"]
    assert project_element["type"] == "static_select"
    assert project_element["initial_option"]["value"] == "P-DELTA"
    assert [option["value"] for option in project_element["options"]] == [
        "P-AGENTE",
        "P-DELTA",
        "P-OLOS",
    ]
    assert "first" not in view["private_metadata"]
    assert "second" not in view["private_metadata"]
    assert "P-OLOS" not in view["private_metadata"]


def test_history_picker_modal_selects_all_nearby_messages(bridge):
    result = ready_result()
    result["mode"] = "history"

    view = bridge._ready_view(result)

    assert view["close"]["text"] == "Cancelar"
    assert "janela de 30 minutos" in view["blocks"][0]["text"]["text"]
    element = view["blocks"][2]["element"]
    assert [option["value"] for option in element["initial_options"]] == [
        "1724440000.000001",
        "1724440001.000001",
    ]
    assert "Todas começam marcadas" in view["blocks"][0]["text"]["text"]


def test_modal_offers_and_preselects_twenty_messages(bridge):
    result = ready_result()
    result["mode"] = "history"
    result["initial_message_ts"] = "1724440010.000001"
    result["messages"] = [
        {
            "message_ts": f"17244400{index:02d}.000001",
            "label": f"{index + 1}. message",
        }
        for index in range(20)
    ]

    view = bridge._ready_view(result)
    element = view["blocks"][2]["element"]

    assert len(element["options"]) == 20
    assert element["initial_options"] == element["options"]


def test_modal_rejects_more_than_twenty_messages(bridge):
    result = ready_result()
    result["messages"] = [
        {
            "message_ts": f"17244400{index:02d}.000001",
            "label": f"{index + 1}. message",
        }
        for index in range(21)
    ]

    with pytest.raises(ValueError, match="messages"):
        bridge._ready_view(result)


def test_history_picker_rejects_a_missing_anchor(bridge):
    result = ready_result()
    result["mode"] = "history"
    result["initial_message_ts"] = "1724440999.000001"

    with pytest.raises(ValueError, match="anchor"):
        bridge._ready_view(result)


def test_submission_rejects_empty_or_forged_selection(bridge):
    request, error, error_block = bridge._submission_request(
        submission_body(bridge, [])
    )
    assert not request
    assert "pelo menos" in error
    assert error_block == "messages"

    request, error, error_block = bridge._submission_request(
        submission_body(bridge, ["1724440999.000001"])
    )
    assert not request
    assert "não corresponde" in error
    assert error_block == "messages"


def test_submission_includes_selected_project(bridge):
    request, error, error_block = bridge._submission_request(
        submission_body(bridge, ["1724440000.000001"], project_id="P-OLOS")
    )

    assert not error
    assert not error_block
    assert request["project_id"] == "P-OLOS"


def test_submission_rejects_missing_project(bridge):
    body = submission_body(bridge, ["1724440000.000001"])
    del body["view"]["state"]["values"]["project"]

    request, error, error_block = bridge._submission_request(body)

    assert not request
    assert "projeto" in error
    assert error_block == "project"


@pytest.mark.asyncio
async def test_shortcut_opens_loading_modal_before_running_draft_process(
    bridge, monkeypatch
):
    events = []
    client = AsyncMock()

    async def views_open(**_kwargs):
        events.append("open")
        return {"view": {"id": "V1", "hash": "H1"}}

    async def run_modal(_request):
        events.append("process")
        return ready_result()

    client.views_open.side_effect = views_open
    adapter = types.SimpleNamespace(_get_client=lambda *_args, **_kwargs: client)
    monkeypatch.setattr(bridge, "_run_modal", run_modal)
    body = {
        "trigger_id": "trigger",
        "team": {"id": "T1"},
        "user": {"id": "U1"},
        "channel": {"id": "D1"},
        "message": {"ts": "1724440000.000001", "text": "first"},
    }

    await bridge.handle_message_shortcut(adapter, body)

    assert events == ["open", "process"]
    client.views_update.assert_awaited_once()


@pytest.mark.asyncio
async def test_submission_acknowledges_before_long_running_ticket_work(
    bridge, monkeypatch
):
    events = []

    async def ack(**_kwargs):
        events.append("ack")

    async def run_modal(_request):
        events.append("process")
        return {"status": "created", "issue_key": "AGENTE-1"}

    monkeypatch.setattr(bridge, "_run_modal", run_modal)
    await bridge.handle_modal_submission(
        ack,
        types.SimpleNamespace(),
        submission_body(bridge, ["1724440000.000001"]),
    )

    assert events == ["ack", "process"]
