"""Command-line interface for the release tool.

Provides commands for:
- release: Create a new release
- validate: Check release prerequisites
- check: Run specific quality checks
- init-config: Generate configuration
- rollback: Undo a failed release
"""

from pathlib import Path

import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from release import __version__
from release.config.defaults import write_default_config
from release.config.loader import load_config
from release.exceptions import ReleaseError

# Create Typer app
app = typer.Typer(
    name="release",
    help="Multi-ecosystem release automation tool",
    add_completion=False,
    no_args_is_help=True,
)

# Rich console for formatted output
console = Console()


def version_callback(value: bool) -> None:
    """Show version and exit."""
    if value:
        console.print(f"release-tool version {__version__}")
        raise typer.Exit()


@app.callback()
def main(
    version: bool = typer.Option(  # noqa: B008
        False,
        "--version",
        "-V",
        callback=version_callback,
        is_eager=True,
        help="Show version and exit",
    ),
) -> None:
    """Multi-ecosystem release automation tool.

    Automates the release process for projects using npm, PyPI,
    cargo, and other package registries.
    """
    pass


@app.command()
def release(
    version: str = typer.Argument(  # noqa: B008
        ...,
        help="Version to release (semver or bump type: major, minor, patch)",
    ),
    dry_run: bool = typer.Option(  # noqa: B008
        False,
        "--dry-run",
        "-n",
        help="Show what would be done without making changes",
    ),
    skip_tests: bool = typer.Option(  # noqa: B008
        False,
        "--skip-tests",
        help="Skip running tests (not recommended)",
    ),
    skip_ci: bool = typer.Option(  # noqa: B008
        False,
        "--skip-ci",
        help="Don't wait for CI workflows",
    ),
    config: Path = typer.Option(  # noqa: B008
        Path("config/release_conf.yml"),
        "--config",
        "-c",
        help="Path to configuration file",
    ),
    yes: bool = typer.Option(  # noqa: B008
        False,
        "--yes",
        "-y",
        help="Skip confirmation prompts",
    ),
) -> None:
    """Create a new release with version bump, changelog, and publishing.

    VERSION can be:
    - A bump type: major, minor, patch
    - An explicit version: 1.2.3

    Examples:
        release patch          # 1.0.0 -> 1.0.1
        release minor          # 1.0.0 -> 1.1.0
        release major          # 1.0.0 -> 2.0.0
        release 2.0.0          # Set specific version
        release patch --dry-run  # Preview without changes
    """
    try:
        # Load configuration (unused until workflow implemented)
        _cfg = load_config(config)

        if dry_run:
            console.print(
                Panel("[yellow]DRY RUN MODE[/yellow] - No changes will be made")
            )

        # TODO: Implement release workflow
        # 1. Validate prerequisites
        # 2. Bump version
        # 3. Generate changelog
        # 4. Commit and tag
        # 5. Push to remote
        # 6. Wait for CI
        # 7. Create GitHub release
        # 8. Verify publication

        console.print("[green]Release workflow not yet implemented[/green]")

    except ReleaseError as e:
        console.print(f"[red]Error:[/red] {e}")
        raise typer.Exit(code=e.exit_code) from None


@app.command()
def validate(
    config: Path = typer.Option(  # noqa: B008
        Path("config/release_conf.yml"),
        "--config",
        "-c",
        help="Path to configuration file",
    ),
    verbose: bool = typer.Option(  # noqa: B008
        False,
        "--verbose",
        "-v",
        help="Show detailed output",
    ),
) -> None:
    """Validate release prerequisites without making changes.

    Runs all validators:
    - Git state (clean working directory, on main branch)
    - Version format (valid semver)
    - Dependencies (no vulnerabilities)
    - Quality checks (lint, typecheck, test results)
    - CI configuration (workflows exist)
    - Security scan (no exposed secrets)
    """
    try:
        # Load configuration (unused until validation implemented)
        _cfg = load_config(config)

        # TODO: Implement validation
        # 1. Run all validators
        # 2. Display results table
        # 3. Exit with error if any failed

        console.print("[green]Validation not yet implemented[/green]")

    except ReleaseError as e:
        console.print(f"[red]Error:[/red] {e}")
        raise typer.Exit(code=e.exit_code) from None


