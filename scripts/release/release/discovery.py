"""Auto-discovery of ecosystems and publishers.

Scans a project to detect which ecosystems and publishers are applicable,
compares with existing configuration, and offers to update the config.

This module provides comprehensive detection for:
- Ecosystems: nodejs, python, rust, go, ruby, java, dotnet, php, elixir, swift
- Publishers: npm, pypi, crates, go, homebrew, docker, github, gitlab, maven, nuget, rubygems, hex
- Helpers: monorepo detection, release automation, CI platforms
"""

import json
import os
import re
import subprocess
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from rich.console import Console

from release.config.loader import load_config
from release.config.models import ReleaseConfig
from release.exceptions import ConfigurationError

console = Console()


class ConfidenceLevel(Enum):
    """Confidence level for detections."""

    HIGH = "high"  # Strong indicators present
    MEDIUM = "medium"  # Some indicators present
    LOW = "low"  # Weak indicators only


class CIPlatform(Enum):
    """Supported CI/CD platforms."""

    GITHUB_ACTIONS = "github_actions"
    GITLAB_CI = "gitlab_ci"
    CIRCLECI = "circleci"
    TRAVIS = "travis"
    JENKINS = "jenkins"
    AZURE_PIPELINES = "azure_pipelines"
    BITBUCKET_PIPELINES = "bitbucket_pipelines"


class ReleaseAutomation(Enum):
    """Release automation tools."""

    RELEASE_PLEASE = "release-please"
    SEMANTIC_RELEASE = "semantic-release"
    CHANGESETS = "changesets"
    STANDARD_VERSION = "standard-version"
    CARGO_RELEASE = "cargo-release"
    GORELEASER = "goreleaser"
    GIT_CLIFF = "git-cliff"
    CONVENTIONAL_COMMITS = "conventional-commits"


@dataclass
class VersionInfo:
    """Version information for a project."""

    current: str | None = None
    source_file: str | None = None
    source_field: str | None = None
    tag_prefix: str = "v"


@dataclass
class DiscoveryResult:
    """Result of ecosystem/publisher discovery."""

    name: str
    display_name: str
    detected: bool
    configured: bool
    config_key: str
    details: str = ""
    dependencies: list[str] = field(default_factory=list)
    missing_dependencies: list[str] = field(default_factory=list)
    confidence: ConfidenceLevel = ConfidenceLevel.MEDIUM
    version: VersionInfo | None = None
    warnings: list[str] = field(default_factory=list)
    suggestions: list[str] = field(default_factory=list)


@dataclass
class MonorepoInfo:
    """Information about monorepo structure."""

    is_monorepo: bool = False
    tool: str | None = None  # lerna, nx, turborepo, pnpm workspaces, cargo workspaces
    packages: list[str] = field(default_factory=list)
    root_package: bool = False


@dataclass
class CIInfo:
    """CI/CD platform information."""

    platforms: list[CIPlatform] = field(default_factory=list)
    has_release_workflow: bool = False
    has_publish_workflow: bool = False
    workflow_files: list[str] = field(default_factory=list)


@dataclass
class ReleaseAutomationInfo:
    """Release automation tool information."""

    tools: list[ReleaseAutomation] = field(default_factory=list)
    config_files: list[str] = field(default_factory=list)


@dataclass
class AuthInfo:
    """Authentication/credential status."""

    name: str
    available: bool
    source: str = ""  # env var, config file, keyring, etc.
    warnings: list[str] = field(default_factory=list)


@dataclass
class ProjectDiscovery:
    """Complete discovery results for a project."""

    ecosystems: list[DiscoveryResult] = field(default_factory=list)
    publishers: list[DiscoveryResult] = field(default_factory=list)
    new_ecosystems: list[DiscoveryResult] = field(default_factory=list)
    new_publishers: list[DiscoveryResult] = field(default_factory=list)

    # Enhanced discovery information
    monorepo: MonorepoInfo | None = None
    ci: CIInfo | None = None
    release_automation: ReleaseAutomationInfo | None = None
    auth_status: list[AuthInfo] = field(default_factory=list)
    primary_ecosystem: str | None = None
    project_version: VersionInfo | None = None


def check_command_exists(cmd: str) -> bool:
    """Check if a command exists in PATH.

    Uses shutil.which for cross-platform compatibility (works on Windows too).

    Args:
        cmd: Command name to check

    Returns:
        True if command exists
    """
    import shutil

    return shutil.which(cmd) is not None


