from __future__ import annotations

import httpx
import pytest
import respx

from slack_plane_intake.config import PlaneConfig
from slack_plane_intake.models import ProblemAnalysis, SourceAttachment
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


@respx.mock
@pytest.mark.asyncio
async def test_create_problem_escapes_evidence_and_builds_key(source_message):
    route = respx.post(
        "https://plane.test/api/v1/workspaces/ws/projects/P1/work-items/"
    ).mock(return_value=httpx.Response(201, json={"id": "I1", "sequence_id": 7}))
    client = PlaneClient(plane_config())
    item = await client.create_problem(
        source_message.model_copy(update={"text": "<script>alert(1)</script>"}),
        analysis(),
        "<!-- spi-source:abc -->",
    )
    await client.close()
    body = route.calls[0].request.content.decode()
    assert "<script>" not in body
    assert "&lt;script&gt;" in body
    assert item.key == "PROB-7"
    assert item.url.endswith("/ws/browse/PROB-7")


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
