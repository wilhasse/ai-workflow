from __future__ import annotations

import httpx
import pytest
import respx

from slack_plane_intake.config import PlaneConfig
from slack_plane_intake.errors import ExternalServiceError
from slack_plane_intake.models import ProblemAnalysis, SourceAttachment, SourceMessage
from slack_plane_intake.plane_client import PlaneClient


def plane_config():
    return PlaneConfig(
        base_url="https://plane.test",
        api_key="secret",
        workspace="ws",
        project_id="P1",
        project_identifier="PROB",
        state_id="S1",
    )


def analysis():
    return ProblemAnalysis(
        title="Problem <unsafe>",
        summary="Summary & evidence",
        confirmed_facts=("Fact <one>",),
        inferences=("Inference",),
        missing_information=("Trace ID",),
        model_used="kimi-k3",
    )


SOURCE_MARKER = "spi-source:" + "a" * 64


@respx.mock
@pytest.mark.asyncio
async def test_lists_only_writable_projects_with_configured_project_first():
    route = respx.get("https://plane.test/api/v1/workspaces/ws/projects/").mock(
        return_value=httpx.Response(
            200,
            json={
                "results": [
                    {
                        "id": "P2",
                        "identifier": "OLOS",
                        "name": "OLOS",
                        "is_member": True,
                    },
                    {
                        "id": "P3",
                        "identifier": "PUBLIC",
                        "name": "Read only",
                        "is_member": False,
                    },
                    {
                        "id": "P1",
                        "identifier": "PROB",
                        "name": "Problems",
                        "is_member": True,
                    },
                ]
            },
        )
    )
    client = PlaneClient(plane_config())

    projects = await client.list_projects()

    await client.close()
    assert [(project.id, project.identifier) for project in projects] == [
        ("P1", "PROB"),
        ("P2", "OLOS"),
    ]
    assert route.calls[0].request.headers["X-API-Key"] == "secret"


@respx.mock
@pytest.mark.asyncio
async def test_resolves_selected_project_and_uses_its_default_state():
    respx.get("https://plane.test/api/v1/workspaces/ws/projects/").mock(
        return_value=httpx.Response(
            200,
            json=[
                {
                    "id": "P1",
                    "identifier": "PROB",
                    "name": "Problems",
                    "is_member": True,
                },
                {
                    "id": "P2",
                    "identifier": "OLOS",
                    "name": "OLOS",
                    "is_member": True,
                },
            ],
        )
    )
    states = respx.get(
        "https://plane.test/api/v1/workspaces/ws/projects/P2/states/"
    ).mock(
        return_value=httpx.Response(
            200,
            json=[
                {"id": "S-TODO", "group": "unstarted", "default": False},
                {"id": "S-BACKLOG", "group": "backlog", "default": True},
            ],
        )
    )
    client = PlaneClient(plane_config())

    selected = await client.resolve_project_config("P2")

    await client.close()
    assert selected.project_id == "P2"
    assert selected.project_identifier == "OLOS"
    assert selected.state_id == "S-BACKLOG"
    assert states.called


@respx.mock
@pytest.mark.asyncio
async def test_preserves_configured_state_for_default_project():
    respx.get("https://plane.test/api/v1/workspaces/ws/projects/").mock(
        return_value=httpx.Response(
            200,
            json=[
                {
                    "id": "P1",
                    "identifier": "PROB",
                    "name": "Problems",
                    "is_member": True,
                }
            ],
        )
    )
    respx.get("https://plane.test/api/v1/workspaces/ws/projects/P1/states/").mock(
        return_value=httpx.Response(
            200,
            json=[
                {"id": "S0", "group": "backlog", "default": True},
                {"id": "S1", "group": "started", "default": False},
            ],
        )
    )
    client = PlaneClient(plane_config())

    selected = await client.resolve_project_config("P1")

    await client.close()
    assert selected.state_id == "S1"


