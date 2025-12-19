"""Tests for git state validators.

Tests the following validators:
- GitCleanValidator: Validates working directory cleanliness
- GitBranchValidator: Validates current branch matches main branch
- GitRemoteValidator: Validates remote connectivity and sync status
- GitTagValidator: Validates tag availability for new releases

These tests mock the git query functions to avoid actual git operations.
"""

from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from release.config.models import GitConfig, ReleaseConfig, SafetyConfig
from release.exceptions import GitError
from release.validators.base import ReleaseContext, ValidationSeverity
from release.validators.git import (
    GitBranchValidator,
    GitCleanValidator,
    GitRemoteValidator,
    GitTagValidator,
)


@pytest.fixture
def mock_config() -> MagicMock:
    """Create a mock ReleaseConfig with typical settings.

    Returns:
        MagicMock configured as a ReleaseConfig
    """
    config = MagicMock(spec=ReleaseConfig)
    config.git = MagicMock(spec=GitConfig)
    config.git.main_branch = "main"
    config.safety = MagicMock(spec=SafetyConfig)
    config.safety.require_clean_worktree = True
    config.safety.require_main_branch = True
    config.version = MagicMock()
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


class TestGitCleanValidator:
    """Tests for GitCleanValidator - validates working directory cleanliness."""

    def test_clean_working_directory_returns_success(
        self, release_context: ReleaseContext
    ) -> None:
        """Validate that a clean working directory returns success result."""
        validator = GitCleanValidator()

        with patch("release.validators.git.is_clean", return_value=True):
            result = validator.validate(release_context)

        assert result.passed is True
        assert result.severity == ValidationSeverity.INFO
        assert "clean" in result.message.lower()

    def test_dirty_working_directory_returns_error(
        self, release_context: ReleaseContext
    ) -> None:
        """Validate that uncommitted changes return an error with file list."""
        validator = GitCleanValidator()
        uncommitted_files = ["src/main.py", "README.md", "package.json"]

        with (
            patch("release.validators.git.is_clean", return_value=False),
            patch(
                "release.validators.git.get_uncommitted_files",
                return_value=uncommitted_files,
            ),
        ):
            result = validator.validate(release_context)

        assert result.passed is False
        assert result.severity == ValidationSeverity.ERROR
        assert "uncommitted" in result.message.lower()
        assert result.details is not None
        assert "src/main.py" in result.details
        assert result.fix_command == "git status"

    def test_git_error_returns_error_result(
        self, release_context: ReleaseContext
    ) -> None:
        """Validate that GitError during status check returns error result."""
        validator = GitCleanValidator()

        with patch(
            "release.validators.git.is_clean",
            side_effect=GitError("Git not found"),
        ):
            result = validator.validate(release_context)

        assert result.passed is False
        assert result.severity == ValidationSeverity.ERROR
        assert "failed" in result.message.lower()

    def test_should_run_respects_config(self, release_context: ReleaseContext) -> None:
        """Validate that should_run checks safety.require_clean_worktree config."""
        validator = GitCleanValidator()

        # When require_clean_worktree is True, should run
        release_context.config.safety.require_clean_worktree = True
        assert validator.should_run(release_context) is True

        # When require_clean_worktree is False, should not run
        release_context.config.safety.require_clean_worktree = False
        assert validator.should_run(release_context) is False


class TestGitBranchValidator:
    """Tests for GitBranchValidator - validates current branch matches main."""

    def test_on_main_branch_returns_success(
        self, release_context: ReleaseContext
    ) -> None:
        """Validate that being on the main branch returns success."""
        validator = GitBranchValidator()
        release_context.config.git.main_branch = "main"

        with patch("release.validators.git.get_current_branch", return_value="main"):
            result = validator.validate(release_context)

        assert result.passed is True
        assert result.severity == ValidationSeverity.INFO
        assert "main" in result.message

    def test_not_on_main_branch_returns_error(
        self, release_context: ReleaseContext
    ) -> None:
        """Validate that being on a feature branch returns error with checkout hint."""
        validator = GitBranchValidator()
        release_context.config.git.main_branch = "main"

        with patch(
            "release.validators.git.get_current_branch",
            return_value="feature/new-thing",
        ):
            result = validator.validate(release_context)

        assert result.passed is False
        assert result.severity == ValidationSeverity.ERROR
        assert "main" in result.message
        assert "feature/new-thing" in result.message
        assert result.fix_command is not None
        assert "git checkout main" in result.fix_command

    def test_custom_main_branch_name(self, release_context: ReleaseContext) -> None:
        """Validate that custom main branch names (e.g., master) are respected."""
        validator = GitBranchValidator()
        release_context.config.git.main_branch = "master"

        with patch("release.validators.git.get_current_branch", return_value="master"):
            result = validator.validate(release_context)

        assert result.passed is True
        assert "master" in result.message

    def test_should_run_respects_config(self, release_context: ReleaseContext) -> None:
        """Validate that should_run checks safety.require_main_branch config."""
        validator = GitBranchValidator()

        release_context.config.safety.require_main_branch = True
        assert validator.should_run(release_context) is True

        release_context.config.safety.require_main_branch = False
        assert validator.should_run(release_context) is False


