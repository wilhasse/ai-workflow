"""Validated Slack transport models shared by shortcut and modal CLIs."""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

CALLBACK_ID = "create_agente_ticket"
MODAL_CALLBACK_ID = "create_agente_ticket_modal"
_TEAM_ID = re.compile(r"T[A-Z0-9]+")
_USER_ID = re.compile(r"[UW][A-Z0-9]+")
_CHANNEL_ID = re.compile(r"[CDG][A-Z0-9]+")
_MESSAGE_TS = re.compile(r"\d{9,}\.(?:\d{1,6})")
_PROJECT_ID = re.compile(r"[A-Za-z0-9-]+")


class SlackObject(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)

    id: str = Field(min_length=1)


class SlackMessage(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)

    ts: str = Field(min_length=1)
    text: str = ""
    user: str = ""
    bot_id: str = ""
    username: str = ""
    subtype: str = ""
    bot_profile: dict[str, Any] | None = None
    files: tuple[dict[str, Any], ...] | None = None
    attachments: tuple[dict[str, Any], ...] | None = None
    blocks: tuple[dict[str, Any], ...] | None = None

    @field_validator("ts")
    @classmethod
    def validate_ts(cls, value: str) -> str:
        if not _MESSAGE_TS.fullmatch(value):
            raise ValueError("invalid Slack message timestamp")
        return value


class SlackMessageShortcut(BaseModel):
    """Only the transport fields accepted from Slack Bolt's shortcut body."""

    model_config = ConfigDict(extra="ignore", frozen=True)

    type: Literal["message_action"]
    callback_id: Literal["create_agente_ticket"]
    team: SlackObject
    user: SlackObject
    channel: SlackObject
    message: SlackMessage

    @field_validator("team")
    @classmethod
    def validate_team(cls, value: SlackObject) -> SlackObject:
        if not _TEAM_ID.fullmatch(value.id):
            raise ValueError("invalid Slack workspace ID")
        return value

    @field_validator("user")
    @classmethod
    def validate_user(cls, value: SlackObject) -> SlackObject:
        if not _USER_ID.fullmatch(value.id):
            raise ValueError("invalid Slack user ID")
        return value

    @field_validator("channel")
    @classmethod
    def validate_channel(cls, value: SlackObject) -> SlackObject:
        if not _CHANNEL_ID.fullmatch(value.id):
            raise ValueError("invalid Slack channel ID")
        return value


class ModalAddRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    action: Literal["add"]
    shortcut: SlackMessageShortcut


class ModalSubmitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    action: Literal["submit"]
    team_id: str
    user_id: str
    channel_id: str
    draft_id: str = Field(min_length=1, max_length=64)
    project_id: str = Field(min_length=1, max_length=64)
    selected_message_ts: tuple[str, ...] = Field(min_length=1, max_length=20)

    @field_validator("team_id")
    @classmethod
    def validate_team_id(cls, value: str) -> str:
        if not _TEAM_ID.fullmatch(value):
            raise ValueError("invalid Slack workspace ID")
        return value

    @field_validator("user_id")
    @classmethod
    def validate_user_id(cls, value: str) -> str:
        if not _USER_ID.fullmatch(value):
            raise ValueError("invalid Slack user ID")
        return value

    @field_validator("channel_id")
    @classmethod
    def validate_channel_id(cls, value: str) -> str:
        if not _CHANNEL_ID.fullmatch(value):
            raise ValueError("invalid Slack channel ID")
        return value

    @field_validator("project_id")
    @classmethod
    def validate_project_id(cls, value: str) -> str:
        if not _PROJECT_ID.fullmatch(value):
            raise ValueError("invalid Plane project ID")
        return value

    @field_validator("selected_message_ts")
    @classmethod
    def validate_selected_timestamps(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        if len(set(values)) != len(values):
            raise ValueError("duplicate selected Slack message timestamp")
        if any(not _MESSAGE_TS.fullmatch(value) for value in values):
            raise ValueError("invalid selected Slack message timestamp")
        return values


def sanitized_message_payload(message: SlackMessage) -> dict[str, Any]:
    """Keep only ticket evidence fields; drop transport URLs and metadata."""

    def block_text(value: object, output: list[str]) -> None:
        if isinstance(value, dict):
            text = value.get("text")
            if isinstance(text, str) and text.strip():
                output.append(text.strip())
            for key, child in value.items():
                if key != "text":
                    block_text(child, output)
        elif isinstance(value, (list, tuple)):
            for child in value:
                block_text(child, output)

    text = message.text.strip()
    if not text:
        values: list[str] = []
        block_text(message.blocks or (), values)
        text = "\n".join(dict.fromkeys(values))

    files = tuple(
        {
            key: file[key]
            for key in ("id", "name", "mimetype", "size", "permalink")
            if key in file
        }
        for file in (message.files or ())
    )
    attachments = []
    for attachment in message.attachments or ():
        cleaned = {
            key: attachment[key]
            for key in ("pretext", "title", "text", "fallback")
            if key in attachment
        }
        fields = tuple(
            {key: field[key] for key in ("title", "value") if key in field}
            for field in (attachment.get("fields") or ())
            if isinstance(field, dict)
        )
        if fields:
            cleaned["fields"] = fields
        attachments.append(cleaned)

    payload: dict[str, Any] = {
        "ts": message.ts,
        "text": text,
        "user": message.user,
        "bot_id": message.bot_id,
        "username": message.username,
        "subtype": message.subtype,
        "files": files,
        "attachments": tuple(attachments),
    }
    if message.bot_profile:
        payload["bot_profile"] = {
            key: message.bot_profile[key]
            for key in ("id", "name")
            if key in message.bot_profile
        }
    return payload
