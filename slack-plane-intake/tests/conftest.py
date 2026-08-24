from __future__ import annotations

from datetime import UTC, datetime

import pytest

from slack_plane_intake.config import LimitConfig
from slack_plane_intake.models import SourceMessage


@pytest.fixture
def required_env(tmp_path):
    return {
        "SPI_SLACK_BOT_TOKEN": "xoxb-test-secret",
        "SPI_SLACK_CHANNEL_ID": "DINTAKE",
        "SPI_SLACK_ALLOWED_USERS": "U1,U2",
        "SPI_CLIPROXY_API_KEY": "model-secret",
        "SPI_PLANE_API_KEY": "plane-secret",
        "SPI_PLANE_PROJECT_ID": "project-uuid",
        "SPI_PLANE_STATE_ID": "state-uuid",
        "SPI_STATE_ROOT": str(tmp_path),
    }


@pytest.fixture
def limits():
    return LimitConfig(
        max_files=10,
        max_file_bytes=20 * 1024 * 1024,
        max_total_bytes=100 * 1024 * 1024,
        max_text_chars=100_000,
        max_pdf_pages=10,
    )


@pytest.fixture
def source_message():
    return SourceMessage(
        team_id="T1",
        channel_id="DINTAKE",
        message_ts="1724440000.123456",
        author_id="U1",
        author_name="Operator",
        text="<@UBOT> problema: API returns HTTP 500",
        permalink="https://example.slack.com/archives/DINTAKE/p1724440000123456",
        posted_at=datetime(2026, 8, 23, tzinfo=UTC),
    )
