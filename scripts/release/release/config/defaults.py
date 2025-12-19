"""Default configuration generation.

Provides functions to generate default configuration files
based on detected project ecosystems, leveraging the discovery module
for comprehensive auto-detection.
"""

import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml


def get_git_remote_url(project_root: Path, remote: str = "origin") -> str | None:
    """Get the URL of a git remote.

    Args:
        project_root: Project root directory
        remote: Remote name (default: origin)

    Returns:
        Remote URL or None if not found
    """
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", remote],
            cwd=project_root,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass
    return None


def parse_github_url(url: str) -> tuple[str, str] | None:
    """Parse owner and repo from GitHub URL.

    Supports:
    - https://github.com/owner/repo.git
    - https://github.com/owner/repo
    - git@github.com:owner/repo.git
    - git@github.com:owner/repo
    - ssh://git@github.com/owner/repo.git

    Args:
        url: Git remote URL

    Returns:
        Tuple of (owner, repo) or None if not a GitHub URL
    """
    url = url.strip()

    # HTTPS format
    https_match = re.match(
        r"https?://(?:www\.)?github\.com/([^/]+)/([^/\s]+?)(?:\.git)?$", url
    )
    if https_match:
        return (https_match.group(1), https_match.group(2))

    # SSH format: git@github.com:owner/repo.git
    ssh_match = re.match(r"git@github\.com:([^/]+)/([^/\s]+?)(?:\.git)?$", url)
    if ssh_match:
        return (ssh_match.group(1), ssh_match.group(2))

    # SSH with protocol: ssh://git@github.com/owner/repo.git
    ssh_proto_match = re.match(
        r"ssh://git@github\.com/([^/]+)/([^/\s]+?)(?:\.git)?$", url
    )
    if ssh_proto_match:
        return (ssh_proto_match.group(1), ssh_proto_match.group(2))

    return None


