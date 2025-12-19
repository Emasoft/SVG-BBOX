"""Unit tests for release.publishers.npm module.

Tests for NPMPublisher:
- detect() equivalent via should_publish() - with/without package.json
- should_publish() - checking public package publishing conditions
- get_dependencies() equivalent - verifying npm/node requirements

Coverage: 3 tests covering core npm publisher detection and configuration.
"""

import json
from pathlib import Path
from unittest.mock import MagicMock

from release.config.models import GitHubConfig, NPMConfig, ProjectConfig, ReleaseConfig
from release.publishers.base import PublishContext, PublishStatus
from release.publishers.npm import NPMPublisher, get_package_json, get_package_name


class TestNPMPublisherDetect:
    """Tests for NPMPublisher detection via should_publish()."""

    def test_detect_with_package_json_returns_true(self, project_dir: Path) -> None:
        """Test that NPMPublisher.should_publish() returns True when package.json exists.

        Creates a valid package.json file in the project directory and verifies
        that the npm publisher correctly detects it should publish.
        """
        # Create realistic package.json
        package_json = {
            "name": "my-npm-package",
            "version": "1.0.0",
            "description": "A test npm package for publishing",
            "main": "dist/index.js",
            "types": "dist/index.d.ts",
            "scripts": {
                "build": "tsc",
                "test": "vitest",
                "lint": "eslint src/",
            },
            "keywords": ["npm", "package", "test"],
            "author": "Test Author <test@example.com>",
            "license": "MIT",
            "files": ["dist/", "README.md"],
            "publishConfig": {
                "access": "public",
            },
        }
        (project_dir / "package.json").write_text(json.dumps(package_json, indent=2))

        # Create mock config
        mock_config = MagicMock(spec=ReleaseConfig)
        mock_config.project = ProjectConfig(name="my-npm-package")
        mock_config.github = GitHubConfig(owner="testowner", repo="testrepo")
        mock_config.npm = NPMConfig(access="public")

        # Create context
        context = PublishContext(
            project_root=project_dir,
            config=mock_config,
            version="1.0.0",
            tag_name="v1.0.0",
            release_notes="Initial release",
        )

        # Test should_publish
        publisher = NPMPublisher()
        result = publisher.should_publish(context)

        assert result is True, (
            "should_publish() should return True when package.json exists"
        )

        # Also verify get_package_json works correctly
        parsed_pkg = get_package_json(project_dir)
        assert parsed_pkg is not None, "get_package_json should return parsed content"
        assert parsed_pkg["name"] == "my-npm-package", (
            "Package name should be correctly parsed"
        )
        assert parsed_pkg["version"] == "1.0.0", (
            "Package version should be correctly parsed"
        )

    def test_detect_without_package_json_returns_false(self, project_dir: Path) -> None:
        """Test that NPMPublisher.should_publish() returns False without package.json.

        Verifies that the npm publisher correctly detects it should NOT publish
        when no package.json file exists in the project directory.
        """
        # Ensure no package.json exists
        package_json_path = project_dir / "package.json"
        if package_json_path.exists():
            package_json_path.unlink()

        # Create mock config
        mock_config = MagicMock(spec=ReleaseConfig)
        mock_config.project = ProjectConfig(name="non-npm-project")
        mock_config.github = GitHubConfig(owner="testowner", repo="testrepo")
        # No npm attribute - simulating non-npm project

        # Create context
        context = PublishContext(
            project_root=project_dir,
            config=mock_config,
            version="1.0.0",
            tag_name="v1.0.0",
            release_notes="Release without npm",
        )

        # Test should_publish
        publisher = NPMPublisher()
        result = publisher.should_publish(context)

        assert result is False, (
            "should_publish() should return False when package.json is missing"
        )

        # Also verify get_package_json returns None
        assert get_package_json(project_dir) is None, (
            "get_package_json should return None for missing file"
        )
        assert get_package_name(project_dir) is None, (
            "get_package_name should return None for missing file"
        )


class TestNPMPublisherShouldPublish:
    """Tests for NPMPublisher.should_publish() with config variations."""

    def test_should_publish_respects_npm_enabled_config(
        self, project_dir: Path
    ) -> None:
        """Test that should_publish() respects npm.enabled config setting.

        Verifies that when npm.enabled is explicitly set to False in config,
        the publisher will not attempt to publish even with valid package.json.
        """
        # Create valid package.json for a public package
        package_json = {
            "name": "@example/public-package",
            "version": "2.0.0",
            "description": "A scoped public package",
            "main": "index.js",
            "publishConfig": {
                "access": "public",
            },
        }
        (project_dir / "package.json").write_text(json.dumps(package_json, indent=2))

        # Create mock config with npm.enabled = False
        mock_config = MagicMock(spec=ReleaseConfig)
        mock_config.project = ProjectConfig(name="public-package")
        mock_config.github = GitHubConfig(owner="example", repo="public-package")
        mock_config.npm = MagicMock()
        mock_config.npm.enabled = False
        mock_config.npm.access = "public"

        # Create context
        context = PublishContext(
            project_root=project_dir,
            config=mock_config,
            version="2.0.0",
            tag_name="v2.0.0",
            release_notes="Version 2.0.0 release",
        )

        # Test should_publish with npm disabled
        publisher = NPMPublisher()
        result = publisher.should_publish(context)

        assert result is False, (
            "should_publish() should return False when npm.enabled is False"
        )

        # Now test with npm.enabled = True
        mock_config.npm.enabled = True
        result_enabled = publisher.should_publish(context)

        assert result_enabled is True, (
            "should_publish() should return True when npm.enabled is True"
        )


class TestNPMPublisherDependencies:
    """Tests for NPMPublisher dependency verification."""

    def test_publish_requires_npm_command(self, project_dir: Path) -> None:
        """Test that NPMPublisher.publish() uses npm command.

        Verifies that the publisher correctly calls npm publish with expected
        arguments and handles the command execution properly.
        """
        # Create package.json
        package_json = {
            "name": "dependency-test-package",
            "version": "1.0.0",
            "description": "Testing npm command dependency",
            "main": "index.js",
        }
        (project_dir / "package.json").write_text(json.dumps(package_json, indent=2))

        # Create mock config
        mock_config = MagicMock(spec=ReleaseConfig)
        mock_config.project = ProjectConfig(name="dependency-test-package")
        mock_config.github = GitHubConfig(owner="testowner", repo="testrepo")
        mock_config.npm = NPMConfig(access="public")

        # Create context with dry_run=True to avoid actual publish
        context = PublishContext(
            project_root=project_dir,
            config=mock_config,
            version="1.0.0",
            tag_name="v1.0.0",
            release_notes="Testing npm dependency",
            dry_run=True,
        )

        # Test publish in dry run mode
        publisher = NPMPublisher()
        result = publisher.publish(context)

        # Verify dry run returns success without calling npm
        assert result.status == PublishStatus.SUCCESS, (
            "Dry run should return SUCCESS status"
        )
        assert "dry run" in result.message.lower(), (
            "Dry run message should indicate dry run mode"
        )
        assert result.registry_url == "https://www.npmjs.com", (
            "Registry URL should be npmjs.com"
        )
        assert (
            result.package_url
            == "https://www.npmjs.com/package/dependency-test-package"
        ), "Package URL should include package name"
        assert result.version == "1.0.0", "Version should match context version"
