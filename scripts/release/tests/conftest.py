"""Pytest fixtures for release tool tests.

Provides common fixtures for:
- Temporary project directories
- Mock configurations
- Git repository setup
- Ecosystem-specific test projects
"""

import json
import os
import subprocess
from collections.abc import Generator
from pathlib import Path
from typing import Any

import pytest
import yaml


@pytest.fixture
def temp_dir(tmp_path: Path) -> Generator[Path, None, None]:
    """Create a temporary directory for tests.

    Yields:
        Path to temporary directory
    """
    yield tmp_path
    # Cleanup handled by pytest's tmp_path


@pytest.fixture
def project_dir(temp_dir: Path) -> Path:
    """Create a temporary project directory.

    Returns:
        Path to project directory
    """
    project = temp_dir / "test-project"
    project.mkdir()
    return project


@pytest.fixture
def git_repo(project_dir: Path) -> Path:
    """Create a git repository in the project directory.

    Returns:
        Path to git repository
    """
    subprocess.run(
        ["git", "init"],
        cwd=project_dir,
        capture_output=True,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.email", "test@test.com"],
        cwd=project_dir,
        capture_output=True,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test User"],
        cwd=project_dir,
        capture_output=True,
        check=True,
    )
    return project_dir


@pytest.fixture
def nodejs_project(git_repo: Path) -> Path:
    """Create a Node.js project with package.json.

    Returns:
        Path to project directory
    """
    package_json = {
        "name": "test-package",
        "version": "1.0.0",
        "description": "Test package",
        "main": "index.js",
        "scripts": {
            "test": "echo 'test'",
            "build": "echo 'build'",
            "lint": "echo 'lint'",
        },
    }
    (git_repo / "package.json").write_text(json.dumps(package_json, indent=2))

    # Create index.js
    (git_repo / "index.js").write_text("module.exports = {};")

    # Initial commit - check=True ensures failures are caught
    subprocess.run(["git", "add", "."], cwd=git_repo, capture_output=True, check=True)
    subprocess.run(
        ["git", "commit", "-m", "Initial commit"],
        cwd=git_repo,
        capture_output=True,
        check=True,
    )

    return git_repo


@pytest.fixture
def python_project(git_repo: Path) -> Path:
    """Create a Python project with pyproject.toml.

    Returns:
        Path to project directory
    """
    pyproject = {
        "project": {
            "name": "test-package",
            "version": "1.0.0",
            "description": "Test package",
        },
        "build-system": {
            "requires": ["hatchling"],
            "build-backend": "hatchling.build",
        },
    }

    # Write as TOML
    import tomli_w

    (git_repo / "pyproject.toml").write_text(tomli_w.dumps(pyproject))

    # Create package
    (git_repo / "src").mkdir()
    (git_repo / "src" / "__init__.py").write_text('__version__ = "1.0.0"')

    # Initial commit - check=True ensures failures are caught
    subprocess.run(["git", "add", "."], cwd=git_repo, capture_output=True, check=True)
    subprocess.run(
        ["git", "commit", "-m", "Initial commit"],
        cwd=git_repo,
        capture_output=True,
        check=True,
    )

    return git_repo


@pytest.fixture
def release_config(project_dir: Path) -> Path:
    """Create a release configuration file.

    Returns:
        Path to config file
    """
    config = {
        "project": {
            "name": "test-project",
            "ecosystems": ["nodejs"],
        },
        "version": {
            "source": "package.json",
            "tag_prefix": "v",
        },
        "git": {
            "main_branch": "main",
            "require_clean": True,
        },
        "quality_checks": {
            "lint": True,
            "test": True,
        },
    }

    config_dir = project_dir / "config"
    config_dir.mkdir()
    config_path = config_dir / "release_conf.yml"
    config_path.write_text(yaml.safe_dump(config))

    return config_path


@pytest.fixture
def mock_config() -> dict[str, Any]:
    """Return a mock configuration dictionary.

    Returns:
        Configuration dictionary
    """
    return {
        "project": {
            "name": "test-project",
            "description": "Test project",
            "ecosystems": ["nodejs"],
            "primary_ecosystem": "nodejs",
        },
        "version": {
            "source": "package.json",
            "pattern": r"^\d+\.\d+\.\d+$",
            "tag_prefix": "v",
        },
        "git": {
            "main_branch": "main",
            "require_clean": True,
            "require_main_branch": True,
        },
        "quality_checks": {
            "lint": True,
            "typecheck": True,
            "test": True,
            "coverage_threshold": 80.0,
        },
    }


@pytest.fixture
def clean_env() -> Generator[None, None, None]:
    """Temporarily clean environment variables.

    Removes RELEASE_* environment variables during test.
    """
    old_env = {}
    for key in list(os.environ.keys()):
        if key.startswith("RELEASE_"):
            old_env[key] = os.environ.pop(key)

    yield

    os.environ.update(old_env)
