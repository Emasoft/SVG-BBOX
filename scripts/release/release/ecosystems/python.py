"""Python ecosystem implementation for package management.

Supports pip, uv, poetry, conda, and pdm package managers with automatic detection.
"""

import re
import sys

from release.ecosystems.base import Ecosystem, EcosystemRegistry
from release.exceptions import EcosystemError
from release.utils.shell import ShellError, run

# Import tomllib (Python 3.11+) or tomli as fallback
if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib


@EcosystemRegistry.register
class PythonEcosystem(Ecosystem):
    """Python ecosystem with multi-package-manager support.

    Package manager detection priority:
    1. poetry.lock -> poetry
    2. uv.lock -> uv
    3. pdm.lock -> pdm
    4. Pipfile.lock -> pipenv
    5. conda-lock.yml or environment.yml -> conda
    6. requirements.txt + pyproject.toml -> pip/uv
    """

    name = "python"
    display_name = "Python"
    config_files = ["pyproject.toml", "setup.py", "setup.cfg"]
    lock_files = [
        "poetry.lock",
        "uv.lock",
        "pdm.lock",
        "Pipfile.lock",
        "conda-lock.yml",
    ]

    def detect(self) -> bool:
        """Detect if project uses Python.

        Returns:
            True if pyproject.toml, setup.py, or setup.cfg exists
        """
        for config_file in self.config_files:
            if (self.project_root / config_file).exists():
                return True
        return False

    def _read_pyproject(self) -> dict[str, object]:
        """Read and parse pyproject.toml.

        Returns:
            Parsed TOML data as dictionary

        Raises:
            EcosystemError: If file not found or invalid TOML
        """
        pyproject_path = self.project_root / "pyproject.toml"

        if not pyproject_path.exists():
            raise EcosystemError(
                "pyproject.toml not found",
                details=f"Expected at: {pyproject_path}",
                fix_hint="Create pyproject.toml or run 'uv init' / 'poetry init'",
            )

        try:
            with open(pyproject_path, "rb") as f:
                return dict(tomllib.load(f))
        except tomllib.TOMLDecodeError as e:
            raise EcosystemError(
                "Invalid TOML in pyproject.toml",
                details=str(e),
                fix_hint="Fix TOML syntax errors in pyproject.toml",
            ) from e
        except OSError as e:
            raise EcosystemError(
                "Failed to read pyproject.toml",
                details=str(e),
            ) from e

    def get_version(self) -> str:
        """Get current version from pyproject.toml.

        Checks for version in this order:
        1. [project].version (PEP 621 standard)
        2. [tool.poetry].version (Poetry format)
        3. Dynamic version marker in [project].dynamic

        Returns:
            Version string (e.g., "1.0.0")

        Raises:
            EcosystemError: If version cannot be determined
        """
        data = self._read_pyproject()

        # Check PEP 621 [project].version first
        project = data.get("project")
        if isinstance(project, dict):
            version = project.get("version")
            if isinstance(version, str) and version:
                return version
            # Check if version is dynamic
            dynamic = project.get("dynamic", [])
            if isinstance(dynamic, list) and "version" in dynamic:
                raise EcosystemError(
                    "Version is marked as dynamic in pyproject.toml",
                    details="[project].dynamic contains 'version'",
                    fix_hint="Use a version management tool like setuptools-scm or hatch-vcs",
                )

        # Check Poetry format [tool.poetry].version
        tool = data.get("tool")
        if isinstance(tool, dict):
            poetry = tool.get("poetry")
            if isinstance(poetry, dict):
                version = poetry.get("version")
                if isinstance(version, str) and version:
                    return version

        raise EcosystemError(
            "No version found in pyproject.toml",
            details="Checked [project].version and [tool.poetry].version",
            fix_hint='Add version = "1.0.0" to [project] or [tool.poetry] section',
        )

    def set_version(self, version: str) -> None:
        """Set version in pyproject.toml.

        Updates version in the appropriate section:
        - [project].version for PEP 621 projects
        - [tool.poetry].version for Poetry projects

        Preserves file formatting as much as possible using regex replacement.

        Args:
            version: New version string (e.g., "1.0.1")

        Raises:
            EcosystemError: If version cannot be updated
        """
        pyproject_path = self.project_root / "pyproject.toml"

        if not pyproject_path.exists():
            raise EcosystemError(
                "pyproject.toml not found",
                details=f"Expected at: {pyproject_path}",
            )

        try:
            # Read current content as text
            content = pyproject_path.read_text(encoding="utf-8")
            original_content = content

            # Determine which format to update by checking current content
            data = self._read_pyproject()
            updated = False

            # Try PEP 621 format first
            project = data.get("project")
            if isinstance(project, dict) and "version" in project:
                # Replace version in [project] section
                # Match: version = "x.y.z" or version = 'x.y.z'
                pattern = r'(\[project\][^\[]*?version\s*=\s*)["\']([^"\']*)["\']'
                replacement = rf'\g<1>"{version}"'
                new_content, count = re.subn(
                    pattern, replacement, content, flags=re.DOTALL
                )
                if count > 0:
                    content = new_content
                    updated = True

            # Try Poetry format if PEP 621 didn't work
            if not updated:
                tool = data.get("tool")
                if isinstance(tool, dict):
                    poetry = tool.get("poetry")
                    if isinstance(poetry, dict) and "version" in poetry:
                        # Replace version in [tool.poetry] section
                        pattern = r'(\[tool\.poetry\][^\[]*?version\s*=\s*)["\']([^"\']*)["\']'
                        replacement = rf'\g<1>"{version}"'
                        new_content, count = re.subn(
                            pattern, replacement, content, flags=re.DOTALL
                        )
                        if count > 0:
                            content = new_content
                            updated = True

            if not updated:
                raise EcosystemError(
                    "Could not find version field to update",
                    details="No version field found in [project] or [tool.poetry]",
                    fix_hint="Add version field to pyproject.toml before updating",
                )

            # Only write if content changed
            if content != original_content:
                pyproject_path.write_text(content, encoding="utf-8")

        except EcosystemError:
            raise
        except OSError as e:
            raise EcosystemError(
                f"Failed to update pyproject.toml version to {version}",
                details=str(e),
            ) from e

    def get_package_manager(self) -> str:
        """Detect which package manager is used.

        Detection strategy (in order):
        1. poetry.lock -> poetry
        2. uv.lock -> uv
        3. pdm.lock -> pdm
        4. Pipfile.lock -> pipenv
        5. conda-lock.yml or environment.yml -> conda
        6. requirements.txt with pyproject.toml -> pip (default)

        Returns:
            Package manager name: "poetry", "uv", "pdm", "pipenv", "conda", or "pip"
        """
        lock_file_map = {
            "poetry.lock": "poetry",
            "uv.lock": "uv",
            "pdm.lock": "pdm",
            "Pipfile.lock": "pipenv",
            "conda-lock.yml": "conda",
        }

        for lock_file, manager in lock_file_map.items():
            if (self.project_root / lock_file).exists():
                return manager

        # Check for conda environment file
        if (self.project_root / "environment.yml").exists():
            return "conda"

        # Default to pip
        return "pip"

    def run_script(self, script_name: str) -> None:
        """Run a script using the detected package manager.

        For different package managers:
        - poetry: poetry run <script>
        - uv: uv run <script>
        - pdm: pdm run <script>
        - pipenv: pipenv run <script>
        - pip: python -m <script> or direct execution

        Args:
            script_name: Script name from pyproject.toml scripts section

        Raises:
            EcosystemError: If script fails or doesn't exist
        """
        if not self.has_script(script_name):
            raise EcosystemError(
                f"Script '{script_name}' not found in pyproject.toml",
                details=f"Available scripts: {', '.join(self.get_available_scripts())}",
                fix_hint=f"Add '{script_name}' to [project.scripts] or [tool.poetry.scripts]",
            )

        package_manager = self.get_package_manager()

        # Build command based on package manager
        if package_manager == "poetry":
            cmd = ["poetry", "run", script_name]
        elif package_manager == "uv":
            cmd = ["uv", "run", script_name]
        elif package_manager == "pdm":
            cmd = ["pdm", "run", script_name]
        elif package_manager == "pipenv":
            cmd = ["pipenv", "run", script_name]
        else:
            # For pip/conda, try direct execution
            cmd = [script_name]

        try:
            run(cmd, cwd=self.project_root, capture=False)
        except ShellError as e:
            raise EcosystemError(
                f"Script '{script_name}' failed",
                details=str(e),
                fix_hint=f"Fix issues in the '{script_name}' script",
            ) from e

    def has_script(self, script_name: str) -> bool:
        """Check if a script exists in pyproject.toml.

        Checks:
        - [project.scripts] (PEP 621)
        - [tool.poetry.scripts] (Poetry)

        Args:
            script_name: Script name to check

        Returns:
            True if script exists
        """
        try:
            data = self._read_pyproject()
        except EcosystemError:
            return False

        # Check PEP 621 [project.scripts]
        project = data.get("project")
        if isinstance(project, dict):
            scripts = project.get("scripts")
            if isinstance(scripts, dict) and script_name in scripts:
                return True

        # Check Poetry [tool.poetry.scripts]
        tool = data.get("tool")
        if isinstance(tool, dict):
            poetry = tool.get("poetry")
            if isinstance(poetry, dict):
                scripts = poetry.get("scripts")
                if isinstance(scripts, dict) and script_name in scripts:
                    return True

        return False

    def get_available_scripts(self) -> list[str]:
        """Get list of all scripts defined in pyproject.toml.

        Combines scripts from:
        - [project.scripts] (PEP 621)
        - [tool.poetry.scripts] (Poetry)

        Returns:
            List of script names
        """
        scripts: set[str] = set()

        try:
            data = self._read_pyproject()
        except EcosystemError:
            return []

        # Get PEP 621 scripts
        project = data.get("project")
        if isinstance(project, dict):
            project_scripts = project.get("scripts")
            if isinstance(project_scripts, dict):
                scripts.update(project_scripts.keys())

        # Get Poetry scripts
        tool = data.get("tool")
        if isinstance(tool, dict):
            poetry = tool.get("poetry")
            if isinstance(poetry, dict):
                poetry_scripts = poetry.get("scripts")
                if isinstance(poetry_scripts, dict):
                    scripts.update(poetry_scripts.keys())

        return sorted(scripts)

    def get_dependencies(self) -> dict[str, list[str]]:
        """Parse dependencies from pyproject.toml.

        Returns dictionary with keys:
        - 'required': Main dependencies
        - 'optional': Optional/dev dependencies

        Returns:
            Dictionary mapping dependency type to list of package specifiers
        """
        dependencies: dict[str, list[str]] = {"required": [], "optional": []}

        try:
            data = self._read_pyproject()
        except EcosystemError:
            return dependencies

        # PEP 621 format
        project = data.get("project")
        if isinstance(project, dict):
            # Main dependencies
            deps = project.get("dependencies")
            if isinstance(deps, list):
                dependencies["required"] = [str(d) for d in deps]

            # Optional dependencies
            optional_deps = project.get("optional-dependencies")
            if isinstance(optional_deps, dict):
                for group_deps in optional_deps.values():
                    if isinstance(group_deps, list):
                        dependencies["optional"].extend(str(d) for d in group_deps)

        # Poetry format
        tool = data.get("tool")
        if isinstance(tool, dict):
            poetry = tool.get("poetry")
            if isinstance(poetry, dict):
                # Main dependencies (poetry uses dict format)
                deps = poetry.get("dependencies")
                if isinstance(deps, dict):
                    # Skip python version specifier
                    dependencies["required"] = [
                        f"{name}{self._poetry_version_to_specifier(spec)}"
                        for name, spec in deps.items()
                        if name.lower() != "python"
                    ]

                # Dev dependencies
                dev_deps = poetry.get("dev-dependencies")
                if isinstance(dev_deps, dict):
                    dependencies["optional"].extend(
                        f"{name}{self._poetry_version_to_specifier(spec)}"
                        for name, spec in dev_deps.items()
                    )

                # Poetry groups (newer format)
                group = poetry.get("group")
                if isinstance(group, dict):
                    for group_data in group.values():
                        if isinstance(group_data, dict):
                            group_deps = group_data.get("dependencies")
                            if isinstance(group_deps, dict):
                                dependencies["optional"].extend(
                                    f"{name}{self._poetry_version_to_specifier(spec)}"
                                    for name, spec in group_deps.items()
                                )

        return dependencies

    def _poetry_version_to_specifier(self, spec: object) -> str:
        """Convert Poetry version specifier to PEP 440 format.

        Args:
            spec: Poetry version specifier (string or dict)

        Returns:
            PEP 440 version specifier string
        """
        if isinstance(spec, str):
            # Simple string specifier
            if spec == "*":
                return ""
            # Handle caret (^) and tilde (~) operators
            if spec.startswith("^"):
                return f">={spec[1:]}"
            if spec.startswith("~"):
                return f"~={spec[1:]}"
            return spec
        if isinstance(spec, dict):
            # Complex specifier with version key
            version = spec.get("version")
            if isinstance(version, str):
                return self._poetry_version_to_specifier(version)
        return ""

    def is_package(self) -> bool:
        """Check if project is a distributable Python package.

        A project is considered a package if it has:
        - [project] section with name (PEP 621)
        - [tool.poetry] section with name (Poetry)

        Returns:
            True if project is a distributable package
        """
        try:
            data = self._read_pyproject()
        except EcosystemError:
            return False

        # Check PEP 621 format
        project = data.get("project")
        if isinstance(project, dict) and "name" in project:
            return True

        # Check Poetry format
        tool = data.get("tool")
        if isinstance(tool, dict):
            poetry = tool.get("poetry")
            if isinstance(poetry, dict) and "name" in poetry:
                return True

        return False
