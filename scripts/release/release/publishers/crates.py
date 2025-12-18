"""crates.io publisher for Rust crate distribution.

Publishes Rust crates to crates.io registry.

Features:
- cargo publish with token authentication
- Workspace publishing (publish members in dependency order)
- Dry-run mode support
- Yank support for partial rollback
"""

import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, ClassVar

from release.publishers.base import (
    PublishContext,
    Publisher,
    PublisherRegistry,
    PublishResult,
)
from release.utils.shell import ShellError, run


def parse_cargo_toml(project_root: Path) -> dict[str, Any] | None:
    """Parse Cargo.toml from project root using cargo metadata.

    Uses `cargo metadata` for reliable parsing instead of manually
    parsing TOML, which handles workspace inheritance correctly.

    Args:
        project_root: Path to project root directory

    Returns:
        Parsed metadata dict, or None if not found or invalid
    """
    cargo_toml_path = project_root / "Cargo.toml"
    if not cargo_toml_path.exists():
        return None

    try:
        # Use cargo metadata for reliable parsing
        result = run(
            ["cargo", "metadata", "--format-version=1", "--no-deps"],
            cwd=project_root,
            capture=True,
            check=True,
            timeout=60,
        )
        data: dict[str, Any] = json.loads(result.stdout)
        return data
    except (json.JSONDecodeError, ShellError):
        return None


def get_crate_name(project_root: Path) -> str | None:
    """Get crate name from Cargo.toml.

    Args:
        project_root: Path to project root directory

    Returns:
        Crate name, or None if not found
    """
    metadata = parse_cargo_toml(project_root)
    if not metadata:
        return None

    # cargo metadata returns packages array
    packages = metadata.get("packages", [])
    if not packages:
        return None

    # For single-crate projects, return the first package name
    # For workspaces, this returns the root package if one exists
    name: str | None = packages[0].get("name")
    return name


def is_publishable(project_root: Path) -> bool:
    """Check if crate is configured for publishing.

    Crates are publishable unless they have `publish = false` in Cargo.toml.

    Args:
        project_root: Path to project root directory

    Returns:
        True if crate can be published to crates.io
    """
    metadata = parse_cargo_toml(project_root)
    if not metadata:
        return False

    packages = metadata.get("packages", [])
    if not packages:
        return False

    # Check if root package is publishable
    root_package = packages[0]
    # Publish field: null/missing = publishable, [] = not publishable
    publish = root_package.get("publish")
    if publish is None:
        return True
    # Empty list means not publishable, anything else is publishable
    return not (isinstance(publish, list) and len(publish) == 0)


def get_workspace_members(project_root: Path) -> list[dict[str, Any]]:
    """Get workspace member packages in dependency order.

    For workspace projects, returns all member packages sorted
    by their dependencies (packages with fewer deps first).

    Args:
        project_root: Path to project root directory

    Returns:
        List of package metadata dicts in publish order
    """
    metadata = parse_cargo_toml(project_root)
    if not metadata:
        return []

    packages = metadata.get("packages", [])
    workspace_members = metadata.get("workspace_members", [])

    # Filter to only workspace members
    member_packages = [pkg for pkg in packages if pkg.get("id") in workspace_members]

    # Sort by dependency count (simple heuristic for publish order)
    def dep_count(pkg: dict[str, Any]) -> int:
        return len(pkg.get("dependencies", []))

    return sorted(member_packages, key=dep_count)


