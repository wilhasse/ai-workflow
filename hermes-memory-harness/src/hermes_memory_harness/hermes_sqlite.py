from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


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
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);
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
        self._conn.execute("DELETE FROM schema_version")
        self._conn.execute(
            "INSERT INTO schema_version(version) VALUES (?)",
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

    def delete_session(self, session_id: str) -> None:
        self._conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
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

    def commit(self) -> None:
        self._conn.commit()
