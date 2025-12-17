"""Git state query operations.

This module provides read-only git operations for inspecting repository state.
All functions use release.utils.shell.run() for command execution and raise
GitError on failures.
"""

import re
from pathlib import Path

from release.exceptions import GitError
from release.utils.shell import run


def is_clean(cwd: Path | None = None) -> bool:
    """Check if the working directory is clean (no uncommitted changes).

    Args:
        cwd: Working directory (defaults to current directory)

    Returns:
        True if working directory is clean, False otherwise

    Raises:
        GitError: If git status command fails
    """
    try:
        result = run(["git", "status", "--porcelain"], cwd=cwd, check=True)
        # Empty output means clean working directory
        return not result.stdout.strip()
    except Exception as e:
        raise GitError(
            "Failed to check git working directory status",
            details=str(e),
            fix_hint="Ensure you are in a git repository and git is installed",
        ) from e


def get_current_branch(cwd: Path | None = None) -> str:
    """Get the name of the current git branch.

    Args:
        cwd: Working directory (defaults to current directory)

    Returns:
        Current branch name (e.g., "main", "develop")

    Raises:
        GitError: If unable to determine current branch
    """
    try:
        result = run(["git", "branch", "--show-current"], cwd=cwd, check=True)
        branch = result.stdout.strip()
        if not branch:
            # Fallback for detached HEAD state
            result = run(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=cwd, check=True
            )
            branch = result.stdout.strip()
        return branch
    except Exception as e:
        raise GitError(
            "Failed to get current branch name",
            details=str(e),
            fix_hint="Ensure you are in a git repository with at least one commit",
        ) from e


def get_remote_url(remote: str = "origin", cwd: Path | None = None) -> str:
    """Get the URL of a git remote.

    Args:
        remote: Name of the remote (default: "origin")
        cwd: Working directory (defaults to current directory)

    Returns:
        Remote URL (e.g., "https://github.com/user/repo.git")

    Raises:
        GitError: If remote does not exist or cannot be retrieved
    """
    try:
        # Use list format to safely handle remote names
        result = run(["git", "remote", "get-url", remote], cwd=cwd, check=True)
        return result.stdout.strip()
    except Exception as e:
        raise GitError(
            f"Failed to get URL for remote '{remote}'",
            details=str(e),
            fix_hint=f"Ensure remote '{remote}' exists. Run 'git remote -v' to list remotes.",
        ) from e


def get_latest_tag(cwd: Path | None = None) -> str | None:
    """Get the most recent git tag.

    Uses 'git describe --tags --abbrev=0' to find the latest tag
    reachable from the current commit.

    Args:
        cwd: Working directory (defaults to current directory)

    Returns:
        Most recent tag name (e.g., "v1.0.12"), or None if no tags exist

    Raises:
        GitError: If git command fails (excluding "no tags found" case)
    """
    try:
        result = run(["git", "describe", "--tags", "--abbrev=0"], cwd=cwd, check=False)
        if result.returncode == 0:
            return result.stdout.strip()
        # No tags exist - this is not an error
        return None
    except Exception as e:
        raise GitError(
            "Failed to get latest git tag",
            details=str(e),
            fix_hint="Ensure you are in a git repository",
        ) from e


def get_tags(cwd: Path | None = None) -> list[str]:
    """Get all git tags in the repository.

    Args:
        cwd: Working directory (defaults to current directory)

    Returns:
        List of tag names, sorted by version (most recent last)
        Returns empty list if no tags exist

    Raises:
        GitError: If git command fails
    """
    try:
        result = run(
            ["git", "tag", "--list", "--sort=version:refname"], cwd=cwd, check=True
        )
        tags = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        return tags
    except Exception as e:
        raise GitError(
            "Failed to list git tags",
            details=str(e),
            fix_hint="Ensure you are in a git repository",
        ) from e


