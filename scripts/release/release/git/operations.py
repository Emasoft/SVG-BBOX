"""Git state modification operations.

This module provides git operations that modify repository state.
All functions use release.utils.shell.run() for command execution and raise
GitError on failures.
"""

from pathlib import Path

from release.exceptions import GitError
from release.utils.shell import run


def commit(
    message: str,
    files: str | list[str] | None = None,
    sign: bool = False,
    cwd: Path | None = None,
) -> str:
    """Create a git commit.

    Args:
        message: Commit message
        files: File(s) to add before committing (None = commit staged files only)
        sign: Whether to GPG sign the commit
        cwd: Working directory (defaults to current directory)

    Returns:
        Commit SHA of the new commit

    Raises:
        GitError: If commit fails or no changes to commit
    """
    try:
        # Stage files if provided
        if files is not None:
            file_list = [files] if isinstance(files, str) else files
            for file in file_list:
                # Use list format to safely handle filenames with spaces/special chars
                run(["git", "add", file], cwd=cwd, check=True)

        # Build commit command
        cmd = ["git", "commit", "-m", message]
        if sign:
            cmd.append("-S")

        # Create commit
        run(cmd, cwd=cwd, check=True)

        # Get the commit SHA
        sha_result = run(["git", "rev-parse", "HEAD"], cwd=cwd, check=True)
        return sha_result.stdout.strip()

    except Exception as e:
        raise GitError(
            "Failed to create git commit",
            details=str(e),
            fix_hint="Ensure you have changes staged or files specified. Run 'git status' to check.",
        ) from e


def tag(
    name: str,
    message: str | None = None,
    sign: bool = False,
    cwd: Path | None = None,
) -> None:
    """Create an annotated git tag.

    Args:
        name: Tag name (e.g., "v1.0.12")
        message: Tag annotation message (defaults to tag name if None)
        sign: Whether to GPG sign the tag
        cwd: Working directory (defaults to current directory)

    Raises:
        GitError: If tag creation fails or tag already exists
    """
    try:
        # Use tag name as message if not provided
        tag_message = message if message is not None else name

        # Build tag command
        cmd = ["git", "tag", "-a", name, "-m", tag_message]
        if sign:
            cmd.append("-s")

        # Create tag
        run(cmd, cwd=cwd, check=True)

    except Exception as e:
        raise GitError(
            f"Failed to create git tag '{name}'",
            details=str(e),
            fix_hint=f"Ensure tag '{name}' doesn't already exist. Run 'git tag -d {name}' to delete it first.",
        ) from e


def push(
    remote: str = "origin",
    branch: str | None = None,
    tags: bool = False,
    force: bool = False,
    cwd: Path | None = None,
) -> None:
    """Push commits and/or tags to a remote.

    Args:
        remote: Remote name (default: "origin")
        branch: Branch to push (None = current branch)
        tags: Whether to push tags
        force: Whether to force push (use with caution)
        cwd: Working directory (defaults to current directory)

    Raises:
        GitError: If push fails
    """
    try:
        # Build push command
        cmd = ["git", "push"]
        if force:
            cmd.append("--force")

        cmd.append(remote)

        if tags:
            cmd.append("--tags")
        elif branch:
            cmd.append(branch)

        # Execute push
        run(cmd, cwd=cwd, check=True)

    except Exception as e:
        target = "tags" if tags else (branch or "current branch")
        raise GitError(
            f"Failed to push {target} to remote '{remote}'",
            details=str(e),
            fix_hint="Ensure remote exists and you have push access. Check network connectivity.",
        ) from e


def push_tag(
    tag: str,
    remote: str = "origin",
    force: bool = False,
    cwd: Path | None = None,
) -> None:
    """Push a specific tag to a remote.

    Args:
        tag: Tag name to push (e.g., "v1.0.12")
        remote: Remote name (default: "origin")
        force: Whether to force push (use with caution)
        cwd: Working directory (defaults to current directory)

    Raises:
        GitError: If push fails or tag doesn't exist
    """
    try:
        # Build push command for specific tag
        cmd = ["git", "push"]
        if force:
            cmd.append("--force")
        cmd.extend([remote, f"refs/tags/{tag}"])

        # Execute push
        run(cmd, cwd=cwd, check=True)

    except Exception as e:
        raise GitError(
            f"Failed to push tag '{tag}' to remote '{remote}'",
            details=str(e),
            fix_hint=f"Ensure tag '{tag}' exists locally. Run 'git tag' to list tags.",
        ) from e


def delete_tag(
    name: str,
    remote: bool = False,
    remote_name: str = "origin",
    cwd: Path | None = None,
) -> None:
    """Delete a git tag locally and/or remotely.

    Args:
        name: Tag name to delete (e.g., "v1.0.12")
        remote: Whether to also delete the tag from remote
        remote_name: Remote name (default: "origin")
        cwd: Working directory (defaults to current directory)

    Raises:
        GitError: If tag deletion fails
    """
    errors = []

    try:
        # Delete local tag
        try:
            # Use list format to safely handle tag names
            run(["git", "tag", "-d", name], cwd=cwd, check=True)
        except Exception as e:
            errors.append(f"Local deletion failed: {e}")

        # Delete remote tag if requested
        if remote:
            try:
                # Use list format for safe remote tag deletion
                run(["git", "push", remote_name, f":refs/tags/{name}"], cwd=cwd, check=True)
            except Exception as e:
                errors.append(f"Remote deletion failed: {e}")

        # Raise error if any deletion failed
        if errors:
            raise GitError(
                f"Failed to delete tag '{name}'",
                details="\n".join(errors),
                fix_hint="Check if the tag exists locally and/or remotely",
            )

    except GitError:
        raise
    except Exception as e:
        raise GitError(
            f"Failed to delete tag '{name}'",
            details=str(e),
            fix_hint=f"Ensure tag '{name}' exists. Run 'git tag' to list tags.",
        ) from e


