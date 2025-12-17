"""GitHub Releases publisher.

Creates GitHub releases using the gh CLI tool with automatic authentication.

Features:
- Creates releases with proper release notes
- Supports draft and prerelease flags
- Uploads release assets
- Verifies release creation
- Supports rollback (release deletion)
"""

import json
import re
from pathlib import Path
from typing import ClassVar

from release.exceptions import PublishError
from release.publishers.base import (
    PublishContext,
    Publisher,
    PublisherRegistry,
    PublishResult,
)
from release.utils.shell import ShellError, is_command_available, run


def get_repo_info(cwd: Path) -> tuple[str, str] | None:
    """Extract GitHub owner/repo from git remote.

    Args:
        cwd: Working directory with git repository

    Returns:
        Tuple of (owner, repo) or None if not a GitHub repo
    """
    try:
        result = run("git remote get-url origin", cwd=cwd, capture=True, check=True)
        remote_url = result.stdout.strip()

        # Match various GitHub URL formats:
        # - https://github.com/owner/repo.git
        # - git@github.com:owner/repo.git
        # - https://github.com/owner/repo
        patterns = [
            r"github\.com[:/]([^/]+)/([^/\s]+?)(?:\.git)?$",
        ]

        for pattern in patterns:
            match = re.search(pattern, remote_url)
            if match:
                owner, repo = match.groups()
                return owner, repo

        return None
    except ShellError:
        return None


def get_current_commit(cwd: Path) -> str:
    """Get the current HEAD commit SHA.

    Args:
        cwd: Working directory with git repository

    Returns:
        Full commit SHA

    Raises:
        PublishError: If git command fails
    """
    try:
        result = run("git rev-parse HEAD", cwd=cwd, capture=True, check=True)
        return result.stdout.strip()
    except ShellError as e:
        raise PublishError(
            "Failed to get current commit SHA",
            details=str(e),
            fix_hint="Ensure you are in a git repository",
        ) from e


