"""Tests for version validators.

Tests the following validators:
- VersionFormatValidator: Validates semver format compliance
- VersionBumpValidator: Validates version increases correctly
- VersionConsistencyValidator: Validates version matches across package files

These tests use temporary directories and mock file contents.
"""

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from release.config.models import ReleaseConfig, VersionConfig
from release.validators.base import ReleaseContext, ValidationSeverity
from release.validators.version import (
    VersionBumpValidator,
    VersionConsistencyValidator,
    VersionFormatValidator,
    compare_versions,
    is_significant_jump,
    parse_semver,
)


@pytest.fixture
def mock_config() -> MagicMock:
    """Create a mock ReleaseConfig with typical settings.

    Returns:
        MagicMock configured as a ReleaseConfig
    """
    config = MagicMock(spec=ReleaseConfig)
    config.version = MagicMock(spec=VersionConfig)
    config.version.tag_prefix = "v"
    return config


@pytest.fixture
def release_context(tmp_path: Path, mock_config: MagicMock) -> ReleaseContext:
    """Create a ReleaseContext for testing.

    Args:
        tmp_path: Pytest temporary directory fixture
        mock_config: Mock configuration fixture

    Returns:
        ReleaseContext configured for testing
    """
    return ReleaseContext(
        project_root=tmp_path,
        config=mock_config,
        version="1.0.0",
        previous_version="0.9.0",
    )


class TestParseSemver:
    """Tests for the parse_semver helper function."""

    def test_valid_semver_returns_tuple(self) -> None:
        """Validate that valid semver strings are parsed to tuples."""
        assert parse_semver("1.0.0") == (1, 0, 0)
        assert parse_semver("10.20.30") == (10, 20, 30)
        assert parse_semver("0.0.1") == (0, 0, 1)

    def test_invalid_semver_returns_none(self) -> None:
        """Validate that invalid semver strings return None."""
        assert parse_semver("1.0") is None
        assert parse_semver("v1.0.0") is None
        assert parse_semver("1.0.0-beta") is None
        assert parse_semver("not-a-version") is None
        assert parse_semver("") is None


class TestCompareVersions:
    """Tests for the compare_versions helper function."""

    def test_version_comparison_ordering(self) -> None:
        """Validate version comparisons return correct ordering values."""
        assert compare_versions("1.0.0", "2.0.0") == -1  # Less than
        assert compare_versions("2.0.0", "1.0.0") == 1  # Greater than
        assert compare_versions("1.0.0", "1.0.0") == 0  # Equal

    def test_minor_and_patch_comparisons(self) -> None:
        """Validate minor and patch version comparisons work correctly."""
        assert compare_versions("1.0.0", "1.1.0") == -1
        assert compare_versions("1.0.0", "1.0.1") == -1
        assert compare_versions("1.9.9", "2.0.0") == -1


class TestIsSignificantJump:
    """Tests for the is_significant_jump helper function."""

    def test_normal_bumps_not_significant(self) -> None:
        """Validate that normal version bumps are not flagged as significant."""
        assert is_significant_jump("1.0.0", "1.0.1") is False
        assert is_significant_jump("1.0.0", "1.1.0") is False
        assert is_significant_jump("1.0.0", "2.0.0") is False

    def test_major_skip_is_significant(self) -> None:
        """Validate that skipping major versions is flagged as significant."""
        assert is_significant_jump("1.0.0", "3.0.0") is True
        assert is_significant_jump("1.0.0", "5.0.0") is True

    def test_minor_skip_is_significant(self) -> None:
        """Validate that skipping minor versions is flagged as significant."""
        assert is_significant_jump("1.0.0", "1.5.0") is True
        assert is_significant_jump("1.0.0", "1.3.0") is True


