from pathlib import Path

from app import worker


class FakeStore:
    def __init__(self, initial):
        self.rows = {r["video_id"]: dict(r) for r in initial}
    def get(self, vid):
        return self.rows.get(vid)
    def upsert(self, record):
        self.rows[record["video_id"]] = dict(record)


def make_deps(store, *, transcript="hello world", raise_on=None):
    def fetch_metadata(url):
        return {"video_id": "vid", "title": "T", "channel": "C", "duration_seconds": 42}
    def download_audio(url, workdir):
        p = Path(workdir) / "audio.m4a"
        p.write_bytes(b"x")
        return p
    def deepgram_transcribe(path, key, params):
        if raise_on == "deepgram":
            raise RuntimeError("Deepgram HTTP 401: bad key")
        return {"results": {"channels": [{"alternatives": [{"transcript": transcript}]}]},
                "metadata": {"duration": 42}}
    return worker.Deps(
        store_get=store.get, store_upsert=store.upsert,
        fetch_metadata=fetch_metadata, download_audio=download_audio,
        deepgram_transcribe=deepgram_transcribe, api_key="k", model="nova-3",
    )


def test_process_job_success_marks_done_with_text():
    store = FakeStore([{"video_id": "vid", "url": "u", "status": "queued"}])
    worker.process_job("vid", make_deps(store))
    row = store.get("vid")
    assert row["status"] == "done"
    assert row["transcript_text"] == "hello world"
    assert row["title"] == "T"
    assert row["duration_seconds"] == 42


def test_process_job_failure_marks_failed_with_error():
    store = FakeStore([{"video_id": "vid", "url": "u", "status": "queued"}])
    worker.process_job("vid", make_deps(store, raise_on="deepgram"))
    row = store.get("vid")
    assert row["status"] == "failed"
    assert "Deepgram HTTP 401" in row["error"]
