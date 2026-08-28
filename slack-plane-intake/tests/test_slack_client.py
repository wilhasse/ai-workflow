from __future__ import annotations

from dataclasses import replace

import httpx
import pytest
import respx

from slack_plane_intake.config import SlackConfig
from slack_plane_intake.errors import SourceValidationError
from slack_plane_intake.slack_client import SlackClient


def slack_client(tmp_path, limits):
    http = httpx.AsyncClient(base_url="https://slack.com/api/")
    return SlackClient(
        SlackConfig(
            "xoxb-secret",
            "DINTAKE",
            frozenset({"U1"}),
            frozenset({"U1", "U2"}),
        ),
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
async def test_message_shortcut_allows_user_without_granting_dm_intake(
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
        invoking_user_id="U2",
        message_payload={"ts": ts, "bot_id": "BALERT", "text": "database alert"},
    )
    await client.close()

    assert message.source_key == f"slack:T1:CALERTS:{ts}"


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


@respx.mock
@pytest.mark.asyncio
async def test_message_bundle_is_chronological_and_shares_attachment_limits(
    tmp_path, limits
):
    limited = replace(limits, max_files=1)
    respx.get("https://slack.com/api/auth.test").mock(
        return_value=httpx.Response(200, json={"ok": True, "team_id": "T1"})
    )
    respx.get("https://slack.com/api/chat.getPermalink").mock(
        return_value=httpx.Response(
            200, json={"ok": True, "permalink": "https://slack.test/message"}
        )
    )
    files_info = respx.get("https://slack.com/api/files.info").mock(
        return_value=httpx.Response(
            200,
            json={
                "ok": True,
                "file": {
                    "id": "F1",
                    "name": "one.png",
                    "mimetype": "image/png",
                    "size": 1,
                    "url_private_download": "https://files.slack.com/F1",
                },
            },
        )
    )
    respx.get("https://files.slack.com/F1").mock(
        return_value=httpx.Response(200, content=b"1")
    )
    client = SlackClient(
        SlackConfig(
            "xoxb-secret",
            "DINTAKE",
            frozenset({"U1"}),
            frozenset({"U1"}),
        ),
        limited,
        tmp_path,
        client=httpx.AsyncClient(base_url="https://slack.com/api/"),
    )

    message = await client.fetch_shortcut_source_messages(
        team_id="T1",
        channel_id="D1",
        invoking_user_id="U1",
        message_payloads=(
            {
                "ts": "1724440001.000001",
                "bot_id": "B1",
                "text": "second",
                "files": [{"id": "F2", "name": "two.png"}],
            },
            {
                "ts": "1724440000.000001",
                "bot_id": "B1",
                "text": "first",
                "files": [{"id": "F1"}],
            },
        ),
    )
    await client.close()

    assert [part.message_ts for part in message.messages] == [
        "1724440000.000001",
        "1724440001.000001",
    ]
    assert len(message.attachments) == 2
    assert sum(attachment.available for attachment in message.attachments) == 1
    assert any(
        attachment.warning == "file-count limit exceeded"
        for attachment in message.attachments
    )
    assert files_info.call_count == 1


@respx.mock
@pytest.mark.asyncio
async def test_message_bundle_rejects_duplicate_before_source_processing(
    tmp_path, limits
):
    respx.get("https://slack.com/api/auth.test").mock(
        return_value=httpx.Response(200, json={"ok": True, "team_id": "T1"})
    )
    client = slack_client(tmp_path, limits)
    payload = {
        "ts": "1724440000.000001",
        "bot_id": "B1",
        "text": "duplicate",
    }

    with pytest.raises(SourceValidationError, match="duplicate"):
        await client.fetch_shortcut_source_messages(
            team_id="T1",
            channel_id="D1",
            invoking_user_id="U1",
            message_payloads=(payload, payload),
        )
    await client.close()

    assert len(respx.calls) == 1


@respx.mock
@pytest.mark.asyncio
async def test_history_picker_reads_following_dm_window_as_invoking_user(
    tmp_path, limits
):
    auth = respx.get("https://slack.com/api/auth.test").mock(
        side_effect=[
            httpx.Response(200, json={"ok": True, "team_id": "T1"}),
            httpx.Response(
                200,
                json={"ok": True, "team_id": "T1", "user_id": "U1"},
            ),
        ]
    )
    history = respx.get("https://slack.com/api/conversations.history").mock(
        return_value=httpx.Response(
            200,
            json={
                "ok": True,
                "messages": [
                    {
                        "ts": "1724440100.000001",
                        "user": "U1",
                        "text": "follow-up after selected",
                    },
                    {
                        "ts": "1724440002.000001",
                        "user": "U1",
                        "text": "last from API",
                    },
                    {
                        "ts": "1724440001.000001",
                        "user": "U2",
                        "text": "details",
                    },
                    {
                        "ts": "1724440000.000001",
                        "user": "U2",
                        "text": "problem",
                    },
                    {
                        "ts": "1724438000.000001",
                        "user": "U2",
                        "text": "before the selected message",
                    },
                    {
                        "ts": "1724441803.000001",
                        "user": "U2",
                        "text": "after the following window",
                    },
                ],
            },
        )
    )
    users = respx.get("https://slack.com/api/users.info").mock(
        return_value=httpx.Response(
            200,
            json={
                "ok": True,
                "user": {"profile": {"display_name": "Willian"}},
            },
        )
    )
    bot_http = httpx.AsyncClient(base_url="https://slack.com/api/")
    user_http = httpx.AsyncClient(
        base_url="https://slack.com/api/",
        headers={"Authorization": "Bearer xoxp-history"},
    )
    client = SlackClient(
        SlackConfig(
            "xoxb-secret",
            "DINTAKE",
            frozenset({"U1"}),
            frozenset({"U1"}),
            "U1",
            "xoxp-history",
        ),
        limits,
        tmp_path,
        client=bot_http,
        user_client=user_http,
    )

    messages = await client.fetch_shortcut_history_payloads(
        team_id="T1",
        channel_id="DPEER",
        invoking_user_id="U1",
        selected_message_payload={
            "ts": "1724440002.000001",
            "user": "U1",
            "text": "authoritative selected message",
        },
    )
    await client.close()
    await bot_http.aclose()
    await user_http.aclose()

    assert [message["ts"] for message in messages] == [
        "1724440002.000001",
        "1724440100.000001",
    ]
    assert messages[0]["text"] == "authoritative selected message"
    assert [message["username"] for message in messages] == [
        "Willian",
        "Willian",
    ]
    assert auth.call_count == 2
    assert users.call_count == 1
    assert history.calls[0].request.url.params["limit"] == "100"
    assert history.calls[0].request.url.params["oldest"] == "1724440002.000001"
    assert history.calls[0].request.url.params["latest"] == "1724441802.000001"
    assert history.calls[0].request.headers["Authorization"] == ("Bearer xoxp-history")


@respx.mock
@pytest.mark.asyncio
async def test_history_picker_keeps_first_twenty_messages_from_anchor(tmp_path, limits):
    respx.get("https://slack.com/api/auth.test").mock(
        side_effect=[
            httpx.Response(200, json={"ok": True, "team_id": "T1"}),
            httpx.Response(
                200,
                json={"ok": True, "team_id": "T1", "user_id": "U1"},
            ),
        ]
    )
    respx.get("https://slack.com/api/conversations.history").mock(
        return_value=httpx.Response(
            200,
            json={
                "ok": True,
                "messages": [
                    {
                        "ts": f"17244400{index:02d}.000001",
                        "bot_id": "B1",
                        "username": "Monitor",
                        "text": f"message {index + 1}",
                    }
                    for index in range(25)
                ],
            },
        )
    )
    bot_http = httpx.AsyncClient(base_url="https://slack.com/api/")
    user_http = httpx.AsyncClient(base_url="https://slack.com/api/")
    client = SlackClient(
        SlackConfig(
            "xoxb-secret",
            "DINTAKE",
            frozenset({"U1"}),
            frozenset({"U1"}),
            "U1",
            "xoxp-history",
        ),
        limits,
        tmp_path,
        client=bot_http,
        user_client=user_http,
    )
    selected_ts = "1724440000.000001"

    messages = await client.fetch_shortcut_history_payloads(
        team_id="T1",
        channel_id="DPEER",
        invoking_user_id="U1",
        selected_message_payload={
            "ts": selected_ts,
            "bot_id": "B1",
            "username": "Monitor",
            "text": "authoritative selected message",
        },
    )
    await client.close()
    await bot_http.aclose()
    await user_http.aclose()

    assert len(messages) == 20
    assert messages[0]["ts"] == selected_ts
    assert messages[-1]["ts"] == "1724440019.000001"
    assert (
        next(message for message in messages if message["ts"] == selected_ts)["text"]
        == "authoritative selected message"
    )


@respx.mock
@pytest.mark.asyncio
async def test_history_picker_never_uses_another_users_token(tmp_path, limits):
    bot_http = httpx.AsyncClient(base_url="https://slack.com/api/")
    user_http = httpx.AsyncClient(base_url="https://slack.com/api/")
    client = SlackClient(
        SlackConfig(
            "xoxb-secret",
            "DINTAKE",
            frozenset({"U1"}),
            frozenset({"U1", "U2"}),
            "U1",
            "xoxp-history",
        ),
        limits,
        tmp_path,
        client=bot_http,
        user_client=user_http,
    )

    with pytest.raises(SourceValidationError, match="not configured for this user"):
        await client.fetch_shortcut_history_payloads(
            team_id="T1",
            channel_id="DPEER",
            invoking_user_id="U2",
            selected_message_payload={
                "ts": "1724440002.000001",
                "text": "selected",
            },
        )
    await client.close()
    await bot_http.aclose()
    await user_http.aclose()

    assert not respx.calls


@respx.mock
@pytest.mark.asyncio
async def test_history_picker_uses_bound_user_token_for_dm_screenshot(tmp_path, limits):
    respx.get("https://slack.com/api/auth.test").mock(
        side_effect=[
            httpx.Response(200, json={"ok": True, "team_id": "T1"}),
            httpx.Response(
                200,
                json={"ok": True, "team_id": "T1", "user_id": "U1"},
            ),
        ]
    )
    permalink = respx.get("https://slack.com/api/chat.getPermalink").mock(
        return_value=httpx.Response(
            200, json={"ok": True, "permalink": "https://slack.test/dm"}
        )
    )
    respx.get("https://slack.com/api/users.info").mock(
        return_value=httpx.Response(
            200,
            json={
                "ok": True,
                "user": {"profile": {"display_name": "Requester"}},
            },
        )
    )
    file_info = respx.get("https://slack.com/api/files.info").mock(
        return_value=httpx.Response(
            200,
            json={
                "ok": True,
                "file": {
                    "id": "F1",
                    "name": "screen.png",
                    "mimetype": "image/png",
                    "size": 3,
                    "url_private_download": "https://files.slack.com/F1",
                },
            },
        )
    )
    download = respx.get("https://files.slack.com/F1").mock(
        return_value=httpx.Response(200, content=b"png")
    )
    bot_http = httpx.AsyncClient(
        base_url="https://slack.com/api/",
        headers={"Authorization": "Bearer xoxb-secret"},
    )
    user_http = httpx.AsyncClient(
        base_url="https://slack.com/api/",
        headers={"Authorization": "Bearer xoxp-history"},
    )
    client = SlackClient(
        SlackConfig(
            "xoxb-secret",
            "DINTAKE",
            frozenset({"U1"}),
            frozenset({"U1"}),
            "U1",
            "xoxp-history",
        ),
        limits,
        tmp_path,
        client=bot_http,
        user_client=user_http,
    )

    message = await client.fetch_shortcut_source_messages(
        team_id="T1",
        channel_id="DPEER",
        invoking_user_id="U1",
        message_payloads=(
            {
                "ts": "1724440000.000001",
                "user": "U2",
                "text": "screenshot",
                "files": [{"id": "F1"}],
            },
        ),
    )
    await client.close()
    await bot_http.aclose()
    await user_http.aclose()

    assert message.attachments[0].local_path.read_bytes() == b"png"
    for route in (permalink, file_info, download):
        assert route.calls[0].request.headers["Authorization"] == (
            "Bearer xoxp-history"
        )
