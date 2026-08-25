from __future__ import annotations

import stat

from plane_codex_worker.ledger import JobLedger
from plane_codex_worker.models import PlaneIssue


def issue() -> PlaneIssue:
    return PlaneIssue(
        id="issue-1",
        sequence_id=1,
        name="Failure",
        description_html="<p>HTTP 500</p>",
        state_id="backlog",
        updated_at="2026-08-24T00:00:00Z",
    )


def test_claims_once_and_persists_thread_correlation(tmp_path):
    ledger = JobLedger(tmp_path / "jobs.sqlite3")
    claimed = ledger.claim(issue(), "AGENTE-1")
    assert claimed is not None
    assert claimed.attempt_count == 1

    ledger.set_running("issue-1", "thread-1", "turn-1")
    assert ledger.get("issue-1").thread_id == "thread-1"
    ledger.complete("issue-1")

    assert ledger.claim(issue(), "AGENTE-1") is None
    assert ledger.get("issue-1").status == "completed"
    assert stat.S_IMODE(ledger.path.stat().st_mode) == 0o600


def test_failed_job_can_be_reclaimed(tmp_path):
    ledger = JobLedger(tmp_path / "jobs.sqlite3")
    ledger.claim(issue(), "AGENTE-1")
    ledger.fail("issue-1", "temporary error")
    retried = ledger.claim(issue(), "AGENTE-1")
    assert retried is not None
    assert retried.attempt_count == 2
