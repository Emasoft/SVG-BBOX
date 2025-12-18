"""PyPI publisher for Python package distribution.

Publishes Python packages to PyPI with trusted publishing (OIDC) support.

Features:
- Multiple build backends (uv, poetry, setuptools/build)
- Trusted publishing (OIDC) in GitHub Actions
- TestPyPI support for testing
- Automatic build tool detection
- Retry logic for verification
"""

import os
import time
from pathlib import Path
from typing import Any, ClassVar

from release.publishers.base import (
    PublishContext,
    Publisher,
    PublisherRegistry,
    PublishResult,
)
from release.utils.shell import ShellError, is_command_available, run


def _parse_toml(path: Path) -> dict[str, Any] | None:
    """Parse a TOML file, using tomllib (Python 3.11+) or tomli fallback.

    Args:
        path: Path to the TOML file

    Returns:
        Parsed TOML data as dict, or None if file not found or invalid
    """
    if not path.exists():
        return None

    try:
        # Python 3.11+ has tomllib in stdlib
        import tomllib

        with open(path, "rb") as f:
            data: dict[str, Any] = tomllib.load(f)
            return data
    except ImportError:
        # Fallback to tomli for Python < 3.11
        try:
            import tomli

            with open(path, "rb") as f:
                data = tomli.load(f)
                return data
        except ImportError:
            # No TOML parser available - read manually for basic fields
            return None
    except (OSError, ValueError):
        return None


def get_pyproject_toml(project_root: Path) -> dict[str, Any] | None:
    """Parse pyproject.toml from project root.

    Args:
        project_root: Path to project root directory

    Returns:
        Parsed pyproject.toml dict, or None if not found or invalid
    """
    pyproject_path = project_root / "pyproject.toml"
    return _parse_toml(pyproject_path)


def get_package_name(project_root: Path) -> str | None:
    """Get package name from pyproject.toml.

    Checks multiple locations where the name might be defined:
    - project.name (PEP 621 standard)
    - tool.poetry.name (Poetry)
    - tool.flit.metadata.module (Flit)

    Args:
        project_root: Path to project root directory

    Returns:
        Package name, or None if not found
    """
    pyproject = get_pyproject_toml(project_root)
    if not pyproject:
        return None

    # PEP 621: project.name (standard location)
    project_section = pyproject.get("project", {})
    if isinstance(project_section, dict) and "name" in project_section:
        name = project_section["name"]
        if isinstance(name, str):
            return name

    # Poetry: tool.poetry.name
    tool_section = pyproject.get("tool", {})
    if isinstance(tool_section, dict):
        poetry = tool_section.get("poetry", {})
        if isinstance(poetry, dict) and "name" in poetry:
            name = poetry["name"]
            if isinstance(name, str):
                return name

        # Flit: tool.flit.metadata.module
        flit = tool_section.get("flit", {})
        if isinstance(flit, dict):
            metadata = flit.get("metadata", {})
            if isinstance(metadata, dict) and "module" in metadata:
                module = metadata["module"]
                if isinstance(module, str):
                    return module

    return None


def get_package_version(project_root: Path) -> str | None:
    """Get package version from pyproject.toml.

    Checks multiple locations:
    - project.version (PEP 621)
    - tool.poetry.version (Poetry)

    Args:
        project_root: Path to project root directory

    Returns:
        Package version, or None if not found or dynamic
    """
    pyproject = get_pyproject_toml(project_root)
    if not pyproject:
        return None

    # PEP 621: project.version
    project_section = pyproject.get("project", {})
    if isinstance(project_section, dict):
        # Check if version is dynamic
        dynamic = project_section.get("dynamic", [])
        if isinstance(dynamic, list) and "version" in dynamic:
            return None  # Dynamic version, can't read statically

        if "version" in project_section:
            version = project_section["version"]
            if isinstance(version, str):
                return version

    # Poetry: tool.poetry.version
    tool_section = pyproject.get("tool", {})
    if isinstance(tool_section, dict):
        poetry = tool_section.get("poetry", {})
        if isinstance(poetry, dict) and "version" in poetry:
            version = poetry["version"]
            if isinstance(version, str):
                return version

    return None


