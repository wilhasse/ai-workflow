from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import pymysql
from pymysql.cursors import DictCursor

from .config import DorisConfig


@dataclass(frozen=True)
class DorisSession:
    session_id: str
    source: str
    started_at: datetime | None
    project: str | None
    display_text: str | None
    message_count: int


@dataclass(frozen=True)
class DorisMessage:
    session_id: str
    source: str
    role: str
    msg_type: str | None
    seq_num: int | None
    ts: datetime | None
    content_text: str
    content_json: str | None


class DorisClient:
    def __init__(self, config: DorisConfig) -> None:
        self._config = config

    def _connect(self):
        return pymysql.connect(
            host=self._config.host,
            port=self._config.port,
            user=self._config.user,
            password=self._config.password,
            database=self._config.database,
            cursorclass=DictCursor,
            charset="utf8mb4",
            autocommit=True,
            read_timeout=60,
            write_timeout=60,
        )

    def fetch_source_stats(self) -> list[dict[str, Any]]:
        sql = """
            select source, min(ts) as min_ts, max(ts) as max_ts, count(*) as rows_in_messages
            from agent_messages
            group by source
            order by rows_in_messages desc
        """
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(sql)
            return list(cur.fetchall())

    def fetch_top_projects(self, source: str, limit: int = 15) -> list[dict[str, Any]]:
        sql = """
            select project, count(*) as session_count
            from agent_sessions
            where source = %s and project is not null and project != ''
            group by project
            order by session_count desc
            limit %s
        """
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(sql, (source, limit))
            return list(cur.fetchall())

    def iter_sessions(
        self,
        source: str,
        *,
        project: str | None = None,
        limit_sessions: int | None = None,
    ) -> Iterator[DorisSession]:
        sql = """
            select
                session_id,
                source,
                min(started_at) as started_at,
                max(project) as project,
                max(display_text) as display_text,
                count(*) as session_row_count
            from agent_sessions
            where source = %s
        """
        params: list[Any] = [source]
        if project:
            sql += " and project = %s"
            params.append(project)
        sql += """
            group by session_id, source
            order by min(started_at) asc
        """
        if limit_sessions is not None:
            sql += " limit %s"
            params.append(limit_sessions)
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            for row in cur.fetchall():
                yield DorisSession(
                    session_id=row["session_id"],
                    source=row["source"],
                    started_at=row["started_at"],
                    project=row["project"],
                    display_text=row["display_text"],
                    message_count=int(row["session_row_count"] or 0),
                )

    def fetch_messages(self, source: str, session_id: str) -> list[DorisMessage]:
        sql = """
            select
                session_id,
                source,
                msg_role,
                msg_type,
                seq_num,
                min(ts) as ts,
                content_text,
                max(content_json) as content_json
            from agent_messages
            where source = %s and session_id = %s
            group by session_id, source, msg_role, msg_type, seq_num, content_text
            order by
                case when seq_num is null then 2147483647 else seq_num end asc,
                min(ts) asc
        """
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(sql, (source, session_id))
            rows = cur.fetchall()
        return [
            DorisMessage(
                session_id=row["session_id"],
                source=row["source"],
                role=row["msg_role"],
                msg_type=row["msg_type"],
                seq_num=row["seq_num"],
                ts=row["ts"],
                content_text=row["content_text"] or "",
                content_json=row["content_json"],
            )
            for row in rows
        ]

    def fetch_message_volume(self, source: str) -> dict[str, Any]:
        sql = """
            select
                count(*) as total_rows,
                count(distinct session_id) as distinct_sessions
            from agent_messages
            where source = %s
        """
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(sql, (source,))
            return dict(cur.fetchone() or {})