class TestVersionFormatValidator:
    """Tests for VersionFormatValidator - validates semver format."""

    def test_valid_semver_format_returns_success(
        self, release_context: ReleaseContext
    ) -> None:
        """Validate that valid semver strings return success."""
        validator = VersionFormatValidator()
        release_context.version = "1.0.0"

        result = validator.validate(release_context)

        assert result.passed is True
        assert result.severity == ValidationSeverity.INFO
        assert "1.0.0" in result.message

    def test_valid_large_version_numbers(self, release_context: ReleaseContext) -> None:
        """Validate that large version numbers are accepted."""
        validator = VersionFormatValidator()
        release_context.version = "100.200.300"

        result = validator.validate(release_context)

        assert result.passed is True

    def test_invalid_format_with_prefix_returns_error(
        self, release_context: ReleaseContext
    ) -> None:
        """Validate that version with 'v' prefix returns error."""
        validator = VersionFormatValidator()
        release_context.version = "v1.0.0"

        result = validator.validate(release_context)

        assert result.passed is False
        assert result.severity == ValidationSeverity.ERROR
        assert "invalid" in result.message.lower()

    def test_invalid_format_missing_patch_returns_error(
        self, release_context: ReleaseContext
    ) -> None:
        """Validate that version missing patch number returns error."""
        validator = VersionFormatValidator()
        release_context.version = "1.0"

        result = validator.validate(release_context)

        assert result.passed is False
        assert result.severity == ValidationSeverity.ERROR

    def test_invalid_format_with_prerelease_returns_error(
        self, release_context: ReleaseContext
    ) -> None:
        """Validate that version with prerelease suffix returns error."""
        validator = VersionFormatValidator()
        release_context.version = "1.0.0-beta.1"

        result = validator.validate(release_context)

        assert result.passed is False
        assert result.severity == ValidationSeverity.ERROR

    def test_no_version_returns_error(self, release_context: ReleaseContext) -> None:
        """Validate that missing version returns error."""
        validator = VersionFormatValidator()
        release_context.version = None

        result = validator.validate(release_context)

        assert result.passed is False
        assert "no version" in result.message.lower()


class TestVersionBumpValidator:
    """Tests for VersionBumpValidator - validates version increases."""

    def test_valid_patch_bump_returns_success(
        self, release_context: ReleaseContext
    ) -> None:
        """Validate that a valid patch bump returns success."""
        validator = VersionBumpValidator()
        release_context.previous_version = "1.0.0"
        release_context.version = "1.0.1"

        result = validator.validate(release_context)

        assert result.passed is True
        assert result.severity == ValidationSeverity.INFO
        assert "1.0.0" in result.message
        assert "1.0.1" in result.message

    def test_valid_minor_bump_returns_success(
        self, release_context: ReleaseContext
    ) -> None:
        """Validate that a valid minor bump returns success."""
        validator = VersionBumpValidator()
        release_context.previous_version = "1.0.0"
        release_context.version = "1.1.0"

        result = validator.validate(release_context)

        assert result.passed is True

    def test_valid_major_bump_returns_success(
        self, release_context: ReleaseContext
    ) -> None:
        """Validate that a valid major bump returns success."""
        validator = VersionBumpValidator()
        release_context.previous_version = "1.0.0"
        release_context.version = "2.0.0"

        result = validator.validate(release_context)

        assert result.passed is True

    def test_decreasing_version_returns_error(
        self, release_context: ReleaseContext
    ) -> None:
        """Validate that a decreasing version returns error."""
        validator = VersionBumpValidator()
        release_context.previous_version = "2.0.0"
        release_context.version = "1.0.0"

        result = validator.validate(release_context)

        assert result.passed is False
        assert result.severity == ValidationSeverity.ERROR
        assert "decrease" in result.message.lower()

    def test_same_version_returns_error(self, release_context: ReleaseContext) -> None:
        """Validate that the same version returns error."""
        validator = VersionBumpValidator()
        release_context.previous_version = "1.0.0"
        release_context.version = "1.0.0"

        result = validator.validate(release_context)

        assert result.passed is False
        assert result.severity == ValidationSeverity.ERROR
        assert "unchanged" in result.message.lower()

    def test_significant_jump_returns_warning(
        self, release_context: ReleaseContext
    ) -> None:
        """Validate that a significant version jump returns warning."""
        validator = VersionBumpValidator()
        release_context.previous_version = "1.0.0"
        release_context.version = "3.0.0"  # Skipping major version 2

        result = validator.validate(release_context)

        assert result.passed is True  # Allowed but warned
        assert result.severity == ValidationSeverity.WARNING
        assert "significant" in result.message.lower()

    def test_first_release_no_previous_version(
        self, release_context: ReleaseContext
    ) -> None:
        """Validate that first release (no previous version) returns success."""
        validator = VersionBumpValidator()
        release_context.previous_version = None
        release_context.version = "1.0.0"

        result = validator.validate(release_context)

        assert result.passed is True
        assert "first release" in result.message.lower()


