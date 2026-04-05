from __future__ import annotations

import hashlib
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from .doris import DorisClient, DorisMessage
from .hermes_sqlite import HermesStateStore, ImportSessionMeta
from .importer import _build_imported_session_id, _build_session_title, _map_role, _message_content

logger = logging.getLogger(__name__)

WATERMARK_OVERLAP_SECONDS = 1


@dataclass(frozen=True)
class SyncStats:
    source: str
    watermark_initialized: bool = False
    messages_seen: int = 0
    messages_imported: int = 0
    messages_skipped: int = 0
    sessions_upserted: int = 0
    watermark: datetime | None = None


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


def _normalize_ts(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _query_floor(watermark: datetime) -> datetime:
    return _normalize_ts(watermark) - timedelta(seconds=WATERMARK_OVERLAP_SECONDS)


def sync_source_once(
    doris: DorisClient,
    hermes: HermesStateStore,
    *,
    source: str,
    dry_run: bool = False,
) -> SyncStats:
    current_max = doris.fetch_source_max_ts(source)
    if current_max is not None:
        current_max = _normalize_ts(current_max)
    watermark = hermes.get_watermark(source)

    if current_max is None:
        return SyncStats(source=source, watermark=watermark)

    if watermark is None:
        if not dry_run:
            hermes.set_watermark(source, current_max)
        return SyncStats(
            source=source,
            watermark_initialized=True,
            watermark=current_max,
        )

    messages = doris.fetch_messages_since(source, _query_floor(watermark))
    if not messages:
        if current_max > watermark and not dry_run:
            hermes.set_watermark(source, current_max)
            watermark = current_max
        return SyncStats(source=source, watermark=watermark)

    sessions_cache: dict[str, ImportSessionMeta] = {}
    messages_imported = 0
    messages_skipped = 0
    sessions_upserted = 0
    latest_seen = watermark

    for message in messages:
        if message.ts:
            message_ts = _normalize_ts(message.ts)
            if message_ts > latest_seen:
                latest_seen = message_ts

        meta = sessions_cache.get(message.session_id)
        if meta is None:
            session = doris.fetch_session_metadata(source, message.session_id)
            if session is None:
                messages_skipped += 1
                continue
            meta = ImportSessionMeta(
                imported_session_id=_build_imported_session_id(source, session.session_id),
                source=f"history:{source}",
                started_at=session.started_at,
                title=_build_session_title(source, session.session_id, session.project, session.display_text),
                project=session.project,
                original_session_id=session.session_id,
            )
            sessions_cache[message.session_id] = meta
            if not dry_run:
                hermes.upsert_session(meta)
            sessions_upserted += 1

        content = _message_content(message)
        if not content.strip():
            messages_skipped += 1
            continue

        if dry_run:
            messages_imported += 1
            continue

        inserted = hermes.append_imported_message_if_new(
            source=source,
            original_session_id=message.session_id,
            imported_session_id=meta.imported_session_id,
            fingerprint=_message_fingerprint(message),
            role=_map_role(message.role),
            content=content,
            timestamp=message.ts,
        )
        if inserted:
            messages_imported += 1
        else:
            messages_skipped += 1

    if not dry_run and latest_seen:
        hermes.set_watermark(source, latest_seen)

    return SyncStats(
        source=source,
        messages_seen=len(messages),
        messages_imported=messages_imported,
        messages_skipped=messages_skipped,
        sessions_upserted=sessions_upserted,
        watermark=latest_seen,
    )


def run_service(
    doris: DorisClient,
    hermes: HermesStateStore,
    *,
    sources: list[str],
    poll_interval_seconds: int,
) -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    logger.info("starting incremental sync service for sources=%s poll_interval=%ss", ",".join(sources), poll_interval_seconds)
    while True:
        for source in sources:
            try:
                stats = sync_source_once(doris, hermes, source=source)
                logger.info(
                    "source=%s initialized=%s seen=%s imported=%s skipped=%s sessions_upserted=%s watermark=%s",
                    stats.source,
                    stats.watermark_initialized,
                    stats.messages_seen,
                    stats.messages_imported,
                    stats.messages_skipped,
                    stats.sessions_upserted,
                    stats.watermark.isoformat() if stats.watermark else None,
                )
            except Exception:
                logger.exception("incremental sync failed for source=%s", source)
        time.sleep(poll_interval_seconds)
