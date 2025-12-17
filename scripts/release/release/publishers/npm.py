"""npm Registry publisher.

Publishes packages to npm using OIDC trusted publishing.

Features:
- OIDC authentication support (npm 11.5.1+)
- Automatic provenance attestation
- Configurable public/restricted access
- Retry logic for verification
"""

import json
import time
from pathlib import Path
from typing import Any, ClassVar

from release.publishers.base import (
    PublishContext,
    Publisher,
    PublisherRegistry,
    PublishResult,
)
from release.utils.shell import ShellError, run


def get_package_json(project_root: Path) -> dict[str, Any] | None:
    """Parse package.json from project root.

    Args:
        project_root: Path to project root directory

    Returns:
        Parsed package.json dict, or None if not found or invalid
    """
    package_json_path = project_root / "package.json"
    if not package_json_path.exists():
        return None

    try:
        with open(package_json_path, encoding="utf-8") as f:
            data: dict[str, Any] = json.load(f)
            return data
    except (json.JSONDecodeError, OSError):
        return None


def get_package_name(project_root: Path) -> str | None:
    """Get package name from package.json.

    Args:
        project_root: Path to project root directory

    Returns:
        Package name, or None if not found
    """
    package_json = get_package_json(project_root)
    if not package_json:
        return None
    return package_json.get("name")


@PublisherRegistry.register
class NPMPublisher(Publisher):
    """Publisher for npm registry.

    Publishes packages to npmjs.com using npm CLI with OIDC trusted publishing.

    Required npm version: 11.5.1+ for OIDC support
    Required Node.js version: 24+ (ships with npm 11.6.0)

    Configuration:
        npm:
            enabled: true
            access: public  # or 'restricted'
    """

    name: ClassVar[str] = "npm"
    display_name: ClassVar[str] = "npm Registry"
    registry_name: ClassVar[str] = "npmjs.com"

    def publish(self, context: PublishContext) -> PublishResult:
        """Publish package to npm registry.

        In CI with OIDC: npm CLI handles authentication automatically
        Locally: Uses npm token from ~/.npmrc

        Args:
            context: Publish context with version and config

        Returns:
            PublishResult indicating success or failure
        """
        # Check if package.json exists
        package_json_path = context.project_root / "package.json"
        if not package_json_path.exists():
            return PublishResult.failed(
                message="package.json not found",
                details=f"Expected package.json at {package_json_path}",
            )

        # Get package name for URLs
        package_name = get_package_name(context.project_root)
        if not package_name:
            return PublishResult.failed(
                message="Failed to read package name from package.json",
            )

        # Dry run mode - skip actual publish
        if context.dry_run:
            return PublishResult.success(
                message=f"Would publish {package_name}@{context.version} to npm (dry run)",
                registry_url="https://www.npmjs.com",
                package_url=f"https://www.npmjs.com/package/{package_name}",
                version=context.version,
            )

        # Get access configuration (public or restricted)
        access = "public"  # Default
        if hasattr(context.config, "npm") and hasattr(context.config.npm, "access"):
            access = context.config.npm.access

        # Build publish command
        cmd = ["npm", "publish", "--access", access]

        try:
            # Execute npm publish
            result = run(
                cmd,
                cwd=context.project_root,
                capture=True,
                check=True,
                timeout=300,
            )

            if context.verbose:
                print(f"npm publish output:\n{result.stdout}")

            return PublishResult.success(
                message=f"Published {package_name}@{context.version} to npm",
                registry_url="https://www.npmjs.com",
                package_url=f"https://www.npmjs.com/package/{package_name}",
                version=context.version,
            )

        except ShellError as e:
            return PublishResult.failed(
                message=f"npm publish failed: {e.cmd}",
                details=f"Exit code: {e.returncode}\n{e.stderr or e.stdout}",
            )

    def verify(self, context: PublishContext) -> bool:
        """Verify package was published to npm registry.

        Uses retry logic with exponential backoff because npm registry
        propagation can take a few seconds.

        Retry schedule:
        - Attempt 1: Immediate
        - Attempt 2: After 5 seconds
        - Attempt 3: After 10 seconds (total: 15s)
        - Attempt 4: After 20 seconds (total: 35s)

        Args:
            context: Publish context

        Returns:
            True if package@version is visible on npm
        """
        package_name = get_package_name(context.project_root)
        if not package_name:
            return False

        # Retry configuration
        max_attempts = 4
        delays = [0, 5, 10, 20]  # seconds

        for attempt in range(max_attempts):
            if attempt > 0:
                delay = delays[attempt - 1]
                if context.verbose:
                    print(f"Waiting {delay}s before retry {attempt}...")
                time.sleep(delay)

            try:
                # Query npm registry for specific version
                cmd = ["npm", "view", f"{package_name}@{context.version}", "version"]
                result = run(
                    cmd,
                    cwd=context.project_root,
                    capture=True,
                    check=False,  # Don't raise on non-zero exit
                    timeout=30,
                )

                # Success: npm view returns the version
                if result.returncode == 0:
                    published_version = result.stdout.strip()
                    if published_version == context.version:
                        if context.verbose:
                            print(
                                f"Verified {package_name}@{context.version} on npm (attempt {attempt + 1})"
                            )
                        return True

            except ShellError:
                # Command failed - package not yet visible
                pass

        # All retries exhausted
        if context.verbose:
            print(
                f"Failed to verify {package_name}@{context.version} on npm after {max_attempts} attempts"
            )
        return False

    def should_publish(self, context: PublishContext) -> bool:
        """Check if npm publishing should run.

        Requirements:
        - package.json must exist
        - npm must be enabled in config (if config has npm section)

        Args:
            context: Publish context

        Returns:
            True if npm publishing should run
        """
        # Check if package.json exists
        package_json_path = context.project_root / "package.json"
        if not package_json_path.exists():
            return False

        # Check if npm publishing is enabled in config
        if hasattr(context.config, "npm") and hasattr(context.config.npm, "enabled"):
            return bool(context.config.npm.enabled)

        # Default: publish if package.json exists
        return True
