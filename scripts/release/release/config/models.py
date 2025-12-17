"""Pydantic v2 configuration models for release_conf.yml.

These models provide:
- Type-safe configuration loading
- Automatic validation
- Default values
- Environment variable override support
"""

from typing import Literal

from pydantic import BaseModel, Field, field_validator
from pydantic_settings import BaseSettings


class ProjectConfig(BaseModel):
    """Project identification and ecosystem configuration."""

    name: str = Field(description="Project name")
    description: str = Field(default="", description="Project description")
    ecosystems: list[str] = Field(
        default_factory=list,
        description="List of ecosystems (nodejs, python, rust, etc.)",
    )
    primary_ecosystem: str | None = Field(
        default=None,
        description="Primary ecosystem for version source",
    )


class VersionConfig(BaseModel):
    """Version management configuration."""

    source: Literal[
        "package.json",
        "pyproject.toml",
        "Cargo.toml",
        "version.txt",
        "VERSION",
    ] = Field(
        default="package.json",
        description="File containing the version",
    )
    pattern: str = Field(
        default=r"^\d+\.\d+\.\d+$",
        description="Regex pattern for valid versions",
    )
    tag_prefix: str = Field(
        default="v",
        description="Prefix for git tags (e.g., 'v' for v1.0.0)",
    )

    @field_validator("tag_prefix")
    @classmethod
    def validate_tag_prefix(cls, v: str) -> str:
        if v and not v.isalnum() and v != "":
            raise ValueError("tag_prefix must be alphanumeric or empty")
        return v


class ToolConfig(BaseModel):
    """External tool configuration."""

    minifier: str | None = Field(
        default=None,
        description="Minifier command (e.g., 'terser')",
    )
    linter: str | None = Field(
        default=None,
        description="Linter command (e.g., 'eslint', 'ruff')",
    )
    formatter: str | None = Field(
        default=None,
        description="Formatter command (e.g., 'prettier', 'ruff format')",
    )
    type_checker: str | None = Field(
        default=None,
        description="Type checker command (e.g., 'tsc', 'mypy')",
    )
    test_runner: str | None = Field(
        default=None,
        description="Test runner command (e.g., 'vitest', 'pytest')",
    )
    changelog_generator: str = Field(
        default="git-cliff",
        description="Changelog generator command",
    )


class GitConfig(BaseModel):
    """Git workflow configuration."""

    main_branch: str = Field(
        default="main",
        description="Main branch name",
    )
    require_clean: bool = Field(
        default=True,
        description="Require clean working directory",
    )
    require_main_branch: bool = Field(
        default=True,
        description="Require being on main branch",
    )
    sign_tags: bool = Field(
        default=False,
        description="Sign git tags with GPG",
    )
    sign_commits: bool = Field(
        default=False,
        description="Sign commits with GPG",
    )


class GitHubConfig(BaseModel):
    """GitHub release configuration."""

    create_release: bool = Field(
        default=True,
        description="Create GitHub release",
    )
    upload_assets: list[str] = Field(
        default_factory=list,
        description="Files to upload as release assets",
    )
    draft: bool = Field(
        default=False,
        description="Create release as draft",
    )
    prerelease: bool = Field(
        default=False,
        description="Mark release as prerelease",
    )


class QualityChecksConfig(BaseModel):
    """Quality check configuration."""

    lint: bool = Field(default=True, description="Run linter")
    typecheck: bool = Field(default=True, description="Run type checker")
    test: bool = Field(default=True, description="Run tests")
    coverage_threshold: float = Field(
        default=80.0,
        ge=0.0,
        le=100.0,
        description="Minimum coverage percentage",
    )
    security_scan: bool = Field(
        default=True,
        description="Run security scan for secrets",
    )


class CIConfig(BaseModel):
    """CI workflow monitoring configuration."""

    wait_for_ci: bool = Field(
        default=True,
        description="Wait for CI workflows to complete",
    )
    required_workflows: list[str] = Field(
        default_factory=lambda: ["CI"],
        description="Workflow names that must pass",
    )
    timeout_minutes: int = Field(
        default=15,
        ge=1,
        le=60,
        description="CI timeout in minutes",
    )


class NPMConfig(BaseModel):
    """npm publishing configuration."""

    access: Literal["public", "restricted"] = Field(
        default="public",
        description="Package access level",
    )
    registry: str = Field(
        default="https://registry.npmjs.org",
        description="npm registry URL",
    )
    trusted_publishing: bool = Field(
        default=True,
        description="Use OIDC trusted publishing",
    )


class ReleaseNotesConfig(BaseModel):
    """Release notes generation configuration."""

    generator: str = Field(
        default="git-cliff",
        description="Release notes generator",
    )
    template: str | None = Field(
        default=None,
        description="Custom template path",
    )
    include_contributors: bool = Field(
        default=True,
        description="Include contributor list",
    )


class TimeoutsConfig(BaseModel):
    """Timeout configuration in seconds."""

    ci_workflow: int = Field(
        default=900,
        ge=60,
        description="CI workflow timeout (default 15 min)",
    )
    publish_workflow: int = Field(
        default=300,
        ge=60,
        description="Publish workflow timeout (default 5 min)",
    )
    npm_verification: int = Field(
        default=60,
        ge=10,
        description="npm verification timeout (default 1 min)",
    )


class SafetyConfig(BaseModel):
    """Safety and confirmation settings."""

    dry_run: bool = Field(
        default=False,
        description="Show what would be done without making changes",
    )
    require_confirmation: bool = Field(
        default=True,
        description="Require user confirmation before release",
    )
    backup_before_release: bool = Field(
        default=True,
        description="Create backup before making changes",
    )


class ReleaseConfig(BaseSettings):
    """Root configuration model for release_conf.yml.

    Supports environment variable overrides with RELEASE_ prefix.
    Example: RELEASE_GIT__MAIN_BRANCH=develop
    """

    project: ProjectConfig
    version: VersionConfig = Field(default_factory=VersionConfig)
    tools: ToolConfig = Field(default_factory=ToolConfig)
    git: GitConfig = Field(default_factory=GitConfig)
    github: GitHubConfig = Field(default_factory=GitHubConfig)
    quality_checks: QualityChecksConfig = Field(default_factory=QualityChecksConfig)
    ci: CIConfig = Field(default_factory=CIConfig)
    npm: NPMConfig = Field(default_factory=NPMConfig)
    release_notes: ReleaseNotesConfig = Field(default_factory=ReleaseNotesConfig)
    timeouts: TimeoutsConfig = Field(default_factory=TimeoutsConfig)
    safety: SafetyConfig = Field(default_factory=SafetyConfig)

    model_config = {
        "env_prefix": "RELEASE_",
        "env_nested_delimiter": "__",
    }