def get_git_default_branch(project_root: Path) -> str:
    """Detect the default branch name.

    Args:
        project_root: Project root directory

    Returns:
        Default branch name (main or master)
    """
    # Check if HEAD points to main or master
    try:
        result = subprocess.run(
            ["git", "symbolic-ref", "--short", "HEAD"],
            cwd=project_root,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            branch = result.stdout.strip()
            if branch in ("main", "master"):
                return branch
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass

    # Check remote refs
    try:
        result = subprocess.run(
            ["git", "remote", "show", "origin"],
            cwd=project_root,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                if "HEAD branch:" in line:
                    return line.split(":")[-1].strip()
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass

    return "main"


def detect_package_manager(project_root: Path) -> str:
    """Detect the Node.js package manager.

    Args:
        project_root: Project root directory

    Returns:
        Package manager name (pnpm, yarn, bun, npm)
    """
    # Check for lock files first (most reliable)
    if (project_root / "pnpm-lock.yaml").exists():
        return "pnpm"
    if (project_root / "yarn.lock").exists():
        return "yarn"
    if (project_root / "bun.lockb").exists():
        return "bun"

    # Check packageManager field in package.json
    package_json = project_root / "package.json"
    if package_json.exists():
        try:
            data = json.loads(package_json.read_text())
            pm = data.get("packageManager", "")
            if pm:
                # Format: pnpm@8.0.0
                return str(pm.split("@")[0])
        except (json.JSONDecodeError, OSError):
            pass

    return "npm"


def detect_node_version(project_root: Path) -> str:
    """Detect the Node.js version for CI/builds.

    Checks .nvmrc, .node-version first (explicit version files),
    then running node version, with default to LTS.

    Note: package.json engines is NOT used as it specifies minimum
    requirement, not the recommended runtime version.

    Args:
        project_root: Project root directory

    Returns:
        Node.js major version (e.g., "24")
    """
    # Check .nvmrc (explicit version file takes precedence)
    nvmrc = project_root / ".nvmrc"
    if nvmrc.exists():
        try:
            version = nvmrc.read_text().strip()
            match = re.match(r"v?(\d+)", version)
            if match:
                return match.group(1)
        except OSError:
            pass

    # Check .node-version (another explicit version file)
    node_version_file = project_root / ".node-version"
    if node_version_file.exists():
        try:
            version = node_version_file.read_text().strip()
            match = re.match(r"v?(\d+)", version)
            if match:
                return match.group(1)
        except OSError:
            pass

    # Use running node version (actual available version)
    try:
        result = subprocess.run(
            ["node", "--version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            match = re.match(r"v?(\d+)", result.stdout.strip())
            if match:
                major = int(match.group(1))
                # Cap at 24 for stability (25+ may not be fully supported)
                if major > 24:
                    return "24"
                return str(major)
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass

    return "24"  # Default to current LTS


def detect_scripts(project_root: Path, package_manager: str) -> dict[str, str | None]:
    """Detect available npm scripts and construct commands.

    Args:
        project_root: Project root directory
        package_manager: Package manager name

    Returns:
        Dict with script commands (lint, lint_fix, typecheck, test, test_e2e, build)
    """
    scripts: dict[str, str | None] = {
        "lint": None,
        "lint_fix": None,
        "typecheck": None,
        "test": None,
        "test_selective": None,
        "test_e2e": None,
        "build": None,
    }

    package_json = project_root / "package.json"
    if not package_json.exists():
        return scripts

    try:
        data = json.loads(package_json.read_text())
        pkg_scripts = data.get("scripts", {})
    except (json.JSONDecodeError, OSError):
        return scripts

    run_cmd = f"{package_manager} run" if package_manager != "npm" else "npm run"

    # Lint detection
    if "lint" in pkg_scripts:
        scripts["lint"] = f"{run_cmd} lint"
    elif "eslint" in pkg_scripts:
        scripts["lint"] = f"{run_cmd} eslint"

    # Lint fix detection
    if "lint:fix" in pkg_scripts:
        scripts["lint_fix"] = f"{run_cmd} lint:fix"
    elif "fix" in pkg_scripts:
        scripts["lint_fix"] = f"{run_cmd} fix"

    # Typecheck detection
    if "typecheck" in pkg_scripts:
        scripts["typecheck"] = f"{run_cmd} typecheck"
    elif "type-check" in pkg_scripts:
        scripts["typecheck"] = f"{run_cmd} type-check"
    elif "tsc" in pkg_scripts:
        scripts["typecheck"] = f"{run_cmd} tsc"
    # Check for tsconfig.json as indicator
    elif (project_root / "tsconfig.json").exists():
        scripts["typecheck"] = f"{package_manager} exec tsc --noEmit"

    # Test detection
    if "test" in pkg_scripts:
        scripts["test"] = f"{package_manager} test"

    # Selective test detection
    if "test:selective" in pkg_scripts:
        scripts["test_selective"] = f"{run_cmd} test:selective"
    elif "test-selective" in pkg_scripts:
        scripts["test_selective"] = f"{run_cmd} test-selective"
    # Check for selective test script file
    selective_script = project_root / "scripts" / "test-selective.cjs"
    if selective_script.exists():
        scripts["test_selective"] = "node scripts/test-selective.cjs"

    # E2E test detection
    if "test:e2e" in pkg_scripts:
        scripts["test_e2e"] = f"{run_cmd} test:e2e"
    elif "e2e" in pkg_scripts:
        scripts["test_e2e"] = f"{run_cmd} e2e"
    elif "test:playwright" in pkg_scripts:
        scripts["test_e2e"] = f"{run_cmd} test:playwright"

    # Build detection
    if "build" in pkg_scripts:
        scripts["build"] = f"{run_cmd} build"

    return scripts


def detect_ci_platform(project_root: Path) -> str:
    """Detect the CI/CD platform.

    Args:
        project_root: Project root directory

    Returns:
        CI platform name (github, gitlab, etc.)
    """
    if (project_root / ".github" / "workflows").is_dir():
        return "github"
    if (project_root / ".gitlab-ci.yml").exists():
        return "gitlab"
    if (project_root / ".circleci").is_dir():
        return "circleci"
    if (project_root / ".travis.yml").exists():
        return "travis"
    if (project_root / "azure-pipelines.yml").exists():
        return "azure"
    if (project_root / "bitbucket-pipelines.yml").exists():
        return "bitbucket"
    if (project_root / "Jenkinsfile").exists():
        return "jenkins"

    return "github"  # Default


def detect_ci_workflow_name(project_root: Path) -> str:
    """Detect the main CI workflow name from GitHub Actions.

    Args:
        project_root: Project root directory

    Returns:
        Workflow name (default: "CI")
    """
    workflows_dir = project_root / ".github" / "workflows"
    if not workflows_dir.is_dir():
        return "CI"

    # Common workflow file names
    for name in ["ci.yml", "ci.yaml", "main.yml", "main.yaml", "test.yml", "test.yaml"]:
        workflow_file = workflows_dir / name
        if workflow_file.exists():
            try:
                content = yaml.safe_load(workflow_file.read_text())
                if content and isinstance(content, dict):
                    return str(content.get("name", "CI"))
            except (yaml.YAMLError, OSError):
                pass

    return "CI"


def detect_publish_workflow_name(project_root: Path) -> str:
    """Detect the publish workflow name from GitHub Actions.

    Args:
        project_root: Project root directory

    Returns:
        Workflow name (default: "Publish to npm")
    """
    workflows_dir = project_root / ".github" / "workflows"
    if not workflows_dir.is_dir():
        return "Publish to npm"

    # Common publish workflow file names
    for name in [
        "publish.yml",
        "publish.yaml",
        "release.yml",
        "release.yaml",
        "npm-publish.yml",
        "npm-publish.yaml",
    ]:
        workflow_file = workflows_dir / name
        if workflow_file.exists():
            try:
                content = yaml.safe_load(workflow_file.read_text())
                if content and isinstance(content, dict):
                    return str(content.get("name", "Publish to npm"))
            except (yaml.YAMLError, OSError):
                pass

    return "Publish to npm"


def detect_release_notes_generator(project_root: Path) -> tuple[str, str]:
    """Detect the release notes generator tool.

    Args:
        project_root: Project root directory

    Returns:
        Tuple of (generator name, config file)
    """
    # git-cliff
    if (project_root / "cliff.toml").exists():
        return ("git-cliff", "cliff.toml")

    # conventional-changelog
    if (project_root / ".changelogrc.json").exists():
        return ("conventional-changelog", ".changelogrc.json")
    if (project_root / ".changelogrc.yaml").exists():
        return ("conventional-changelog", ".changelogrc.yaml")

    # release-please
    if (project_root / "release-please-config.json").exists():
        return ("release-please", "release-please-config.json")

    # changesets
    if (project_root / ".changeset" / "config.json").exists():
        return ("changesets", ".changeset/config.json")

    return ("git-cliff", "cliff.toml")  # Default


def detect_npm_access(project_root: Path) -> str:
    """Detect npm package access level.

    Args:
        project_root: Project root directory

    Returns:
        Access level (public or restricted)
    """
    package_json = project_root / "package.json"
    if not package_json.exists():
        return "public"

    try:
        data = json.loads(package_json.read_text())

        # Check publishConfig
        publish_config = data.get("publishConfig", {})
        if "access" in publish_config:
            return str(publish_config["access"])

        # Scoped packages default to restricted
        name = data.get("name", "")
        if name.startswith("@"):
            return "restricted"

    except (json.JSONDecodeError, OSError):
        pass

    return "public"


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
        ecosystems.append("node")

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

    # Ruby
    if (project_root / "Gemfile").exists() or any(project_root.glob("*.gemspec")):
        ecosystems.append("ruby")

    # Java (Maven)
    if (project_root / "pom.xml").exists():
        ecosystems.append("java")

    # Java (Gradle)
    if (
        (project_root / "build.gradle").exists()
        or (project_root / "build.gradle.kts").exists()
    ) and "java" not in ecosystems:
        ecosystems.append("java")

    # .NET
    if any(project_root.glob("*.csproj")) or any(project_root.glob("*.fsproj")):
        ecosystems.append("dotnet")

    # PHP
    if (project_root / "composer.json").exists():
        ecosystems.append("php")

    # Elixir
    if (project_root / "mix.exs").exists():
        ecosystems.append("elixir")

    return ecosystems


def get_version_config(ecosystems: list[str]) -> dict[str, str]:
    """Get version configuration based on ecosystem.

    Args:
        ecosystems: List of detected ecosystems

    Returns:
        Version config dict with file and field
    """
    if "node" in ecosystems:
        return {"file": "package.json", "field": "version"}
    if "python" in ecosystems:
        return {"file": "pyproject.toml", "field": "version"}
    if "rust" in ecosystems:
        return {"file": "Cargo.toml", "field": "version"}
    return {"file": "package.json", "field": "version"}


def get_project_description(project_root: Path, ecosystems: list[str]) -> str:
    """Extract project description from config files.

    Args:
        project_root: Project root directory
        ecosystems: List of detected ecosystems

    Returns:
        Project description (truncated to 50 chars)
    """
    # Try package.json
    if "node" in ecosystems:
        package_json = project_root / "package.json"
        if package_json.exists():
            try:
                data = json.loads(package_json.read_text())
                desc = str(data.get("description", ""))
                if desc:
                    return desc[:50] if len(desc) > 50 else desc
            except (json.JSONDecodeError, OSError):
                pass

    # Try pyproject.toml
    if "python" in ecosystems:
        pyproject = project_root / "pyproject.toml"
        if pyproject.exists():
            try:
                import sys

                if sys.version_info >= (3, 11):
                    import tomllib
                else:
                    import tomli as tomllib

                with open(pyproject, "rb") as f:
                    data = tomllib.load(f)
                    desc = str(data.get("project", {}).get("description", ""))
                    if desc:
                        return desc[:50] if len(desc) > 50 else desc
            except Exception:
                pass

    return ""


def get_project_name(project_root: Path, ecosystems: list[str]) -> str:
    """Extract project name from config files.

    Args:
        project_root: Project root directory
        ecosystems: List of detected ecosystems

    Returns:
        Project name
    """
    # Try package.json
    if "node" in ecosystems:
        package_json = project_root / "package.json"
        if package_json.exists():
            try:
                data = json.loads(package_json.read_text())
                name = str(data.get("name", ""))
                if name:
                    # Remove scope prefix
                    if name.startswith("@"):
                        parts = name.split("/")
                        return parts[1] if len(parts) > 1 else name
                    return name
            except (json.JSONDecodeError, OSError):
                pass

    return project_root.name


def generate_default_config(
    project_root: Path,
    project_name: str | None = None,
) -> dict[str, Any]:
    """Generate default configuration based on detected project.

    Uses comprehensive detection to generate a config matching the
    structure expected by the bash release script.

    Args:
        project_root: Project root directory
        project_name: Override project name (auto-detected if not provided)

    Returns:
        Configuration dictionary matching release_conf.yml schema
    """
    # Detect ecosystems
    ecosystems = detect_ecosystems(project_root)
    primary = ecosystems[0] if ecosystems else "node"

    # Get project info
    if project_name is None:
        project_name = get_project_name(project_root, ecosystems)
    description = get_project_description(project_root, ecosystems)

    # Detect tools
    package_manager = detect_package_manager(project_root)
    node_version = detect_node_version(project_root)
    scripts = detect_scripts(project_root, package_manager)

    # Detect git info
    main_branch = get_git_default_branch(project_root)
    remote_url = get_git_remote_url(project_root)
    github_info = parse_github_url(remote_url) if remote_url else None

    # Detect CI info
    ci_platform = detect_ci_platform(project_root)
    ci_workflow_name = detect_ci_workflow_name(project_root)
    publish_workflow_name = detect_publish_workflow_name(project_root)

    # Detect release notes generator
    notes_generator, notes_config = detect_release_notes_generator(project_root)

    # Detect npm access
    npm_access = detect_npm_access(project_root)

    # Get version config
    version_config = get_version_config(ecosystems)

    # Build the config dict
    config: dict[str, Any] = {}

    # Header comment will be added when writing

    # Project section
    config["project"] = {
        "name": project_name,
        "description": description,
        "ecosystem": primary,
    }

    # Version section
    config["version"] = {
        "file": version_config["file"],
        "field": version_config["field"],
        "tag_prefix": "v",
    }

    # Tools section
    config["tools"] = {
        "package_manager": package_manager,
        "node_version": node_version,
    }

    # Git section
    config["git"] = {
        "main_branch": main_branch,
        "remote": "origin",
    }

    # GitHub section
    if github_info:
        owner, repo = github_info
        config["github"] = {
            "owner": owner,
            "repo": repo,
            "release_target": "commit_sha",
        }
    else:
        # Placeholder - user must fill in
        config["github"] = {
            "owner": "OWNER",
            "repo": project_name.upper() if project_name else "REPO",
            "release_target": "commit_sha",
        }

    # Quality checks section
    config["quality_checks"] = {
        "lint": {
            "enabled": scripts["lint"] is not None,
            "command": scripts["lint"] or f"{package_manager} run lint",
        },
        "typecheck": {
            "enabled": scripts["typecheck"] is not None,
            "command": scripts["typecheck"] or f"{package_manager} run typecheck",
        },
        "tests": {
            "enabled": scripts["test"] is not None,
            "mode": "selective" if scripts["test_selective"] else "full",
            "full_command": scripts["test"] or f"{package_manager} test",
        },
        "e2e": {
            "enabled": scripts["test_e2e"] is not None,
            "command": scripts["test_e2e"] or f"{package_manager} run test:e2e",
        },
        "build": {
            "enabled": scripts["build"] is not None,
            "command": scripts["build"] or f"{package_manager} run build",
            "output_files": [],
        },
    }

    # Add lint fix command if available
    if scripts["lint_fix"]:
        config["quality_checks"]["lint"]["auto_fix_command"] = scripts["lint_fix"]

    # Add selective command if available
    if scripts["test_selective"]:
        config["quality_checks"]["tests"]["selective_command"] = scripts[
            "test_selective"
        ]

    # CI section
    config["ci"] = {
        "platforms": ci_platform,
        "workflow": {
            "name": ci_workflow_name,
            "timeout_seconds": 900,
            "poll_interval_seconds": 10,
        },
        "publish": {
            "name": publish_workflow_name,
            "timeout_seconds": 900,
            "poll_interval_seconds": 10,
        },
    }

    # npm section
    config["npm"] = {
        "registry": "https://registry.npmjs.org",
        "access": npm_access,
        "publish_method": "oidc",
    }

    # Release notes section
    config["release_notes"] = {
        "generator": notes_generator,
        "config_file": notes_config,
    }

    # Timeouts section
    config["timeouts"] = {
        "git_operations": 30,
        "npm_operations": 60,
        "test_execution": 600,
        "ci_workflow": 900,
        "publish_workflow": 900,
        "npm_propagation": 300,
    }

    # Safety section
    config["safety"] = {
        "require_clean_worktree": True,
        "require_main_branch": True,
        "require_ci_pass": True,
        "auto_rollback_on_failure": True,
        "confirm_before_push": False,
    }

    return config


def generate_config_header(project_root: Path, ecosystems: list[str]) -> str:
    """Generate the YAML header comment.

    Args:
        project_root: Project root directory
        ecosystems: List of detected ecosystems

    Returns:
        Header comment string
    """
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    primary = ecosystems[0] if ecosystems else "node"

    package_manager = detect_package_manager(project_root)
    ci_platform = detect_ci_platform(project_root)

    ecosystem_display = "Node.js" if primary == "node" else primary.capitalize()
    pm_display = f" ({package_manager})" if primary == "node" else ""

    return f"""# ============================================================================
# Release Configuration - release_conf.yml
# ============================================================================
# Auto-generated on {now}
# Ecosystem: {ecosystem_display}{pm_display}
# CI Platforms: {ci_platform}
#
# To regenerate with auto-detected values:
#   python -m release init-config --force
# ============================================================================

"""


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
        ConfigurationError: If file cannot be written
    """
    from release.exceptions import ConfigurationError

    if project_root is None:
        project_root = Path.cwd()

    config = generate_default_config(project_root, project_name)
    ecosystems = detect_ecosystems(project_root)
    header = generate_config_header(project_root, ecosystems)

    try:
        # Create parent directory if needed
        output_path.parent.mkdir(parents=True, exist_ok=True)

        # Write with header and section comments
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(header)

            # Write each section with a comment
            sections = [
                ("project", "Project Information"),
                ("version", "Version Management"),
                ("tools", "Package Manager & Build Tools"),
                ("git", "Git & Repository Configuration"),
                ("github", None),  # No header, continues from git
                ("quality_checks", "Quality Checks"),
                ("ci", "CI/CD Workflow Settings"),
                ("npm", "npm Publishing"),
                ("release_notes", "Release Notes"),
                ("timeouts", "Timeouts (seconds)"),
                ("safety", "Safety Settings"),
            ]

            for section_key, section_title in sections:
                if section_key not in config:
                    continue

                if section_title:
                    f.write(f"# {'-' * 76}\n")
                    f.write(f"# {section_title}\n")
                    f.write(f"# {'-' * 76}\n")

                section_data = {section_key: config[section_key]}
                yaml_str = yaml.safe_dump(
                    section_data,
                    default_flow_style=False,
                    sort_keys=False,
                    allow_unicode=True,
                )
                f.write(yaml_str)
                f.write("\n")

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