def get_command_version(cmd: str, version_flag: str = "--version") -> str | None:
    """Get version string from a command.

    Args:
        cmd: Command to run
        version_flag: Flag to get version (default: --version)

    Returns:
        Version string or None if command fails
    """
    try:
        result = subprocess.run(
            [cmd, version_flag],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            # Extract version number from output
            output = result.stdout.strip() or result.stderr.strip()
            # Try to find version pattern
            match = re.search(r"(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)", output)
            if match:
                return match.group(1)
            return output.split("\n")[0][:50]  # First line, truncated
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass
    return None


def load_toml(path: Path) -> dict[str, Any] | None:
    """Load and parse a TOML file.

    Args:
        path: Path to TOML file

    Returns:
        Parsed TOML data or None on error
    """
    if not path.exists():
        return None

    try:
        import sys

        if sys.version_info >= (3, 11):
            import tomllib
        else:
            import tomli as tomllib

        with open(path, "rb") as f:
            data: dict[str, Any] = tomllib.load(f)
            return data
    except Exception:
        return None


def load_json(path: Path) -> dict[str, Any] | None:
    """Load and parse a JSON file.

    Args:
        path: Path to JSON file

    Returns:
        Parsed JSON data or None on error
    """
    if not path.exists():
        return None

    try:
        data: dict[str, Any] = json.loads(path.read_text())
        return data
    except (json.JSONDecodeError, OSError):
        return None


def load_yaml(path: Path) -> dict[str, Any] | None:
    """Load and parse a YAML file.

    Args:
        path: Path to YAML file

    Returns:
        Parsed YAML data or None on error
    """
    if not path.exists():
        return None

    try:
        import yaml

        with open(path) as f:
            data: dict[str, Any] = yaml.safe_load(f)
            return data
    except Exception:
        return None


# =============================================================================
# ECOSYSTEM DETECTION FUNCTIONS
# =============================================================================


def detect_nodejs_ecosystem(project_root: Path) -> DiscoveryResult:
    """Detect Node.js/JavaScript/TypeScript ecosystem.

    Detects package managers (npm, pnpm, yarn, bun), TypeScript usage,
    and framework indicators.

    Args:
        project_root: Path to project root

    Returns:
        DiscoveryResult for Node.js ecosystem
    """
    result = DiscoveryResult(
        name="nodejs",
        display_name="Node.js",
        detected=False,
        configured=False,
        config_key="ecosystems.nodejs",
        dependencies=["node"],
    )

    package_json = project_root / "package.json"
    if not package_json.exists():
        return result

    data = load_json(package_json)
    if not data:
        return result

    result.detected = True
    result.confidence = ConfidenceLevel.HIGH

    # Get version info
    version = data.get("version")
    if version:
        result.version = VersionInfo(
            current=version,
            source_file="package.json",
            source_field="version",
        )

    # Detect package manager
    pm = "npm"
    pm_version = None
    if "packageManager" in data:
        pm_spec = data["packageManager"]
        pm = pm_spec.split("@")[0]
        if "@" in pm_spec:
            pm_version = pm_spec.split("@")[1]
    elif (project_root / "pnpm-lock.yaml").exists():
        pm = "pnpm"
    elif (project_root / "yarn.lock").exists():
        pm = "yarn"
    elif (project_root / "bun.lockb").exists():
        pm = "bun"

    result.details = f"Package manager: {pm}"
    if pm_version:
        result.details += f"@{pm_version}"

    # Detect TypeScript
    has_typescript = (
        (project_root / "tsconfig.json").exists()
        or "typescript" in data.get("devDependencies", {})
        or "typescript" in data.get("dependencies", {})
    )
    if has_typescript:
        result.details += " [TypeScript]"

    # Detect frameworks
    all_deps = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
    frameworks = []
    if "next" in all_deps:
        frameworks.append("Next.js")
    if "react" in all_deps:
        frameworks.append("React")
    if "vue" in all_deps:
        frameworks.append("Vue")
    if "svelte" in all_deps or "@sveltejs/kit" in all_deps:
        frameworks.append("Svelte")
    if "@angular/core" in all_deps:
        frameworks.append("Angular")
    if "express" in all_deps:
        frameworks.append("Express")
    if "fastify" in all_deps:
        frameworks.append("Fastify")
    if "hono" in all_deps:
        frameworks.append("Hono")

    if frameworks:
        result.details += f" ({', '.join(frameworks[:3])})"

    # Check for node availability
    if not check_command_exists("node"):
        result.missing_dependencies.append("node")
    if not check_command_exists(pm):
        result.missing_dependencies.append(pm)

    # Add warnings
    if not (project_root / "package-lock.json").exists() and pm == "npm":
        result.warnings.append("No package-lock.json found")

    # Add suggestions
    if not has_typescript and "typescript" not in all_deps:
        result.suggestions.append(
            "Consider adding TypeScript for better maintainability"
        )

    return result


def detect_python_ecosystem(project_root: Path) -> DiscoveryResult:
    """Detect Python ecosystem.

    Detects build tools (setuptools, poetry, flit, hatch, pdm), Python version,
    and virtual environment.

    Args:
        project_root: Path to project root

    Returns:
        DiscoveryResult for Python ecosystem
    """
    result = DiscoveryResult(
        name="python",
        display_name="Python",
        detected=False,
        configured=False,
        config_key="ecosystems.python",
        dependencies=["python"],
    )

    pyproject = project_root / "pyproject.toml"
    setup_py = project_root / "setup.py"
    requirements_txt = project_root / "requirements.txt"

    build_tool = None
    project_name = None
    version = None

    if pyproject.exists():
        data = load_toml(pyproject)
        if data:
            result.detected = True
            result.confidence = ConfidenceLevel.HIGH

            # Detect build tool
            build_backend = data.get("build-system", {}).get("build-backend", "")
            tool = data.get("tool", {})

            if "poetry" in build_backend or "poetry" in tool:
                build_tool = "poetry"
                poetry_data = tool.get("poetry", {})
                project_name = poetry_data.get("name")
                version = poetry_data.get("version")
            elif "flit" in build_backend or "flit" in tool:
                build_tool = "flit"
            elif "hatchling" in build_backend or "hatch" in tool:
                build_tool = "hatch"
            elif "pdm" in build_backend or "pdm" in tool:
                build_tool = "pdm"
            elif "maturin" in build_backend:
                build_tool = "maturin"
            elif "setuptools" in build_backend:
                build_tool = "setuptools"
            else:
                build_tool = "pep621"

            # Get project info from PEP 621
            project_data = data.get("project", {})
            if not project_name:
                project_name = project_data.get("name")
            if not version:
                version = project_data.get("version")

            # Get Python version requirement
            requires_python = project_data.get("requires-python")
            if requires_python:
                result.details = f"Python {requires_python}"

    elif setup_py.exists():
        result.detected = True
        result.confidence = ConfidenceLevel.MEDIUM
        build_tool = "setuptools-legacy"

        # Try to extract name/version from setup.py
        try:
            content = setup_py.read_text()
            name_match = re.search(r'name\s*=\s*["\']([^"\']+)["\']', content)
            version_match = re.search(r'version\s*=\s*["\']([^"\']+)["\']', content)
            if name_match:
                project_name = name_match.group(1)
            if version_match:
                version = version_match.group(1)
        except OSError:
            pass

    elif requirements_txt.exists():
        result.detected = True
        result.confidence = ConfidenceLevel.LOW
        build_tool = "requirements.txt only"

    if not result.detected:
        return result

    # Add build tool to details
    if build_tool:
        if result.details:
            result.details += f" [{build_tool}]"
        else:
            result.details = f"Build: {build_tool}"

    # Set version info
    if version:
        result.version = VersionInfo(
            current=version,
            source_file="pyproject.toml" if pyproject.exists() else "setup.py",
            source_field="version",
        )

    # Check for virtual environment
    venv_indicators = [".venv", "venv", ".virtualenv", "virtualenv"]
    has_venv = any((project_root / v).is_dir() for v in venv_indicators)
    if has_venv:
        result.details += " [venv]"

    # Check for uv.lock (uv package manager)
    if (project_root / "uv.lock").exists():
        result.details += " [uv]"

    # Check Python availability
    if not check_command_exists("python") and not check_command_exists("python3"):
        result.missing_dependencies.append("python")

    # Check build tool availability
    if build_tool == "poetry" and not check_command_exists("poetry"):
        result.missing_dependencies.append("poetry")
    elif build_tool == "pdm" and not check_command_exists("pdm"):
        result.missing_dependencies.append("pdm")
    elif build_tool == "hatch" and not check_command_exists("hatch"):
        result.missing_dependencies.append("hatch")

    return result


def detect_rust_ecosystem(project_root: Path) -> DiscoveryResult:
    """Detect Rust ecosystem.

    Detects Cargo workspace, edition, and MSRV.

    Args:
        project_root: Path to project root

    Returns:
        DiscoveryResult for Rust ecosystem
    """
    result = DiscoveryResult(
        name="rust",
        display_name="Rust",
        detected=False,
        configured=False,
        config_key="ecosystems.rust",
        dependencies=["cargo"],
    )

    cargo_toml = project_root / "Cargo.toml"
    if not cargo_toml.exists():
        return result

    data = load_toml(cargo_toml)
    if not data:
        return result

    result.detected = True
    result.confidence = ConfidenceLevel.HIGH

    # Check if workspace
    is_workspace = "workspace" in data and "package" not in data
    if is_workspace:
        members = data.get("workspace", {}).get("members", [])
        result.details = f"Workspace with {len(members)} members"
    else:
        pkg = data.get("package", {})
        name = pkg.get("name", "unknown")
        version = pkg.get("version")
        edition = pkg.get("edition", "2015")
        msrv = pkg.get("rust-version")

        result.details = f"Crate: {name} [edition {edition}]"
        if msrv:
            result.details += f" [MSRV {msrv}]"

        if version:
            result.version = VersionInfo(
                current=version,
                source_file="Cargo.toml",
                source_field="package.version",
            )

    # Check for cargo
    if not check_command_exists("cargo"):
        result.missing_dependencies.append("cargo")
    else:
        # Get rustc version
        rustc_version = get_command_version("rustc")
        if rustc_version:
            result.details += f" [rustc {rustc_version}]"

    return result


def detect_go_ecosystem(project_root: Path) -> DiscoveryResult:
    """Detect Go ecosystem.

    Detects go.mod, go.work, and Go version.

    Args:
        project_root: Path to project root

    Returns:
        DiscoveryResult for Go ecosystem
    """
    result = DiscoveryResult(
        name="go",
        display_name="Go",
        detected=False,
        configured=False,
        config_key="ecosystems.go",
        dependencies=["go"],
    )

    go_mod = project_root / "go.mod"
    go_work = project_root / "go.work"

    if go_work.exists():
        result.detected = True
        result.confidence = ConfidenceLevel.HIGH
        result.details = "Go workspace (go.work)"
    elif go_mod.exists():
        result.detected = True
        result.confidence = ConfidenceLevel.HIGH

        try:
            content = go_mod.read_text()
            module_path = None
            go_version = None

            for line in content.splitlines():
                line = line.strip()
                if line.startswith("module "):
                    module_path = line[7:].strip().strip('"')
                elif line.startswith("go "):
                    go_version = line[3:].strip()

            if module_path:
                result.details = f"Module: {module_path}"
            if go_version:
                result.details += f" [go {go_version}]"
                result.version = VersionInfo(
                    current=go_version,
                    source_file="go.mod",
                    source_field="go",
                )
        except OSError:
            pass

    if not result.detected:
        return result

    # Check for go
    if not check_command_exists("go"):
        result.missing_dependencies.append("go")
    else:
        go_version = get_command_version("go", "version")
        if go_version:
            result.details += f" [installed: {go_version}]"

    return result


def detect_ruby_ecosystem(project_root: Path) -> DiscoveryResult:
    """Detect Ruby ecosystem.

    Detects Gemfile, gemspec, and Ruby version.

    Args:
        project_root: Path to project root

    Returns:
        DiscoveryResult for Ruby ecosystem
    """
    result = DiscoveryResult(
        name="ruby",
        display_name="Ruby",
        detected=False,
        configured=False,
        config_key="ecosystems.ruby",
        dependencies=["ruby", "bundler"],
    )

    gemfile = project_root / "Gemfile"
    gemspecs = list(project_root.glob("*.gemspec"))
    ruby_version_file = project_root / ".ruby-version"

    if gemfile.exists() or gemspecs:
        result.detected = True
        result.confidence = ConfidenceLevel.HIGH

        details = []

        # Check for gemspec (indicates gem project)
        if gemspecs:
            gem_name = gemspecs[0].stem
            details.append(f"Gem: {gem_name}")

            # Try to extract version from gemspec
            try:
                content = gemspecs[0].read_text()
                version_match = re.search(
                    r'\.version\s*=\s*["\']([^"\']+)["\']', content
                )
                if version_match:
                    result.version = VersionInfo(
                        current=version_match.group(1),
                        source_file=gemspecs[0].name,
                        source_field="version",
                    )
            except OSError:
                pass

        # Check for Ruby version
        if ruby_version_file.exists():
            try:
                ruby_ver = ruby_version_file.read_text().strip()
                details.append(f"Ruby {ruby_ver}")
            except OSError:
                pass

        # Check for Rails
        if gemfile.exists():
            try:
                content = gemfile.read_text()
                if "rails" in content.lower():
                    details.append("Rails")
            except OSError:
                pass

        result.details = " ".join(details)

    if not result.detected:
        return result

    # Check dependencies
    if not check_command_exists("ruby"):
        result.missing_dependencies.append("ruby")
    if not check_command_exists("bundle") and not check_command_exists("bundler"):
        result.missing_dependencies.append("bundler")
    if gemspecs and not check_command_exists("gem"):
        result.missing_dependencies.append("gem")

    return result


def detect_java_ecosystem(project_root: Path) -> DiscoveryResult:
    """Detect Java/Kotlin/Scala ecosystem.

    Detects Maven (pom.xml), Gradle (build.gradle), and JVM version.

    Args:
        project_root: Path to project root

    Returns:
        DiscoveryResult for Java ecosystem
    """
    result = DiscoveryResult(
        name="java",
        display_name="Java/JVM",
        detected=False,
        configured=False,
        config_key="ecosystems.java",
        dependencies=["java"],
    )

    pom_xml = project_root / "pom.xml"
    build_gradle = project_root / "build.gradle"
    build_gradle_kts = project_root / "build.gradle.kts"
    settings_gradle = project_root / "settings.gradle"
    settings_gradle_kts = project_root / "settings.gradle.kts"

    if pom_xml.exists():
        result.detected = True
        result.confidence = ConfidenceLevel.HIGH
        result.details = "Maven (pom.xml)"
        result.dependencies = ["java", "mvn"]

        # Try to extract version from pom.xml
        try:
            content = pom_xml.read_text()
            version_match = re.search(r"<version>([^<]+)</version>", content)
            if version_match:
                result.version = VersionInfo(
                    current=version_match.group(1),
                    source_file="pom.xml",
                    source_field="version",
                )
        except OSError:
            pass

    elif build_gradle.exists() or build_gradle_kts.exists():
        result.detected = True
        result.confidence = ConfidenceLevel.HIGH
        gradle_file = build_gradle if build_gradle.exists() else build_gradle_kts
        result.details = f"Gradle ({gradle_file.name})"
        result.dependencies = ["java", "gradle"]

        # Check for Kotlin
        if build_gradle_kts.exists():
            result.details += " [Kotlin DSL]"

        # Check if multi-project
        if settings_gradle.exists() or settings_gradle_kts.exists():
            result.details += " [multi-project]"

    if not result.detected:
        return result

    # Check Java
    if not check_command_exists("java"):
        result.missing_dependencies.append("java")
    else:
        java_version = get_command_version("java", "-version")
        if java_version:
            result.details += f" [Java {java_version}]"

    # Check build tool
    if "mvn" in result.dependencies and not check_command_exists("mvn"):
        result.missing_dependencies.append("mvn")
    if "gradle" in result.dependencies:
        # Check for wrapper first
        gradlew = project_root / "gradlew"
        if not gradlew.exists() and not check_command_exists("gradle"):
            result.missing_dependencies.append("gradle")

    return result


def detect_dotnet_ecosystem(project_root: Path) -> DiscoveryResult:
    """Detect .NET ecosystem.

    Detects .csproj, .fsproj, .sln files and .NET version.

    Args:
        project_root: Path to project root

    Returns:
        DiscoveryResult for .NET ecosystem
    """
    result = DiscoveryResult(
        name="dotnet",
        display_name=".NET",
        detected=False,
        configured=False,
        config_key="ecosystems.dotnet",
        dependencies=["dotnet"],
    )

    csproj_files = list(project_root.glob("*.csproj"))
    fsproj_files = list(project_root.glob("*.fsproj"))
    sln_files = list(project_root.glob("*.sln"))
    global_json = project_root / "global.json"

    if csproj_files or fsproj_files or sln_files:
        result.detected = True
        result.confidence = ConfidenceLevel.HIGH

        details = []
        if sln_files:
            details.append(f"Solution: {sln_files[0].name}")
        if csproj_files:
            details.append(f"{len(csproj_files)} C# project(s)")
        if fsproj_files:
            details.append(f"{len(fsproj_files)} F# project(s)")

        # Check for .NET version in global.json
        if global_json.exists():
            data = load_json(global_json)
            if data and "sdk" in data:
                sdk_version = data["sdk"].get("version")
                if sdk_version:
                    details.append(f".NET {sdk_version}")
                    result.version = VersionInfo(
                        current=sdk_version,
                        source_file="global.json",
                        source_field="sdk.version",
                    )

        result.details = " | ".join(details)

    if not result.detected:
        return result

    if not check_command_exists("dotnet"):
        result.missing_dependencies.append("dotnet")

    return result


def detect_php_ecosystem(project_root: Path) -> DiscoveryResult:
    """Detect PHP ecosystem.

    Detects composer.json and PHP version.

    Args:
        project_root: Path to project root

    Returns:
        DiscoveryResult for PHP ecosystem
    """
    result = DiscoveryResult(
        name="php",
        display_name="PHP",
        detected=False,
        configured=False,
        config_key="ecosystems.php",
        dependencies=["php", "composer"],
    )

    composer_json = project_root / "composer.json"
    if not composer_json.exists():
        return result

    data = load_json(composer_json)
    if not data:
        return result

    result.detected = True
    result.confidence = ConfidenceLevel.HIGH

    name = data.get("name", "")
    version = data.get("version")
    php_require = data.get("require", {}).get("php", "")

    details = []
    if name:
        details.append(f"Package: {name}")
    if php_require:
        details.append(f"PHP {php_require}")

    # Check for frameworks
    require = {**data.get("require", {}), **data.get("require-dev", {})}
    if "laravel/framework" in require:
        details.append("Laravel")
    elif "symfony/symfony" in require or any(k.startswith("symfony/") for k in require):
        details.append("Symfony")

    result.details = " | ".join(details)

    if version:
        result.version = VersionInfo(
            current=version,
            source_file="composer.json",
            source_field="version",
        )

    if not check_command_exists("php"):
        result.missing_dependencies.append("php")
    if not check_command_exists("composer"):
        result.missing_dependencies.append("composer")

    return result


def detect_elixir_ecosystem(project_root: Path) -> DiscoveryResult:
    """Detect Elixir ecosystem.

    Detects mix.exs and Elixir version.

    Args:
        project_root: Path to project root

    Returns:
        DiscoveryResult for Elixir ecosystem
    """
    result = DiscoveryResult(
        name="elixir",
        display_name="Elixir",
        detected=False,
        configured=False,
        config_key="ecosystems.elixir",
        dependencies=["elixir", "mix"],
    )

    mix_exs = project_root / "mix.exs"
    if not mix_exs.exists():
        return result

    result.detected = True
    result.confidence = ConfidenceLevel.HIGH

    try:
        content = mix_exs.read_text()

        # Extract project name
        name_match = re.search(r"app:\s*:(\w+)", content)
        version_match = re.search(r'version:\s*"([^"]+)"', content)

        details = []
        if name_match:
            details.append(f"App: {name_match.group(1)}")
        if version_match:
            details.append(f"v{version_match.group(1)}")
            result.version = VersionInfo(
                current=version_match.group(1),
                source_file="mix.exs",
                source_field="version",
            )

        # Check for Phoenix
        if "phoenix" in content.lower():
            details.append("Phoenix")

        result.details = " | ".join(details)
    except OSError:
        pass

    if not check_command_exists("elixir"):
        result.missing_dependencies.append("elixir")
    if not check_command_exists("mix"):
        result.missing_dependencies.append("mix")

    return result


def detect_npm_publishing(project_root: Path) -> DiscoveryResult:
    """Detect if project can publish to npm.

    Checks for package.json with a publishable configuration. Supports multiple
    package managers: npm, pnpm, yarn, bun.

    SHORTCOMINGS:
    - Does not detect workspace packages (packages/* or apps/*) that may have
      their own package.json files with different publish settings
    - Does not check .npmrc for registry overrides (private registries)
    - Does not validate that 'name' follows npm naming conventions
    - Does not check if package already exists on npm (name collision)
    - Does not detect 'publishConfig' overrides that might change behavior

    Args:
        project_root: Path to project root

    Returns:
        DiscoveryResult for npm publishing
    """
    result = DiscoveryResult(
        name="npm",
        display_name="npm Registry",
        detected=False,
        configured=False,
        config_key="publishers.npm",
        # Any of these package managers can publish to npm
        dependencies=["npm"],  # Will check alternatives below
    )

    package_json = project_root / "package.json"
    if not package_json.exists():
        return result

    try:
        data = json.loads(package_json.read_text())

        # Check if it's a publishable package (has name, not private)
        if data.get("name") and not data.get("private", False):
            result.detected = True
            pkg_name = data["name"]
            result.details = f"Package: {pkg_name}"

            # Check for 'files' field - if present, indicates intentional publishing
            if "files" in data:
                result.details += " (has files field)"

            # Check for publishConfig which may override registry
            if "publishConfig" in data:
                pub_config = data["publishConfig"]
                if pub_config.get("registry"):
                    result.details += f" -> {pub_config['registry']}"
                if pub_config.get("access"):
                    result.details += f" ({pub_config['access']})"

            # Detect preferred package manager from packageManager field or lock files
            # This affects which command we'll use to publish
            pm_detected = None
            if "packageManager" in data:
                # Format: "pnpm@8.0.0" or "yarn@4.0.0"
                pm_detected = data["packageManager"].split("@")[0]
            elif (project_root / "pnpm-lock.yaml").exists():
                pm_detected = "pnpm"
            elif (project_root / "yarn.lock").exists():
                pm_detected = "yarn"
            elif (project_root / "bun.lockb").exists():
                pm_detected = "bun"
            elif (project_root / "package-lock.json").exists():
                pm_detected = "npm"

            if pm_detected:
                result.details += f" [{pm_detected}]"

            # Check for package manager availability - any one will work
            # Priority: pnpm > bun > yarn > npm (performance order)
            pm_available = False
            for pm in ["pnpm", "bun", "yarn", "npm"]:
                if check_command_exists(pm):
                    pm_available = True
                    break

            if not pm_available:
                result.missing_dependencies.append("npm (or pnpm/yarn/bun)")

    except (json.JSONDecodeError, OSError) as e:
        # Log parse errors for debugging
        result.details = f"Error parsing package.json: {e}"

    return result


def detect_pypi_publishing(project_root: Path) -> DiscoveryResult:
    """Detect if project can publish to PyPI.

    Supports multiple Python build systems: setuptools, poetry, flit, hatch, pdm, maturin.

    SHORTCOMINGS:
    - Does not detect private PyPI registries configured in pyproject.toml
    - Does not check if package name is available on PyPI (name collision)
    - Does not validate classifiers or metadata completeness
    - Does not detect maturin (Rust+Python) projects reliably
    - Does not check for .pypirc configuration file
    - Does not detect namespace packages properly
    - Cannot determine if project uses trusted publishing (OIDC) vs token auth

    Args:
        project_root: Path to project root

    Returns:
        DiscoveryResult for PyPI publishing
    """
    result = DiscoveryResult(
        name="pypi",
        display_name="PyPI",
        detected=False,
        configured=False,
        config_key="publishers.pypi",
        dependencies=[],  # Will be set based on detected build system
    )

    pyproject = project_root / "pyproject.toml"
    setup_py = project_root / "setup.py"
    setup_cfg = project_root / "setup.cfg"

    build_system = None
    project_name = None

    if pyproject.exists():
        try:
            import sys

            if sys.version_info >= (3, 11):
                import tomllib
            else:
                import tomli as tomllib

            with open(pyproject, "rb") as f:
                data = tomllib.load(f)

            # Detect build system from build-system.requires or tool sections
            build_backend = data.get("build-system", {}).get("build-backend", "")

            if "poetry" in build_backend or "poetry" in data.get("tool", {}):
                build_system = "poetry"
                project_name = data.get("tool", {}).get("poetry", {}).get("name")
            elif "flit" in build_backend or "flit" in data.get("tool", {}):
                build_system = "flit"
                project_name = data.get("project", {}).get("name")
            elif "hatchling" in build_backend or "hatch" in data.get("tool", {}):
                build_system = "hatch"
                project_name = data.get("project", {}).get("name")
            elif "pdm" in build_backend or "pdm" in data.get("tool", {}):
                build_system = "pdm"
                project_name = data.get("project", {}).get("name")
            elif "maturin" in build_backend:
                build_system = "maturin"
                project_name = data.get("project", {}).get("name")
            elif "setuptools" in build_backend:
                build_system = "setuptools"
                project_name = data.get("project", {}).get("name")
            else:
                # PEP 621 with unknown or default build system
                if "project" in data and "name" in data["project"]:
                    build_system = "pep621"
                    project_name = data["project"]["name"]

            # Check for explicit "not publishable" indicators
            # Some tools use tool.X.publish = false
            tool_config = data.get("tool", {})
            for tool_name in ["poetry", "flit", "hatch", "pdm"]:
                if tool_name in tool_config:
                    tool_data = tool_config[tool_name]
                    # Poetry uses packages = [] for non-publishable
                    if tool_name == "poetry" and tool_data.get("packages") == []:
                        project_name = None
                    # Check explicit publish = false
                    if tool_data.get("publish") is False:
                        project_name = None

        except Exception as e:
            result.details = f"Error parsing pyproject.toml: {e}"

    # Fall back to legacy setup.py/setup.cfg
    if not project_name:
        if setup_py.exists():
            build_system = "setuptools-legacy"
            # Try to extract name from setup.py (very basic parsing)
            try:
                content = setup_py.read_text()
                # Look for name= in setup() call
                import re

                match = re.search(r'name\s*=\s*["\']([^"\']+)["\']', content)
                if match:
                    project_name = match.group(1)
                else:
                    project_name = "unknown (setup.py)"
            except OSError:
                project_name = "unknown (setup.py)"
        elif setup_cfg.exists():
            build_system = "setuptools-cfg"
            # Try to extract name from setup.cfg
            try:
                import configparser

                config = configparser.ConfigParser()
                config.read(setup_cfg)
                if config.has_option("metadata", "name"):
                    project_name = config.get("metadata", "name")
            except Exception:
                project_name = "unknown (setup.cfg)"

    if project_name:
        result.detected = True
        result.details = f"Package: {project_name}"
        if build_system:
            result.details += f" [{build_system}]"

        # Set dependencies based on build system
        if build_system == "poetry":
            result.dependencies = ["poetry"]
            if not check_command_exists("poetry"):
                result.missing_dependencies.append("poetry")
        elif build_system == "flit":
            result.dependencies = ["flit"]
            if not check_command_exists("flit"):
                result.missing_dependencies.append("flit")
        elif build_system == "hatch":
            result.dependencies = ["hatch"]
            if not check_command_exists("hatch"):
                result.missing_dependencies.append("hatch")
        elif build_system == "pdm":
            result.dependencies = ["pdm"]
            if not check_command_exists("pdm"):
                result.missing_dependencies.append("pdm")
        elif build_system == "maturin":
            result.dependencies = ["maturin"]
            if not check_command_exists("maturin"):
                result.missing_dependencies.append("maturin")
        else:
            # Default: uv (modern) or twine (legacy)
            result.dependencies = ["uv"]
            if not check_command_exists("uv"):
                if check_command_exists("twine"):
                    result.details += " (using twine)"
                elif check_command_exists("python"):
                    result.details += " (using python -m build)"
                else:
                    result.missing_dependencies.append("uv (or twine/python)")

    return result


def detect_crates_publishing(project_root: Path) -> DiscoveryResult:
    """Detect if project can publish to crates.io.

    Handles workspaces, virtual manifests, and various publish configurations.

    SHORTCOMINGS:
    - Does not detect workspace members that have different publish settings
    - Does not check if crate name is available on crates.io (name collision)
    - Does not validate required fields for publishing (license, description, etc.)
    - Does not detect .cargo/config.toml registry overrides
    - Does not handle path dependencies that block publishing
    - Cannot determine if project uses cargo-release or semantic-release-rust

    Args:
        project_root: Path to project root

    Returns:
        DiscoveryResult for crates.io publishing
    """
    result = DiscoveryResult(
        name="crates",
        display_name="crates.io",
        detected=False,
        configured=False,
        config_key="publishers.crates",
        dependencies=["cargo"],
    )

    cargo_toml = project_root / "Cargo.toml"
    if not cargo_toml.exists():
        return result

    try:
        import sys

        if sys.version_info >= (3, 11):
            import tomllib
        else:
            import tomli as tomllib

        with open(cargo_toml, "rb") as f:
            data = tomllib.load(f)

        # Check if it's a workspace (virtual manifest)
        is_workspace = "workspace" in data and "package" not in data
        if is_workspace:
            # Virtual manifest - check workspace.package for shared config
            # or look for member crates
            workspace = data.get("workspace", {})
            members = workspace.get("members", [])
            if members:
                result.details = f"Workspace with {len(members)} members"
                # Check if any member is publishable (would need to scan each)
                # For now, assume workspace projects may be publishable
                result.detected = True
            return result

        # Check if it's a publishable crate
        if "package" in data:
            pkg = data["package"]
            crate_name = pkg.get("name", "unknown")

            # Check publish field:
            # - publish = false -> not publishable
            # - publish = [] -> not publishable (empty registry list)
            # - publish = ["crates-io"] -> publishable to crates.io
            # - publish = ["my-registry"] -> publishable to private registry only
            # - publish absent -> publishable to crates.io (default)
            publish = pkg.get("publish")

            if publish is False:
                # Explicitly disabled
                result.details = f"Crate: {crate_name} (publish disabled)"
                return result
            elif isinstance(publish, list):
                if len(publish) == 0:
                    # Empty list = not publishable anywhere
                    result.details = f"Crate: {crate_name} (publish = [])"
                    return result
                elif "crates-io" not in publish and len(publish) > 0:
                    # Only private registries
                    result.details = (
                        f"Crate: {crate_name} (private registry: {publish})"
                    )
                    result.detected = True
                    return result

            # Crate is publishable
            result.detected = True
            result.details = f"Crate: {crate_name}"

            # Check for required publishing metadata
            missing_metadata = []
            if not pkg.get("version"):
                missing_metadata.append("version")
            if not pkg.get("license") and not pkg.get("license-file"):
                missing_metadata.append("license")
            if not pkg.get("description"):
                missing_metadata.append("description")
            if not pkg.get("repository") and not pkg.get("homepage"):
                missing_metadata.append("repository/homepage")

            if missing_metadata:
                result.details += f" (missing: {', '.join(missing_metadata)})"

            # Check for edition (not required but recommended)
            edition = pkg.get("edition", "2015")
            result.details += f" [edition {edition}]"

    except Exception as e:
        result.details = f"Error parsing Cargo.toml: {e}"

    if result.detected:
        if not check_command_exists("cargo"):
            result.missing_dependencies.append("cargo")

    return result


def detect_go_publishing(project_root: Path) -> DiscoveryResult:
    """Detect if project can be indexed on Go proxy.

    Supports go.mod modules and go.work workspaces. Go modules are automatically
    indexed on proxy.golang.org when a version tag is pushed to a public repo.

    SHORTCOMINGS:
    - Does not detect GOPRIVATE environment variable settings
    - Does not check if module path matches repository URL (common mistake)
    - Does not validate semantic import versioning for v2+ modules
    - Does not detect replace directives that might block indexing
    - Does not check for retracted versions in go.mod
    - Cannot determine if module is already indexed on proxy.golang.org
    - Does not detect deprecated modules (//go:deprecated comment)

    Args:
        project_root: Path to project root

    Returns:
        DiscoveryResult for Go proxy publishing
    """
    result = DiscoveryResult(
        name="go",
        display_name="Go Module Proxy",
        detected=False,
        configured=False,
        config_key="publishers.go",
        # HTTP-based indexing works without local go installation
        # But go CLI is useful for verification
        dependencies=[],
    )

    go_mod = project_root / "go.mod"
    go_work = project_root / "go.work"

    # Check for workspace first
    if go_work.exists():
        try:
            content = go_work.read_text()
            modules = []
            for line in content.splitlines():
                line = line.strip()
                # Parse "use ./path" or "use (" block
                if line.startswith("use "):
                    path = line[4:].strip().strip('"')
                    if path != "(" and path != ")":
                        modules.append(path)
                elif line.startswith("./") or line.startswith("../"):
                    # Inside use ( ) block
                    modules.append(line.strip().strip('"'))

            if modules:
                result.detected = True
                result.details = f"Workspace with {len(modules)} modules"
                return result
        except OSError:
            pass

    # Check for single module
    if not go_mod.exists():
        return result

    try:
        content = go_mod.read_text()
        module_path = None
        go_version = None
        has_replace = False
        has_retract = False

        for line in content.splitlines():
            line = line.strip()

            # Parse module declaration
            if line.startswith("module "):
                # Handle both: module foo and module "foo"
                module_path = line[7:].strip().strip('"')

            # Parse go version
            elif line.startswith("go "):
                go_version = line[3:].strip()

            # Check for replace directives (may affect publishability)
            elif line.startswith("replace "):
                has_replace = True

            # Check for retracted versions
            elif line.startswith("retract "):
                has_retract = True

        if module_path:
            result.detected = True
            result.details = f"Module: {module_path}"

            if go_version:
                result.details += f" [go {go_version}]"

            # Check for v2+ module path (semantic import versioning)
            import re

            v2_match = re.search(r"/v(\d+)$", module_path)
            if v2_match:
                major = v2_match.group(1)
                result.details += f" (v{major}+ path)"

            # Warnings
            warnings = []
            if has_replace:
                warnings.append("has replace")
            if has_retract:
                warnings.append("has retract")
            if warnings:
                result.details += f" ({', '.join(warnings)})"

            # Check if go is available (optional but useful)
            if check_command_exists("go"):
                result.details += " [go available]"

    except OSError as e:
        result.details = f"Error reading go.mod: {e}"

    return result


def detect_homebrew_publishing(project_root: Path) -> DiscoveryResult:
    """Detect if project can publish to Homebrew.

    Only detects projects that are clearly CLI tools. Being conservative to avoid
    false positives (libraries are not suitable for Homebrew).

    SHORTCOMINGS:
    - Does not check if a formula already exists in homebrew-core
    - Does not validate that the tool is actually installable via Homebrew
    - Does not detect if project uses goreleaser/cargo-dist for releases
    - Cannot determine if project needs a tap or can go to homebrew-core
    - Does not check for prebuilt binaries in GitHub releases
    - Does not detect Homebrew Cask candidates (GUI apps)
    - Cannot validate formula syntax in existing Formula/*.rb files

    Args:
        project_root: Path to project root

    Returns:
        DiscoveryResult for Homebrew publishing
    """
    result = DiscoveryResult(
        name="homebrew",
        display_name="Homebrew",
        detected=False,
        configured=False,
        config_key="publishers.homebrew",
        dependencies=["brew", "gh"],
    )

    # Check for existing formula directory (strong signal)
    has_formula_dir = (project_root / "Formula").is_dir()
    has_homebrew_dir = (project_root / "homebrew").is_dir()

    if has_formula_dir:
        # Check for actual formula files
        formula_files = list((project_root / "Formula").glob("*.rb"))
        if formula_files:
            result.detected = True
            result.details = f"Formula directory with {len(formula_files)} formula(s)"
            if not check_command_exists("brew"):
                result.missing_dependencies.append("brew")
            if not check_command_exists("gh"):
                result.missing_dependencies.append("gh")
            return result

    if has_homebrew_dir:
        result.detected = True
        result.details = "Homebrew directory found"
        if not check_command_exists("brew"):
            result.missing_dependencies.append("brew")
        if not check_command_exists("gh"):
            result.missing_dependencies.append("gh")
        return result

    # Check for CLI indicators - be conservative
    cli_indicators = []

    # Check package.json for bin field (strong signal for Node.js CLI)
    package_json = project_root / "package.json"
    if package_json.exists():
        try:
            data = json.loads(package_json.read_text())
            if "bin" in data:
                bin_field = data["bin"]
                if isinstance(bin_field, dict):
                    cli_indicators.append(f"Node.js CLI: {', '.join(bin_field.keys())}")
                elif isinstance(bin_field, str):
                    cli_indicators.append(f"Node.js CLI: {data.get('name', 'unknown')}")
        except (json.JSONDecodeError, OSError):
            pass

    # Check Cargo.toml for [[bin]] section (strong signal)
    # Note: [package] alone is NOT sufficient - many libraries have [package]
    cargo_toml = project_root / "Cargo.toml"
    if cargo_toml.exists():
        try:
            import sys

            if sys.version_info >= (3, 11):
                import tomllib
            else:
                import tomli as tomllib

            with open(cargo_toml, "rb") as f:
                data = tomllib.load(f)

            # Check for explicit [[bin]] section (clear CLI indicator)
            if "bin" in data:
                bins = data["bin"]
                if isinstance(bins, list) and len(bins) > 0:
                    bin_names = [b.get("name", "unknown") for b in bins]
                    cli_indicators.append(f"Rust CLI: {', '.join(bin_names)}")

            # Check for src/main.rs (implicit binary) - but only if no lib.rs
            src_main = project_root / "src" / "main.rs"
            src_lib = project_root / "src" / "lib.rs"
            if src_main.exists() and not src_lib.exists():
                # Pure binary crate
                pkg_name = data.get("package", {}).get("name", "unknown")
                cli_indicators.append(f"Rust binary: {pkg_name}")
            elif src_main.exists() and src_lib.exists():
                # Both - could be CLI with lib, check for bin section
                if "bin" not in data:
                    # Implicit default binary alongside lib - likely a CLI
                    pkg_name = data.get("package", {}).get("name", "unknown")
                    cli_indicators.append(f"Rust binary+lib: {pkg_name}")

        except Exception:
            pass

    # Check Go for main package (CLI indicator)
    go_mod = project_root / "go.mod"
    main_go = project_root / "main.go"
    cmd_dir = project_root / "cmd"
    if go_mod.exists():
        if main_go.exists():
            cli_indicators.append("Go CLI: main.go")
        elif cmd_dir.is_dir():
            # cmd/ directory pattern for multiple CLIs
            cmd_entries = [d.name for d in cmd_dir.iterdir() if d.is_dir()]
            if cmd_entries:
                cli_indicators.append(f"Go CLI: cmd/{', cmd/'.join(cmd_entries[:3])}")

    # Check pyproject.toml for scripts (CLI entry points)
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

            # Check for [project.scripts]
            scripts = data.get("project", {}).get("scripts", {})
            if scripts:
                cli_indicators.append(
                    f"Python CLI: {', '.join(list(scripts.keys())[:3])}"
                )

            # Check for Poetry scripts
            poetry_scripts = data.get("tool", {}).get("poetry", {}).get("scripts", {})
            if poetry_scripts:
                cli_indicators.append(
                    f"Python CLI (Poetry): {', '.join(list(poetry_scripts.keys())[:3])}"
                )

        except Exception:
            pass

    # Only detect if we found clear CLI indicators
    if cli_indicators:
        result.detected = True
        result.details = "; ".join(cli_indicators[:2])  # Limit details length

        if not check_command_exists("brew"):
            result.missing_dependencies.append("brew")
        if not check_command_exists("gh"):
            result.missing_dependencies.append("gh")

    return result


def detect_docker_publishing(project_root: Path) -> DiscoveryResult:
    """Detect if project can publish Docker images.

    Supports Docker, Podman, and various container file formats.

    SHORTCOMINGS:
    - Does not parse Dockerfile to detect base images or build stages
    - Does not detect multi-platform build configurations
    - Does not check for .dockerignore (best practice)
    - Does not detect if image is already published to a registry
    - Cannot determine target registry (DockerHub, GHCR, ECR, GCR, etc.)
    - Does not validate Dockerfile syntax
    - Does not detect buildx/buildkit requirements
    - Does not check for HEALTHCHECK or security best practices

    Args:
        project_root: Path to project root

    Returns:
        DiscoveryResult for Docker publishing
    """
    result = DiscoveryResult(
        name="docker",
        display_name="Docker Registry",
        detected=False,
        configured=False,
        config_key="publishers.docker",
        dependencies=["docker"],
    )

    # Check for container files (Docker and Podman compatible)
    container_files = {
        "Dockerfile": "Dockerfile",
        "Containerfile": "Containerfile (Podman)",
        "Dockerfile.prod": "Dockerfile.prod",
        "Dockerfile.production": "Dockerfile.production",
        "docker/Dockerfile": "docker/Dockerfile",
        ".docker/Dockerfile": ".docker/Dockerfile",
    }

    # Check for compose files
    compose_files = [
        "docker-compose.yml",
        "docker-compose.yaml",
        "compose.yml",
        "compose.yaml",
        "docker-compose.prod.yml",
        "docker-compose.production.yml",
    ]

    found_files = []

    # Check main container files
    for filename, description in container_files.items():
        filepath = project_root / filename
        if filepath.exists():
            found_files.append(description)

            # Try to parse Dockerfile for useful info
            try:
                content = filepath.read_text()
                lines = content.splitlines()

                # Find FROM instruction (base image)
                base_images = []
                for line in lines:
                    line = line.strip()
                    if line.upper().startswith("FROM "):
                        # Parse: FROM image:tag AS stage
                        parts = line[5:].split()
                        if parts:
                            base_images.append(parts[0])

                if base_images:
                    # Report first and last base image (for multi-stage)
                    if len(base_images) == 1:
                        found_files[-1] += f" (base: {base_images[0]})"
                    else:
                        found_files[-1] += f" ({len(base_images)} stages)"

            except OSError:
                pass

    # Check compose files
    compose_found = []
    for filename in compose_files:
        if (project_root / filename).exists():
            compose_found.append(filename)

    if compose_found:
        found_files.append(f"Compose: {compose_found[0]}")

    # Check for .dockerignore (good practice indicator)
    has_dockerignore = (project_root / ".dockerignore").exists()

    if found_files:
        result.detected = True
        result.details = "; ".join(found_files[:2])
        if has_dockerignore:
            result.details += " [.dockerignore]"

        # Check for container runtime
        # Support both Docker and Podman
        has_docker = check_command_exists("docker")
        has_podman = check_command_exists("podman")

        if not has_docker and not has_podman:
            result.missing_dependencies.append("docker (or podman)")
        elif has_podman and not has_docker:
            result.details += " [using podman]"

        # Check for buildx (multi-platform builds)
        if has_docker:
            # Note: Can't easily check for buildx without running docker
            # Just note that it might be needed for multi-platform
            pass

    return result


def detect_gitlab_publishing(project_root: Path) -> DiscoveryResult:
    """Detect if project uses GitLab for releases.

    Parses git remote URLs to detect GitLab repositories.

    SHORTCOMINGS:
    - Does not detect self-hosted GitLab instances reliably
    - Does not check for CI/CD pipeline configuration
    - Does not verify authentication status
    - Does not detect GitLab packages (npm, PyPI, Maven registries)

    Args:
        project_root: Path to project root

    Returns:
        DiscoveryResult for GitLab Releases publishing
    """
    result = DiscoveryResult(
        name="gitlab",
        display_name="GitLab Releases",
        detected=False,
        configured=False,
        config_key="publishers.gitlab",
        dependencies=["glab"],
    )

    git_dir = project_root / ".git"
    if not git_dir.exists():
        return result

    def parse_gitlab_url(url: str) -> str | None:
        """Parse owner/repo from GitLab URL formats."""
        url = url.strip()

        # HTTPS format: https://gitlab.com/owner/repo.git
        https_match = re.match(
            r"https?://(?:www\.)?gitlab\.com/([^/]+)/([^/\s]+?)(?:\.git)?$", url
        )
        if https_match:
            return f"{https_match.group(1)}/{https_match.group(2)}"

        # SSH format: git@gitlab.com:owner/repo.git
        ssh_match = re.match(r"git@gitlab\.com:([^/]+)/([^/\s]+?)(?:\.git)?$", url)
        if ssh_match:
            return f"{ssh_match.group(1)}/{ssh_match.group(2)}"

        return None

    try:
        git_config = git_dir / "config"
        if git_config.exists():
            content = git_config.read_text()

            current_remote = None
            for line in content.splitlines():
                line = line.strip()

                remote_match = re.match(r'\[remote\s+"([^"]+)"\]', line)
                if remote_match:
                    current_remote = remote_match.group(1)
                    continue

                if current_remote and line.startswith("url = "):
                    url = line[6:].strip()
                    parsed = parse_gitlab_url(url)
                    if parsed:
                        result.detected = True
                        result.details = f"Repository: {parsed}"
                        break

    except OSError:
        pass

    # Check for .gitlab-ci.yml
    gitlab_ci = project_root / ".gitlab-ci.yml"
    if gitlab_ci.exists():
        if not result.detected:
            result.detected = True
            result.details = "GitLab CI/CD detected"
        else:
            result.details += " [.gitlab-ci.yml]"

    if result.detected:
        if not check_command_exists("glab"):
            result.missing_dependencies.append("glab")

    return result


def detect_maven_publishing(project_root: Path) -> DiscoveryResult:
    """Detect if project can publish to Maven Central or other Maven repos.

    SHORTCOMINGS:
    - Does not detect Gradle projects with Maven publishing
    - Does not validate GPG signing configuration
    - Does not check for Sonatype/Maven Central credentials
    - Does not parse full POM for distributionManagement

    Args:
        project_root: Path to project root

    Returns:
        DiscoveryResult for Maven publishing
    """
    result = DiscoveryResult(
        name="maven",
        display_name="Maven Central",
        detected=False,
        configured=False,
        config_key="publishers.maven",
        dependencies=["mvn"],
    )

    pom_xml = project_root / "pom.xml"
    if not pom_xml.exists():
        # Check for Gradle with maven-publish plugin
        build_gradle = project_root / "build.gradle"
        build_gradle_kts = project_root / "build.gradle.kts"

        gradle_file = None
        if build_gradle.exists():
            gradle_file = build_gradle
        elif build_gradle_kts.exists():
            gradle_file = build_gradle_kts

        if gradle_file:
            try:
                content = gradle_file.read_text()
                if "maven-publish" in content or "publishing" in content:
                    result.detected = True
                    result.details = f"Gradle with maven-publish ({gradle_file.name})"
                    result.dependencies = ["gradle"]
                    if not check_command_exists("gradle"):
                        # Check for wrapper
                        gradlew = project_root / "gradlew"
                        if not gradlew.exists():
                            result.missing_dependencies.append("gradle")
            except OSError:
                pass

        return result

    try:
        content = pom_xml.read_text()

        # Extract groupId and artifactId
        group_match = re.search(r"<groupId>([^<]+)</groupId>", content)
        artifact_match = re.search(r"<artifactId>([^<]+)</artifactId>", content)
        version_match = re.search(r"<version>([^<]+)</version>", content)

        if group_match and artifact_match:
            result.detected = True
            group_id = group_match.group(1)
            artifact_id = artifact_match.group(1)
            result.details = f"Maven: {group_id}:{artifact_id}"

            if version_match:
                version = version_match.group(1)
                result.details += f":{version}"
                result.version = VersionInfo(
                    current=version,
                    source_file="pom.xml",
                    source_field="version",
                )

        # Check for distributionManagement
        if "<distributionManagement>" in content:
            result.details += " [distributionManagement]"

        # Check for signing plugin
        if "maven-gpg-plugin" in content:
            result.details += " [GPG signing]"

    except OSError:
        pass

    if result.detected:
        if not check_command_exists("mvn"):
            result.missing_dependencies.append("mvn")

    return result


def detect_nuget_publishing(project_root: Path) -> DiscoveryResult:
    """Detect if project can publish to NuGet.

    SHORTCOMINGS:
    - Does not parse .csproj for PackageId metadata
    - Does not check for NuGet API key
    - Does not validate package metadata completeness
    - Does not detect GitHub Packages NuGet publishing

    Args:
        project_root: Path to project root

    Returns:
        DiscoveryResult for NuGet publishing
    """
    result = DiscoveryResult(
        name="nuget",
        display_name="NuGet",
        detected=False,
        configured=False,
        config_key="publishers.nuget",
        dependencies=["dotnet"],
    )

    # Check for .csproj files
    csproj_files = list(project_root.glob("**/*.csproj"))
    if not csproj_files:
        return result

    publishable_projects = []
    for csproj in csproj_files[:10]:  # Limit search
        try:
            content = csproj.read_text()

            # Check if it's a library (not executable)
            is_library = (
                "Library" in content
                or "<OutputType>Library</OutputType>" in content
                or "<OutputType>" not in content  # Default is library
            )

            # Check for IsPackable (explicit)
            is_packable = "<IsPackable>true</IsPackable>" in content.lower()
            not_packable = "<IsPackable>false</IsPackable>" in content.lower()

            if not_packable:
                continue

            if is_library or is_packable:
                # Extract package info
                pkg_id_match = re.search(r"<PackageId>([^<]+)</PackageId>", content)
                version_match = re.search(r"<Version>([^<]+)</Version>", content)

                pkg_name = pkg_id_match.group(1) if pkg_id_match else csproj.stem
                version = version_match.group(1) if version_match else None

                publishable_projects.append(
                    {
                        "name": pkg_name,
                        "file": csproj.name,
                        "version": version,
                    }
                )

        except OSError:
            pass

    if publishable_projects:
        result.detected = True
        if len(publishable_projects) == 1:
            pkg = publishable_projects[0]
            result.details = f"Package: {pkg['name']}"
            if pkg["version"]:
                result.details += f" v{pkg['version']}"
                result.version = VersionInfo(
                    current=pkg["version"],
                    source_file=pkg["file"],
                    source_field="Version",
                )
        else:
            result.details = f"{len(publishable_projects)} publishable projects"

        if not check_command_exists("dotnet"):
            result.missing_dependencies.append("dotnet")

    return result


def detect_rubygems_publishing(project_root: Path) -> DiscoveryResult:
    """Detect if project can publish to RubyGems.

    SHORTCOMINGS:
    - Does not validate gemspec completeness
    - Does not check for RubyGems API key
    - Does not detect gem signing configuration
    - Does not handle multi-gem repositories

    Args:
        project_root: Path to project root

    Returns:
        DiscoveryResult for RubyGems publishing
    """
    result = DiscoveryResult(
        name="rubygems",
        display_name="RubyGems",
        detected=False,
        configured=False,
        config_key="publishers.rubygems",
        dependencies=["gem"],
    )

    gemspecs = list(project_root.glob("*.gemspec"))
    if not gemspecs:
        return result

    gemspec = gemspecs[0]
    try:
        content = gemspec.read_text()

        # Extract gem name and version
        name_match = re.search(r'\.name\s*=\s*["\']([^"\']+)["\']', content)
        version_match = re.search(r'\.version\s*=\s*["\']([^"\']+)["\']', content)
        # Also check for VERSION constant reference
        version_const_match = re.search(r"\.version\s*=\s*(\w+)::VERSION", content)

        gem_name = name_match.group(1) if name_match else gemspec.stem

        result.detected = True
        result.details = f"Gem: {gem_name}"

        if version_match:
            version = version_match.group(1)
            result.details += f" v{version}"
            result.version = VersionInfo(
                current=version,
                source_file=gemspec.name,
                source_field="version",
            )
        elif version_const_match:
            result.details += " (version from constant)"

        # Check for required metadata
        missing = []
        if "summary" not in content.lower():
            missing.append("summary")
        if "license" not in content.lower():
            missing.append("license")
        if missing:
            result.details += f" (missing: {', '.join(missing)})"

    except OSError:
        pass

    if result.detected:
        if not check_command_exists("gem"):
            result.missing_dependencies.append("gem")

    return result


def detect_hex_publishing(project_root: Path) -> DiscoveryResult:
    """Detect if project can publish to Hex.pm (Elixir).

    SHORTCOMINGS:
    - Does not validate package metadata
    - Does not check for Hex API key
    - Does not detect umbrella applications properly

    Args:
        project_root: Path to project root

    Returns:
        DiscoveryResult for Hex.pm publishing
    """
    result = DiscoveryResult(
        name="hex",
        display_name="Hex.pm",
        detected=False,
        configured=False,
        config_key="publishers.hex",
        dependencies=["mix"],
    )

    mix_exs = project_root / "mix.exs"
    if not mix_exs.exists():
        return result

    try:
        content = mix_exs.read_text()

        # Check for hex package configuration
        if "package:" in content or ":package" in content:
            result.detected = True

            # Extract app name
            app_match = re.search(r"app:\s*:(\w+)", content)
            version_match = re.search(r'version:\s*"([^"]+)"', content)

            if app_match:
                result.details = f"Package: {app_match.group(1)}"

            if version_match:
                version = version_match.group(1)
                if result.details:
                    result.details += f" v{version}"
                else:
                    result.details = f"v{version}"
                result.version = VersionInfo(
                    current=version,
                    source_file="mix.exs",
                    source_field="version",
                )

            # Check for umbrella
            if "apps_path" in content:
                result.details += " [umbrella]"

    except OSError:
        pass

    if result.detected:
        if not check_command_exists("mix"):
            result.missing_dependencies.append("mix")

    return result


def detect_packagist_publishing(project_root: Path) -> DiscoveryResult:
    """Detect if project can publish to Packagist (PHP).

    SHORTCOMINGS:
    - Does not check for Packagist account
    - Does not validate autoload configuration
    - Does not detect private Satis/Packagist instances

    Args:
        project_root: Path to project root

    Returns:
        DiscoveryResult for Packagist publishing
    """
    result = DiscoveryResult(
        name="packagist",
        display_name="Packagist",
        detected=False,
        configured=False,
        config_key="publishers.packagist",
        dependencies=["composer"],
    )

    composer_json = project_root / "composer.json"
    if not composer_json.exists():
        return result

    data = load_json(composer_json)
    if not data:
        return result

    # Check for package name (vendor/package format)
    name = data.get("name", "")
    if "/" in name:
        result.detected = True
        result.details = f"Package: {name}"

        version = data.get("version")
        if version:
            result.details += f" v{version}"
            result.version = VersionInfo(
                current=version,
                source_file="composer.json",
                source_field="version",
            )

        # Check for type
        pkg_type = data.get("type", "library")
        if pkg_type != "library":
            result.details += f" [{pkg_type}]"

        # Check for autoload
        if "autoload" in data:
            result.details += " [autoload]"

    if result.detected:
        if not check_command_exists("composer"):
            result.missing_dependencies.append("composer")

    return result


# =============================================================================
# HELPER DETECTION FUNCTIONS
# =============================================================================


def detect_monorepo(project_root: Path) -> MonorepoInfo:
    """Detect monorepo structure and tool.

    Supports: Lerna, Nx, Turborepo, pnpm workspaces, Cargo workspaces,
    Go workspaces, Yarn workspaces.

    Args:
        project_root: Path to project root

    Returns:
        MonorepoInfo with detected structure
    """
    info = MonorepoInfo()

    # Check for pnpm workspaces
    pnpm_workspace = project_root / "pnpm-workspace.yaml"
    if pnpm_workspace.exists():
        info.is_monorepo = True
        info.tool = "pnpm"
        try:
            data = load_yaml(pnpm_workspace)
            if data and "packages" in data:
                info.packages = data["packages"]
        except Exception:
            pass
        return info

    # Check for Lerna
    lerna_json = project_root / "lerna.json"
    if lerna_json.exists():
        info.is_monorepo = True
        info.tool = "lerna"
        try:
            data = load_json(lerna_json)
            if data:
                info.packages = data.get("packages", ["packages/*"])
        except Exception:
            pass
        return info

    # Check for Nx
    nx_json = project_root / "nx.json"
    if nx_json.exists():
        info.is_monorepo = True
        info.tool = "nx"
        return info

    # Check for Turborepo
    turbo_json = project_root / "turbo.json"
    if turbo_json.exists():
        info.is_monorepo = True
        info.tool = "turborepo"
        return info

    # Check for Yarn workspaces in package.json
    package_json = project_root / "package.json"
    if package_json.exists():
        data = load_json(package_json)
        if data and "workspaces" in data:
            info.is_monorepo = True
            info.tool = "yarn" if (project_root / "yarn.lock").exists() else "npm"
            workspaces = data["workspaces"]
            if isinstance(workspaces, list):
                info.packages = workspaces
            elif isinstance(workspaces, dict):
                info.packages = workspaces.get("packages", [])
            return info

    # Check for Cargo workspace
    cargo_toml = project_root / "Cargo.toml"
    if cargo_toml.exists():
        data = load_toml(cargo_toml)
        if data and "workspace" in data:
            info.is_monorepo = True
            info.tool = "cargo"
            info.packages = data.get("workspace", {}).get("members", [])
            return info

    # Check for Go workspace
    go_work = project_root / "go.work"
    if go_work.exists():
        info.is_monorepo = True
        info.tool = "go"
        try:
            content = go_work.read_text()
            packages = []
            for line in content.splitlines():
                line = line.strip()
                if line.startswith("use "):
                    path = line[4:].strip().strip('"')
                    if path not in ("(", ")"):
                        packages.append(path)
                elif line.startswith("./") or line.startswith("../"):
                    packages.append(line.strip('"'))
            info.packages = packages
        except OSError:
            pass
        return info

    return info


def detect_ci_platforms(project_root: Path) -> CIInfo:
    """Detect CI/CD platforms and workflows.

    Args:
        project_root: Path to project root

    Returns:
        CIInfo with detected platforms and workflows
    """
    info = CIInfo()

    # GitHub Actions
    github_workflows = project_root / ".github" / "workflows"
    if github_workflows.is_dir():
        info.platforms.append(CIPlatform.GITHUB_ACTIONS)
        for wf in github_workflows.glob("*.yml"):
            info.workflow_files.append(f".github/workflows/{wf.name}")
            try:
                content = wf.read_text().lower()
                if "release" in content or "publish" in content:
                    info.has_release_workflow = True
                    if "npm publish" in content or "publish --access" in content:
                        info.has_publish_workflow = True
            except OSError:
                pass
        for wf in github_workflows.glob("*.yaml"):
            info.workflow_files.append(f".github/workflows/{wf.name}")

    # GitLab CI
    gitlab_ci = project_root / ".gitlab-ci.yml"
    if gitlab_ci.exists():
        info.platforms.append(CIPlatform.GITLAB_CI)
        info.workflow_files.append(".gitlab-ci.yml")

    # CircleCI
    circleci = project_root / ".circleci" / "config.yml"
    if circleci.exists():
        info.platforms.append(CIPlatform.CIRCLECI)
        info.workflow_files.append(".circleci/config.yml")

    # Travis CI
    travis = project_root / ".travis.yml"
    if travis.exists():
        info.platforms.append(CIPlatform.TRAVIS)
        info.workflow_files.append(".travis.yml")

    # Jenkins
    jenkinsfile = project_root / "Jenkinsfile"
    if jenkinsfile.exists():
        info.platforms.append(CIPlatform.JENKINS)
        info.workflow_files.append("Jenkinsfile")

    # Azure Pipelines
    azure_pipelines = project_root / "azure-pipelines.yml"
    if azure_pipelines.exists():
        info.platforms.append(CIPlatform.AZURE_PIPELINES)
        info.workflow_files.append("azure-pipelines.yml")

    # Bitbucket Pipelines
    bitbucket = project_root / "bitbucket-pipelines.yml"
    if bitbucket.exists():
        info.platforms.append(CIPlatform.BITBUCKET_PIPELINES)
        info.workflow_files.append("bitbucket-pipelines.yml")

    return info


def detect_release_automation(project_root: Path) -> ReleaseAutomationInfo:
    """Detect release automation tools.

    Args:
        project_root: Path to project root

    Returns:
        ReleaseAutomationInfo with detected tools
    """
    info = ReleaseAutomationInfo()

    # Check package.json for JS tools
    package_json = project_root / "package.json"
    if package_json.exists():
        data = load_json(package_json)
        if data:
            all_deps = {
                **data.get("dependencies", {}),
                **data.get("devDependencies", {}),
            }

            if "semantic-release" in all_deps:
                info.tools.append(ReleaseAutomation.SEMANTIC_RELEASE)
            if "@changesets/cli" in all_deps or "changesets" in all_deps:
                info.tools.append(ReleaseAutomation.CHANGESETS)
            if "standard-version" in all_deps:
                info.tools.append(ReleaseAutomation.STANDARD_VERSION)

    # Check for release-please
    release_please = project_root / "release-please-config.json"
    if release_please.exists():
        info.tools.append(ReleaseAutomation.RELEASE_PLEASE)
        info.config_files.append("release-please-config.json")

    # Also check workflow files for release-please
    github_workflows = project_root / ".github" / "workflows"
    if github_workflows.is_dir():
        for wf in github_workflows.glob("*.yml"):
            try:
                content = wf.read_text()
                if "release-please" in content:
                    if ReleaseAutomation.RELEASE_PLEASE not in info.tools:
                        info.tools.append(ReleaseAutomation.RELEASE_PLEASE)
                        info.config_files.append(f".github/workflows/{wf.name}")
            except OSError:
                pass

    # Check for changesets
    changesets_dir = project_root / ".changeset"
    if changesets_dir.is_dir():
        info.tools.append(ReleaseAutomation.CHANGESETS)
        info.config_files.append(".changeset/")

    # Check for cargo-release
    cargo_toml = project_root / "Cargo.toml"
    if cargo_toml.exists():
        data = load_toml(cargo_toml)
        if data and "release" in data.get("workspace", {}).get("metadata", {}):
            info.tools.append(ReleaseAutomation.CARGO_RELEASE)
        if data and "release" in data.get("package", {}).get("metadata", {}):
            info.tools.append(ReleaseAutomation.CARGO_RELEASE)

    # Check for goreleaser
    goreleaser_files = [".goreleaser.yml", ".goreleaser.yaml", "goreleaser.yml"]
    for filename in goreleaser_files:
        if (project_root / filename).exists():
            info.tools.append(ReleaseAutomation.GORELEASER)
            info.config_files.append(filename)
            break

    # Check for git-cliff
    cliff_toml = project_root / "cliff.toml"
    if cliff_toml.exists():
        info.tools.append(ReleaseAutomation.GIT_CLIFF)
        info.config_files.append("cliff.toml")

    # Check for conventional commits (commitlint)
    commitlint_files = [
        "commitlint.config.js",
        "commitlint.config.cjs",
        ".commitlintrc.js",
        ".commitlintrc.json",
    ]
    for filename in commitlint_files:
        if (project_root / filename).exists():
            info.tools.append(ReleaseAutomation.CONVENTIONAL_COMMITS)
            info.config_files.append(filename)
            break

    return info


def detect_auth_status(project_root: Path) -> list[AuthInfo]:
    """Detect authentication/credential status for various services.

    Checks environment variables and config files for credentials.
    Does NOT log or expose actual credential values.

    Args:
        project_root: Path to project root

    Returns:
        List of AuthInfo for each service
    """
    auth_list = []

    # npm auth
    npm_auth = AuthInfo(name="npm", available=False)
    if os.environ.get("NPM_TOKEN"):
        npm_auth.available = True
        npm_auth.source = "NPM_TOKEN env var"
    elif os.environ.get("NODE_AUTH_TOKEN"):
        npm_auth.available = True
        npm_auth.source = "NODE_AUTH_TOKEN env var"
    else:
        # Check for .npmrc
        npmrc_paths = [
            project_root / ".npmrc",
            Path.home() / ".npmrc",
        ]
        for npmrc in npmrc_paths:
            if npmrc.exists():
                try:
                    content = npmrc.read_text()
                    if "//registry.npmjs.org/:_authToken" in content:
                        npm_auth.available = True
                        npm_auth.source = str(npmrc)
                        break
                except OSError:
                    pass
    auth_list.append(npm_auth)

    # PyPI auth
    pypi_auth = AuthInfo(name="pypi", available=False)
    if os.environ.get("TWINE_PASSWORD") or os.environ.get("PYPI_API_TOKEN"):
        pypi_auth.available = True
        pypi_auth.source = "env var"
    else:
        pypirc = Path.home() / ".pypirc"
        if pypirc.exists():
            pypi_auth.available = True
            pypi_auth.source = "~/.pypirc"
    auth_list.append(pypi_auth)

    # GitHub auth
    gh_auth = AuthInfo(name="github", available=False)
    if os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN"):
        gh_auth.available = True
        gh_auth.source = "env var"
    elif check_command_exists("gh"):
        # Check if gh is authenticated
        try:
            result = subprocess.run(
                ["gh", "auth", "status"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode == 0:
                gh_auth.available = True
                gh_auth.source = "gh auth"
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            pass
    auth_list.append(gh_auth)

    # Docker auth
    docker_auth = AuthInfo(name="docker", available=False)
    docker_config = Path.home() / ".docker" / "config.json"
    if docker_config.exists():
        try:
            data = load_json(docker_config)
            if data and "auths" in data and data["auths"]:
                docker_auth.available = True
                registries = list(data["auths"].keys())[:2]
                docker_auth.source = f"~/.docker/config.json ({', '.join(registries)})"
        except Exception:
            pass
    auth_list.append(docker_auth)

    # crates.io auth
    crates_auth = AuthInfo(name="crates.io", available=False)
    if os.environ.get("CARGO_REGISTRY_TOKEN"):
        crates_auth.available = True
        crates_auth.source = "CARGO_REGISTRY_TOKEN env var"
    else:
        cargo_credentials = Path.home() / ".cargo" / "credentials.toml"
        cargo_credentials_old = Path.home() / ".cargo" / "credentials"
        if cargo_credentials.exists() or cargo_credentials_old.exists():
            crates_auth.available = True
            crates_auth.source = "~/.cargo/credentials"
    auth_list.append(crates_auth)

    # Hex.pm auth (Elixir)
    hex_auth = AuthInfo(name="hex.pm", available=False)
    if os.environ.get("HEX_API_KEY"):
        hex_auth.available = True
        hex_auth.source = "HEX_API_KEY env var"
    auth_list.append(hex_auth)

    # RubyGems auth
    gem_auth = AuthInfo(name="rubygems", available=False)
    if os.environ.get("GEM_HOST_API_KEY"):
        gem_auth.available = True
        gem_auth.source = "GEM_HOST_API_KEY env var"
    else:
        gem_credentials = Path.home() / ".gem" / "credentials"
        if gem_credentials.exists():
            gem_auth.available = True
            gem_auth.source = "~/.gem/credentials"
    auth_list.append(gem_auth)

    return auth_list


def detect_github_publishing(project_root: Path) -> DiscoveryResult:
    """Detect if project uses GitHub for releases.

    Parses git remote URLs to detect GitHub repositories. Supports both
    HTTPS and SSH URL formats.

    SHORTCOMINGS:
    - Does not detect GitHub Enterprise instances
    - Does not check if user has push access to the repository
    - Does not verify that gh CLI is authenticated
    - Does not detect existing releases or release patterns
    - Cannot determine if project uses release automation (release-please, etc.)
    - Does not check for .github/workflows release workflows
    - Does not detect release assets configuration

    Args:
        project_root: Path to project root

    Returns:
        DiscoveryResult for GitHub Releases publishing
    """
    result = DiscoveryResult(
        name="github",
        display_name="GitHub Releases",
        detected=False,
        configured=False,
        config_key="publishers.github",
        dependencies=["gh"],
    )

    git_dir = project_root / ".git"
    if not git_dir.exists():
        return result

    import re

    def parse_github_url(url: str) -> str | None:
        """Parse owner/repo from various GitHub URL formats.

        Supports:
        - https://github.com/owner/repo.git
        - https://github.com/owner/repo
        - git@github.com:owner/repo.git
        - git@github.com:owner/repo
        - ssh://git@github.com/owner/repo.git
        - github:owner/repo (git shorthand)
        """
        url = url.strip()

        # HTTPS format: https://github.com/owner/repo.git
        https_match = re.match(
            r"https?://(?:www\.)?github\.com/([^/]+)/([^/\s]+?)(?:\.git)?$", url
        )
        if https_match:
            return f"{https_match.group(1)}/{https_match.group(2)}"

        # SSH format: git@github.com:owner/repo.git
        ssh_match = re.match(r"git@github\.com:([^/]+)/([^/\s]+?)(?:\.git)?$", url)
        if ssh_match:
            return f"{ssh_match.group(1)}/{ssh_match.group(2)}"

        # SSH with protocol: ssh://git@github.com/owner/repo.git
        ssh_proto_match = re.match(
            r"ssh://git@github\.com/([^/]+)/([^/\s]+?)(?:\.git)?$", url
        )
        if ssh_proto_match:
            return f"{ssh_proto_match.group(1)}/{ssh_proto_match.group(2)}"

        # Git shorthand: github:owner/repo
        shorthand_match = re.match(r"github:([^/]+)/([^/\s]+?)(?:\.git)?$", url)
        if shorthand_match:
            return f"{shorthand_match.group(1)}/{shorthand_match.group(2)}"

        return None

    # Try to get remote URL from git config
    repo_info = None

    try:
        git_config = git_dir / "config"
        if git_config.exists():
            content = git_config.read_text()

            # Parse git config to find remotes
            # Format:
            # [remote "origin"]
            #     url = git@github.com:owner/repo.git
            current_remote = None
            for line in content.splitlines():
                line = line.strip()

                # Check for remote section
                remote_match = re.match(r'\[remote\s+"([^"]+)"\]', line)
                if remote_match:
                    current_remote = remote_match.group(1)
                    continue

                # Check for url line
                if current_remote and line.startswith("url = "):
                    url = line[6:].strip()
                    parsed = parse_github_url(url)
                    if parsed:
                        repo_info = parsed
                        result.details = f"Repository: {repo_info}"
                        if current_remote != "origin":
                            result.details += f" (remote: {current_remote})"
                        result.detected = True
                        break

    except OSError as e:
        result.details = f"Error reading git config: {e}"

    # If git config parsing failed, try using git command as fallback
    if not result.detected:
        try:
            import subprocess

            git_result = subprocess.run(
                ["git", "-C", str(project_root), "remote", "get-url", "origin"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if git_result.returncode == 0:
                url = git_result.stdout.strip()
                parsed = parse_github_url(url)
                if parsed:
                    repo_info = parsed
                    result.details = f"Repository: {repo_info}"
                    result.detected = True
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            pass

    # Check for release-related files
    if result.detected:
        release_indicators = []

        # Check for release workflows
        workflows_dir = project_root / ".github" / "workflows"
        if workflows_dir.is_dir():
            for wf_file in workflows_dir.glob("*.yml"):
                try:
                    content = wf_file.read_text()
                    if (
                        "release" in wf_file.name.lower()
                        or "gh release" in content.lower()
                    ):
                        release_indicators.append(wf_file.name)
                except OSError:
                    pass

            for wf_file in workflows_dir.glob("*.yaml"):
                try:
                    content = wf_file.read_text()
                    if (
                        "release" in wf_file.name.lower()
                        or "gh release" in content.lower()
                    ):
                        release_indicators.append(wf_file.name)
                except OSError:
                    pass

        if release_indicators:
            result.details += f" [workflows: {', '.join(release_indicators[:2])}]"

        # Check for gh CLI
        if not check_command_exists("gh"):
            result.missing_dependencies.append("gh")

    return result


def discover_project(
    project_root: Path,
    config: ReleaseConfig | None = None,
    verbose: bool = False,
) -> ProjectDiscovery:
    """Discover all applicable ecosystems and publishers for a project.

    Args:
        project_root: Path to project root
        config: Existing configuration (if any)
        verbose: Whether to show detailed output

    Returns:
        ProjectDiscovery with all detected ecosystems and publishers
    """
    discovery = ProjectDiscovery()

    # Detect ecosystems
    ecosystem_detectors = [
        detect_nodejs_ecosystem,
        detect_python_ecosystem,
        detect_rust_ecosystem,
        detect_go_ecosystem,
        detect_ruby_ecosystem,
        detect_java_ecosystem,
        detect_dotnet_ecosystem,
        detect_php_ecosystem,
        detect_elixir_ecosystem,
    ]

    for detector in ecosystem_detectors:
        result = detector(project_root)

        # Check if already configured
        if config:
            configured_ecosystem = getattr(config.project, "ecosystem", None)
            if configured_ecosystem:
                result.configured = result.name == configured_ecosystem

        discovery.ecosystems.append(result)

        if result.detected and not result.configured:
            discovery.new_ecosystems.append(result)

        # Set primary ecosystem (first detected with high confidence)
        if (
            result.detected
            and result.confidence == ConfidenceLevel.HIGH
            and not discovery.primary_ecosystem
        ):
            discovery.primary_ecosystem = result.name
            if result.version:
                discovery.project_version = result.version

    # Detect publishers
    publisher_detectors = [
        detect_npm_publishing,
        detect_pypi_publishing,
        detect_crates_publishing,
        detect_go_publishing,
        detect_homebrew_publishing,
        detect_docker_publishing,
        detect_github_publishing,
        detect_gitlab_publishing,
        detect_maven_publishing,
        detect_nuget_publishing,
        detect_rubygems_publishing,
        detect_hex_publishing,
        detect_packagist_publishing,
    ]

    for detector in publisher_detectors:
        result = detector(project_root)

        # Check if already configured
        if config:
            # Check if publisher is in the enabled list
            configured_publishers = getattr(config, "publishers", [])
            if isinstance(configured_publishers, list):
                result.configured = result.name in configured_publishers

        discovery.publishers.append(result)

        if result.detected and not result.configured:
            discovery.new_publishers.append(result)

    # Detect helper information
    discovery.monorepo = detect_monorepo(project_root)
    discovery.ci = detect_ci_platforms(project_root)
    discovery.release_automation = detect_release_automation(project_root)
    discovery.auth_status = detect_auth_status(project_root)

    return discovery


def show_discovery_status(
    discovery: ProjectDiscovery,
    show_all: bool = False,
) -> None:
    """Display discovery status with rich formatting.

    Args:
        discovery: Discovery results
        show_all: Whether to show all publishers (not just new ones)
    """
    has_output = False

    # Show primary ecosystem and version
    if discovery.primary_ecosystem:
        has_output = True
        console.print()
        eco_display = discovery.primary_ecosystem.title()
        if discovery.project_version and discovery.project_version.current:
            console.print(
                f"[bold cyan]Primary ecosystem:[/bold cyan] {eco_display} "
                f"[dim](v{discovery.project_version.current})[/dim]"
            )
        else:
            console.print(f"[bold cyan]Primary ecosystem:[/bold cyan] {eco_display}")

    # Show detected ecosystems
    detected_ecosystems = [e for e in discovery.ecosystems if e.detected]
    if detected_ecosystems and show_all:
        has_output = True
        console.print()
        console.print("[bold]Detected ecosystems:[/bold]")
        for eco in detected_ecosystems:
            icon = "[green]+[/green]" if eco.detected else "[dim]-[/dim]"
            conf_icon = " [cyan](configured)[/cyan]" if eco.configured else ""
            console.print(
                f"  {icon} [cyan]{eco.display_name}[/cyan]{conf_icon} "
                f"[dim]{eco.details}[/dim]"
            )
            if eco.missing_dependencies:
                deps = ", ".join(eco.missing_dependencies)
                console.print(f"      [yellow]Missing: {deps}[/yellow]")

    # Show monorepo info
    if discovery.monorepo and discovery.monorepo.is_monorepo:
        has_output = True
        console.print()
        console.print(
            f"[bold magenta]Monorepo:[/bold magenta] {discovery.monorepo.tool} "
            f"[dim]({len(discovery.monorepo.packages)} packages)[/dim]"
        )

    # Show CI platforms
    if discovery.ci and discovery.ci.platforms:
        has_output = True
        console.print()
        platforms = ", ".join(
            p.value.replace("_", " ").title() for p in discovery.ci.platforms
        )
        console.print(f"[bold blue]CI/CD:[/bold blue] {platforms}")
        if discovery.ci.has_release_workflow:
            console.print("  [dim]Release workflow detected[/dim]")
        if discovery.ci.has_publish_workflow:
            console.print("  [dim]Publish workflow detected[/dim]")

    # Show release automation
    if discovery.release_automation and discovery.release_automation.tools:
        has_output = True
        console.print()
        tools = ", ".join(t.value for t in discovery.release_automation.tools)
        console.print(f"[bold green]Release automation:[/bold green] {tools}")

    # Show new publishers
    if discovery.new_publishers:
        has_output = True
        console.print()
        console.print("[bold]New publishers detected:[/bold]")
        for pub in discovery.new_publishers:
            icon = "[green]>[/green]"
            console.print(
                f"  {icon} [cyan]{pub.display_name}[/cyan] [dim]({pub.details})[/dim]"
            )

            if pub.missing_dependencies:
                deps = ", ".join(pub.missing_dependencies)
                console.print(f"      [yellow]Missing: {deps}[/yellow]")

    # Show already configured if requested
    if show_all:
        configured_pubs = [p for p in discovery.publishers if p.configured]
        if configured_pubs:
            has_output = True
            console.print()
            console.print("[dim]Configured publishers:[/dim]")
            for pub in configured_pubs:
                console.print(f"  [dim]- {pub.display_name}[/dim]")

    # Show auth status if verbose
    if show_all and discovery.auth_status:
        has_output = True
        console.print()
        console.print("[bold]Authentication status:[/bold]")
        for auth in discovery.auth_status:
            if auth.available:
                console.print(
                    f"  [green]+[/green] {auth.name}: [green]available[/green] "
                    f"[dim]({auth.source})[/dim]"
                )
            else:
                console.print(f"  [red]-[/red] {auth.name}: [dim]not configured[/dim]")

    if has_output:
        console.print()


def install_missing_dependencies(
    discovery: ProjectDiscovery,
    dry_run: bool = False,
) -> bool:
    """Attempt to install missing dependencies.

    Args:
        discovery: Discovery results
        dry_run: Whether to just show what would be done

    Returns:
        True if all dependencies are available
    """
    all_missing: set[str] = set()
    for pub in discovery.new_publishers:
        all_missing.update(pub.missing_dependencies)

    if not all_missing:
        return True

    console.print("[yellow]Missing dependencies:[/yellow]")
    for dep in sorted(all_missing):
        console.print(f"  - {dep}")

    if dry_run:
        console.print("[dim]Would attempt to install these dependencies[/dim]")
        return False

    # Attempt installation based on what's missing
    success = True
    for dep in all_missing:
        if dep in ("npm", "node"):
            console.print(
                "[yellow]![/yellow] Please install Node.js: https://nodejs.org/"
            )
            success = False
        elif dep == "cargo":
            console.print("[yellow]![/yellow] Please install Rust: https://rustup.rs/")
            success = False
        elif dep == "go":
            console.print("[yellow]![/yellow] Please install Go: https://go.dev/dl/")
            success = False
        elif dep == "docker":
            console.print(
                "[yellow]![/yellow] Please install Docker: https://docker.com/"
            )
            success = False
        elif dep == "brew":
            console.print(
                "[yellow]![/yellow] Please install Homebrew: https://brew.sh/"
            )
            success = False
        elif dep == "gh":
            if check_command_exists("brew"):
                console.print("[cyan]>[/cyan] Installing gh via Homebrew...")
                if not dry_run:
                    try:
                        subprocess.run(
                            ["brew", "install", "gh"], check=True, timeout=300
                        )
                        console.print("[green]>[/green] gh installed successfully")
                    except subprocess.CalledProcessError:
                        console.print("[red]![/red] Failed to install gh")
                        success = False
            else:
                console.print(
                    "[yellow]![/yellow] Please install GitHub CLI: https://cli.github.com/"
                )
                success = False
        elif dep == "uv":
            console.print("[cyan]>[/cyan] Installing uv...")
            if not dry_run:
                try:
                    subprocess.run(
                        [
                            "curl",
                            "-LsSf",
                            "https://astral.sh/uv/install.sh",
                            "-o",
                            "/tmp/uv-install.sh",
                        ],
                        check=True,
                        timeout=30,
                    )
                    subprocess.run(["sh", "/tmp/uv-install.sh"], check=True, timeout=60)
                    console.print("[green]>[/green] uv installed successfully")
                except subprocess.CalledProcessError:
                    console.print("[red]![/red] Failed to install uv")
                    success = False

    return success


def update_config_with_publishers(
    config_path: Path,
    discovery: ProjectDiscovery,
    dry_run: bool = False,
) -> bool:
    """Update configuration file with newly detected publishers.

    Args:
        config_path: Path to config file
        discovery: Discovery results
        dry_run: Whether to just show what would be done

    Returns:
        True if config was updated successfully
    """
    if not discovery.new_publishers:
        return True

    import yaml

    try:
        with open(config_path) as f:
            config_data = yaml.safe_load(f) or {}
    except FileNotFoundError:
        config_data = {}

    # Ensure publishers section exists
    if "publishers" not in config_data:
        config_data["publishers"] = []

    # Add new publishers
    current_publishers = set(config_data.get("publishers", []))
    for pub in discovery.new_publishers:
        if pub.name not in current_publishers:
            if dry_run:
                console.print(
                    f"[cyan]>[/cyan] Would add [cyan]{pub.display_name}[/cyan] "
                    f"to config... [dim](dry-run)[/dim]"
                )
            else:
                config_data["publishers"].append(pub.name)
                console.print(
                    f"[green]>[/green] Added [cyan]{pub.display_name}[/cyan] "
                    f"to release config"
                )

    if not dry_run and discovery.new_publishers:
        # Write updated config
        with open(config_path, "w") as f:
            yaml.safe_dump(config_data, f, default_flow_style=False, sort_keys=False)

    return True


def run_discovery(
    project_root: Path,
    config_path: Path | None = None,
    auto_update: bool = True,
    install_deps: bool = False,
    dry_run: bool = False,
    verbose: bool = False,
) -> ProjectDiscovery:
    """Run full discovery and optionally update config.

    This is the main entry point for discovery, typically called
    at the start of a release command.

    Args:
        project_root: Path to project root
        config_path: Path to config file
        auto_update: Whether to automatically update config with new publishers
        install_deps: Whether to attempt installing missing dependencies
        dry_run: Whether to just show what would be done
        verbose: Whether to show detailed output

    Returns:
        ProjectDiscovery results
    """
    # Load existing config if available
    config: ReleaseConfig | None = None
    if config_path and config_path.exists():
        try:
            config = load_config(config_path, project_root)
        except ConfigurationError:
            pass

    # Run discovery
    discovery = discover_project(project_root, config, verbose)

    # Show status
    show_discovery_status(discovery, show_all=verbose)

    # Install missing dependencies if requested
    if install_deps and discovery.new_publishers:
        install_missing_dependencies(discovery, dry_run)

    # Update config if requested
    if auto_update and config_path and discovery.new_publishers:
        update_config_with_publishers(config_path, discovery, dry_run)

    return discovery
