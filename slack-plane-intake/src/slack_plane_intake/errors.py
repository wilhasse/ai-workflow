"""Domain errors with safe, credential-free messages."""


class IntakeError(Exception):
    """Base error that is safe to summarize to Hermes."""


class ConfigurationError(IntakeError):
    """Required runtime configuration is missing or invalid."""


class SourceValidationError(IntakeError):
    """The Slack source is not authorized for intake."""


class ExternalServiceError(IntakeError):
    """An external API request failed."""

    def __init__(self, message: str, *, ambiguous: bool = False) -> None:
        super().__init__(message)
        self.ambiguous = ambiguous


class AnalysisError(IntakeError):
    """Every configured analysis model failed."""


class IntakeInProgress(IntakeError):
    """Another call is already processing the same source message."""
