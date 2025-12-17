"""Command-line interface for the release tool.

Provides commands for:
- release: Create a new release
- validate: Check release prerequisites
- check: Run specific quality checks
- init-config: Generate configuration
- rollback: Undo a failed release
"""

import json
from pathlib import Path

import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from release import __version__
from release.config.defaults import write_default_config
from release.config.loader import load_config
from release.exceptions import ReleaseError
from release.utils.shell import ShellError, run, run_silent

# Import validators to trigger registration via decorators
from release.validators import git as _git_validators  # noqa: F401
from release.validators import version as _version_validators  # noqa: F401
from release.validators.base import (
    ReleaseContext,
    ValidationResult,
    ValidationSeverity,
    ValidatorRegistry,
)

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


def get_current_version(project_root: Path) -> str | None:
    """Read current version from package.json.

    Args:
        project_root: Path to project root

    Returns:
        Current version string or None if not found
    """
    package_json = project_root / "package.json"
    if package_json.exists():
        try:
            with open(package_json) as f:
                data = json.load(f)
                version = data.get("version")
                if isinstance(version, str):
                    return version
                return None
        except (json.JSONDecodeError, OSError):
            pass
    return None


def display_validation_results(
    results: list[ValidationResult],
    title: str = "Validation Results",
) -> bool:
    """Display validation results in a formatted table.

    Args:
        results: List of validation results
        title: Table title

    Returns:
        True if all validations passed (no errors)
    """
    table = Table(title=title)
    table.add_column("Status", style="bold", width=8)
    table.add_column("Check", style="cyan")
    table.add_column("Message")

    has_errors = False

    for result in results:
        if result.severity == ValidationSeverity.ERROR:
            status = "[red]FAIL[/red]"
            if not result.passed:
                has_errors = True
        elif result.severity == ValidationSeverity.WARNING:
            status = "[yellow]WARN[/yellow]"
        else:
            status = "[green]PASS[/green]"

        table.add_row(status, result.message.split(":")[0], result.message)

    console.print(table)

    # Show details for failures
    for result in results:
        if not result.passed and result.details:
            console.print(f"\n[red]Details:[/red] {result.details}")
            if result.fix_command:
                console.print(f"[yellow]Fix:[/yellow] {result.fix_command}")

    return not has_errors


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
        # Load configuration
        cfg = load_config(config)
        project_root = Path.cwd()

        if dry_run:
            console.print(
                Panel("[yellow]DRY RUN MODE[/yellow] - No changes will be made")
            )

        # Determine new version
        from release.utils.version import bump_version, is_valid_version

        current_version = get_current_version(project_root)
        if current_version is None:
            console.print("[red]Error:[/red] Could not read current version")
            raise typer.Exit(code=1)

        if version in ("major", "minor", "patch"):
            new_version = bump_version(current_version, version)
        elif is_valid_version(version):
            new_version = version
        else:
            console.print(f"[red]Error:[/red] Invalid version: {version}")
            raise typer.Exit(code=1)

        console.print(f"Version: {current_version} -> {new_version}")

        # Create release context
        context = ReleaseContext(
            project_root=project_root,
            config=cfg,
            version=new_version,
            previous_version=current_version,
            dry_run=dry_run,
            verbose=True,
        )

        # Run validation
        console.print("\n[bold]Running pre-release validation...[/bold]")
        results = ValidatorRegistry.run_all(context)

        if not display_validation_results(results, "Pre-release Validation"):
            console.print(
                "\n[red]Validation failed. Fix issues before releasing.[/red]"
            )
            raise typer.Exit(code=1)

        # TODO: Implement release workflow
        # 1. Bump version in files
        # 2. Generate changelog
        # 3. Commit and tag
        # 4. Push to remote
        # 5. Wait for CI
        # 6. Create GitHub release
        # 7. Verify publication

        console.print("\n[yellow]Release workflow implementation pending[/yellow]")

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
        cfg = load_config(config)
        project_root = Path.cwd()
        current_version = get_current_version(project_root)

        # Create release context
        context = ReleaseContext(
            project_root=project_root,
            config=cfg,
            version=current_version,
            previous_version=None,
            dry_run=True,
            verbose=verbose,
        )

        # Show registered validators
        if verbose:
            registered = ValidatorRegistry.list_registered()
            categories = ValidatorRegistry.list_categories()
            console.print(f"[dim]Registered validators: {', '.join(registered)}[/dim]")
            console.print(f"[dim]Categories: {', '.join(categories)}[/dim]\n")

        # Run all validators
        results = ValidatorRegistry.run_all(context)

        if not results:
            console.print("[yellow]No validators registered[/yellow]")
            return

        all_passed = display_validation_results(results)

        if all_passed:
            console.print("\n[green]All validations passed![/green]")
        else:
            console.print("\n[red]Some validations failed.[/red]")
            raise typer.Exit(code=1)

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
    verbose: bool = typer.Option(  # noqa: B008
        False,
        "--verbose",
        "-v",
        help="Show detailed output",
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
        cfg = load_config(config)
        project_root = Path.cwd()
        current_version = get_current_version(project_root)

        # Create release context
        context = ReleaseContext(
            project_root=project_root,
            config=cfg,
            version=current_version,
            previous_version=None,
            dry_run=True,
            verbose=verbose,
        )

        # Map check names to categories
        category_map = {
            "all": None,  # Run all
            "git": "git",
            "version": "version",
            "deps": "dependencies",
            "security": "security",
            "ci": "ci",
            "quality": "quality",
        }

        if what not in category_map:
            console.print(f"[red]Unknown check:[/red] {what}")
            console.print(f"Available: {', '.join(category_map.keys())}")
            raise typer.Exit(code=1)

        # Run validators
        category = category_map[what]
        if category is None:
            results = ValidatorRegistry.run_all(context)
            title = "All Checks"
        else:
            results = ValidatorRegistry.run_category(category, context)
            title = f"{what.title()} Checks"

        if not results:
            console.print(f"[yellow]No validators registered for '{what}'[/yellow]")
            return

        all_passed = display_validation_results(results, title)

        if all_passed:
            console.print(f"\n[green]{what.title()} checks passed![/green]")
        else:
            console.print(f"\n[red]Some {what} checks failed.[/red]")
            raise typer.Exit(code=1)

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
    revert_commit: bool = typer.Option(  # noqa: B008
        False,
        "--revert-commit",
        help="Also revert the version bump commit (dangerous)",
    ),
    config: Path = typer.Option(  # noqa: B008
        Path("config/release_conf.yml"),
        "--config",
        "-c",
        help="Path to configuration file",
    ),
) -> None:
    """Rollback a failed release.

    Removes the git tag (local and remote) and GitHub release.
    Optionally reverts the version bump commit.
    Cannot unpublish from registries (npm, PyPI, etc.).

    Examples:
        release rollback 1.2.3
        release rollback v1.2.3 --force
        release rollback 1.2.3 --revert-commit
    """
    try:
        # Load configuration
        cfg = load_config(config)

        # Parse version input - strip 'v' prefix if present
        clean_version = version.lstrip("v")

        # Build tag name using config prefix
        tag_name = f"{cfg.version.tag_prefix}{clean_version}"

        if not force:
            console.print("\n[yellow]This will:[/yellow]")
            console.print(f"  - Delete local tag: {tag_name}")
            console.print(f"  - Delete remote tag: {tag_name}")
            console.print(f"  - Delete GitHub release: {tag_name}")
            if revert_commit:
                console.print("  - [red]Revert version bump commit (DANGEROUS)[/red]")
            console.print()

            confirm = typer.confirm(f"Proceed with rollback of {tag_name}?")
            if not confirm:
                console.print("[yellow]Rollback cancelled[/yellow]")
                raise typer.Exit()

        project_root = Path.cwd()
        results = []
        errors = []

        # Check if tag exists locally
        tag_exists_local = run_silent(
            f"git tag -l {tag_name}",
            cwd=project_root,
        )
        if tag_exists_local:
            # Verify it actually returned the tag name
            result = run(
                f"git tag -l {tag_name}",
                cwd=project_root,
                check=False,
            )
            tag_exists_local = result.stdout.strip() == tag_name

        # Check if tag exists on remote
        tag_exists_remote = False
        try:
            result = run(
                f"git ls-remote --tags {cfg.git.remote} {tag_name}",
                cwd=project_root,
                check=False,
            )
            tag_exists_remote = len(result.stdout.strip()) > 0
        except ShellError:
            pass

        console.print("\n[bold]Rollback status:[/bold]\n")

        # Step 1: Delete remote tag if exists
        if tag_exists_remote:
            try:
                run(
                    f"git push {cfg.git.remote} :refs/tags/{tag_name}",
                    cwd=project_root,
                )
                results.append(f"[green]✓[/green] Deleted remote tag: {tag_name}")
            except ShellError as e:
                errors.append(f"[red]✗[/red] Failed to delete remote tag: {e}")
        else:
            results.append(f"[yellow]⊘[/yellow] Remote tag does not exist: {tag_name}")

        # Step 2: Delete local tag
        if tag_exists_local:
            try:
                run(
                    f"git tag -d {tag_name}",
                    cwd=project_root,
                )
                results.append(f"[green]✓[/green] Deleted local tag: {tag_name}")
            except ShellError as e:
                errors.append(f"[red]✗[/red] Failed to delete local tag: {e}")
        else:
            results.append(f"[yellow]⊘[/yellow] Local tag does not exist: {tag_name}")

        # Step 3: Delete GitHub release if exists
        try:
            # First check if release exists
            result = run(
                f"gh release view {tag_name}",
                cwd=project_root,
                check=False,
            )
            if result.returncode == 0:
                # Release exists, delete it
                run(
                    f"gh release delete {tag_name} -y --cleanup-tag",
                    cwd=project_root,
                    check=False,
                )
                results.append(f"[green]✓[/green] Deleted GitHub release: {tag_name}")
            else:
                results.append(
                    f"[yellow]⊘[/yellow] GitHub release does not exist: {tag_name}"
                )
        except ShellError as e:
            # Suppress error if release doesn't exist
            if "release not found" in str(e).lower() or "not found" in str(e).lower():
                results.append(
                    f"[yellow]⊘[/yellow] GitHub release does not exist: {tag_name}"
                )
            else:
                errors.append(f"[red]✗[/red] Failed to delete GitHub release: {e}")

        # Step 4: Optionally revert version bump commit
        if revert_commit:
            try:
                # Find commit with version bump
                result = run(
                    f'git log -1 --grep="chore(release): Bump version to {clean_version}" --format=%H',
                    cwd=project_root,
                    check=False,
                )
                commit_hash = result.stdout.strip()

                if commit_hash:
                    # Revert the commit
                    run(
                        f"git revert {commit_hash} --no-edit",
                        cwd=project_root,
                    )
                    results.append(
                        f"[green]✓[/green] Reverted version bump commit: {commit_hash[:7]}"
                    )
                else:
                    results.append("[yellow]⊘[/yellow] Version bump commit not found")
            except ShellError as e:
                errors.append(f"[red]✗[/red] Failed to revert commit: {e}")

        # Display results
        for msg in results:
            console.print(msg)

        if errors:
            console.print(f"\n[red]Encountered {len(errors)} error(s):[/red]")
            for error in errors:
                console.print(error)
            raise typer.Exit(code=1)
        else:
            console.print(
                f"\n[green]Rollback of {tag_name} completed successfully[/green]"
            )

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
        project_root = Path.cwd()
        current_version = get_current_version(project_root)

        # Create status table
        table = Table(title="Release Status")
        table.add_column("Property", style="cyan")
        table.add_column("Value", style="green")

        table.add_row("Project", cfg.project.name)
        table.add_row("Current Version", current_version or "Unknown")
        table.add_row("Version File", cfg.version.file)
        table.add_row("Ecosystem", cfg.project.ecosystem)
        table.add_row("Main Branch", cfg.git.main_branch)
        table.add_row("Tag Prefix", cfg.version.tag_prefix)

        console.print(table)

    except ReleaseError as e:
        console.print(f"[red]Error:[/red] {e}")
        raise typer.Exit(code=e.exit_code) from None


if __name__ == "__main__":
    app()
