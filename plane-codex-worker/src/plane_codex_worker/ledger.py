"""Crash-safe local correlation between Plane issues and Codex threads."""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .models import Job, PlaneIssue


class JobLedger:
    def __init__(self, path: Path, *, stale_after: timedelta | None = None) -> None:
        self.path = path
        self.stale_after = stale_after or timedelta(hours=2)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.execute("PRAGMA synchronous=FULL")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    issue_id TEXT PRIMARY KEY,
                    issue_key TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN
                        ('claimed', 'running', 'completed', 'failed')),
                    attempt_count INTEGER NOT NULL DEFAULT 1,
                    thread_id TEXT NOT NULL DEFAULT '',
                    turn_id TEXT NOT NULL DEFAULT '',
                    last_error TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                PRAGMA user_version=1;
                """
            )
        self.path.chmod(0o600)

    def claim(self, issue: PlaneIssue, issue_key: str) -> Job | None:
        now = datetime.now(UTC)
        now_text = now.isoformat()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM jobs WHERE issue_id=?", (issue.id,)
            ).fetchone()
            if row is None:
                connection.execute(
                    """
                    INSERT INTO jobs(
                        issue_id, issue_key, status, created_at, updated_at
                    ) VALUES (?, ?, 'claimed', ?, ?)
                    """,
                    (issue.id, issue_key, now_text, now_text),
                )
                connection.commit()
                return Job(issue.id, issue_key, "claimed", 1)
            if row["status"] == "completed":
                connection.commit()
                return None
            updated_at = datetime.fromisoformat(row["updated_at"])
            if (
                row["status"] in {"claimed", "running"}
                and now - updated_at < self.stale_after
            ):
                connection.commit()
                return None
            attempt = int(row["attempt_count"]) + 1
            connection.execute(
                """
                UPDATE jobs
                   SET status='claimed', attempt_count=?, thread_id='', turn_id='',
                       last_error='', updated_at=?
                 WHERE issue_id=?
                """,
                (attempt, now_text, issue.id),
            )
            connection.commit()
            return Job(issue.id, issue_key, "claimed", attempt)

    def set_running(self, issue_id: str, thread_id: str, turn_id: str) -> None:
        self._update(
            issue_id,
            "status='running', thread_id=?, turn_id=?, last_error=''",
            (thread_id, turn_id),
        )

    def complete(self, issue_id: str) -> None:
        self._update(issue_id, "status='completed', last_error=''", ())

    def fail(self, issue_id: str, error: str) -> None:
        self._update(issue_id, "status='failed', last_error=?", (error[:1000],))

    def active(self) -> tuple[Job, ...]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM jobs WHERE status IN ('claimed', 'running')"
            ).fetchall()
        return tuple(self._job(row) for row in rows)

    def get(self, issue_id: str) -> Job | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM jobs WHERE issue_id=?", (issue_id,)
            ).fetchone()
        return self._job(row) if row else None

    def _update(
        self, issue_id: str, assignment: str, values: tuple[object, ...]
    ) -> None:
        now = datetime.now(UTC).isoformat()
        with self._connect() as connection:
            connection.execute(
                f"UPDATE jobs SET {assignment}, updated_at=? WHERE issue_id=?",
                (*values, now, issue_id),
            )

    @staticmethod
    def _job(row: sqlite3.Row) -> Job:
        return Job(
            issue_id=str(row["issue_id"]),
            issue_key=str(row["issue_key"]),
            status=str(row["status"]),
            attempt_count=int(row["attempt_count"]),
            thread_id=str(row["thread_id"] or ""),
            turn_id=str(row["turn_id"] or ""),
        )
