"""Abstract base class for validators.

Validators perform pre-release checks and report issues with
severity levels that determine whether a release can proceed.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar

if TYPE_CHECKING:
    from release.config.models import ReleaseConfig


class ValidationSeverity(Enum):
    """Severity level for validation results.

    - ERROR: Blocks release (must be fixed)
    - WARNING: Shown but doesn't block (should be reviewed)
    - INFO: Informational only
    """

    ERROR = "error"
    WARNING = "warning"
    INFO = "info"


@dataclass
class ValidationResult:
    """Result of a validation check.

    Attributes:
        passed: Whether the validation passed
        message: Brief description of the result
        severity: How serious the issue is
        details: Extended explanation
        fix_command: Suggested command to fix the issue
        file_path: File where issue was found (if applicable)
        line_number: Line number in file (if applicable)
    """

    passed: bool
    message: str
    severity: ValidationSeverity = ValidationSeverity.ERROR
    details: str | None = None
    fix_command: str | None = None
    file_path: Path | None = None
    line_number: int | None = None

    @classmethod
    def success(cls, message: str = "Validation passed") -> "ValidationResult":
        """Create a successful validation result.

        Args:
            message: Success message

        Returns:
            ValidationResult with passed=True
        """
        return cls(passed=True, message=message, severity=ValidationSeverity.INFO)

    @classmethod
    def error(
        cls,
        message: str,
        details: str | None = None,
        fix_command: str | None = None,
        file_path: Path | None = None,
        line_number: int | None = None,
    ) -> "ValidationResult":
        """Create an error validation result.

        Args:
            message: Error message
            details: Extended explanation
            fix_command: Suggested fix
            file_path: File with issue
            line_number: Line number

        Returns:
            ValidationResult with passed=False, severity=ERROR
        """
        return cls(
            passed=False,
            message=message,
            severity=ValidationSeverity.ERROR,
            details=details,
            fix_command=fix_command,
            file_path=file_path,
            line_number=line_number,
        )

    @classmethod
    def warning(
        cls,
        message: str,
        details: str | None = None,
        fix_command: str | None = None,
    ) -> "ValidationResult":
        """Create a warning validation result.

        Args:
            message: Warning message
            details: Extended explanation
            fix_command: Suggested fix

        Returns:
            ValidationResult with passed=True, severity=WARNING
        """
        return cls(
            passed=True,
            message=message,
            severity=ValidationSeverity.WARNING,
            details=details,
            fix_command=fix_command,
        )


@dataclass
class ReleaseContext:
    """Context passed to validators during validation.

    Contains all information validators need to perform their checks.
    """

    project_root: Path
    config: "ReleaseConfig"
    version: str | None = None
    previous_version: str | None = None
    dry_run: bool = False
    verbose: bool = False
    extra: dict[str, Any] = field(default_factory=dict)


class Validator(ABC):
    """Abstract base class for all validators.

    Validators check specific aspects of the project before release:
    - Git state (clean, on main branch)
    - Version format (valid semver)
    - Security (no secrets in publishable files)
    - Dependencies (no vulnerabilities)
    - Quality (lint, typecheck, test results)
    - CI (workflow configuration)
    """

    # Class-level attributes to be defined by subclasses
    name: ClassVar[str]
    description: ClassVar[str]
    category: ClassVar[str]  # e.g., "git", "security", "quality"

    @abstractmethod
    def validate(self, context: ReleaseContext) -> ValidationResult:
        """Run validation and return result.

        Args:
            context: Release context with config and project info

        Returns:
            ValidationResult indicating pass/fail and details
        """
        pass

    def should_run(self, context: ReleaseContext) -> bool:
        """Check if this validator should run based on config.

        Override in subclasses to conditionally skip validation.

        Args:
            context: Release context

        Returns:
            True if validator should run
        """
        return True


class ValidatorRegistry:
    """Registry for validator implementations.

    Provides validator discovery and execution across
    all registered validator types.
    """

    _validators: dict[str, type[Validator]] = {}
    _categories: dict[str, list[type[Validator]]] = {}

    @classmethod
    def register(
        cls,
        validator_class: type[Validator],
    ) -> type[Validator]:
        """Register a validator class.

        Can be used as a decorator:
            @ValidatorRegistry.register
            class GitCleanValidator(Validator):
                ...

        Args:
            validator_class: Validator class to register

        Returns:
            The registered class (for decorator usage)

        Raises:
            TypeError: If validator_class is missing required attributes
            ValueError: If a validator with the same name is already registered
        """
        # Validate required class attributes exist
        required_attrs = ["name", "description", "category"]
        missing = [attr for attr in required_attrs if not hasattr(validator_class, attr)]
        if missing:
            raise TypeError(
                f"Validator class {validator_class.__name__} missing required "
                f"class attributes: {', '.join(missing)}. "
                "All validators must define 'name', 'description', and 'category'."
            )

        # Validate name is a non-empty string
        name = validator_class.name
        if not isinstance(name, str) or not name:
            raise TypeError(
                f"Validator {validator_class.__name__}.name must be a non-empty string, "
                f"got {type(name).__name__}: {name!r}"
            )

        # Check for duplicate names (allow re-registration of same class)
        if name in cls._validators:
            existing = cls._validators[name]
            if existing is not validator_class:
                raise ValueError(
                    f"Validator name '{name}' already registered by {existing.__name__}. "
                    f"Cannot register {validator_class.__name__}."
                )
            # Same class registered twice - idempotent, just return
            return validator_class

        cls._validators[name] = validator_class

        # Group by category
        category = validator_class.category
        if category not in cls._categories:
            cls._categories[category] = []
        cls._categories[category].append(validator_class)

        return validator_class

    @classmethod
    def get(cls, name: str) -> type[Validator] | None:
        """Get a validator class by name.

        Args:
            name: Validator name

        Returns:
            Validator class or None if not found
        """
        return cls._validators.get(name)

    @classmethod
    def get_by_category(cls, category: str) -> list[type[Validator]]:
        """Get all validators in a category.

        Args:
            category: Category name (e.g., "git", "security")

        Returns:
            List of validator classes
        """
        return cls._categories.get(category, [])

    @classmethod
    def run_all(cls, context: ReleaseContext) -> list[ValidationResult]:
        """Run all registered validators.

        Args:
            context: Release context

        Returns:
            List of validation results
        """
        results = []
        for validator_class in cls._validators.values():
            validator = validator_class()
            if validator.should_run(context):
                results.append(validator.validate(context))
        return results

    @classmethod
    def run_category(
        cls,
        category: str,
        context: ReleaseContext,
    ) -> list[ValidationResult]:
        """Run all validators in a category.

        Args:
            category: Category name
            context: Release context

        Returns:
            List of validation results
        """
        results = []
        for validator_class in cls.get_by_category(category):
            validator = validator_class()
            if validator.should_run(context):
                results.append(validator.validate(context))
        return results

    @classmethod
    def list_registered(cls) -> list[str]:
        """List all registered validator names.

        Returns:
            List of validator names
        """
        return list(cls._validators.keys())

    @classmethod
    def list_categories(cls) -> list[str]:
        """List all validator categories.

        Returns:
            List of category names
        """
        return list(cls._categories.keys())
