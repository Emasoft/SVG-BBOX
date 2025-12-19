"""Unit tests for release.discovery module.

Tests ecosystem detection, publisher detection, monorepo detection,
CI platform detection, release automation detection, auth status detection,
and the discover_project integration function.

Coverage: 15 tests covering core detection logic with realistic project structures.
- Ecosystem detection: Node.js, Python, Rust, Go, TypeScript
- Publisher detection: npm, PyPI, GitHub
- Helper detection: monorepo (pnpm, lerna), CI platforms, release automation
- Authentication status
- Integration: discover_project for Node.js and Python projects
"""

import json
import subprocess
from pathlib import Path

import pytest

from release.discovery import (
    CIPlatform,
    ConfidenceLevel,
    ProjectDiscovery,
    ReleaseAutomation,
    detect_auth_status,
    detect_ci_platforms,
    detect_github_publishing,
    detect_go_ecosystem,
    detect_monorepo,
    detect_nodejs_ecosystem,
    detect_npm_publishing,
    detect_pypi_publishing,
    detect_python_ecosystem,
    detect_release_automation,
    detect_rust_ecosystem,
    discover_project,
)


class TestDetectNodejsEcosystem:
    """Tests for detect_nodejs_ecosystem function."""

    def test_detect_nodejs_ecosystem(self, project_dir: Path) -> None:
        """Test Node.js ecosystem detection with valid package.json.

        Creates a minimal package.json file and verifies that the Node.js
        ecosystem is correctly detected with HIGH confidence level.
        """
        # Create a package.json file
        package_json = {
            "name": "test-nodejs-project",
            "version": "1.2.3",
            "description": "A test Node.js project",
            "main": "index.js",
            "scripts": {
                "test": "jest",
                "build": "tsc",
            },
        }
        (project_dir / "package.json").write_text(json.dumps(package_json, indent=2))

        # Run detection
        result = detect_nodejs_ecosystem(project_dir)

        # Verify detection results
        assert result.detected is True, "Node.js ecosystem should be detected"
        assert result.name == "nodejs", "Ecosystem name should be 'nodejs'"
        assert result.display_name == "Node.js", "Display name should be 'Node.js'"
        assert result.confidence == ConfidenceLevel.HIGH, "Confidence should be HIGH"
        assert result.version is not None, "Version info should be present"
        assert result.version.current == "1.2.3", "Version should be '1.2.3'"
        assert result.version.source_file == "package.json", (
            "Source file should be package.json"
        )
        assert "npm" in result.details, "Details should mention npm as package manager"

    def test_detect_nodejs_with_typescript(self, project_dir: Path) -> None:
        """Test TypeScript detection via tsconfig.json presence.

        Creates a package.json with TypeScript dependency and a tsconfig.json
        file, then verifies that TypeScript is detected and mentioned in details.
        """
        # Create package.json with TypeScript dependency
        package_json = {
            "name": "typescript-project",
            "version": "2.0.0",
            "devDependencies": {
                "typescript": "^5.0.0",
            },
        }
        (project_dir / "package.json").write_text(json.dumps(package_json, indent=2))

        # Create tsconfig.json
        tsconfig = {
            "compilerOptions": {
                "target": "ES2022",
                "module": "commonjs",
                "strict": True,
            },
        }
        (project_dir / "tsconfig.json").write_text(json.dumps(tsconfig, indent=2))

        # Run detection
        result = detect_nodejs_ecosystem(project_dir)

        # Verify TypeScript is detected
        assert result.detected is True, "Node.js ecosystem should be detected"
        assert "TypeScript" in result.details, "Details should mention TypeScript"
        assert result.version is not None, "Version info should be present"
        assert result.version.current == "2.0.0", "Version should be '2.0.0'"


