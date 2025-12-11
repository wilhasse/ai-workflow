"""Prometheus metrics for monitoring."""

from prometheus_client import Counter, Gauge, Histogram, generate_latest, CONTENT_TYPE_LATEST


# Queue metrics
pending_tickets_gauge = Gauge(
    "plane_pending_tickets",
    "Number of tickets in pending queue awaiting approval",
)

active_sessions_gauge = Gauge(
    "plane_active_sessions",
    "Number of active Claude Code sessions currently running",
)

completed_tickets_gauge = Gauge(
    "plane_completed_tickets",
    "Number of completed tickets awaiting Plane update",
)

# Ticket lifecycle metrics
tickets_approved_total = Counter(
    "plane_tickets_approved_total",
    "Total number of tickets approved and sessions created",
)

tickets_completed_total = Counter(
    "plane_tickets_completed_total",
    "Total number of tickets marked as completed",
)

plane_updates_total = Counter(
    "plane_updates_total",
    "Total number of successful Plane ticket updates",
    ["status"],  # Labels: success, failed_comment, failed_state
)

# API performance metrics
api_request_duration = Histogram(
    "plane_api_request_duration_seconds",
    "Time spent processing API requests",
    ["method", "endpoint"],
    buckets=(0.1, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0),
)

api_requests_total = Counter(
    "plane_api_requests_total",
    "Total number of API requests",
    ["method", "endpoint", "status"],
)

# Plane API interaction metrics
plane_api_calls_total = Counter(
    "plane_api_calls_total",
    "Total number of Plane API calls",
    ["operation", "status"],  # operation: poll, add_comment, update_state, etc.
)

plane_api_retry_total = Counter(
    "plane_api_retry_total",
    "Total number of Plane API retry attempts",
    ["operation"],
)

# Session metrics
session_duration = Histogram(
    "plane_session_duration_seconds",
    "Time from session creation to completion",
    buckets=(60, 300, 600, 1800, 3600, 7200, 14400),  # 1m, 5m, 10m, 30m, 1h, 2h, 4h
)


def get_metrics() -> bytes:
    """Generate Prometheus metrics in text format.

    Returns:
        Metrics in Prometheus text format
    """
    return generate_latest()


def get_content_type() -> str:
    """Get Prometheus content type.

    Returns:
        Content-Type header value
    """
    return CONTENT_TYPE_LATEST
