"""Custom exception hierarchy for the release tool.

Exit codes follow Unix conventions:
- 1: General error
- 2: Configuration error
- 3: Validation error
- 4: Git error
- 5: Publish error
- 6: CI error
- 7: Network error
- 8: Rollback error
"""


class ReleaseError(Exception):
    """Base exception for all release errors.

    All release-related exceptions inherit from this class.
    Each subclass defines an exit_code for CLI error reporting.
    """

    exit_code: int = 1

    def __init__(
        self,
        message: str,
        details: str | None = None,
        fix_hint: str | None = None,
    ) -> None:
        """Initialize the exception.

        Args:
            message: Brief error message
            details: Detailed explanation of what went wrong
            fix_hint: Suggested command or action to fix the issue
        """
        super().__init__(message)
        self.message = message
        self.details = details
        self.fix_hint = fix_hint

    def __str__(self) -> str:
        parts = [self.message]
        if self.details:
            parts.append(f"\nDetails: {self.details}")
        if self.fix_hint:
            parts.append(f"\nFix: {self.fix_hint}")
        return "".join(parts)


class ConfigurationError(ReleaseError):
    """Configuration file errors.

    Raised when:
    - Config file not found
    - Config file has invalid syntax (YAML/TOML)
    - Config values fail validation
    - Required config fields are missing
    """

    exit_code = 2


class ValidationError(ReleaseError):
    """Pre-release validation failures.

    Raised when:
    - Git working directory is dirty
    - Not on main branch
    - Version format is invalid
    - Secrets detected in publishable files
    - Dependencies have security issues
    - Quality checks fail (lint, typecheck, test)
    """

    exit_code = 3


class GitError(ReleaseError):
    """Git operation failures.

    Raised when:
    - Git commands fail
    - Branch operations fail
    - Tag creation fails
    - Push operations fail
    - Merge conflicts detected
    """

    exit_code = 4


class PublishError(ReleaseError):
    """Publishing failures.

    Raised when:
    - npm publish fails
    - PyPI upload fails
    - crates.io publish fails
    - GitHub release creation fails
    - Authentication fails with registries
    """

    exit_code = 5


class CIError(ReleaseError):
    """CI workflow failures.

    Raised when:
    - CI workflow times out
    - Required checks fail
    - Workflow not found
    - Unable to monitor workflow status
    """

    exit_code = 6


class NetworkError(ReleaseError):
    """Network/API failures.

    Raised when:
    - HTTP requests fail
    - API rate limits hit
    - DNS resolution fails
    - Connection timeouts
    """

    exit_code = 7


class RollbackError(ReleaseError):
    """Rollback operation failures.

    Raised when:
    - Tag deletion fails
    - Version revert fails
    - Unable to restore previous state
    - Partial rollback completed
    """

    exit_code = 8


class EcosystemError(ReleaseError):
    """Ecosystem-specific operation failures.

    Raised when:
    - Package manager not found
    - Build script fails
    - Version bump fails in config file
    - Ecosystem-specific validation fails
    """

    exit_code = 9


class ReleaseTimeoutError(ReleaseError):
    """Operation timeout errors.

    Named ReleaseTimeoutError to avoid shadowing Python's built-in TimeoutError.

    Raised when:
    - CI workflow exceeds timeout
    - npm verification times out
    - Network request times out
    """

    exit_code = 10
