"""Stdio MCP entry point used by the restricted Hermes profile."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys

from mcp.server import MCPServer

from .analyzer import Analyzer
from .config import AppConfig, load_config
from .errors import ConfigurationError
from .ledger import IntakeLedger
from .plane_client import PlaneClient
from .service import ProblemIntakeService
from .slack_client import SlackClient


def build_service(config: AppConfig) -> ProblemIntakeService:
    config.work_dir.mkdir(parents=True, exist_ok=True)
    return ProblemIntakeService(
        slack=SlackClient(config.slack, config.limits, config.work_dir),
        analyzer=Analyzer(config.models, config.limits),
        plane=PlaneClient(config.plane),
        ledger=IntakeLedger(config.state_db),
    )


def create_mcp_server(service: ProblemIntakeService) -> MCPServer:
    server = MCPServer(
        "slack-plane-intake",
        instructions=(
            "Create a Plane problem only from the current authorized top-level "
            "Slack direct message to Hermes. Pass its Slack timestamp exactly. Never "
            "invent a timestamp, channel, project, ticket field, or success result."
        ),
    )

    @server.tool()
    async def create_plane_problem(message_ts: str) -> dict:
        """Create or recover the Plane ticket for one Slack DM intake message.

        Args:
            message_ts: Exact Slack timestamp of the current top-level DM.
        """
        result = await service.create_from_slack(message_ts)
        return result.model_dump(mode="json")

    return server


async def _run() -> None:
    config = load_config()
    service = build_service(config)
    server = create_mcp_server(service)
    try:
        await server.run_stdio_async()
    finally:
        await service.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--validate-config",
        action="store_true",
        help="validate environment and print only non-secret settings",
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)

    try:
        config = load_config()
    except ConfigurationError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2

    if args.validate_config:
        print(json.dumps(config.redacted_summary(), indent=2, sort_keys=True))
        return 0

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
