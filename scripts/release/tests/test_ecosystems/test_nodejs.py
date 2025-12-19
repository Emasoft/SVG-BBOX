"""Unit tests for NodeJSEcosystem class.

Tests cover:
- Project detection via package.json presence
- Version reading from package.json
- Version setting/updating in package.json
- Package manager detection (npm, pnpm, yarn, bun)
"""

import json
from pathlib import Path

import pytest

from release.ecosystems.nodejs import NodeJSEcosystem
from release.exceptions import EcosystemError


class TestNodeJSEcosystemDetect:
    """Tests for NodeJSEcosystem.detect() method."""

    def test_detect_returns_true_when_package_json_exists(self, tmp_path: Path) -> None:
        """Detection returns True when package.json exists in project root."""
        package_json = tmp_path / "package.json"
        package_json.write_text('{"name": "test", "version": "1.0.0"}')

        ecosystem = NodeJSEcosystem(tmp_path)
        result = ecosystem.detect()

        assert result is True

    def test_detect_returns_false_when_no_package_json(self, tmp_path: Path) -> None:
        """Detection returns False when package.json is missing."""
        ecosystem = NodeJSEcosystem(tmp_path)
        result = ecosystem.detect()

        assert result is False

    def test_detect_returns_false_for_empty_directory(self, tmp_path: Path) -> None:
        """Detection returns False for an empty project directory."""
        empty_project = tmp_path / "empty-project"
        empty_project.mkdir()

        ecosystem = NodeJSEcosystem(empty_project)
        result = ecosystem.detect()

        assert result is False


class TestNodeJSEcosystemGetVersion:
    """Tests for NodeJSEcosystem.get_version() method."""

    def test_get_version_reads_from_package_json(self, tmp_path: Path) -> None:
        """Correctly reads version field from package.json."""
        package_data = {"name": "test-pkg", "version": "2.3.4"}
        (tmp_path / "package.json").write_text(json.dumps(package_data, indent=2))

        ecosystem = NodeJSEcosystem(tmp_path)
        version = ecosystem.get_version()

        assert version == "2.3.4"

    def test_get_version_raises_when_no_package_json(self, tmp_path: Path) -> None:
        """Raises EcosystemError when package.json is missing."""
        ecosystem = NodeJSEcosystem(tmp_path)

        with pytest.raises(EcosystemError) as exc_info:
            ecosystem.get_version()

        assert "package.json not found" in str(exc_info.value)

    def test_get_version_raises_when_version_field_missing(
        self, tmp_path: Path
    ) -> None:
        """Raises EcosystemError when version field is absent from package.json."""
        package_data = {"name": "test-pkg", "description": "no version here"}
        (tmp_path / "package.json").write_text(json.dumps(package_data, indent=2))

        ecosystem = NodeJSEcosystem(tmp_path)

        with pytest.raises(EcosystemError) as exc_info:
            ecosystem.get_version()

        assert "No version field" in str(exc_info.value)


class TestNodeJSEcosystemSetVersion:
    """Tests for NodeJSEcosystem.set_version() method."""

    def test_set_version_updates_package_json(self, tmp_path: Path) -> None:
        """Successfully updates version in package.json."""
        package_data = {"name": "test-pkg", "version": "1.0.0"}
        package_path = tmp_path / "package.json"
        package_path.write_text(json.dumps(package_data, indent=2))

        ecosystem = NodeJSEcosystem(tmp_path)
        ecosystem.set_version("2.0.0")

        # Read back and verify
        updated_data = json.loads(package_path.read_text())
        assert updated_data["version"] == "2.0.0"

    def test_set_version_preserves_other_fields(self, tmp_path: Path) -> None:
        """Version update preserves all other package.json fields."""
        package_data = {
            "name": "my-package",
            "version": "1.0.0",
            "description": "A test package",
            "author": "Test Author",
            "license": "MIT",
            "dependencies": {"lodash": "^4.17.21"},
        }
        package_path = tmp_path / "package.json"
        package_path.write_text(json.dumps(package_data, indent=2))

        ecosystem = NodeJSEcosystem(tmp_path)
        ecosystem.set_version("1.1.0")

        updated_data = json.loads(package_path.read_text())
        assert updated_data["version"] == "1.1.0"
        assert updated_data["name"] == "my-package"
        assert updated_data["description"] == "A test package"
        assert updated_data["author"] == "Test Author"
        assert updated_data["license"] == "MIT"
        assert updated_data["dependencies"] == {"lodash": "^4.17.21"}

    def test_set_version_raises_when_no_package_json(self, tmp_path: Path) -> None:
        """Raises EcosystemError when package.json is missing."""
        ecosystem = NodeJSEcosystem(tmp_path)

        with pytest.raises(EcosystemError) as exc_info:
            ecosystem.set_version("1.0.0")

        assert "package.json not found" in str(exc_info.value)


