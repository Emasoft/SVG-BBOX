"""Go module proxy publisher.

Triggers indexing on proxy.golang.org and pkg.go.dev after a release.
Go modules are distributed directly from source repositories (GitHub, GitLab),
but this publisher ensures the module is cached and discoverable.
"""

import subprocess
import time
from typing import TYPE_CHECKING

from release.publishers.base import (
    PublishContext,
    Publisher,
    PublisherRegistry,
    PublishResult,
)
from release.utils.shell import run

if TYPE_CHECKING:
    pass


def get_module_path(project_root: str) -> str | None:
    """Extract module path from go.mod.

    Args:
        project_root: Path to project root

    Returns:
        Module path (e.g., 'github.com/user/repo') or None
    """
    from pathlib import Path

    go_mod = Path(project_root) / "go.mod"
    if not go_mod.exists():
        return None

    content = go_mod.read_text()
    for line in content.splitlines():
        line = line.strip()
        if line.startswith("module "):
            # Extract module path, handling quotes if present
            module_path = line[7:].strip().strip('"')
            return module_path
    return None


@PublisherRegistry.register
class GoProxyPublisher(Publisher):
    """Publisher for Go module proxy indexing.

    Triggers caching on proxy.golang.org and documentation
    indexing on pkg.go.dev after a version tag is pushed.
    """

    name = "go"
    display_name = "Go Module Proxy"
    registry_name = "proxy.golang.org"

    def publish(self, context: PublishContext) -> PublishResult:
        """Trigger Go module proxy indexing.

        This requests the module version from proxy.golang.org,
        which causes it to fetch and cache the module from the
        source repository.

        Args:
            context: Publish context with version and config

        Returns:
            PublishResult indicating success/failure
        """
        module_path = get_module_path(str(context.project_root))
        if not module_path:
            return PublishResult.skipped("No go.mod found - not a Go module")

        version = context.version
        if not version.startswith("v"):
            version = f"v{version}"

        module_version = f"{module_path}@{version}"

        if context.dry_run:
            return PublishResult.success(
                message=f"Would trigger proxy indexing for {module_version}",
                registry_url="https://proxy.golang.org",
                package_url=f"https://pkg.go.dev/{module_path}@{version}",
                version=version,
            )

        if context.verbose:
            print(f"Triggering Go proxy indexing for {module_version}...")

        # Method 1: Use go list to trigger proxy fetch
        # This is the most reliable method as it uses the Go toolchain
        try:
            result = run(
                ["go", "list", "-m", module_version],
                cwd=context.project_root,
                check=False,
                timeout=60,
            )

            if result.returncode == 0:
                if context.verbose:
                    print(f"Successfully triggered proxy indexing via go list")
            else:
                # go list might fail if module not yet available, try HTTP method
                if context.verbose:
                    print(f"go list failed, trying HTTP request to proxy...")

        except FileNotFoundError:
            # Go not installed, fall back to HTTP method
            if context.verbose:
                print("Go toolchain not found, using HTTP request to proxy...")

        # Method 2: Direct HTTP request to proxy.golang.org
        # This works even without Go installed
        try:
            import urllib.request
            import urllib.error

            # Request the .info endpoint which triggers caching
            # URL format: https://proxy.golang.org/{module}/@v/{version}.info
            escaped_module = module_path.replace("/", "/")
            proxy_url = f"https://proxy.golang.org/{escaped_module}/@v/{version}.info"

            if context.verbose:
                print(f"Requesting: {proxy_url}")

            req = urllib.request.Request(proxy_url, method="GET")
            req.add_header("User-Agent", "release-tool/1.0")

            with urllib.request.urlopen(req, timeout=30) as response:
                if response.status == 200:
                    if context.verbose:
                        print(f"Proxy returned module info successfully")

        except urllib.error.HTTPError as e:
            if e.code == 404:
                # Module not yet available on proxy - might need more time
                return PublishResult.failed(
                    message=f"Module {module_version} not found on proxy",
                    details=(
                        "The tag may not have been pushed yet, or the proxy "
                        "hasn't indexed it. Wait a few minutes and try again."
                    ),
                )
            return PublishResult.failed(
                message=f"Proxy request failed: HTTP {e.code}",
                details=str(e),
            )
        except urllib.error.URLError as e:
            return PublishResult.failed(
                message="Failed to connect to proxy.golang.org",
                details=str(e),
            )
        except Exception as e:
            return PublishResult.failed(
                message="Unexpected error during proxy indexing",
                details=str(e),
            )

        # Method 3: Trigger pkg.go.dev indexing
        # Request the package page to trigger documentation generation
        try:
            pkg_url = f"https://pkg.go.dev/{module_path}@{version}"

            if context.verbose:
                print(f"Triggering pkg.go.dev indexing: {pkg_url}")

            req = urllib.request.Request(pkg_url, method="GET")
            req.add_header("User-Agent", "release-tool/1.0")

            # Just request the page - pkg.go.dev will queue indexing
            with urllib.request.urlopen(req, timeout=30) as response:
                pass  # Response content not needed

        except Exception:
            # pkg.go.dev indexing is best-effort, don't fail the release
            if context.verbose:
                print("Note: pkg.go.dev indexing request failed (non-fatal)")

        return PublishResult.success(
            message=f"Triggered proxy indexing for {module_version}",
            registry_url="https://proxy.golang.org",
            package_url=f"https://pkg.go.dev/{module_path}@{version}",
            version=version,
        )

    def verify(self, context: PublishContext) -> bool:
        """Verify the module is available on proxy.golang.org.

        Args:
            context: Publish context

        Returns:
            True if module is available on proxy
        """
        module_path = get_module_path(str(context.project_root))
        if not module_path:
            return False

        version = context.version
        if not version.startswith("v"):
            version = f"v{version}"

        import urllib.request
        import urllib.error

        # Retry with exponential backoff (proxy indexing can take time)
        delays = [0, 5, 10, 20]  # Total: 35 seconds max wait

        for i, delay in enumerate(delays):
            if delay > 0:
                if context.verbose:
                    print(f"Waiting {delay}s before retry {i + 1}...")
                time.sleep(delay)

            try:
                proxy_url = f"https://proxy.golang.org/{module_path}/@v/{version}.info"
                req = urllib.request.Request(proxy_url, method="GET")
                req.add_header("User-Agent", "release-tool/1.0")

                with urllib.request.urlopen(req, timeout=15) as response:
                    if response.status == 200:
                        if context.verbose:
                            print(f"Module {module_path}@{version} verified on proxy")
                        return True

            except urllib.error.HTTPError as e:
                if e.code == 404:
                    if context.verbose:
                        print(f"Module not yet available (attempt {i + 1}/{len(delays)})")
                    continue
                if context.verbose:
                    print(f"Proxy check failed: HTTP {e.code}")
                return False
            except Exception as e:
                if context.verbose:
                    print(f"Proxy check error: {e}")
                return False

        return False

    def should_publish(self, context: PublishContext) -> bool:
        """Check if this is a Go module project.

        Args:
            context: Publish context

        Returns:
            True if go.mod exists
        """
        go_mod = context.project_root / "go.mod"
        return go_mod.exists()

    def can_rollback(self) -> bool:
        """Go proxy caching cannot be rolled back.

        Once a module version is cached, it's immutable.
        The checksum database ensures integrity.

        Returns:
            False (proxy caching is immutable)
        """
        return False
