from __future__ import annotations

import re
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from slack_plane_intake.models import SourceMessage, SourceMessagePart


def part(message_ts: str, text: str) -> SourceMessagePart:
    return SourceMessagePart(
        message_ts=message_ts,
        author_id="U1",
        author_name="Operator",
        text=text,
        permalink=f"https://slack.test/{message_ts}",
        posted_at=datetime.fromtimestamp(float(message_ts), tz=UTC),
    )


def test_multi_message_source_has_stable_bundle_key_and_combined_text():
    source = SourceMessage(
        team_id="T1",
        channel_id="D1",
        messages=(
            part("1724440000.000001", "first"),
            part("1724440001.000001", "second"),
        ),
    )

    assert re.fullmatch(r"slack-bundle:T1:D1:[0-9a-f]{64}", source.source_key)
    assert "first" in source.text
    assert "second" in source.text
    assert source.message_ts == "1724440001.000001"


def test_multi_message_source_rejects_duplicates_and_non_chronological_order():
    first = part("1724440000.000001", "first")
    second = part("1724440001.000001", "second")
    with pytest.raises(ValidationError, match="unique"):
        SourceMessage(team_id="T1", channel_id="D1", messages=(first, first))
    with pytest.raises(ValidationError, match="chronological"):
        SourceMessage(team_id="T1", channel_id="D1", messages=(second, first))


def test_multi_message_source_accepts_twenty_and_rejects_twenty_one():
    messages = tuple(
        part(f"17244400{index:02d}.000001", f"message {index + 1}")
        for index in range(21)
    )

    source = SourceMessage(team_id="T1", channel_id="D1", messages=messages[:20])
    assert len(source.messages) == 20

    with pytest.raises(ValidationError, match="20"):
        SourceMessage(team_id="T1", channel_id="D1", messages=messages)
