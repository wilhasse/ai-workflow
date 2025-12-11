"""Main daemon process for Plane Claude Orchestrator."""

import asyncio
import json
import logging
import logging.handlers
import os
import signal
import sys
from pathlib import Path
from typing import Any

import uvicorn

from .api import OrchestratorAPI
from .config import Config, load_config

logger = logging.getLogger(__name__)


class PlaneClaudeOrchestrator:
    """Main orchestrator daemon."""

    def __init__(self, config: Config):
        """Initialize orchestrator.

        Args:
            config: Application configuration
        """
        self.config = config
        self.api = OrchestratorAPI(config)
        self.running = False
        self._poll_task: asyncio.Task | None = None
        self._completion_task: asyncio.Task | None = None

    async def start(self):
        """Start the orchestrator daemon."""
        logger.info("Starting Plane Claude Orchestrator...")

        self.running = True

        # Start background tasks
        self._poll_task = asyncio.create_task(self._poll_plane_loop())
        self._completion_task = asyncio.create_task(self._poll_completion_loop())

        # Start FastAPI server
        config = uvicorn.Config(
            self.api.app,
            host=self.config.api.host,
            port=self.config.api.port,
            log_level=self.config.logging.level.lower(),
        )
        server = uvicorn.Server(config)

        logger.info(
            f"API server listening on {self.config.api.host}:{self.config.api.port}"
        )

        await server.serve()

    async def stop(self):
        """Stop the orchestrator daemon."""
        logger.info("Stopping Plane Claude Orchestrator...")

        self.running = False

        # Cancel background tasks
        if self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass

        if self._completion_task:
            self._completion_task.cancel()
            try:
                await self._completion_task
            except asyncio.CancelledError:
                pass

        # Close HTTP clients
        await self.api.tmux_client.close()
        await self.api.plane_client.close()

        logger.info("Orchestrator stopped")

    async def _poll_plane_loop(self):
        """Background task to poll Plane for triggered tickets."""
        logger.info("Starting Plane polling loop...")

        while self.running:
            try:
                # Poll Plane for triggers
                triggered_tickets = await self.api.plane_client.poll_for_triggers()

                # Add new tickets to pending queue
                for ticket in triggered_tickets:
                    ticket_id = ticket["id"]

                    # Skip if already in queue or active
                    if (
                        ticket_id in self.api.pending_tickets
                        or ticket_id in self.api.active_sessions
                        or ticket_id in self.api.completed_tickets
                    ):
                        continue

                    self.api.add_pending_ticket(ticket)

                # Wait for next poll interval
                await asyncio.sleep(self.config.plane.poll_interval)

            except Exception as e:
                logger.error(f"Error in Plane polling loop: {e}", exc_info=True)
                await asyncio.sleep(10)  # Back off on error

    async def _poll_completion_loop(self):
        """Background task to poll for completion signals."""
        logger.info("Starting completion polling loop...")

        while self.running:
            try:
                # Check for completion files in /tmp
                for ticket_id in list(self.api.active_sessions.keys()):
                    completion_file = Path(f"/tmp/completion-{ticket_id}.txt")

                    if completion_file.exists():
                        try:
                            # Read summary from completion file
                            summary = completion_file.read_text().strip()

                            # Mark ticket as completed
                            self.api.mark_ticket_completed(ticket_id, summary)

                            # Clean up completion file
                            completion_file.unlink()

                            logger.info(
                                f"Detected completion for {ticket_id}: {summary[:50]}..."
                            )

                        except Exception as e:
                            logger.error(
                                f"Failed to process completion for {ticket_id}: {e}"
                            )

                # Poll every 5 seconds
                await asyncio.sleep(5)

            except Exception as e:
                logger.error(f"Error in completion polling loop: {e}", exc_info=True)
                await asyncio.sleep(10)


def setup_logging(config: Config):
    """Configure logging with rotation and structured format.

    Args:
        config: Application configuration
    """
    # Create log directory if needed
    log_file = Path(config.logging.file)
    log_file.parent.mkdir(parents=True, exist_ok=True)

    # Create formatters
    detailed_formatter = logging.Formatter(
        fmt="%(asctime)s - %(name)s - %(levelname)s - [%(filename)s:%(lineno)d] - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    console_formatter = logging.Formatter(
        fmt="%(asctime)s - %(levelname)s - %(message)s",
        datefmt="%H:%M:%S",
    )

    # Rotating file handler (max 10MB per file, keep 5 backups)
    file_handler = logging.handlers.RotatingFileHandler(
        log_file,
        maxBytes=10 * 1024 * 1024,  # 10 MB
        backupCount=5,
        encoding="utf-8",
    )
    file_handler.setFormatter(detailed_formatter)
    file_handler.setLevel(logging.DEBUG)

    # Console handler (less verbose)
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(console_formatter)
    console_handler.setLevel(logging.INFO)

    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(config.logging.level)
    root_logger.addHandler(file_handler)
    root_logger.addHandler(console_handler)

    # Reduce noise from external libraries
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    logging.getLogger("aiohttp").setLevel(logging.WARNING)
    logging.getLogger("asyncio").setLevel(logging.WARNING)
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)

    logger.info("Logging configured successfully")
    logger.debug(f"Log file: {log_file} (rotating, max 10MB x 5 files)")


def main():
    """Main entry point."""
    # Load configuration
    try:
        config = load_config("config.yaml")
    except Exception as e:
        print(f"Failed to load configuration: {e}", file=sys.stderr)
        sys.exit(1)

    # Setup logging
    setup_logging(config)

    # Create orchestrator
    orchestrator = PlaneClaudeOrchestrator(config)

    # Handle signals
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    def signal_handler(signum, frame):
        logger.info(f"Received signal {signum}, shutting down...")
        loop.create_task(orchestrator.stop())

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    # Run orchestrator
    try:
        loop.run_until_complete(orchestrator.start())
    except KeyboardInterrupt:
        logger.info("Interrupted by user")
    finally:
        loop.run_until_complete(orchestrator.stop())
        loop.close()


if __name__ == "__main__":
    main()
