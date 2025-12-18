"""Docker publisher for container image distribution.

Publishes container images to Docker Hub, GitHub Container Registry, or other registries.

Features:
- Docker Hub (docker.io) support
- GitHub Container Registry (ghcr.io) support
- Custom registry support
- Multi-platform builds (linux/amd64, linux/arm64)
- Version tagging (v1.0.0, latest)
- Automatic registry authentication
"""

import os
import time
from pathlib import Path
from typing import ClassVar

from release.publishers.base import (
    PublishContext,
    Publisher,
    PublisherRegistry,
    PublishResult,
)
from release.utils.shell import ShellError, run, run_silent


def get_dockerfile_path(project_root: Path) -> Path | None:
    """Find Dockerfile in project root.

    Checks for Dockerfile in standard locations:
    - Dockerfile (root)
    - docker/Dockerfile
    - .docker/Dockerfile

    Args:
        project_root: Path to project root directory

    Returns:
        Path to Dockerfile if found, None otherwise
    """
    candidates = [
        project_root / "Dockerfile",
        project_root / "docker" / "Dockerfile",
        project_root / ".docker" / "Dockerfile",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


@PublisherRegistry.register
class DockerPublisher(Publisher):
    """Docker publisher for container registries.

    Supports:
    - Docker Hub (docker.io)
    - GitHub Container Registry (ghcr.io)
    - Custom registries
    - Multi-platform builds (linux/amd64, linux/arm64)
    - Version tagging (v1.0.0, latest)

    Configuration:
        docker:
            enabled: true
            registry: ghcr.io  # or docker.io, or custom registry
            image_name: owner/repo  # optional, defaults to repo name
            platforms:
              - linux/amd64
              - linux/arm64
            tag_latest: true  # also tag as :latest
    """

    name: ClassVar[str] = "docker"
    display_name: ClassVar[str] = "Docker Registry"
    registry_name: ClassVar[str] = "docker.io"

    def publish(self, context: PublishContext) -> PublishResult:
        """Build and push Docker image to registry.

        In GitHub Actions with ghcr.io: Uses GITHUB_TOKEN for authentication
        For Docker Hub: Uses DOCKER_USERNAME and DOCKER_TOKEN
        For custom registries: Uses configured credentials

        Args:
            context: Publish context with version and config

        Returns:
            PublishResult indicating success or failure
        """
        # Check if Dockerfile exists
        dockerfile_path = self._get_dockerfile_path(context)
        if not dockerfile_path:
            return PublishResult.failed(
                message="Dockerfile not found",
                details="Expected Dockerfile at project root or in docker/ directory",
            )

        # Get image name and registry configuration
        image_name = self._get_image_name(context)
        registry_url = self._get_registry_url(context)
        full_image = f"{registry_url}/{image_name}" if registry_url else image_name

        # Build tags list
        version_tag = f"{full_image}:{context.version}"
        tags = [version_tag]

        # Add latest tag if configured
        if self._should_tag_latest(context):
            tags.append(f"{full_image}:latest")

        # Dry run mode - skip actual build and push
        if context.dry_run:
            return PublishResult.success(
                message=f"Would build and push {full_image}:{context.version} (dry run)",
                registry_url=f"https://{registry_url}" if registry_url else None,
                package_url=self._get_package_url(context, full_image),
                version=context.version,
            )

        # Authenticate with registry
        login_result = self._login_registry(context)
        if login_result.status.value == "failed":
            return login_result

        # Build and push the image
        build_result = self._build_image(context, dockerfile_path, tags)
        if build_result.status.value == "failed":
            return build_result

        return PublishResult.success(
            message=f"Published {full_image}:{context.version} to Docker registry",
            registry_url=f"https://{registry_url}" if registry_url else None,
            package_url=self._get_package_url(context, full_image),
            version=context.version,
        )

    def verify(self, context: PublishContext) -> bool:
        """Verify image was pushed to registry.

        Uses docker manifest inspect to check if image exists on remote registry.
        Implements retry logic with exponential backoff for registry propagation.

        Retry schedule:
        - Attempt 1: Immediate
        - Attempt 2: After 5 seconds
        - Attempt 3: After 10 seconds (total: 15s)
        - Attempt 4: After 20 seconds (total: 35s)

        Args:
            context: Publish context

        Returns:
            True if image is visible on registry
        """
        image_name = self._get_image_name(context)
        registry_url = self._get_registry_url(context)
        full_image = f"{registry_url}/{image_name}" if registry_url else image_name
        image_with_tag = f"{full_image}:{context.version}"

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
                # Use docker manifest inspect to check remote registry
                cmd = ["docker", "manifest", "inspect", image_with_tag]
                result = run(
                    cmd,
                    cwd=context.project_root,
                    capture=True,
                    check=False,
                    timeout=60,
                )

                if result.returncode == 0:
                    if context.verbose:
                        print(
                            f"Verified {image_with_tag} on registry (attempt {attempt + 1})"
                        )
                    return True

            except ShellError:
                # Command failed - image not yet visible
                pass

        # All retries exhausted
        if context.verbose:
            print(
                f"Failed to verify {image_with_tag} on registry after {max_attempts} attempts"
            )
        return False

    def should_publish(self, context: PublishContext) -> bool:
        """Check if Docker publishing should run.

        Requirements:
        - Dockerfile must exist
        - Docker must be enabled in config (if config has docker section)

        Args:
            context: Publish context

        Returns:
            True if Docker publishing should run
        """
        # Check if Dockerfile exists
        dockerfile_path = self._get_dockerfile_path(context)
        if not dockerfile_path:
            return False

        # Check if docker publishing is enabled in config
        if hasattr(context.config, "docker") and hasattr(
            context.config.docker, "enabled"
        ):
            return bool(context.config.docker.enabled)

        # Default: publish if Dockerfile exists
        return True

    def can_rollback(self) -> bool:
        """Docker supports rollback by deleting tags.

        Returns:
            True - Docker registries support tag deletion
        """
        return True

    def rollback(self, context: PublishContext) -> PublishResult:
        """Delete image tag from registry.

        Note: Tag deletion may not be supported on all registries.
        Docker Hub requires authentication with delete permissions.
        ghcr.io supports tag deletion via API.

        Args:
            context: Publish context

        Returns:
            PublishResult indicating rollback success/failure
        """
        image_name = self._get_image_name(context)
        registry_url = self._get_registry_url(context)
        full_image = f"{registry_url}/{image_name}" if registry_url else image_name
        image_with_tag = f"{full_image}:{context.version}"

        if context.dry_run:
            return PublishResult.success(
                message=f"Would delete {image_with_tag} (dry run)",
            )

        # For ghcr.io, use gh CLI to delete
        if registry_url == "ghcr.io":
            return self._rollback_ghcr(context, image_name)

        # For Docker Hub and others, tag deletion requires API calls
        # Most registries don't support direct deletion via docker CLI
        return PublishResult.skipped(
            message=f"Automatic rollback not supported for {registry_url}. "
            f"Manually delete tag: {image_with_tag}",
        )

    def _get_dockerfile_path(self, context: PublishContext) -> Path | None:
        """Find Dockerfile location.

        Args:
            context: Publish context

        Returns:
            Path to Dockerfile or None
        """
        return get_dockerfile_path(context.project_root)

    def _get_image_name(self, context: PublishContext) -> str:
        """Build image name from config or defaults.

        Priority:
        1. docker.image_name from config
        2. GitHub owner/repo from environment
        3. Project directory name

        Args:
            context: Publish context

        Returns:
            Image name (e.g., 'owner/repo')
        """
        # Check config for explicit image name
        if hasattr(context.config, "docker") and hasattr(
            context.config.docker, "image_name"
        ):
            configured_name: str = context.config.docker.image_name
            if configured_name:
                return configured_name

        # Use GitHub repository info if available
        github_repo = os.environ.get("GITHUB_REPOSITORY")
        if github_repo:
            return github_repo.lower()  # Docker images must be lowercase

        # Fall back to project directory name
        return context.project_root.name.lower()

    def _get_registry_url(self, context: PublishContext) -> str:
        """Get registry URL from config or detect from environment.

        Priority:
        1. docker.registry from config
        2. ghcr.io if in GitHub Actions
        3. docker.io (Docker Hub) as default

        Args:
            context: Publish context

        Returns:
            Registry URL (e.g., 'ghcr.io', 'docker.io')
        """
        # Check config for explicit registry
        if hasattr(context.config, "docker") and hasattr(
            context.config.docker, "registry"
        ):
            configured_registry: str = context.config.docker.registry
            if configured_registry:
                return configured_registry

        # Detect GitHub Actions environment
        if os.environ.get("GITHUB_ACTIONS") == "true":
            return "ghcr.io"

        # Default to Docker Hub
        return "docker.io"

    def _should_tag_latest(self, context: PublishContext) -> bool:
        """Check if image should also be tagged as latest.

        Args:
            context: Publish context

        Returns:
            True if latest tag should be added
        """
        if hasattr(context.config, "docker") and hasattr(
            context.config.docker, "tag_latest"
        ):
            return bool(context.config.docker.tag_latest)
        # Default: tag as latest
        return True

    def _get_platforms(self, context: PublishContext) -> list[str]:
        """Get target platforms for multi-platform build.

        Args:
            context: Publish context

        Returns:
            List of platform strings (e.g., ['linux/amd64', 'linux/arm64'])
        """
        if hasattr(context.config, "docker") and hasattr(
            context.config.docker, "platforms"
        ):
            platforms: list[str] = context.config.docker.platforms
            if platforms:
                return platforms
        # Default: amd64 only for faster builds
        return ["linux/amd64"]

    def _login_registry(self, context: PublishContext) -> PublishResult:
        """Authenticate with Docker registry.

        Handles different authentication methods:
        - ghcr.io: GITHUB_TOKEN
        - docker.io: DOCKER_USERNAME + DOCKER_TOKEN
        - Custom: DOCKER_USERNAME + DOCKER_PASSWORD

        Args:
            context: Publish context

        Returns:
            PublishResult indicating login success/failure
        """
        registry_url = self._get_registry_url(context)

        # GitHub Container Registry
        if registry_url == "ghcr.io":
            token = os.environ.get("GITHUB_TOKEN")
            if not token:
                return PublishResult.failed(
                    message="GITHUB_TOKEN not found",
                    details="Set GITHUB_TOKEN environment variable for ghcr.io authentication",
                )
            actor = os.environ.get("GITHUB_ACTOR", "")
            if not actor:
                return PublishResult.failed(
                    message="GITHUB_ACTOR not found",
                    details="Set GITHUB_ACTOR environment variable for ghcr.io authentication",
                )

            try:
                import subprocess

                # Login using stdin to pipe token to docker login
                cmd = [
                    "docker",
                    "login",
                    registry_url,
                    "-u",
                    actor,
                    "--password-stdin",
                ]
                proc = subprocess.run(
                    cmd,
                    input=token,
                    capture_output=True,
                    text=True,
                    timeout=60,
                    cwd=context.project_root,
                )
                if proc.returncode != 0:
                    return PublishResult.failed(
                        message=f"Failed to login to {registry_url}",
                        details=proc.stderr,
                    )
            except subprocess.TimeoutExpired:
                return PublishResult.failed(
                    message="Docker login timed out",
                )

        # Docker Hub
        elif registry_url == "docker.io":
            username = os.environ.get("DOCKER_USERNAME")
            token = os.environ.get("DOCKER_TOKEN")
            if not username or not token:
                return PublishResult.failed(
                    message="Docker Hub credentials not found",
                    details="Set DOCKER_USERNAME and DOCKER_TOKEN environment variables",
                )

            try:
                import subprocess

                cmd = ["docker", "login", "-u", username, "--password-stdin"]
                proc = subprocess.run(
                    cmd,
                    input=token,
                    capture_output=True,
                    text=True,
                    timeout=60,
                    cwd=context.project_root,
                )
                if proc.returncode != 0:
                    return PublishResult.failed(
                        message="Failed to login to Docker Hub",
                        details=proc.stderr,
                    )
            except subprocess.TimeoutExpired:
                return PublishResult.failed(
                    message="Docker login timed out",
                )

        # Custom registry
        else:
            username = os.environ.get("DOCKER_USERNAME")
            password = os.environ.get("DOCKER_PASSWORD")
            if not username or not password:
                # Skip login if no credentials - might be public or already logged in
                if context.verbose:
                    print(
                        f"No credentials for {registry_url}, attempting without login"
                    )
                return PublishResult.success(message="Skipped login - no credentials")

            try:
                import subprocess

                cmd = [
                    "docker",
                    "login",
                    registry_url,
                    "-u",
                    username,
                    "--password-stdin",
                ]
                proc = subprocess.run(
                    cmd,
                    input=password,
                    capture_output=True,
                    text=True,
                    timeout=60,
                    cwd=context.project_root,
                )
                if proc.returncode != 0:
                    return PublishResult.failed(
                        message=f"Failed to login to {registry_url}",
                        details=proc.stderr,
                    )
            except subprocess.TimeoutExpired:
                return PublishResult.failed(
                    message="Docker login timed out",
                )

        return PublishResult.success(message=f"Logged in to {registry_url}")

    def _build_image(
        self,
        context: PublishContext,
        dockerfile_path: Path,
        tags: list[str],
    ) -> PublishResult:
        """Build and push Docker image.

        Uses docker buildx for multi-platform builds if multiple platforms configured.
        Falls back to regular docker build for single platform.

        Args:
            context: Publish context
            dockerfile_path: Path to Dockerfile
            tags: List of image tags to apply

        Returns:
            PublishResult indicating build success/failure
        """
        platforms = self._get_platforms(context)
        use_buildx = len(platforms) > 1

        # Build tag arguments
        tag_args: list[str] = []
        for tag in tags:
            tag_args.extend(["-t", tag])

        # Determine build context directory (parent of Dockerfile)
        build_context = dockerfile_path.parent

        if use_buildx:
            # Multi-platform build with buildx
            # First ensure buildx builder exists
            if not self._ensure_buildx_builder(context):
                return PublishResult.failed(
                    message="Failed to setup docker buildx builder",
                )

            platform_str = ",".join(platforms)
            cmd = [
                "docker",
                "buildx",
                "build",
                "--platform",
                platform_str,
                "-f",
                str(dockerfile_path),
                *tag_args,
                "--push",
                str(build_context),
            ]
        else:
            # Single platform build and push
            cmd = [
                "docker",
                "build",
                "-f",
                str(dockerfile_path),
                *tag_args,
                str(build_context),
            ]

        try:
            if context.verbose:
                print(f"Building image: {' '.join(cmd)}")

            result = run(
                cmd,
                cwd=context.project_root,
                capture=True,
                check=True,
                timeout=1800,  # 30 minutes for large builds
            )

            if context.verbose and result.stdout:
                print(result.stdout)

            # For single platform, need to push separately
            if not use_buildx:
                for tag in tags:
                    push_result = self._push_image(context, tag)
                    if push_result.status.value == "failed":
                        return push_result

            return PublishResult.success(
                message=f"Built and pushed image with {len(tags)} tags",
            )

        except ShellError as e:
            return PublishResult.failed(
                message="Docker build failed",
                details=f"Exit code: {e.returncode}\n{e.stderr or e.stdout}",
            )

    def _push_image(self, context: PublishContext, tag: str) -> PublishResult:
        """Push a single image tag to registry.

        Args:
            context: Publish context
            tag: Full image tag to push

        Returns:
            PublishResult indicating push success/failure
        """
        try:
            cmd = ["docker", "push", tag]
            if context.verbose:
                print(f"Pushing: {tag}")

            run(
                cmd,
                cwd=context.project_root,
                capture=True,
                check=True,
                timeout=600,  # 10 minutes
            )
            return PublishResult.success(message=f"Pushed {tag}")

        except ShellError as e:
            return PublishResult.failed(
                message=f"Failed to push {tag}",
                details=f"Exit code: {e.returncode}\n{e.stderr or e.stdout}",
            )

    def _ensure_buildx_builder(self, context: PublishContext) -> bool:
        """Ensure docker buildx builder is available.

        Creates a new builder if one doesn't exist for multi-platform builds.

        Args:
            context: Publish context

        Returns:
            True if builder is ready
        """
        # Check if buildx is available
        if not run_silent(["docker", "buildx", "version"], cwd=context.project_root):
            return False

        # Check if a builder exists that supports multi-platform
        result = run(
            ["docker", "buildx", "ls"],
            cwd=context.project_root,
            capture=True,
            check=False,
        )

        # Create builder if needed
        if "docker-container" not in result.stdout:
            try:
                run(
                    ["docker", "buildx", "create", "--use", "--name", "multiplatform"],
                    cwd=context.project_root,
                    capture=True,
                    check=True,
                )
            except ShellError:
                # Builder might already exist, try to use it
                run_silent(
                    ["docker", "buildx", "use", "multiplatform"],
                    cwd=context.project_root,
                )

        return True

    def _get_package_url(self, context: PublishContext, full_image: str) -> str | None:
        """Get URL to view the published package.

        Args:
            context: Publish context
            full_image: Full image name with registry

        Returns:
            URL to package page, or None
        """
        registry_url = self._get_registry_url(context)
        image_name = self._get_image_name(context)

        if registry_url == "ghcr.io":
            # GitHub Container Registry package URL
            return f"https://github.com/{image_name}/pkgs/container/{image_name.split('/')[-1]}"
        elif registry_url == "docker.io":
            # Docker Hub URL
            return f"https://hub.docker.com/r/{image_name}"
        else:
            return None

    def _rollback_ghcr(self, context: PublishContext, image_name: str) -> PublishResult:
        """Rollback by deleting tag from GitHub Container Registry.

        Uses gh CLI to delete the package version.

        Args:
            context: Publish context
            image_name: Image name (owner/repo format)

        Returns:
            PublishResult indicating rollback success/failure
        """
        # Extract package name from image name
        parts = image_name.split("/")
        if len(parts) != 2:
            return PublishResult.failed(
                message=f"Invalid image name format: {image_name}",
                details="Expected format: owner/repo",
            )

        owner, package = parts

        try:
            # Use gh CLI to delete the package version
            cmd = [
                "gh",
                "api",
                "-X",
                "DELETE",
                f"/users/{owner}/packages/container/{package}/versions",
                "-f",
                f"tag={context.version}",
            ]
            run(
                cmd,
                cwd=context.project_root,
                capture=True,
                check=True,
                timeout=60,
            )
            return PublishResult.success(
                message=f"Deleted {image_name}:{context.version} from ghcr.io",
            )
        except ShellError as e:
            return PublishResult.failed(
                message="Failed to delete tag from ghcr.io",
                details=str(e),
            )
