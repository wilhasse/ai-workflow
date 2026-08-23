from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from slack_plane_intake.errors import AnalysisError, ExternalServiceError
from slack_plane_intake.ledger import IntakeLedger
from slack_plane_intake.models import (
    PlaneWorkItem,
    ProblemAnalysis,
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
