from __future__ import annotations

import httpx
import pytest

from plane_codex_worker.codex_client import CodexControlClient


@pytest.mark.asyncio
async def test_creates_read_only_persistent_thread_and_waits_for_result(config):
    requests: list[httpx.Request] = []
    reads = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal reads
        requests.append(request)
        if request.method == "POST":
            return httpx.Response(
                201,
                json={
                    "thread": {"id": "thread-1"},
                    "turn": {"id": "turn-1"},
                },
            )
        reads += 1
        status = "inProgress" if reads == 1 else "completed"
        return httpx.Response(
            200,
            json={
                "thread": {
                    "lastTurn": {"id": "turn-1", "status": status},
                    "lastAgentMessage": "Confirmed: fixed",
                }
            },
        )

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://codex-control"
    ) as client:
        control = CodexControlClient(config, client=client)
        run = await control.create_investigation("Investigate")
        result = await control.wait_for_result(run)

    request_payload = __import__("json").loads(requests[0].content)
    assert request_payload == {
        "preset": "default",
        "cwd": str(config.codex_cwd),
        "sandbox": "readOnly",
        "approvalPolicy": "never",
        "ephemeral": False,
        "prompt": "Investigate",
    }
    assert result.output == "Confirmed: fixed"
    assert result.status == "completed"
