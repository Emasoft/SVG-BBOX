"""Version validation for releases.

Validates version format, version bumps, and consistency across package files.
"""

import json
import re

from release.validators.base import (
    ReleaseContext,
    ValidationResult,
    Validator,
    ValidatorRegistry,
)


def parse_semver(version: str) -> tuple[int, int, int] | None:
    """Parse a semantic version string into components.

    Args:
        version: Version string (e.g., "1.2.3")

    Returns:
        Tuple of (major, minor, patch) or None if invalid
    """
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)$", version)
    if not match:
        return None
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


def compare_versions(v1: str, v2: str) -> int:
    """Compare two semantic versions.

    Args:
        v1: First version string
        v2: Second version string

    Returns:
        -1 if v1 < v2, 0 if v1 == v2, 1 if v1 > v2
    """
    parts1 = parse_semver(v1)
    parts2 = parse_semver(v2)

    if parts1 is None or parts2 is None:
        # If parsing fails, fall back to string comparison
        if v1 < v2:
            return -1
        elif v1 > v2:
            return 1
        else:
            return 0

    # Compare major, minor, patch
    if parts1 < parts2:
        return -1
    elif parts1 > parts2:
        return 1
    else:
        return 0


def is_significant_jump(previous: str, current: str) -> bool:
    """Check if version jump is significant (e.g., skipping major versions).

    Args:
        previous: Previous version string
        current: Current version string

    Returns:
        True if the jump is significant (e.g., 1.0.0 -> 3.0.0)
    """
    prev_parts = parse_semver(previous)
    curr_parts = parse_semver(current)

    if prev_parts is None or curr_parts is None:
        return False

    prev_major, prev_minor, _prev_patch = prev_parts
    curr_major, curr_minor, _curr_patch = curr_parts

    # Check for major version jumps > 1
    if curr_major - prev_major > 1:
        return True

    # Check for minor version jumps > 1 when major is the same
    return curr_major == prev_major and curr_minor - prev_minor > 1


@ValidatorRegistry.register
class VersionFormatValidator(Validator):
    """Validates that version matches the configured pattern.

    Checks the version string against the regex pattern defined in
    config.version.pattern. By default, this validates semantic
    versioning (major.minor.patch).
    """

    name = "version_format"
    description = "Validate version format matches configured pattern"
    category = "version"

    def validate(self, context: ReleaseContext) -> ValidationResult:
        """Validate version format against semver pattern.

        Args:
            context: Release context with version and config

        Returns:
            ValidationResult indicating if version format is valid
        """
        if context.version is None:
            return ValidationResult.error(
                message="No version provided",
                details="Version must be specified for validation",
            )

        # Use standard semver pattern
        pattern = r"^\d+\.\d+\.\d+$"
        version = context.version

        if not re.match(pattern, version):
            return ValidationResult.error(
                message=f"Invalid version format: {version}",
                details=f"Version must match semver pattern: {pattern}\n"
                f"Expected format: semantic version (e.g., 1.0.12)\n"
                f"Got: {version}",
                fix_command=f"Use a valid version format matching {pattern}",
            )

        return ValidationResult.success(f"Version format is valid: {version}")