class TestDetectPythonEcosystem:
    """Tests for detect_python_ecosystem function."""

    def test_detect_python_ecosystem(self, project_dir: Path) -> None:
        """Test Python ecosystem detection with pyproject.toml.

        Creates a pyproject.toml with hatchling build backend and verifies
        Python ecosystem detection with appropriate version information.
        """
        import tomli_w

        # Create pyproject.toml with hatchling backend
        pyproject = {
            "project": {
                "name": "test-python-project",
                "version": "3.1.4",
                "description": "A test Python project",
                "requires-python": ">=3.10",
            },
            "build-system": {
                "requires": ["hatchling"],
                "build-backend": "hatchling.build",
            },
        }
        (project_dir / "pyproject.toml").write_text(tomli_w.dumps(pyproject))

        # Run detection
        result = detect_python_ecosystem(project_dir)

        # Verify detection results
        assert result.detected is True, "Python ecosystem should be detected"
        assert result.name == "python", "Ecosystem name should be 'python'"
        assert result.display_name == "Python", "Display name should be 'Python'"
        assert result.confidence == ConfidenceLevel.HIGH, "Confidence should be HIGH"
        assert result.version is not None, "Version info should be present"
        assert result.version.current == "3.1.4", "Version should be '3.1.4'"
        assert "hatch" in result.details, "Details should mention hatch build tool"
        assert "Python >=3.10" in result.details, (
            "Details should mention Python version requirement"
        )


class TestDetectRustEcosystem:
    """Tests for detect_rust_ecosystem function."""

    def test_detect_rust_ecosystem(self, project_dir: Path) -> None:
        """Test Rust ecosystem detection with Cargo.toml.

        Creates a valid Cargo.toml file with package metadata and verifies
        Rust ecosystem detection including edition and MSRV information.
        """
        import tomli_w

        # Create Cargo.toml
        cargo_toml = {
            "package": {
                "name": "test-rust-crate",
                "version": "0.5.0",
                "edition": "2021",
                "rust-version": "1.70.0",
                "description": "A test Rust crate",
            },
            "dependencies": {},
        }
        (project_dir / "Cargo.toml").write_text(tomli_w.dumps(cargo_toml))

        # Run detection
        result = detect_rust_ecosystem(project_dir)

        # Verify detection results
        assert result.detected is True, "Rust ecosystem should be detected"
        assert result.name == "rust", "Ecosystem name should be 'rust'"
        assert result.display_name == "Rust", "Display name should be 'Rust'"
        assert result.confidence == ConfidenceLevel.HIGH, "Confidence should be HIGH"
        assert result.version is not None, "Version info should be present"
        assert result.version.current == "0.5.0", "Version should be '0.5.0'"
        assert "test-rust-crate" in result.details, "Details should mention crate name"
        assert "edition 2021" in result.details, "Details should mention edition"
        assert "MSRV 1.70.0" in result.details, "Details should mention MSRV"


class TestDetectGoEcosystem:
    """Tests for detect_go_ecosystem function."""

    def test_detect_go_ecosystem(self, project_dir: Path) -> None:
        """Test Go ecosystem detection with go.mod.

        Creates a go.mod file with module path and Go version, then verifies
        Go ecosystem detection with correct module information.
        """
        # Create go.mod file
        go_mod_content = """module github.com/example/test-go-project

go 1.21

require (
    github.com/gin-gonic/gin v1.9.1
)
"""
        (project_dir / "go.mod").write_text(go_mod_content)

        # Run detection
        result = detect_go_ecosystem(project_dir)

        # Verify detection results
        assert result.detected is True, "Go ecosystem should be detected"
        assert result.name == "go", "Ecosystem name should be 'go'"
        assert result.display_name == "Go", "Display name should be 'Go'"
        assert result.confidence == ConfidenceLevel.HIGH, "Confidence should be HIGH"
        assert "github.com/example/test-go-project" in result.details, (
            "Details should mention module path"
        )
        assert "go 1.21" in result.details, "Details should mention Go version"


