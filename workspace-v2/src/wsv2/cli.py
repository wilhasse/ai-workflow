from __future__ import annotations

import argparse
import json
import sys

from .actions import WorkspaceActions, build_workspace_command


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Workspace v2 popup launcher")
    parser.add_argument("--config", help="Path to workspaces.json")
    parser.add_argument("--state", help="Path to launcher state file")

    subparsers = parser.add_subparsers(dest="command")

    list_parser = subparsers.add_parser("list", help="List workspaces with status")
    list_parser.add_argument("--json", action="store_true", help="Emit JSON instead of text")

    open_parser = subparsers.add_parser("open", help="Open or focus a workspace")
    open_parser.add_argument("target", help="Workspace id or host:id")
    open_parser.add_argument(
        "--no-focus",
        action="store_true",
        help="Skip searching for an existing window before launching",
    )

    kill_parser = subparsers.add_parser("kill", help="Kill a workspace tmux session")
    kill_parser.add_argument("target", help="Workspace id or host:id")

    subparsers.add_parser("popup", help="Launch the popup UI")

    command_parser = subparsers.add_parser("command", help="Print the tmux/ssh command for a target")
    command_parser.add_argument("target", help="Workspace id or host:id")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    command = args.command or "popup"
    actions = WorkspaceActions(config_path=args.config, state_path=args.state)

    if command == "popup":
        from .popup import launch_popup

        launch_popup(actions)
        return 0

    if command == "list":
        statuses = actions.list_workspace_statuses()
        if args.json:
            payload = [
                {
                    "id": status.workspace.id,
                    "name": status.workspace.name,
                    "host": status.workspace.host_id,
                    "hostName": status.workspace.host.name,
                    "path": status.workspace.path,
                    "active": status.active,
                    "reachable": status.reachable,
                    "target": status.workspace.target,
                }
                for status in statuses
            ]
            print(json.dumps(payload, indent=2))
            return 0

        for status in statuses:
            if status.reachable is False:
                dot = "!"
            elif status.active:
                dot = "*"
            else:
                dot = "."
            print(
                f"{dot} {status.workspace.name:<18} "
                f"[{status.workspace.host.name}] "
                f"{status.workspace.id:<18} "
                f"{status.workspace.display_path}"
            )
        return 0

    if command == "open":
        result = actions.open_workspace(args.target, focus_existing=not args.no_focus)
        print(result)
        return 0

    if command == "kill":
        if not actions.kill_workspace(args.target):
            print("session not found or could not be killed", file=sys.stderr)
            return 1
        print("killed")
        return 0

    if command == "command":
        workspace = actions.resolve_workspace(args.target)
        print(build_workspace_command(workspace))
        return 0

    parser.print_help()
    return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