@respx.mock
@pytest.mark.asyncio
async def test_rejects_forged_or_non_member_project_selection():
    respx.get("https://plane.test/api/v1/workspaces/ws/projects/").mock(
        return_value=httpx.Response(
            200,
            json=[
                {
                    "id": "P3",
                    "identifier": "PUBLIC",
                    "name": "Read only",
                    "is_member": False,
                }
            ],
        )
    )
    client = PlaneClient(plane_config())

    with pytest.raises(ExternalServiceError, match="not available"):
        await client.resolve_project_config("P3")

    await client.close()


@respx.mock
@pytest.mark.asyncio
async def test_create_problem_escapes_evidence_and_builds_key(source_message):
    route = respx.post(
        "https://plane.test/api/v1/workspaces/ws/projects/P1/work-items/"
    ).mock(return_value=httpx.Response(201, json={"id": "I1", "sequence_id": 7}))
    client = PlaneClient(plane_config())
    unsafe_part = source_message.messages[0].model_copy(
        update={"text": "<script>alert(1)</script>"}
    )
    item = await client.create_problem(
        source_message.model_copy(update={"messages": (unsafe_part,)}),
        analysis(),
        SOURCE_MARKER,
    )
    await client.close()
    body = route.calls[0].request.content.decode()
    assert "<script>" not in body
    assert "&lt;script&gt;" in body
    assert SOURCE_MARKER in body
    assert "Workspace Slack" in body
    assert "<!-- spi-source:" not in body
    assert item.key == "PROB-7"
    assert item.url.endswith("/ws/browse/PROB-7")


@respx.mock
@pytest.mark.asyncio
async def test_reconciliation_finds_visible_source_marker():
    base = "https://plane.test/api/v1/workspaces/ws/projects/P1/work-items/"
    respx.get(base).mock(
        return_value=httpx.Response(
            200,
            json={
                "results": [
                    {
                        "id": "I7",
                        "sequence_id": 7,
                        "description_html": (f"<p><code>{SOURCE_MARKER}</code></p>"),
                    }
                ]
            },
        )
    )
    client = PlaneClient(plane_config())
    item = await client.find_by_source_marker(SOURCE_MARKER)
    await client.close()
    assert item is not None
    assert item.key == "PROB-7"


@respx.mock
@pytest.mark.asyncio
async def test_attachment_presign_upload_complete_and_verify(tmp_path):
    path = tmp_path / "original.txt"
    path.write_bytes(b"unchanged-original")
    attachment = SourceAttachment(
        file_id="F1",
        name="original.txt",
        mime_type="text/plain",
        size=path.stat().st_size,
        sha256="hash",
        local_path=path,
    )
    base = (
        "https://plane.test/api/v1/workspaces/ws/projects/P1/work-items/I1/attachments/"
    )
    respx.post(base).mock(
        return_value=httpx.Response(
            200,
            json={
                "upload_data": {
                    "url": "https://storage.test/upload",
                    "fields": {"key": "opaque", "policy": "opaque"},
                },
                "asset_id": "A1",
            },
        )
    )
    storage = respx.post("https://storage.test/upload").mock(
        return_value=httpx.Response(204)
    )
    respx.patch(f"{base}A1/").mock(return_value=httpx.Response(200, json={}))
    respx.get(base).mock(
        return_value=httpx.Response(200, json=[{"id": "A1", "is_uploaded": True}])
    )
    client = PlaneClient(plane_config())
    report = await client.upload_originals(
        type("WorkItem", (), {"id": "I1"})(), (attachment,), "slack:T:C:1.1"
    )
    await client.close()
    assert report.uploaded == 1
    assert report.warnings == ()
    assert b"unchanged-original" in storage.calls[0].request.content