class TestDetectNpmPublishing:
    """Tests for detect_npm_publishing function."""

    def test_detect_npm_publishing(self, project_dir: Path) -> None:
        """Test npm publishing detection for a publishable package.

        Creates a package.json with public name and no private flag,
        verifying that npm publishing capability is correctly detected.
        """
        # Create package.json for a publishable package
        package_json = {
            "name": "@example/test-package",
            "version": "1.0.0",
            "description": "A publishable npm package",
            "main": "index.js",
            "files": ["dist/", "README.md"],
            "publishConfig": {
                "access": "public",
            },
        }
        (project_dir / "package.json").write_text(json.dumps(package_json, indent=2))

        # Run detection
        result = detect_npm_publishing(project_dir)

        # Verify detection results
        assert result.detected is True, "npm publishing should be detected"
        assert result.name == "npm", "Publisher name should be 'npm'"
        assert "@example/test-package" in result.details, (
            "Details should mention package name"
        )
        assert "has files field" in result.details, "Details should mention files field"
        assert "public" in result.details, "Details should mention public access"


class TestDetectPypiPublishing:
    """Tests for detect_pypi_publishing function."""

    def test_detect_pypi_publishing(self, project_dir: Path) -> None:
        """Test PyPI publishing detection for a Python package.

        Creates a pyproject.toml with complete package metadata and verifies
        PyPI publishing capability is detected with correct build system info.
        """
        import tomli_w

        # Create pyproject.toml for a publishable package
        pyproject = {
            "project": {
                "name": "test-pypi-package",
                "version": "1.0.0",
                "description": "A publishable PyPI package",
            },
            "build-system": {
                "requires": ["hatchling"],
                "build-backend": "hatchling.build",
            },
        }
        (project_dir / "pyproject.toml").write_text(tomli_w.dumps(pyproject))

        # Run detection
        result = detect_pypi_publishing(project_dir)

        # Verify detection results
        assert result.detected is True, "PyPI publishing should be detected"
        assert result.name == "pypi", "Publisher name should be 'pypi'"
        assert "test-pypi-package" in result.details, (
            "Details should mention package name"
        )
        assert "hatch" in result.details, "Details should mention hatch build system"


class TestDetectGitHubPublishing:
    """Tests for detect_github_publishing function."""

    def test_detect_github_publishing(self, git_repo: Path) -> None:
        """Test GitHub publishing detection from git remote.

        Uses git_repo fixture which has git initialized, adds a GitHub remote,
        and verifies GitHub publishing detection with correct repository info.
        """
        # Add a GitHub remote to the git repo
        subprocess.run(
            [
                "git",
                "remote",
                "add",
                "origin",
                "https://github.com/example/test-repo.git",
            ],
            cwd=git_repo,
            capture_output=True,
            check=True,
        )

        # Run detection
        result = detect_github_publishing(git_repo)

        # Verify detection results
        assert result.detected is True, "GitHub publishing should be detected"
        assert result.name == "github", "Publisher name should be 'github'"
        assert "example/test-repo" in result.details, "Details should mention repo path"


class TestDetectMonorepo:
    """Tests for detect_monorepo function."""

    def test_detect_monorepo_pnpm(self, project_dir: Path) -> None:
        """Test pnpm workspace monorepo detection.

        Creates a pnpm-workspace.yaml file with package patterns and verifies
        pnpm monorepo detection with correct package list.
        """
        import yaml

        # Create pnpm-workspace.yaml
        workspace_config = {
            "packages": [
                "packages/*",
                "apps/*",
            ],
        }
        (project_dir / "pnpm-workspace.yaml").write_text(
            yaml.safe_dump(workspace_config)
        )

        # Run detection
        result = detect_monorepo(project_dir)

        # Verify detection results
        assert result.is_monorepo is True, "Should be detected as monorepo"
        assert result.tool == "pnpm", "Tool should be 'pnpm'"
        assert "packages/*" in result.packages, "Packages should include 'packages/*'"
        assert "apps/*" in result.packages, "Packages should include 'apps/*'"

    def test_detect_monorepo_lerna(self, project_dir: Path) -> None:
        """Test Lerna monorepo detection.

        Creates a lerna.json configuration file with package patterns and
        verifies Lerna monorepo detection.
        """
        # Create lerna.json
        lerna_config = {
            "version": "independent",
            "packages": [
                "packages/*",
                "modules/*",
            ],
            "npmClient": "yarn",
        }
        (project_dir / "lerna.json").write_text(json.dumps(lerna_config, indent=2))

        # Run detection
        result = detect_monorepo(project_dir)

        # Verify detection results
        assert result.is_monorepo is True, "Should be detected as monorepo"
        assert result.tool == "lerna", "Tool should be 'lerna'"
        assert "packages/*" in result.packages, "Packages should include 'packages/*'"
        assert "modules/*" in result.packages, "Packages should include 'modules/*'"