def get_commit_sha(ref: str = "HEAD", cwd: Path | None = None) -> str:
    """Get the full SHA hash of a git commit reference.

    Args:
        ref: Git reference (e.g., "HEAD", "main", "v1.0.0")
        cwd: Working directory (defaults to current directory)

    Returns:
        Full 40-character commit SHA

    Raises:
        GitError: If reference does not exist or cannot be resolved
    """
    try:
        # Use list format to safely handle refs
        result = run(["git", "rev-parse", ref], cwd=cwd, check=True)
        sha = result.stdout.strip()
        # Validate SHA format (40 hex characters)
        if not re.match(r"^[0-9a-f]{40}$", sha):
            raise GitError(
                f"Invalid commit SHA format: {sha}",
                details=f"Expected 40 hex characters for ref '{ref}'",
                fix_hint="Ensure the git reference exists and is valid",
            )
        return sha
    except GitError:
        raise
    except Exception as e:
        raise GitError(
            f"Failed to resolve git reference '{ref}'",
            details=str(e),
            fix_hint="Ensure the reference exists. Run 'git log' or 'git tag' to verify.",
        ) from e


def get_commits_since_tag(tag: str, cwd: Path | None = None) -> list[dict[str, str]]:
    """Get all commits since a given tag.

    Args:
        tag: Tag name to compare against (e.g., "v1.0.11")
        cwd: Working directory (defaults to current directory)

    Returns:
        List of commit dictionaries with keys:
        - sha: Full commit SHA
        - short_sha: Abbreviated SHA (7 chars)
        - subject: Commit message first line
        - author: Commit author name
        - date: Commit date (ISO 8601 format)

    Raises:
        GitError: If tag does not exist or git command fails
    """
    try:
        # Format: %H|%h|%s|%an|%aI
        # %H = full SHA, %h = short SHA, %s = subject, %an = author name, %aI = author date ISO
        format_str = "%H|%h|%s|%an|%aI"
        # Use list format to safely handle tag names
        result = run(
            ["git", "log", f"{tag}..HEAD", f"--pretty=format:{format_str}"],
            cwd=cwd,
            check=True,
        )

        commits = []
        for line in result.stdout.splitlines():
            if not line.strip():
                continue
            parts = line.split("|", maxsplit=4)
            if len(parts) == 5:
                commits.append(
                    {
                        "sha": parts[0],
                        "short_sha": parts[1],
                        "subject": parts[2],
                        "author": parts[3],
                        "date": parts[4],
                    }
                )

        return commits
    except Exception as e:
        raise GitError(
            f"Failed to get commits since tag '{tag}'",
            details=str(e),
            fix_hint=f"Ensure tag '{tag}' exists. Run 'git tag' to list tags.",
        ) from e


def has_remote_changes(
    remote: str = "origin", branch: str | None = None, cwd: Path | None = None
) -> bool:
    """Check if the remote branch has new commits.

    Fetches the remote branch and compares it with the local branch.
    Returns True if the remote has commits that aren't in the local branch.

    Args:
        remote: Name of the remote (default: "origin")
        branch: Branch name (defaults to current branch)
        cwd: Working directory (defaults to current directory)

    Returns:
        True if remote has new commits, False otherwise

    Raises:
        GitError: If fetch fails or branch does not exist
    """
    try:
        # Get current branch if not specified
        if branch is None:
            branch = get_current_branch(cwd=cwd)

        # Fetch remote updates - use list format for safety
        run(["git", "fetch", remote, branch], cwd=cwd, check=True)

        # Compare local and remote - use list format for safety
        result = run(
            ["git", "rev-list", f"HEAD..{remote}/{branch}", "--count"],
            cwd=cwd,
            check=True,
        )

        # If count > 0, remote has new commits
        count = int(result.stdout.strip())
        return count > 0

    except ValueError as e:
        raise GitError(
            "Failed to parse commit count",
            details=str(e),
            fix_hint="This is likely a bug in the release tool. Please report it.",
        ) from e
    except Exception as e:
        raise GitError(
            f"Failed to check for remote changes on '{remote}/{branch}'",
            details=str(e),
            fix_hint=f"Ensure remote '{remote}' and branch '{branch}' exist",
        ) from e


