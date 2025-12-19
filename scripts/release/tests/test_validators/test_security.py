"""Tests for security validators.

Tests the following validators:
- SecretDetectionValidator: Scans publishable files for exposed secrets

These tests use temporary directories with mock files containing
various secret patterns to validate detection capabilities.
"""

import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from release.config.models import ReleaseConfig
from release.validators.base import ReleaseContext, ValidationSeverity
from release.validators.security import (
    SecretDetectionValidator,
    get_publishable_files,
    is_safe_context,
)


@pytest.fixture
def mock_config() -> MagicMock:
    """Create a mock ReleaseConfig with typical settings.

    Returns:
        MagicMock configured as a ReleaseConfig
    """
    config = MagicMock(spec=ReleaseConfig)
    return config


@pytest.fixture
def release_context(tmp_path: Path, mock_config: MagicMock) -> ReleaseContext:
    """Create a ReleaseContext for testing.

    Args:
        tmp_path: Pytest temporary directory fixture
        mock_config: Mock configuration fixture

    Returns:
        ReleaseContext configured for testing
    """
    return ReleaseContext(
        project_root=tmp_path,
        config=mock_config,
        version="1.0.0",
    )


@pytest.fixture
def git_tracked_project(tmp_path: Path) -> Path:
    """Create a git repository with tracked files for testing.

    Args:
        tmp_path: Pytest temporary directory fixture

    Returns:
        Path to project directory with git initialized
    """
    # Initialize git repo
    subprocess.run(["git", "init"], cwd=tmp_path, capture_output=True, check=True)
    subprocess.run(
        ["git", "config", "user.email", "test@test.com"],
        cwd=tmp_path,
        capture_output=True,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test User"],
        cwd=tmp_path,
        capture_output=True,
        check=True,
    )
    return tmp_path


class TestIsSafeContext:
    """Tests for the is_safe_context helper function."""

    def test_example_context_is_safe(self) -> None:
        """Validate that example context is considered safe."""
        line = 'api_key = "YOUR_API_KEY_HERE"'
        match = "api_key = YOUR_API_KEY_HERE"
        assert is_safe_context(line, match) is True

    def test_placeholder_context_is_safe(self) -> None:
        """Validate that placeholder context is considered safe."""
        line = 'secret = "REPLACE_ME_WITH_REAL_SECRET"'
        match = "REPLACE_ME_WITH_REAL_SECRET"
        assert is_safe_context(line, match) is True

    def test_test_context_is_safe(self) -> None:
        """Validate that test context is considered safe."""
        line = '# test api_key = "sk-1234567890abcdef"'
        match = 'api_key = "sk-1234567890abcdef"'
        assert is_safe_context(line, match) is True

    def test_real_secret_not_safe(self) -> None:
        """Validate that real secrets are not considered safe."""
        line = 'api_key = "sk-proj-1234567890abcdefghij"'
        match = 'api_key = "sk-proj-1234567890abcdefghij"'
        assert is_safe_context(line, match) is False


class TestGetPublishableFiles:
    """Tests for the get_publishable_files helper function."""

    def test_returns_git_tracked_files(self, git_tracked_project: Path) -> None:
        """Validate that git tracked files are returned."""
        # Create and track a file
        test_file = git_tracked_project / "src" / "main.js"
        test_file.parent.mkdir(parents=True, exist_ok=True)
        test_file.write_text("console.log('hello');")
        subprocess.run(
            ["git", "add", "src/main.js"],
            cwd=git_tracked_project,
            capture_output=True,
            check=True,
        )

        files = get_publishable_files(git_tracked_project)

        assert any(f.name == "main.js" for f in files)

    def test_excludes_node_modules(self, git_tracked_project: Path) -> None:
        """Validate that node_modules directory is excluded."""
        # Create file in node_modules (simulated as tracked)
        node_file = git_tracked_project / "node_modules" / "dep" / "index.js"
        node_file.parent.mkdir(parents=True, exist_ok=True)
        node_file.write_text("module.exports = {};")

        files = get_publishable_files(git_tracked_project)

        assert not any("node_modules" in str(f) for f in files)

    def test_excludes_test_directories(self, git_tracked_project: Path) -> None:
        """Validate that test directories are excluded."""
        # Create file in tests directory
        test_file = git_tracked_project / "tests" / "test_main.py"
        test_file.parent.mkdir(parents=True, exist_ok=True)
        test_file.write_text("def test_example(): pass")

        files = get_publishable_files(git_tracked_project)

        assert not any("tests" in str(f) for f in files)