class TestDetectCIPlatforms:
    """Tests for detect_ci_platforms function."""

    def test_detect_ci_github_actions(self, project_dir: Path) -> None:
        """Test GitHub Actions CI detection.

        Creates a .github/workflows directory with workflow files and verifies
        GitHub Actions platform detection with release workflow detection.
        """
        # Create .github/workflows directory with workflow files
        workflows_dir = project_dir / ".github" / "workflows"
        workflows_dir.mkdir(parents=True)

        # Create a CI workflow
        ci_workflow = """name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
"""
        (workflows_dir / "ci.yml").write_text(ci_workflow)

        # Create a release workflow
        release_workflow = """name: Release
on:
  release:
    types: [published]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm publish --access public
"""
        (workflows_dir / "release.yml").write_text(release_workflow)

        # Run detection
        result = detect_ci_platforms(project_dir)

        # Verify detection results
        assert CIPlatform.GITHUB_ACTIONS in result.platforms, (
            "GitHub Actions should be detected"
        )
        assert ".github/workflows/ci.yml" in result.workflow_files, (
            "CI workflow should be in list"
        )
        assert ".github/workflows/release.yml" in result.workflow_files, (
            "Release workflow should be in list"
        )
        assert result.has_release_workflow is True, (
            "Release workflow should be detected"
        )
        assert result.has_publish_workflow is True, (
            "Publish workflow should be detected"
        )


class TestDetectReleaseAutomation:
    """Tests for detect_release_automation function."""

    def test_detect_release_automation_git_cliff(self, project_dir: Path) -> None:
        """Test git-cliff release automation detection.

        Creates a cliff.toml configuration file and verifies git-cliff
        release automation tool detection.
        """
        import tomli_w

        # Create cliff.toml
        cliff_config = {
            "changelog": {
                "header": "# Changelog\n",
                "body": '{% for group, commits in commits | group_by(attribute="group") %}...',
                "footer": "",
            },
            "git": {
                "conventional_commits": True,
                "filter_unconventional": True,
            },
        }
        (project_dir / "cliff.toml").write_text(tomli_w.dumps(cliff_config))

        # Run detection
        result = detect_release_automation(project_dir)

        # Verify detection results
        assert ReleaseAutomation.GIT_CLIFF in result.tools, (
            "git-cliff should be detected"
        )
        assert "cliff.toml" in result.config_files, (
            "cliff.toml should be in config files"
        )