@respx.mock
@pytest.mark.asyncio
async def test_attachment_complete_retries_http_429(tmp_path, monkeypatch):
    path = tmp_path / "original.txt"
    path.write_bytes(b"unchanged-original")
    attachment = SourceAttachment(
        file_id="F1",
        name="original.txt",
        mime_type="text/plain",
        size=path.stat().st_size,
        sha256="hash",
        local_path=path,
    )
    base = (
        "https://plane.test/api/v1/workspaces/ws/projects/P1/work-items/I1/attachments/"
    )
    respx.post(base).mock(
        return_value=httpx.Response(
            200,
            json={
                "upload_data": {
                    "url": "https://storage.test/upload",
                    "fields": {"key": "opaque"},
                },
                "asset_id": "A1",
            },
        )
    )
    respx.post("https://storage.test/upload").mock(return_value=httpx.Response(204))
    complete = respx.patch(f"{base}A1/").mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "0"}),
            httpx.Response(204),
        ]
    )
    respx.get(base).mock(
        return_value=httpx.Response(200, json=[{"id": "A1", "is_uploaded": True}])
    )
    client = PlaneClient(plane_config())
    monkeypatch.setattr(client, "_sleep", _noop_sleep, raising=False)
    report = await client.upload_originals(
        type("WorkItem", (), {"id": "I1"})(), (attachment,), "slack:T:C:1.1"
    )
    await client.close()
    assert report.uploaded == 1
    assert report.warnings == ()
    assert complete.call_count == 2


async def _noop_sleep(_seconds: float = 0) -> None:
    return None


@respx.mock
@pytest.mark.asyncio
async def test_stored_attachment_is_not_deleted_after_complete_429(
    tmp_path, monkeypatch
):
    path = tmp_path / "original.txt"
    path.write_text("evidence")
    attachment = SourceAttachment(
        file_id="F1",
        name="original.txt",
        mime_type="text/plain",
        size=path.stat().st_size,
        local_path=path,
    )
    base = (
        "https://plane.test/api/v1/workspaces/ws/projects/P1/work-items/I1/attachments/"
    )
    respx.post(base).mock(
        return_value=httpx.Response(
            200,
            json={
                "upload_data": {"url": "https://storage.test/upload", "fields": {}},
                "asset_id": "A1",
            },
        )
    )
    respx.post("https://storage.test/upload").mock(return_value=httpx.Response(204))
    respx.patch(f"{base}A1/").mock(return_value=httpx.Response(429))
    deleted = respx.delete(f"{base}A1/").mock(return_value=httpx.Response(204))
    client = PlaneClient(plane_config())
    monkeypatch.setattr(client, "_sleep", _noop_sleep, raising=False)
    report = await client.upload_originals(
        type("WorkItem", (), {"id": "I1"})(), (attachment,), "slack:T:C:1.1"
    )
    await client.close()
    assert report.uploaded == 0
    assert any("HTTP 429" in warning for warning in report.warnings)
    assert not deleted.called


@respx.mock
@pytest.mark.asyncio
async def test_failed_storage_upload_deletes_dangling_asset(tmp_path):
    path = tmp_path / "original.txt"
    path.write_text("evidence")
    attachment = SourceAttachment(
        file_id="F1",
        name="original.txt",
        mime_type="text/plain",
        size=path.stat().st_size,
        local_path=path,
    )
    base = (
        "https://plane.test/api/v1/workspaces/ws/projects/P1/work-items/I1/attachments/"
    )
    respx.post(base).mock(
        return_value=httpx.Response(
            200,
            json={
                "upload_data": {"url": "https://storage.test/upload", "fields": {}},
                "asset_id": "A1",
            },
        )
    )
    respx.post("https://storage.test/upload").mock(return_value=httpx.Response(500))
    deleted = respx.delete(f"{base}A1/").mock(return_value=httpx.Response(204))
    client = PlaneClient(plane_config())
    report = await client.upload_originals(
        type("WorkItem", (), {"id": "I1"})(), (attachment,), "slack:T:C:1.1"
    )
    await client.close()
    assert report.uploaded == 0
    assert report.warnings
    assert deleted.called


@respx.mock
@pytest.mark.asyncio
async def test_append_warnings_escapes_text():
    path = "https://plane.test/api/v1/workspaces/ws/projects/P1/work-items/I1/"
    respx.get(path).mock(
        return_value=httpx.Response(200, json={"description_html": "<p>Original</p>"})
    )
    patched = respx.patch(path).mock(return_value=httpx.Response(200, json={}))
    client = PlaneClient(plane_config())
    await client.append_warnings(
        type("WorkItem", (), {"id": "I1"})(), ("upload <failed>",)
    )
    await client.close()
    body = patched.calls[0].request.content.decode()
    assert "&lt;failed&gt;" in body
    assert "upload <failed>" not in body


