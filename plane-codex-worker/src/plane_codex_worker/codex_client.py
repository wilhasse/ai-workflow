"""HTTP client for the existing host-side Codex control service."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

import httpx

from .config import WorkerConfig
from .models import CodexResult, CodexRun


class CodexControlError(RuntimeError):
    """Raised when the control service cannot complete a bounded operation."""


@dataclass(frozen=True)
class CodexHealth:
    ready: bool
    pid: int | None


class CodexControlClient:
    def __init__(
        self, config: WorkerConfig, *, client: httpx.AsyncClient | None = None
    ) -> None:
        self.config = config
        self._owns_client = client is None
        if client is None:
            transport = httpx.AsyncHTTPTransport(uds=str(config.codex_socket))
            client = httpx.AsyncClient(
                transport=transport,
                base_url="http://codex-control",
                timeout=30,
            )
        self.client = client

    async def close(self) -> None:
        if self._owns_client:
            await self.client.aclose()

    async def _request(self, method: str, path: str, **kwargs) -> dict:
        try:
            response = await self.client.request(method, path, **kwargs)
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            suffix = f" (HTTP {status})" if status else ""
            raise CodexControlError(
                f"Codex control {method} {path} failed{suffix}"
            ) from exc
        if not isinstance(payload, dict):
            raise CodexControlError("Codex control returned an invalid response")
        return payload

    async def health(self) -> CodexHealth:
        payload = await self._request("GET", "/health")
        app_server = payload.get("appServer") or {}
        return CodexHealth(
            ready=bool(payload.get("ok") and app_server.get("ready")),
            pid=int(app_server["pid"]) if app_server.get("pid") else None,
        )

    async def create_investigation(self, prompt: str) -> CodexRun:
        payload = await self._request(
            "POST",
            "/threads",
            json={
                "preset": self.config.codex_preset,
                "cwd": str(self.config.codex_cwd),
                "sandbox": "readOnly",
                "approvalPolicy": "never",
                "ephemeral": False,
                "prompt": prompt,
            },
        )
        try:
            return CodexRun(
                thread_id=str(payload["thread"]["id"]),
                turn_id=str(payload["turn"]["id"]),
            )
        except (KeyError, TypeError) as exc:
            raise CodexControlError(
                "Codex control did not return a thread and turn"
            ) from exc

    async def wait_for_result(self, run: CodexRun) -> CodexResult:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.config.turn_timeout_seconds
        while True:
            payload = await self._request("GET", f"/threads/{run.thread_id}")
            thread = payload.get("thread") or {}
            turn = thread.get("lastTurn") or {}
            status = self._status_name(turn.get("status"))
            if status and status != "inProgress":
                output = str(thread.get("lastAgentMessage") or "")
                return CodexResult(
                    thread_id=run.thread_id,
                    turn_id=run.turn_id,
                    status=status,
                    output=output,
                )
            if loop.time() >= deadline:
                raise CodexControlError(
                    f"Codex turn timed out after {self.config.turn_timeout_seconds:g}s"
                )
            await asyncio.sleep(self.config.turn_poll_seconds)

    @staticmethod
    def _status_name(status: object) -> str:
        if isinstance(status, str):
            return status
        if isinstance(status, dict):
            if isinstance(status.get("type"), str):
                return str(status["type"])
            if status:
                return str(next(iter(status)))
        return ""
