from __future__ import annotations

import argparse
from pprint import pprint

from .config import load_config
from .doris import DorisClient
from .hermes_sqlite import HermesStateStore
from .importer import import_history
from .memory_draft import generate_memory_drafts
from .sync_service import run_service, sync_source_once


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="hmh",
        description="Hermes Memory Harness",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    inspect_parser = sub.add_parser("inspect", help="Inspect Doris history")
    inspect_parser.add_argument("--source", default="codex")
    inspect_parser.add_argument("--top-projects", type=int, default=12)

    projects_parser = sub.add_parser("list-projects", help="List top projects for a source")
    projects_parser.add_argument("--source", default="codex")
    projects_parser.add_argument("--limit", type=int, default=25)

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

    sync_parser = sub.add_parser(
        "sync-once",
        help="Incrementally sync new Doris messages into Hermes history using watermarks",
    )
    sync_parser.add_argument("--source", action="append", dest="sources")
    sync_parser.add_argument("--dry-run", action="store_true")

    service_parser = sub.add_parser(
        "run-service",
        help="Run a polling service that keeps Hermes history incrementally synced",
    )
    service_parser.add_argument("--source", action="append", dest="sources")
    service_parser.add_argument("--poll-interval", type=int)

    watermarks_parser = sub.add_parser(
        "watermarks",
        help="Show stored incremental sync watermarks",
    )

    return parser


def _resolve_sources(raw_sources: list[str] | None) -> list[str]:
    config = load_config()
    if raw_sources:
        return raw_sources
    return list(config.service.sources)


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


def _cmd_list_projects(source: str, limit: int) -> int:
    config = load_config()
    doris = DorisClient(config.doris)
    for row in doris.fetch_top_projects(source, limit=limit):
        print(f"{row['project']}\t{row['session_count']}")
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


def _cmd_sync_once(sources: list[str], dry_run: bool) -> int:
    config = load_config()
    doris = DorisClient(config.doris)
    hermes = HermesStateStore(config.hermes.state_db_path)
    try:
        for source in sources:
            stats = sync_source_once(doris, hermes, source=source, dry_run=dry_run)
            print(
                f"source={stats.source} initialized={stats.watermark_initialized} "
                f"seen={stats.messages_seen} imported={stats.messages_imported} "
                f"skipped={stats.messages_skipped} sessions_upserted={stats.sessions_upserted} "
                f"watermark={stats.watermark}"
            )
    finally:
        hermes.close()
    return 0


def _cmd_run_service(sources: list[str], poll_interval: int | None) -> int:
    config = load_config()
    doris = DorisClient(config.doris)
    hermes = HermesStateStore(config.hermes.state_db_path)
    try:
        run_service(
            doris,
            hermes,
            sources=sources,
            poll_interval_seconds=poll_interval or config.service.poll_interval_seconds,
        )
    finally:
        hermes.close()
    return 0


def _cmd_watermarks() -> int:
    config = load_config()
    hermes = HermesStateStore(config.hermes.state_db_path)
    try:
        watermarks = hermes.all_watermarks()
        if not watermarks:
            print("No watermarks stored.")
            return 0
        for source, value in watermarks.items():
            print(f"{source}\t{value}")
    finally:
        hermes.close()
    return 0


def main() -> int:
    parser = _build_parser()
    args = parser.parse_args()

    if args.command == "inspect":
        return _cmd_inspect(args.source, args.top_projects)
    if args.command == "list-projects":
        return _cmd_list_projects(args.source, args.limit)
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
    if args.command == "sync-once":
        return _cmd_sync_once(_resolve_sources(args.sources), args.dry_run)
    if args.command == "run-service":
        return _cmd_run_service(_resolve_sources(args.sources), args.poll_interval)
    if args.command == "watermarks":
        return _cmd_watermarks()

    parser.error(f"unknown command: {args.command}")
    return 2
