"""tmux-session-service REST API client."""

import logging
from typing import Any

import aiohttp

logger = logging.getLogger(__name__)


class TmuxSessionServiceClient:
    """Client for tmux-session-service REST API."""

    def __init__(self, base_url: str):
        """Initialize client.

        Args:
            base_url: Base URL of tmux-session-service (e.g., "http://localhost:5001")
        """
        self.base_url = base_url.rstrip("/")
        self._session: aiohttp.ClientSession | None = None

    async def __aenter__(self):
        """Async context manager entry."""
        self._session = aiohttp.ClientSession()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit."""
        if self._session:
            await self._session.close()

    async def _get_session(self) -> aiohttp.ClientSession:
        """Get or create HTTP session."""
        if self._session is None:
            self._session = aiohttp.ClientSession()
        return self._session

    async def create_session(
        self, session_id: str, project_id: str, command: str
    ) -> dict[str, Any]:
        """Create or ensure a tmux session exists (idempotent).

        Args:
            session_id: Unique session identifier
            project_id: Project identifier for grouping
            command: Shell command to execute in the session

        Returns:
            Session details dict

        Raises:
            aiohttp.ClientError: If API request fails
        """
        session = await self._get_session()

        url = f"{self.base_url}/sessions/{session_id}"
        payload = {"projectId": project_id, "command": command}

        try:
            async with session.put(url, json=payload) as response:
                response.raise_for_status()
                data = await response.json()
                logger.info(f"Created/ensured session: {session_id}")
                return data.get("session", {})

        except aiohttp.ClientError as e:
            logger.error(f"Failed to create session {session_id}: {e}")
            raise

    async def list_sessions(self) -> list[dict[str, Any]]:
        """List all tmux sessions.

        Returns:
            List of session dictionaries

        Raises:
            aiohttp.ClientError: If API request fails
        """
        session = await self._get_session()

        url = f"{self.base_url}/sessions"

        try:
            async with session.get(url) as response:
                response.raise_for_status()
                data = await response.json()
                return data.get("sessions", [])

        except aiohttp.ClientError as e:
            logger.error(f"Failed to list sessions: {e}")
            raise

    async def delete_session(self, session_id: str) -> bool:
        """Delete a tmux session.

        Args:
            session_id: Session identifier to delete

        Returns:
            True if successful, False otherwise
        """
        session = await self._get_session()

        url = f"{self.base_url}/sessions/{session_id}"

        try:
            async with session.delete(url) as response:
                response.raise_for_status()
                logger.info(f"Deleted session: {session_id}")
                return True

        except aiohttp.ClientError as e:
            logger.error(f"Failed to delete session {session_id}: {e}")
            return False

    async def session_exists(self, session_id: str) -> bool:
        """Check if a session exists.

        Args:
            session_id: Session identifier to check

        Returns:
            True if session exists, False otherwise
        """
        try:
            sessions = await self.list_sessions()
            return any(s.get("sessionId") == session_id for s in sessions)
        except aiohttp.ClientError:
            return False

    async def health_check(self) -> bool:
        """Check if tmux-session-service is healthy.

        Returns:
            True if service is healthy, False otherwise
        """
        session = await self._get_session()

        url = f"{self.base_url}/health"

        try:
            async with session.get(url) as response:
                return response.status == 200

        except aiohttp.ClientError:
            return False

    async def close(self):
        """Close HTTP session."""
        if self._session:
            await self._session.close()
            self._session = None