def fetch(
    remote: str = "origin",
    branch: str | None = None,
    tags: bool = False,
    prune: bool = False,
    cwd: Path | None = None,
) -> None:
    """Fetch updates from a remote repository.

    Args:
        remote: Remote name (default: "origin")
        branch: Specific branch to fetch (None = all branches)
        tags: Whether to fetch tags
        prune: Whether to prune deleted remote branches
        cwd: Working directory (defaults to current directory)

    Raises:
        GitError: If fetch fails
    """
    try:
        # Build fetch command
        cmd = ["git", "fetch"]
        if prune:
            cmd.append("--prune")
        if tags:
            cmd.append("--tags")

        cmd.append(remote)
        if branch:
            cmd.append(branch)

        # Execute fetch
        run(cmd, cwd=cwd, check=True)

    except Exception as e:
        raise GitError(
            f"Failed to fetch from remote '{remote}'",
            details=str(e),
            fix_hint="Ensure remote exists and network is available",
        ) from e


def merge(
    branch: str,
    ff_only: bool = False,
    no_ff: bool = False,
    cwd: Path | None = None,
) -> None:
    """Merge a branch into the current branch.

    Args:
        branch: Branch to merge
        ff_only: Only allow fast-forward merges
        no_ff: Create a merge commit even if fast-forward is possible
        cwd: Working directory (defaults to current directory)

    Raises:
        GitError: If merge fails or conflicts occur
    """
    try:
        # Build merge command
        cmd = ["git", "merge"]
        if ff_only:
            cmd.append("--ff-only")
        elif no_ff:
            cmd.append("--no-ff")

        cmd.append(branch)

        # Execute merge
        run(cmd, cwd=cwd, check=True)

    except Exception as e:
        raise GitError(
            f"Failed to merge branch '{branch}'",
            details=str(e),
            fix_hint="Check for merge conflicts. Run 'git status' to see conflicting files.",
        ) from e


def checkout(
    ref: str,
    create: bool = False,
    cwd: Path | None = None,
) -> None:
    """Checkout a branch, tag, or commit.

    Args:
        ref: Git reference to checkout (branch, tag, or commit SHA)
        create: Whether to create a new branch
        cwd: Working directory (defaults to current directory)

    Raises:
        GitError: If checkout fails
    """
    try:
        # Build checkout command
        cmd = ["git", "checkout"]
        if create:
            cmd.append("-b")
        cmd.append(ref)

        # Execute checkout
        run(cmd, cwd=cwd, check=True)

    except Exception as e:
        action = "create and checkout" if create else "checkout"
        raise GitError(
            f"Failed to {action} '{ref}'",
            details=str(e),
            fix_hint="Ensure the reference exists and working directory is clean",
        ) from e


def reset(
    ref: str = "HEAD",
    hard: bool = False,
    cwd: Path | None = None,
) -> None:
    """Reset the current branch to a specific commit.

    CAUTION: Using hard=True will discard uncommitted changes!

    Args:
        ref: Git reference to reset to (default: HEAD)
        hard: Whether to discard all uncommitted changes
        cwd: Working directory (defaults to current directory)

    Raises:
        GitError: If reset fails
    """
    try:
        # Build reset command
        cmd = ["git", "reset"]
        if hard:
            cmd.append("--hard")
        cmd.append(ref)

        # Execute reset
        run(cmd, cwd=cwd, check=True)

    except Exception as e:
        raise GitError(
            f"Failed to reset to '{ref}'",
            details=str(e),
            fix_hint="Ensure the reference exists",
        ) from e


def stash(
    message: str | None = None,
    include_untracked: bool = False,
    cwd: Path | None = None,
) -> None:
    """Stash uncommitted changes.

    Args:
        message: Stash message (optional)
        include_untracked: Whether to include untracked files
        cwd: Working directory (defaults to current directory)

    Raises:
        GitError: If stash fails
    """
    try:
        # Build stash command
        cmd = ["git", "stash", "push"]
        if include_untracked:
            cmd.append("-u")
        if message:
            cmd.extend(["-m", message])

        # Execute stash
        run(cmd, cwd=cwd, check=True)

    except Exception as e:
        raise GitError(
            "Failed to stash changes",
            details=str(e),
            fix_hint="Ensure you have uncommitted changes to stash",
        ) from e


def stash_pop(cwd: Path | None = None) -> None:
    """Pop the most recent stash.

    Args:
        cwd: Working directory (defaults to current directory)

    Raises:
        GitError: If stash pop fails or no stash exists
    """
    try:
        run(["git", "stash", "pop"], cwd=cwd, check=True)
    except Exception as e:
        raise GitError(
            "Failed to pop stash",
            details=str(e),
            fix_hint="Ensure you have a stash to pop. Run 'git stash list' to check.",
        ) from e
