"""Validated data passed between the intake service's deep modules."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class FrozenModel(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class SourceAttachment(FrozenModel):
    file_id: str
    name: str
    mime_type: str = "application/octet-stream"
    size: int = Field(ge=0)
    sha256: str = ""
    local_path: Path | None = None
    source_url: str = ""
    warning: str = ""

    @property
    def available(self) -> bool:
        return self.local_path is not None and not self.warning


class SourceMessage(FrozenModel):
    provider: Literal["slack"] = "slack"
    team_id: str
    channel_id: str
    message_ts: str
    author_id: str
    author_name: str
    text: str
    permalink: str
    posted_at: datetime
    attachments: tuple[SourceAttachment, ...] = ()

    @property
    def source_key(self) -> str:
        return f"slack:{self.team_id}:{self.channel_id}:{self.message_ts}"


class ProblemAnalysis(FrozenModel):
    title: str = Field(min_length=1, max_length=255)
    summary: str = Field(min_length=1)
    confirmed_facts: tuple[str, ...] = ()
    inferences: tuple[str, ...] = ()
    missing_information: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()
    model_used: str | None = None
    analysis_kind: Literal["text", "vision", "fallback"] = "text"

    @field_validator("confirmed_facts", "inferences", "missing_information", "warnings")
    @classmethod
    def remove_blank_entries(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        return tuple(value.strip() for value in values if value.strip())


class PlaneWorkItem(FrozenModel):
    id: str
    key: str
    url: str


class UploadReport(FrozenModel):
    uploaded: int = 0
    warnings: tuple[str, ...] = ()


class IntakeResult(FrozenModel):
    status: Literal["created", "existing", "partial", "failed"]
    issue_key: str | None = None
    issue_url: str | None = None
    model_used: str | None = None
    attachments_uploaded: int = 0
    warnings: tuple[str, ...] = ()
