from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).parents[1]


def test_systemd_unit_contains_no_secret_and_uses_existing_control_socket():
    unit = (ROOT / "deploy" / "plane-codex-worker.service").read_text()
    assert "PCW_PLANE_API_KEY" not in unit
    assert "runtime/codex-control/control.sock" in unit
    assert "UMask=0077" in unit
    assert "PrivateTmp=yes" in unit
    assert "NoNewPrivileges=yes" in unit


def test_installer_restarts_existing_service():
    installer = (ROOT / "scripts" / "install-user-service.sh").read_text()
    assert "set -euo pipefail" in installer
    assert "systemctl --user restart plane-codex-worker.service" in installer