class TestNodeJSEcosystemGetPackageManager:
    """Tests for NodeJSEcosystem.get_package_manager() method."""

    def test_get_package_manager_detects_npm_from_lock_file(
        self, tmp_path: Path
    ) -> None:
        """Detects npm from package-lock.json presence."""
        (tmp_path / "package.json").write_text('{"name": "test", "version": "1.0.0"}')
        (tmp_path / "package-lock.json").write_text("{}")

        ecosystem = NodeJSEcosystem(tmp_path)
        pm = ecosystem.get_package_manager()

        assert pm == "npm"

    def test_get_package_manager_detects_pnpm_from_lock_file(
        self, tmp_path: Path
    ) -> None:
        """Detects pnpm from pnpm-lock.yaml presence."""
        (tmp_path / "package.json").write_text('{"name": "test", "version": "1.0.0"}')
        (tmp_path / "pnpm-lock.yaml").write_text("lockfileVersion: 6.0")

        ecosystem = NodeJSEcosystem(tmp_path)
        pm = ecosystem.get_package_manager()

        assert pm == "pnpm"

    def test_get_package_manager_detects_yarn_from_lock_file(
        self, tmp_path: Path
    ) -> None:
        """Detects yarn from yarn.lock presence."""
        (tmp_path / "package.json").write_text('{"name": "test", "version": "1.0.0"}')
        (tmp_path / "yarn.lock").write_text("# yarn lockfile")

        ecosystem = NodeJSEcosystem(tmp_path)
        pm = ecosystem.get_package_manager()

        assert pm == "yarn"

    def test_get_package_manager_detects_bun_from_lock_file(
        self, tmp_path: Path
    ) -> None:
        """Detects bun from bun.lockb presence."""
        (tmp_path / "package.json").write_text('{"name": "test", "version": "1.0.0"}')
        (tmp_path / "bun.lockb").write_bytes(b"\x00\x01\x02")

        ecosystem = NodeJSEcosystem(tmp_path)
        pm = ecosystem.get_package_manager()

        assert pm == "bun"

    def test_get_package_manager_detects_from_package_manager_field(
        self, tmp_path: Path
    ) -> None:
        """Detects package manager from packageManager field in package.json."""
        package_data = {
            "name": "test",
            "version": "1.0.0",
            "packageManager": "pnpm@8.6.0",
        }
        (tmp_path / "package.json").write_text(json.dumps(package_data))

        ecosystem = NodeJSEcosystem(tmp_path)
        pm = ecosystem.get_package_manager()

        assert pm == "pnpm"

    def test_get_package_manager_defaults_to_npm(self, tmp_path: Path) -> None:
        """Returns npm as default when no lock file or packageManager field exists."""
        (tmp_path / "package.json").write_text('{"name": "test", "version": "1.0.0"}')

        ecosystem = NodeJSEcosystem(tmp_path)
        pm = ecosystem.get_package_manager()

        assert pm == "npm"

    def test_get_package_manager_prioritizes_pnpm_lock_over_npm_lock(
        self, tmp_path: Path
    ) -> None:
        """Prioritizes pnpm-lock.yaml over package-lock.json when both exist."""
        (tmp_path / "package.json").write_text('{"name": "test", "version": "1.0.0"}')
        (tmp_path / "pnpm-lock.yaml").write_text("lockfileVersion: 6.0")
        (tmp_path / "package-lock.json").write_text("{}")

        ecosystem = NodeJSEcosystem(tmp_path)
        pm = ecosystem.get_package_manager()

        # pnpm-lock.yaml should take precedence
        assert pm == "pnpm"
