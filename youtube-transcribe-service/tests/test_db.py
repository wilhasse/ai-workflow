from app import db


def test_row_to_dict_serializes_datetimes():
    from datetime import datetime
    row = {
        "video_id": "abc", "url": "u", "title": "t", "channel": "c",
        "duration_seconds": 10, "language": "en", "model": "nova-3",
        "status": "done", "error": None, "transcript_text": "hi",
        "created_at": datetime(2026, 5, 31, 12, 0, 0),
        "updated_at": datetime(2026, 5, 31, 12, 1, 0),
    }
    out = db.row_to_dict(row)
    assert out["video_id"] == "abc"
    assert out["created_at"] == "2026-05-31T12:00:00"
    assert out["updated_at"] == "2026-05-31T12:01:00"


def test_row_to_dict_handles_none_datetimes():
    out = db.row_to_dict({"video_id": "x", "created_at": None, "updated_at": None})
    assert out["created_at"] is None
    assert out["updated_at"] is None


def test_upsert_sql_lists_all_columns():
    sql = db.UPSERT_SQL
    for col in ("video_id", "url", "title", "channel", "duration_seconds",
                "language", "model", "status", "error", "transcript_text",
                "created_at", "updated_at"):
        assert col in sql
    assert sql.count("%s") == 12
