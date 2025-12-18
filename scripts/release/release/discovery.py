"""Auto-discovery of ecosystems and publishers.

Scans a project to detect which ecosystems and publishers are applicable,
compares with existing configuration, and offers to update the config.
"""

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from rich.console import Console

from release.config.loader import load_config
from release.config.models import ReleaseConfig
from release.exceptions import ConfigurationError

console = Console()


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


@dataclass
class ProjectDiscovery:
    """Complete discovery results for a project."""

    ecosystems: list[DiscoveryResult] = field(default_factory=list)
    publishers: list[DiscoveryResult] = field(default_factory=list)
    new_ecosystems: list[DiscoveryResult] = field(default_factory=list)
    new_publishers: list[DiscoveryResult] = field(default_factory=list)


def check_command_exists(cmd: str) -> bool:
    """Check if a command exists in PATH.

    Args:
        cmd: Command name to check

    Returns:
        True if command exists
    """
    try:
        subprocess.run(
            ["which", cmd],
            capture_output=True,
            check=True,
            timeout=5,
        )
        return True
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return False


def detect_npm_publishing(project_root: Path) -> DiscoveryResult:
    """Detect if project can publish to npm.

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
        dependencies=["npm"],
    )

    package_json = project_root / "package.json"
    if not package_json.exists():
        return result

    try:
        data = json.loads(package_json.read_text())
        # Check if it's a publishable package (has name, not private)
        if data.get("name") and not data.get("private", False):
            result.detected = True
            result.details = f"Package: {data['name']}"

            # Check for npm
            if not check_command_exists("npm"):
                result.missing_dependencies.append("npm")
    except (json.JSONDecodeError, OSError):
        pass

    return result


def detect_pypi_publishing(project_root: Path) -> DiscoveryResult:
    """Detect if project can publish to PyPI.

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
        dependencies=["uv", "twine"],
    )

    pyproject = project_root / "pyproject.toml"
    setup_py = project_root / "setup.py"

    if pyproject.exists():
        try:
            import sys
            if sys.version_info >= (3, 11):
                import tomllib
            else:
                import tomli as tomllib

            with open(pyproject, "rb") as f:
                data = tomllib.load(f)

            # Check for PEP 621 project name or Poetry name
            project_name = None
            if "project" in data and "name" in data["project"]:
                project_name = data["project"]["name"]
            elif "tool" in data and "poetry" in data["tool"]:
                project_name = data["tool"]["poetry"].get("name")

            if project_name:
                result.detected = True
                result.details = f"Package: {project_name}"
        except Exception:
            pass
    elif setup_py.exists():
        result.detected = True
        result.details = "Legacy setup.py detected"

    if result.detected:
        # Check for build tools
        if not check_command_exists("uv") and not check_command_exists("python"):
            result.missing_dependencies.append("uv or python")

    return result


def detect_crates_publishing(project_root: Path) -> DiscoveryResult:
    """Detect if project can publish to crates.io.

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

        # Check if it's a publishable crate
        if "package" in data:
            pkg = data["package"]
            # publish = false means not publishable
            if pkg.get("publish") is not False:
                result.detected = True
                result.details = f"Crate: {pkg.get('name', 'unknown')}"
    except Exception:
        pass

    if result.detected:
        if not check_command_exists("cargo"):
            result.missing_dependencies.append("cargo")

    return result


def detect_go_publishing(project_root: Path) -> DiscoveryResult:
    """Detect if project can be indexed on Go proxy.

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
        dependencies=[],  # HTTP-based, no local deps required
    )

    go_mod = project_root / "go.mod"
    if not go_mod.exists():
        return result

    try:
        content = go_mod.read_text()
        for line in content.splitlines():
            if line.strip().startswith("module "):
                module_path = line.strip()[7:].strip().strip('"')
                result.detected = True
                result.details = f"Module: {module_path}"
                break
    except OSError:
        pass

    return result


