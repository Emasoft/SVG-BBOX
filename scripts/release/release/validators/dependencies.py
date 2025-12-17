"""Dependency validators for release checks.

Validates dependency management state before release:
- Lock file freshness and existence
- Node.js version requirements
- Package manager configuration consistency
"""

import os
import re
import subprocess
from typing import ClassVar

from release.validators.base import (
    ReleaseContext,
    ValidationResult,
    Validator,
    ValidatorRegistry,
)


def parse_node_version(version_string: str) -> tuple[int, int, int] | None:
    """Parse Node.js version string into components.

    Args:
        version_string: Version string (e.g., "v24.0.0" or "24.0.0")

    Returns:
        Tuple of (major, minor, patch) or None if invalid
    """
    # Remove leading 'v' if present
    version_string = version_string.lstrip("v")
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)", version_string)
    if not match:
        return None
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


@ValidatorRegistry.register
class LockFileValidator(Validator):
    """Validates that lock files are up to date.

    Ensures package lock files exist and are newer than package.json
    to prevent releasing with outdated dependencies.
    """

    name: ClassVar[str] = "lock_file"
    description: ClassVar[str] = "Check that lock files are up to date"
    category: ClassVar[str] = "dependencies"

    def validate(self, context: ReleaseContext) -> ValidationResult:
        """Validate that lock files are up to date.

        Args:
            context: Release context with project root

        Returns:
            ValidationResult indicating lock file status
        """
        project_root = context.project_root
        package_json = project_root / "package.json"

        # Skip if no package.json exists
        if not package_json.exists():
            return ValidationResult.success(
                "No package.json found, skipping lock file validation"
            )

        package_json_mtime = os.path.getmtime(package_json)

        # Check for pnpm-lock.yaml
        pnpm_lock = project_root / "pnpm-lock.yaml"
        if pnpm_lock.exists():
            lock_mtime = os.path.getmtime(pnpm_lock)
            if lock_mtime < package_json_mtime:
                return ValidationResult.warning(
                    message="pnpm-lock.yaml is older than package.json",
                    details="Lock file was modified before package.json, which suggests "
                    "dependencies may have been updated without regenerating the lock file.",
                    fix_command="pnpm install",
                )
            return ValidationResult.success("pnpm-lock.yaml is up to date")

        # Check for package-lock.json
        npm_lock = project_root / "package-lock.json"
        if npm_lock.exists():
            lock_mtime = os.path.getmtime(npm_lock)
            if lock_mtime < package_json_mtime:
                return ValidationResult.warning(
                    message="package-lock.json is older than package.json",
                    details="Lock file was modified before package.json, which suggests "
                    "dependencies may have been updated without regenerating the lock file.",
                    fix_command="npm install",
                )
            return ValidationResult.success("package-lock.json is up to date")

        # Check for yarn.lock
        yarn_lock = project_root / "yarn.lock"
        if yarn_lock.exists():
            return ValidationResult.success(
                "yarn.lock exists (timestamp checking not implemented for Yarn)"
            )

        # No lock file found
        return ValidationResult.error(
            message="No lock file found",
            details="No package lock file (pnpm-lock.yaml, package-lock.json, or yarn.lock) "
            "was found in the project. A lock file is required to ensure dependency consistency.",
            fix_command="Run your package manager's install command (pnpm install, npm install, or yarn install)",
        )