@PublisherRegistry.register
class CratesPublisher(Publisher):
    """crates.io publisher for Rust crates.

    Supports:
    - cargo publish
    - Workspace publishing (publish members in dependency order)
    - Dry-run mode
    - Token authentication via CARGO_REGISTRY_TOKEN

    Configuration:
        crates:
            enabled: true
            allow_dirty: false  # Allow publishing with uncommitted changes
    """

    name: ClassVar[str] = "crates"
    display_name: ClassVar[str] = "crates.io"
    registry_name: ClassVar[str] = "crates.io"

    def _get_crate_name(self, context: PublishContext) -> str | None:
        """Get crate name from Cargo.toml.

        Args:
            context: Publish context

        Returns:
            Crate name or None if not found
        """
        return get_crate_name(context.project_root)

    def _is_publishable(self, context: PublishContext) -> bool:
        """Check if crate has publish = true in Cargo.toml.

        Args:
            context: Publish context

        Returns:
            True if crate is configured for publishing
        """
        return is_publishable(context.project_root)

    def _get_workspace_members(self, context: PublishContext) -> list[dict[str, Any]]:
        """Get workspace crates in dependency order.

        Args:
            context: Publish context

        Returns:
            List of package metadata in publish order
        """
        return get_workspace_members(context.project_root)

    def _yank_version(self, context: PublishContext, crate_name: str) -> PublishResult:
        """Yank a published version from crates.io.

        Yanking makes a version unavailable for new dependencies
        but allows existing lockfiles to continue working.

        Args:
            context: Publish context
            crate_name: Name of the crate to yank

        Returns:
            PublishResult indicating success or failure
        """
        cmd = ["cargo", "yank", "--version", context.version, crate_name]

        try:
            run(
                cmd,
                cwd=context.project_root,
                capture=True,
                check=True,
                timeout=120,
            )
            return PublishResult.success(
                message=f"Yanked {crate_name}@{context.version} from crates.io",
                registry_url="https://crates.io",
                package_url=f"https://crates.io/crates/{crate_name}/{context.version}",
                version=context.version,
            )
        except ShellError as e:
            return PublishResult.failed(
                message=f"Failed to yank {crate_name}@{context.version}",
                details=f"Exit code: {e.returncode}\n{e.stderr or e.stdout}",
            )

    def publish(self, context: PublishContext) -> PublishResult:
        """Publish crate to crates.io registry.

        Uses cargo publish with token from CARGO_REGISTRY_TOKEN env var.

        Args:
            context: Publish context with version and config

        Returns:
            PublishResult indicating success or failure
        """
        # Check if Cargo.toml exists
        cargo_toml_path = context.project_root / "Cargo.toml"
        if not cargo_toml_path.exists():
            return PublishResult.failed(
                message="Cargo.toml not found",
                details=f"Expected Cargo.toml at {cargo_toml_path}",
            )

        # Get crate name for URLs
        crate_name = self._get_crate_name(context)
        if not crate_name:
            return PublishResult.failed(
                message="Failed to read crate name from Cargo.toml",
            )

        # Check if publishable
        if not self._is_publishable(context):
            return PublishResult.skipped(
                f"Crate {crate_name} has publish = false in Cargo.toml"
            )

        # Dry run mode - skip actual publish
        if context.dry_run:
            # Run cargo publish --dry-run to validate
            cmd = ["cargo", "publish", "--dry-run"]
            try:
                run(
                    cmd,
                    cwd=context.project_root,
                    capture=True,
                    check=True,
                    timeout=300,
                )
                return PublishResult.success(
                    message=f"Would publish {crate_name}@{context.version} to crates.io (dry run)",
                    registry_url="https://crates.io",
                    package_url=f"https://crates.io/crates/{crate_name}",
                    version=context.version,
                )
            except ShellError as e:
                return PublishResult.failed(
                    message=f"Dry run failed for {crate_name}",
                    details=f"Exit code: {e.returncode}\n{e.stderr or e.stdout}",
                )

        # Check for workspace members
        workspace_members = self._get_workspace_members(context)
        if len(workspace_members) > 1:
            # Publish workspace members in dependency order
            return self._publish_workspace(context, workspace_members)

        # Build publish command for single crate
        cmd = ["cargo", "publish"]

        # Check if allow_dirty is enabled
        allow_dirty = False
        if hasattr(context.config, "crates") and hasattr(
            context.config.crates, "allow_dirty"
        ):
            allow_dirty = bool(context.config.crates.allow_dirty)

        if allow_dirty:
            cmd.append("--allow-dirty")

        try:
            # Execute cargo publish
            result = run(
                cmd,
                cwd=context.project_root,
                capture=True,
                check=True,
                timeout=600,
            )

            if context.verbose:
                print(f"cargo publish output:\n{result.stdout}")

            return PublishResult.success(
                message=f"Published {crate_name}@{context.version} to crates.io",
                registry_url="https://crates.io",
                package_url=f"https://crates.io/crates/{crate_name}/{context.version}",
                version=context.version,
            )

        except ShellError as e:
            return PublishResult.failed(
                message=f"cargo publish failed: {e.cmd}",
                details=f"Exit code: {e.returncode}\n{e.stderr or e.stdout}",
            )

    def _publish_workspace(
        self, context: PublishContext, members: list[dict[str, Any]]
    ) -> PublishResult:
        """Publish workspace members in dependency order.

        Args:
            context: Publish context
            members: List of workspace member packages in publish order

        Returns:
            PublishResult indicating success or failure
        """
        published: list[str] = []

        for pkg in members:
            name = pkg.get("name", "unknown")

            # Skip non-publishable packages
            publish = pkg.get("publish")
            if isinstance(publish, list) and len(publish) == 0:
                if context.verbose:
                    print(f"Skipping {name} (publish = false)")
                continue

            # Build command for this package
            cmd = ["cargo", "publish", "--package", name]

            # Check if allow_dirty is enabled
            allow_dirty = False
            if hasattr(context.config, "crates") and hasattr(
                context.config.crates, "allow_dirty"
            ):
                allow_dirty = bool(context.config.crates.allow_dirty)

            if allow_dirty:
                cmd.append("--allow-dirty")

            try:
                if context.verbose:
                    print(f"Publishing {name}...")

                run(
                    cmd,
                    cwd=context.project_root,
                    capture=True,
                    check=True,
                    timeout=600,
                )
                published.append(name)

                # Wait briefly between publishes for index updates
                if pkg != members[-1]:
                    time.sleep(5)

            except ShellError as e:
                # Rollback by yanking already published crates
                if published:
                    for yanked_name in published:
                        self._yank_version(context, yanked_name)

                return PublishResult.failed(
                    message=f"Failed to publish {name} in workspace",
                    details=f"Exit code: {e.returncode}\n{e.stderr or e.stdout}\nYanked: {', '.join(published)}",
                )

        # Include published crates list in message since success() has no details param
        published_list = ", ".join(published)
        return PublishResult.success(
            message=f"Published {len(published)} crates to crates.io: {published_list}",
            registry_url="https://crates.io",
            version=context.version,
        )

    def verify(self, context: PublishContext) -> bool:
        """Verify crate was published to crates.io registry.

        Uses crates.io API with retry logic since index propagation
        can take a few seconds.

        Retry schedule:
        - Attempt 1: Immediate
        - Attempt 2: After 5 seconds
        - Attempt 3: After 10 seconds (total: 15s)
        - Attempt 4: After 20 seconds (total: 35s)

        Args:
            context: Publish context

        Returns:
            True if crate@version is visible on crates.io
        """
        crate_name = self._get_crate_name(context)
        if not crate_name:
            return False

        # Retry configuration
        max_attempts = 4
        delays = [0, 5, 10, 20]  # seconds

        for attempt in range(max_attempts):
            if attempt > 0:
                delay = delays[attempt]
                if context.verbose:
                    print(f"Waiting {delay}s before retry {attempt + 1}...")
                time.sleep(delay)

            try:
                # Query crates.io API for specific version
                api_url = (
                    f"https://crates.io/api/v1/crates/{crate_name}/{context.version}"
                )

                req = urllib.request.Request(
                    api_url,
                    headers={"User-Agent": "release-tool/1.0"},
                )

                with urllib.request.urlopen(req, timeout=30) as response:
                    if response.status == 200:
                        data = json.loads(response.read().decode("utf-8"))
                        version_info = data.get("version", {})
                        published_version = version_info.get("num")

                        if published_version == context.version:
                            if context.verbose:
                                print(
                                    f"Verified {crate_name}@{context.version} on crates.io "
                                    f"(attempt {attempt + 1})"
                                )
                            return True

            except urllib.error.HTTPError as e:
                # 404 means version not yet visible, log other errors
                if e.code != 404 and context.verbose:
                    print(f"API error: {e.code}")
            except urllib.error.URLError:
                # Network error - continue retrying
                pass
            except json.JSONDecodeError:
                # Invalid response - continue retrying
                pass

        # All retries exhausted
        if context.verbose:
            print(
                f"Failed to verify {crate_name}@{context.version} on crates.io "
                f"after {max_attempts} attempts"
            )
        return False

    def should_publish(self, context: PublishContext) -> bool:
        """Check if crates.io publishing should run.

        Requirements:
        - Cargo.toml must exist
        - Crate must be publishable (publish != false)
        - crates must be enabled in config (if config has crates section)

        Args:
            context: Publish context

        Returns:
            True if crates.io publishing should run
        """
        # Check if Cargo.toml exists
        cargo_toml_path = context.project_root / "Cargo.toml"
        if not cargo_toml_path.exists():
            return False

        # Check if crate is publishable
        if not self._is_publishable(context):
            return False

        # Check if crates publishing is enabled in config
        if hasattr(context.config, "crates") and hasattr(
            context.config.crates, "enabled"
        ):
            return bool(context.config.crates.enabled)

        # Default: publish if Cargo.toml exists and is publishable
        return True

    def can_rollback(self) -> bool:
        """Check if this publisher supports rollback.

        crates.io is immutable - published versions cannot be deleted.
        Only yanking is supported, which is a partial rollback.

        Returns:
            False (full rollback not supported)
        """
        return False

    def rollback(self, context: PublishContext) -> PublishResult:
        """Attempt to rollback by yanking the published version.

        Note: This is a partial rollback. Yanking makes a version
        unavailable for new dependencies but existing lockfiles
        will still work.

        Args:
            context: Publish context

        Returns:
            PublishResult indicating yank success/failure
        """
        crate_name = self._get_crate_name(context)
        if not crate_name:
            return PublishResult.failed(
                message="Cannot rollback: unable to determine crate name"
            )

        return self._yank_version(context, crate_name)
