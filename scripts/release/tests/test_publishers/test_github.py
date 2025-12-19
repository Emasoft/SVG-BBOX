"""Unit tests for release.publishers.github module.

Tests for GitHubPublisher:
- detect() equivalent via get_repo_info() - with git remote
- should_publish() - checking GitHub release configuration
- verify() and publish() basic behavior

Coverage: 3 tests covering core GitHub publisher detection and configuration.
"""

import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

from release.config.models import (
    GitConfig,
    GitHubConfig,
    ProjectConfig,
    ReleaseConfig,
)
from release.publishers.base import PublishContext, PublishStatus
from release.publishers.github import (
    GitHubPublisher,
    get_repo_info,
)


class TestGitHubPublisherDetect:
    """Tests for GitHubPublisher detection via get_repo_info()."""

    def test_detect_with_git_remote_returns_owner_repo(self, git_repo: Path) -> None:
        """Test that get_repo_info() correctly parses GitHub remote URL.

        Uses git_repo fixture which has git initialized, adds a GitHub remote,
        and verifies the owner and repo are correctly extracted.
        """
        # Add a GitHub remote with HTTPS URL
        subprocess.run(
            [
                "git",
                "remote",
                "add",
                "origin",
                "https://github.com/testowner/test-github-repo.git",
            ],
            cwd=git_repo,
            capture_output=True,
            check=True,
        )

        # Test get_repo_info
        result = get_repo_info(git_repo)

        assert result is not None, "get_repo_info should return tuple for valid remote"
        owner, repo = result
        assert owner == "testowner", "Owner should be 'testowner'"
        assert repo == "test-github-repo", "Repo should be 'test-github-repo'"

    def test_detect_with_ssh_remote_returns_owner_repo(self, git_repo: Path) -> None:
        """Test that get_repo_info() correctly parses SSH-style GitHub URL.

        Verifies the function handles git@github.com:owner/repo.git format
        which is commonly used for SSH authentication.
        """
        # Add a GitHub remote with SSH URL
        subprocess.run(
            [
                "git",
                "remote",
                "add",
                "origin",
                "git@github.com:myorg/my-awesome-project.git",
            ],
            cwd=git_repo,
            capture_output=True,
            check=True,
        )

        # Test get_repo_info
        result = get_repo_info(git_repo)

        assert result is not None, "get_repo_info should return tuple for SSH remote"
        owner, repo = result
        assert owner == "myorg", "Owner should be 'myorg'"
        assert repo == "my-awesome-project", "Repo should be 'my-awesome-project'"

    def test_detect_without_remote_returns_none(self, git_repo: Path) -> None:
        """Test that get_repo_info() returns None when no remote is configured.

        Verifies the function handles git repositories without any remote
        configuration gracefully by returning None.
        """
        # git_repo fixture already has git init but no remote

        # Test get_repo_info
        result = get_repo_info(git_repo)

        assert result is None, "get_repo_info should return None when no remote exists"


class TestGitHubPublisherShouldPublish:
    """Tests for GitHubPublisher.should_publish()."""

    def test_should_publish_respects_create_release_config(
        self, git_repo: Path
    ) -> None:
        """Test that should_publish() respects github.create_release config.

        Verifies that when create_release is set to False, the publisher
        will not attempt to create a GitHub release.
        """
        # Add remote for realistic scenario
        subprocess.run(
            [
                "git",
                "remote",
                "add",
                "origin",
                "https://github.com/example/config-test-repo.git",
            ],
            cwd=git_repo,
            capture_output=True,
            check=True,
        )

        # Create mock config with create_release = False
        mock_config = MagicMock(spec=ReleaseConfig)
        mock_config.project = ProjectConfig(name="config-test")
        mock_config.github = MagicMock(spec=GitHubConfig)
        mock_config.github.owner = "example"
        mock_config.github.repo = "config-test-repo"
        mock_config.github.create_release = False
        mock_config.github.draft = False
        mock_config.github.prerelease = False

        # Create context
        context = PublishContext(
            project_root=git_repo,
            config=mock_config,
            version="1.0.0",
            tag_name="v1.0.0",
            release_notes="Test release notes",
        )

        # Test should_publish with create_release disabled
        publisher = GitHubPublisher()
        result = publisher.should_publish(context)

        assert result is False, (
            "should_publish() should return False when create_release is False"
        )

        # Now test with create_release = True (default behavior)
        mock_config.github.create_release = True
        result_enabled = publisher.should_publish(context)

        assert result_enabled is True, (
            "should_publish() should return True when create_release is True"
        )


