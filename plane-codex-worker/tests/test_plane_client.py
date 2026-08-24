from __future__ import annotations

import httpx
import pytest

from plane_codex_worker.plane_client import PlaneClient


@pytest.mark.asyncio
async def test_provisions_missing_review_and_blocked_states(config):
    requests: list[tuple[str, str, dict | None]] = []
    states = [
        {"id": "backlog", "name": "Backlog", "group": "backlog"},
        {"id": "running", "name": "In Progress", "group": "started"},
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        payload = None
        if request.content:
            import json

            payload = json.loads(request.content)
        requests.append((request.method, request.url.path, payload))
        if request.method == "GET":
            return httpx.Response(200, json={"results": states})
        created = {
            "id": payload["name"].lower(),
            "name": payload["name"],
            "group": payload["group"],
        }
        states.append(created)
        return httpx.Response(201, json=created)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="https://plane.test"
    ) as client:
        resolved = await PlaneClient(config, client=client).ensure_automation_states()

    assert resolved.review.id == "review"
    assert resolved.blocked.id == "blocked"
    assert [item[2]["name"] for item in requests if item[0] == "POST"] == [
        "Review",
        "Blocked",
    ]


@pytest.mark.asyncio
async def test_lists_only_requested_state_and_fetches_full_issue(config):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/issues/"):
            return httpx.Response(
                200,
                json={
                    "results": [
                        {"id": "I1", "state": "backlog"},
                        {"id": "I2", "state": "review"},
                    ]
                },
            )
        return httpx.Response(
            200,
            json={
                "id": "I1",
                "sequence_id": 1,
                "name": "API failure",
                "description_html": "<p>HTTP 500</p>",
                "state": "backlog",
                "updated_at": "now",
            },
        )

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="https://plane.test"
    ) as client:
        issues = await PlaneClient(config, client=client).list_issues_in_state(
            "backlog", limit=3
        )

    assert issues[0].name == "API failure"
    assert len(issues) == 1
