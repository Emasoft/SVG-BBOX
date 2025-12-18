"""Node.js ecosystem implementation for package management.

Supports npm, pnpm, yarn, and bun package managers with automatic detection.
Includes workspace/monorepo support and multi-config file detection.
"""

import json
from pathlib import Path
from typing import Any

import tomllib

from release.ecosystems.base import Ecosystem, EcosystemRegistry
from release.exceptions import EcosystemError
from release.utils.shell import ShellError, run


@EcosystemRegistry.register
class NodeJSEcosystem(Ecosystem):
    """Node.js ecosystem with multi-package-manager support.

    Package manager detection priority:
    1. packageManager field in package.json
    2. Lock file presence (pnpm-lock.yaml, yarn.lock, bun.lockb, package-lock.json)
    3. Default to npm if no indicators found
    """

    name = "nodejs"
    display_name = "Node.js"
    config_files = ["package.json", ".npmrc", ".yarnrc.yml", "bunfig.toml"]
    lock_files = ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "package-lock.json"]

    def detect(self) -> bool:
        """Detect if project uses Node.js.

        Returns:
            True if package.json exists
        """
        package_json = self.project_root / "package.json"
        return package_json.exists()

    def get_version(self) -> str:
        """Get current version from package.json.

        Returns:
            Version string (e.g., "1.0.0")

        Raises:
            EcosystemError: If package.json not found or version missing
        """
        package_json = self.project_root / "package.json"

        if not package_json.exists():
            raise EcosystemError(
                "package.json not found",
                details=f"Expected at: {package_json}",
                fix_hint="Ensure you are in a Node.js project root",
            )

        try:
            with open(package_json, encoding="utf-8") as f:
                data = json.load(f)
        except json.JSONDecodeError as e:
            raise EcosystemError(
                "Invalid JSON in package.json",
                details=str(e),
                fix_hint="Fix JSON syntax errors in package.json",
            ) from e
        except Exception as e:
            raise EcosystemError("Failed to read package.json", details=str(e)) from e

        version: str | None = data.get("version")
        if not version:
            raise EcosystemError(
                "No version field in package.json",
                fix_hint='Add "version": "1.0.0" to package.json',
            )

        return version

    def set_version(self, version: str) -> None:
        """Set version in package.json.

        Preserves formatting by reading, modifying, and writing back.
        Uses 2-space indentation (Node.js convention).

        Args:
            version: New version string (e.g., "1.0.1")

        Raises:
            EcosystemError: If package.json cannot be updated
        """
        package_json = self.project_root / "package.json"

        if not package_json.exists():
            raise EcosystemError(
                "package.json not found", details=f"Expected at: {package_json}"
            )

        try:
            # Read current content
            with open(package_json, encoding="utf-8") as f:
                data = json.load(f)

            # Update version
            data["version"] = version

            # Write back with formatting
            with open(package_json, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
                f.write("\n")  # Trailing newline (Node.js convention)

        except json.JSONDecodeError as e:
            raise EcosystemError("Invalid JSON in package.json", details=str(e)) from e
        except Exception as e:
            raise EcosystemError(
                f"Failed to update package.json version to {version}", details=str(e)
            ) from e

    def get_package_manager(self) -> str:
        """Detect which package manager is used.

        Detection strategy:
        1. Check packageManager field in package.json (e.g., "pnpm@8.0.0")
        2. Check for lock files (pnpm-lock.yaml, yarn.lock, bun.lockb, package-lock.json)
        3. Default to npm

        Returns:
            Package manager name: "npm", "pnpm", "yarn", or "bun"
        """
        # Strategy 1: Check packageManager field
        package_json = self.project_root / "package.json"
        if package_json.exists():
            try:
                with open(package_json, encoding="utf-8") as f:
                    data = json.load(f)
                    pm_field: str = data.get("packageManager", "")
                    if pm_field:
                        # Extract manager name from "pnpm@8.0.0" format
                        manager: str = pm_field.split("@")[0]
                        if manager in ["npm", "pnpm", "yarn", "bun"]:
                            return manager
            except (json.JSONDecodeError, OSError):
                pass  # Fall through to lock file detection on JSON/file errors

        # Strategy 2: Check lock files in priority order
        lock_file_map = {
            "pnpm-lock.yaml": "pnpm",
            "yarn.lock": "yarn",
            "bun.lockb": "bun",
            "package-lock.json": "npm",
        }

        for lock_file, manager in lock_file_map.items():
            if (self.project_root / lock_file).exists():
                return manager

        # Strategy 3: Default to npm
        return "npm"

    def run_script(self, script_name: str) -> None:
        """Run a package.json script using the detected package manager.

        Args:
            script_name: Script name from package.json scripts section

        Raises:
            EcosystemError: If script fails or doesn't exist
        """
        if not self.has_script(script_name):
            raise EcosystemError(
                f"Script '{script_name}' not found in package.json",
                details=f"Available scripts: {', '.join(self.get_available_scripts())}",
                fix_hint=f'Add "{script_name}" to package.json scripts section',
            )

        package_manager = self.get_package_manager()
        cmd = [package_manager, "run", script_name]

        try:
            run(cmd, cwd=self.project_root, capture=False)
        except ShellError as e:
            raise EcosystemError(
                f"Script '{script_name}' failed",
                details=str(e),
                fix_hint=f"Fix issues in the '{script_name}' script",
            ) from e

    def has_script(self, script_name: str) -> bool:
        """Check if a script exists in package.json.

        Args:
            script_name: Script name to check

        Returns:
            True if script exists in package.json scripts section
        """
        package_json = self.project_root / "package.json"

        if not package_json.exists():
            return False

        try:
            with open(package_json, encoding="utf-8") as f:
                data = json.load(f)
                scripts = data.get("scripts", {})
                return script_name in scripts
        except (json.JSONDecodeError, OSError):
            # Return False on JSON parse errors or file I/O errors
            return False

    def get_available_scripts(self) -> list[str]:
        """Get list of all scripts defined in package.json.

        Returns:
            List of script names from package.json scripts section
        """
        package_json = self.project_root / "package.json"

        if not package_json.exists():
            return []

        try:
            with open(package_json, encoding="utf-8") as f:
                data = json.load(f)
                scripts = data.get("scripts", {})
                return list(scripts.keys())
        except (json.JSONDecodeError, OSError):
            # Return empty list on JSON parse errors or file I/O errors
            return []

    def get_bun_config(self) -> dict[str, Any] | None:
        """Read Bun-specific configuration from bunfig.toml if present.

        Parses bunfig.toml for registry settings, install options, and other
        Bun-specific configuration.

        Returns:
            Parsed bunfig.toml as a dictionary, or None if file doesn't exist
            or cannot be parsed.
        """
        bunfig_path = self.project_root / "bunfig.toml"

        if not bunfig_path.exists():
            return None

        try:
            with open(bunfig_path, "rb") as f:
                config: dict[str, Any] = tomllib.load(f)
                return config
        except tomllib.TOMLDecodeError:
            # Return None on TOML parse errors (invalid bunfig.toml)
            return None
        except OSError:
            # Return None on file I/O errors
            return None

    def is_monorepo(self) -> bool:
        """Detect if project is a monorepo/workspace.

        Checks for the "workspaces" field in package.json which indicates
        a multi-package workspace configuration used by npm, yarn, and pnpm.

        Returns:
            True if package.json contains a "workspaces" field
        """
        package_json = self.project_root / "package.json"

        if not package_json.exists():
            return False

        try:
            with open(package_json, encoding="utf-8") as f:
                data = json.load(f)
                # Workspaces can be an array or an object with "packages" key
                workspaces = data.get("workspaces")
                if workspaces is None:
                    return False
                # Array format: ["packages/*", "apps/*"]
                if isinstance(workspaces, list):
                    return len(workspaces) > 0
                # Object format: {"packages": ["packages/*"]}
                if isinstance(workspaces, dict):
                    packages = workspaces.get("packages", [])
                    return len(packages) > 0
                return False
        except (json.JSONDecodeError, OSError):
            # Return False on JSON parse errors or file I/O errors
            return False

    def get_workspace_packages(self) -> list[Path]:
        """Get list of workspace package paths in a monorepo.

        Resolves workspace glob patterns from package.json to actual package
        directories. Each returned path is a directory containing a package.json.

        Returns:
            List of absolute paths to workspace packages. Returns empty list if
            not a monorepo or no packages found.
        """
        package_json = self.project_root / "package.json"

        if not package_json.exists():
            return []

        try:
            with open(package_json, encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError):
            return []

        # Extract workspace patterns
        workspaces = data.get("workspaces")
        if workspaces is None:
            return []

        # Normalize to list of patterns
        patterns: list[str] = []
        if isinstance(workspaces, list):
            patterns = workspaces
        elif isinstance(workspaces, dict):
            patterns = workspaces.get("packages", [])

        if not patterns:
            return []

        # Resolve patterns to actual package paths
        package_paths: list[Path] = []
        for pattern in patterns:
            # Handle glob patterns (e.g., "packages/*", "apps/**")
            if "*" in pattern:
                # Use glob to find matching directories
                for match in self.project_root.glob(pattern):
                    if match.is_dir() and (match / "package.json").exists():
                        package_paths.append(match.resolve())
            else:
                # Direct path reference
                direct_path = self.project_root / pattern
                if direct_path.is_dir() and (direct_path / "package.json").exists():
                    package_paths.append(direct_path.resolve())

        # Sort for consistent ordering
        return sorted(package_paths)
