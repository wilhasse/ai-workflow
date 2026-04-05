from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 6

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    user_id TEXT,
    model TEXT,
    model_config TEXT,
    system_prompt TEXT,
    parent_session_id TEXT,
    started_at REAL NOT NULL,
    ended_at REAL,
    end_reason TEXT,
    message_count INTEGER DEFAULT 0,
    tool_call_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    billing_provider TEXT,
    billing_base_url TEXT,
    billing_mode TEXT,
    estimated_cost_usd REAL,
    actual_cost_usd REAL,
    cost_status TEXT,
    cost_source TEXT,
    pricing_version TEXT,
    title TEXT
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT,
    tool_call_id TEXT,
    tool_calls TEXT,
    tool_name TEXT,
    timestamp REAL NOT NULL,
    token_count INTEGER,
    finish_reason TEXT,
    reasoning TEXT,
    reasoning_details TEXT,
    codex_reasoning_items TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_title_unique ON sessions(title) WHERE title IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);

CREATE TABLE IF NOT EXISTS imported_message_fingerprints (
    source TEXT NOT NULL,
    original_session_id TEXT NOT NULL,
    imported_session_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    imported_at REAL NOT NULL,
    PRIMARY KEY (source, original_session_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS import_watermarks (
    source TEXT PRIMARY KEY,
    last_ts TEXT NOT NULL,
    updated_at REAL NOT NULL
);
"""

FTS_SQL = """
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content=messages,
    content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
"""


@dataclass(frozen=True)
class ImportSessionMeta:
    imported_session_id: str
    source: str
    started_at: datetime | None
    title: str | None
    project: str | None
    original_session_id: str


class HermesStateStore:
    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self._db_path))
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=OFF")
        self._initialize_schema()

    def close(self) -> None:
        self._conn.close()

    def _initialize_schema(self) -> None:
        self._conn.executescript(SCHEMA_SQL)
        self._conn.executescript(FTS_SQL)
        self._conn.execute(
            "INSERT OR REPLACE INTO schema_version(rowid, version) VALUES (1, ?)",
            (SCHEMA_VERSION,),
        )
        self._conn.commit()

    @staticmethod
    def _to_epoch(value: datetime | None) -> float:
        if value is None:
            return datetime.now(tz=timezone.utc).timestamp()
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.timestamp()

    @staticmethod
    def _to_iso(value: datetime) -> str:
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()

    @staticmethod
    def _from_iso(value: str | None) -> datetime | None:
        if not value:
            return None
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed

    def delete_session(self, session_id: str) -> None:
        self._conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
        self._conn.execute(
            "DELETE FROM imported_message_fingerprints WHERE imported_session_id = ?",
            (session_id,),
        )
        self._conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        self._conn.commit()

    def session_exists(self, session_id: str) -> bool:
        row = self._conn.execute(
            "SELECT 1 FROM sessions WHERE id = ? LIMIT 1",
            (session_id,),
        ).fetchone()
        return row is not None

    def upsert_session(self, meta: ImportSessionMeta) -> None:
        model_config = {
            "import_origin": "doris-agent_history",
            "project": meta.project,
            "original_session_id": meta.original_session_id,
        }
        self._conn.execute(
            """
            INSERT INTO sessions (
                id, source, model, model_config, started_at, title
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                source=excluded.source,
                model=excluded.model,
                model_config=excluded.model_config,
                started_at=excluded.started_at,
                title=excluded.title
            """,
            (
                meta.imported_session_id,
                meta.source,
                "historical-import",
                json.dumps(model_config),
                self._to_epoch(meta.started_at),
                meta.title,
            ),
        )
        self._conn.commit()

    def append_message(
        self,
        *,
        session_id: str,
        role: str,
        content: str,
        timestamp: datetime | None,
    ) -> None:
        self._conn.execute(
            """
            INSERT INTO messages (
                session_id, role, content, timestamp
            ) VALUES (?, ?, ?, ?)
            """,
            (session_id, role, content, self._to_epoch(timestamp)),
        )
        self._conn.execute(
            "UPDATE sessions SET message_count = COALESCE(message_count, 0) + 1 WHERE id = ?",
            (session_id,),
        )

    def append_imported_message_if_new(
        self,
        *,
        source: str,
        original_session_id: str,
        imported_session_id: str,
        fingerprint: str,
        role: str,
        content: str,
        timestamp: datetime | None,
    ) -> bool:
        inserted = False
        cursor = self._conn.execute(
            """
            INSERT OR IGNORE INTO imported_message_fingerprints (
                source, original_session_id, imported_session_id, fingerprint, imported_at
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (
                source,
                original_session_id,
                imported_session_id,
                fingerprint,
                datetime.now(tz=timezone.utc).timestamp(),
            ),
        )
        if cursor.rowcount:
            self.append_message(
                session_id=imported_session_id,
                role=role,
                content=content,
                timestamp=timestamp,
            )
            self._conn.commit()
            inserted = True
        return inserted

    def get_watermark(self, source: str) -> datetime | None:
        row = self._conn.execute(
            "SELECT last_ts FROM import_watermarks WHERE source = ?",
            (source,),
        ).fetchone()
        return self._from_iso(row[0] if row else None)

    def set_watermark(self, source: str, value: datetime) -> None:
        self._conn.execute(
            """
            INSERT INTO import_watermarks (source, last_ts, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(source) DO UPDATE SET
                last_ts=excluded.last_ts,
                updated_at=excluded.updated_at
            """,
            (source, self._to_iso(value), datetime.now(tz=timezone.utc).timestamp()),
        )
        self._conn.commit()

    def all_watermarks(self) -> dict[str, datetime | None]:
        rows = self._conn.execute(
            "SELECT source, last_ts FROM import_watermarks ORDER BY source"
        ).fetchall()
        return {row[0]: self._from_iso(row[1]) for row in rows}

    def count_sessions_by_source(self) -> list[tuple[str, int]]:
        rows = self._conn.execute(
            "SELECT source, count(*) FROM sessions GROUP BY source ORDER BY count(*) DESC"
        ).fetchall()
        return [(row[0], row[1]) for row in rows]

    def count_messages_for_source(self, source: str) -> int:
        row = self._conn.execute(
            "SELECT count(*) FROM messages m JOIN sessions s ON s.id = m.session_id WHERE s.source = ?",
            (source,),
        ).fetchone()
        return int(row[0] if row else 0)

    def commit(self) -> None:
        self._conn.commit()
