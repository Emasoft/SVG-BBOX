"""Git operations and utilities.

This module provides a clean API for git operations used in the release tool.
All operations use release.utils.shell.run() for safe command execution
and raise GitError on failures.
"""

from pathlib import Path

from release.git.operations import (
    checkout,
    commit,
    delete_tag,
    fetch,
    merge,
    push,
    push_tag,
    reset,
    stash,
    stash_pop,
    tag,
)
from release.git.queries import (
    get_commit_sha,
    get_commits_since_tag,
    get_current_branch,
    get_latest_tag,
    get_remote_url,
    get_tags,
    get_uncommitted_files,
    has_remote_changes,
    is_ancestor,
    is_clean,
    is_remote_reachable,
    tag_exists,
)

# Backward compatibility aliases
is_working_directory_clean = is_clean


def tag_exists_remote(
    project_root: Path | None, tag: str, remote: str = "origin"
) -> bool:
    """Check if a git tag exists on remote (backward compatibility).

    Args:
        project_root: Path to project root directory
        tag: Tag name to check
        remote: Remote name (default: "origin")

    Returns:
        True if tag exists on remote, False otherwise
    """
    return tag_exists(tag, remote=True, cwd=project_root)


def is_up_to_date_with_remote(
    project_root: Path | None, branch: str | None = None, remote: str = "origin"
) -> tuple[bool, str | None]:
    """Check if local branch is up to date with remote (backward compatibility).

    Args:
        project_root: Path to project root directory
        branch: Branch name (uses current branch if None)
        remote: Remote name (default: "origin")

    Returns:
        Tuple of (is_up_to_date, status_message)
    """
    try:
        from release.exceptions import GitError

        # Get current branch if not specified
        if branch is None:
            branch = get_current_branch(cwd=project_root)

        # Fetch latest from remote
        fetch(remote=remote, branch=branch, cwd=project_root)

        # Check tracking branch
        from release.utils.shell import run

        result = run(
            f"git rev-parse --abbrev-ref {branch}@{{upstream}}",
            cwd=project_root,
            check=False,
        )
        if result.returncode != 0:
            return (False, "no_tracking")

        upstream = result.stdout.strip()

        # Compare local and remote
        result = run(
            f"git rev-list --left-right --count {branch}...{upstream}",
            cwd=project_root,
            check=False,
        )
        if result.returncode != 0:
            return (False, "error")

        parts = result.stdout.strip().split("\t")
        if len(parts) != 2:
            return (False, "error")

        ahead = int(parts[0])
        behind = int(parts[1])

        if ahead == 0 and behind == 0:
            return (True, None)
        elif ahead > 0 and behind == 0:
            return (False, "ahead")
        elif ahead == 0 and behind > 0:
            return (False, "behind")
        else:
            return (False, "diverged")

    except GitError:
        return (False, "error")
    except Exception:
        return (False, "error")


__all__ = [
    # Query operations
    "is_clean",
    "get_current_branch",
    "get_remote_url",
    "get_latest_tag",
    "get_tags",
    "get_commit_sha",
    "get_commits_since_tag",
    "has_remote_changes",
    "tag_exists",
    "is_ancestor",
    "get_uncommitted_files",
    "is_remote_reachable",
    # Modification operations
    "commit",
    "tag",
    "push",
    "push_tag",
    "delete_tag",
    "fetch",
    "merge",
    "checkout",
    "reset",
    "stash",
    "stash_pop",
    # Backward compatibility
    "is_working_directory_clean",
    "tag_exists_remote",
    "is_up_to_date_with_remote",
]
