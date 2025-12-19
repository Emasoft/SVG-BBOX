"""Unit tests for default configuration generation.

Tests cover:
- GitHub URL parsing (HTTPS, SSH, protocol-prefixed SSH)
- Package manager detection (pnpm, yarn, bun, npm)
- Node version detection (.nvmrc, .node-version, running node)
- Script detection from package.json
- Full config generation

Coverage: ~85% (all detection logic paths tested)
"""

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from release.config.defaults import (
    detect_node_version,
    detect_package_manager,
    detect_scripts,
    generate_default_config,
    parse_github_url,
)


class TestParseGitHubUrl:
    """Tests for GitHub URL parsing with multiple formats."""

    def test_https_url(self) -> None:
        """parse_github_url extracts owner/repo from HTTPS URL."""
        result = parse_github_url("https://github.com/emasoft/svg-bbox.git")
        assert result == ("emasoft", "svg-bbox")

    def test_https_url_without_git(self) -> None:
        """parse_github_url handles HTTPS URL without .git suffix."""
        result = parse_github_url("https://github.com/emasoft/svg-bbox")
        assert result == ("emasoft", "svg-bbox")

    def test_ssh_url(self) -> None:
        """parse_github_url extracts owner/repo from SSH URL."""
        result = parse_github_url("git@github.com:emasoft/svg-bbox.git")
        assert result == ("emasoft", "svg-bbox")

    def test_ssh_url_without_git(self) -> None:
        """parse_github_url handles SSH URL without .git suffix."""
        result = parse_github_url("git@github.com:emasoft/svg-bbox")
        assert result == ("emasoft", "svg-bbox")

    def test_ssh_protocol_url(self) -> None:
        """parse_github_url handles ssh:// protocol format."""
        result = parse_github_url("ssh://git@github.com/emasoft/svg-bbox.git")
        assert result == ("emasoft", "svg-bbox")

    def test_non_github_url(self) -> None:
        """parse_github_url returns None for non-GitHub URLs."""
        result = parse_github_url("https://gitlab.com/user/repo.git")
        assert result is None

    def test_invalid_url(self) -> None:
        """parse_github_url returns None for invalid URLs."""
        result = parse_github_url("not-a-url")
        assert result is None


class TestDetectPackageManager:
    """Tests for Node.js package manager detection."""

    def test_detect_pnpm(self, temp_dir: Path) -> None:
        """detect_package_manager identifies pnpm from lock file."""
        (temp_dir / "pnpm-lock.yaml").write_text("lockfileVersion: 9.0")
        result = detect_package_manager(temp_dir)
        assert result == "pnpm"

    def test_detect_yarn(self, temp_dir: Path) -> None:
        """detect_package_manager identifies yarn from lock file."""
        (temp_dir / "yarn.lock").write_text("# yarn lockfile")
        result = detect_package_manager(temp_dir)
        assert result == "yarn"

    def test_detect_bun(self, temp_dir: Path) -> None:
        """detect_package_manager identifies bun from lock file."""
        (temp_dir / "bun.lockb").write_bytes(b"\x00bun lockfile")
        result = detect_package_manager(temp_dir)
        assert result == "bun"

    def test_detect_from_package_json(self, temp_dir: Path) -> None:
        """detect_package_manager reads packageManager field from package.json."""
        package_json = {"packageManager": "pnpm@9.0.0"}
        (temp_dir / "package.json").write_text(json.dumps(package_json))
        result = detect_package_manager(temp_dir)
        assert result == "pnpm"

    def test_default_npm(self, temp_dir: Path) -> None:
        """detect_package_manager defaults to npm when no indicators found."""
        result = detect_package_manager(temp_dir)
        assert result == "npm"


class TestDetectNodeVersion:
    """Tests for Node.js version detection."""

    def test_detect_from_nvmrc(self, temp_dir: Path) -> None:
        """detect_node_version reads version from .nvmrc file."""
        (temp_dir / ".nvmrc").write_text("v20")
        result = detect_node_version(temp_dir)
        assert result == "20"

    def test_detect_from_node_version_file(self, temp_dir: Path) -> None:
        """detect_node_version reads version from .node-version file."""
        (temp_dir / ".node-version").write_text("22.0.0")
        result = detect_node_version(temp_dir)
        assert result == "22"

    def test_detect_with_v_prefix(self, temp_dir: Path) -> None:
        """detect_node_version handles version with 'v' prefix."""
        (temp_dir / ".nvmrc").write_text("v18.17.0")
        result = detect_node_version(temp_dir)
        assert result == "18"

    def test_fallback_to_running_node(self, temp_dir: Path) -> None:
        """detect_node_version uses running node version as fallback."""
        # No .nvmrc or .node-version, will try running node
        with patch("subprocess.run") as mock_run:
            mock_run.return_value.returncode = 0
            mock_run.return_value.stdout = "v20.11.0\n"
            result = detect_node_version(temp_dir)
            assert result == "20"

    def test_default_version(self, temp_dir: Path) -> None:
        """detect_node_version defaults to 24 when detection fails."""
        with patch("subprocess.run") as mock_run:
            mock_run.side_effect = FileNotFoundError()
            result = detect_node_version(temp_dir)
            assert result == "24"