@PublisherRegistry.register
class GitHubPublisher(Publisher):
    """Publisher for GitHub Releases.

    Creates releases on GitHub using the gh CLI tool. Supports draft/prerelease
    flags, asset uploads, and release deletion for rollbacks.
    """

    name: ClassVar[str] = "github"
    display_name: ClassVar[str] = "GitHub Releases"
    registry_name: ClassVar[str] = "github.com"

    def publish(self, context: PublishContext) -> PublishResult:
        """Publish a GitHub release.

        Args:
            context: Publish context with version and config

        Returns:
            PublishResult indicating success/failure
        """
        # Check gh CLI is installed
        if not is_command_available("gh"):
            return PublishResult.failed(
                "gh CLI not installed",
                details="GitHub CLI (gh) is required for creating releases",
            )

        # Get repo info from git or config
        repo_info = get_repo_info(context.project_root)
        if not repo_info:
            # Fall back to config
            owner = context.config.github.owner
            repo = context.config.github.repo
        else:
            owner, repo = repo_info

        # Dry run mode
        if context.dry_run:
            if context.verbose:
                print(
                    f"[DRY RUN] Would create GitHub release {context.tag_name} "
                    f"for {owner}/{repo}"
                )
            return PublishResult.success(
                f"Would create release {context.tag_name}",
                registry_url=f"https://github.com/{owner}/{repo}",
                package_url=f"https://github.com/{owner}/{repo}/releases/tag/{context.tag_name}",
                version=context.version,
            )

        # Get current commit SHA
        commit_sha = get_current_commit(context.project_root)

        # Determine target for release
        if context.config.github.release_target == "commit_sha":
            target = commit_sha
        else:
            target = context.config.git.main_branch

        # Build gh release create command
        cmd_parts = [
            "gh",
            "release",
            "create",
            context.tag_name,
            "--title",
            context.tag_name,
        ]

        # Add release notes (use heredoc-style approach for multi-line)
        # We'll pass notes via stdin to avoid shell quoting issues
        release_notes = context.release_notes

        # Add target
        cmd_parts.extend(["--target", target])

        # Add draft flag if configured
        if getattr(context.config.github, "draft", False):
            cmd_parts.append("--draft")

        # Add prerelease flag if configured
        if getattr(context.config.github, "prerelease", False):
            cmd_parts.append("--prerelease")

        # Add repo specification
        cmd_parts.extend(["--repo", f"{owner}/{repo}"])

        # Add assets if configured
        upload_assets = getattr(context.config.github, "upload_assets", [])
        for asset_pattern in upload_assets:
            # Resolve asset paths relative to project root
            asset_path = context.project_root / asset_pattern
            if asset_path.exists():
                cmd_parts.append(str(asset_path))
            elif context.verbose:
                print(f"Warning: Asset not found: {asset_pattern}")

        # Add notes as final argument
        cmd_parts.extend(["--notes", release_notes])

        try:
            # Execute gh release create
            result = run(
                cmd_parts,
                cwd=context.project_root,
                capture=True,
                check=True,
            )

            # Extract release URL from output
            release_url = result.stdout.strip()
            if not release_url.startswith("http"):
                # If gh didn't return URL, construct it
                release_url = (
                    f"https://github.com/{owner}/{repo}/releases/tag/{context.tag_name}"
                )

            return PublishResult.success(
                f"Created GitHub release {context.tag_name}",
                registry_url=f"https://github.com/{owner}/{repo}",
                package_url=release_url,
                version=context.version,
            )

        except ShellError as e:
            return PublishResult.failed(
                f"Failed to create GitHub release: {str(e)}",
                details=e.stderr or e.stdout,
            )

    def verify(self, context: PublishContext) -> bool:
        """Verify the GitHub release was created successfully.

        Args:
            context: Publish context

        Returns:
            True if release exists and is visible
        """
        if not is_command_available("gh"):
            return False

        # Get repo info
        repo_info = get_repo_info(context.project_root)
        if not repo_info:
            owner = context.config.github.owner
            repo = context.config.github.repo
        else:
            owner, repo = repo_info

        try:
            # Check if release exists
            result = run(
                [
                    "gh",
                    "release",
                    "view",
                    context.tag_name,
                    "--repo",
                    f"{owner}/{repo}",
                    "--json",
                    "tagName,isDraft",
                ],
                cwd=context.project_root,
                capture=True,
                check=True,
            )

            # Parse JSON output
            release_data: dict[str, object] = json.loads(result.stdout)

            # Verify tag matches
            return bool(release_data.get("tagName") == context.tag_name)

        except (ShellError, json.JSONDecodeError):
            return False

    def should_publish(self, context: PublishContext) -> bool:
        """Check if GitHub release should be created.

        Args:
            context: Publish context

        Returns:
            True if GitHub releases are enabled in config
        """
        # Check if create_release is configured (default True)
        return getattr(context.config.github, "create_release", True)

    def can_rollback(self) -> bool:
        """Check if GitHub releases support rollback.

        Returns:
            True (releases can be deleted)
        """
        return True

    def rollback(self, context: PublishContext) -> PublishResult:
        """Delete a GitHub release (rollback).

        Args:
            context: Publish context

        Returns:
            PublishResult indicating rollback success/failure
        """
        if not is_command_available("gh"):
            return PublishResult.failed(
                "gh CLI not installed",
                details="Cannot rollback without gh CLI",
            )

        # Get repo info
        repo_info = get_repo_info(context.project_root)
        if not repo_info:
            owner = context.config.github.owner
            repo = context.config.github.repo
        else:
            owner, repo = repo_info

        try:
            # Delete the GitHub release
            run(
                [
                    "gh",
                    "release",
                    "delete",
                    context.tag_name,
                    "--repo",
                    f"{owner}/{repo}",
                    "-y",
                ],
                cwd=context.project_root,
                capture=True,
                check=True,
            )

            return PublishResult.success(
                f"Deleted GitHub release {context.tag_name}",
                version=context.version,
            )

        except ShellError as e:
            return PublishResult.failed(
                f"Failed to delete GitHub release: {str(e)}",
                details=e.stderr or e.stdout,
            )
