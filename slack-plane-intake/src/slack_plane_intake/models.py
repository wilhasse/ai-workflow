"""Validated data passed between the intake service's deep modules."""

from __future__ import annotations

import hashlib
from datetime import datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


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


class SourceMessagePart(FrozenModel):
    message_ts: str = Field(pattern=r"\d{9,}\.(?:\d{1,6})")
    author_id: str
    author_name: str
    text: str
    permalink: str
    posted_at: datetime
    attachments: tuple[SourceAttachment, ...] = ()


class SourceMessage(FrozenModel):
    provider: Literal["slack"] = "slack"
    team_id: str
    channel_id: str
    messages: tuple[SourceMessagePart, ...] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def validate_messages(self) -> SourceMessage:
        timestamps = tuple(part.message_ts for part in self.messages)
        if len(set(timestamps)) != len(timestamps):
            raise ValueError("Slack source messages must be unique")
        if timestamps != tuple(sorted(timestamps, key=float)):
            raise ValueError("Slack source messages must be chronological")
        return self

    @property
    def message_ts(self) -> str:
        return self.messages[-1].message_ts

    @property
    def author_id(self) -> str:
        return self.messages[-1].author_id

    @property
    def author_name(self) -> str:
        return self.messages[-1].author_name

    @property
    def permalink(self) -> str:
        return self.messages[-1].permalink

    @property
    def posted_at(self) -> datetime:
        return self.messages[-1].posted_at

    @property
    def attachments(self) -> tuple[SourceAttachment, ...]:
        return tuple(
            attachment for part in self.messages for attachment in part.attachments
        )

    @property
    def text(self) -> str:
        if len(self.messages) == 1:
            return self.messages[0].text
        sections = []
        for index, part in enumerate(self.messages, start=1):
            sections.append(
                f"Mensagem {index} — {part.author_name} — "
                f"{part.posted_at.isoformat()}\n{part.text}"
            )
        return "\n\n".join(sections)

    @property
    def source_key(self) -> str:
        if len(self.messages) == 1:
            return f"slack:{self.team_id}:{self.channel_id}:{self.message_ts}"
        timestamps = ",".join(part.message_ts for part in self.messages)
        digest = hashlib.sha256(timestamps.encode("utf-8")).hexdigest()
        return f"slack-bundle:{self.team_id}:{self.channel_id}:{digest}"


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


class PlaneProject(FrozenModel):
    id: str = Field(min_length=1, max_length=64)
    identifier: str = Field(min_length=1, max_length=255)
    name: str = Field(min_length=1, max_length=255)


class UploadReport(FrozenModel):
    uploaded: int = 0
    warnings: tuple[str, ...] = ()


class IntakeResult(FrozenModel):
    status: Literal["created", "appended", "existing", "partial", "failed"]
    issue_key: str | None = None
    issue_url: str | None = None
    model_used: str | None = None
    attachments_uploaded: int = 0
    warnings: tuple[str, ...] = ()