@ValidatorRegistry.register
class VersionBumpValidator(Validator):
    """Validates that new version is greater than previous version.

    Ensures version numbers only increase, never decrease or stay the same.
    Also warns about significant version jumps (e.g., skipping major versions).
    """

    name = "version_bump"
    description = "Validate version is greater than previous version"
    category = "version"

    def validate(self, context: ReleaseContext) -> ValidationResult:
        """Validate version bump is valid.

        Args:
            context: Release context with version and previous_version

        Returns:
            ValidationResult indicating if version bump is valid
        """
        if context.version is None:
            return ValidationResult.error(
                message="No version provided",
                details="Version must be specified for bump validation",
            )

        if context.previous_version is None:
            # First release, no previous version to compare
            return ValidationResult.success(f"First release: {context.version}")

        version = context.version
        previous = context.previous_version

        comparison = compare_versions(version, previous)

        if comparison < 0:
            return ValidationResult.error(
                message=f"Version would decrease: {previous} → {version}",
                details=f"New version ({version}) is less than previous version ({previous})\n"
                "Versions must always increase",
                fix_command=f"Use a version greater than {previous}",
            )

        if comparison == 0:
            return ValidationResult.error(
                message=f"Version unchanged: {version}",
                details=f"Version is the same as previous version ({previous})\n"
                "Version must be bumped for a new release",
                fix_command="Bump version using patch, minor, or major",
            )

        # Version increased - check if jump is significant
        if is_significant_jump(previous, version):
            return ValidationResult.warning(
                message=f"Significant version jump: {previous} → {version}",
                details="Version skips one or more major/minor versions.\n"
                "This is allowed but unusual - verify this is intentional.",
            )

        return ValidationResult.success(
            f"Version bump is valid: {previous} → {version}"
        )


@ValidatorRegistry.register
class VersionConsistencyValidator(Validator):
    """Validates version consistency across package configuration files.

    For Node.js projects, checks that package.json and pnpm-lock.yaml
    (or package-lock.json) have matching versions.
    """

    name = "version_consistency"
    description = "Validate version is consistent across package files"
    category = "version"

    def validate(self, context: ReleaseContext) -> ValidationResult:
        """Validate version consistency across files.

        Args:
            context: Release context with version and project root

        Returns:
            ValidationResult indicating if versions are consistent
        """
        if context.version is None:
            return ValidationResult.error(
                message="No version provided",
                details="Version must be specified for consistency validation",
            )

        project_root = context.project_root
        version = context.version
        inconsistencies = []

        # Check Node.js package files
        package_json = project_root / "package.json"
        if package_json.exists():
            try:
                with open(package_json) as f:
                    data = json.load(f)
                    pkg_version = data.get("version")

                if pkg_version != version:
                    inconsistencies.append(
                        f"package.json: {pkg_version} (expected {version})"
                    )
            except (json.JSONDecodeError, OSError) as e:
                return ValidationResult.error(
                    message=f"Failed to read package.json: {e}",
                    file_path=package_json,
                )

        # Check pnpm-lock.yaml
        pnpm_lock = project_root / "pnpm-lock.yaml"
        if pnpm_lock.exists():
            try:
                with open(pnpm_lock) as f:
                    content = f.read()
                    # Look for version in pnpm-lock.yaml
                    # Format: "version: 1.0.29" in the root package section
                    match = re.search(
                        r"^\s*version:\s*['\"]?([0-9.]+)['\"]?\s*$",
                        content,
                        re.MULTILINE,
                    )
                    if match:
                        lock_version = match.group(1)
                        if lock_version != version:
                            inconsistencies.append(
                                f"pnpm-lock.yaml: {lock_version} (expected {version})"
                            )
            except OSError as e:
                return ValidationResult.error(
                    message=f"Failed to read pnpm-lock.yaml: {e}",
                    file_path=pnpm_lock,
                )

        # Check package-lock.json (npm)
        package_lock = project_root / "package-lock.json"
        if package_lock.exists():
            try:
                with open(package_lock) as f:
                    data = json.load(f)
                    lock_version = data.get("version")

                if lock_version != version:
                    inconsistencies.append(
                        f"package-lock.json: {lock_version} (expected {version})"
                    )
            except (json.JSONDecodeError, OSError) as e:
                return ValidationResult.error(
                    message=f"Failed to read package-lock.json: {e}",
                    file_path=package_lock,
                )

        if inconsistencies:
            return ValidationResult.warning(
                message="Version inconsistencies detected",
                details="The following files have different versions:\n"
                + "\n".join(f"  - {inc}" for inc in inconsistencies)
                + f"\n\nExpected version: {version}\n\n"
                "This may indicate that lock files need to be regenerated.",
                fix_command="Run `pnpm install` or `npm install` to update lock files",
            )

        return ValidationResult.success(
            "Version is consistent across all package files"
        )