class TestVersionConsistencyValidator:
    """Tests for VersionConsistencyValidator - validates version across files."""

    def test_consistent_package_json_returns_success(
        self, release_context: ReleaseContext, tmp_path: Path
    ) -> None:
        """Validate that matching package.json version returns success."""
        validator = VersionConsistencyValidator()
        release_context.project_root = tmp_path
        release_context.version = "1.0.0"

        # Create package.json with matching version
        package_json = {"name": "test", "version": "1.0.0"}
        (tmp_path / "package.json").write_text(json.dumps(package_json))

        result = validator.validate(release_context)

        assert result.passed is True
        assert "consistent" in result.message.lower()

    def test_inconsistent_package_json_returns_warning(
        self, release_context: ReleaseContext, tmp_path: Path
    ) -> None:
        """Validate that mismatched package.json version returns warning."""
        validator = VersionConsistencyValidator()
        release_context.project_root = tmp_path
        release_context.version = "1.0.0"

        # Create package.json with different version
        package_json = {"name": "test", "version": "0.9.0"}
        (tmp_path / "package.json").write_text(json.dumps(package_json))

        result = validator.validate(release_context)

        assert result.passed is True  # Warning, not error
        assert result.severity == ValidationSeverity.WARNING
        assert "inconsistencies" in result.message.lower()
        assert "0.9.0" in result.details

    def test_inconsistent_pnpm_lock_returns_warning(
        self, release_context: ReleaseContext, tmp_path: Path
    ) -> None:
        """Validate that mismatched pnpm-lock.yaml version returns warning."""
        validator = VersionConsistencyValidator()
        release_context.project_root = tmp_path
        release_context.version = "1.0.0"

        # Create package.json with correct version
        package_json = {"name": "test", "version": "1.0.0"}
        (tmp_path / "package.json").write_text(json.dumps(package_json))

        # Create pnpm-lock.yaml with different version
        pnpm_lock_content = """lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
packages:
  name: test
  version: 0.9.0
"""
        (tmp_path / "pnpm-lock.yaml").write_text(pnpm_lock_content)

        result = validator.validate(release_context)

        assert result.passed is True
        assert result.severity == ValidationSeverity.WARNING
        assert "pnpm-lock.yaml" in result.details

    def test_no_package_files_returns_success(
        self, release_context: ReleaseContext, tmp_path: Path
    ) -> None:
        """Validate that missing package files returns success (nothing to check)."""
        validator = VersionConsistencyValidator()
        release_context.project_root = tmp_path
        release_context.version = "1.0.0"

        # No package.json or lock files created

        result = validator.validate(release_context)

        assert result.passed is True

    def test_invalid_package_json_returns_error(
        self, release_context: ReleaseContext, tmp_path: Path
    ) -> None:
        """Validate that invalid JSON in package.json returns error."""
        validator = VersionConsistencyValidator()
        release_context.project_root = tmp_path
        release_context.version = "1.0.0"

        # Create invalid JSON
        (tmp_path / "package.json").write_text("{invalid json")

        result = validator.validate(release_context)

        assert result.passed is False
        assert result.severity == ValidationSeverity.ERROR
        assert "failed to read" in result.message.lower()
