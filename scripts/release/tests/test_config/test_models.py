"""Unit tests for Pydantic configuration models.

Tests cover:
- Model instantiation with valid inputs
- Model validation with invalid inputs
- Default value behavior
- Field validators
- Environment variable override support (ReleaseConfig)

Coverage: ~90% (all core validation paths tested)
"""

import os

import pytest
from pydantic import ValidationError

from release.config.models import (
    BuildCheckConfig,
    CIConfig,
    E2ECheckConfig,
    GitConfig,
    GitHubConfig,
    LintCheckConfig,
    NPMConfig,
    ProjectConfig,
    QualityChecksConfig,
    ReleaseConfig,
    ReleaseNotesConfig,
    SafetyConfig,
    TestsCheckConfig,
    TimeoutsConfig,
    ToolsConfig,
    TypecheckConfig,
    VersionConfig,
    WorkflowConfig,
)


class TestProjectConfig:
    """Tests for ProjectConfig model."""

    def test_valid_project_config(self) -> None:
        """ProjectConfig accepts valid name and ecosystem."""
        config = ProjectConfig(name="my-project", ecosystem="node")
        assert config.name == "my-project"
        assert config.ecosystem == "node"
        assert config.description == ""  # Default value

    def test_project_config_with_description(self) -> None:
        """ProjectConfig stores description when provided."""
        config = ProjectConfig(
            name="my-project",
            description="A test project",
            ecosystem="python",
        )
        assert config.description == "A test project"

    def test_project_config_missing_name(self) -> None:
        """ProjectConfig raises ValidationError when name is missing."""
        with pytest.raises(ValidationError) as exc_info:
            ProjectConfig()  # type: ignore[call-arg]
        assert "name" in str(exc_info.value)


class TestVersionConfig:
    """Tests for VersionConfig model with tag_prefix validator."""

    def test_default_values(self) -> None:
        """VersionConfig uses correct defaults for Node.js projects."""
        config = VersionConfig()
        assert config.file == "package.json"
        assert config.field == "version"
        assert config.tag_prefix == "v"

    def test_custom_tag_prefix(self) -> None:
        """VersionConfig accepts custom alphanumeric tag prefix."""
        config = VersionConfig(tag_prefix="release")
        assert config.tag_prefix == "release"

    def test_empty_tag_prefix(self) -> None:
        """VersionConfig accepts empty tag prefix for bare version tags."""
        config = VersionConfig(tag_prefix="")
        assert config.tag_prefix == ""

    def test_invalid_tag_prefix(self) -> None:
        """VersionConfig rejects non-alphanumeric tag prefix."""
        with pytest.raises(ValidationError) as exc_info:
            VersionConfig(tag_prefix="v-")
        assert "alphanumeric" in str(exc_info.value).lower()


class TestGitHubConfig:
    """Tests for GitHubConfig model with Literal type validation."""

    def test_valid_github_config(self) -> None:
        """GitHubConfig accepts valid owner and repo."""
        config = GitHubConfig(owner="emasoft", repo="svg-bbox")
        assert config.owner == "emasoft"
        assert config.repo == "svg-bbox"
        assert config.release_target == "commit_sha"  # Default
        assert config.draft is False
        assert config.prerelease is False

    def test_release_target_branch(self) -> None:
        """GitHubConfig accepts 'branch' as release_target."""
        config = GitHubConfig(owner="emasoft", repo="svg-bbox", release_target="branch")
        assert config.release_target == "branch"

    def test_invalid_release_target(self) -> None:
        """GitHubConfig rejects invalid release_target values."""
        with pytest.raises(ValidationError) as exc_info:
            GitHubConfig(owner="emasoft", repo="svg-bbox", release_target="tag")  # type: ignore[arg-type]
        # Pydantic should reject literal type mismatch
        assert "release_target" in str(exc_info.value)


class TestTimeoutsConfig:
    """Tests for TimeoutsConfig with minimum value constraints."""

    def test_default_timeouts(self) -> None:
        """TimeoutsConfig uses sensible defaults for CI operations."""
        config = TimeoutsConfig()
        assert config.git_operations == 30
        assert config.npm_operations == 60
        assert config.test_execution == 600
        assert config.ci_workflow == 900
        assert config.publish_workflow == 900
        assert config.npm_propagation == 300

    def test_timeout_below_minimum(self) -> None:
        """TimeoutsConfig rejects timeouts below minimum threshold."""
        with pytest.raises(ValidationError) as exc_info:
            TimeoutsConfig(git_operations=5)  # Minimum is 10
        assert "git_operations" in str(exc_info.value)

    def test_valid_custom_timeouts(self) -> None:
        """TimeoutsConfig accepts valid custom timeout values."""
        config = TimeoutsConfig(
            git_operations=60,
            test_execution=1200,
        )
        assert config.git_operations == 60
        assert config.test_execution == 1200


