"""Bounded Plane operations owned by the automation layer."""

from __future__ import annotations

from collections.abc import Iterable

import httpx

from .config import WorkerConfig
from .models import PlaneIssue, PlaneState, StateSet


class PlaneError(RuntimeError):
    """Raised for a safe, credential-free Plane failure."""


class PlaneClient:
    STATE_DEFINITIONS = (
        {"name": "Review", "color": "#8B5CF6", "group": "started", "sequence": 40000},
        {"name": "Blocked", "color": "#EF4444", "group": "started", "sequence": 37500},
    )

    def __init__(
        self, config: WorkerConfig, *, client: httpx.AsyncClient | None = None
    ) -> None:
        self.config = config
        self._owns_client = client is None
        self.client = client or httpx.AsyncClient(
            base_url=config.plane_base_url,
            headers={"X-API-Key": config.plane_api_key},
            timeout=30,
        )

    @property
    def project_path(self) -> str:
        return (
            f"/api/v1/workspaces/{self.config.plane_workspace}/projects/"
            f"{self.config.plane_project_id}"
        )

    @property
    def issues_path(self) -> str:
        return f"{self.project_path}/issues/"

    async def close(self) -> None:
        if self._owns_client:
            await self.client.aclose()

    async def _request(self, method: str, path: str, **kwargs) -> object:
        try:
            response = await self.client.request(method, path, **kwargs)
            response.raise_for_status()
            return response.json()
        except (httpx.HTTPError, ValueError) as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            suffix = f" (HTTP {status})" if status else ""
            raise PlaneError(f"Plane {method} {path} failed{suffix}") from exc

    @staticmethod
    def _results(payload: object) -> list[dict]:
        if isinstance(payload, list):
            return [item for item in payload if isinstance(item, dict)]
        if isinstance(payload, dict):
            values = payload.get("results") or payload.get("data") or []
            return [item for item in values if isinstance(item, dict)]
        return []

    async def list_states(self) -> tuple[PlaneState, ...]:
        payload = await self._request("GET", f"{self.project_path}/states/")
        return tuple(
            PlaneState(
                id=str(item["id"]),
                name=str(item.get("name") or ""),
                group=str(item.get("group") or ""),
            )
            for item in self._results(payload)
            if item.get("id") and item.get("name")
        )

    async def ensure_automation_states(self) -> StateSet:
        states = list(await self.list_states())
        by_name = {state.name.casefold(): state for state in states}
        for definition in self.STATE_DEFINITIONS:
            if definition["name"].casefold() in by_name:
                continue
            payload = await self._request(
                "POST", f"{self.project_path}/states/", json=definition
            )
            if not isinstance(payload, dict) or not payload.get("id"):
                raise PlaneError("Plane returned an invalid state response")
            state = PlaneState(
                id=str(payload["id"]),
                name=str(payload.get("name") or definition["name"]),
                group=str(payload.get("group") or definition["group"]),
            )
            states.append(state)
            by_name[state.name.casefold()] = state
        return self._state_set(states)

    async def resolve_states(self) -> StateSet:
        return self._state_set(await self.list_states())

    @staticmethod
    def _state_set(states: Iterable[PlaneState]) -> StateSet:
        by_name = {state.name.casefold(): state for state in states}
        required = {
            "backlog": "Backlog",
            "running": "In Progress",
            "review": "Review",
            "blocked": "Blocked",
        }
        missing = [name for name in required.values() if name.casefold() not in by_name]
        if missing:
            raise PlaneError("Plane project is missing states: " + ", ".join(missing))
        return StateSet(
            **{field: by_name[name.casefold()] for field, name in required.items()}
        )

    async def list_issues_in_state(
        self, state_id: str, *, limit: int
    ) -> tuple[PlaneIssue, ...]:
        payload = await self._request(
            "GET",
            self.issues_path,
            params={"per_page": str(min(limit, 100)), "order_by": "created_at"},
        )
        issues: list[PlaneIssue] = []
        for item in self._results(payload):
            item_state = item.get("state")
            if isinstance(item_state, dict):
                item_state = item_state.get("id")
            item_state = item_state or (item.get("state_detail") or {}).get("id")
            if str(item_state or "") != state_id or not item.get("id"):
                continue
            issues.append(await self.get_issue(str(item["id"])))
            if len(issues) >= limit:
                break
        return tuple(issues)

    async def get_issue(self, issue_id: str) -> PlaneIssue:
        payload = await self._request("GET", f"{self.issues_path}{issue_id}/")
        if not isinstance(payload, dict):
            raise PlaneError("Plane returned an invalid issue response")
        state = payload.get("state")
        if isinstance(state, dict):
            state = state.get("id")
        state = state or (payload.get("state_detail") or {}).get("id")
        try:
            return PlaneIssue(
                id=str(payload["id"]),
                sequence_id=int(payload["sequence_id"]),
                name=str(payload.get("name") or "Untitled issue"),
                description_html=str(payload.get("description_html") or ""),
                state_id=str(state or ""),
                updated_at=str(payload.get("updated_at") or ""),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise PlaneError("Plane returned incomplete issue fields") from exc

    async def set_issue_state(self, issue_id: str, state_id: str) -> None:
        await self._request(
            "PATCH", f"{self.issues_path}{issue_id}/", json={"state": state_id}
        )

    async def comments_contain(self, issue_id: str, marker: str) -> bool:
        payload = await self._request("GET", f"{self.issues_path}{issue_id}/comments/")
        return any(
            marker
            in str(item.get("comment_html") or item.get("comment_stripped") or "")
            for item in self._results(payload)
        )

    async def add_comment(self, issue_id: str, comment_html: str) -> None:
        await self._request(
            "POST",
            f"{self.issues_path}{issue_id}/comments/",
            json={"comment_html": comment_html},
        )
