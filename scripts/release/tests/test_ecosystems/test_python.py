"""Unit tests for PythonEcosystem class.

Tests cover:
- Project detection via pyproject.toml presence
- Version reading from pyproject.toml (PEP 621 and Poetry formats)
- Package manager detection (pip, uv, poetry, pipenv, conda)
"""

from pathlib import Path

import pytest

from release.ecosystems.python import PythonEcosystem
from release.exceptions import EcosystemError


class TestPythonEcosystemDetect:
    """Tests for PythonEcosystem.detect() method."""

    def test_detect_returns_true_when_pyproject_toml_exists(
        self, tmp_path: Path
    ) -> None:
        """Detection returns True when pyproject.toml exists."""
        pyproject = tmp_path / "pyproject.toml"
        pyproject.write_text('[project]\nname = "test"\nversion = "1.0.0"\n')

        ecosystem = PythonEcosystem(tmp_path)
        result = ecosystem.detect()

        assert result is True

    def test_detect_returns_true_when_setup_py_exists(self, tmp_path: Path) -> None:
        """Detection returns True when setup.py exists (legacy projects)."""
        setup_py = tmp_path / "setup.py"
        setup_py.write_text('from setuptools import setup\nsetup(name="test")\n')

        ecosystem = PythonEcosystem(tmp_path)
        result = ecosystem.detect()

        assert result is True

    def test_detect_returns_false_when_no_config_files(self, tmp_path: Path) -> None:
        """Detection returns False when no Python config files exist."""
        ecosystem = PythonEcosystem(tmp_path)
        result = ecosystem.detect()

        assert result is False


class TestPythonEcosystemGetVersion:
    """Tests for PythonEcosystem.get_version() method."""

    def test_get_version_reads_pep621_format(self, tmp_path: Path) -> None:
        """Correctly reads version from PEP 621 [project] section."""
        pyproject_content = """\
[project]
name = "my-package"
version = "3.2.1"
description = "Test package"
"""
        (tmp_path / "pyproject.toml").write_text(pyproject_content)

        ecosystem = PythonEcosystem(tmp_path)
        version = ecosystem.get_version()

        assert version == "3.2.1"

    def test_get_version_reads_poetry_format(self, tmp_path: Path) -> None:
        """Correctly reads version from Poetry [tool.poetry] section."""
        pyproject_content = """\
[tool.poetry]
name = "my-package"
version = "2.5.0"
description = "Poetry project"
"""
        (tmp_path / "pyproject.toml").write_text(pyproject_content)

        ecosystem = PythonEcosystem(tmp_path)
        version = ecosystem.get_version()

        assert version == "2.5.0"

    def test_get_version_raises_when_no_pyproject_toml(self, tmp_path: Path) -> None:
        """Raises EcosystemError when pyproject.toml is missing."""
        ecosystem = PythonEcosystem(tmp_path)

        with pytest.raises(EcosystemError) as exc_info:
            ecosystem.get_version()

        assert "pyproject.toml not found" in str(exc_info.value)

    def test_get_version_raises_when_version_missing(self, tmp_path: Path) -> None:
        """Raises EcosystemError when version field is absent."""
        pyproject_content = """\
[project]
name = "my-package"
description = "No version here"
"""
        (tmp_path / "pyproject.toml").write_text(pyproject_content)

        ecosystem = PythonEcosystem(tmp_path)

        with pytest.raises(EcosystemError) as exc_info:
            ecosystem.get_version()

        assert "No version found" in str(exc_info.value)


class TestPythonEcosystemGetPackageManager:
    """Tests for PythonEcosystem.get_package_manager() method."""

    def test_get_package_manager_detects_pip_default(self, tmp_path: Path) -> None:
        """Returns pip as default when no lock file exists."""
        pyproject_content = '[project]\nname = "test"\nversion = "1.0.0"\n'
        (tmp_path / "pyproject.toml").write_text(pyproject_content)

        ecosystem = PythonEcosystem(tmp_path)
        pm = ecosystem.get_package_manager()

        assert pm == "pip"

    def test_get_package_manager_detects_uv_from_lock_file(
        self, tmp_path: Path
    ) -> None:
        """Detects uv from uv.lock presence."""
        pyproject_content = '[project]\nname = "test"\nversion = "1.0.0"\n'
        (tmp_path / "pyproject.toml").write_text(pyproject_content)
        (tmp_path / "uv.lock").write_text("version = 1\n")

        ecosystem = PythonEcosystem(tmp_path)
        pm = ecosystem.get_package_manager()

        assert pm == "uv"

    def test_get_package_manager_detects_poetry_from_lock_file(
        self, tmp_path: Path
    ) -> None:
        """Detects poetry from poetry.lock presence."""
        pyproject_content = '[project]\nname = "test"\nversion = "1.0.0"\n'
        (tmp_path / "pyproject.toml").write_text(pyproject_content)
        (tmp_path / "poetry.lock").write_text("[[package]]\n")

        ecosystem = PythonEcosystem(tmp_path)
        pm = ecosystem.get_package_manager()

        assert pm == "poetry"

    def test_get_package_manager_detects_pipenv_from_lock_file(
        self, tmp_path: Path
    ) -> None:
        """Detects pipenv from Pipfile.lock presence."""
        pyproject_content = '[project]\nname = "test"\nversion = "1.0.0"\n'
        (tmp_path / "pyproject.toml").write_text(pyproject_content)
        (tmp_path / "Pipfile.lock").write_text("{}")

        ecosystem = PythonEcosystem(tmp_path)
        pm = ecosystem.get_package_manager()

        assert pm == "pipenv"

    def test_get_package_manager_detects_conda_from_environment_yml(
        self, tmp_path: Path
    ) -> None:
        """Detects conda from environment.yml presence."""
        pyproject_content = '[project]\nname = "test"\nversion = "1.0.0"\n'
        (tmp_path / "pyproject.toml").write_text(pyproject_content)
        (tmp_path / "environment.yml").write_text(
            "name: myenv\ndependencies:\n  - python=3.11\n"
        )

        ecosystem = PythonEcosystem(tmp_path)
        pm = ecosystem.get_package_manager()

        assert pm == "conda"

    def test_get_package_manager_poetry_takes_precedence_over_uv(
        self, tmp_path: Path
    ) -> None:
        """Poetry lock file takes precedence over uv lock file."""
        pyproject_content = '[project]\nname = "test"\nversion = "1.0.0"\n'
        (tmp_path / "pyproject.toml").write_text(pyproject_content)
        (tmp_path / "poetry.lock").write_text("[[package]]\n")
        (tmp_path / "uv.lock").write_text("version = 1\n")

        ecosystem = PythonEcosystem(tmp_path)
        pm = ecosystem.get_package_manager()

        # poetry.lock is checked before uv.lock in the detection order
        assert pm == "poetry"
