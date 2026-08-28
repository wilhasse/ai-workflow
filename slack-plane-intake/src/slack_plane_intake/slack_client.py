"""Slack retrieval and authorization behind one exact-message operation."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from .config import LimitConfig, SlackConfig
from .errors import ExternalServiceError, SourceValidationError
from .models import SourceAttachment, SourceMessage, SourceMessagePart

_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")
_MESSAGE_TS = re.compile(r"\d{9,}\.(?:\d{1,6})")
_TEAM_ID = re.compile(r"T[A-Z0-9]+")
_CHANNEL_ID = re.compile(r"[CDG][A-Z0-9]+")
_HISTORY_WINDOW_SECONDS = 30 * 60
_HISTORY_CANDIDATE_LIMIT = 100
_HISTORY_SELECTION_LIMIT = 20


@dataclass
class _DownloadBudget:
    files_seen: int = 0
    total_bytes: int = 0


class SlackClient:
    def __init__(
        self,
        config: SlackConfig,
        limits: LimitConfig,
        work_dir: Path,
        *,
        client: httpx.AsyncClient | None = None,
        user_client: httpx.AsyncClient | None = None,
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
        self._owns_user_client = user_client is None and bool(config.history_user_token)
        self.user_client = user_client
        if self.user_client is None and config.history_user_token:
            self.user_client = httpx.AsyncClient(
                base_url=base_url,
                headers={"Authorization": f"Bearer {config.history_user_token}"},
                timeout=60,
                follow_redirects=False,
            )

    async def close(self) -> None:
        if self._owns_client:
            await self.client.aclose()
        if self._owns_user_client and self.user_client is not None:
            await self.user_client.aclose()

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

    async def _user_api(self, method: str, **params: str) -> dict:
        if self.user_client is None:
            raise SourceValidationError(
                "Slack DM history picker is not configured for this user"
            )
        try:
            response = await self.user_client.get(method, params=params)
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise ExternalServiceError(
                f"Slack user API request failed for {method}"
            ) from exc
        if not payload.get("ok"):
            error = str(payload.get("error", "unknown_error"))
            raise ExternalServiceError(f"Slack user API rejected {method}: {error}")
        return payload

    async def fetch_shortcut_history_payloads(
        self,
        *,
        team_id: str,
        channel_id: str,
        invoking_user_id: str,
        selected_message_payload: dict,
    ) -> tuple[dict, ...]:
        """Fetch the 20 closest messages in a 30-minute window as the user."""
        if (
            not self.config.history_user_id
            or invoking_user_id != self.config.history_user_id
        ):
            raise SourceValidationError(
                "Slack DM history picker is not configured for this user"
            )
        await self._authorize_shortcut(
            team_id=team_id,
            channel_id=channel_id,
            invoking_user_id=invoking_user_id,
        )
        selected_ts = str(selected_message_payload.get("ts", ""))
        if not _MESSAGE_TS.fullmatch(selected_ts):
            raise SourceValidationError("Slack message timestamp is invalid")
        selected_time = Decimal(selected_ts)

        auth = await self._user_api("auth.test")
        self._validate_history_identity(
            auth,
            team_id=team_id,
            invoking_user_id=invoking_user_id,
        )
        history = await self._user_api(
            "conversations.history",
            channel=channel_id,
            oldest=str(selected_time - _HISTORY_WINDOW_SECONDS),
            latest=str(selected_time + _HISTORY_WINDOW_SECONDS),
            inclusive="true",
            limit=str(_HISTORY_CANDIDATE_LIMIT),
        )
        candidates: dict[str, dict] = {}
        for value in history.get("messages") or ():
            if not isinstance(value, dict):
                continue
            message_ts = str(value.get("ts", ""))
            if not _MESSAGE_TS.fullmatch(message_ts):
                continue
            if abs(Decimal(message_ts) - selected_time) > _HISTORY_WINDOW_SECONDS:
                continue
            if not str(value.get("text") or "").strip() and not value.get("files"):
                continue
            candidates[message_ts] = value
        candidates[selected_ts] = selected_message_payload
        selected_timestamps = sorted(
            candidates,
            key=lambda value: (abs(Decimal(value) - selected_time), Decimal(value)),
        )[:_HISTORY_SELECTION_LIMIT]
        ordered = tuple(
            candidates[value] for value in sorted(selected_timestamps, key=Decimal)
        )
        if not ordered:
            raise SourceValidationError("Slack DM history did not contain messages")
        preview_names: dict[str, str] = {}
        decorated = []
        for value in ordered:
            message = dict(value)
            author_id = str(message.get("user") or "")
            if author_id.startswith(("U", "W")):
                if author_id not in preview_names:
                    preview_names[author_id] = await self._resolve_user_name(author_id)
                message["username"] = preview_names[author_id]
            decorated.append(message)
        return tuple(decorated)

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
        part = SourceMessagePart(
            message_ts=message_ts,
            author_id=author_id,
            author_name=author_name,
            text=text,
            permalink=permalink,
            posted_at=datetime.fromtimestamp(float(message_ts), tz=UTC),
            attachments=attachments,
        )
        return SourceMessage(
            team_id=team_id,
            channel_id=self.config.channel_id,
            messages=(part,),
        )

    async def fetch_shortcut_source_message(
        self,
        *,
        team_id: str,
        channel_id: str,
        invoking_user_id: str,
        message_payload: dict,
    ) -> SourceMessage:
        """Build a source from one Slack-authenticated message shortcut payload."""
        return await self.fetch_shortcut_source_messages(
            team_id=team_id,
            channel_id=channel_id,
            invoking_user_id=invoking_user_id,
            message_payloads=(message_payload,),
        )

    async def fetch_shortcut_source_messages(
        self,
        *,
        team_id: str,
        channel_id: str,
        invoking_user_id: str,
        message_payloads: tuple[dict, ...],
    ) -> SourceMessage:
        """Build one ordered source from authenticated shortcut payloads.

        Authorization belongs to the human invoking the shortcut. The selected
        message may have been posted by a monitoring bot, so its author is
        recorded as provenance but is not used as the authorization principal.
        """
        await self._authorize_shortcut(
            team_id=team_id,
            channel_id=channel_id,
            invoking_user_id=invoking_user_id,
        )
        if not 1 <= len(message_payloads) <= _HISTORY_SELECTION_LIMIT:
            raise SourceValidationError(
                "Slack ticket source must contain between 1 and 20 messages"
            )
        timestamps = []
        for message_payload in message_payloads:
            if not isinstance(message_payload, dict):
                raise SourceValidationError("Slack shortcut message payload is invalid")
            message_ts = str(message_payload.get("ts", ""))
            if not _MESSAGE_TS.fullmatch(message_ts):
                raise SourceValidationError("Slack message timestamp is invalid")
            timestamps.append(message_ts)
        if len(set(timestamps)) != len(timestamps):
            raise SourceValidationError(
                "Slack ticket source contains duplicate messages"
            )

        budget = _DownloadBudget()
        parts = []
        use_history_user = bool(
            self.config.history_user_token
            and invoking_user_id == self.config.history_user_id
        )
        if use_history_user:
            history_auth = await self._user_api("auth.test")
            self._validate_history_identity(
                history_auth,
                team_id=team_id,
                invoking_user_id=invoking_user_id,
            )
        for message_payload in sorted(
            message_payloads, key=lambda payload: float(str(payload["ts"]))
        ):
            parts.append(
                await self._shortcut_source_part(
                    channel_id=channel_id,
                    message_payload=message_payload,
                    budget=budget,
                    use_history_user=use_history_user,
                )
            )
        ordered = tuple(sorted(parts, key=lambda part: float(part.message_ts)))
        return SourceMessage(
            team_id=team_id,
            channel_id=channel_id,
            messages=ordered,
        )

    async def _authorize_shortcut(
        self, *, team_id: str, channel_id: str, invoking_user_id: str
    ) -> None:
        if invoking_user_id not in self.config.shortcut_allowed_users:
            raise SourceValidationError(
                "Slack user is not allowed to create problem tickets"
            )
        if not _TEAM_ID.fullmatch(team_id):
            raise SourceValidationError("Slack shortcut workspace ID is invalid")
        if not _CHANNEL_ID.fullmatch(channel_id):
            raise SourceValidationError("Slack shortcut channel ID is invalid")

        auth = await self._api("auth.test")
        authenticated_team_id = str(auth.get("team_id", ""))
        if authenticated_team_id != team_id:
            raise SourceValidationError(
                "Slack shortcut workspace does not match the configured bot token"
            )

    async def _shortcut_source_part(
        self,
        *,
        channel_id: str,
        message_payload: dict,
        budget: _DownloadBudget,
        use_history_user: bool,
    ) -> SourceMessagePart:
        if not isinstance(message_payload, dict):
            raise SourceValidationError("Slack shortcut message payload is invalid")

        message_ts = str(message_payload.get("ts", ""))
        if not _MESSAGE_TS.fullmatch(message_ts):
            raise SourceValidationError("Slack message timestamp is invalid")

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
            if use_history_user:
                permalink_payload = await self._user_api(
                    "chat.getPermalink", channel=channel_id, message_ts=message_ts
                )
            else:
                permalink_payload = await self._api(
                    "chat.getPermalink", channel=channel_id, message_ts=message_ts
                )
            permalink = str(permalink_payload.get("permalink", ""))
        except ExternalServiceError:
            # A message shortcut can be invoked where the app is not a channel
            # member. The authenticated shortcut body remains authoritative;
            # ticket creation should continue without a clickable permalink.
            pass

        attachments = await self._download_attachments(
            message_ts,
            files,
            budget=budget,
            use_history_user=use_history_user,
        )
        return SourceMessagePart(
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
        self,
        message_ts: str,
        files: tuple[dict, ...],
        *,
        budget: _DownloadBudget | None = None,
        use_history_user: bool = False,
    ) -> tuple[SourceAttachment, ...]:
        batch_dir = self.work_dir / message_ts.replace(".", "_")
        budget = budget or _DownloadBudget()
        results: list[SourceAttachment] = []

        for index, shallow in enumerate(files):
            file_id = str(shallow.get("id", "")) or f"unknown-{index + 1}"
            if budget.files_seen >= self.limits.max_files:
                results.append(
                    self._metadata(shallow, file_id, "file-count limit exceeded")
                )
                continue
            budget.files_seen += 1
            try:
                if use_history_user:
                    detail = (await self._user_api("files.info", file=file_id)).get(
                        "file", {}
                    )
                else:
                    detail = (await self._api("files.info", file=file_id)).get(
                        "file", {}
                    )
            except ExternalServiceError as exc:
                results.append(self._metadata(shallow, file_id, str(exc)))
                continue

            size = int(detail.get("size") or 0)
            if size > self.limits.max_file_bytes:
                results.append(
                    self._metadata(detail, file_id, "per-file size limit exceeded")
                )
                continue
            if budget.total_bytes + size > self.limits.max_total_bytes:
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
                raw = await self._download(
                    download_url,
                    self.limits.max_file_bytes,
                    use_history_user=use_history_user,
                )
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
            budget.total_bytes += len(raw)
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

    async def _download(
        self, url: str, max_bytes: int, *, use_history_user: bool = False
    ) -> bytes:
        download_client = self.user_client if use_history_user else self.client
        if download_client is None:
            raise SourceValidationError(
                "Slack DM history picker is not configured for file access"
            )
        try:
            async with download_client.stream("GET", url) as response:
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
    def _validate_history_identity(
        payload: dict, *, team_id: str, invoking_user_id: str
    ) -> None:
        if str(payload.get("team_id", "")) != team_id:
            raise SourceValidationError(
                "Slack history token workspace does not match the shortcut"
            )
        if str(payload.get("user_id", "")) != invoking_user_id:
            raise SourceValidationError(
                "Slack history token does not belong to the invoking user"
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
