from __future__ import annotations

import json
import sqlite3
from datetime import timedelta

import pytest

from slack_plane_intake.drafts import DraftStore
from slack_plane_intake.errors import SourceValidationError


def message(message_ts: str, text: str = "alert") -> dict:
    return {"ts": message_ts, "text": text, "files": []}


def test_draft_is_per_user_conversation_durable_and_idempotent(tmp_path):
    path = tmp_path / "state.sqlite3"
    store = DraftStore(path)
    first = store.add(
        team_id="T1",
        user_id="U1",
        channel_id="D1",
        message_ts="1724440000.000001",
        payload=message("1724440000.000001", "first"),
    )
    repeated = store.add(
        team_id="T1",
        user_id="U1",
        channel_id="D1",
        message_ts="1724440000.000001",
        payload=message("1724440000.000001", "updated"),
    )
    other_channel = store.add(
        team_id="T1",
        user_id="U1",
        channel_id="D2",
        message_ts="1724440001.000001",
        payload=message("1724440001.000001"),
    )

    reopened = DraftStore(path).get(
        draft_id=first.draft_id,
        team_id="T1",
        user_id="U1",
        channel_id="D1",
    )
    assert repeated.draft_id == first.draft_id
    assert len(reopened.messages) == 1
    assert reopened.messages[0].payload["text"] == "updated"
    assert other_channel.draft_id != first.draft_id


def test_draft_selection_fails_closed_and_clear_checks_owner(tmp_path):
    store = DraftStore(tmp_path / "state.sqlite3")
    snapshot = store.add(
        team_id="T1",
        user_id="U1",
        channel_id="D1",
        message_ts="1724440000.000001",
        payload=message("1724440000.000001"),
    )
    with pytest.raises(SourceValidationError, match="selection"):
        store.select(
            draft_id=snapshot.draft_id,
            team_id="T1",
            user_id="U1",
            channel_id="D1",
            selected_message_ts=("1724440999.000001",),
        )
    assert not store.clear(
        draft_id=snapshot.draft_id,
        team_id="T1",
        user_id="UOTHER",
        channel_id="D1",
    )
    assert store.get(
        draft_id=snapshot.draft_id,
        team_id="T1",
        user_id="U1",
        channel_id="D1",
    )


def test_draft_rejects_twenty_first_message_and_expired_draft(tmp_path):
    path = tmp_path / "state.sqlite3"
    store = DraftStore(path)
    snapshot = None
    for index in range(20):
        ts = f"17244400{index:02d}.000001"
        snapshot = store.add(
            team_id="T1",
            user_id="U1",
            channel_id="D1",
            message_ts=ts,
            payload=message(ts),
        )
    with pytest.raises(SourceValidationError, match="maximum"):
        store.add(
            team_id="T1",
            user_id="U1",
            channel_id="D1",
            message_ts="1724440999.000001",
            payload=message("1724440999.000001"),
        )

    expiring = DraftStore(path, expires_after=timedelta(microseconds=-1))
    assert snapshot is not None
    with pytest.raises(SourceValidationError, match="not found or expired"):
        expiring.get(
            draft_id=snapshot.draft_id,
            team_id="T1",
            user_id="U1",
            channel_id="D1",
        )


def test_history_window_atomically_replaces_collected_candidates(tmp_path):
    store = DraftStore(tmp_path / "state.sqlite3")
    collected = store.add(
        team_id="T1",
        user_id="U1",
        channel_id="D1",
        message_ts="1724439999.000001",
        payload=message("1724439999.000001", "old candidate"),
    )

    replaced = store.replace(
        team_id="T1",
        user_id="U1",
        channel_id="D1",
        messages=(
            (
                "1724440000.000001",
                message("1724440000.000001", "first"),
            ),
            (
                "1724440001.000001",
                message("1724440001.000001", "second"),
            ),
        ),
    )

    assert replaced.draft_id == collected.draft_id
    assert [item.payload["text"] for item in replaced.messages] == [
        "first",
        "second",
    ]


def test_submission_audit_retains_only_ids_timestamps_and_outcome(tmp_path):
    path = tmp_path / "state.sqlite3"
    store = DraftStore(path)
    snapshot = store.replace(
        team_id="T1",
        user_id="U1",
        channel_id="D1",
        messages=(
            (
                "1724440000.000001",
                message("1724440000.000001", "private Sunday text"),
            ),
            (
                "1724440001.000001",
                message("1724440001.000001", "private Tuesday text"),
            ),
        ),
    )

    submission_id = store.begin_submission_audit(
        snapshot=snapshot,
        selected_message_ts=("1724440001.000001",),
    )
    store.finish_submission_audit(
        submission_id,
        status="created",
        issue_key="AGENTE-6",
    )

    with sqlite3.connect(path) as connection:
        row = connection.execute(
            "SELECT * FROM shortcut_submission_audit WHERE submission_id=?",
            (submission_id,),
        ).fetchone()
        columns = tuple(
            value[1]
            for value in connection.execute(
                "PRAGMA table_info(shortcut_submission_audit)"
            )
        )
    assert row is not None
    audit = dict(zip(columns, row, strict=True))
    assert json.loads(audit["offered_message_ts_json"]) == [
        "1724440000.000001",
        "1724440001.000001",
    ]
    assert json.loads(audit["selected_message_ts_json"]) == ["1724440001.000001"]
    assert audit["status"] == "created"
    assert audit["issue_key"] == "AGENTE-6"
    assert "private" not in json.dumps(audit)
