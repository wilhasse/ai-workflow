"""Idempotent provisioning helpers that never print credentials."""

from __future__ import annotations

import argparse
import json
import os
import sys

import httpx

from .errors import ConfigurationError, ExternalServiceError


def _items(payload: object) -> list[dict]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        values = payload.get("results") or payload.get("data") or []
        if isinstance(values, list):
            return [item for item in values if isinstance(item, dict)]
    return []


def ensure_plane_project(
    *,
    base_url: str,
    api_key: str,
    workspace: str,
    name: str = "Problem Intake",
    identifier: str = "PROB",
    client: httpx.Client | None = None,
) -> dict[str, str]:
    owns_client = client is None
    http = client or httpx.Client(
        base_url=base_url.rstrip("/"),
        headers={"X-API-Key": api_key},
        timeout=60,
    )
    projects_path = f"/api/v1/workspaces/{workspace}/projects/"
    try:
        response = http.get(projects_path, params={"per_page": "100"})
        response.raise_for_status()
        projects = _items(response.json())
        project = next(
            (
                item
                for item in projects
                if str(item.get("identifier", "")).upper() == identifier.upper()
            ),
            None,
        )
        created = False
        if project is None:
            response = http.post(
                projects_path,
                json={"name": name, "identifier": identifier, "description": ""},
            )
            response.raise_for_status()
            project = response.json()
            created = True

        project_id = str(project.get("id", ""))
        if not project_id:
            raise ExternalServiceError("Plane project response did not contain an ID")
        states_path = f"{projects_path}{project_id}/states/"
        response = http.get(states_path, params={"per_page": "100"})
        response.raise_for_status()
        states = _items(response.json())
        backlog = next(
            (
                item
                for item in states
                if str(item.get("name", "")).strip().lower() == "backlog"
                or str(item.get("group", "")).strip().lower() == "backlog"
            ),
            None,
        )
        if not backlog or not backlog.get("id"):
            raise ExternalServiceError("Plane project has no Backlog state")
        return {
            "project_id": project_id,
            "project_identifier": str(project.get("identifier") or identifier),
            "state_id": str(backlog["id"]),
            "created": str(created).lower(),
        }
    except (httpx.HTTPError, ValueError) as exc:
        raise ExternalServiceError("Plane project provisioning failed") from exc
    finally:
        if owns_client:
            http.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["plane-project"])
    args = parser.parse_args(argv)
    if args.command != "plane-project":
        return 2

    missing = [
        name for name in ("SPI_PLANE_API_KEY",) if not os.environ.get(name, "").strip()
    ]
    if missing:
        print("configuration error: missing " + ", ".join(missing), file=sys.stderr)
        return 2
    try:
        result = ensure_plane_project(
            base_url=os.environ.get(
                "SPI_PLANE_BASE_URL", "https://plane.supersaber.dev.br"
            ),
            api_key=os.environ["SPI_PLANE_API_KEY"],
            workspace=os.environ.get("SPI_PLANE_WORKSPACE", "supersaber"),
        )
    except (ConfigurationError, ExternalServiceError) as exc:
        print(f"provisioning error: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
