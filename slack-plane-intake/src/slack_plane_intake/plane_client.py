"""Plane work-item and attachment sequencing behind a small interface."""

from __future__ import annotations

import hashlib
import html
import re
from collections.abc import Iterable
from dataclasses import replace
from pathlib import Path

import httpx

from .config import PlaneConfig
from .errors import ExternalServiceError
from .models import (
    PlaneProject,
    PlaneWorkItem,
    ProblemAnalysis,
    SourceAttachment,
    SourceMessage,
    SourceMessagePart,
    UploadReport,
)


class PlaneClient:
    def __init__(
        self,
        config: PlaneConfig,
        *,
        client: httpx.AsyncClient | None = None,
        storage_client: httpx.AsyncClient | None = None,
    ) -> None:
        self.config = config
        self._owns_client = client is None
        self._owns_storage_client = storage_client is None
        self.client = client or httpx.AsyncClient(
            base_url=config.base_url,
            headers={"X-API-Key": config.api_key},
            timeout=60,
        )
        self.storage_client = storage_client or httpx.AsyncClient(timeout=120)

    async def close(self) -> None:
        if self._owns_client:
            await self.client.aclose()
        if self._owns_storage_client:
            await self.storage_client.aclose()

    @property
    def work_items_path(self) -> str:
        return (
            f"/api/v1/workspaces/{self.config.workspace}/projects/"
            f"{self.config.project_id}/work-items/"
        )

    @property
    def projects_path(self) -> str:
        return f"/api/v1/workspaces/{self.config.workspace}/projects/"

    async def list_projects(self) -> tuple[PlaneProject, ...]:
        """Return projects in which the current Plane user can create work items."""
        try:
            response = await self.client.get(self.projects_path)
            response.raise_for_status()
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise ExternalServiceError("Plane project listing failed") from exc

        projects: list[PlaneProject] = []
        for item in self._result_items(body):
            if item.get("is_member") is False:
                continue
            try:
                projects.append(
                    PlaneProject(
                        id=str(item["id"]),
                        identifier=str(item["identifier"]).strip(),
                        name=str(item["name"]).strip(),
                    )
                )
            except (KeyError, TypeError, ValueError):
                continue

        configured_id = self.config.project_id
        return tuple(
            sorted(
                projects,
                key=lambda project: (
                    project.id != configured_id,
                    project.identifier.casefold(),
                    project.name.casefold(),
                ),
            )
        )

    async def resolve_project_config(self, project_id: str) -> PlaneConfig:
        """Revalidate one project and choose a safe initial workflow state."""
        projects = await self.list_projects()
        project = next((item for item in projects if item.id == project_id), None)
        if project is None:
            raise ExternalServiceError(
                "The selected Plane project is not available to this user"
            )

        states_path = f"{self.projects_path}{project.id}/states/"
        try:
            response = await self.client.get(states_path)
            response.raise_for_status()
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise ExternalServiceError("Plane project state listing failed") from exc

        states = tuple(
            item
            for item in self._result_items(body)
            if item.get("id") and isinstance(item.get("id"), str)
        )
        if not states:
            raise ExternalServiceError(
                "The selected Plane project has no available workflow state"
            )

        configured_state = next(
            (
                item
                for item in states
                if project.id == self.config.project_id
                and item["id"] == self.config.state_id
            ),
            None,
        )
        state = (
            configured_state
            or next((item for item in states if item.get("default") is True), None)
            or next((item for item in states if item.get("group") == "backlog"), None)
            or next((item for item in states if item.get("group") == "unstarted"), None)
            or states[0]
        )
        return replace(
            self.config,
            project_id=project.id,
            project_identifier=project.identifier,
            state_id=str(state["id"]),
        )

    @staticmethod
    def _result_items(body: object) -> tuple[dict, ...]:
        if isinstance(body, list):
            values = body
        elif isinstance(body, dict):
            values = body.get("results") or body.get("data") or ()
        else:
            values = ()
        return tuple(item for item in values if isinstance(item, dict))

    async def create_problem(
        self,
        message: SourceMessage,
        analysis: ProblemAnalysis,
        source_marker: str,
    ) -> PlaneWorkItem:
        payload = {
            "name": analysis.title,
            "description_html": self.render_description(
                message, analysis, source_marker
            ),
            "state": self.config.state_id,
            "priority": "none",
            "assignees": [],
        }
        try:
            response = await self.client.post(self.work_items_path, json=payload)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            raise ExternalServiceError(
                "Plane work-item creation had an ambiguous network failure",
                ambiguous=True,
            ) from exc
        if response.status_code >= 400:
            raise ExternalServiceError(
                f"Plane work-item creation failed with HTTP {response.status_code}"
            )
        try:
            body = response.json()
            return self._work_item_from_payload(body)
        except (ValueError, KeyError, TypeError) as exc:
            raise ExternalServiceError(
                "Plane returned an invalid work-item response", ambiguous=True
            ) from exc

    async def find_by_source_marker(self, source_marker: str) -> PlaneWorkItem | None:
        try:
            response = await self.client.get(
                self.work_items_path,
                params={"per_page": "50", "order_by": "-created_at"},
            )
            response.raise_for_status()
            body = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise ExternalServiceError("Plane reconciliation request failed") from exc

        candidates = self._result_items(body)

        for candidate in candidates:
            if not isinstance(candidate, dict) or not candidate.get("id"):
                continue
            detail = candidate
            if source_marker not in str(detail.get("description_html", "")):
                try:
                    response = await self.client.get(
                        f"{self.work_items_path}{candidate['id']}/"
                    )
                    response.raise_for_status()
                    detail = response.json()
                except (httpx.HTTPError, ValueError):
                    continue
            if source_marker in str(detail.get("description_html", "")):
                return self._work_item_from_payload(detail)
        return None

    async def upload_originals(
        self,
        work_item: PlaneWorkItem,
        attachments: Iterable[SourceAttachment],
        source_key: str,
    ) -> UploadReport:
        uploaded = 0
        warnings: list[str] = []
        for attachment in attachments:
            if not attachment.local_path:
                if attachment.warning:
                    warnings.append(f"{attachment.name}: {attachment.warning}")
                continue
            try:
                await self._upload_one(work_item, attachment, source_key)
                uploaded += 1
            except ExternalServiceError as exc:
                warnings.append(f"{attachment.name}: {exc}")
        return UploadReport(uploaded=uploaded, warnings=tuple(warnings))

    async def append_warnings(
        self, work_item: PlaneWorkItem, warnings: Iterable[str]
    ) -> None:
        values = tuple(dict.fromkeys(value for value in warnings if value))
        if not values:
            return
        path = f"{self.work_items_path}{work_item.id}/"
        try:
            response = await self.client.get(path)
            response.raise_for_status()
            body = response.json()
            current = str(body.get("description_html") or "")
            warning_html = (
                "<h2>Avisos de processamento</h2><ul>"
                + "".join(f"<li>{html.escape(value)}</li>" for value in values)
                + "</ul>"
            )
            response = await self.client.patch(
                path, json={"description_html": current + warning_html}
            )
            response.raise_for_status()
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            raise ExternalServiceError("Plane warning writeback failed") from exc

    async def _upload_one(
        self,
        work_item: PlaneWorkItem,
        attachment: SourceAttachment,
        source_key: str,
    ) -> None:
        base = f"{self.work_items_path}{work_item.id}/attachments/"
        external_id = hashlib.sha256(
            f"{source_key}:{attachment.file_id}".encode()
        ).hexdigest()
        payload = {
            "name": attachment.name,
            "type": attachment.mime_type,
            "size": attachment.size,
            "external_source": "slack-plane-intake",
            "external_id": external_id,
        }
        completed = False
        try:
            response = await self.client.post(base, json=payload)
            response.raise_for_status()
            credentials = response.json()
            upload_data = credentials["upload_data"]
            upload_url = upload_data["url"]
            fields = upload_data["fields"]
            asset_id = credentials["asset_id"]
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            raise ExternalServiceError(
                "Plane attachment credential request failed"
            ) from exc

        try:
            raw = Path(attachment.local_path).read_bytes()
            response = await self.storage_client.post(
                upload_url,
                data={key: str(value) for key, value in fields.items()},
                files={
                    "file": (
                        attachment.name,
                        raw,
                        attachment.mime_type,
                    )
                },
            )
            response.raise_for_status()
            response = await self.client.patch(
                f"{base}{asset_id}/", json={"is_uploaded": True}
            )
            response.raise_for_status()
            completed = True
            response = await self.client.get(base)
            response.raise_for_status()
            listing = response.json()
            assets = (
                listing if isinstance(listing, list) else listing.get("results", [])
            )
            verified = any(
                str(item.get("id") or item.get("asset_id")) == str(asset_id)
                and bool(
                    item.get("is_uploaded")
                    or item.get("attachment", {}).get("is_uploaded")
                )
                for item in assets
                if isinstance(item, dict)
            )
            if not verified:
                raise ExternalServiceError("Plane attachment verification failed")
        except (OSError, httpx.HTTPError, ValueError, ExternalServiceError) as exc:
            if not completed:
                try:
                    await self.client.delete(f"{base}{asset_id}/")
                except httpx.HTTPError:
                    pass
            if isinstance(exc, ExternalServiceError):
                raise
            raise ExternalServiceError("Plane attachment upload failed") from exc

    def _work_item_from_payload(self, body: dict) -> PlaneWorkItem:
        item_id = str(body["id"])
        sequence = body.get("sequence_id") or body.get("sequence")
        identifier = str(
            body.get("project_identifier") or self.config.project_identifier
        )
        key = str(body.get("key") or f"{identifier}-{sequence}")
        if not sequence and "key" not in body:
            raise KeyError("sequence_id")
        url = f"{self.config.base_url}/{self.config.workspace}/browse/{key}"
        return PlaneWorkItem(id=item_id, key=key, url=url)

    @staticmethod
    def render_description(
        message: SourceMessage,
        analysis: ProblemAnalysis,
        source_marker: str,
    ) -> str:
        def section(title: str, values: Iterable[str]) -> str:
            items = "".join(f"<li>{html.escape(value)}</li>" for value in values)
            return f"<h2>{html.escape(title)}</h2><ul>{items}</ul>"

        attachment_rows = "".join(
            "<li>"
            + html.escape(attachment.name)
            + " — "
            + html.escape(attachment.mime_type)
            + f" — {attachment.size} bytes"
            + (
                f" — SHA-256 {html.escape(attachment.sha256)}"
                if attachment.sha256
                else ""
            )
            + (f" — {html.escape(attachment.warning)}" if attachment.warning else "")
            + " — Origem: "
            + html.escape(part.author_name)
            + " em "
            + html.escape(part.posted_at.isoformat())
            + "</li>"
            for part in message.messages
            for attachment in part.attachments
        )
        if not re.fullmatch(r"spi-source:[0-9a-f]{64}", source_marker):
            raise ValueError("invalid source marker")
        safe_marker = html.escape(source_marker)
        model = analysis.model_used or "unavailable"
        original_messages = [
            part.text.strip() for part in message.messages if part.text.strip()
        ]
        original_text = "\n".join(original_messages)
        if not original_text:
            original_text = "Mensagens selecionadas sem conteúdo textual."

        message_links = []
        authors: dict[tuple[str, str], list[SourceMessagePart]] = {}
        for index, part in enumerate(message.messages, start=1):
            if part.permalink:
                message_links.append(
                    f'<a href="{html.escape(part.permalink, quote=True)}">{index}</a>'
                )
            else:
                message_links.append(str(index))
            authors.setdefault((part.author_id, part.author_name), []).append(part)

        provenance_rows = [
            "<li>Mensagens no Slack: " + ", ".join(message_links) + "</li>"
        ]
        for (author_id, author_name), parts in authors.items():
            first = parts[0].posted_at.isoformat()
            last = parts[-1].posted_at.isoformat()
            period = first if first == last else f"{first} a {last}"
            provenance_rows.append(
                "<li>"
                f"Autor: {html.escape(author_name)} ({html.escape(author_id)}) — "
                f"{len(parts)} mensagem(ns) — Período UTC: {html.escape(period)}"
                "</li>"
            )
        return "".join(
            [
                "<h2>Resumo</h2><p>",
                html.escape(analysis.summary),
                "</p>",
                section("Fatos confirmados", analysis.confirmed_facts),
                section("Inferências", analysis.inferences),
                section("Informações ausentes", analysis.missing_information),
                "<h2>Mensagem</h2><pre><code>",
                html.escape(original_text),
                "</code></pre>",
                "<h2>Proveniência</h2><ul>",
                f"<li>Workspace Slack: {html.escape(message.team_id)}</li>",
                f"<li>Canal: {html.escape(message.channel_id)}</li>",
                *provenance_rows,
                f"<li>Modelo: {html.escape(model)}</li>",
                f"<li>Tipo de análise: {html.escape(analysis.analysis_kind)}</li>",
                f"<li>ID de origem: <code>{safe_marker}</code></li>",
                "</ul>",
                "<h2>Anexos originais</h2><ul>",
                attachment_rows,
                "</ul>",
                section("Avisos", analysis.warnings),
            ]
        )