def detect_homebrew_publishing(project_root: Path) -> DiscoveryResult:
    """Detect if project can publish to Homebrew.

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

    # Check for indicators of a CLI tool that could use Homebrew:
    # 1. Existing formula template
    # 2. Binary/CLI indicators in package files
    # 3. Makefile with install target

    formula_template = project_root / "Formula" / "*.rb"
    has_formula_dir = (project_root / "Formula").is_dir()

    # Check package.json for bin field
    package_json = project_root / "package.json"
    has_bin = False
    if package_json.exists():
        try:
            data = json.loads(package_json.read_text())
            if "bin" in data:
                has_bin = True
                result.details = "CLI tool detected (package.json bin)"
        except (json.JSONDecodeError, OSError):
            pass

    # Check Cargo.toml for [[bin]] section
    cargo_toml = project_root / "Cargo.toml"
    if cargo_toml.exists():
        try:
            content = cargo_toml.read_text()
            if "[[bin]]" in content or "[package]" in content:
                # Most Rust projects with a package are CLI tools
                has_bin = True
                result.details = "CLI tool detected (Cargo.toml)"
        except OSError:
            pass

    # Check for Makefile with install target
    makefile = project_root / "Makefile"
    if makefile.exists():
        try:
            content = makefile.read_text()
            if "install:" in content:
                has_bin = True
                result.details = "CLI tool detected (Makefile install)"
        except OSError:
            pass

    # Check pyproject.toml for scripts
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

            if "project" in data and "scripts" in data["project"]:
                has_bin = True
                result.details = "CLI tool detected (pyproject.toml scripts)"
        except Exception:
            pass

    if has_formula_dir or has_bin:
        result.detected = True

    if result.detected:
        if not check_command_exists("brew"):
            result.missing_dependencies.append("brew")
        if not check_command_exists("gh"):
            result.missing_dependencies.append("gh")

    return result


def detect_docker_publishing(project_root: Path) -> DiscoveryResult:
    """Detect if project can publish Docker images.

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

    # Check for Dockerfile
    dockerfile = project_root / "Dockerfile"
    docker_compose = project_root / "docker-compose.yml"
    docker_compose_yaml = project_root / "docker-compose.yaml"
    compose_yml = project_root / "compose.yml"
    compose_yaml = project_root / "compose.yaml"

    if dockerfile.exists():
        result.detected = True
        result.details = "Dockerfile found"
    elif any(f.exists() for f in [docker_compose, docker_compose_yaml, compose_yml, compose_yaml]):
        result.detected = True
        result.details = "Docker Compose found"

    if result.detected:
        if not check_command_exists("docker"):
            result.missing_dependencies.append("docker")

    return result


def detect_github_publishing(project_root: Path) -> DiscoveryResult:
    """Detect if project uses GitHub for releases.

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

    # Check for GitHub remote
    try:
        git_config = git_dir / "config"
        if git_config.exists():
            content = git_config.read_text()
            if "github.com" in content or "github:" in content:
                result.detected = True
                # Extract repo name
                for line in content.splitlines():
                    if "github.com" in line:
                        # Parse URL to get owner/repo
                        if "github.com/" in line:
                            parts = line.split("github.com/")[-1]
                            repo = parts.split(".git")[0].strip()
                            result.details = f"Repository: {repo}"
                            break
                        elif "github.com:" in line:
                            parts = line.split("github.com:")[-1]
                            repo = parts.split(".git")[0].strip()
                            result.details = f"Repository: {repo}"
                            break
    except OSError:
        pass

    if result.detected:
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

    # Detect publishers
    publisher_detectors = [
        detect_npm_publishing,
        detect_pypi_publishing,
        detect_crates_publishing,
        detect_go_publishing,
        detect_homebrew_publishing,
        detect_docker_publishing,
        detect_github_publishing,
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
    if not discovery.new_publishers and not show_all:
        return

    console.print()

    # Show new publishers
    for pub in discovery.new_publishers:
        icon = "[green]>[/green]"
        console.print(
            f"{icon} [cyan]{pub.display_name}[/cyan] publishing detected... "
            f"[dim]({pub.details})[/dim]"
        )

        if pub.missing_dependencies:
            deps = ", ".join(pub.missing_dependencies)
            console.print(
                f"  [yellow]![/yellow] Missing dependencies: [yellow]{deps}[/yellow]"
            )

    # Show already configured if requested
    if show_all:
        configured = [p for p in discovery.publishers if p.configured]
        if configured:
            console.print()
            console.print("[dim]Already configured:[/dim]")
            for pub in configured:
                console.print(f"  [dim]- {pub.display_name}[/dim]")

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
            console.print(f"[yellow]![/yellow] Please install Node.js: https://nodejs.org/")
            success = False
        elif dep == "cargo":
            console.print(f"[yellow]![/yellow] Please install Rust: https://rustup.rs/")
            success = False
        elif dep == "go":
            console.print(f"[yellow]![/yellow] Please install Go: https://go.dev/dl/")
            success = False
        elif dep == "docker":
            console.print(f"[yellow]![/yellow] Please install Docker: https://docker.com/")
            success = False
        elif dep == "brew":
            console.print(f"[yellow]![/yellow] Please install Homebrew: https://brew.sh/")
            success = False
        elif dep == "gh":
            if check_command_exists("brew"):
                console.print(f"[cyan]>[/cyan] Installing gh via Homebrew...")
                if not dry_run:
                    try:
                        subprocess.run(["brew", "install", "gh"], check=True, timeout=300)
                        console.print(f"[green]>[/green] gh installed successfully")
                    except subprocess.CalledProcessError:
                        console.print(f"[red]![/red] Failed to install gh")
                        success = False
            else:
                console.print(f"[yellow]![/yellow] Please install GitHub CLI: https://cli.github.com/")
                success = False
        elif dep == "uv":
            console.print(f"[cyan]>[/cyan] Installing uv...")
            if not dry_run:
                try:
                    subprocess.run(
                        ["curl", "-LsSf", "https://astral.sh/uv/install.sh", "-o", "/tmp/uv-install.sh"],
                        check=True,
                        timeout=30,
                    )
                    subprocess.run(["sh", "/tmp/uv-install.sh"], check=True, timeout=60)
                    console.print(f"[green]>[/green] uv installed successfully")
                except subprocess.CalledProcessError:
                    console.print(f"[red]![/red] Failed to install uv")
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
