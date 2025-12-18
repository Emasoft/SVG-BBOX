"""Rust ecosystem implementation for package management.

Supports cargo package manager with workspace support.
"""

import re
import sys
from pathlib import Path
from typing import Any, cast

from release.ecosystems.base import Ecosystem, EcosystemRegistry
from release.exceptions import EcosystemError
from release.utils.shell import ShellError, run

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib


@EcosystemRegistry.register
class RustEcosystem(Ecosystem):
    """Rust ecosystem with cargo support.

    Handles single crates and cargo workspaces.
    """

    name = "rust"
    display_name = "Rust"
    config_files = ["Cargo.toml"]
    lock_files = ["Cargo.lock"]

    def detect(self) -> bool:
        """Detect if project uses Rust/Cargo.

        Returns:
            True if Cargo.toml exists
        """
        cargo_toml = self.project_root / "Cargo.toml"
        return cargo_toml.exists()

    def _read_cargo_toml(self) -> dict[str, Any]:
        """Read and parse Cargo.toml.

        Returns:
            Parsed TOML data as dictionary

        Raises:
            EcosystemError: If file not found or invalid TOML
        """
        cargo_toml = self.project_root / "Cargo.toml"

        if not cargo_toml.exists():
            raise EcosystemError(
                "Cargo.toml not found",
                details=f"Expected at: {cargo_toml}",
                fix_hint="Ensure you are in a Rust project root",
            )

        try:
            with open(cargo_toml, "rb") as f:
                return cast(dict[str, Any], tomllib.load(f))
        except tomllib.TOMLDecodeError as e:
            raise EcosystemError(
                "Invalid TOML in Cargo.toml",
                details=str(e),
                fix_hint="Fix TOML syntax errors in Cargo.toml",
            ) from e
        except OSError as e:
            raise EcosystemError("Failed to read Cargo.toml", details=str(e)) from e

    def get_version(self) -> str:
        """Get current version from Cargo.toml [package].version.

        Returns:
            Version string (e.g., "1.0.0")

        Raises:
            EcosystemError: If Cargo.toml not found or version missing
        """
        data = self._read_cargo_toml()

        # Check for [package] section
        package = data.get("package")
        if not package:
            raise EcosystemError(
                "No [package] section in Cargo.toml",
                fix_hint=(
                    "Add a [package] section with version field, "
                    "or this may be a workspace root"
                ),
            )

        version: str | None = package.get("version")
        if not version:
            # Check if version is inherited from workspace
            version_info = package.get("version", {})
            if isinstance(version_info, dict) and version_info.get("workspace"):
                raise EcosystemError(
                    "Version is inherited from workspace",
                    details="This crate uses `version.workspace = true`",
                    fix_hint="Set version in the workspace Cargo.toml instead",
                )
            raise EcosystemError(
                "No version field in Cargo.toml [package] section",
                fix_hint='Add version = "0.1.0" to [package] section',
            )

        return version

    def set_version(self, version: str) -> None:
        """Set version in Cargo.toml [package].version.

        Preserves formatting by using regex replacement on the raw file.
        This avoids the need for a TOML writer while maintaining
        comments and formatting.

        Args:
            version: New version string (e.g., "1.0.1")

        Raises:
            EcosystemError: If Cargo.toml cannot be updated
        """
        cargo_toml = self.project_root / "Cargo.toml"

        if not cargo_toml.exists():
            raise EcosystemError(
                "Cargo.toml not found", details=f"Expected at: {cargo_toml}"
            )

        try:
            # Read current content
            content = cargo_toml.read_text(encoding="utf-8")

            # Pattern to match version in [package] section
            # This handles: version = "x.y.z" with various spacing
            # The regex looks for version after [package] but before another section
            # First, find the [package] section
            package_match = re.search(r"\[package\]", content)
            if not package_match:
                raise EcosystemError(
                    "No [package] section found in Cargo.toml",
                    fix_hint="Add a [package] section with version field",
                )

            package_start = package_match.end()

            # Find the next section (or end of file)
            next_section = re.search(r"\n\[", content[package_start:])
            if next_section:
                package_end = package_start + next_section.start()
            else:
                package_end = len(content)

            # Extract package section content
            package_section = content[package_start:package_end]

            # Replace version in the package section
            # Pattern: version = "..." or version = '...'
            version_pattern = r'(version\s*=\s*)["\']([^"\']*)["\']'
            version_match = re.search(version_pattern, package_section)

            if not version_match:
                raise EcosystemError(
                    "No version field found in [package] section",
                    fix_hint='Add version = "0.1.0" to [package] section',
                )

            # Build the new version line preserving quote style
            old_version_line = version_match.group(0)
            quote_char = '"' if '"' in old_version_line else "'"
            new_version_line = (
                f"{version_match.group(1)}{quote_char}{version}{quote_char}"
            )

            # Replace in the package section
            new_package_section = package_section.replace(
                old_version_line, new_version_line, 1
            )

            # Reconstruct the file
            new_content = (
                content[:package_start] + new_package_section + content[package_end:]
            )

            # Write back
            cargo_toml.write_text(new_content, encoding="utf-8")

        except EcosystemError:
            raise
        except OSError as e:
            raise EcosystemError(
                f"Failed to update Cargo.toml version to {version}", details=str(e)
            ) from e

    def get_package_manager(self) -> str:
        """Get the package manager for Rust projects.

        Returns:
            Always "cargo" for Rust projects
        """
        return "cargo"

    def run_script(self, script_name: str) -> None:
        """Run a cargo command.

        Maps common script names to cargo commands:
        - build -> cargo build
        - test -> cargo test
        - lint/check -> cargo clippy
        - format -> cargo fmt

        Args:
            script_name: Script name to run (build, test, lint, etc.)

        Raises:
            EcosystemError: If command fails
        """
        # Map common script names to cargo commands
        script_map = {
            "build": ["cargo", "build", "--release"],
            "test": ["cargo", "test"],
            "lint": ["cargo", "clippy", "--", "-D", "warnings"],
            "check": ["cargo", "clippy", "--", "-D", "warnings"],
            "format": ["cargo", "fmt"],
            "fmt": ["cargo", "fmt"],
            "clean": ["cargo", "clean"],
            "doc": ["cargo", "doc"],
            "publish": ["cargo", "publish"],
        }

        cmd = script_map.get(script_name)
        if not cmd:
            # If not a known script, try running as cargo subcommand
            cmd = ["cargo", script_name]

        try:
            run(cmd, cwd=self.project_root, capture=False)
        except ShellError as e:
            raise EcosystemError(
                f"Cargo command '{script_name}' failed",
                details=str(e),
                fix_hint=f"Fix issues reported by cargo {script_name}",
            ) from e

    def has_script(self, script_name: str) -> bool:
        """Check if a cargo command/script is available.

        Args:
            script_name: Script name to check

        Returns:
            True for known cargo commands, False otherwise
        """
        known_commands = {
            "build",
            "test",
            "lint",
            "check",
            "format",
            "fmt",
            "clean",
            "doc",
            "publish",
            "run",
            "bench",
        }
        return script_name in known_commands

    def get_available_scripts(self) -> list[str]:
        """Get list of available cargo commands.

        Returns:
            List of common cargo command names
        """
        return [
            "build",
            "test",
            "lint",
            "check",
            "format",
            "clean",
            "doc",
            "publish",
            "run",
            "bench",
        ]

    def is_workspace(self) -> bool:
        """Check if this is a cargo workspace.

        Returns:
            True if Cargo.toml has [workspace] section
        """
        try:
            data = self._read_cargo_toml()
            return "workspace" in data
        except EcosystemError:
            return False

    def get_workspace_members(self) -> list[Path]:
        """Get paths to workspace member crates.

        Returns:
            List of paths to workspace member directories

        Raises:
            EcosystemError: If not a workspace or members cannot be resolved
        """
        data = self._read_cargo_toml()

        workspace = data.get("workspace")
        if not workspace:
            raise EcosystemError(
                "Not a cargo workspace",
                details="No [workspace] section found",
                fix_hint="This command only applies to workspace roots",
            )

        members: list[str] = workspace.get("members", [])
        if not members:
            return []

        # Resolve glob patterns in members
        resolved_members: list[Path] = []
        for member in members:
            # Handle glob patterns like "crates/*"
            if "*" in member:
                pattern_path = self.project_root / member
                # Use glob to expand the pattern
                parent = pattern_path.parent
                pattern = pattern_path.name
                if parent.exists():
                    for match in parent.glob(pattern):
                        if match.is_dir() and (match / "Cargo.toml").exists():
                            resolved_members.append(match)
            else:
                member_path = self.project_root / member
                if member_path.is_dir() and (member_path / "Cargo.toml").exists():
                    resolved_members.append(member_path)

        return resolved_members

    def get_crate_name(self) -> str:
        """Get the crate name from Cargo.toml [package].name.

        Returns:
            Crate name string

        Raises:
            EcosystemError: If name not found
        """
        data = self._read_cargo_toml()

        package = data.get("package")
        if not package:
            raise EcosystemError(
                "No [package] section in Cargo.toml",
                fix_hint="Add a [package] section with name field",
            )

        name: str | None = package.get("name")
        if not name:
            raise EcosystemError(
                "No name field in Cargo.toml [package] section",
                fix_hint='Add name = "my-crate" to [package] section',
            )

        return name

    def is_publishable(self) -> bool:
        """Check if the crate can be published to crates.io.

        The publish field defaults to true if not specified.
        Can be set to false or to a list of registries.

        Returns:
            True if crate can be published (publish != false)
        """
        try:
            data = self._read_cargo_toml()
        except EcosystemError:
            return False

        package = data.get("package")
        if not package:
            return False

        # Default is true (publishable)
        publish = package.get("publish", True)

        # publish = false means not publishable
        if publish is False:
            return False

        # publish = [] (empty list) also means not publishable
        # publish = true or publish = ["some-registry"] means publishable
        return not (isinstance(publish, list) and len(publish) == 0)
