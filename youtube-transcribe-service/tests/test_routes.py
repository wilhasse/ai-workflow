from fastapi.testclient import TestClient

import app.main as main


class FakeQueue:
    def __init__(self):
        self.enqueued = []
    def enqueue(self, vid):
        self.enqueued.append(vid)


def setup_function():
    main._STORE = {}
    main.queue = FakeQueue()
    main.db.get = lambda vid: main._STORE.get(vid)
    main.db.list_recent = lambda limit=100: list(main._STORE.values())
    def fake_upsert(record):
        main._STORE[record["video_id"]] = dict(record)
    main.db.upsert = fake_upsert


client = TestClient(main.app)


def test_post_job_rejects_bad_url():
    resp = client.post("/jobs", json={"url": "https://example.com/nope"})
    assert resp.status_code == 400


def test_post_job_enqueues_new_video():
    resp = client.post("/jobs", json={"url": "https://youtu.be/q9xD36NCtZ8"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["video_id"] == "q9xD36NCtZ8"
    assert body["status"] == "queued"
    assert "q9xD36NCtZ8" in main.queue.enqueued


def test_post_job_reuses_done_video_without_enqueue():
    main._STORE["q9xD36NCtZ8"] = {
        "video_id": "q9xD36NCtZ8", "status": "done", "transcript_text": "hi",
        "url": "https://youtu.be/q9xD36NCtZ8",
    }
    resp = client.post("/jobs", json={"url": "https://youtu.be/q9xD36NCtZ8"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "done"
    assert main.queue.enqueued == []


def test_get_jobs_lists_records():
    main._STORE["a"] = {"video_id": "a", "status": "done"}
    resp = client.get("/jobs")
    assert resp.status_code == 200
    assert any(j["video_id"] == "a" for j in resp.json())


def test_get_job_detail_404_when_missing():
    assert client.get("/jobs/missing").status_code == 404
