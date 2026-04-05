from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from .config import AppConfig
from .doris import DorisClient


@dataclass(frozen=True)
class DraftPaths:
    memory_path: Path
    user_path: Path


def _render_memory_draft(
    *,
    source: str,
    source_stats: list[dict],
    top_projects: list[dict],
) -> str:
    source_row = next((row for row in source_stats if row["source"] == source), None)
    lines = [
        "# MEMORY.md draft",
        "",
        "Review this file before copying anything into Hermes memory.",
        "Keep only durable facts that should influence future work.",
        "",
    ]
    if source_row:
        lines.extend(
            [
                "## Imported history scope",
                f"- source: {source}",
                f"- date range: {source_row['min_ts']} .. {source_row['max_ts']}",
                f"- message rows available: {source_row['rows_in_messages']}",
                "",
            ]
        )
    lines.extend(
        [
            "## Candidate stable environment facts",
            "- Historical transcript corpus is available and should be consulted with session search before asking the user to restate prior project context.",
            "- Prior work spans multiple coding projects and operational environments, so project path is a useful retrieval key.",
            "",
            "## Frequent projects from history",
        ]
    )
    for row in top_projects[:12]:
        lines.append(f"- {row['project']} ({row['session_count']} sessions)")
    lines.extend(
        [
            "",
            "## Human review notes",
            "- Replace generic bullets above with precise durable facts after validation.",
            "- Do not keep raw transcript summaries or completed task logs here.",
            "",
        ]
    )
    return "\n".join(lines)


def _render_user_draft(*, source: str, top_projects: list[dict]) -> str:
    project_paths = [row["project"] for row in top_projects if row.get("project")]
    common_roots = Counter()
    for project_path in project_paths:
        parts = [p for p in project_path.split("/") if p]
        if len(parts) >= 2:
            common_roots["/" + "/".join(parts[:2])] += 1
        if len(parts) >= 3:
            common_roots["/" + "/".join(parts[:3])] += 1

    lines = [
        "# USER.md draft",
        "",
        "Review this file before copying anything into Hermes user memory.",
        "Only keep recurring user preferences and workflow expectations.",
        "",
        "## Candidate workflow facts",
        "- The user values recall of past project work and may expect the agent to search prior sessions before asking repeated context questions.",
        "- The user works across multiple project roots; filesystem path is a meaningful retrieval signal.",
        "",
        "## Candidate workspace hints",
    ]
    for root, count in common_roots.most_common(8):
        lines.append(f"- {root} ({count} references)")
    lines.extend(
        [
            "",
            "## Human review notes",
            f"- Add only confirmed preferences discovered from historical {source} work.",
            "- Remove any statement that is only a temporary task pattern.",
            "",
        ]
    )
    return "\n".join(lines)


def generate_memory_drafts(
    config: AppConfig,
    doris: DorisClient,
    *,
    source: str,
) -> DraftPaths:
    config.hermes.generated_dir.mkdir(parents=True, exist_ok=True)
    source_stats = doris.fetch_source_stats()
    top_projects = doris.fetch_top_projects(source, limit=20)

    memory_path = config.hermes.generated_dir / "MEMORY.draft.md"
    user_path = config.hermes.generated_dir / "USER.draft.md"
    memory_path.write_text(
        _render_memory_draft(
            source=source,
            source_stats=source_stats,
            top_projects=top_projects,
        )
        + "\n",
        encoding="utf-8",
    )
    user_path.write_text(
        _render_user_draft(
            source=source,
            top_projects=top_projects,
        )
        + "\n",
        encoding="utf-8",
    )
    return DraftPaths(memory_path=memory_path, user_path=user_path)
