from __future__ import annotations

import sqlite3
from datetime import timedelta

import pytest

from slack_plane_intake.errors import IntakeInProgress
from slack_plane_intake.ledger import IntakeLedger
from slack_plane_intake.models import IntakeResult


def test_completed_source_returns_existing_result(tmp_path):
    ledger = IntakeLedger(tmp_path / "ledger.sqlite3")
    claim = ledger.claim("slack:T:C:1.1")
    assert claim.claimed
    ledger.complete(
        "slack:T:C:1.1",
        IntakeResult(
            status="created",
            issue_key="PROB-1",
            issue_url="https://plane.test/ws/browse/PROB-1",
            model_used="kimi-k3",
            attachments_uploaded=2,
        ),
    )
    duplicate = ledger.claim("slack:T:C:1.1")
    assert not duplicate.claimed
    assert duplicate.existing
    assert duplicate.existing.status == "existing"
    assert duplicate.existing.issue_key == "PROB-1"
    assert duplicate.existing.attachments_uploaded == 2


def test_recent_pending_source_is_not_processed_concurrently(tmp_path):
    ledger = IntakeLedger(tmp_path / "ledger.sqlite3")
    ledger.claim("slack:T:C:1.2")
    with pytest.raises(IntakeInProgress):
        ledger.claim("slack:T:C:1.2")


def test_failed_source_can_be_retried(tmp_path):
    ledger = IntakeLedger(tmp_path / "ledger.sqlite3", stale_after=timedelta(0))
    ledger.claim("slack:T:C:1.3")
    ledger.fail("slack:T:C:1.3", "temporary failure")
    retry = ledger.claim("slack:T:C:1.3")
    assert retry.claimed
    assert retry.attempt_count == 2


def test_ledger_uses_rollback_journal_for_target_sqlite_safety(tmp_path):
    path = tmp_path / "ledger.sqlite3"
    IntakeLedger(path)
    with sqlite3.connect(path) as connection:
        mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
        synchronous = connection.execute("PRAGMA synchronous").fetchone()[0]
    assert mode == "delete"
    assert synchronous == 2
