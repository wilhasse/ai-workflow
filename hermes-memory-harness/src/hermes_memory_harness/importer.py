from __future__ import annotations

import hashlib
from dataclasses import dataclass

from .doris import DorisClient, DorisMessage
from .hermes_sqlite import HermesStateStore, ImportSessionMeta


@dataclass(frozen=True)
class ImportStats:
    sessions_seen: int = 0
    sessions_imported: int = 0
    sessions_replaced: int = 0
    messages_imported: int = 0


def _map_role(role: str) -> str:
    normalized = (role or "").strip().lower()
    if normalized in {"user", "assistant", "tool", "system"}:
        return normalized
    return "assistant"


def _build_imported_session_id(source: str, session_id: str) -> str:
    return f"doris:{source}:{session_id}"


def _build_session_title(
    source: str,
    session_id: str,
    project: str | None,
    display_text: str | None,
) -> str | None:
    project_piece = project or source
    return f"{project_piece} :: {session_id}"[:100]


def _message_content(message: DorisMessage) -> str:
    if message.content_text.strip():
        return message.content_text
    if message.content_json and message.content_json.strip():
        return message.content_json
    return ""


def _message_fingerprint(message: DorisMessage) -> str:
    payload = "|".join(
        [
            message.role or "",
            message.msg_type or "",
            str(message.seq_num) if message.seq_num is not None else "",
            message.content_text or "",
            message.content_json or "",
        ]
    )
    return hashlib.sha256(payload.encode("utf-8", errors="ignore")).hexdigest()


def import_history(
    doris: DorisClient,
    hermes: HermesStateStore,
    *,
    source: str,
    project: str | None = None,
    limit_sessions: int | None = None,
    replace: bool = False,
    dry_run: bool = False,
) -> ImportStats:
    stats = ImportStats()

    for session in doris.iter_sessions(
        source,
        project=project,
        limit_sessions=limit_sessions,
    ):
        stats = ImportStats(
            sessions_seen=stats.sessions_seen + 1,
            sessions_imported=stats.sessions_imported,
            sessions_replaced=stats.sessions_replaced,
            messages_imported=stats.messages_imported,
        )
        imported_id = _build_imported_session_id(source, session.session_id)

        if dry_run:
            continue

        if replace and hermes.session_exists(imported_id):
            hermes.delete_session(imported_id)
            stats = ImportStats(
                sessions_seen=stats.sessions_seen,
                sessions_imported=stats.sessions_imported,
                sessions_replaced=stats.sessions_replaced + 1,
                messages_imported=stats.messages_imported,
            )
        elif hermes.session_exists(imported_id):
            continue

        hermes.upsert_session(
            ImportSessionMeta(
                imported_session_id=imported_id,
                source=f"history:{source}",
                started_at=session.started_at,
                title=_build_session_title(
                    source,
                    session.session_id,
                    session.project,
                    session.display_text,
                ),
                project=session.project,
                original_session_id=session.session_id,
            )
        )

        imported_messages = 0
        for message in doris.fetch_messages(source, session.session_id):
            content = _message_content(message)
            if not content.strip():
                continue
            inserted = hermes.append_imported_message_if_new(
                source=source,
                original_session_id=message.session_id,
                imported_session_id=imported_id,
                fingerprint=_message_fingerprint(message),
                role=_map_role(message.role),
                content=content,
                timestamp=message.ts,
            )
            if inserted:
                imported_messages += 1

        stats = ImportStats(
            sessions_seen=stats.sessions_seen,
            sessions_imported=stats.sessions_imported + 1,
            sessions_replaced=stats.sessions_replaced,
            messages_imported=stats.messages_imported + imported_messages,
        )

    if not dry_run:
        latest = doris.fetch_source_max_ts(source)
        if latest is not None:
            hermes.set_watermark(source, latest)

    return stats