def detect_build_backend(project_root: Path) -> str:
    """Detect the build backend from pyproject.toml.

    Checks [build-system].build-backend to determine which tool to use.

    Args:
        project_root: Path to project root directory

    Returns:
        Build backend name: 'poetry', 'hatchling', 'flit', 'setuptools', or 'unknown'
    """
    pyproject = get_pyproject_toml(project_root)
    if not pyproject:
        return "unknown"

    build_system = pyproject.get("build-system", {})
    if not isinstance(build_system, dict):
        return "unknown"

    backend = build_system.get("build-backend", "")
    if not isinstance(backend, str):
        return "unknown"

    # Map build-backend to tool name
    if "poetry" in backend:
        return "poetry"
    if "hatchling" in backend or "hatch" in backend:
        return "hatchling"
    if "flit" in backend:
        return "flit"
    if "setuptools" in backend:
        return "setuptools"
    if "pdm" in backend:
        return "pdm"
    if "maturin" in backend:
        return "maturin"

    return "unknown"


def is_trusted_publishing() -> bool:
    """Check if running in GitHub Actions with OIDC support.

    Trusted publishing uses OIDC tokens to authenticate with PyPI
    without needing a static API token.

    Returns:
        True if running in GitHub Actions with OIDC environment
    """
    # Check for GitHub Actions environment
    if os.environ.get("GITHUB_ACTIONS") != "true":
        return False

    # Check for OIDC-related environment variables
    # GitHub provides these when id-token: write permission is set
    return bool(os.environ.get("ACTIONS_ID_TOKEN_REQUEST_URL"))


