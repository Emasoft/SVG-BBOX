"""Version parsing, validation, and manipulation utilities.

This module provides comprehensive version string handling for semantic versioning,
including parsing, validation, comparison, and bumping operations.

All version strings are expected to follow semantic versioning format: MAJOR.MINOR.PATCH
Git tags may optionally include a prefix (e.g., 'v1.2.3').
"""

import re
from typing import Literal

from release.exceptions import ValidationError

# Type aliases for clarity
BumpType = Literal["major", "minor", "patch"]
VersionTuple = tuple[int, int, int]

# Semantic version pattern: MAJOR.MINOR.PATCH (with optional leading 'v')
SEMVER_PATTERN = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")

# Strict semver pattern without prefix (for validation)
STRICT_SEMVER_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")


def parse_version(version_str: str) -> VersionTuple:
    """Parse a semantic version string into a tuple of integers.

    Args:
        version_str: Version string to parse (e.g., '1.2.3', 'v1.2.3')

    Returns:
        Tuple of (major, minor, patch) as integers

    Raises:
        ValidationError: If version string is invalid or doesn't match semver format

    Examples:
        >>> parse_version('1.2.3')
        (1, 2, 3)
        >>> parse_version('v1.2.3')
        (1, 2, 3)
        >>> parse_version('invalid')
        ValidationError: Invalid version format: 'invalid'
    """
    if not version_str or not version_str.strip():
        raise ValidationError(
            "Empty version string",
            details="Version string cannot be empty or whitespace",
            fix_hint="Provide a valid semantic version (e.g., '1.2.3')",
        )

    match = SEMVER_PATTERN.match(version_str.strip())
    if not match:
        raise ValidationError(
            f"Invalid version format: '{version_str}'",
            details="Version must follow semantic versioning: MAJOR.MINOR.PATCH",
            fix_hint="Use format like '1.2.3' or 'v1.2.3'",
        )

    try:
        major, minor, patch = (
            int(match.group(1)),
            int(match.group(2)),
            int(match.group(3)),
        )
    except (ValueError, IndexError) as e:
        raise ValidationError(
            f"Failed to parse version components from '{version_str}'",
            details=str(e),
            fix_hint="Ensure all version parts are valid integers",
        ) from e

    return (major, minor, patch)


def is_valid_version(version_str: str, pattern: re.Pattern[str] | None = None) -> bool:
    """Check if a version string is valid.

    Args:
        version_str: Version string to validate
        pattern: Optional regex pattern to use for validation.
                If None, uses default SEMVER_PATTERN (allows 'v' prefix)

    Returns:
        True if version is valid, False otherwise

    Examples:
        >>> is_valid_version('1.2.3')
        True
        >>> is_valid_version('v1.2.3')
        True
        >>> is_valid_version('1.2')
        False
        >>> is_valid_version('1.2.3', pattern=STRICT_SEMVER_PATTERN)
        True
        >>> is_valid_version('v1.2.3', pattern=STRICT_SEMVER_PATTERN)
        False
    """
    if not version_str or not version_str.strip():
        return False

    validation_pattern = pattern if pattern is not None else SEMVER_PATTERN
    return validation_pattern.match(version_str.strip()) is not None


def compare_versions(v1: str, v2: str) -> int:
    """Compare two semantic version strings.

    Args:
        v1: First version string
        v2: Second version string

    Returns:
        -1 if v1 < v2
         0 if v1 == v2
         1 if v1 > v2

    Raises:
        ValidationError: If either version string is invalid

    Examples:
        >>> compare_versions('1.2.3', '1.2.4')
        -1
        >>> compare_versions('2.0.0', '1.9.9')
        1
        >>> compare_versions('1.2.3', '1.2.3')
        0
        >>> compare_versions('v1.2.3', '1.2.3')
        0
    """
    version1 = parse_version(v1)
    version2 = parse_version(v2)

    if version1 < version2:
        return -1
    elif version1 > version2:
        return 1
    else:
        return 0