class TestGitHubPublisherPublish:
    """Tests for GitHubPublisher.publish() functionality."""

    def test_publish_dry_run_returns_success(self, git_repo: Path) -> None:
        """Test that publish() in dry_run mode returns success without gh CLI.

        Verifies that dry run mode works correctly and returns expected
        metadata without actually creating a GitHub release.
        """
        # Add remote
        subprocess.run(
            [
                "git",
                "remote",
                "add",
                "origin",
                "https://github.com/dryrunowner/dryrun-repo.git",
            ],
            cwd=git_repo,
            capture_output=True,
            check=True,
        )

        # Create mock config
        mock_config = MagicMock(spec=ReleaseConfig)
        mock_config.project = ProjectConfig(name="dryrun-test")
        mock_config.github = GitHubConfig(owner="dryrunowner", repo="dryrun-repo")
        mock_config.git = GitConfig()

        # Create context with dry_run=True
        release_notes = """## v3.0.0 Release

### Breaking Changes
- Updated API endpoints

### Features
- New authentication system
"""
        context = PublishContext(
            project_root=git_repo,
            config=mock_config,
            version="3.0.0",
            tag_name="v3.0.0",
            release_notes=release_notes,
            dry_run=True,
            verbose=True,
        )

        # Test publish in dry run mode
        publisher = GitHubPublisher()

        # Mock is_command_available to avoid gh CLI check
        with patch("release.publishers.github.is_command_available", return_value=True):
            result = publisher.publish(context)

        # Verify dry run returns expected values
        assert result.status == PublishStatus.SUCCESS, (
            "Dry run should return SUCCESS status"
        )
        assert "Would create release" in result.message, (
            "Message should indicate dry run mode"
        )
        assert result.registry_url == "https://github.com/dryrunowner/dryrun-repo", (
            "Registry URL should be GitHub repo URL"
        )
        assert (
            result.package_url
            == "https://github.com/dryrunowner/dryrun-repo/releases/tag/v3.0.0"
        ), "Package URL should be release tag URL"
        assert result.version == "3.0.0", "Version should match context version"

    def test_publish_without_gh_cli_returns_failure(self, git_repo: Path) -> None:
        """Test that publish() returns failure when gh CLI is not available.

        Verifies that the publisher correctly handles missing gh CLI tool
        and returns an appropriate error message.
        """
        # Add remote
        subprocess.run(
            [
                "git",
                "remote",
                "add",
                "origin",
                "https://github.com/noghowner/nogh-repo.git",
            ],
            cwd=git_repo,
            capture_output=True,
            check=True,
        )

        # Create mock config
        mock_config = MagicMock(spec=ReleaseConfig)
        mock_config.project = ProjectConfig(name="nogh-test")
        mock_config.github = GitHubConfig(owner="noghowner", repo="nogh-repo")
        mock_config.git = GitConfig()

        # Create context with dry_run=False to actually attempt publish
        context = PublishContext(
            project_root=git_repo,
            config=mock_config,
            version="1.0.0",
            tag_name="v1.0.0",
            release_notes="Test notes",
            dry_run=False,
        )

        # Test publish with gh CLI not available
        publisher = GitHubPublisher()

        # Mock is_command_available to return False
        with patch(
            "release.publishers.github.is_command_available", return_value=False
        ):
            result = publisher.publish(context)

        # Verify failure is returned
        assert result.status == PublishStatus.FAILED, (
            "Should return FAILED when gh CLI is missing"
        )
        assert "gh CLI not installed" in result.message, (
            "Message should explain gh CLI is required"
        )
        assert result.details is not None, "Details should explain the requirement"


class TestGitHubPublisherRollback:
    """Tests for GitHubPublisher.can_rollback() and rollback()."""

    def test_can_rollback_returns_true(self) -> None:
        """Test that GitHubPublisher supports rollback.

        Verifies that the publisher advertises rollback capability since
        GitHub releases can be deleted.
        """
        publisher = GitHubPublisher()
        assert publisher.can_rollback() is True, (
            "GitHubPublisher should support rollback"
        )