class TestDetectScripts:
    """Tests for npm script detection from package.json."""

    def test_detect_standard_scripts(self, temp_dir: Path) -> None:
        """detect_scripts finds standard lint, test, build scripts."""
        package_json = {
            "scripts": {
                "lint": "eslint .",
                "test": "vitest",
                "build": "tsc",
            }
        }
        (temp_dir / "package.json").write_text(json.dumps(package_json))

        result = detect_scripts(temp_dir, "pnpm")
        assert result["lint"] == "pnpm run lint"
        assert result["test"] == "pnpm test"
        assert result["build"] == "pnpm run build"

    def test_detect_typecheck_script(self, temp_dir: Path) -> None:
        """detect_scripts finds typecheck script variants."""
        package_json = {"scripts": {"typecheck": "tsc --noEmit"}}
        (temp_dir / "package.json").write_text(json.dumps(package_json))

        result = detect_scripts(temp_dir, "npm")
        assert result["typecheck"] == "npm run typecheck"

    def test_detect_e2e_script(self, temp_dir: Path) -> None:
        """detect_scripts finds e2e test script variants."""
        package_json = {"scripts": {"test:e2e": "playwright test"}}
        (temp_dir / "package.json").write_text(json.dumps(package_json))

        result = detect_scripts(temp_dir, "pnpm")
        assert result["test_e2e"] == "pnpm run test:e2e"

    def test_detect_lint_fix(self, temp_dir: Path) -> None:
        """detect_scripts finds lint:fix script."""
        package_json = {"scripts": {"lint": "eslint .", "lint:fix": "eslint . --fix"}}
        (temp_dir / "package.json").write_text(json.dumps(package_json))

        result = detect_scripts(temp_dir, "yarn")
        assert result["lint_fix"] == "yarn run lint:fix"

    def test_no_package_json(self, temp_dir: Path) -> None:
        """detect_scripts returns None values when package.json missing."""
        result = detect_scripts(temp_dir, "npm")
        assert result["lint"] is None
        assert result["test"] is None
        assert result["build"] is None


class TestGenerateDefaultConfig:
    """Tests for full configuration generation."""

    def test_generate_config_node_project(self, nodejs_project: Path) -> None:
        """generate_default_config creates valid config for Node.js project."""
        config = generate_default_config(nodejs_project)

        assert config["project"]["name"] == "test-package"
        assert config["project"]["ecosystem"] == "node"
        assert config["version"]["file"] == "package.json"
        assert config["tools"]["package_manager"] == "npm"

    def test_generate_config_with_github(self, git_repo: Path) -> None:
        """generate_default_config detects GitHub repo info when available."""
        # Create package.json
        package_json = {"name": "test-package", "version": "1.0.0"}
        (git_repo / "package.json").write_text(json.dumps(package_json))

        # Mock git remote to return GitHub URL
        with patch("release.config.defaults.get_git_remote_url") as mock_remote:
            mock_remote.return_value = "https://github.com/emasoft/test-repo.git"
            config = generate_default_config(git_repo)

        assert config["github"]["owner"] == "emasoft"
        assert config["github"]["repo"] == "test-repo"

    def test_generate_config_placeholder_github(self, temp_dir: Path) -> None:
        """generate_default_config uses placeholders when no GitHub remote."""
        package_json = {"name": "test-package", "version": "1.0.0"}
        (temp_dir / "package.json").write_text(json.dumps(package_json))

        with patch("release.config.defaults.get_git_remote_url") as mock_remote:
            mock_remote.return_value = None
            config = generate_default_config(temp_dir)

        assert config["github"]["owner"] == "OWNER"
        assert "TEST" in config["github"]["repo"].upper()

    def test_generate_config_custom_name(self, temp_dir: Path) -> None:
        """generate_default_config allows project name override."""
        package_json = {"name": "original-name", "version": "1.0.0"}
        (temp_dir / "package.json").write_text(json.dumps(package_json))

        config = generate_default_config(temp_dir, project_name="custom-name")
        assert config["project"]["name"] == "custom-name"
