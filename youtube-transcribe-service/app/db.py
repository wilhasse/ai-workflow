from datetime import datetime

import pymysql
from pymysql.cursors import DictCursor

from .config import config

COLUMNS = [
    "video_id", "url", "title", "channel", "duration_seconds", "language",
    "model", "status", "error", "transcript_text", "created_at", "updated_at",
]

UPSERT_SQL = (
    "INSERT INTO youtube_transcripts ("
    + ", ".join(COLUMNS)
    + ") VALUES (" + ", ".join(["%s"] * len(COLUMNS)) + ")"
)

DDL = """
CREATE TABLE IF NOT EXISTS youtube_transcripts (
    video_id         VARCHAR(32)   NOT NULL,
    url              VARCHAR(512)  DEFAULT NULL,
    title            STRING        DEFAULT NULL,
    channel          STRING        DEFAULT NULL,
    duration_seconds INT           NOT NULL DEFAULT 0,
    language         VARCHAR(16)   DEFAULT NULL,
    model            VARCHAR(32)   DEFAULT NULL,
    status           VARCHAR(16)   NOT NULL DEFAULT 'queued',
    error            STRING        DEFAULT NULL,
    transcript_text  STRING        DEFAULT NULL,
    created_at       DATETIME      NOT NULL,
    updated_at       DATETIME      NOT NULL,
    INDEX idx_transcript_text (transcript_text) USING INVERTED PROPERTIES("parser" = "unicode", "support_phrase" = "true")
)
UNIQUE KEY(video_id)
DISTRIBUTED BY HASH(video_id) BUCKETS 4
PROPERTIES ("replication_num" = "1")
"""


def connect():
    return pymysql.connect(
        host=config.doris["host"], port=config.doris["port"],
        user=config.doris["user"], password=config.doris["password"],
        database=config.doris["database"], cursorclass=DictCursor,
        charset="utf8mb4", autocommit=True, read_timeout=60, write_timeout=60,
    )


def check_connection() -> bool:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1")
        cur.fetchone()
    return True


def ensure_schema() -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(DDL)


def row_to_dict(row: dict) -> dict:
    out = dict(row)
    for key in ("created_at", "updated_at"):
        value = out.get(key)
        out[key] = value.isoformat() if isinstance(value, datetime) else value
    return out


def upsert(record: dict) -> None:
    values = [record.get(col) for col in COLUMNS]
    with connect() as conn, conn.cursor() as cur:
        cur.execute(UPSERT_SQL, values)


def get(video_id: str) -> dict | None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT * FROM youtube_transcripts WHERE video_id = %s", (video_id,))
        row = cur.fetchone()
    return row_to_dict(row) if row else None


def list_recent(limit: int = 100) -> list:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT * FROM youtube_transcripts ORDER BY created_at DESC LIMIT %s", (limit,))
        rows = cur.fetchall()
    return [row_to_dict(r) for r in rows]


def recover_pending() -> list:
    """On startup: return queued video_ids to re-enqueue; mark orphaned
    'processing' rows as failed (their temp audio is gone)."""
    now = datetime.now()
    requeue = []
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT * FROM youtube_transcripts WHERE status IN ('queued', 'processing')")
        rows = cur.fetchall()
    for row in rows:
        if row["status"] == "queued":
            requeue.append(row["video_id"])
        else:
            failed = dict(row)
            failed["status"] = "failed"
            failed["error"] = "Interrupted by service restart"
            failed["updated_at"] = now
            upsert(failed)
    return requeue
