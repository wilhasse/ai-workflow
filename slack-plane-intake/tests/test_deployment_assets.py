from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_examples_are_redacted_and_restricted():
    env_example = (ROOT / "deploy/hermes.env.example").read_text()
    config_example = (ROOT / "deploy/hermes-config.example.yaml").read_text()
    assert "xoxb-redacted" in env_example
    assert "xapp-redacted" in env_example
    assert "slack-plane-intake" in config_example
    assert "create_plane_problem" in config_example
    assert "terminal" in config_example
    assert "kanban" in config_example
    assert "whatsapp" not in config_example.lower()


def test_hermes_patch_exposes_only_transport_message_id():
    patch = (ROOT / "patches/hermes-slack-trigger-message-id.patch").read_text()
    assert "event.message_id" in patch
    assert "Platform.SLACK" in patch
    assert "SLACK_BOT_TOKEN" not in patch
    assert "raw_message" not in patch
