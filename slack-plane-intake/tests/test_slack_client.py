from __future__ import annotations

import httpx
import pytest
import respx

from slack_plane_intake.config import SlackConfig
from slack_plane_intake.errors import SourceValidationError
from slack_plane_intake.slack_client import SlackClient


def slack_client(tmp_path, limits):
    http = httpx.AsyncClient(base_url="https://slack.com/api/")
    return SlackClient(
        SlackConfig("xoxb-secret", "CINTAKE", frozenset({"U1"})),
        limits,
        tmp_path,
        client=http,
    )


def mock_common(message):
    respx.get("https://slack.com/api/auth.test").mock(
        return_value=httpx.Response(
            200, json={"ok": True, "team_id": "T1", "user_id": "UBOT"}
        )
    )
    respx.get("https://slack.com/api/conversations.history").mock(
        return_value=httpx.Response(200, json={"ok": True, "messages": [message]})
    )


@respx.mock
@pytest.mark.asyncio
async def test_fetches_exact_authorized_message_and_original_file(tmp_path, limits):
    ts = "1724440000.123456"
    mock_common(
        {
            "ts": ts,
            "user": "U1",
            "text": "<@UBOT> problema no login",
            "files": [{"id": "F1"}],
        }
    )
    respx.get("https://slack.com/api/chat.getPermalink").mock(
        return_value=httpx.Response(
            200, json={"ok": True, "permalink": "https://slack.test/p1"}
        )
    )
    respx.get("https://slack.com/api/users.info").mock(
        return_value=httpx.Response(
            200,
            json={"ok": True, "user": {"profile": {"display_name": "Alice"}}},
        )
    )
    respx.get("https://slack.com/api/files.info").mock(
        return_value=httpx.Response(
            200,
            json={
                "ok": True,
                "file": {
                    "id": "F1",
                    "name": "screen.png",
                    "mimetype": "image/png",
                    "size": 8,
                    "url_private_download": "https://files.slack.com/files-pri/F1",
                    "permalink": "https://slack.test/files/F1",
                },
            },
        )
    )
    respx.get("https://files.slack.com/files-pri/F1").mock(
        return_value=httpx.Response(200, content=b"original")
    )

    client = slack_client(tmp_path, limits)
    message = await client.fetch_source_message(ts)
    await client.close()

    assert message.source_key == f"slack:T1:CINTAKE:{ts}"
    assert message.author_name == "Alice"
    assert len(message.attachments) == 1
    attachment = message.attachments[0]
    assert attachment.local_path.read_bytes() == b"original"
    assert attachment.sha256


@respx.mock
@pytest.mark.asyncio
async def test_rejects_thread_reply_before_plane_work(tmp_path, limits):
    ts = "1724440000.123456"
    mock_common(
        {
            "ts": ts,
            "thread_ts": "1724439999.000001",
            "user": "U1",
            "text": "<@UBOT> create",
        }
    )
    client = slack_client(tmp_path, limits)
    with pytest.raises(SourceValidationError, match="Thread replies"):
        await client.fetch_source_message(ts)
    await client.close()


@respx.mock
@pytest.mark.asyncio
async def test_rejects_message_without_bot_mention(tmp_path, limits):
    ts = "1724440000.123456"
    mock_common({"ts": ts, "user": "U1", "text": "problem without mention"})
    client = slack_client(tmp_path, limits)
    with pytest.raises(SourceValidationError, match="does not mention"):
        await client.fetch_source_message(ts)
    await client.close()