def test_render_description_combines_messages_in_one_field_with_provenance(
    source_message,
):
    second = source_message.messages[0].model_copy(
        update={
            "message_ts": "1724440001.123456",
            "author_id": "U2",
            "author_name": "Second Operator",
            "text": "screenshot follows",
            "permalink": "https://slack.test/second",
            "attachments": (
                SourceAttachment(
                    file_id="F2",
                    name="screen.png",
                    mime_type="image/png",
                    size=123,
                    sha256="abc",
                ),
            ),
        }
    )
    bundle = SourceMessage(
        team_id=source_message.team_id,
        channel_id=source_message.channel_id,
        messages=(*source_message.messages, second),
    )

    rendered = PlaneClient.render_description(bundle, analysis(), SOURCE_MARKER)

    assert rendered.count("<h2>Mensagem</h2>") == 1
    assert rendered.count("<pre><code>") == 1
    assert "Mensagem 1" not in rendered
    assert "Mensagem 2" not in rendered
    assert "API returns HTTP 500\nscreenshot follows" in rendered
    assert rendered.count("Second Operator") == 2
    assert "https://slack.test/second" in rendered
    assert "Mensagens no Slack:" in rendered
    assert "1 mensagem(ns)" in rendered
    assert "screen.png — image/png — 123 bytes" in rendered
    assert "Origem: Second Operator" in rendered


def test_render_description_skips_image_only_message_text_and_groups_author(
    source_message,
):
    first = source_message.messages[0].model_copy(
        update={"author_id": "U2", "author_name": "Noboru", "text": "Primeira"}
    )
    image_only = first.model_copy(
        update={
            "message_ts": "1724440001.123456",
            "text": "",
            "permalink": "https://slack.test/image",
            "attachments": (
                SourceAttachment(
                    file_id="F2",
                    name="screen.png",
                    mime_type="image/png",
                    size=123,
                ),
            ),
        }
    )
    last = first.model_copy(
        update={
            "message_ts": "1724440002.123456",
            "text": "Última",
            "permalink": "https://slack.test/last",
            "attachments": (),
        }
    )
    bundle = SourceMessage(
        team_id=source_message.team_id,
        channel_id=source_message.channel_id,
        messages=(first, image_only, last),
    )

    rendered = PlaneClient.render_description(bundle, analysis(), SOURCE_MARKER)

    assert "<pre><code>Primeira\nÚltima</code></pre>" in rendered
    assert rendered.count("Autor: Noboru (U2)") == 1
    assert "3 mensagem(ns)" in rendered
    assert "Mensagens no Slack:" in rendered


@respx.mock
@pytest.mark.asyncio
async def test_get_work_item_by_sequence_checks_project():
    respx.get("https://plane.test/api/v1/workspaces/ws/work-items/PROB-385/").mock(
        return_value=httpx.Response(
            200,
            json={
                "id": "I385",
                "sequence_id": 385,
                "project_identifier": "PROB",
                "project": "P1",
            },
        )
    )
    client = PlaneClient(plane_config())
    item = await client.get_work_item_by_sequence(385)
    await client.close()
    assert item.id == "I385"
    assert item.key == "PROB-385"


@respx.mock
@pytest.mark.asyncio
async def test_add_update_comment_posts_slack_html(source_message):
    posted = respx.post(
        "https://plane.test/api/v1/workspaces/ws/projects/P1/work-items/I385/comments/"
    ).mock(return_value=httpx.Response(201, json={"id": "C1"}))
    client = PlaneClient(plane_config())
    await client.add_update_comment(
        type("WorkItem", (), {"id": "I385"})(),
        source_message,
        analysis(),
        SOURCE_MARKER,
    )
    await client.close()
    body = posted.calls[0].request.content.decode()
    assert "Atualização via Slack" in body
    assert SOURCE_MARKER in body
    assert "API returns HTTP 500" in body