class TestGitRemoteValidator:
    """Tests for GitRemoteValidator - validates remote connectivity and sync."""

    def test_remote_reachable_and_up_to_date_returns_success(
        self, release_context: ReleaseContext
    ) -> None:
        """Validate that reachable remote with no new commits returns success."""
        validator = GitRemoteValidator()

        with (
            patch("release.validators.git.is_remote_reachable", return_value=True),
            patch("release.validators.git.has_remote_changes", return_value=False),
        ):
            result = validator.validate(release_context)

        assert result.passed is True
        assert result.severity == ValidationSeverity.INFO
        assert "reachable" in result.message.lower()

    def test_remote_not_reachable_returns_error(
        self, release_context: ReleaseContext
    ) -> None:
        """Validate that unreachable remote returns error with network hint."""
        validator = GitRemoteValidator()

        with patch("release.validators.git.is_remote_reachable", return_value=False):
            result = validator.validate(release_context)

        assert result.passed is False
        assert result.severity == ValidationSeverity.ERROR
        assert "not reachable" in result.message.lower()
        assert result.fix_command is not None

    def test_remote_has_new_commits_returns_error(
        self, release_context: ReleaseContext
    ) -> None:
        """Validate that remote with new commits returns error with pull hint."""
        validator = GitRemoteValidator()

        with (
            patch("release.validators.git.is_remote_reachable", return_value=True),
            patch("release.validators.git.has_remote_changes", return_value=True),
        ):
            result = validator.validate(release_context)

        assert result.passed is False
        assert result.severity == ValidationSeverity.ERROR
        assert "behind" in result.message.lower()
        assert result.fix_command == "git pull"

    def test_sync_check_fails_returns_warning(
        self, release_context: ReleaseContext
    ) -> None:
        """Validate that failing to check sync status returns warning not error."""
        validator = GitRemoteValidator()

        with (
            patch("release.validators.git.is_remote_reachable", return_value=True),
            patch(
                "release.validators.git.has_remote_changes",
                side_effect=GitError("No tracking branch"),
            ),
        ):
            result = validator.validate(release_context)

        # Should be a warning, not an error - allow release to continue
        assert result.passed is True
        assert result.severity == ValidationSeverity.WARNING
        assert "unable" in result.message.lower()


class TestGitTagValidator:
    """Tests for GitTagValidator - validates tag availability for release."""

    def test_tag_available_returns_success(
        self, release_context: ReleaseContext
    ) -> None:
        """Validate that an available tag name returns success."""
        validator = GitTagValidator()
        release_context.version = "1.0.0"
        release_context.config.version.tag_prefix = "v"

        with (
            patch("release.validators.git.tag_exists", return_value=False),
            patch("release.validators.git.is_remote_reachable", return_value=True),
        ):
            result = validator.validate(release_context)

        assert result.passed is True
        assert result.severity == ValidationSeverity.INFO
        assert "v1.0.0" in result.message
        assert "available" in result.message.lower()

    def test_tag_exists_locally_returns_error(
        self, release_context: ReleaseContext
    ) -> None:
        """Validate that existing local tag returns error with delete command."""
        validator = GitTagValidator()
        release_context.version = "1.0.0"
        release_context.config.version.tag_prefix = "v"

        # First call (local check) returns True, second would be remote
        with patch("release.validators.git.tag_exists", return_value=True):
            result = validator.validate(release_context)

        assert result.passed is False
        assert result.severity == ValidationSeverity.ERROR
        assert "v1.0.0" in result.message
        assert "exists locally" in result.message.lower()
        assert result.fix_command is not None
        assert "git tag -d" in result.fix_command

    def test_tag_exists_on_remote_returns_error(
        self, release_context: ReleaseContext
    ) -> None:
        """Validate that existing remote tag returns error with push delete hint."""
        validator = GitTagValidator()
        release_context.version = "1.0.0"
        release_context.config.version.tag_prefix = "v"

        def tag_exists_mock(tag: str, remote: bool = False, cwd: Any = None) -> bool:
            """Return False for local, True for remote."""
            return remote  # Local: False, Remote: True

        with (
            patch("release.validators.git.tag_exists", side_effect=tag_exists_mock),
            patch("release.validators.git.is_remote_reachable", return_value=True),
        ):
            result = validator.validate(release_context)

        assert result.passed is False
        assert result.severity == ValidationSeverity.ERROR
        assert "remote" in result.message.lower()
        assert result.fix_command is not None
        assert "git push origin :" in result.fix_command

    def test_no_version_in_context_returns_error(
        self, release_context: ReleaseContext
    ) -> None:
        """Validate that missing version in context returns error."""
        validator = GitTagValidator()
        release_context.version = None

        result = validator.validate(release_context)

        assert result.passed is False
        assert result.severity == ValidationSeverity.ERROR
        assert "version not set" in result.message.lower()
