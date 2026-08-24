from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_examples_are_redacted_and_restricted():
    env_example = (ROOT / "deploy/hermes.env.example").read_text()
    config_example = (ROOT / "deploy/hermes-config.example.yaml").read_text()
    assert "xoxb-redacted" in env_example
    assert "xapp-redacted" in env_example
    assert "slack-plane-intake" in config_example
    assert "create_plane_problem" in config_example
    assert "slack: []" in config_example
    assert "terminal" in config_example
    assert "kanban" in config_example
    assert "whatsapp" not in config_example.lower()
    assert "disable_dms: false" in config_example
    assert "D_REDACTED" in env_example
    assert "SPI_PLANE_BASE_URL=https://plane.cslog.com.br" in env_example
    assert "SPI_PLANE_WORKSPACE=cslog" in env_example
    assert "SPI_PLANE_PROJECT_IDENTIFIER=AGENTE" in env_example
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


def test_activation_is_guarded_by_slack_and_single_owner_checks():
    local = (ROOT / "scripts/activate-godev.sh").read_text()
    target = (ROOT / "scripts/activate-target.py").read_text()
    assert "reference Hermes gateway is still running" in local
    assert "mcp test slack-plane-intake" in local
    assert "files:read" in target
    assert "conversations.open" in target
    assert "conversations.info" not in target
    assert "conversations.join" not in target
    assert "--channel-id" not in local
    assert "hermes-gateway-hardening.conf" in local
    assert "10-cslog-179-hardening.conf" in local
    assert "systemctl --user restart hermes-gateway.service" in local
    assert '"SLACK_HOME_CHANNEL": channel_id' in target
    assert "deploy/problem-intake/SKILL.md" in local


def test_problem_intake_reply_does_not_restate_source_fields():
    skill = (ROOT / "deploy/problem-intake/SKILL.md").read_text()
    assert "Do not summarize or restate fields" in skill
    assert "warnings verbatim" in skill
    assert "alter numeric values" in skill
    assert "PROB-N" not in skill
    assert "issue_key" in skill


def test_gateway_hardening_is_a_persistent_systemd_dropin():
    dropin = (ROOT / "deploy/hermes-gateway-hardening.conf").read_text()
    assert dropin.startswith("[Service]\n")
    assert "EnvironmentFile=/home/cslog/.hermes/.env" in dropin
    assert "UMask=0077" in dropin
    assert "NoNewPrivileges=true" in dropin
    assert "PrivateTmp=true" in dropin