def bump_version(current: str, bump_type: BumpType | str) -> str:
    """Bump a version string according to semantic versioning rules.

    Args:
        current: Current version string (e.g., '1.2.3', 'v1.2.3')
        bump_type: Type of bump ('major', 'minor', 'patch') or explicit version string

    Returns:
        New version string without prefix (e.g., '1.2.4')

    Raises:
        ValidationError: If current version or bump_type is invalid

    Examples:
        >>> bump_version('1.2.3', 'patch')
        '1.2.4'
        >>> bump_version('1.2.3', 'minor')
        '1.3.0'
        >>> bump_version('1.2.3', 'major')
        '2.0.0'
        >>> bump_version('v1.2.3', 'patch')
        '1.2.4'
        >>> bump_version('1.2.3', '2.0.0')
        '2.0.0'
    """
    # If bump_type is an explicit version, validate and return it
    if bump_type not in ("major", "minor", "patch"):
        if is_valid_version(bump_type):
            # Return normalized version (without prefix)
            return normalize_version(bump_type)
        else:
            raise ValidationError(
                f"Invalid bump type or version: '{bump_type}'",
                details="Bump type must be 'major', 'minor', 'patch', or a valid version string",
                fix_hint="Use 'major', 'minor', 'patch', or a version like '2.0.0'",
            )

    # Parse current version
    major, minor, patch = parse_version(current)

    # Apply bump
    if bump_type == "major":
        return f"{major + 1}.0.0"
    elif bump_type == "minor":
        return f"{major}.{minor + 1}.0"
    elif bump_type == "patch":
        return f"{major}.{minor}.{patch + 1}"
    else:
        # This should never happen due to earlier validation
        raise ValidationError(
            f"Unknown bump type: '{bump_type}'",
            details="This is a programming error",
            fix_hint="Report this as a bug",
        )


def normalize_version(version_str: str) -> str:
    """Normalize a version string by removing prefix and whitespace.

    Args:
        version_str: Version string to normalize (e.g., 'v1.2.3', ' 1.2.3 ')

    Returns:
        Normalized version string without prefix (e.g., '1.2.3')

    Raises:
        ValidationError: If version string is invalid

    Examples:
        >>> normalize_version('v1.2.3')
        '1.2.3'
        >>> normalize_version(' 1.2.3 ')
        '1.2.3'
        >>> normalize_version('1.2.3')
        '1.2.3'
    """
    # Parse and reconstruct to ensure validity
    major, minor, patch = parse_version(version_str)
    return f"{major}.{minor}.{patch}"


def add_tag_prefix(version: str, prefix: str = "v") -> str:
    """Add a tag prefix to a version string.

    Args:
        version: Version string (e.g., '1.2.3')
        prefix: Prefix to add (default: 'v')

    Returns:
        Version string with prefix (e.g., 'v1.2.3')

    Raises:
        ValidationError: If version string is invalid

    Examples:
        >>> add_tag_prefix('1.2.3')
        'v1.2.3'
        >>> add_tag_prefix('1.2.3', 'version-')
        'version-1.2.3'
        >>> add_tag_prefix('v1.2.3')
        'v1.2.3'
    """
    # Normalize first to ensure validity and remove any existing prefix
    normalized = normalize_version(version)
    return f"{prefix}{normalized}"


def remove_tag_prefix(tag: str, prefix: str = "v") -> str:
    """Remove a tag prefix from a version string.

    Args:
        tag: Tag string (e.g., 'v1.2.3', 'version-1.2.3')
        prefix: Prefix to remove (default: 'v')

    Returns:
        Version string without prefix (e.g., '1.2.3')

    Raises:
        ValidationError: If resulting version string is invalid

    Examples:
        >>> remove_tag_prefix('v1.2.3')
        '1.2.3'
        >>> remove_tag_prefix('version-1.2.3', 'version-')
        '1.2.3'
        >>> remove_tag_prefix('1.2.3')
        '1.2.3'
    """
    stripped = tag.strip()
    if stripped.startswith(prefix):
        stripped = stripped[len(prefix) :]

    # Validate and normalize
    return normalize_version(stripped)


def format_version_info(version: str) -> dict[str, str]:
    """Format version information into a structured dictionary.

    Args:
        version: Version string to format

    Returns:
        Dictionary with version components and formatted strings

    Raises:
        ValidationError: If version string is invalid

    Examples:
        >>> info = format_version_info('1.2.3')
        >>> info['major']
        '1'
        >>> info['minor']
        '2'
        >>> info['patch']
        '3'
        >>> info['version']
        '1.2.3'
        >>> info['tag']
        'v1.2.3'
    """
    major, minor, patch = parse_version(version)
    normalized = f"{major}.{minor}.{patch}"

    return {
        "major": str(major),
        "minor": str(minor),
        "patch": str(patch),
        "version": normalized,
        "tag": f"v{normalized}",
        "version_tuple": f"({major}, {minor}, {patch})",
    }


# Export all public functions
__all__ = [
    "parse_version",
    "is_valid_version",
    "compare_versions",
    "bump_version",
    "normalize_version",
    "add_tag_prefix",
    "remove_tag_prefix",
    "format_version_info",
    "BumpType",
    "VersionTuple",
    "SEMVER_PATTERN",
    "STRICT_SEMVER_PATTERN",
]
