"""Homebrew publisher for formula and cask distribution.

Publishes CLI tools to Homebrew taps (personal or homebrew-core).

Features:
- Formula generation from GitHub releases
- SHA256 checksum calculation from release tarballs
- Personal tap repository management (homebrew-tap)
- Automatic tap repository updates and commits
- Rollback support via git revert
"""

import hashlib
import re
import tempfile
import urllib.request
from pathlib import Path
from typing import Any, ClassVar

from release.exceptions import PublishError
from release.publishers.base import (
    PublishContext,
    Publisher,
    PublisherRegistry,
    PublishResult,
)
from release.utils.shell import ShellError, run


def get_homebrew_config(context: PublishContext) -> dict[str, Any] | None:
    """Extract Homebrew configuration from release config.

    Args:
        context: Publish context with config

    Returns:
        Homebrew config dict, or None if not configured
    """
    config = context.config
    if hasattr(config, "homebrew"):
        homebrew_attr = config.homebrew
        if homebrew_attr is not None:
            # Handle both dict and object-style access
            if isinstance(homebrew_attr, dict):
                return homebrew_attr
            # Convert object to dict if it has __dict__
            if hasattr(homebrew_attr, "__dict__"):
                result: dict[str, Any] = vars(homebrew_attr)
                return result
            return None
    return None


