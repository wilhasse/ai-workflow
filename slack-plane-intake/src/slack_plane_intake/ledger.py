"""Crash-safe idempotency ledger for Slack source messages."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .errors import IntakeInProgress
from .models import IntakeResult


@dataclass(frozen=True)
class LedgerClaim:
    claimed: bool
    attempt_count: int
    existing: IntakeResult | None = None


class IntakeLedger:
    def __init__(self, path: Path, *, stale_after: timedelta | None = None) -> None:
        self.path = path
        self.stale_after = stale_after or timedelta(minutes=15)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        # The target Debian Python currently links SQLite 3.40.1, which is in
        # the upstream WAL-reset defect range. Intake volume is low, and
        # BEGIN IMMEDIATE already serializes claims, so rollback journaling is
        # the safer durability choice until the host SQLite is patched.
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS intake (
                    source_key TEXT PRIMARY KEY,
                    status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed')),
                    attempt_count INTEGER NOT NULL DEFAULT 1,
                    issue_key TEXT,
                    issue_url TEXT,
                    model_used TEXT,
                    attachments_uploaded INTEGER NOT NULL DEFAULT 0,
                    warnings_json TEXT NOT NULL DEFAULT '[]',
                    last_error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                PRAGMA user_version=1;
                """
            )

    def claim(self, source_key: str) -> LedgerClaim:
        now = datetime.now(UTC)
        now_text = now.isoformat()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM intake WHERE source_key=?", (source_key,)
            ).fetchone()
            if row is None:
                connection.execute(
                    """
                    INSERT INTO intake(source_key, status, created_at, updated_at)
                    VALUES (?, 'pending', ?, ?)
                    """,
                    (source_key, now_text, now_text),
                )
                connection.commit()
                return LedgerClaim(claimed=True, attempt_count=1)

            if row["status"] == "completed":
                connection.commit()
                return LedgerClaim(
                    claimed=False,
                    attempt_count=int(row["attempt_count"]),
                    existing=self._result(row, status="existing"),
                )

            updated_at = datetime.fromisoformat(row["updated_at"])
            if row["status"] == "pending" and now - updated_at < self.stale_after:
                connection.rollback()
                raise IntakeInProgress("This Slack message is already being processed")

            attempt_count = int(row["attempt_count"]) + 1
            connection.execute(
                """
                UPDATE intake
                   SET status='pending', attempt_count=?, last_error=NULL, updated_at=?
                 WHERE source_key=?
                """,
                (attempt_count, now_text, source_key),
            )
            connection.commit()
            return LedgerClaim(claimed=True, attempt_count=attempt_count)

    def complete(self, source_key: str, result: IntakeResult) -> None:
        if result.status not in {"created", "appended", "partial", "existing"}:
            raise ValueError("Only successful or partial results can complete a claim")
        now = datetime.now(UTC).isoformat()
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE intake
                   SET status='completed', issue_key=?, issue_url=?, model_used=?,
                       attachments_uploaded=?, warnings_json=?, last_error=NULL,
                       updated_at=?
                 WHERE source_key=?
                """,
                (
                    result.issue_key,
                    result.issue_url,
                    result.model_used,
                    result.attachments_uploaded,
                    json.dumps(result.warnings, ensure_ascii=False),
                    now,
                    source_key,
                ),
            )

    def fail(self, source_key: str, message: str) -> None:
        now = datetime.now(UTC).isoformat()
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE intake
                   SET status='failed', last_error=?, updated_at=?
                 WHERE source_key=?
                """,
                (message[:1000], now, source_key),
            )

    def get(self, source_key: str) -> IntakeResult | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM intake WHERE source_key=?", (source_key,)
            ).fetchone()
        if row is None or row["status"] != "completed":
            return None
        return self._result(row, status="existing")

    @staticmethod
    def _result(row: sqlite3.Row, *, status: str) -> IntakeResult:
        return IntakeResult(
            status=status,
            issue_key=row["issue_key"],
            issue_url=row["issue_url"],
            model_used=row["model_used"],
            attachments_uploaded=int(row["attachments_uploaded"]),
            warnings=tuple(json.loads(row["warnings_json"] or "[]")),
        )