@ValidatorRegistry.register
class NodeVersionValidator(Validator):
    """Validates that Node.js version meets requirements.

    Checks the installed Node.js version against configured requirements
    and warns about versions that may not support modern features.
    """

    name: ClassVar[str] = "node_version"
    description: ClassVar[str] = "Check Node.js version meets requirements"
    category: ClassVar[str] = "dependencies"

    def validate(self, context: ReleaseContext) -> ValidationResult:
        """Validate Node.js version meets requirements.

        Args:
            context: Release context with config

        Returns:
            ValidationResult indicating Node.js version status
        """
        try:
            # Run node --version
            result = subprocess.run(
                ["node", "--version"],
                capture_output=True,
                text=True,
                check=True,
            )
            version_string = result.stdout.strip()

            # Parse version
            version_parts = parse_node_version(version_string)
            if version_parts is None:
                return ValidationResult.error(
                    message=f"Failed to parse Node.js version: {version_string}",
                    details="Could not parse version string from 'node --version'",
                    fix_command="node --version",
                )

            major, minor, patch = version_parts

            # Check against configured requirements if specified
            if hasattr(context.config, "tools") and hasattr(
                context.config.tools, "node_version"
            ):
                required = context.config.tools.node_version
                required_parts = parse_node_version(required)
                if required_parts is not None:
                    req_major, req_minor, req_patch = required_parts
                    if (major, minor, patch) < (req_major, req_minor, req_patch):
                        return ValidationResult.error(
                            message=f"Node.js version {version_string} does not meet requirement {required}",
                            details=f"Current version: {version_string}\n"
                            f"Required version: {required}",
                            fix_command=f"Install Node.js {required} or higher",
                        )

            # Warn if Node.js < 24 (for npm OIDC support)
            if major < 24:
                return ValidationResult.warning(
                    message=f"Node.js {version_string} may not support npm trusted publishing",
                    details=f"Current version: {version_string}\n"
                    "Node.js 24+ is recommended for npm OIDC trusted publishing support (requires npm 11.5.1+).\n"
                    "Older versions ship with npm 10.x which does not support OIDC authentication.",
                    fix_command="Consider upgrading to Node.js 24 or later",
                )

            return ValidationResult.success(
                f"Node.js version {version_string} meets requirements"
            )

        except FileNotFoundError:
            return ValidationResult.error(
                message="Node.js is not installed",
                details="The 'node' command was not found. Node.js must be installed to release this package.",
                fix_command="Install Node.js from https://nodejs.org/",
            )
        except subprocess.CalledProcessError as e:
            return ValidationResult.error(
                message="Failed to check Node.js version",
                details=f"Command 'node --version' failed with exit code {e.returncode}:\n{e.stderr}",
                fix_command="node --version",
            )


@ValidatorRegistry.register
class PackageManagerValidator(Validator):
    """Validates the package manager configuration.

    Detects the package manager from lock files and verifies it matches
    the packageManager field in package.json if specified.
    """

    name: ClassVar[str] = "package_manager"
    description: ClassVar[str] = "Validate package manager configuration"
    category: ClassVar[str] = "dependencies"

    def validate(self, context: ReleaseContext) -> ValidationResult:
        """Validate package manager configuration.

        Args:
            context: Release context with project root

        Returns:
            ValidationResult indicating package manager status
        """
        project_root = context.project_root
        package_json_path = project_root / "package.json"

        # Skip if no package.json exists
        if not package_json_path.exists():
            return ValidationResult.success(
                "No package.json found, skipping package manager validation"
            )

        # Detect package manager from lock files
        detected_manager = None
        if (project_root / "pnpm-lock.yaml").exists():
            detected_manager = "pnpm"
        elif (project_root / "package-lock.json").exists():
            detected_manager = "npm"
        elif (project_root / "yarn.lock").exists():
            detected_manager = "yarn"

        if detected_manager is None:
            return ValidationResult.warning(
                message="Could not detect package manager",
                details="No lock file found to determine package manager. "
                "Expected one of: pnpm-lock.yaml, package-lock.json, yarn.lock",
                fix_command="Run your package manager's install command to generate a lock file",
            )

        # Check package.json packageManager field
        try:
            import json

            with open(package_json_path) as f:
                package_data = json.load(f)

            package_manager_field = package_data.get("packageManager")

            if package_manager_field:
                # Extract manager name from field (e.g., "pnpm@8.15.0" -> "pnpm")
                declared_manager = package_manager_field.split("@")[0]

                if declared_manager != detected_manager:
                    return ValidationResult.warning(
                        message=f"Package manager mismatch: declared '{declared_manager}' but detected '{detected_manager}'",
                        details=f"The packageManager field in package.json declares '{package_manager_field}', "
                        f"but the lock file suggests '{detected_manager}' is being used.\n\n"
                        "This may cause issues with automated workflows or other developers.",
                        fix_command="Update packageManager field to match detected manager, or switch to declared manager",
                    )

                return ValidationResult.success(
                    f"Package manager '{declared_manager}' matches detected manager"
                )

            # No packageManager field - just report detected manager
            return ValidationResult.success(
                f"Detected package manager: {detected_manager} (no packageManager field in package.json)"
            )

        except (json.JSONDecodeError, OSError) as e:
            return ValidationResult.error(
                message=f"Failed to read package.json: {e}",
                file_path=package_json_path,
            )