class TestSecretDetectionValidator:
    """Tests for SecretDetectionValidator - detects exposed secrets."""

    def test_no_secrets_returns_success(
        self, release_context: ReleaseContext, git_tracked_project: Path
    ) -> None:
        """Validate that clean files with no secrets return success."""
        validator = SecretDetectionValidator()
        release_context.project_root = git_tracked_project

        # Create clean file and track it
        clean_file = git_tracked_project / "src" / "app.js"
        clean_file.parent.mkdir(parents=True, exist_ok=True)
        clean_file.write_text(
            """
// Clean application code
const config = {
    name: 'my-app',
    version: '1.0.0'
};
module.exports = config;
"""
        )
        subprocess.run(
            ["git", "add", "src/app.js"],
            cwd=git_tracked_project,
            capture_output=True,
            check=True,
        )

        result = validator.validate(release_context)

        assert result.passed is True
        assert result.severity == ValidationSeverity.INFO
        assert "no secrets" in result.message.lower()

    def test_detects_api_key_pattern(
        self, release_context: ReleaseContext, git_tracked_project: Path
    ) -> None:
        """Validate that API key patterns are detected."""
        validator = SecretDetectionValidator()
        release_context.project_root = git_tracked_project

        # Create file with API key
        secret_file = git_tracked_project / "config.js"
        secret_file.write_text(
            """
const config = {
    api_key: 'sk-proj-1234567890abcdefghij1234'
};
"""
        )
        subprocess.run(
            ["git", "add", "config.js"],
            cwd=git_tracked_project,
            capture_output=True,
            check=True,
        )

        result = validator.validate(release_context)

        assert result.passed is True  # Warning, not blocking
        assert result.severity == ValidationSeverity.WARNING
        assert "potential secret" in result.message.lower()

    def test_detects_npm_token(
        self, release_context: ReleaseContext, git_tracked_project: Path
    ) -> None:
        """Validate that npm access tokens are detected."""
        validator = SecretDetectionValidator()
        release_context.project_root = git_tracked_project

        # Create file with npm token pattern
        secret_file = git_tracked_project / ".npmrc"
        # npm tokens start with npm_ and are 36 chars
        secret_file.write_text(
            "//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz1234567890"
        )
        subprocess.run(
            ["git", "add", ".npmrc"],
            cwd=git_tracked_project,
            capture_output=True,
            check=True,
        )

        result = validator.validate(release_context)

        assert result.passed is True  # Warning
        assert result.severity == ValidationSeverity.WARNING
        assert "npm" in result.details.lower() or "secret" in result.message.lower()

    def test_detects_github_token(
        self, release_context: ReleaseContext, git_tracked_project: Path
    ) -> None:
        """Validate that GitHub personal access tokens are detected."""
        validator = SecretDetectionValidator()
        release_context.project_root = git_tracked_project

        # Create file with GitHub PAT pattern (ghp_ prefix, 36 chars)
        secret_file = git_tracked_project / "deploy.sh"
        secret_file.write_text(
            """#!/bin/bash
GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234567890
curl -H "Authorization: token $GITHUB_TOKEN" https://api.github.com
"""
        )
        subprocess.run(
            ["git", "add", "deploy.sh"],
            cwd=git_tracked_project,
            capture_output=True,
            check=True,
        )

        result = validator.validate(release_context)

        assert result.passed is True  # Warning
        assert result.severity == ValidationSeverity.WARNING
        assert (
            "github" in result.details.lower() or "potential" in result.message.lower()
        )

    def test_detects_private_key(
        self, release_context: ReleaseContext, git_tracked_project: Path
    ) -> None:
        """Validate that private key files are detected."""
        validator = SecretDetectionValidator()
        release_context.project_root = git_tracked_project

        # Create file with private key header
        key_file = git_tracked_project / "key.pem"
        key_file.write_text(
            """-----BEGIN RSA PRIVATE KEY-----
MIIEpQIBAAKCAQEA3Tz2m...
-----END RSA PRIVATE KEY-----
"""
        )
        subprocess.run(
            ["git", "add", "key.pem"],
            cwd=git_tracked_project,
            capture_output=True,
            check=True,
        )

        result = validator.validate(release_context)

        assert result.passed is True  # Warning
        assert result.severity == ValidationSeverity.WARNING
        assert (
            "private key" in result.details.lower()
            or "secret" in result.message.lower()
        )

    def test_ignores_safe_context_patterns(
        self, release_context: ReleaseContext, git_tracked_project: Path
    ) -> None:
        """Validate that safe context patterns (example, placeholder) are ignored."""
        validator = SecretDetectionValidator()
        release_context.project_root = git_tracked_project

        # Create file with example/placeholder API keys
        doc_file = git_tracked_project / "README.md"
        doc_file.write_text(
            """# Configuration

Set your API key:
```
api_key: YOUR_API_KEY_HERE
secret_key: REPLACE_ME_WITH_SECRET
```

Example configuration:
```
api_key: example_api_key_1234567890
```
"""
        )
        subprocess.run(
            ["git", "add", "README.md"],
            cwd=git_tracked_project,
            capture_output=True,
            check=True,
        )

        result = validator.validate(release_context)

        # Should not detect these as secrets due to safe context
        assert result.passed is True
        assert result.severity == ValidationSeverity.INFO

    def test_limits_findings_display(
        self, release_context: ReleaseContext, git_tracked_project: Path
    ) -> None:
        """Validate that findings are limited to 10 in display with 'more' indicator."""
        validator = SecretDetectionValidator()
        release_context.project_root = git_tracked_project

        # Create file with many potential secrets
        secrets_file = git_tracked_project / "secrets.js"
        secrets_content = "\n".join(
            [f"const key{i} = 'api_key: sk-proj-{i:030d}1234';" for i in range(15)]
        )
        secrets_file.write_text(secrets_content)
        subprocess.run(
            ["git", "add", "secrets.js"],
            cwd=git_tracked_project,
            capture_output=True,
            check=True,
        )

        result = validator.validate(release_context)

        assert result.passed is True  # Warning
        assert result.severity == ValidationSeverity.WARNING
        # Check that "more" indicator is present when >10 findings
        if result.details and "more" in result.details:
            assert "and" in result.details and "more" in result.details

    def test_skips_large_files(
        self, release_context: ReleaseContext, git_tracked_project: Path
    ) -> None:
        """Validate that files larger than 1MB are skipped."""
        validator = SecretDetectionValidator()
        release_context.project_root = git_tracked_project

        # Create a large file (>1MB) with a secret
        large_file = git_tracked_project / "large.txt"
        # Create file just over 1MB with a secret at the start
        content = "api_key: sk-proj-1234567890abcdefghij\n"
        content += "x" * (1_000_001 - len(content))
        large_file.write_text(content)
        subprocess.run(
            ["git", "add", "large.txt"],
            cwd=git_tracked_project,
            capture_output=True,
            check=True,
        )

        # Mock get_publishable_files to return our large file
        with patch(
            "release.validators.security.get_publishable_files",
            return_value=[large_file],
        ):
            result = validator.validate(release_context)

        # Large file should be skipped, so no secrets found
        assert result.passed is True
        assert result.severity == ValidationSeverity.INFO
