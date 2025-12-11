"""Plane REST API client for ticket polling and updates."""

import logging
from datetime import datetime
from typing import Any

import aiohttp
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
    before_sleep_log,
)

logger = logging.getLogger(__name__)


class PlaneClient:
    """Client for Plane REST API."""

    def __init__(
        self,
        api_url: str,
        api_token: str,
        workspace_slug: str,
        project_identifier: str,
        project_ids: list[str],
    ):
        """Initialize Plane client.

        Args:
            api_url: Base URL of Plane API (e.g., "https://plane.cslog.com.br/api/v1")
            api_token: Plane API token
            workspace_slug: Workspace slug
            project_identifier: Readable project identifier (e.g., "CSLOG")
            project_ids: List of project UUIDs to monitor
        """
        self.api_url = api_url.rstrip("/")
        self.api_token = api_token
        self.workspace_slug = workspace_slug
        self.project_identifier = project_identifier
        self.project_ids = project_ids
        self._last_poll_state: dict[str, Any] = {}
        self._session: aiohttp.ClientSession | None = None

    async def _get_session(self) -> aiohttp.ClientSession:
        """Get or create HTTP session."""
        if self._session is None:
            headers = {
                "X-Api-Key": self.api_token,
                "Content-Type": "application/json",
            }
            self._session = aiohttp.ClientSession(headers=headers)
        return self._session

    async def close(self):
        """Close HTTP session."""
        if self._session:
            await self._session.close()
            self._session = None

    async def list_project_issues(self, project_id: str) -> list[dict[str, Any]]:
        """List all issues for a project.

        Args:
            project_id: UUID of the project

        Returns:
            List of issue dictionaries
        """
        session = await self._get_session()

        url = f"{self.api_url}/workspaces/{self.workspace_slug}/projects/{project_id}/issues/"

        try:
            async with session.get(url) as response:
                if response.status == 200:
                    data = await response.json()
                    # Plane API returns results in 'results' key
                    return data.get("results", data if isinstance(data, list) else [])
                else:
                    logger.error(
                        f"Failed to list issues for project {project_id}: "
                        f"HTTP {response.status}"
                    )
                    return []

        except aiohttp.ClientError as e:
            logger.error(f"Failed to list issues for project {project_id}: {e}")
            return []

    async def get_issue_details(self, project_id: str, issue_id: str) -> dict[str, Any] | None:
        """Get full details for a specific issue.

        Args:
            project_id: UUID of the project
            issue_id: UUID of the issue

        Returns:
            Issue details dict or None if not found
        """
        session = await self._get_session()

        url = (
            f"{self.api_url}/workspaces/{self.workspace_slug}/"
            f"projects/{project_id}/issues/{issue_id}/"
        )

        try:
            async with session.get(url) as response:
                if response.status == 200:
                    return await response.json()
                else:
                    logger.error(
                        f"Failed to get issue {issue_id}: HTTP {response.status}"
                    )
                    return None

        except aiohttp.ClientError as e:
            logger.error(f"Failed to get issue {issue_id}: {e}")
            return None

    async def poll_for_triggers(self) -> list[dict[str, Any]]:
        """Poll Plane for triggered tickets.

        Returns:
            List of triggered ticket dictionaries with trigger metadata
        """
        logger.debug(f"Polling Plane for triggers across {len(self.project_ids)} project(s)...")
        triggered_tickets = []

        for project_id in self.project_ids:
            issues = await self.list_project_issues(project_id)
            logger.debug(f"Found {len(issues)} issue(s) in project {project_id}")

            for issue in issues:
                sequence_id = issue.get("sequence_id")
                if not sequence_id:
                    continue

                issue_id = f"{self.project_identifier}-{sequence_id}"
                issue_uuid = issue.get("id")

                trigger_type = await self._check_trigger(issue, issue_id)

                if trigger_type:
                    triggered_tickets.append(
                        {
                            "id": issue_id,
                            "uuid": issue_uuid,
                            "project_id": project_id,
                            "title": issue.get("name", ""),
                            "description": issue.get("description_html", ""),
                            "state": issue.get("state", ""),
                            "state_detail": issue.get("state_detail", {}),
                            "priority": issue.get("priority", ""),
                            "trigger_type": trigger_type,
                            "created_at": issue.get("created_at", ""),
                            "updated_at": issue.get("updated_at", ""),
                        }
                    )

        logger.info(f"Poll complete: {len(triggered_tickets)} triggered ticket(s) found")
        return triggered_tickets

    async def _check_trigger(self, issue: dict[str, Any], issue_id: str) -> str | None:
        """Check if an issue should trigger automation.

        Args:
            issue: Issue data from Plane
            issue_id: Readable issue ID

        Returns:
            Trigger type string or None if no trigger
        """
        # Get last known state
        last_state = self._last_poll_state.get(issue_id, {})

        # Check if new ticket (first time we see it)
        if not last_state:
            self._last_poll_state[issue_id] = {
                "state": issue.get("state"),
                "updated_at": issue.get("updated_at"),
            }
            # Only trigger on new tickets if they're not in backlog or done states
            state_detail = issue.get("state_detail", {})
            state_group = state_detail.get("group", "").lower()

            # Trigger if it's a new ticket in todo or started state
            if state_group in ["started", "unstarted"]:
                return "new_ticket"

            return None

        # Check if status changed
        current_state = issue.get("state")
        if current_state != last_state.get("state"):
            self._last_poll_state[issue_id]["state"] = current_state
            return "status_change"

        # Check if updated (could be new comment)
        current_updated_at = issue.get("updated_at")
        if current_updated_at != last_state.get("updated_at"):
            self._last_poll_state[issue_id]["updated_at"] = current_updated_at
            return "comment_added"

        return None

    @retry(
        retry=retry_if_exception_type((aiohttp.ClientError, aiohttp.ServerTimeoutError)),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10),
        before_sleep=before_sleep_log(logger, logging.WARNING),
        reraise=True,
    )
    async def add_issue_comment(
        self, project_id: str, issue_id: str, comment_html: str
    ) -> bool:
        """Add a comment to an issue with automatic retry on network errors.

        Args:
            project_id: UUID of the project
            issue_id: UUID of the issue
            comment_html: HTML content of the comment

        Returns:
            True if successful, False otherwise
        """
        session = await self._get_session()

        url = (
            f"{self.api_url}/workspaces/{self.workspace_slug}/"
            f"projects/{project_id}/issues/{issue_id}/comments/"
        )

        payload = {
            "comment_html": comment_html,
        }

        try:
            async with session.post(url, json=payload) as response:
                if response.status in (200, 201):
                    logger.info(f"Added comment to issue {issue_id}")
                    return True
                elif response.status >= 500:
                    # Server error - retry
                    error_text = await response.text()
                    logger.warning(
                        f"Server error adding comment to issue {issue_id}: "
                        f"HTTP {response.status} - {error_text}"
                    )
                    raise aiohttp.ClientError(f"Server error: {response.status}")
                else:
                    # Client error - don't retry
                    logger.error(
                        f"Failed to add comment to issue {issue_id}: "
                        f"HTTP {response.status} - {await response.text()}"
                    )
                    return False

        except aiohttp.ClientError as e:
            logger.error(f"Network error adding comment to issue {issue_id}: {e}")
            raise  # Let retry decorator handle it

    @retry(
        retry=retry_if_exception_type((aiohttp.ClientError, aiohttp.ServerTimeoutError)),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10),
        before_sleep=before_sleep_log(logger, logging.WARNING),
        reraise=True,
    )
    async def update_issue_state(
        self, project_id: str, issue_id: str, state_id: str
    ) -> bool:
        """Update the state of an issue with automatic retry on network errors.

        Args:
            project_id: UUID of the project
            issue_id: UUID of the issue
            state_id: UUID of the target state

        Returns:
            True if successful, False otherwise
        """
        session = await self._get_session()

        url = (
            f"{self.api_url}/workspaces/{self.workspace_slug}/"
            f"projects/{project_id}/issues/{issue_id}/"
        )

        payload = {"state": state_id}

        try:
            async with session.patch(url, json=payload) as response:
                if response.status == 200:
                    logger.info(f"Updated state for issue {issue_id}")
                    return True
                elif response.status >= 500:
                    # Server error - retry
                    error_text = await response.text()
                    logger.warning(
                        f"Server error updating issue {issue_id}: "
                        f"HTTP {response.status} - {error_text}"
                    )
                    raise aiohttp.ClientError(f"Server error: {response.status}")
                else:
                    # Client error - don't retry
                    logger.error(
                        f"Failed to update issue {issue_id}: "
                        f"HTTP {response.status} - {await response.text()}"
                    )
                    return False

        except aiohttp.ClientError as e:
            logger.error(f"Network error updating issue {issue_id}: {e}")
            raise  # Let retry decorator handle it

    async def list_states(self, project_id: str) -> list[dict[str, Any]]:
        """List all states for a project.

        Args:
            project_id: UUID of the project

        Returns:
            List of state dictionaries
        """
        session = await self._get_session()

        url = (
            f"{self.api_url}/workspaces/{self.workspace_slug}/"
            f"projects/{project_id}/states/"
        )

        try:
            async with session.get(url) as response:
                if response.status == 200:
                    data = await response.json()
                    return data.get("results", data if isinstance(data, list) else [])
                else:
                    logger.error(
                        f"Failed to list states for project {project_id}: "
                        f"HTTP {response.status}"
                    )
                    return []

        except aiohttp.ClientError as e:
            logger.error(f"Failed to list states for project {project_id}: {e}")
            return []

    async def get_in_progress_state_id(self, project_id: str) -> str | None:
        """Get the UUID of the 'In Progress' state for a project.

        Args:
            project_id: UUID of the project

        Returns:
            State UUID or None if not found
        """
        states = await self.list_states(project_id)

        # Find "In Progress", "Started", or similar state
        for state in states:
            name = state.get("name", "").lower()
            group = state.get("group", "").lower()

            # Check group first (most reliable)
            if group == "started":
                return state.get("id")

            # Fall back to name matching
            if "progress" in name or "started" in name or "doing" in name:
                return state.get("id")

        logger.warning(f"No 'In Progress' state found for project {project_id}")
        return None
