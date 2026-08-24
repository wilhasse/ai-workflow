"""Command-line entry point for provisioning and running the Plane worker."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import signal

from .codex_client import CodexControlClient
from .config import ConfigurationError, load_config
from .ledger import JobLedger
from .plane_client import PlaneClient, PlaneError
from .worker import AutomationWorker

LOGGER = logging.getLogger(__name__)


def _components():
    config = load_config()
    plane = PlaneClient(config)
    codex = CodexControlClient(config)
    ledger = JobLedger(config.state_db)
    worker = AutomationWorker(config, plane, codex, ledger)
    return config, plane, codex, worker


async def _close(plane: PlaneClient, codex: CodexControlClient) -> None:
    await plane.close()
    await codex.close()


async def _validate() -> dict[str, object]:
    config, plane, codex, _worker = _components()
    try:
        states = await plane.resolve_states()
        health = await codex.health()
        if not health.ready:
            raise RuntimeError("Codex app-server is not ready")
        return {
            **config.redacted_summary(),
            "codex_ready": health.ready,
            "codex_pid": health.pid,
            "plane_states": {
                "backlog": states.backlog.id,
                "running": states.running.id,
                "review": states.review.id,
                "blocked": states.blocked.id,
            },
        }
    finally:
        await _close(plane, codex)


async def _provision() -> dict[str, object]:
    _config, plane, codex, _worker = _components()
    try:
        states = await plane.ensure_automation_states()
        return {
            "backlog": states.backlog.id,
            "running": states.running.id,
            "review": states.review.id,
            "blocked": states.blocked.id,
        }
    finally:
        await _close(plane, codex)


async def _once() -> dict[str, int]:
    _config, plane, codex, worker = _components()
    try:
        return await worker.run_once()
    finally:
        await _close(plane, codex)


async def _run() -> None:
    config, plane, codex, worker = _components()
    stopping = asyncio.Event()
    loop = asyncio.get_running_loop()
    for name in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(name, stopping.set)
    try:
        while not stopping.is_set():
            try:
                result = await worker.run_once()
                LOGGER.info("poll completed: %s", result)
            except Exception:
                LOGGER.exception("poll failed")
            try:
                await asyncio.wait_for(stopping.wait(), timeout=config.poll_seconds)
            except TimeoutError:
                pass
    finally:
        await _close(plane, codex)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command", choices=("validate-config", "provision", "once", "run")
    )
    args = parser.parse_args(argv)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    try:
        if args.command == "validate-config":
            result = asyncio.run(_validate())
        elif args.command == "provision":
            result = asyncio.run(_provision())
        elif args.command == "once":
            result = asyncio.run(_once())
        else:
            asyncio.run(_run())
            return 0
    except (ConfigurationError, PlaneError, RuntimeError) as exc:
        LOGGER.error("%s", exc)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