@PublisherRegistry.register
class HomebrewPublisher(Publisher):
    """Homebrew publisher for formula distribution.

    Supports:
    - Personal taps (homebrew-tap repositories)
    - Formula generation from GitHub releases
    - SHA256 checksum calculation
    - Automatic tap repository updates

    Configuration:
        homebrew:
            enabled: true
            tap: "username/tap"  # GitHub repo for tap
            formula_name: "tool-name"  # Name of the formula
            description: "Tool description"
            license: "MIT"
            install_command: 'bin.install "tool-name"'
            test_command: 'system "#{bin}/tool-name", "--version"'
    """

    name: ClassVar[str] = "homebrew"
    display_name: ClassVar[str] = "Homebrew"
    registry_name: ClassVar[str] = "brew.sh"

    def publish(self, context: PublishContext) -> PublishResult:
        """Publish formula to Homebrew tap.

        Workflow:
        1. Calculate SHA256 of release tarball from GitHub
        2. Generate Ruby formula file
        3. Clone/update tap repository
        4. Commit and push formula update

        Args:
            context: Publish context with version and config

        Returns:
            PublishResult indicating success or failure
        """
        homebrew_config = get_homebrew_config(context)
        if not homebrew_config:
            return PublishResult.failed(
                message="Homebrew configuration not found",
                details="Add 'homebrew' section to release config",
            )

        # Extract configuration
        tap = homebrew_config.get("tap")
        formula_name = homebrew_config.get("formula_name")

        if not tap:
            return PublishResult.failed(
                message="Homebrew tap not configured",
                details="Set 'homebrew.tap' in release config (e.g., 'username/tap')",
            )

        if not formula_name:
            return PublishResult.failed(
                message="Formula name not configured",
                details="Set 'homebrew.formula_name' in release config",
            )

        # Get GitHub repo info for tarball URL
        github_repo = self._get_github_repo(context)
        if not github_repo:
            return PublishResult.failed(
                message="GitHub repository not configured",
                details="Homebrew publishing requires GitHub as source for tarballs",
            )

        # Build tarball URL
        tarball_url = (
            f"https://github.com/{github_repo}/archive/refs/tags/"
            f"{context.tag_name}.tar.gz"
        )

        # Dry run mode - skip actual publish
        if context.dry_run:
            return PublishResult.success(
                message=f"Would publish {formula_name}@{context.version} to {tap} (dry run)",
                registry_url="https://brew.sh",
                package_url=f"https://github.com/{tap}",
                version=context.version,
            )

        # Calculate SHA256 of release tarball
        try:
            sha256 = self._get_tarball_sha256(tarball_url)
        except PublishError as e:
            return PublishResult.failed(
                message="Failed to calculate tarball SHA256",
                details=str(e),
            )

        # Generate formula content
        formula_content = self._generate_formula(context, sha256, homebrew_config)

        # Update tap repository
        try:
            tap_path = self._get_tap_path(context, tap)
            formula_path = tap_path / "Formula" / f"{formula_name}.rb"

            # Ensure Formula directory exists
            formula_path.parent.mkdir(parents=True, exist_ok=True)

            # Write formula file
            formula_path.write_text(formula_content, encoding="utf-8")

            # Commit and push
            self._commit_formula(tap_path, formula_name, context.version)

        except (ShellError, OSError) as e:
            return PublishResult.failed(
                message="Failed to update tap repository",
                details=str(e),
            )

        return PublishResult.success(
            message=f"Published {formula_name}@{context.version} to {tap}",
            registry_url="https://brew.sh",
            package_url=f"https://github.com/{tap}",
            version=context.version,
        )

    def verify(self, context: PublishContext) -> bool:
        """Verify formula is accessible via brew info.

        Args:
            context: Publish context

        Returns:
            True if formula is visible via brew
        """
        homebrew_config = get_homebrew_config(context)
        if not homebrew_config:
            return False

        tap = homebrew_config.get("tap")
        formula_name = homebrew_config.get("formula_name")

        if not tap or not formula_name:
            return False

        # Try to get info about the formula from the tap
        full_formula = f"{tap}/{formula_name}"

        try:
            result = run(
                ["brew", "info", full_formula],
                capture=True,
                check=False,
                timeout=60,
            )

            # Check if command succeeded and version appears in output
            if result.returncode == 0 and context.version in result.stdout:
                if context.verbose:
                    print(f"Verified {full_formula}@{context.version} in Homebrew")
                return True

        except ShellError:
            pass

        if context.verbose:
            print(f"Failed to verify {full_formula}@{context.version}")
        return False

    def should_publish(self, context: PublishContext) -> bool:
        """Check if Homebrew publishing should run.

        Requirements:
        - Homebrew config must exist in release config
        - Homebrew publishing must be enabled

        Args:
            context: Publish context

        Returns:
            True if Homebrew publishing should run
        """
        homebrew_config = get_homebrew_config(context)
        if not homebrew_config:
            return False

        # Check if explicitly enabled/disabled
        enabled = homebrew_config.get("enabled", True)
        return bool(enabled)

    def can_rollback(self) -> bool:
        """Check if rollback is supported.

        Homebrew supports rollback by reverting the formula commit.

        Returns:
            True - rollback is supported
        """
        return True

    def rollback(self, context: PublishContext) -> PublishResult:
        """Rollback formula update in tap repository.

        Reverts the most recent formula commit and force-pushes.

        Args:
            context: Publish context

        Returns:
            PublishResult indicating rollback success/failure
        """
        homebrew_config = get_homebrew_config(context)
        if not homebrew_config:
            return PublishResult.failed(
                message="Homebrew configuration not found for rollback",
            )

        tap = homebrew_config.get("tap")
        formula_name = homebrew_config.get("formula_name")

        if not tap or not formula_name:
            return PublishResult.failed(
                message="Missing tap or formula_name for rollback",
            )

        try:
            tap_path = self._get_tap_path(context, tap)

            # Revert the last commit (formula update)
            run(
                ["git", "revert", "--no-edit", "HEAD"],
                cwd=tap_path,
                capture=True,
                check=True,
            )

            # Push the revert
            run(
                ["git", "push", "origin", "main"],
                cwd=tap_path,
                capture=True,
                check=True,
            )

            return PublishResult.success(
                message=f"Rolled back {formula_name} formula update",
                version=context.version,
            )

        except ShellError as e:
            return PublishResult.failed(
                message="Failed to rollback formula",
                details=str(e),
            )

    def _get_tarball_sha256(self, url: str) -> str:
        """Download and calculate SHA256 hash of release tarball.

        Args:
            url: URL to the release tarball

        Returns:
            Hex-encoded SHA256 hash

        Raises:
            PublishError: If download or hashing fails
        """
        try:
            # Download tarball to temp file
            with tempfile.NamedTemporaryFile(delete=True) as tmp_file:
                with urllib.request.urlopen(url, timeout=120) as response:
                    sha256_hash = hashlib.sha256()
                    while chunk := response.read(8192):
                        sha256_hash.update(chunk)
                        tmp_file.write(chunk)

                return sha256_hash.hexdigest()

        except urllib.error.URLError as e:
            raise PublishError(
                message=f"Failed to download tarball from {url}",
                details=str(e),
            ) from e
        except OSError as e:
            raise PublishError(
                message="Failed to calculate SHA256",
                details=str(e),
            ) from e

    def _generate_formula(
        self,
        context: PublishContext,
        sha256: str,
        config: dict[str, Any],
    ) -> str:
        """Generate Ruby formula content for Homebrew.

        Args:
            context: Publish context
            sha256: SHA256 hash of the release tarball
            config: Homebrew configuration dict

        Returns:
            Ruby formula file content
        """
        # Extract config values with defaults
        formula_name = config.get("formula_name", "")
        description = config.get("description", "A CLI tool")
        license_name = config.get("license", "MIT")
        install_command = config.get(
            "install_command",
            f'bin.install "{formula_name}"',
        )
        test_command = config.get(
            "test_command",
            f'system "#{{bin}}/{formula_name}", "--version"',
        )
        dependencies = config.get("dependencies", [])
        head_url = config.get("head_url")

        # Get GitHub repo for URLs
        github_repo = self._get_github_repo(context)
        homepage = f"https://github.com/{github_repo}" if github_repo else ""
        tarball_url = (
            f"https://github.com/{github_repo}/archive/refs/tags/"
            f"{context.tag_name}.tar.gz"
        )

        # Convert formula name to Ruby class name (CamelCase)
        class_name = self._to_class_name(formula_name)

        # Build formula
        lines = [
            f"class {class_name} < Formula",
            f'  desc "{description}"',
            f'  homepage "{homepage}"',
            f'  url "{tarball_url}"',
            f'  sha256 "{sha256}"',
            f'  license "{license_name}"',
        ]

        # Add head section if configured
        if head_url:
            lines.append(f'  head "{head_url}"')

        lines.append("")

        # Add dependencies
        for dep in dependencies:
            if isinstance(dep, dict):
                dep_name = dep.get("name", "")
                dep_type = dep.get("type", "")
                if dep_type == "build":
                    lines.append(f'  depends_on "{dep_name}" => :build')
                elif dep_type == "test":
                    lines.append(f'  depends_on "{dep_name}" => :test')
                else:
                    lines.append(f'  depends_on "{dep_name}"')
            else:
                lines.append(f'  depends_on "{dep}"')

        if dependencies:
            lines.append("")

        # Install block
        lines.extend(
            [
                "  def install",
                f"    {install_command}",
                "  end",
                "",
            ]
        )

        # Test block
        lines.extend(
            [
                "  test do",
                f"    {test_command}",
                "  end",
                "end",
                "",
            ]
        )

        return "\n".join(lines)

    def _get_tap_path(self, context: PublishContext, tap: str) -> Path:
        """Get or clone the tap repository path.

        Args:
            context: Publish context
            tap: Tap identifier (e.g., "username/tap")

        Returns:
            Path to the local tap repository

        Raises:
            ShellError: If git operations fail
        """
        # Standard Homebrew tap location
        tap_parts = tap.split("/")
        if len(tap_parts) != 2:
            raise ShellError(
                cmd="parse_tap",
                returncode=1,
                stdout="",
                stderr=f"Invalid tap format: {tap}. Expected 'username/tap'",
            )

        username, tap_name = tap_parts

        # Check if using standard Homebrew prefix
        homebrew_prefix = Path("/usr/local/Homebrew")
        if not homebrew_prefix.exists():
            homebrew_prefix = Path("/opt/homebrew")

        tap_path = (
            homebrew_prefix / "Library" / "Taps" / username / f"homebrew-{tap_name}"
        )

        # If tap exists, update it
        if tap_path.exists():
            run(
                ["git", "fetch", "origin"],
                cwd=tap_path,
                capture=True,
                check=True,
            )
            run(
                ["git", "reset", "--hard", "origin/main"],
                cwd=tap_path,
                capture=True,
                check=True,
            )
            return tap_path

        # Clone the tap using brew tap command
        run(
            ["brew", "tap", tap],
            capture=True,
            check=True,
            timeout=120,
        )

        # Verify tap path now exists
        if not tap_path.exists():
            raise ShellError(
                cmd=f"brew tap {tap}",
                returncode=1,
                stdout="",
                stderr=f"Tap path not found after brew tap: {tap_path}",
            )

        return tap_path

    def _commit_formula(
        self,
        tap_path: Path,
        formula_name: str,
        version: str,
    ) -> None:
        """Commit and push formula update to tap repository.

        Args:
            tap_path: Path to the tap repository
            formula_name: Name of the formula
            version: Version being released

        Raises:
            ShellError: If git operations fail
        """
        formula_file = f"Formula/{formula_name}.rb"

        # Stage the formula file
        run(
            ["git", "add", formula_file],
            cwd=tap_path,
            capture=True,
            check=True,
        )

        # Check if there are changes to commit
        result = run(
            ["git", "diff", "--cached", "--quiet"],
            cwd=tap_path,
            capture=True,
            check=False,
        )

        if result.returncode == 0:
            # No changes - formula is already up to date
            return

        # Commit the changes
        commit_message = f"{formula_name} {version}"
        run(
            ["git", "commit", "-m", commit_message],
            cwd=tap_path,
            capture=True,
            check=True,
        )

        # Push to origin
        run(
            ["git", "push", "origin", "main"],
            cwd=tap_path,
            capture=True,
            check=True,
        )

    def _get_github_repo(self, context: PublishContext) -> str | None:
        """Extract GitHub repository from config.

        Args:
            context: Publish context

        Returns:
            GitHub repo string (owner/repo), or None
        """
        config = context.config

        # Try github config section
        if hasattr(config, "github"):
            github_attr = config.github
            if github_attr is not None:
                if isinstance(github_attr, dict):
                    repo = github_attr.get("repository")
                    if repo:
                        return str(repo)
                elif hasattr(github_attr, "repository"):
                    repo = github_attr.repository
                    if repo:
                        return str(repo)

        # Try project section
        if hasattr(config, "project"):
            project_attr = config.project
            if project_attr is not None:
                if isinstance(project_attr, dict):
                    repo = project_attr.get("repository")
                    if repo:
                        return str(repo)
                elif hasattr(project_attr, "repository"):
                    repo = project_attr.repository
                    if repo:
                        return str(repo)

        return None

    def _to_class_name(self, formula_name: str) -> str:
        """Convert formula name to Ruby class name.

        Homebrew convention: hyphens become CamelCase
        e.g., "my-tool" -> "MyTool"

        Args:
            formula_name: Hyphenated formula name

        Returns:
            CamelCase class name
        """
        # Split on hyphens and underscores
        parts = re.split(r"[-_]", formula_name)
        # Capitalize each part and join
        return "".join(part.capitalize() for part in parts)
