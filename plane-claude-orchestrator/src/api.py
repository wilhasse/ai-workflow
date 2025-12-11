"""FastAPI endpoints for dashboard integration."""

import logging
from datetime import datetime
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

from .config import Config
from .plane_client import PlaneClient
from .tmux_client import TmuxSessionServiceClient
from . import metrics

logger = logging.getLogger(__name__)


# Pydantic models for request/response
class TicketResponse(BaseModel):
    """Pending or completed ticket response."""

    id: str
    uuid: str
    project_id: str
    title: str
    description: str
    trigger_type: str | None = None
    summary: str | None = None
    created_at: str
    updated_at: str | None = None
    completed_at: str | None = None


class ApproveResponse(BaseModel):
    """Session creation response."""

    session_id: str
    ticket_id: str
    created_at: str


class UpdatePlaneRequest(BaseModel):
    """Request to update Plane ticket."""

    summary: str


class OrchestratorAPI:
    """FastAPI application for dashboard integration."""

    def __init__(self, config: Config):
        """Initialize API.

        Args:
            config: Application configuration
        """
        self.config = config
        self.app = FastAPI(title="Plane Claude Orchestrator API", version="0.1.0")

        # Enable CORS for dashboard
        self.app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],  # TODO: restrict in production
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

        # State storage (in-memory for MVP, will persist to JSON later)
        self.pending_tickets: dict[str, dict[str, Any]] = {}
        self.active_sessions: dict[str, dict[str, Any]] = {}
        self.completed_tickets: dict[str, dict[str, Any]] = {}

        # Initialize clients
        self.plane_client = PlaneClient(
            api_url=config.plane.api_url,
            api_token=config.plane.api_token,
            workspace_slug=config.plane.workspace_slug,
            project_identifier=config.plane.project_identifier,
            project_ids=config.plane.project_ids,
        )

        self.tmux_client = TmuxSessionServiceClient(
            base_url=config.tmux_session_service.url
        )

        # Register routes
        self._register_routes()

    def _register_routes(self):
        """Register API routes."""

        @self.app.get("/health")
        async def health():
            """Health check endpoint."""
            tmux_healthy = await self.tmux_client.health_check()

            # Update queue metrics
            metrics.pending_tickets_gauge.set(len(self.pending_tickets))
            metrics.active_sessions_gauge.set(len(self.active_sessions))
            metrics.completed_tickets_gauge.set(len(self.completed_tickets))

            return {
                "status": "healthy" if tmux_healthy else "degraded",
                "tmux_service": tmux_healthy,
                "pending_count": len(self.pending_tickets),
                "active_count": len(self.active_sessions),
                "completed_count": len(self.completed_tickets),
            }

        @self.app.get("/metrics")
        async def get_metrics_endpoint():
            """Prometheus metrics endpoint."""
            # Update queue metrics before returning
            metrics.pending_tickets_gauge.set(len(self.pending_tickets))
            metrics.active_sessions_gauge.set(len(self.active_sessions))
            metrics.completed_tickets_gauge.set(len(self.completed_tickets))

            return Response(
                content=metrics.get_metrics(),
                media_type=metrics.get_content_type(),
            )

        @self.app.get("/api/pending-tickets", response_model=list[TicketResponse])
        async def get_pending_tickets():
            """Get list of pending tickets awaiting approval."""
            return [
                TicketResponse(**ticket)
                for ticket in self.pending_tickets.values()
            ]

        @self.app.get("/api/completed-tickets", response_model=list[TicketResponse])
        async def get_completed_tickets():
            """Get list of completed tickets awaiting Plane update."""
            return [
                TicketResponse(**ticket)
                for ticket in self.completed_tickets.values()
            ]

        @self.app.post("/api/approve/{ticket_id}", response_model=ApproveResponse)
        async def approve_ticket(ticket_id: str):
            """Approve a ticket and create Claude Code session.

            Args:
                ticket_id: Ticket ID to approve (e.g., "CSLOG-16")

            Returns:
                Session creation details
            """
            # Check if ticket exists in pending queue
            if ticket_id not in self.pending_tickets:
                raise HTTPException(status_code=404, detail="Ticket not found in pending queue")

            ticket = self.pending_tickets[ticket_id]

            # Create unique session ID with timestamp to allow re-approving same ticket
            timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            session_id = f"{self.config.automation.session_prefix}{ticket_id}-{timestamp}"

            # Build command to run claude-ticket-worker
            command = (
                f"cd {self.config.automation.repo_path} && "
                f"./scripts/claude-ticket-worker {ticket_id}"
            )

            try:
                # Create tmux session via tmux-session-service
                session_details = await self.tmux_client.create_session(
                    session_id=session_id,
                    project_id=self.config.automation.project_id,
                    command=command,
                )

                # Move ticket from pending to active
                self.active_sessions[ticket_id] = {
                    **ticket,
                    "session_id": session_id,
                    "started_at": datetime.now().isoformat(),
                }

                del self.pending_tickets[ticket_id]

                # Update metrics
                metrics.tickets_approved_total.inc()
                metrics.pending_tickets_gauge.set(len(self.pending_tickets))
                metrics.active_sessions_gauge.set(len(self.active_sessions))

                logger.info(f"Approved ticket {ticket_id}, created session {session_id}")

                return ApproveResponse(
                    session_id=session_id,
                    ticket_id=ticket_id,
                    created_at=datetime.now().isoformat(),
                )

            except Exception as e:
                logger.error(f"Failed to create session for {ticket_id}: {e}")
                raise HTTPException(
                    status_code=500, detail=f"Failed to create session: {str(e)}"
                )

        @self.app.post("/api/update-plane/{ticket_id}")
        async def update_plane_ticket(ticket_id: str, request: UpdatePlaneRequest):
            """Update Plane ticket with completion summary.

            Args:
                ticket_id: Ticket ID to update
                request: Update request with summary

            Returns:
                Update status
            """
            # Check if ticket exists in completed queue
            if ticket_id not in self.completed_tickets:
                raise HTTPException(
                    status_code=404, detail="Ticket not found in completed queue"
                )

            ticket = self.completed_tickets[ticket_id]

            try:
                # Add comment to Plane
                comment_html = (
                    f"<p>{request.summary}</p>"
                    f"<p>🤖 Completed with Claude Code assistance</p>"
                )

                success = await self.plane_client.add_issue_comment(
                    project_id=ticket["project_id"],
                    issue_id=ticket["uuid"],
                    comment_html=comment_html,
                )

                if not success:
                    logger.error(f"Failed to add comment to Plane for ticket {ticket_id}")
                    metrics.plane_updates_total.labels(status="failed_comment").inc()
                    raise HTTPException(
                        status_code=500,
                        detail="Failed to add comment to Plane. Ticket remains in completed queue."
                    )

                # Get "In Progress" state ID
                in_progress_state_id = await self.plane_client.get_in_progress_state_id(
                    project_id=ticket["project_id"]
                )

                if in_progress_state_id:
                    # Update issue state (non-critical - don't fail if this fails)
                    try:
                        state_updated = await self.plane_client.update_issue_state(
                            project_id=ticket["project_id"],
                            issue_id=ticket["uuid"],
                            state_id=in_progress_state_id,
                        )
                        if not state_updated:
                            logger.warning(
                                f"Failed to update state for ticket {ticket_id}, "
                                "but comment was posted successfully"
                            )
                            metrics.plane_updates_total.labels(status="failed_state").inc()
                    except Exception as state_error:
                        logger.warning(
                            f"Exception updating state for ticket {ticket_id}: {state_error}. "
                            "Comment was posted successfully, continuing..."
                        )
                else:
                    logger.warning(
                        f"No 'In Progress' state found for project {ticket['project_id']}, "
                        "skipping state update"
                    )

                # Only remove from completed queue if comment was successfully posted
                del self.completed_tickets[ticket_id]

                # Update metrics
                metrics.plane_updates_total.labels(status="success").inc()
                metrics.completed_tickets_gauge.set(len(self.completed_tickets))

                logger.info(f"Successfully updated Plane ticket {ticket_id}")

                return {
                    "status": "updated",
                    "ticket_id": ticket_id,
                    "comment_posted": True,
                    "state_updated": in_progress_state_id is not None,
                }

            except HTTPException:
                # Re-raise HTTP exceptions without wrapping
                raise
            except Exception as e:
                logger.error(f"Unexpected error updating Plane ticket {ticket_id}: {e}", exc_info=True)
                raise HTTPException(
                    status_code=500,
                    detail=f"Failed to update Plane: {str(e)}. Ticket remains in completed queue."
                )

        @self.app.delete("/api/tickets/{ticket_id}")
        async def delete_ticket(ticket_id: str):
            """Remove a ticket from pending or completed queue.

            Args:
                ticket_id: Ticket ID to remove

            Returns:
                Deletion status
            """
            deleted = False

            if ticket_id in self.pending_tickets:
                del self.pending_tickets[ticket_id]
                deleted = True

            if ticket_id in self.completed_tickets:
                del self.completed_tickets[ticket_id]
                deleted = True

            if not deleted:
                raise HTTPException(status_code=404, detail="Ticket not found")

            return {"status": "deleted", "ticket_id": ticket_id}

        @self.app.post("/api/test/add-ticket", response_model=TicketResponse)
        async def add_test_ticket(ticket: TicketResponse):
            """Add a test ticket to the pending queue (for development/testing).

            Args:
                ticket: Ticket data to add

            Returns:
                Added ticket data
            """
            # Convert to dict and add to pending queue
            ticket_dict = ticket.model_dump()
            self.add_pending_ticket(ticket_dict)

            logger.info(f"Added test ticket via API: {ticket.id}")

            return ticket

    def add_pending_ticket(self, ticket: dict[str, Any]):
        """Add a ticket to the pending queue.

        Args:
            ticket: Ticket data from Plane polling
        """
        ticket_id = ticket["id"]
        self.pending_tickets[ticket_id] = ticket

        # Update metrics
        metrics.pending_tickets_gauge.set(len(self.pending_tickets))

        logger.info(f"Added pending ticket: {ticket_id} ({ticket.get('trigger_type')})")

    def mark_ticket_completed(self, ticket_id: str, summary: str):
        """Move a ticket from active to completed queue.

        Args:
            ticket_id: Ticket ID to mark as completed
            summary: Completion summary from user
        """
        if ticket_id in self.active_sessions:
            ticket = self.active_sessions[ticket_id]
            ticket["summary"] = summary
            ticket["completed_at"] = datetime.now().isoformat()

            self.completed_tickets[ticket_id] = ticket
            del self.active_sessions[ticket_id]

            # Update metrics
            metrics.tickets_completed_total.inc()
            metrics.active_sessions_gauge.set(len(self.active_sessions))
            metrics.completed_tickets_gauge.set(len(self.completed_tickets))

            # Record session duration if we have started_at timestamp
            if "started_at" in ticket:
                try:
                    started_at = datetime.fromisoformat(ticket["started_at"])
                    completed_at = datetime.fromisoformat(ticket["completed_at"])
                    duration_seconds = (completed_at - started_at).total_seconds()
                    metrics.session_duration.observe(duration_seconds)
                except (ValueError, KeyError) as e:
                    logger.warning(f"Failed to calculate session duration for {ticket_id}: {e}")

            logger.info(f"Marked ticket {ticket_id} as completed")
