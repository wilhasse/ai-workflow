"""Validate Slack prerequisites and save the dedicated intake channel."""

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
    parser.add_argument("channel_id")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"C[A-Z0-9]+", args.channel_id):
        print("activation error: invalid public Slack channel ID", file=sys.stderr)
        return 2

    env_path = Path.home() / ".hermes/.env"
    values = read_env(env_path)
    token = values.get("SLACK_BOT_TOKEN", "")
    if not token.startswith("xoxb-"):
        print("activation error: Slack bot token is unavailable", file=sys.stderr)
        return 2

    auth, scopes_header = slack_call(token, "auth.test", {})
    if not auth.get("ok"):
        print("activation error: Slack authentication failed", file=sys.stderr)
        return 1
    scopes = {item.strip() for item in scopes_header.split(",") if item.strip()}
    if "files:read" not in scopes:
        print(
            "activation error: Slack app lacks files:read; add the scope and reinstall the app",
            file=sys.stderr,
        )
        return 1

    info, _ = slack_call(token, "conversations.info", {"channel": args.channel_id})
    channel = info.get("channel") or {}
    if not info.get("ok") or channel.get("name") != "problem-intake":
        print(
            "activation error: channel must exist with exact name problem-intake",
            file=sys.stderr,
        )
        return 1
    if channel.get("is_private"):
        print("activation error: v1 requires a public intake channel", file=sys.stderr)
        return 1

    if not channel.get("is_member"):
        joined, _ = slack_call(
            token, "conversations.join", {"channel": args.channel_id}
        )
        if not joined.get("ok"):
            print(
                "activation error: bot could not join the intake channel",
                file=sys.stderr,
            )
            return 1
        channel = joined.get("channel") or {}
    if not channel.get("is_member"):
        print("activation error: bot membership was not verified", file=sys.stderr)
        return 1

    update_env(
        env_path,
        {
            "SLACK_ALLOWED_CHANNELS": args.channel_id,
            "SPI_SLACK_CHANNEL_ID": args.channel_id,
        },
    )
    print("slack_channel_id=" + args.channel_id)
    print("slack_channel_name=problem-intake")
    print("files_read_scope=true")
    print("bot_membership=true")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
