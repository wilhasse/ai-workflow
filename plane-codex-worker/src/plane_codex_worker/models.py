"""Small validated data objects shared by the worker layers."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PlaneIssue:
    id: str
    sequence_id: int
    name: str
    description_html: str
    state_id: str
    updated_at: str


@dataclass(frozen=True)
class PlaneState:
    id: str
    name: str
    group: str


@dataclass(frozen=True)
class StateSet:
    backlog: PlaneState
    running: PlaneState
    review: PlaneState
    blocked: PlaneState


@dataclass(frozen=True)
class CodexRun:
    thread_id: str
    turn_id: str


@dataclass(frozen=True)
class CodexResult:
    thread_id: str
    turn_id: str
    status: str
    output: str


@dataclass(frozen=True)
class Job:
    issue_id: str
    issue_key: str
    status: str
    attempt_count: int
    thread_id: str = ""
    turn_id: str = ""
