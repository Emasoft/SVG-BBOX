"""Abstract base class for ecosystem detection and operations.

Ecosystems encapsulate package manager operations for different
programming languages and platforms:
- Version reading/writing
- Package manager detection
- Build script execution
- Dependency management
"""

import contextlib
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import ClassVar


@dataclass
class EcosystemInfo:
    """Information about a detected ecosystem."""

    name: str
    package_manager: str
    version: str | None = None
    config_file: Path | None = None
    lock_file: Path | None = None


class Ecosystem(ABC):
    """Abstract base class for ecosystem implementations.

    Each ecosystem (nodejs, python, rust, etc.) implements this interface
    to provide consistent operations across different platforms.
    """

    # Class-level attributes to be defined by subclasses
    name: ClassVar[str]
    display_name: ClassVar[str]
    config_files: ClassVar[list[str]]  # Files that indicate this ecosystem
    lock_files: ClassVar[list[str]]  # Lock files for this ecosystem

    def __init__(self, project_root: Path) -> None:
        """Initialize ecosystem with project root.

        Args:
            project_root: Path to the project root directory
        """
        self.project_root = project_root

    @abstractmethod
    def detect(self) -> bool:
        """Detect if project uses this ecosystem.

        Returns:
            True if ecosystem is detected
        """
        pass

    @abstractmethod
    def get_version(self) -> str:
        """Get current version from config file.

        Returns:
            Version string (e.g., "1.0.0")

        Raises:
            EcosystemError: If version cannot be read
        """
        pass

    @abstractmethod
    def set_version(self, version: str) -> None:
        """Set version in config file.

        Args:
            version: New version string

        Raises:
            EcosystemError: If version cannot be set
        """
        pass

    @abstractmethod
    def get_package_manager(self) -> str:
        """Detect which package manager is used.

        Returns:
            Package manager name (e.g., "npm", "pnpm", "pip", "uv")
        """
        pass

    @abstractmethod
    def run_script(self, script_name: str) -> None:
        """Run an ecosystem-specific script.

        Args:
            script_name: Name of the script to run (e.g., "build", "test")

        Raises:
            EcosystemError: If script fails
        """
        pass

    def get_info(self) -> EcosystemInfo:
        """Get information about this ecosystem in the project.

        Returns:
            EcosystemInfo with detected configuration
        """
        config_file = None
        for cfg in self.config_files:
            path = self.project_root / cfg
            if path.exists():
                config_file = path
                break

        lock_file = None
        for lf in self.lock_files:
            path = self.project_root / lf
            if path.exists():
                lock_file = path
                break

        version = None
        with contextlib.suppress(Exception):
            version = self.get_version()

        return EcosystemInfo(
            name=self.name,
            package_manager=self.get_package_manager(),
            version=version,
            config_file=config_file,
            lock_file=lock_file,
        )

    def has_script(self, script_name: str) -> bool:
        """Check if a script exists.

        Args:
            script_name: Name of the script to check

        Returns:
            True if script exists
        """
        # Default implementation - subclasses should override
        return False

    def get_available_scripts(self) -> list[str]:
        """Get list of available scripts.

        Returns:
            List of script names
        """
        # Default implementation - subclasses should override
        return []


class EcosystemRegistry:
    """Registry for ecosystem implementations.

    Provides ecosystem detection and instantiation across
    all registered ecosystem types.
    """

    _ecosystems: dict[str, type[Ecosystem]] = {}

    @classmethod
    def register(cls, ecosystem_class: type[Ecosystem]) -> type[Ecosystem]:
        """Register an ecosystem class.

        Can be used as a decorator:
            @EcosystemRegistry.register
            class NodeJSEcosystem(Ecosystem):
                ...

        Args:
            ecosystem_class: Ecosystem class to register

        Returns:
            The registered class (for decorator usage)

        Raises:
            TypeError: If ecosystem_class is missing required attributes
            ValueError: If an ecosystem with the same name is already registered
        """
        # Validate required class attributes exist
        required_attrs = ["name", "display_name", "config_files", "lock_files"]
        missing = [attr for attr in required_attrs if not hasattr(ecosystem_class, attr)]
        if missing:
            raise TypeError(
                f"Ecosystem class {ecosystem_class.__name__} missing required "
                f"class attributes: {', '.join(missing)}. "
                "All ecosystems must define 'name', 'display_name', 'config_files', and 'lock_files'."
            )

        # Validate name is a non-empty string
        name = ecosystem_class.name
        if not isinstance(name, str) or not name:
            raise TypeError(
                f"Ecosystem {ecosystem_class.__name__}.name must be a non-empty string, "
                f"got {type(name).__name__}: {name!r}"
            )

        # Check for duplicate names (allow re-registration of same class)
        if name in cls._ecosystems:
            existing = cls._ecosystems[name]
            if existing is not ecosystem_class:
                raise ValueError(
                    f"Ecosystem name '{name}' already registered by {existing.__name__}. "
                    f"Cannot register {ecosystem_class.__name__}."
                )
            # Same class registered twice - idempotent, just return
            return ecosystem_class

        cls._ecosystems[name] = ecosystem_class
        return ecosystem_class

    @classmethod
    def get(cls, name: str) -> type[Ecosystem] | None:
        """Get an ecosystem class by name.

        Args:
            name: Ecosystem name

        Returns:
            Ecosystem class or None if not found
        """
        return cls._ecosystems.get(name)

    @classmethod
    def detect_all(cls, project_root: Path) -> list[Ecosystem]:
        """Detect all ecosystems present in a project.

        Args:
            project_root: Project root directory

        Returns:
            List of detected ecosystem instances
        """
        detected = []
        for ecosystem_class in cls._ecosystems.values():
            eco = ecosystem_class(project_root)
            if eco.detect():
                detected.append(eco)
        return detected

    @classmethod
    def detect_primary(cls, project_root: Path) -> Ecosystem | None:
        """Detect the primary ecosystem.

        Returns the first detected ecosystem based on registration order.

        Args:
            project_root: Project root directory

        Returns:
            Primary ecosystem instance or None
        """
        detected = cls.detect_all(project_root)
        return detected[0] if detected else None

    @classmethod
    def list_registered(cls) -> list[str]:
        """List all registered ecosystem names.

        Returns:
            List of ecosystem names
        """
        return list(cls._ecosystems.keys())
