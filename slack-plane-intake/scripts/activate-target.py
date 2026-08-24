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

    opened, _ = slack_call(token, "conversations.open", {"users": allowed_user})
    channel_id = str((opened.get("channel") or {}).get("id", ""))
    if not opened.get("ok") or not re.fullmatch(r"D[A-Z0-9]+", channel_id):
        print(
            "activation error: Slack did not resolve a one-to-one Hermes DM",
            file=sys.stderr,
        )
        return 1

    info, _ = slack_call(token, "conversations.info", {"channel": channel_id})
    channel = info.get("channel") or {}
    if not info.get("ok") or not channel.get("is_im") or channel.get("is_mpim"):
        print(
            "activation error: resolved conversation is not a one-to-one Slack DM",
            file=sys.stderr,
        )
        return 1
    conversation_user = str(channel.get("user", ""))
    if conversation_user and conversation_user != allowed_user:
        print(
            "activation error: Slack DM user does not match the allowlist",
            file=sys.stderr,
        )
        return 1

    update_env(
        env_path,
        {
            "SLACK_ALLOWED_CHANNELS": channel_id,
            "SPI_SLACK_CHANNEL_ID": channel_id,
        },
    )
    print("slack_intake_mode=direct_message")
    print("slack_dm_channel_id=" + channel_id)
    print("allowed_user_count=1")
    print("files_read_scope=true")
    print("dm_history_scope=true")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
