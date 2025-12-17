"""Default configuration generation.

Provides functions to generate default configuration files
based on detected project ecosystems.
"""

from pathlib import Path
from typing import Any

import yaml


def detect_ecosystems(project_root: Path) -> list[str]:
    """Detect ecosystems present in the project.

    Args:
        project_root: Project root directory

    Returns:
        List of detected ecosystem names
    """
    ecosystems = []

    # Node.js
    if (project_root / "package.json").exists():
        ecosystems.append("nodejs")

    # Python
    if (project_root / "pyproject.toml").exists() or (
        project_root / "setup.py"
    ).exists():
        ecosystems.append("python")

    # Rust
    if (project_root / "Cargo.toml").exists():
        ecosystems.append("rust")

    # Go
    if (project_root / "go.mod").exists():
        ecosystems.append("go")

    # Ruby - gemspec files are named <project>.gemspec, not .gemspec
    if (project_root / "Gemfile").exists() or any(project_root.glob("*.gemspec")):
        ecosystems.append("ruby")

    # Java (Maven)
    if (project_root / "pom.xml").exists():
        ecosystems.append("java-maven")

    # Java (Gradle)
    if (project_root / "build.gradle").exists() or (
        project_root / "build.gradle.kts"
    ).exists():
        ecosystems.append("java-gradle")

    # .NET - use any() for efficient short-circuit evaluation
    if any(project_root.glob("*.csproj")) or any(project_root.glob("*.fsproj")):
        ecosystems.append("dotnet")

    # PHP
    if (project_root / "composer.json").exists():
        ecosystems.append("php")

    # Elixir
    if (project_root / "mix.exs").exists():
        ecosystems.append("elixir")

    # Swift
    if (project_root / "Package.swift").exists():
        ecosystems.append("swift")

    return ecosystems


def get_version_source(ecosystems: list[str]) -> str:
    """Determine version source file based on ecosystems.

    Args:
        ecosystems: List of detected ecosystems

    Returns:
        Version source file name
    """
    # Priority order for version source
    if "nodejs" in ecosystems:
        return "package.json"
    if "python" in ecosystems:
        return "pyproject.toml"
    if "rust" in ecosystems:
        return "Cargo.toml"
    return "VERSION"


def generate_default_config(
    project_root: Path,
    project_name: str | None = None,
) -> dict[str, Any]:
    """Generate default configuration based on detected project.

    Args:
        project_root: Project root directory
        project_name: Override project name (auto-detected from folder name)

    Returns:
        Configuration dictionary
    """
    if project_name is None:
        project_name = project_root.name

    ecosystems = detect_ecosystems(project_root)
    primary = ecosystems[0] if ecosystems else None

    return {
        "project": {
            "name": project_name,
            "description": "",
            "ecosystems": ecosystems,
            "primary_ecosystem": primary,
        },
        "version": {
            "source": get_version_source(ecosystems),
            "pattern": r"^\d+\.\d+\.\d+$",
            "tag_prefix": "v",
        },
        "tools": {
            "changelog_generator": "git-cliff",
        },
        "git": {
            "main_branch": "main",
            "require_clean": True,
            "require_main_branch": True,
        },
        "github": {
            "create_release": True,
            "upload_assets": [],
        },
        "quality_checks": {
            "lint": True,
            "typecheck": True,
            "test": True,
            "coverage_threshold": 80.0,
            "security_scan": True,
        },
        "ci": {
            "wait_for_ci": True,
            "required_workflows": ["CI"],
            "timeout_minutes": 15,
        },
        "timeouts": {
            "ci_workflow": 900,
            "publish_workflow": 300,
            "npm_verification": 60,
        },
        "safety": {
            "dry_run": False,
            "require_confirmation": True,
            "backup_before_release": True,
        },
    }


def write_default_config(
    output_path: Path,
    project_root: Path | None = None,
    project_name: str | None = None,
) -> None:
    """Generate and write default configuration file.

    Args:
        output_path: Path to write configuration
        project_root: Project root directory (defaults to cwd)
        project_name: Override project name

    Raises:
        ConfigurationError: If file cannot be written (permissions, disk full, etc.)
    """
    from release.exceptions import ConfigurationError

    if project_root is None:
        project_root = Path.cwd()

    config = generate_default_config(project_root, project_name)

    try:
        # Create parent directory if needed
        output_path.parent.mkdir(parents=True, exist_ok=True)

        with open(output_path, "w", encoding="utf-8") as f:
            yaml.safe_dump(
                config,
                f,
                default_flow_style=False,
                sort_keys=False,
                allow_unicode=True,
            )
    except PermissionError:
        raise ConfigurationError(
            f"Permission denied writing config to {output_path}",
            fix_hint="Check file permissions or use a different location",
        ) from None
    except OSError as e:
        raise ConfigurationError(
            f"Failed to write config to {output_path}",
            details=str(e),
            fix_hint="Check disk space and path validity",
        ) from e
