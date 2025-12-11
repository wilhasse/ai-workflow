"""Completion detection for Claude Code sessions."""

import asyncio
import logging
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .api import OrchestratorAPI

logger = logging.getLogger(__name__)


class CompletionDetector:
    """Monitors for session completion signals."""

    def __init__(self, api: "OrchestratorAPI", poll_interval: int = 5):
        """Initialize completion detector.

        Args:
            api: Orchestrator API instance with active sessions tracking
            poll_interval: How often to check for completion files (seconds)
        """
        self.api = api
        self.poll_interval = poll_interval
        self.completion_dir = Path("/tmp")
        self._running = False
        self._task: asyncio.Task | None = None

    async def start(self):
        """Start the completion detection loop."""
        if self._running:
            logger.warning("Completion detector already running")
            return

        self._running = True
        self._task = asyncio.create_task(self._poll_loop())
        logger.info(f"Started completion detector (polling every {self.poll_interval}s)")

    async def stop(self):
        """Stop the completion detection loop."""
        if not self._running:
            return

        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

        logger.info("Stopped completion detector")

    async def _poll_loop(self):
        """Main polling loop."""
        while self._running:
            try:
                await self._check_for_completions()
            except Exception as e:
                logger.error(f"Error checking for completions: {e}")

            await asyncio.sleep(self.poll_interval)

    async def _check_for_completions(self):
        """Check for completion files and process them."""
        # Get list of active sessions
        active_ticket_ids = list(self.api.active_sessions.keys())

        if not active_ticket_ids:
            # No active sessions to monitor
            return

        # Check for completion files
        for ticket_id in active_ticket_ids:
            completion_file = self.completion_dir / f"completion-{ticket_id}.txt"

            if completion_file.exists():
                try:
                    # Read summary from file
                    summary = completion_file.read_text().strip()

                    if not summary:
                        logger.warning(f"Empty completion file for {ticket_id}")
                        continue

                    logger.info(f"Detected completion for {ticket_id}: {summary[:100]}...")

                    # Mark ticket as completed
                    self.api.mark_ticket_completed(ticket_id, summary)

                    # Clean up completion file
                    completion_file.unlink()

                    logger.info(f"Processed completion for {ticket_id}")

                except Exception as e:
                    logger.error(f"Failed to process completion for {ticket_id}: {e}")

    def check_completion_file(self, ticket_id: str) -> str | None:
        """Manually check for a completion file.

        Args:
            ticket_id: Ticket ID to check

        Returns:
            Summary text if completion file exists, None otherwise
        """
        completion_file = self.completion_dir / f"completion-{ticket_id}.txt"

        if completion_file.exists():
            try:
                summary = completion_file.read_text().strip()
                return summary if summary else None
            except Exception as e:
                logger.error(f"Failed to read completion file for {ticket_id}: {e}")
                return None

        return None
