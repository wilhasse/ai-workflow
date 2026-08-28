"""Durable, bounded Slack message drafts for modal ticket creation."""

from __future__ import annotations

import json
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .errors import SourceValidationError

_MAX_DRAFT_MESSAGES = 20
_MAX_MESSAGE_PAYLOAD_BYTES = 256 * 1024
_AUDIT_RETENTION = timedelta(days=30)
_AUDIT_STATUSES = {"processing", "created", "existing", "partial", "failed"}


@dataclass(frozen=True)
class DraftMessage:
    message_ts: str
    payload: dict


@dataclass(frozen=True)
class DraftSnapshot:
    draft_id: str
    team_id: str
    user_id: str
    channel_id: str
    messages: tuple[DraftMessage, ...]


class DraftStore:
    def __init__(self, path: Path, *, expires_after: timedelta | None = None) -> None:
        self.path = path
        self.expires_after = expires_after or timedelta(hours=2)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS shortcut_drafts (
                    draft_id TEXT PRIMARY KEY,
                    team_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    channel_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(team_id, user_id, channel_id)
                );
                CREATE TABLE IF NOT EXISTS shortcut_draft_messages (
                    draft_id TEXT NOT NULL REFERENCES shortcut_drafts(draft_id)
                        ON DELETE CASCADE,
                    message_ts TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    added_at TEXT NOT NULL,
                    PRIMARY KEY(draft_id, message_ts)
                );
                CREATE INDEX IF NOT EXISTS shortcut_drafts_updated_at
                    ON shortcut_drafts(updated_at);
                CREATE TABLE IF NOT EXISTS shortcut_submission_audit (
                    submission_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    draft_id TEXT NOT NULL,
                    team_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    channel_id TEXT NOT NULL,
                    offered_message_ts_json TEXT NOT NULL,
                    selected_message_ts_json TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN (
                        'processing', 'created', 'existing', 'partial', 'failed'
                    )),
                    issue_key TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS shortcut_submission_audit_created_at
                    ON shortcut_submission_audit(created_at);
                """
            )

    def add(
        self,
        *,
        team_id: str,
        user_id: str,
        channel_id: str,
        message_ts: str,
        payload: dict,
    ) -> DraftSnapshot:
        serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        if len(serialized.encode("utf-8")) > _MAX_MESSAGE_PAYLOAD_BYTES:
            raise SourceValidationError("Slack message is too large for the draft")

        now = datetime.now(UTC)
        now_text = now.isoformat()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._prune(connection, now)
            row = connection.execute(
                """
                SELECT draft_id FROM shortcut_drafts
                 WHERE team_id=? AND user_id=? AND channel_id=?
                """,
                (team_id, user_id, channel_id),
            ).fetchone()
            if row is None:
                draft_id = uuid.uuid4().hex
                connection.execute(
                    """
                    INSERT INTO shortcut_drafts(
                        draft_id, team_id, user_id, channel_id, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (draft_id, team_id, user_id, channel_id, now_text, now_text),
                )
            else:
                draft_id = str(row["draft_id"])

            existing = connection.execute(
                """
                SELECT 1 FROM shortcut_draft_messages
                 WHERE draft_id=? AND message_ts=?
                """,
                (draft_id, message_ts),
            ).fetchone()
            count = int(
                connection.execute(
                    "SELECT COUNT(*) FROM shortcut_draft_messages WHERE draft_id=?",
                    (draft_id,),
                ).fetchone()[0]
            )
            if existing is None and count >= _MAX_DRAFT_MESSAGES:
                connection.rollback()
                raise SourceValidationError(
                    "Slack draft already contains the maximum of 20 messages"
                )
            connection.execute(
                """
                INSERT INTO shortcut_draft_messages(
                    draft_id, message_ts, payload_json, added_at
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT(draft_id, message_ts) DO UPDATE SET
                    payload_json=excluded.payload_json
                """,
                (draft_id, message_ts, serialized, now_text),
            )
            connection.execute(
                "UPDATE shortcut_drafts SET updated_at=? WHERE draft_id=?",
                (now_text, draft_id),
            )
            connection.commit()
        return self.get(
            draft_id=draft_id,
            team_id=team_id,
            user_id=user_id,
            channel_id=channel_id,
        )

    def replace(
        self,
        *,
        team_id: str,
        user_id: str,
        channel_id: str,
        messages: tuple[tuple[str, dict], ...],
    ) -> DraftSnapshot:
        if not 1 <= len(messages) <= _MAX_DRAFT_MESSAGES:
            raise SourceValidationError(
                "Slack history picker must contain between 1 and 20 messages"
            )
        timestamps = tuple(message_ts for message_ts, _payload in messages)
        if len(set(timestamps)) != len(timestamps):
            raise SourceValidationError("Slack history picker contains duplicates")

        serialized_messages = []
        for message_ts, payload in sorted(messages, key=lambda item: float(item[0])):
            serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            if len(serialized.encode("utf-8")) > _MAX_MESSAGE_PAYLOAD_BYTES:
                raise SourceValidationError(
                    "Slack message is too large for the history picker"
                )
            serialized_messages.append((message_ts, serialized))

        now = datetime.now(UTC)
        now_text = now.isoformat()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._prune(connection, now)
            row = connection.execute(
                """
                SELECT draft_id FROM shortcut_drafts
                 WHERE team_id=? AND user_id=? AND channel_id=?
                """,
                (team_id, user_id, channel_id),
            ).fetchone()
            if row is None:
                draft_id = uuid.uuid4().hex
                connection.execute(
                    """
                    INSERT INTO shortcut_drafts(
                        draft_id, team_id, user_id, channel_id, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (draft_id, team_id, user_id, channel_id, now_text, now_text),
                )
            else:
                draft_id = str(row["draft_id"])
                connection.execute(
                    "DELETE FROM shortcut_draft_messages WHERE draft_id=?",
                    (draft_id,),
                )
            connection.executemany(
                """
                INSERT INTO shortcut_draft_messages(
                    draft_id, message_ts, payload_json, added_at
                ) VALUES (?, ?, ?, ?)
                """,
                (
                    (draft_id, message_ts, serialized, now_text)
                    for message_ts, serialized in serialized_messages
                ),
            )
            connection.execute(
                "UPDATE shortcut_drafts SET updated_at=? WHERE draft_id=?",
                (now_text, draft_id),
            )
            connection.commit()
        return self.get(
            draft_id=draft_id,
            team_id=team_id,
            user_id=user_id,
            channel_id=channel_id,
        )

    def select(
        self,
        *,
        draft_id: str,
        team_id: str,
        user_id: str,
        channel_id: str,
        selected_message_ts: tuple[str, ...],
    ) -> DraftSnapshot:
        snapshot = self.get(
            draft_id=draft_id,
            team_id=team_id,
            user_id=user_id,
            channel_id=channel_id,
        )
        available = {message.message_ts: message for message in snapshot.messages}
        if not selected_message_ts:
            raise SourceValidationError("Select at least one Slack message")
        if any(value not in available for value in selected_message_ts):
            raise SourceValidationError("Slack draft selection is no longer valid")
        selected = tuple(
            available[value] for value in sorted(selected_message_ts, key=float)
        )
        return DraftSnapshot(
            draft_id=snapshot.draft_id,
            team_id=snapshot.team_id,
            user_id=snapshot.user_id,
            channel_id=snapshot.channel_id,
            messages=selected,
        )

    def get(
        self, *, draft_id: str, team_id: str, user_id: str, channel_id: str
    ) -> DraftSnapshot:
        now = datetime.now(UTC)
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._prune(connection, now)
            row = connection.execute(
                """
                SELECT * FROM shortcut_drafts
                 WHERE draft_id=? AND team_id=? AND user_id=? AND channel_id=?
                """,
                (draft_id, team_id, user_id, channel_id),
            ).fetchone()
            if row is None:
                connection.rollback()
                raise SourceValidationError(
                    "Slack ticket draft was not found or expired"
                )
            messages = connection.execute(
                """
                SELECT message_ts, payload_json
                  FROM shortcut_draft_messages
                 WHERE draft_id=? ORDER BY CAST(message_ts AS REAL), added_at
                """,
                (draft_id,),
            ).fetchall()
            connection.commit()
        if not messages:
            raise SourceValidationError("Slack ticket draft is empty")
        return DraftSnapshot(
            draft_id=draft_id,
            team_id=team_id,
            user_id=user_id,
            channel_id=channel_id,
            messages=tuple(
                DraftMessage(
                    message_ts=str(message["message_ts"]),
                    payload=json.loads(str(message["payload_json"])),
                )
                for message in messages
            ),
        )

    def clear(
        self, *, draft_id: str, team_id: str, user_id: str, channel_id: str
    ) -> bool:
        with self._connect() as connection:
            cursor = connection.execute(
                """
                DELETE FROM shortcut_drafts
                 WHERE draft_id=? AND team_id=? AND user_id=? AND channel_id=?
                """,
                (draft_id, team_id, user_id, channel_id),
            )
        return cursor.rowcount == 1

    def begin_submission_audit(
        self,
        *,
        snapshot: DraftSnapshot,
        selected_message_ts: tuple[str, ...],
    ) -> int:
        offered = tuple(message.message_ts for message in snapshot.messages)
        if not selected_message_ts or any(
            value not in offered for value in selected_message_ts
        ):
            raise SourceValidationError("Slack draft selection is no longer valid")
        now = datetime.now(UTC)
        now_text = now.isoformat()
        with self._connect() as connection:
            self._prune_audit(connection, now)
            cursor = connection.execute(
                """
                INSERT INTO shortcut_submission_audit(
                    draft_id, team_id, user_id, channel_id,
                    offered_message_ts_json, selected_message_ts_json,
                    status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'processing', ?, ?)
                """,
                (
                    snapshot.draft_id,
                    snapshot.team_id,
                    snapshot.user_id,
                    snapshot.channel_id,
                    json.dumps(offered, separators=(",", ":")),
                    json.dumps(
                        tuple(sorted(selected_message_ts, key=float)),
                        separators=(",", ":"),
                    ),
                    now_text,
                    now_text,
                ),
            )
            return int(cursor.lastrowid)

    def finish_submission_audit(
        self,
        submission_id: int,
        *,
        status: str,
        issue_key: str | None = None,
    ) -> None:
        if status not in _AUDIT_STATUSES or status == "processing":
            raise ValueError("invalid final Slack submission audit status")
        with self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE shortcut_submission_audit
                   SET status=?, issue_key=?, updated_at=?
                 WHERE submission_id=? AND status='processing'
                """,
                (status, issue_key, datetime.now(UTC).isoformat(), submission_id),
            )
            if cursor.rowcount != 1:
                raise RuntimeError("Slack submission audit was not pending")

    def _prune(self, connection: sqlite3.Connection, now: datetime) -> None:
        cutoff = (now - self.expires_after).isoformat()
        connection.execute(
            "DELETE FROM shortcut_drafts WHERE updated_at < ?", (cutoff,)
        )

    @staticmethod
    def _prune_audit(connection: sqlite3.Connection, now: datetime) -> None:
        cutoff = (now - _AUDIT_RETENTION).isoformat()
        connection.execute(
            "DELETE FROM shortcut_submission_audit WHERE created_at < ?", (cutoff,)
        )
