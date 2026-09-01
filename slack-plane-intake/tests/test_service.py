from __future__ import annotations

import re
from unittest.mock import AsyncMock, MagicMock

import pytest

from slack_plane_intake.errors import AnalysisError, ExternalServiceError
from slack_plane_intake.ledger import IntakeLedger
from slack_plane_intake.models import (
    PlaneWorkItem,
    ProblemAnalysis,
    SourceMessage,
    UploadReport,
)
from slack_plane_intake.service import ProblemIntakeService


def service(tmp_path, source_message):
    slack = AsyncMock()
    slack.fetch_source_message.return_value = source_message
    analyzer = MagicMock()
    analyzer.analyze = AsyncMock()
    analyzer.analyze.return_value = ProblemAnalysis(
        title="API failure",
        summary="HTTP 500",
        confirmed_facts=("HTTP 500",),
        model_used="kimi-k3",
    )
    plane = MagicMock()
    plane.find_by_source_marker = AsyncMock()
    plane.create_problem = AsyncMock()
    plane.upload_originals = AsyncMock()
    plane.append_warnings = AsyncMock()
    plane.find_by_source_marker.return_value = None
    plane.create_problem.return_value = PlaneWorkItem(
        id="I1", key="PROB-1", url="https://plane.test/ws/browse/PROB-1"
    )
    plane.upload_originals.return_value = UploadReport()
    ledger = IntakeLedger(tmp_path / "ledger.sqlite3")
    return ProblemIntakeService(slack, analyzer, plane, ledger), analyzer, plane


def test_source_marker_is_plane_visible_and_stable():
    marker = ProblemIntakeService.source_marker("slack:T1:D1:1.2")
    assert re.fullmatch(r"spi-source:[0-9a-f]{64}", marker)
    assert marker == ProblemIntakeService.source_marker("slack:T1:D1:1.2")


@pytest.mark.asyncio
async def test_creates_once_and_returns_existing_on_duplicate(tmp_path, source_message):
    intake, analyzer, plane = service(tmp_path, source_message)
    first = await intake.create_from_slack(source_message.message_ts)
    second = await intake.create_from_slack(source_message.message_ts)
    assert first.status == "created"
    assert second.status == "existing"
    assert first.issue_key == second.issue_key == "PROB-1"
    assert analyzer.analyze.await_count == 1
    assert plane.create_problem.await_count == 1


@pytest.mark.asyncio
async def test_ai_failure_creates_partial_ticket_with_deterministic_analysis(
    tmp_path, source_message
):
    intake, analyzer, _plane = service(tmp_path, source_message)
    analyzer.analyze.side_effect = AnalysisError("models unavailable")
    analyzer.deterministic_fallback.return_value = ProblemAnalysis(
        title="Fallback",
        summary="Original preserved",
        warnings=("Análise por IA indisponível",),
        analysis_kind="fallback",
    )
    result = await intake.create_from_slack(source_message.message_ts)
    assert result.status == "partial"
    assert result.issue_key == "PROB-1"


@pytest.mark.asyncio
async def test_ambiguous_plane_create_reconciles_without_duplicate(
    tmp_path, source_message
):
    intake, _, plane = service(tmp_path, source_message)
    plane.create_problem.side_effect = ExternalServiceError("ambiguous", ambiguous=True)
    plane.find_by_source_marker.side_effect = [
        None,
        PlaneWorkItem(id="I9", key="PROB-9", url="https://plane.test/ws/browse/PROB-9"),
    ]
    result = await intake.create_from_slack(source_message.message_ts)
    assert result.status == "existing"
    assert result.issue_key == "PROB-9"


@pytest.mark.asyncio
async def test_plane_failure_does_not_claim_success(tmp_path, source_message):
    intake, _, plane = service(tmp_path, source_message)
    plane.create_problem.side_effect = ExternalServiceError("Plane unavailable")
    result = await intake.create_from_slack(source_message.message_ts)
    assert result.status == "failed"
    assert result.issue_key is None


@pytest.mark.asyncio
async def test_shortcut_uses_same_idempotent_workflow(tmp_path, source_message):
    intake, analyzer, plane = service(tmp_path, source_message)
    intake.slack.fetch_shortcut_source_message.return_value = source_message

    first = await intake.create_from_slack_shortcut(
        team_id="T1",
        channel_id="CALERTS",
        invoking_user_id="U1",
        message_payload={"ts": source_message.message_ts, "text": "alert"},
    )
    second = await intake.create_from_slack_shortcut(
        team_id="T1",
        channel_id="CALERTS",
        invoking_user_id="U1",
        message_payload={"ts": source_message.message_ts, "text": "alert"},
    )

    assert first.status == "created"
    assert second.status == "existing"
    assert analyzer.analyze.await_count == 1
    assert plane.create_problem.await_count == 1


@pytest.mark.asyncio
async def test_shortcut_bundle_uses_one_aggregate_idempotent_workflow(
    tmp_path, source_message
):
    second = source_message.messages[0].model_copy(
        update={"message_ts": "1724440001.123456", "text": "screenshot follows"}
    )
    bundle = SourceMessage(
        team_id=source_message.team_id,
        channel_id=source_message.channel_id,
        messages=(*source_message.messages, second),
    )
    intake, analyzer, plane = service(tmp_path, bundle)
    intake.slack.fetch_shortcut_source_messages.return_value = bundle

    result = await intake.create_from_slack_shortcut_messages(
        team_id="T1",
        channel_id="DINTAKE",
        invoking_user_id="U1",
        message_payloads=(
            {"ts": source_message.message_ts},
            {"ts": second.message_ts},
        ),
    )

    assert result.status == "created"
    intake.slack.fetch_shortcut_source_messages.assert_awaited_once()
    analyzer.analyze.assert_awaited_once_with(bundle)
    plane.create_problem.assert_awaited_once()


@pytest.mark.asyncio
async def test_appends_comment_and_attachments_to_existing_ticket(
    tmp_path, source_message
):
    intake, _analyzer, plane = service(tmp_path, source_message)
    plane.config = MagicMock(project_identifier="DELTA", project_id="project-delta")
    plane.get_work_item_by_sequence = AsyncMock(
        return_value=PlaneWorkItem(
            id="I385",
            key="DELTA-385",
            url="https://plane.test/ws/browse/DELTA-385",
        )
    )
    plane.add_update_comment = AsyncMock()
    plane.upload_originals.return_value = UploadReport(uploaded=1)
    intake.slack.fetch_shortcut_source_messages.return_value = source_message

    result = await intake.append_from_slack_shortcut_messages(
        team_id="T1",
        channel_id="DINTAKE",
        invoking_user_id="U1",
        message_payloads=({"ts": source_message.message_ts},),
        issue_number="385",
    )
    duplicate = await intake.append_from_slack_shortcut_messages(
        team_id="T1",
        channel_id="DINTAKE",
        invoking_user_id="U1",
        message_payloads=({"ts": source_message.message_ts},),
        issue_number="385",
    )

    assert result.status == "appended"
    assert result.issue_key == "DELTA-385"
    assert result.attachments_uploaded == 1
    assert duplicate.status == "existing"
    plane.create_problem.assert_not_awaited()
    assert plane.add_update_comment.await_count == 1
    assert plane.upload_originals.await_count == 1
