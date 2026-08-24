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
        SlackConfig("xoxb-secret", "DINTAKE", frozenset({"U1"})),
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
    respx.post("https://slack.com/api/conversations.open").mock(
        return_value=httpx.Response(
            200,
            json={"ok": True, "channel": {"id": "DINTAKE"}},
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
            "text": "problema no login",
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

    assert message.source_key == f"slack:T1:DINTAKE:{ts}"
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
            "text": "create",
        }
    )
    client = slack_client(tmp_path, limits)
    with pytest.raises(SourceValidationError, match="Thread replies"):
        await client.fetch_source_message(ts)
    await client.close()


@respx.mock
@pytest.mark.asyncio
async def test_accepts_dm_without_bot_mention(tmp_path, limits):
    ts = "1724440000.123456"
    mock_common({"ts": ts, "user": "U1", "text": "problem without mention"})
    respx.get("https://slack.com/api/chat.getPermalink").mock(
        return_value=httpx.Response(
            200, json={"ok": True, "permalink": "https://slack.test/p2"}
        )
    )
    respx.get("https://slack.com/api/users.info").mock(
        return_value=httpx.Response(200, json={"ok": True, "user": {}})
    )
    client = slack_client(tmp_path, limits)
    message = await client.fetch_source_message(ts)
    assert message.text == "problem without mention"
    await client.close()


@respx.mock
@pytest.mark.asyncio
async def test_rejects_non_matching_configured_conversation(tmp_path, limits):
    ts = "1724440000.123456"
    mock_common({"ts": ts, "user": "U1", "text": "problem"})
    respx.post("https://slack.com/api/conversations.open").mock(
        return_value=httpx.Response(200, json={"ok": True, "channel": {"id": "DOTHER"}})
    )
    client = slack_client(tmp_path, limits)
    with pytest.raises(SourceValidationError, match="does not match"):
        await client.fetch_source_message(ts)
    await client.close()


@respx.mock
@pytest.mark.asyncio
async def test_message_shortcut_authorizes_invoker_and_accepts_bot_alert(
    tmp_path, limits
):
    ts = "1724440000.123456"
    respx.get("https://slack.com/api/auth.test").mock(
        return_value=httpx.Response(200, json={"ok": True, "team_id": "T1"})
    )
    respx.get("https://slack.com/api/chat.getPermalink").mock(
        return_value=httpx.Response(
            200, json={"ok": True, "permalink": "https://slack.test/alert"}
        )
    )

    client = slack_client(tmp_path, limits)
    message = await client.fetch_shortcut_source_message(
        team_id="T1",
        channel_id="CALERTS",
        invoking_user_id="U1",
        message_payload={
            "ts": ts,
            "bot_id": "BALERT",
            "username": "Monitor",
            "text": "CONEXÃO RESTAURADA",
            "attachments": [
                {
                    "fields": [
                        {"title": "Base", "value": "GERAL"},
                        {"title": "IP", "value": "10.200.53.1:3306"},
                    ]
                }
            ],
        },
    )
    await client.close()

    assert message.source_key == f"slack:T1:CALERTS:{ts}"
    assert message.author_id == "BALERT"
    assert message.author_name == "Monitor"
    assert "CONEXÃO RESTAURADA" in message.text
    assert "Base: GERAL" in message.text
    assert message.permalink == "https://slack.test/alert"


@respx.mock
@pytest.mark.asyncio
async def test_message_shortcut_rejects_unauthorized_invoker_without_api_call(
    tmp_path, limits
):
    client = slack_client(tmp_path, limits)
    with pytest.raises(SourceValidationError, match="not allowed"):
        await client.fetch_shortcut_source_message(
            team_id="T1",
            channel_id="CALERTS",
            invoking_user_id="UOTHER",
            message_payload={"ts": "1724440000.123456", "text": "alert"},
        )
    await client.close()
    assert not respx.calls


@respx.mock
@pytest.mark.asyncio
async def test_message_shortcut_keeps_processing_without_permalink(tmp_path, limits):
    ts = "1724440000.123456"
    respx.get("https://slack.com/api/auth.test").mock(
        return_value=httpx.Response(200, json={"ok": True, "team_id": "T1"})
    )
    respx.get("https://slack.com/api/chat.getPermalink").mock(
        return_value=httpx.Response(200, json={"ok": False, "error": "not_in_channel"})
    )

    client = slack_client(tmp_path, limits)
    message = await client.fetch_shortcut_source_message(
        team_id="T1",
        channel_id="CALERTS",
        invoking_user_id="U1",
        message_payload={"ts": ts, "bot_id": "B2", "text": "database alert"},
    )
    await client.close()

    assert message.permalink == ""
    assert message.author_id == "B2"
