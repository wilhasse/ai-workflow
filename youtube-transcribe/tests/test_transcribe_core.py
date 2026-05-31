import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import transcribe_core as core


def test_video_id_from_standard_watch_url():
    assert core.video_id_from_url("https://www.youtube.com/watch?v=q9xD36NCtZ8") == "q9xD36NCtZ8"


def test_video_id_from_short_url():
    assert core.video_id_from_url("https://youtu.be/q9xD36NCtZ8?si=abc") == "q9xD36NCtZ8"


def test_video_id_from_embed_and_extra_params():
    assert core.video_id_from_url("https://www.youtube.com/embed/q9xD36NCtZ8") == "q9xD36NCtZ8"
    assert core.video_id_from_url("https://m.youtube.com/watch?feature=x&v=q9xD36NCtZ8") == "q9xD36NCtZ8"


def test_video_id_from_invalid_url_returns_none():
    assert core.video_id_from_url("https://example.com/not-a-video") is None


def test_extract_transcript_uses_paragraphs():
    result = {
        "results": {
            "channels": [
                {
                    "alternatives": [
                        {
                            "transcript": "flat text",
                            "paragraphs": {"transcript": "nice paragraphs"},
                            "words": [],
                        }
                    ]
                }
            ]
        }
    }
    assert core.extract_transcript(result, diarize=False) == "nice paragraphs"


def test_extract_transcript_diarized_groups_speakers():
    result = {
        "results": {
            "channels": [
                {
                    "alternatives": [
                        {
                            "transcript": "",
                            "words": [
                                {"word": "hi", "punctuated_word": "Hi", "speaker": 0},
                                {"word": "there", "punctuated_word": "there", "speaker": 0},
                                {"word": "yo", "punctuated_word": "Yo", "speaker": 1},
                            ],
                        }
                    ]
                }
            ]
        }
    }
    out = core.extract_transcript(result, diarize=True)
    assert out == "Speaker 0: Hi there\nSpeaker 1: Yo"