class TestDetectAuthStatus:
    """Tests for detect_auth_status function."""

    def test_detect_auth_status(
        self, project_dir: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Test authentication status detection for various services.

        Uses monkeypatch to set environment variables for various service
        credentials and verifies auth status detection.
        """
        # Set environment variables for testing
        monkeypatch.setenv("NPM_TOKEN", "npm_test_token_12345")
        monkeypatch.setenv("PYPI_API_TOKEN", "pypi-test-token-67890")
        monkeypatch.setenv("GITHUB_TOKEN", "ghp_test_token_abcdef")

        # Run detection
        result = detect_auth_status(project_dir)

        # Verify detection results - should be a list of AuthInfo
        assert isinstance(result, list), "Result should be a list"
        assert len(result) > 0, "Should detect at least some auth statuses"

        # Find specific auth statuses
        npm_auth = next((a for a in result if a.name == "npm"), None)
        pypi_auth = next((a for a in result if a.name == "pypi"), None)
        github_auth = next((a for a in result if a.name == "github"), None)

        # Verify npm auth
        assert npm_auth is not None, "npm auth should be detected"
        assert npm_auth.available is True, "npm auth should be available"
        assert "NPM_TOKEN" in npm_auth.source, "npm source should mention NPM_TOKEN"

        # Verify pypi auth
        assert pypi_auth is not None, "pypi auth should be detected"
        assert pypi_auth.available is True, "pypi auth should be available"

        # Verify github auth
        assert github_auth is not None, "github auth should be detected"
        assert github_auth.available is True, "github auth should be available"
        assert "env var" in github_auth.source, "github source should mention env var"


class TestDiscoverProject:
    """Tests for discover_project integration function."""

    def test_discover_project_nodejs(self, nodejs_project: Path) -> None:
        """Full integration test for Node.js project discovery.

        Uses the nodejs_project fixture which creates a complete Node.js
        project structure, and verifies full project discovery results.
        """
        # Run full project discovery
        discovery = discover_project(nodejs_project, config=None, verbose=False)

        # Verify it's a ProjectDiscovery instance
        assert isinstance(discovery, ProjectDiscovery), (
            "Result should be ProjectDiscovery"
        )

        # Verify ecosystem detection
        assert len(discovery.ecosystems) > 0, "Should detect ecosystems"
        nodejs_eco = next((e for e in discovery.ecosystems if e.name == "nodejs"), None)
        assert nodejs_eco is not None, "Node.js ecosystem should be detected"
        assert nodejs_eco.detected is True, "Node.js should be marked as detected"
        assert nodejs_eco.confidence == ConfidenceLevel.HIGH, (
            "Confidence should be HIGH"
        )

        # Verify primary ecosystem
        assert discovery.primary_ecosystem == "nodejs", (
            "Primary ecosystem should be nodejs"
        )

        # Verify version info
        assert discovery.project_version is not None, (
            "Project version should be detected"
        )
        assert discovery.project_version.current == "1.0.0", "Version should be '1.0.0'"

        # Verify publisher detection (npm should be detected)
        npm_pub = next((p for p in discovery.publishers if p.name == "npm"), None)
        assert npm_pub is not None, "npm publisher should be detected"
        assert npm_pub.detected is True, "npm publishing should be available"

    def test_discover_project_python(self, python_project: Path) -> None:
        """Full integration test for Python project discovery.

        Uses the python_project fixture which creates a complete Python
        project structure with pyproject.toml, and verifies full discovery.
        """
        # Run full project discovery
        discovery = discover_project(python_project, config=None, verbose=False)

        # Verify it's a ProjectDiscovery instance
        assert isinstance(discovery, ProjectDiscovery), (
            "Result should be ProjectDiscovery"
        )

        # Verify ecosystem detection
        assert len(discovery.ecosystems) > 0, "Should detect ecosystems"
        python_eco = next((e for e in discovery.ecosystems if e.name == "python"), None)
        assert python_eco is not None, "Python ecosystem should be detected"
        assert python_eco.detected is True, "Python should be marked as detected"
        assert python_eco.confidence == ConfidenceLevel.HIGH, (
            "Confidence should be HIGH"
        )

        # Verify primary ecosystem
        assert discovery.primary_ecosystem == "python", (
            "Primary ecosystem should be python"
        )

        # Verify version info
        assert discovery.project_version is not None, (
            "Project version should be detected"
        )
        assert discovery.project_version.current == "1.0.0", "Version should be '1.0.0'"

        # Verify publisher detection (pypi should be detected)
        pypi_pub = next((p for p in discovery.publishers if p.name == "pypi"), None)
        assert pypi_pub is not None, "PyPI publisher should be detected"
        assert pypi_pub.detected is True, "PyPI publishing should be available"

        # Verify monorepo is not detected (single project)
        assert discovery.monorepo is not None, "Monorepo info should be present"
        assert discovery.monorepo.is_monorepo is False, "Should not be a monorepo"

        # Verify CI detection (no CI configured in fixture)
        assert discovery.ci is not None, "CI info should be present"