def tag_exists(
    tag: str, remote: bool = False, remote_name: str = "origin", cwd: Path | None = None
) -> bool:
    """Check if a git tag exists locally or remotely.

    Args:
        tag: Tag name to check (e.g., "v1.0.12")
        remote: If True, check remote tags instead of local
        remote_name: Name of remote to check (default: "origin")
        cwd: Working directory (defaults to current directory)

    Returns:
        True if tag exists, False otherwise

    Raises:
        GitError: If git command fails
    """
    try:
        if remote:
            # Check if tag exists on remote without fetching - use list format
            result = run(
                ["git", "ls-remote", "--tags", remote_name], cwd=cwd, check=True
            )
            # Output format: <sha> refs/tags/<tag>
            return f"refs/tags/{tag}" in result.stdout
        else:
            # Check if tag exists locally - use list format
            result = run(["git", "rev-parse", tag], cwd=cwd, check=False)
            return result.returncode == 0
    except Exception as e:
        raise GitError(
            f"Failed to check if tag '{tag}' exists",
            details=str(e),
            fix_hint="Ensure you are in a git repository",
        ) from e


def is_ancestor(
    ancestor: str, descendant: str = "HEAD", cwd: Path | None = None
) -> bool:
    """Check if one commit is an ancestor of another.

    Args:
        ancestor: Commit/tag/branch that might be an ancestor
        descendant: Commit/tag/branch to check against (default: HEAD)
        cwd: Working directory (defaults to current directory)

    Returns:
        True if ancestor is an ancestor of descendant

    Raises:
        GitError: If references don't exist or git command fails
    """
    try:
        # Use list format to safely handle refs
        result = run(
            ["git", "merge-base", "--is-ancestor", ancestor, descendant],
            cwd=cwd,
            check=False,
        )
        return result.returncode == 0
    except Exception as e:
        raise GitError(
            f"Failed to check if '{ancestor}' is ancestor of '{descendant}'",
            details=str(e),
            fix_hint="Ensure both references exist",
        ) from e


def get_uncommitted_files(cwd: Path | None = None) -> list[str]:
    """Get list of files with uncommitted changes.

    Args:
        cwd: Working directory (defaults to current directory)

    Returns:
        List of file paths with uncommitted changes
        Returns empty list if no uncommitted files

    Raises:
        GitError: If git command fails
    """
    try:
        result = run(["git", "status", "--porcelain"], cwd=cwd, check=True)

        files = []
        for line in result.stdout.strip().split("\n"):
            if line:
                # Format: "XY filename" where XY is status code
                parts = line.strip().split(maxsplit=1)
                if len(parts) == 2:
                    files.append(parts[1])
        return files
    except Exception as e:
        raise GitError(
            "Failed to get uncommitted files",
            details=str(e),
            fix_hint="Ensure you are in a git repository",
        ) from e


def is_remote_reachable(
    remote: str = "origin", timeout: int = 10, cwd: Path | None = None
) -> bool:
    """Check if a git remote exists and is reachable.

    Args:
        remote: Remote name to check (default: "origin")
        timeout: Timeout in seconds for remote check
        cwd: Working directory (defaults to current directory)

    Returns:
        True if remote is reachable, False otherwise

    Raises:
        GitError: If git command fails
    """
    try:
        # Check if remote exists - use list format
        result = run(["git", "remote", "get-url", remote], cwd=cwd, check=False)
        if result.returncode != 0:
            return False

        # Check if we can reach it (ls-remote with timeout) - use list format
        result = run(
            ["git", "ls-remote", "--exit-code", remote, "HEAD"],
            cwd=cwd,
            check=False,
            timeout=timeout,
        )
        return result.returncode == 0
    except Exception as e:
        raise GitError(
            f"Failed to check if remote '{remote}' is reachable",
            details=str(e),
            fix_hint="Check network connectivity and remote configuration",
        ) from e
