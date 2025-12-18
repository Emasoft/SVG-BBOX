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

    Uses shutil.which for cross-platform compatibility (works on Windows too).

    Args:
        cmd: Command name to check

    Returns:
        True if command exists
    """
    import shutil
    return shutil.which(cmd) is not None


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
                    result.details = f"Crate: {crate_name} (private registry: {publish})"
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
            v2_match = re.search(r'/v(\d+)$', module_path)
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
                cli_indicators.append(f"Python CLI: {', '.join(list(scripts.keys())[:3])}")

            # Check for Poetry scripts
            poetry_scripts = data.get("tool", {}).get("poetry", {}).get("scripts", {})
            if poetry_scripts:
                cli_indicators.append(f"Python CLI (Poetry): {', '.join(list(poetry_scripts.keys())[:3])}")

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
            r'https?://(?:www\.)?github\.com/([^/]+)/([^/\s]+?)(?:\.git)?$',
            url
        )
        if https_match:
            return f"{https_match.group(1)}/{https_match.group(2)}"

        # SSH format: git@github.com:owner/repo.git
        ssh_match = re.match(
            r'git@github\.com:([^/]+)/([^/\s]+?)(?:\.git)?$',
            url
        )
        if ssh_match:
            return f"{ssh_match.group(1)}/{ssh_match.group(2)}"

        # SSH with protocol: ssh://git@github.com/owner/repo.git
        ssh_proto_match = re.match(
            r'ssh://git@github\.com/([^/]+)/([^/\s]+?)(?:\.git)?$',
            url
        )
        if ssh_proto_match:
            return f"{ssh_proto_match.group(1)}/{ssh_proto_match.group(2)}"

        # Git shorthand: github:owner/repo
        shorthand_match = re.match(r'github:([^/]+)/([^/\s]+?)(?:\.git)?$', url)
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
                    if "release" in wf_file.name.lower() or "gh release" in content.lower():
                        release_indicators.append(wf_file.name)
                except OSError:
                    pass

            for wf_file in workflows_dir.glob("*.yaml"):
                try:
                    content = wf_file.read_text()
                    if "release" in wf_file.name.lower() or "gh release" in content.lower():
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
