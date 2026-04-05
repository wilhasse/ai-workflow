from __future__ import annotations

import argparse
from pprint import pprint

from .config import load_config
from .doris import DorisClient
from .hermes_sqlite import HermesStateStore
from .importer import import_history
from .memory_draft import generate_memory_drafts


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="hmh",
        description="Hermes Memory Harness",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    inspect_parser = sub.add_parser("inspect", help="Inspect Doris history")
    inspect_parser.add_argument("--source", default="codex")
    inspect_parser.add_argument("--top-projects", type=int, default=12)

    import_parser = sub.add_parser(
        "import-history",
        help="Import Doris sessions into Hermes state.db",
    )
    import_parser.add_argument("--source", default="codex")
    import_parser.add_argument("--project")
    import_parser.add_argument("--limit-sessions", type=int)
    import_parser.add_argument("--replace", action="store_true")
    import_parser.add_argument("--dry-run", action="store_true")

    draft_parser = sub.add_parser(
        "draft-memory",
        help="Generate review-first MEMORY.md and USER.md drafts",
    )
    draft_parser.add_argument("--source", default="codex")

    return parser


def _cmd_inspect(source: str, top_projects: int) -> int:
    config = load_config()
    doris = DorisClient(config.doris)
    print("Doris source stats:")
    for row in doris.fetch_source_stats():
        print(
            f"- {row['source']}: rows={row['rows_in_messages']}, "
            f"range={row['min_ts']} .. {row['max_ts']}"
        )
    print()
    print(f"Top projects for source={source}:")
    for row in doris.fetch_top_projects(source, limit=top_projects):
        print(f"- {row['project']}: {row['session_count']} sessions")
    print()
    print("Message volume:")
    pprint(doris.fetch_message_volume(source))
    return 0


def _cmd_import_history(
    *,
    source: str,
    project: str | None,
    limit_sessions: int | None,
    replace: bool,
    dry_run: bool,
) -> int:
    config = load_config()
    doris = DorisClient(config.doris)
    hermes = HermesStateStore(config.hermes.state_db_path)
    try:
        stats = import_history(
            doris,
            hermes,
            source=source,
            project=project,
            limit_sessions=limit_sessions,
            replace=replace,
            dry_run=dry_run,
        )
    finally:
        hermes.close()

    print("Import summary:")
    print(f"- sessions seen: {stats.sessions_seen}")
    print(f"- sessions imported: {stats.sessions_imported}")
    print(f"- sessions replaced: {stats.sessions_replaced}")
    print(f"- messages imported: {stats.messages_imported}")
    if not dry_run:
        print(f"- hermes state db: {config.hermes.state_db_path}")
    return 0


def _cmd_draft_memory(source: str) -> int:
    config = load_config()
    doris = DorisClient(config.doris)
    paths = generate_memory_drafts(config, doris, source=source)
    print("Generated draft files:")
    print(f"- {paths.memory_path}")
    print(f"- {paths.user_path}")
    return 0


def main() -> int:
    parser = _build_parser()
    args = parser.parse_args()

    if args.command == "inspect":
        return _cmd_inspect(args.source, args.top_projects)
    if args.command == "import-history":
        return _cmd_import_history(
            source=args.source,
            project=args.project,
            limit_sessions=args.limit_sessions,
            replace=args.replace,
            dry_run=args.dry_run,
        )
    if args.command == "draft-memory":
        return _cmd_draft_memory(args.source)

    parser.error(f"unknown command: {args.command}")
    return 2
