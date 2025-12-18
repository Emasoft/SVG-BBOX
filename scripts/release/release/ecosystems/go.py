"""Go ecosystem implementation for package management.

Supports go modules with workspace support.
"""

import re
from pathlib import Path

from release.ecosystems.base import Ecosystem, EcosystemRegistry
from release.exceptions import EcosystemError
from release.utils.shell import ShellError, run


@EcosystemRegistry.register
class GoEcosystem(Ecosystem):
    """Go ecosystem with modules support.

    Handles single modules and go workspaces.
    Go modules use git tags for versioning (e.g., v1.0.0).
    A VERSION file can optionally store the current version.
    """

    name = "go"
    display_name = "Go"
    config_files = ["go.mod"]
    lock_files = ["go.sum"]

    def detect(self) -> bool:
        """Detect if project uses Go modules.

        Returns:
            True if go.mod exists in project root
        """
        go_mod = self.project_root / "go.mod"
        return go_mod.exists()

    def get_version(self) -> str:
        """Get current version from VERSION file or git tags.

        Go modules conventionally use git tags for versioning.
        If a VERSION file exists, it takes precedence.
        Otherwise, returns the latest git tag matching vX.Y.Z pattern.

        Returns:
            Version string (e.g., "1.0.0" without the v prefix)

        Raises:
            EcosystemError: If version cannot be determined
        """
        version_file = self.project_root / "VERSION"

        # Strategy 1: Check VERSION file
        if version_file.exists():
            try:
                content = version_file.read_text(encoding="utf-8").strip()
                # Remove v prefix if present
                if content.startswith("v"):
                    content = content[1:]
                if self._is_valid_semver(content):
                    return content
            except OSError as e:
                raise EcosystemError(
                    "Failed to read VERSION file",
                    details=str(e),
                ) from e

        # Strategy 2: Get latest git tag
        try:
            result = run(
                ["git", "describe", "--tags", "--abbrev=0"],
                cwd=self.project_root,
                capture=True,
                check=True,
            )
            tag = result.stdout.strip()
            # Remove v prefix if present
            version = tag[1:] if tag.startswith("v") else tag
            if self._is_valid_semver(version):
                return version
        except ShellError:
            pass  # No git tags found, fall through

        # Strategy 3: Default to 0.0.0
        return "0.0.0"

    def set_version(self, version: str) -> None:
        """Set version in VERSION file.

        Go modules use git tags for actual versioning, but a VERSION file
        provides a convenient way to track the intended next version.
        The release process creates the corresponding git tag.

        Args:
            version: New version string (e.g., "1.0.1")

        Raises:
            EcosystemError: If VERSION file cannot be written
        """
        if not self._is_valid_semver(version):
            raise EcosystemError(
                f"Invalid version format: {version}",
                details="Version must be in semver format (X.Y.Z)",
                fix_hint="Use a valid semantic version like 1.0.0",
            )

        version_file = self.project_root / "VERSION"

        try:
            # Write version with v prefix (Go convention)
            version_file.write_text(f"v{version}\n", encoding="utf-8")
        except OSError as e:
            raise EcosystemError(
                f"Failed to write VERSION file: {version}",
                details=str(e),
            ) from e

    def get_package_manager(self) -> str:
        """Get the package manager for Go.

        Go has a single built-in package manager.

        Returns:
            Always returns "go"
        """
        return "go"

    def run_script(self, script_name: str) -> None:
        """Run a Go command.

        Maps common script names to go commands:
        - build: go build ./...
        - test: go test ./...
        - lint: golangci-lint run (if available)
        - fmt: go fmt ./...
        - vet: go vet ./...
        - mod: go mod tidy

        Args:
            script_name: Script/command name to run

        Raises:
            EcosystemError: If command fails or is unknown
        """
        script_map: dict[str, list[str]] = {
            "build": ["go", "build", "./..."],
            "test": ["go", "test", "./..."],
            "fmt": ["go", "fmt", "./..."],
            "vet": ["go", "vet", "./..."],
            "mod": ["go", "mod", "tidy"],
            "lint": ["golangci-lint", "run"],
        }

        cmd = script_map.get(script_name)
        if cmd is None:
            available = ", ".join(sorted(script_map.keys()))
            raise EcosystemError(
                f"Unknown Go script: {script_name}",
                details=f"Available scripts: {available}",
                fix_hint="Use one of the predefined Go commands",
            )

        try:
            run(cmd, cwd=self.project_root, capture=False)
        except ShellError as e:
            raise EcosystemError(
                f"Go command '{script_name}' failed",
                details=str(e),
                fix_hint=f"Fix issues reported by 'go {script_name}'",
            ) from e

    def has_script(self, script_name: str) -> bool:
        """Check if a Go script/command is available.

        Args:
            script_name: Script name to check

        Returns:
            True if the script is a known Go command
        """
        known_scripts = {"build", "test", "fmt", "vet", "mod", "lint"}
        return script_name in known_scripts

    def get_available_scripts(self) -> list[str]:
        """Get list of available Go commands.

        Returns:
            List of available script names
        """
        return ["build", "test", "fmt", "vet", "mod", "lint"]

    def get_module_path(self) -> str:
        """Parse module path from go.mod.

        The module path is the first line: "module github.com/user/repo"

        Returns:
            Module path (e.g., "github.com/user/repo")

        Raises:
            EcosystemError: If go.mod cannot be parsed
        """
        go_mod = self.project_root / "go.mod"

        if not go_mod.exists():
            raise EcosystemError(
                "go.mod not found",
                details=f"Expected at: {go_mod}",
                fix_hint="Run 'go mod init <module-path>' to create go.mod",
            )

        try:
            content = go_mod.read_text(encoding="utf-8")
        except OSError as e:
            raise EcosystemError("Failed to read go.mod", details=str(e)) from e

        # Parse module directive: "module github.com/user/repo"
        for line in content.splitlines():
            line = line.strip()
            if line.startswith("module "):
                module_path = line[7:].strip()
                # Remove any inline comments
                if "//" in module_path:
                    module_path = module_path.split("//")[0].strip()
                return module_path

        raise EcosystemError(
            "No module directive found in go.mod",
            details="go.mod must contain a 'module' directive",
            fix_hint="Add 'module <path>' as the first line of go.mod",
        )

    def is_workspace(self) -> bool:
        """Check if this is a Go workspace.

        Go workspaces are indicated by the presence of go.work file.

        Returns:
            True if go.work exists
        """
        go_work = self.project_root / "go.work"
        return go_work.exists()

    def get_workspace_modules(self) -> list[Path]:
        """Parse go.work file for module directories.

        Go workspace file format:
        ```
        go 1.21
        use (
            ./module1
            ./module2
        )
        ```

        Returns:
            List of module directory paths (absolute)

        Raises:
            EcosystemError: If go.work cannot be parsed
        """
        go_work = self.project_root / "go.work"

        if not go_work.exists():
            raise EcosystemError(
                "go.work not found",
                details="This is not a Go workspace",
                fix_hint="Run 'go work init' to create a workspace",
            )

        try:
            content = go_work.read_text(encoding="utf-8")
        except OSError as e:
            raise EcosystemError("Failed to read go.work", details=str(e)) from e

        modules: list[Path] = []
        in_use_block = False

        for line in content.splitlines():
            line = line.strip()

            # Skip empty lines and comments
            if not line or line.startswith("//"):
                continue

            # Check for single-line use directive: use ./module
            if line.startswith("use ") and "(" not in line:
                module_path = line[4:].strip()
                if module_path:
                    abs_path = (self.project_root / module_path).resolve()
                    if abs_path.exists():
                        modules.append(abs_path)
                continue

            # Start of use block
            if line.startswith("use ("):
                in_use_block = True
                continue

            # End of use block
            if line == ")":
                in_use_block = False
                continue

            # Module path inside use block
            if in_use_block and line:
                # Remove any inline comments
                if "//" in line:
                    line = line.split("//")[0].strip()
                if line:
                    abs_path = (self.project_root / line).resolve()
                    if abs_path.exists():
                        modules.append(abs_path)

        return modules

    def get_go_version(self) -> str | None:
        """Parse Go version requirement from go.mod.

        Looks for the "go X.Y" directive in go.mod.

        Returns:
            Go version string (e.g., "1.21") or None if not specified

        Raises:
            EcosystemError: If go.mod cannot be read
        """
        go_mod = self.project_root / "go.mod"

        if not go_mod.exists():
            return None

        try:
            content = go_mod.read_text(encoding="utf-8")
        except OSError as e:
            raise EcosystemError("Failed to read go.mod", details=str(e)) from e

        # Parse go version directive: "go 1.21"
        for line in content.splitlines():
            line = line.strip()
            if line.startswith("go "):
                version = line[3:].strip()
                # Remove any inline comments
                if "//" in version:
                    version = version.split("//")[0].strip()
                return version

        return None

    def _is_valid_semver(self, version: str) -> bool:
        """Validate semver format.

        Args:
            version: Version string to validate

        Returns:
            True if version matches X.Y.Z pattern
        """
        pattern = r"^\d+\.\d+\.\d+$"
        return bool(re.match(pattern, version))