@app.command()
def check(
    what: str = typer.Argument(  # noqa: B008
        "all",
        help="What to check: all, git, version, deps, security, ci, quality",
    ),
    config: Path = typer.Option(  # noqa: B008
        Path("config/release_conf.yml"),
        "--config",
        "-c",
        help="Path to configuration file",
    ),
) -> None:
    """Run specific quality checks.

    Available checks:
    - all: Run all checks
    - git: Git state checks
    - version: Version format checks
    - deps: Dependency checks
    - security: Secret detection
    - ci: CI configuration checks
    - quality: Lint, typecheck, test
    """
    try:
        # Load configuration (unused until checks implemented)
        _cfg = load_config(config)

        # TODO: Implement specific checks
        console.print(f"[green]Check '{what}' not yet implemented[/green]")

    except ReleaseError as e:
        console.print(f"[red]Error:[/red] {e}")
        raise typer.Exit(code=e.exit_code) from None


@app.command(name="init-config")
def init_config(
    output: Path = typer.Option(  # noqa: B008
        Path("config/release_conf.yml"),
        "--output",
        "-o",
        help="Output path for configuration file",
    ),
    ecosystem: str | None = typer.Option(  # noqa: B008
        None,
        "--ecosystem",
        "-e",
        help="Primary ecosystem (auto-detected if not specified)",
    ),
    force: bool = typer.Option(  # noqa: B008
        False,
        "--force",
        "-f",
        help="Overwrite existing configuration",
    ),
) -> None:
    """Generate a release configuration file.

    Auto-detects project ecosystems and generates appropriate
    default configuration.

    Examples:
        release init-config
        release init-config -o release.yml
        release init-config -e nodejs
    """
    if output.exists() and not force:
        console.print(f"[red]Configuration already exists:[/red] {output}")
        console.print("Use --force to overwrite")
        raise typer.Exit(code=1)

    try:
        write_default_config(output)
        console.print(f"[green]Configuration written to:[/green] {output}")

    except Exception as e:
        console.print(f"[red]Error:[/red] {e}")
        raise typer.Exit(code=1) from None


@app.command()
def rollback(
    version: str = typer.Argument(  # noqa: B008
        ...,
        help="Version to rollback (the failed release version)",
    ),
    force: bool = typer.Option(  # noqa: B008
        False,
        "--force",
        "-f",
        help="Force rollback without confirmation",
    ),
    config: Path = typer.Option(  # noqa: B008
        Path("config/release_conf.yml"),
        "--config",
        "-c",
        help="Path to configuration file",
    ),
) -> None:
    """Rollback a failed release.

    Removes the git tag and reverts the version bump.
    Cannot unpublish from registries (npm, PyPI, etc.).

    Examples:
        release rollback 1.2.3
        release rollback v1.2.3 --force
    """
    try:
        # Load configuration (unused until rollback implemented)
        _cfg = load_config(config)

        if not force:
            confirm = typer.confirm(f"Rollback version {version}?")
            if not confirm:
                raise typer.Exit()

        # TODO: Implement rollback
        # 1. Delete local tag
        # 2. Delete remote tag
        # 3. Revert version in config file
        # 4. Commit revert

        console.print("[green]Rollback not yet implemented[/green]")

    except ReleaseError as e:
        console.print(f"[red]Error:[/red] {e}")
        raise typer.Exit(code=e.exit_code) from None


@app.command()
def status(
    config: Path = typer.Option(  # noqa: B008
        Path("config/release_conf.yml"),
        "--config",
        "-c",
        help="Path to configuration file",
    ),
) -> None:
    """Show current release status.

    Displays:
    - Current version
    - Git status
    - Detected ecosystems
    - Last release info
    """
    try:
        cfg = load_config(config)

        # Create status table
        table = Table(title="Release Status")
        table.add_column("Property", style="cyan")
        table.add_column("Value", style="green")

        table.add_row("Project", cfg.project.name)
        table.add_row("Version Source", cfg.version.source)
        table.add_row(
            "Ecosystems", ", ".join(cfg.project.ecosystems) or "None detected"
        )
        table.add_row("Main Branch", cfg.git.main_branch)

        console.print(table)

    except ReleaseError as e:
        console.print(f"[red]Error:[/red] {e}")
        raise typer.Exit(code=e.exit_code) from None


if __name__ == "__main__":
    app()
