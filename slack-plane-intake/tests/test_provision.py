from __future__ import annotations

import json

import httpx
import respx

from slack_plane_intake.provision import ensure_plane_project


@respx.mock
def test_creates_project_and_discovers_backlog_state():
    projects = "https://plane.test/api/v1/workspaces/ws/projects/"
    respx.get(projects).mock(return_value=httpx.Response(200, json={"results": []}))
    created = respx.post(projects).mock(
        return_value=httpx.Response(201, json={"id": "P1", "identifier": "AGENTE"})
    )
    respx.get(f"{projects}P1/states/").mock(
        return_value=httpx.Response(
            200,
            json={"results": [{"id": "S1", "name": "Backlog", "group": "backlog"}]},
        )
    )
    result = ensure_plane_project(
        base_url="https://plane.test",
        api_key="secret",
        workspace="ws",
    )
    assert result == {
        "project_id": "P1",
        "project_identifier": "AGENTE",
        "state_id": "S1",
        "created": "true",
    }
    assert created.called
    payload = json.loads(created.calls[0].request.content)
    assert payload["name"] == "AGENTE"
    assert payload["identifier"] == "AGENTE"


@respx.mock
def test_reuses_existing_project():
    projects = "https://plane.test/api/v1/workspaces/ws/projects/"
    respx.get(projects).mock(
        return_value=httpx.Response(200, json=[{"id": "P9", "identifier": "AGENTE"}])
    )
    create = respx.post(projects).mock(return_value=httpx.Response(500))
    respx.get(f"{projects}P9/states/").mock(
        return_value=httpx.Response(200, json=[{"id": "S9", "name": "Backlog"}])
    )
    result = ensure_plane_project(
        base_url="https://plane.test",
        api_key="secret",
        workspace="ws",
    )
    assert result["project_id"] == "P9"
    assert result["created"] == "false"
    assert not create.called
