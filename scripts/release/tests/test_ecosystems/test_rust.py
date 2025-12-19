"""Unit tests for RustEcosystem class.

Tests cover:
- Project detection via Cargo.toml presence
- Version reading from Cargo.toml [package] section
- Package manager detection (always cargo)
"""

from pathlib import Path

import pytest

from release.ecosystems.rust import RustEcosystem
from release.exceptions import EcosystemError


class TestRustEcosystemDetect:
    """Tests for RustEcosystem.detect() method."""

    def test_detect_returns_true_when_cargo_toml_exists(self, tmp_path: Path) -> None:
        """Detection returns True when Cargo.toml exists in project root."""
        cargo_content = """\
[package]
name = "my-crate"
version = "0.1.0"
edition = "2021"
"""
        (tmp_path / "Cargo.toml").write_text(cargo_content)

        ecosystem = RustEcosystem(tmp_path)
        result = ecosystem.detect()

        assert result is True

    def test_detect_returns_false_when_no_cargo_toml(self, tmp_path: Path) -> None:
        """Detection returns False when Cargo.toml is missing."""
        ecosystem = RustEcosystem(tmp_path)
        result = ecosystem.detect()

        assert result is False

    def test_detect_returns_false_for_empty_directory(self, tmp_path: Path) -> None:
        """Detection returns False for an empty project directory."""
        empty_project = tmp_path / "empty-crate"
        empty_project.mkdir()

        ecosystem = RustEcosystem(empty_project)
        result = ecosystem.detect()

        assert result is False


class TestRustEcosystemGetVersion:
    """Tests for RustEcosystem.get_version() method."""

    def test_get_version_reads_from_cargo_toml(self, tmp_path: Path) -> None:
        """Correctly reads version from Cargo.toml [package] section."""
        cargo_content = """\
[package]
name = "my-crate"
version = "1.2.3"
edition = "2021"
authors = ["Test Author"]
"""
        (tmp_path / "Cargo.toml").write_text(cargo_content)

        ecosystem = RustEcosystem(tmp_path)
        version = ecosystem.get_version()

        assert version == "1.2.3"

    def test_get_version_raises_when_no_cargo_toml(self, tmp_path: Path) -> None:
        """Raises EcosystemError when Cargo.toml is missing."""
        ecosystem = RustEcosystem(tmp_path)

        with pytest.raises(EcosystemError) as exc_info:
            ecosystem.get_version()

        assert "Cargo.toml not found" in str(exc_info.value)

    def test_get_version_raises_when_no_package_section(self, tmp_path: Path) -> None:
        """Raises EcosystemError when [package] section is missing."""
        cargo_content = """\
[workspace]
members = ["crate-a", "crate-b"]
"""
        (tmp_path / "Cargo.toml").write_text(cargo_content)

        ecosystem = RustEcosystem(tmp_path)

        with pytest.raises(EcosystemError) as exc_info:
            ecosystem.get_version()

        assert "No [package] section" in str(exc_info.value)

    def test_get_version_raises_when_version_missing(self, tmp_path: Path) -> None:
        """Raises EcosystemError when version field is absent from [package]."""
        cargo_content = """\
[package]
name = "my-crate"
edition = "2021"
"""
        (tmp_path / "Cargo.toml").write_text(cargo_content)

        ecosystem = RustEcosystem(tmp_path)

        with pytest.raises(EcosystemError) as exc_info:
            ecosystem.get_version()

        assert "No version field" in str(exc_info.value)


class TestRustEcosystemGetPackageManager:
    """Tests for RustEcosystem.get_package_manager() method."""

    def test_get_package_manager_always_returns_cargo(self, tmp_path: Path) -> None:
        """Always returns cargo as the package manager for Rust projects."""
        cargo_content = """\
[package]
name = "my-crate"
version = "0.1.0"
"""
        (tmp_path / "Cargo.toml").write_text(cargo_content)

        ecosystem = RustEcosystem(tmp_path)
        pm = ecosystem.get_package_manager()

        assert pm == "cargo"

    def test_get_package_manager_returns_cargo_even_without_cargo_toml(
        self, tmp_path: Path
    ) -> None:
        """Returns cargo even when Cargo.toml does not exist."""
        ecosystem = RustEcosystem(tmp_path)
        pm = ecosystem.get_package_manager()

        assert pm == "cargo"
