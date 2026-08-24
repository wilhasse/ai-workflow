"""One deep operation that turns an authorized Slack message into a Plane item."""

from __future__ import annotations

import hashlib
from contextlib import suppress

from .analyzer import Analyzer
from .errors import AnalysisError, ExternalServiceError, IntakeError, IntakeInProgress
from .ledger import IntakeLedger
from .models import IntakeResult, PlaneWorkItem, SourceMessage
from .plane_client import PlaneClient
from .slack_client import SlackClient


class ProblemIntakeService:
    def __init__(
        self,
        slack: SlackClient,
        analyzer: Analyzer,
        plane: PlaneClient,
        ledger: IntakeLedger,
    ) -> None:
        self.slack = slack
        self.analyzer = analyzer
        self.plane = plane
        self.ledger = ledger

    async def close(self) -> None:
        await self.slack.close()
        await self.analyzer.close()
        await self.plane.close()

    async def create_from_slack(self, message_ts: str) -> IntakeResult:
        message: SourceMessage | None = None
        source_key = ""
        try:
            message = await self.slack.fetch_source_message(message_ts)
            source_key = message.source_key
            claim = self.ledger.claim(source_key)
            if not claim.claimed and claim.existing:
                return claim.existing

            marker = self.source_marker(source_key)
            reconciled = await self.plane.find_by_source_marker(marker)
            if reconciled:
                result = self._existing_result(reconciled)
                self.ledger.complete(source_key, result)
                return result

            try:
                analysis = await self.analyzer.analyze(message)
            except (AnalysisError, ExternalServiceError) as exc:
                analysis = self.analyzer.deterministic_fallback(message, str(exc))

            try:
                work_item = await self.plane.create_problem(message, analysis, marker)
            except ExternalServiceError as exc:
                if exc.ambiguous:
                    reconciled = await self.plane.find_by_source_marker(marker)
                    if reconciled:
                        result = self._existing_result(reconciled)
                        self.ledger.complete(source_key, result)
                        return result
                self.ledger.fail(source_key, str(exc))
                return IntakeResult(status="failed", warnings=(str(exc),))

            uploads = await self.plane.upload_originals(
                work_item, message.attachments, source_key
            )
            writeback_warnings: tuple[str, ...] = ()
            if uploads.warnings:
                try:
                    await self.plane.append_warnings(work_item, uploads.warnings)
                except ExternalServiceError as exc:
                    writeback_warnings = (str(exc),)
            warnings = tuple(
                dict.fromkeys(
                    (
                        *analysis.warnings,
                        *(
                            f"{attachment.name}: {attachment.warning}"
                            for attachment in message.attachments
                            if attachment.warning
                        ),
                        *uploads.warnings,
                        *writeback_warnings,
                    )
                )
            )
            status = "partial" if warnings else "created"
            result = IntakeResult(
                status=status,
                issue_key=work_item.key,
                issue_url=work_item.url,
                model_used=analysis.model_used,
                attachments_uploaded=uploads.uploaded,
                warnings=warnings,
            )
            self.ledger.complete(source_key, result)
            return result
        except IntakeInProgress as exc:
            return IntakeResult(status="failed", warnings=(str(exc),))
        except IntakeError as exc:
            if source_key:
                self.ledger.fail(source_key, str(exc))
            return IntakeResult(status="failed", warnings=(str(exc),))
        finally:
            if message:
                self._clean_downloads(message)

    @staticmethod
    def source_marker(source_key: str) -> str:
        digest = hashlib.sha256(source_key.encode("utf-8")).hexdigest()
        return f"spi-source:{digest}"

    @staticmethod
    def _existing_result(work_item: PlaneWorkItem) -> IntakeResult:
        return IntakeResult(
            status="existing",
            issue_key=work_item.key,
            issue_url=work_item.url,
        )

    @staticmethod
    def _clean_downloads(message: SourceMessage) -> None:
        parents = set()
        for attachment in message.attachments:
            if not attachment.local_path:
                continue
            parents.add(attachment.local_path.parent)
            with suppress(OSError):
                attachment.local_path.unlink()
        for parent in sorted(parents, key=lambda path: len(path.parts), reverse=True):
            with suppress(OSError):
                parent.rmdir()