@PublisherRegistry.register
class PyPIPublisher(Publisher):
    """PyPI publisher with trusted publishing support.

    Publishes Python packages to pypi.org using OIDC trusted publishing
    when available, or API token authentication otherwise.

    Supports multiple build backends:
    - uv (recommended, handles OIDC automatically)
    - poetry
    - setuptools with build module
    - twine for upload

    Configuration:
        pypi:
            enabled: true
            repository: pypi  # or 'testpypi'
    """

    name: ClassVar[str] = "pypi"
    display_name: ClassVar[str] = "PyPI"
    registry_name: ClassVar[str] = "pypi.org"

    def publish(self, context: PublishContext) -> PublishResult:
        """Publish package to PyPI.

        In CI with OIDC: uv publish handles authentication automatically.
        Locally: Uses token from ~/.pypirc or environment variable.

        Build and upload sequence:
        1. Detect build backend
        2. Build wheel and sdist
        3. Upload with appropriate tool

        Args:
            context: Publish context with version and config

        Returns:
            PublishResult indicating success or failure
        """
        # Check if pyproject.toml exists
        pyproject_path = context.project_root / "pyproject.toml"
        if not pyproject_path.exists():
            return PublishResult.failed(
                message="pyproject.toml not found",
                details=f"Expected pyproject.toml at {pyproject_path}",
            )

        # Get package name
        package_name = get_package_name(context.project_root)
        if not package_name:
            return PublishResult.failed(
                message="Failed to read package name from pyproject.toml",
                details="Check that project.name or tool.poetry.name is set",
            )

        # Dry run mode - skip actual publish
        if context.dry_run:
            return PublishResult.success(
                message=f"Would publish {package_name}=={context.version} to PyPI (dry run)",
                registry_url="https://pypi.org",
                package_url=f"https://pypi.org/project/{package_name}/",
                version=context.version,
            )

        # Build the package
        build_result = self._build_package(context)
        if build_result.status.value == "failed":
            return build_result

        # Upload the package
        upload_result = self._upload_package(context, package_name)
        if upload_result.status.value == "failed":
            return upload_result

        return PublishResult.success(
            message=f"Published {package_name}=={context.version} to PyPI",
            registry_url="https://pypi.org",
            package_url=f"https://pypi.org/project/{package_name}/{context.version}/",
            version=context.version,
        )

    def _build_package(self, context: PublishContext) -> PublishResult:
        """Build wheel and sdist for the package.

        Tries build tools in order of preference:
        1. uv build (fastest, handles dependencies well)
        2. poetry build (if using poetry backend)
        3. python -m build (standard PEP 517 builder)

        Args:
            context: Publish context

        Returns:
            PublishResult indicating build success or failure
        """
        backend = detect_build_backend(context.project_root)

        # Clean existing dist directory
        dist_dir = context.project_root / "dist"
        if dist_dir.exists():
            for file in dist_dir.iterdir():
                if file.suffix in (".whl", ".tar.gz"):
                    file.unlink()

        # Try uv first (recommended)
        if is_command_available("uv"):
            try:
                result = run(
                    ["uv", "build"],
                    cwd=context.project_root,
                    capture=True,
                    check=True,
                    timeout=300,
                )
                if context.verbose:
                    print(f"uv build output:\n{result.stdout}")
                return PublishResult.success(message="Package built with uv")
            except ShellError as e:
                if context.verbose:
                    print(f"uv build failed: {e}, trying fallback...")
                # Fall through to other methods

        # Try poetry if that's the backend
        if backend == "poetry" and is_command_available("poetry"):
            try:
                result = run(
                    ["poetry", "build"],
                    cwd=context.project_root,
                    capture=True,
                    check=True,
                    timeout=300,
                )
                if context.verbose:
                    print(f"poetry build output:\n{result.stdout}")
                return PublishResult.success(message="Package built with poetry")
            except ShellError as e:
                if context.verbose:
                    print(f"poetry build failed: {e}, trying fallback...")

        # Try python -m build (PEP 517 standard)
        try:
            result = run(
                ["python", "-m", "build"],
                cwd=context.project_root,
                capture=True,
                check=True,
                timeout=300,
            )
            if context.verbose:
                print(f"python -m build output:\n{result.stdout}")
            return PublishResult.success(message="Package built with python -m build")
        except ShellError as e:
            return PublishResult.failed(
                message="Package build failed",
                details=f"Exit code: {e.returncode}\n{e.stderr or e.stdout}",
            )

    def _upload_package(
        self, context: PublishContext, package_name: str
    ) -> PublishResult:
        """Upload built package to PyPI.

        Tries upload tools in order:
        1. uv publish (handles OIDC automatically)
        2. twine upload (standard tool)

        Args:
            context: Publish context
            package_name: Name of the package

        Returns:
            PublishResult indicating upload success or failure
        """
        dist_dir = context.project_root / "dist"

        # Verify dist files exist
        dist_files = list(dist_dir.glob("*.whl")) + list(dist_dir.glob("*.tar.gz"))
        if not dist_files:
            return PublishResult.failed(
                message="No distribution files found",
                details=f"Expected .whl and .tar.gz files in {dist_dir}",
            )

        # Try uv publish first (handles OIDC automatically)
        if is_command_available("uv"):
            try:
                cmd = ["uv", "publish"]

                # In trusted publishing mode, uv handles OIDC automatically
                # No token needed when ACTIONS_ID_TOKEN_REQUEST_URL is set

                result = run(
                    cmd,
                    cwd=context.project_root,
                    capture=True,
                    check=True,
                    timeout=300,
                )
                if context.verbose:
                    print(f"uv publish output:\n{result.stdout}")
                return PublishResult.success(
                    message=f"Uploaded {package_name} with uv publish"
                )
            except ShellError as e:
                if context.verbose:
                    print(f"uv publish failed: {e}, trying twine...")

        # Fall back to twine
        if is_command_available("twine"):
            try:
                cmd = ["twine", "upload", "dist/*"]

                result = run(
                    cmd,
                    cwd=context.project_root,
                    capture=True,
                    check=True,
                    timeout=300,
                )
                if context.verbose:
                    print(f"twine upload output:\n{result.stdout}")
                return PublishResult.success(
                    message=f"Uploaded {package_name} with twine"
                )
            except ShellError as e:
                return PublishResult.failed(
                    message="twine upload failed",
                    details=f"Exit code: {e.returncode}\n{e.stderr or e.stdout}",
                )

        return PublishResult.failed(
            message="No upload tool available",
            details="Install uv or twine: pip install twine",
        )

    def verify(self, context: PublishContext) -> bool:
        """Verify package was published to PyPI.

        Uses retry logic with exponential backoff because PyPI
        propagation can take a few seconds.

        Retry schedule:
        - Attempt 1: Immediate
        - Attempt 2: After 5 seconds
        - Attempt 3: After 10 seconds (total: 15s)
        - Attempt 4: After 20 seconds (total: 35s)

        Args:
            context: Publish context

        Returns:
            True if package@version is visible on PyPI
        """
        package_name = get_package_name(context.project_root)
        if not package_name:
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

            # Try pip index versions first (fastest, local check)
            if self._verify_with_pip(context, package_name):
                if context.verbose:
                    print(
                        f"Verified {package_name}=={context.version} on PyPI (attempt {attempt + 1})"
                    )
                return True

            # Fall back to PyPI JSON API
            if self._verify_with_api(context, package_name):
                if context.verbose:
                    print(
                        f"Verified {package_name}=={context.version} via API (attempt {attempt + 1})"
                    )
                return True

        # All retries exhausted
        if context.verbose:
            print(
                f"Failed to verify {package_name}=={context.version} on PyPI after {max_attempts} attempts"
            )
        return False

    def _verify_with_pip(self, context: PublishContext, package_name: str) -> bool:
        """Verify package using pip index versions command.

        Args:
            context: Publish context
            package_name: Package name to check

        Returns:
            True if version is found
        """
        try:
            # pip index versions shows available versions
            cmd = ["pip", "index", "versions", package_name]
            result = run(
                cmd,
                cwd=context.project_root,
                capture=True,
                check=False,
                timeout=30,
            )

            # Check if our version is in the output
            if result.returncode == 0 and context.version in result.stdout:
                return True

        except ShellError:
            pass

        return False

    def _verify_with_api(self, context: PublishContext, package_name: str) -> bool:
        """Verify package using PyPI JSON API.

        Args:
            context: Publish context
            package_name: Package name to check

        Returns:
            True if version is found in API response
        """
        try:
            # Use curl to query PyPI JSON API
            url = f"https://pypi.org/pypi/{package_name}/{context.version}/json"
            cmd = ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", url]
            result = run(
                cmd,
                cwd=context.project_root,
                capture=True,
                check=False,
                timeout=30,
            )

            # 200 means the version exists
            if result.returncode == 0 and result.stdout.strip() == "200":
                return True

        except ShellError:
            pass

        return False

    def should_publish(self, context: PublishContext) -> bool:
        """Check if PyPI publishing should run.

        Requirements:
        - pyproject.toml must exist
        - pypi must be enabled in config (if config has pypi section)

        Args:
            context: Publish context

        Returns:
            True if PyPI publishing should run
        """
        # Check if pyproject.toml exists
        pyproject_path = context.project_root / "pyproject.toml"
        if not pyproject_path.exists():
            return False

        # Check if pypi publishing is enabled in config
        if hasattr(context.config, "pypi") and hasattr(context.config.pypi, "enabled"):
            return bool(context.config.pypi.enabled)

        # Check project ecosystem - only publish Python projects
        if hasattr(context.config, "project") and hasattr(
            context.config.project, "ecosystem"
        ):
            ecosystem = context.config.project.ecosystem
            if ecosystem not in ("python", "py"):
                return False

        # Default: publish if pyproject.toml exists and ecosystem is python
        return True

    def can_rollback(self) -> bool:
        """Check if rollback is supported.

        PyPI does not allow deletion of published releases.
        Once a version is published, it cannot be removed.
        You can only yank a release (mark it as not recommended).

        Returns:
            False - PyPI releases cannot be rolled back
        """
        return False

    def rollback(self, context: PublishContext) -> PublishResult:
        """Attempt to rollback a published package.

        PyPI does not support deletion. This method could potentially
        yank the release, but yanking is not the same as deletion.

        Args:
            context: Publish context

        Returns:
            PublishResult indicating rollback is not supported
        """
        package_name = get_package_name(context.project_root)
        return PublishResult.skipped(
            f"PyPI does not support release deletion. "
            f"Consider yanking {package_name}=={context.version} manually via PyPI web interface."
        )
