"""Abstract base class for package publishers.

Publishers handle uploading packages to registries:
- npm registry
- PyPI
- crates.io
- GitHub releases
- Docker registries
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, ClassVar

if TYPE_CHECKING:
    from release.config.models import ReleaseConfig


class PublishStatus(Enum):
    """Status of a publish operation."""

    SUCCESS = "success"
    FAILED = "failed"
    SKIPPED = "skipped"
    PENDING = "pending"


@dataclass
class PublishResult:
    """Result of a publish operation.

    Attributes:
        status: Overall status
        message: Brief description
        registry_url: URL where package was published
        package_url: Direct URL to the published package
        version: Version that was published
        details: Extended information
    """

    status: PublishStatus
    message: str
    registry_url: str | None = None
    package_url: str | None = None
    version: str | None = None
    details: str | None = None

    @classmethod
    def success(
        cls,
        message: str,
        registry_url: str | None = None,
        package_url: str | None = None,
        version: str | None = None,
    ) -> "PublishResult":
        """Create a successful publish result.

        Args:
            message: Success message
            registry_url: Registry URL
            package_url: Package URL
            version: Published version

        Returns:
            PublishResult with SUCCESS status
        """
        return cls(
            status=PublishStatus.SUCCESS,
            message=message,
            registry_url=registry_url,
            package_url=package_url,
            version=version,
        )

    @classmethod
    def failed(
        cls,
        message: str,
        details: str | None = None,
    ) -> "PublishResult":
        """Create a failed publish result.

        Args:
            message: Error message
            details: Extended error information

        Returns:
            PublishResult with FAILED status
        """
        return cls(
            status=PublishStatus.FAILED,
            message=message,
            details=details,
        )

    @classmethod
    def skipped(cls, message: str) -> "PublishResult":
        """Create a skipped publish result.

        Args:
            message: Reason for skipping

        Returns:
            PublishResult with SKIPPED status
        """
        return cls(status=PublishStatus.SKIPPED, message=message)


@dataclass
class PublishContext:
    """Context passed to publishers during publishing.

    Contains all information publishers need to perform their operations.
    """

    project_root: Path
    config: "ReleaseConfig"
    version: str
    tag_name: str
    release_notes: str
    dry_run: bool = False
    verbose: bool = False


class Publisher(ABC):
    """Abstract base class for all publishers.

    Publishers handle the final step of releasing: uploading
    packages to their respective registries.
    """

    # Class-level attributes to be defined by subclasses
    name: ClassVar[str]
    display_name: ClassVar[str]
    registry_name: ClassVar[str]

    @abstractmethod
    def publish(self, context: PublishContext) -> PublishResult:
        """Publish the package to the registry.

        Args:
            context: Publish context with version and config

        Returns:
            PublishResult indicating success/failure
        """
        pass

    @abstractmethod
    def verify(self, context: PublishContext) -> bool:
        """Verify the package was published successfully.

        Args:
            context: Publish context

        Returns:
            True if package is visible on registry
        """
        pass

    def should_publish(self, context: PublishContext) -> bool:
        """Check if this publisher should run based on config.

        Override in subclasses to conditionally skip publishing.

        Args:
            context: Publish context

        Returns:
            True if publisher should run
        """
        return True

    def can_rollback(self) -> bool:
        """Check if this publisher supports rollback.

        Returns:
            True if rollback is supported
        """
        return False

    def rollback(self, context: PublishContext) -> PublishResult:
        """Rollback a published package.

        Only called if can_rollback() returns True.

        Args:
            context: Publish context

        Returns:
            PublishResult indicating rollback success/failure
        """
        return PublishResult.skipped("Rollback not supported")


class PublisherRegistry:
    """Registry for publisher implementations.

    Provides publisher discovery and execution across
    all registered publisher types.
    """

    _publishers: dict[str, type[Publisher]] = {}

    @classmethod
    def register(cls, publisher_class: type[Publisher]) -> type[Publisher]:
        """Register a publisher class.

        Can be used as a decorator:
            @PublisherRegistry.register
            class NPMPublisher(Publisher):
                ...

        Args:
            publisher_class: Publisher class to register

        Returns:
            The registered class (for decorator usage)

        Raises:
            TypeError: If publisher_class is missing required attributes
            ValueError: If a publisher with the same name is already registered
        """
        # Validate required class attributes exist
        required_attrs = ["name", "display_name", "registry_name"]
        missing = [attr for attr in required_attrs if not hasattr(publisher_class, attr)]
        if missing:
            raise TypeError(
                f"Publisher class {publisher_class.__name__} missing required "
                f"class attributes: {', '.join(missing)}. "
                "All publishers must define 'name', 'display_name', and 'registry_name'."
            )

        # Validate name is a non-empty string
        name = publisher_class.name
        if not isinstance(name, str) or not name:
            raise TypeError(
                f"Publisher {publisher_class.__name__}.name must be a non-empty string, "
                f"got {type(name).__name__}: {name!r}"
            )

        # Check for duplicate names (allow re-registration of same class)
        if name in cls._publishers:
            existing = cls._publishers[name]
            if existing is not publisher_class:
                raise ValueError(
                    f"Publisher name '{name}' already registered by {existing.__name__}. "
                    f"Cannot register {publisher_class.__name__}."
                )
            # Same class registered twice - idempotent, just return
            return publisher_class

        cls._publishers[name] = publisher_class
        return publisher_class

    @classmethod
    def get(cls, name: str) -> type[Publisher] | None:
        """Get a publisher class by name.

        Args:
            name: Publisher name

        Returns:
            Publisher class or None if not found
        """
        return cls._publishers.get(name)

    @classmethod
    def publish_all(
        cls,
        context: PublishContext,
        publishers: list[str] | None = None,
    ) -> list[PublishResult]:
        """Run all or specified publishers.

        Args:
            context: Publish context
            publishers: Optional list of publisher names to run

        Returns:
            List of publish results
        """
        results = []
        for name, publisher_class in cls._publishers.items():
            if publishers and name not in publishers:
                continue
            publisher = publisher_class()
            if publisher.should_publish(context):
                results.append(publisher.publish(context))
        return results

    @classmethod
    def list_registered(cls) -> list[str]:
        """List all registered publisher names.

        Returns:
            List of publisher names
        """
        return list(cls._publishers.keys())
