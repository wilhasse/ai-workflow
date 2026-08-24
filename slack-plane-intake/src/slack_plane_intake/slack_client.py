"""Slack retrieval and authorization behind one exact-message operation."""

from __future__ import annotations

import hashlib
import re
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from .config import LimitConfig, SlackConfig
from .errors import ExternalServiceError, SourceValidationError
from .models import SourceAttachment, SourceMessage

_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")
_MESSAGE_TS = re.compile(r"\d{9,}\.(?:\d{1,6})")
_TEAM_ID = re.compile(r"T[A-Z0-9]+")
_CHANNEL_ID = re.compile(r"[CDG][A-Z0-9]+")


class SlackClient:
    def __init__(
        self,
        config: SlackConfig,
        limits: LimitConfig,
        work_dir: Path,
        *,
        client: httpx.AsyncClient | None = None,
        base_url: str = "https://slack.com/api",
    ) -> None:
        self.config = config
        self.limits = limits
        self.work_dir = work_dir
        self._owns_client = client is None
        self.client = client or httpx.AsyncClient(
            base_url=base_url,
            headers={"Authorization": f"Bearer {config.bot_token}"},
            timeout=60,
            follow_redirects=False,
        )

    async def close(self) -> None:
        if self._owns_client:
            await self.client.aclose()

    async def _api(
        self, method: str, *, request_method: str = "GET", **params: str
    ) -> dict:
        try:
            if request_method == "POST":
                response = await self.client.post(method, data=params)
            else:
                response = await self.client.get(method, params=params)
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise ExternalServiceError(
                f"Slack API request failed for {method}"
            ) from exc
        if not payload.get("ok"):
            error = str(payload.get("error", "unknown_error"))
            raise ExternalServiceError(f"Slack API rejected {method}: {error}")
        return payload

    async def fetch_source_message(self, message_ts: str) -> SourceMessage:
        if not _MESSAGE_TS.fullmatch(message_ts):
            raise SourceValidationError("Slack message timestamp is invalid")

        auth = await self._api("auth.test")
        team_id = str(auth.get("team_id", ""))
        if not team_id:
            raise ExternalServiceError("Slack auth.test did not return a team ID")

        allowed_user = next(iter(self.config.allowed_users))
        resolved_dm = (
            await self._api(
                "conversations.open",
                request_method="POST",
                users=allowed_user,
            )
        ).get("channel", {})
        resolved_channel_id = str(resolved_dm.get("id", ""))
        if (
            not re.fullmatch(r"D[A-Z0-9]+", resolved_channel_id)
            or resolved_channel_id != self.config.channel_id
        ):
            raise SourceValidationError(
                "Configured Slack intake conversation does not match the authorized Hermes DM"
            )

        history = await self._api(
            "conversations.history",
            channel=self.config.channel_id,
            oldest=message_ts,
            latest=message_ts,
            inclusive="true",
            limit="1",
        )
        message = next(
            (
                item
                for item in history.get("messages", [])
                if str(item.get("ts", "")) == message_ts
            ),
            None,
        )
        if message is None:
            raise SourceValidationError(
                "Slack message was not found in the configured Hermes DM"
            )

        author_id = str(message.get("user", ""))
        if author_id not in self.config.allowed_users:
            raise SourceValidationError(
                "Slack author is not allowed to create problem tickets"
            )
        if message.get("subtype") or message.get("bot_id"):
            raise SourceValidationError(
                "Bot and subtype messages are not accepted for intake"
            )

        thread_ts = str(message.get("thread_ts", ""))
        if thread_ts and thread_ts != message_ts:
            raise SourceValidationError(
                "Thread replies are not intake sources; send a new top-level DM"
            )

        text = str(message.get("text", ""))

        permalink_payload = await self._api(
            "chat.getPermalink", channel=self.config.channel_id, message_ts=message_ts
        )
        permalink = str(permalink_payload.get("permalink", ""))
        if not permalink:
            raise ExternalServiceError("Slack did not return a message permalink")

        author_name = author_id
        author_name = await self._resolve_user_name(author_id)

        attachments = await self._download_attachments(
            message_ts, tuple(message.get("files") or ())
        )
        return SourceMessage(
            team_id=team_id,
            channel_id=self.config.channel_id,
            message_ts=message_ts,
            author_id=author_id,
            author_name=author_name,
            text=text,
            permalink=permalink,
            posted_at=datetime.fromtimestamp(float(message_ts), tz=UTC),
            attachments=attachments,
        )

    async def fetch_shortcut_source_message(
        self,
        *,
        team_id: str,
        channel_id: str,
        invoking_user_id: str,
        message_payload: dict,
    ) -> SourceMessage:
        """Build a source from a Slack-authenticated message shortcut payload.

        Authorization belongs to the human invoking the shortcut. The selected
        message may have been posted by a monitoring bot, so its author is
        recorded as provenance but is not used as the authorization principal.
        """
        if invoking_user_id not in self.config.allowed_users:
            raise SourceValidationError(
                "Slack user is not allowed to create problem tickets"
            )
        if not _TEAM_ID.fullmatch(team_id):
            raise SourceValidationError("Slack shortcut workspace ID is invalid")
        if not _CHANNEL_ID.fullmatch(channel_id):
            raise SourceValidationError("Slack shortcut channel ID is invalid")
        if not isinstance(message_payload, dict):
            raise SourceValidationError("Slack shortcut message payload is invalid")

        message_ts = str(message_payload.get("ts", ""))
        if not _MESSAGE_TS.fullmatch(message_ts):
            raise SourceValidationError("Slack message timestamp is invalid")

        auth = await self._api("auth.test")
        authenticated_team_id = str(auth.get("team_id", ""))
        if authenticated_team_id != team_id:
            raise SourceValidationError(
                "Slack shortcut workspace does not match the configured bot token"
            )

        files = tuple(
            item
            for item in (message_payload.get("files") or ())
            if isinstance(item, dict)
        )
        text = self._shortcut_message_text(message_payload)
        if not text and not files:
            raise SourceValidationError(
                "The selected Slack message has no text or files to process"
            )

        bot_profile = message_payload.get("bot_profile")
        if not isinstance(bot_profile, dict):
            bot_profile = {}
        author_id = str(
            message_payload.get("user")
            or message_payload.get("bot_id")
            or bot_profile.get("id")
            or "unknown"
        )
        if author_id.startswith(("U", "W")):
            author_name = await self._resolve_user_name(author_id)
        else:
            author_name = str(
                bot_profile.get("name") or message_payload.get("username") or author_id
            )

        permalink = ""
        try:
            permalink_payload = await self._api(
                "chat.getPermalink", channel=channel_id, message_ts=message_ts
            )
            permalink = str(permalink_payload.get("permalink", ""))
        except ExternalServiceError:
            # A message shortcut can be invoked where the app is not a channel
            # member. The authenticated shortcut body remains authoritative;
            # ticket creation should continue without a clickable permalink.
            pass

        attachments = await self._download_attachments(message_ts, files)
        return SourceMessage(
            team_id=team_id,
            channel_id=channel_id,
            message_ts=message_ts,
            author_id=author_id,
            author_name=author_name,
            text=text,
            permalink=permalink,
            posted_at=datetime.fromtimestamp(float(message_ts), tz=UTC),
            attachments=attachments,
        )

    async def _resolve_user_name(self, user_id: str) -> str:
        try:
            user_payload = await self._api("users.info", user=user_id)
            user = user_payload.get("user", {})
            profile = user.get("profile", {})
            return str(
                profile.get("display_name")
                or profile.get("real_name")
                or user.get("real_name")
                or user.get("name")
                or user_id
            )
        except ExternalServiceError:
            return user_id

    @staticmethod
    def _shortcut_message_text(message: dict) -> str:
        primary = str(message.get("text") or "").strip()
        details: list[str] = []
        for attachment in message.get("attachments") or ():
            if not isinstance(attachment, dict):
                continue
            for key in ("pretext", "title", "text", "fallback"):
                value = str(attachment.get(key) or "").strip()
                if value and value not in primary and value not in details:
                    details.append(value)
            for field in attachment.get("fields") or ():
                if not isinstance(field, dict):
                    continue
                title = str(field.get("title") or "").strip()
                value = str(field.get("value") or "").strip()
                rendered = ": ".join(part for part in (title, value) if part)
                if rendered and rendered not in primary and rendered not in details:
                    details.append(rendered)

        if not primary:
            block_text: list[str] = []

            def collect(value: object) -> None:
                if isinstance(value, dict):
                    text = value.get("text")
                    if isinstance(text, str) and text.strip():
                        block_text.append(text.strip())
                    for key, child in value.items():
                        if key != "text":
                            collect(child)
                elif isinstance(value, list):
                    for child in value:
                        collect(child)

            collect(message.get("blocks") or [])
            primary = "\n".join(dict.fromkeys(block_text))

        parts = [primary] if primary else []
        if details:
            parts.extend(("Slack attachment details:", *details))
        return "\n\n".join(parts)

    async def _download_attachments(
        self, message_ts: str, files: tuple[dict, ...]
    ) -> tuple[SourceAttachment, ...]:
        batch_dir = self.work_dir / message_ts.replace(".", "_")
        total_bytes = 0
        results: list[SourceAttachment] = []

        for index, shallow in enumerate(files):
            file_id = str(shallow.get("id", "")) or f"unknown-{index + 1}"
            if index >= self.limits.max_files:
                results.append(
                    self._metadata(shallow, file_id, "file-count limit exceeded")
                )
                continue
            try:
                detail = (await self._api("files.info", file=file_id)).get("file", {})
            except ExternalServiceError as exc:
                results.append(self._metadata(shallow, file_id, str(exc)))
                continue

            size = int(detail.get("size") or 0)
            if size > self.limits.max_file_bytes:
                results.append(
                    self._metadata(detail, file_id, "per-file size limit exceeded")
                )
                continue
            if total_bytes + size > self.limits.max_total_bytes:
                results.append(
                    self._metadata(detail, file_id, "batch size limit exceeded")
                )
                continue

            download_url = str(
                detail.get("url_private_download") or detail.get("url_private") or ""
            )
            if not self._allowed_download_url(download_url):
                results.append(
                    self._metadata(detail, file_id, "unsafe or missing download URL")
                )
                continue

            original_name = str(detail.get("name") or f"{file_id}.bin")
            safe_name = _SAFE_NAME.sub("_", Path(original_name).name).strip("._")
            safe_name = safe_name or f"{file_id}.bin"
            local_path = batch_dir / f"{file_id}-{safe_name}"
            try:
                raw = await self._download(download_url, self.limits.max_file_bytes)
            except ExternalServiceError as exc:
                results.append(self._metadata(detail, file_id, str(exc)))
                continue
            if size and len(raw) != size:
                results.append(
                    self._metadata(
                        detail, file_id, "downloaded size did not match Slack metadata"
                    )
                )
                continue

            batch_dir.mkdir(parents=True, exist_ok=True)
            local_path.write_bytes(raw)
            total_bytes += len(raw)
            results.append(
                SourceAttachment(
                    file_id=file_id,
                    name=original_name,
                    mime_type=str(detail.get("mimetype") or "application/octet-stream"),
                    size=len(raw),
                    sha256=hashlib.sha256(raw).hexdigest(),
                    local_path=local_path,
                    source_url=str(detail.get("permalink") or ""),
                )
            )
        return tuple(results)

    async def _download(self, url: str, max_bytes: int) -> bytes:
        try:
            async with self.client.stream("GET", url) as response:
                response.raise_for_status()
                chunks: list[bytes] = []
                size = 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > max_bytes:
                        raise ExternalServiceError(
                            "Slack file exceeded the download limit"
                        )
                    chunks.append(chunk)
                return b"".join(chunks)
        except ExternalServiceError:
            raise
        except httpx.HTTPError as exc:
            raise ExternalServiceError("Slack file download failed") from exc

    @staticmethod
    def _allowed_download_url(url: str) -> bool:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").lower()
        return parsed.scheme == "https" and (
            host == "slack.com" or host.endswith(".slack.com")
        )

    @staticmethod
    def _metadata(payload: dict, file_id: str, warning: str) -> SourceAttachment:
        return SourceAttachment(
            file_id=file_id,
            name=str(payload.get("name") or file_id),
            mime_type=str(payload.get("mimetype") or "application/octet-stream"),
            size=max(0, int(payload.get("size") or 0)),
            source_url=str(payload.get("permalink") or ""),
            warning=warning,
        )
