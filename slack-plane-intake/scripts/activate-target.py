"""Validate Slack prerequisites and bind intake to one authorized Hermes DM."""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from slack_plane_intake.config import _load_shortcut_user_credentials
from slack_plane_intake.errors import ConfigurationError


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text().splitlines():
        if not raw or raw.lstrip().startswith("#") or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        parsed = shlex.split(value)
        values[key] = parsed[0] if parsed else ""
    return values


def slack_call(token: str, method: str, params: dict[str, str]) -> tuple[dict, str]:
    request = urllib.request.Request(
        "https://slack.com/api/" + method,
        data=urllib.parse.urlencode(params).encode(),
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response), response.headers.get("x-oauth-scopes", "")


def plane_call(base_url: str, api_key: str, path: str) -> object:
    request = urllib.request.Request(
        base_url.rstrip("/") + path,
        headers={"X-API-Key": api_key, "Accept": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def update_env(path: Path, updates: dict[str, str]) -> None:
    output: list[str] = []
    seen: set[str] = set()
    for raw in path.read_text().splitlines():
        key = raw.split("=", 1)[0] if "=" in raw else ""
        if key in updates:
            output.append(f"{key}={shlex.quote(updates[key])}")
            seen.add(key)
        else:
            output.append(raw)
    for key, value in updates.items():
        if key not in seen:
            output.append(f"{key}={shlex.quote(value)}")
    temporary = path.with_name(".env.activate.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write("\n".join(output) + "\n")
    os.replace(temporary, path)
    os.chmod(path, 0o600)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args(argv)

    hermes_home = Path(
        os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))
    ).expanduser()
    env_path = hermes_home / ".env"
    values = read_env(env_path)
    token = values.get("SLACK_BOT_TOKEN", "")
    if not token.startswith("xoxb-"):
        print("activation error: Slack bot token is unavailable", file=sys.stderr)
        return 2

    allowed_raw = values.get("SPI_SLACK_ALLOWED_USERS", "") or values.get(
        "SLACK_ALLOWED_USERS", ""
    )
    allowed_users = tuple(
        dict.fromkeys(item for item in re.split(r"[,\s]+", allowed_raw) if item)
    )
    if len(allowed_users) != 1 or not re.fullmatch(r"U[A-Z0-9]+", allowed_users[0]):
        print(
            "activation error: DM intake requires exactly one allowed Slack user ID",
            file=sys.stderr,
        )
        return 2
    allowed_user = allowed_users[0]
    shortcut_allowed_raw = values.get("SPI_SLACK_SHORTCUT_ALLOWED_USERS", allowed_raw)
    shortcut_allowed_users = frozenset(
        item for item in re.split(r"[,\s]+", shortcut_allowed_raw) if item
    )
    try:
        user_credentials = _load_shortcut_user_credentials(
            values, shortcut_allowed_users
        )
    except ConfigurationError as exc:
        print(f"activation error: {exc}", file=sys.stderr)
        return 2

    auth, scopes_header = slack_call(token, "auth.test", {})
    if not auth.get("ok"):
        print("activation error: Slack authentication failed", file=sys.stderr)
        return 1
    scopes = {item.strip() for item in scopes_header.split(",") if item.strip()}
    required_scopes = {"files:read", "im:history", "im:write"}
    missing_scopes = sorted(required_scopes - scopes)
    if missing_scopes:
        print(
            "activation error: Slack app lacks required DM intake scopes: "
            + ", ".join(missing_scopes)
            + "; add them and reinstall the app",
            file=sys.stderr,
        )
        return 1

    history_user_id = values.get("SPI_SLACK_HISTORY_USER_ID", "")
    history_user_token = values.get("SPI_SLACK_HISTORY_USER_TOKEN", "")
    if bool(history_user_id) != bool(history_user_token):
        print(
            "activation error: Slack history user ID and token must be configured together",
            file=sys.stderr,
        )
        return 2
    history_picker_enabled = bool(history_user_token)
    if history_picker_enabled:
        if history_user_id != allowed_user or not history_user_token.startswith(
            "xoxp-"
        ):
            print(
                "activation error: Slack history token must belong to the DM owner",
                file=sys.stderr,
            )
            return 2
        user_auth, user_scopes_header = slack_call(history_user_token, "auth.test", {})
        user_scopes = {
            item.strip() for item in user_scopes_header.split(",") if item.strip()
        }
        missing_user_scopes = sorted({"files:read", "im:history"} - user_scopes)
        if (
            not user_auth.get("ok")
            or str(user_auth.get("user_id", "")) != history_user_id
            or str(user_auth.get("team_id", "")) != str(auth.get("team_id", ""))
        ):
            print(
                "activation error: Slack history user authentication failed",
                file=sys.stderr,
            )
            return 1
        if missing_user_scopes:
            print(
                "activation error: Slack history user token lacks required scopes: "
                + ", ".join(missing_user_scopes)
                + "; add the user scopes and reinstall the app",
                file=sys.stderr,
            )
            return 1

    plane_base_url = values.get(
        "SPI_PLANE_BASE_URL", "https://plane.cslog.com.br"
    ).rstrip("/")
    plane_workspace = values.get("SPI_PLANE_WORKSPACE", "cslog")
    plane_project_id = values.get("SPI_PLANE_PROJECT_ID", "")
    if user_credentials and not plane_project_id:
        print(
            "activation error: Plane project ID is required for personal credentials",
            file=sys.stderr,
        )
        return 2
    for user_id, credential in user_credentials.items():
        user_auth, user_scopes_header = slack_call(
            credential.slack_user_token, "auth.test", {}
        )
        user_scopes = {
            item.strip() for item in user_scopes_header.split(",") if item.strip()
        }
        if (
            not user_auth.get("ok")
            or str(user_auth.get("user_id", "")) != user_id
            or str(user_auth.get("team_id", "")) != str(auth.get("team_id", ""))
        ):
            print(
                "activation error: personal Slack credential identity mismatch",
                file=sys.stderr,
            )
            return 1
        missing_user_scopes = sorted({"files:read", "im:history"} - user_scopes)
        if missing_user_scopes:
            print(
                "activation error: personal Slack token lacks required scopes: "
                + ", ".join(missing_user_scopes),
                file=sys.stderr,
            )
            return 1
        try:
            current_plane_user = plane_call(
                plane_base_url,
                credential.plane_api_key,
                "/api/v1/users/me/",
            )
            work_items = plane_call(
                plane_base_url,
                credential.plane_api_key,
                "/api/v1/workspaces/"
                + urllib.parse.quote(plane_workspace, safe="")
                + "/projects/"
                + urllib.parse.quote(plane_project_id, safe="")
                + "/work-items/?limit=1",
            )
        except (OSError, ValueError, json.JSONDecodeError):
            print(
                "activation error: personal Plane credential validation failed",
                file=sys.stderr,
            )
            return 1
        if not isinstance(current_plane_user, dict) or not current_plane_user.get("id"):
            print(
                "activation error: personal Plane credential has no user identity",
                file=sys.stderr,
            )
            return 1
        if not isinstance(work_items, (dict, list)):
            print(
                "activation error: personal Plane credential cannot access AGENTE",
                file=sys.stderr,
            )
            return 1
    opened, _ = slack_call(token, "conversations.open", {"users": allowed_user})
    channel_id = str((opened.get("channel") or {}).get("id", ""))
    if not opened.get("ok") or not re.fullmatch(r"D[A-Z0-9]+", channel_id):
        print(
            "activation error: Slack did not resolve a one-to-one Hermes DM",
            file=sys.stderr,
        )
        return 1

    update_env(
        env_path,
        {
            "SLACK_ALLOWED_CHANNELS": channel_id,
            "SLACK_HOME_CHANNEL": channel_id,
            "SPI_SLACK_CHANNEL_ID": channel_id,
        },
    )
    print("slack_intake_mode=direct_message")
    print("slack_dm_channel_id=" + channel_id)
    print("slack_home_channel_bound=true")
    print("allowed_user_count=1")
    print("files_read_scope=true")
    print("dm_history_scope=true")
    print(
        "slack_history_picker_enabled="
        + ("true" if history_picker_enabled else "false")
    )
    print("personal_shortcut_credential_count=" + str(len(user_credentials)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
