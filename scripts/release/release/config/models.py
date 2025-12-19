"""Pydantic v2 configuration models for release_conf.yml.

These models provide:
- Type-safe configuration loading
- Automatic validation
- Default values
- Environment variable override support

Models match the actual release_conf.yml structure used by the bash script.
"""

from typing import Literal

from pydantic import BaseModel, Field, field_validator
from pydantic_settings import BaseSettings


class ProjectConfig(BaseModel):
    """Project identification and ecosystem configuration."""

    name: str = Field(description="Project name")
    description: str = Field(default="", description="Project description")
    ecosystem: str = Field(
        default="node",
        description="Primary ecosystem (node, python, rust, etc.)",
    )


class VersionConfig(BaseModel):
    """Version management configuration."""

    file: str = Field(
        default="package.json",
        description="File containing the version",
    )
    field: str = Field(
        default="version",
        description="Field name in version file",
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


class ToolsConfig(BaseModel):
    """Package manager and tool configuration."""

    package_manager: str = Field(
        default="pnpm",
        description="Package manager (npm, pnpm, yarn, bun)",
    )
    node_version: str = Field(
        default="24",
        description="Node.js version to use",
    )


class GitConfig(BaseModel):
    """Git workflow configuration."""

    main_branch: str = Field(
        default="main",
        description="Main branch name",
    )
    remote: str = Field(
        default="origin",
        description="Git remote name",
    )
    sign_commits: bool = Field(
        default=False,
        description="GPG sign commits",
    )
    sign_tags: bool = Field(
        default=False,
        description="GPG sign tags",
    )


class GitHubConfig(BaseModel):
    """GitHub repository and release configuration."""

    owner: str = Field(description="GitHub repository owner")
    repo: str = Field(description="GitHub repository name")
    release_target: Literal["commit_sha", "branch"] = Field(
        default="commit_sha",
        description="Target for GitHub release (commit_sha or branch)",
    )
    draft: bool = Field(
        default=False,
        description="Create release as draft",
    )
    prerelease: bool = Field(
        default=False,
        description="Mark release as prerelease",
    )


class LintCheckConfig(BaseModel):
    """Lint check configuration."""

    enabled: bool = Field(default=True, description="Enable lint check")
    command: str = Field(
        default="pnpm run lint",
        description="Lint command",
    )
    auto_fix_command: str | None = Field(
        default=None,
        description="Command to auto-fix lint issues",
    )


class TypecheckConfig(BaseModel):
    """Type check configuration."""

    enabled: bool = Field(default=True, description="Enable type check")
    command: str = Field(
        default="pnpm run typecheck",
        description="Type check command",
    )


class TestsCheckConfig(BaseModel):
    """Test execution configuration."""

    enabled: bool = Field(default=True, description="Enable tests")
    mode: Literal["full", "selective"] = Field(
        default="full",
        description="Test mode (full or selective)",
    )
    full_command: str = Field(
        default="pnpm test",
        description="Full test command",
    )
    selective_command: str | None = Field(
        default=None,
        description="Selective test command",
    )


class E2ECheckConfig(BaseModel):
    """E2E test configuration."""

    enabled: bool = Field(default=False, description="Enable E2E tests")
    command: str = Field(
        default="pnpm run test:e2e",
        description="E2E test command",
    )


class BuildCheckConfig(BaseModel):
    """Build check configuration."""

    enabled: bool = Field(default=True, description="Enable build check")
    command: str = Field(
        default="pnpm run build",
        description="Build command",
    )
    output_files: list[str] = Field(
        default_factory=list,
        description="Expected output files to verify",
    )


class QualityChecksConfig(BaseModel):
    """Quality check configuration."""

    lint: LintCheckConfig = Field(default_factory=LintCheckConfig)
    typecheck: TypecheckConfig = Field(default_factory=TypecheckConfig)
    tests: TestsCheckConfig = Field(default_factory=TestsCheckConfig)
    e2e: E2ECheckConfig = Field(default_factory=E2ECheckConfig)
    build: BuildCheckConfig = Field(default_factory=BuildCheckConfig)


class WorkflowConfig(BaseModel):
    """CI workflow configuration."""

    name: str = Field(default="CI", description="Workflow name")
    timeout_seconds: int = Field(
        default=900,
        ge=60,
        description="Workflow timeout in seconds",
    )
    poll_interval_seconds: int = Field(
        default=10,
        ge=5,
        description="Poll interval in seconds",
    )


class CIConfig(BaseModel):
    """CI/CD workflow monitoring configuration."""

    platforms: str = Field(
        default="github",
        description="CI platforms (github, gitlab, etc.)",
    )
    workflow: WorkflowConfig = Field(default_factory=WorkflowConfig)
    publish: WorkflowConfig = Field(
        default_factory=lambda: WorkflowConfig(
            name="Publish to npm",
            timeout_seconds=900,
            poll_interval_seconds=10,
        )
    )


class NPMConfig(BaseModel):
    """npm publishing configuration."""

    registry: str = Field(
        default="https://registry.npmjs.org",
        description="npm registry URL",
    )
    access: Literal["public", "restricted"] = Field(
        default="public",
        description="Package access level",
    )
    publish_method: Literal["oidc", "token"] = Field(
        default="oidc",
        description="Publishing authentication method",
    )


class ReleaseNotesConfig(BaseModel):
    """Release notes generation configuration."""

    generator: str = Field(
        default="git-cliff",
        description="Release notes generator",
    )
    config_file: str = Field(
        default="cliff.toml",
        description="Generator config file",
    )


class TimeoutsConfig(BaseModel):
    """Timeout configuration in seconds."""

    git_operations: int = Field(
        default=30,
        ge=10,
        description="Git operation timeout",
    )
    npm_operations: int = Field(
        default=60,
        ge=10,
        description="npm operation timeout",
    )
    test_execution: int = Field(
        default=600,
        ge=60,
        description="Test execution timeout",
    )
    ci_workflow: int = Field(
        default=900,
        ge=60,
        description="CI workflow timeout",
    )
    publish_workflow: int = Field(
        default=900,
        ge=60,
        description="Publish workflow timeout",
    )
    npm_propagation: int = Field(
        default=300,
        ge=60,
        description="npm propagation timeout",
    )


class SafetyConfig(BaseModel):
    """Safety and confirmation settings."""

    require_clean_worktree: bool = Field(
        default=True,
        description="Require clean git working tree",
    )
    require_main_branch: bool = Field(
        default=True,
        description="Require being on main branch",
    )
    require_ci_pass: bool = Field(
        default=True,
        description="Require CI to pass before release",
    )
    auto_rollback_on_failure: bool = Field(
        default=True,
        description="Auto rollback on release failure",
    )
    confirm_before_push: bool = Field(
        default=False,
        description="Require confirmation before push",
    )


class ReleaseConfig(BaseSettings):
    """Root configuration model for release_conf.yml.

    Supports environment variable overrides with RELEASE_ prefix.
    Example: RELEASE_GIT__MAIN_BRANCH=develop
    """

    project: ProjectConfig
    version: VersionConfig = Field(default_factory=VersionConfig)
    tools: ToolsConfig = Field(default_factory=ToolsConfig)
    git: GitConfig = Field(default_factory=GitConfig)
    github: GitHubConfig
    quality_checks: QualityChecksConfig = Field(default_factory=QualityChecksConfig)
    ci: CIConfig = Field(default_factory=CIConfig)
    npm: NPMConfig = Field(default_factory=NPMConfig)
    release_notes: ReleaseNotesConfig = Field(default_factory=ReleaseNotesConfig)
    timeouts: TimeoutsConfig = Field(default_factory=TimeoutsConfig)
    safety: SafetyConfig = Field(default_factory=SafetyConfig)
    publishers: list[str] = Field(
        default_factory=list,
        description="List of discovered/configured publishers (npm, homebrew, github, pypi, crates, docker)",
    )

    model_config = {
        "env_prefix": "RELEASE_",
        "env_nested_delimiter": "__",
    }
