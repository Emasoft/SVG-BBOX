"""Git state validators for release checks.

Validates git repository state before release:
- Working directory cleanliness
- Branch requirements
- Remote connectivity
- Tag conflicts
"""

from typing import ClassVar

from release.exceptions import GitError
from release.git.queries import (
    get_current_branch,
    get_uncommitted_files,
    has_remote_changes,
    is_clean,
    is_remote_reachable,
    tag_exists,
)
from release.validators.base import (
    ReleaseContext,
    ValidationResult,
    Validator,
    ValidatorRegistry,
)


@ValidatorRegistry.register
class GitCleanValidator(Validator):
    """Validates that the git working directory is clean.

    Ensures no uncommitted changes exist before release to prevent
    releasing code that hasn't been committed to version control.
    """

    name: ClassVar[str] = "git_clean"
    description: ClassVar[str] = "Check if working directory is clean"
    category: ClassVar[str] = "git"

    def should_run(self, context: ReleaseContext) -> bool:
        """Check if this validator should run.

        Args:
            context: Release context

        Returns:
            True if git.require_clean is enabled in config
        """
        return context.config.git.require_clean

    def validate(self, context: ReleaseContext) -> ValidationResult:
        """Validate that working directory is clean.

        Args:
            context: Release context with project root

        Returns:
            ValidationResult indicating if working directory is clean
        """
        try:
            if is_clean(cwd=context.project_root):
                return ValidationResult.success("Working directory is clean")

            # Get list of uncommitted files for detailed message
            uncommitted_files = get_uncommitted_files(cwd=context.project_root)
            file_list = "\n".join(f"  - {f}" for f in uncommitted_files[:10])
            if len(uncommitted_files) > 10:
                file_list += f"\n  ... and {len(uncommitted_files) - 10} more"

            details = f"Uncommitted changes detected:\n{file_list}"

            return ValidationResult.error(
                message="Working directory has uncommitted changes",
                details=details,
                fix_command="git status",
            )
        except GitError as e:
            return ValidationResult.error(
                message="Failed to check git status",
                details=str(e),
                fix_command="git status",
            )


@ValidatorRegistry.register
class GitBranchValidator(Validator):
    """Validates that the current branch is the configured main branch.

    Prevents accidental releases from feature branches or other
    non-main branches.
    """

    name: ClassVar[str] = "git_branch"
    description: ClassVar[str] = "Check if on main branch"
    category: ClassVar[str] = "git"

    def should_run(self, context: ReleaseContext) -> bool:
        """Check if this validator should run.

        Args:
            context: Release context

        Returns:
            True if git.require_main_branch is enabled in config
        """
        return context.config.git.require_main_branch

    def validate(self, context: ReleaseContext) -> ValidationResult:
        """Validate that current branch is the main branch.

        Args:
            context: Release context with project root and config

        Returns:
            ValidationResult indicating if on correct branch
        """
        try:
            current_branch = get_current_branch(cwd=context.project_root)
            expected_branch = context.config.git.main_branch

            if current_branch == expected_branch:
                return ValidationResult.success(f"On main branch: {current_branch}")

            return ValidationResult.error(
                message=f"Not on main branch (expected: {expected_branch}, current: {current_branch})",
                details=f"Releases must be made from the '{expected_branch}' branch",
                fix_command=f"git checkout {expected_branch}",
            )
        except GitError as e:
            return ValidationResult.error(
                message="Failed to determine current branch",
                details=str(e),
                fix_command="git branch --show-current",
            )


@ValidatorRegistry.register
class GitRemoteValidator(Validator):
    """Validates that git remote is configured and reachable.

    Ensures the remote repository is accessible and the local branch
    is synchronized before release.
    """

    name: ClassVar[str] = "git_remote"
    description: ClassVar[str] = "Check remote connectivity and sync status"
    category: ClassVar[str] = "git"

    def validate(self, context: ReleaseContext) -> ValidationResult:
        """Validate remote connectivity and sync status.

        Args:
            context: Release context with project root

        Returns:
            ValidationResult indicating remote status
        """
        try:
            # Check if remote is reachable
            if not is_remote_reachable(cwd=context.project_root):
                return ValidationResult.error(
                    message="Git remote 'origin' is not reachable",
                    details="Cannot connect to remote repository. Check network connection and remote URL.",
                    fix_command="git remote -v",
                )

            # Check if remote has changes we don't have
            try:
                has_changes = has_remote_changes(cwd=context.project_root)
                if has_changes:
                    return ValidationResult.error(
                        message="Local branch is behind remote",
                        details="Remote has commits that you don't have locally. Pull changes before release.",
                        fix_command="git pull",
                    )
            except GitError as e:
                # If we can't determine remote changes (e.g., no tracking branch),
                # treat as a warning rather than an error
                return ValidationResult.warning(
                    message="Unable to check sync status with remote",
                    details=str(e),
                    fix_command="git fetch origin",
                )

            return ValidationResult.success(
                "Remote is reachable and local is up to date"
            )

        except GitError as e:
            return ValidationResult.error(
                message="Failed to check remote status",
                details=str(e),
                fix_command="git remote -v",
            )


@ValidatorRegistry.register
class GitTagValidator(Validator):
    """Validates that the version tag doesn't already exist.

    Prevents attempting to create a release with a tag that
    already exists, which would cause the release to fail.
    """

    name: ClassVar[str] = "git_tag"
    description: ClassVar[str] = "Check if version tag already exists"
    category: ClassVar[str] = "git"

    def validate(self, context: ReleaseContext) -> ValidationResult:
        """Validate that version tag doesn't exist.

        Args:
            context: Release context with version and project root

        Returns:
            ValidationResult indicating if tag exists
        """
        # Need version to check tag
        if context.version is None:
            return ValidationResult.error(
                message="Cannot validate tag: version not set in context",
                details="Version must be determined before checking tags",
            )

        # Construct tag name with prefix
        tag_prefix = context.config.version.tag_prefix
        tag_name = f"{tag_prefix}{context.version}"

        try:
            # Check local tags
            if tag_exists(tag_name, remote=False, cwd=context.project_root):
                return ValidationResult.error(
                    message=f"Git tag '{tag_name}' already exists locally",
                    details=f"Cannot create release: tag {tag_name} already exists. "
                    "Delete the tag or bump version.",
                    fix_command=f"git tag -d {tag_name}",
                )

            # Check remote tags (if remote is reachable)
            if is_remote_reachable(cwd=context.project_root) and tag_exists(
                tag_name, remote=True, cwd=context.project_root
            ):
                return ValidationResult.error(
                    message=f"Git tag '{tag_name}' already exists on remote",
                    details=f"Cannot create release: tag {tag_name} exists on origin. "
                    "Delete the remote tag or bump version.",
                    fix_command=f"git push origin :{tag_name}",
                )

            return ValidationResult.success(f"Tag '{tag_name}' is available")

        except GitError as e:
            return ValidationResult.error(
                message="Failed to check tag existence",
                details=str(e),
                fix_command="git tag -l",
            )
