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
    assert config_example.startswith("_config_version: 38\n")


def test_hermes_patch_exposes_only_transport_message_id():
    patch = (ROOT / "patches/hermes-slack-trigger-message-id.patch").read_text()
    assert "event.message_id" in patch
    assert "Platform.SLACK" in patch
    assert "SLACK_BOT_TOKEN" not in patch
    assert "raw_message" not in patch


def test_target_installer_builds_venv_at_final_path():
    installer = (ROOT / "scripts/install-release-target.sh").read_text()
    move = installer.index('mv -- "$staging_dir" "$release_dir"')
    venv = installer.index('python3 -m venv "$release_dir/venv"')
    assert move < venv
    assert 'python3 -m venv "$staging_dir/venv"' not in installer


def test_hermes_installer_includes_slack_and_mcp_clients():
    installer = (ROOT / "scripts/install-hermes-godev.sh").read_text()
    assert '"$release_dir[slack,mcp]"' in installer
    assert "/home/cslog/.local/bin/hermes" in installer