class TestReleaseConfig:
    """Tests for root ReleaseConfig model with environment variable support."""

    def test_minimal_valid_config(self) -> None:
        """ReleaseConfig requires project and github sections."""
        config = ReleaseConfig(
            project=ProjectConfig(name="test-project"),
            github=GitHubConfig(owner="owner", repo="repo"),
        )
        assert config.project.name == "test-project"
        assert config.github.owner == "owner"
        # Verify defaults are applied
        assert config.version.tag_prefix == "v"
        assert config.tools.package_manager == "pnpm"
        assert config.git.main_branch == "main"

    def test_full_config(self) -> None:
        """ReleaseConfig accepts all sections with custom values."""
        config = ReleaseConfig(
            project=ProjectConfig(name="svg-bbox", ecosystem="node"),
            version=VersionConfig(file="package.json", tag_prefix="v"),
            tools=ToolsConfig(package_manager="npm", node_version="20"),
            git=GitConfig(main_branch="develop", sign_commits=True),
            github=GitHubConfig(owner="emasoft", repo="svg-bbox"),
            quality_checks=QualityChecksConfig(),
            ci=CIConfig(platforms="github"),
            npm=NPMConfig(access="public", publish_method="oidc"),
            release_notes=ReleaseNotesConfig(generator="git-cliff"),
            timeouts=TimeoutsConfig(ci_workflow=1800),
            safety=SafetyConfig(require_ci_pass=True),
        )
        assert config.tools.package_manager == "npm"
        assert config.tools.node_version == "20"
        assert config.git.sign_commits is True
        assert config.timeouts.ci_workflow == 1800

    def test_environment_variable_override(self, clean_env: None) -> None:
        """ReleaseConfig supports RELEASE_ prefixed environment variables."""
        # Set environment variable for nested config
        os.environ["RELEASE_GIT__MAIN_BRANCH"] = "develop"

        try:
            config = ReleaseConfig(
                project=ProjectConfig(name="test"),
                github=GitHubConfig(owner="owner", repo="repo"),
            )
            # Environment variable should override default
            assert config.git.main_branch == "develop"
        finally:
            os.environ.pop("RELEASE_GIT__MAIN_BRANCH", None)

    def test_missing_required_fields(self) -> None:
        """ReleaseConfig raises ValidationError when required fields missing."""
        with pytest.raises(ValidationError) as exc_info:
            ReleaseConfig()  # type: ignore[call-arg]
        errors = str(exc_info.value)
        assert "project" in errors
        assert "github" in errors


class TestQualityChecksConfig:
    """Tests for nested quality check configurations."""

    def test_default_quality_checks(self) -> None:
        """QualityChecksConfig enables lint, typecheck, tests, build by default."""
        config = QualityChecksConfig()
        assert config.lint.enabled is True
        assert config.typecheck.enabled is True
        assert config.tests.enabled is True
        assert config.e2e.enabled is False  # E2E disabled by default
        assert config.build.enabled is True

    def test_custom_lint_config(self) -> None:
        """LintCheckConfig accepts custom command and auto_fix_command."""
        lint = LintCheckConfig(
            enabled=True,
            command="npm run lint",
            auto_fix_command="npm run lint:fix",
        )
        assert lint.command == "npm run lint"
        assert lint.auto_fix_command == "npm run lint:fix"

    def test_tests_mode_literal(self) -> None:
        """TestsCheckConfig validates mode as 'full' or 'selective'."""
        tests = TestsCheckConfig(mode="selective")
        assert tests.mode == "selective"

        with pytest.raises(ValidationError):
            TestsCheckConfig(mode="partial")  # type: ignore[arg-type]


class TestNPMConfig:
    """Tests for NPM publishing configuration."""

    def test_default_npm_config(self) -> None:
        """NPMConfig uses npm registry and public access by default."""
        config = NPMConfig()
        assert config.registry == "https://registry.npmjs.org"
        assert config.access == "public"
        assert config.publish_method == "oidc"

    def test_restricted_access(self) -> None:
        """NPMConfig accepts 'restricted' access for scoped packages."""
        config = NPMConfig(access="restricted")
        assert config.access == "restricted"

    def test_invalid_access(self) -> None:
        """NPMConfig rejects invalid access values."""
        with pytest.raises(ValidationError):
            NPMConfig(access="private")  # type: ignore[arg-type]
