"""Release workflow orchestration.

Coordinates the complete release process:
1. Version bump
2. Changelog generation
3. Git commit and tag
4. Push to remote
5. Wait for CI
6. Create GitHub release
7. Run publishers
8. Verify publication
"""

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from rich.console import Console
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn

from release.config.models import ReleaseConfig
from release.exceptions import GitError, PublishError, ReleaseError
from release.git import operations as git_ops
from release.git import queries as git_queries  # Used for get_latest_tag
from release.publishers.base import PublishContext, PublisherRegistry, PublishStatus
from release.utils.shell import run, ShellError

console = Console()


@dataclass
class WorkflowResult:
    """Result of a workflow step."""

    success: bool
    message: str
    details: str | None = None
    data: dict[str, Any] = field(default_factory=dict)


@dataclass
class ReleaseWorkflow:
    """Orchestrates the complete release process."""

    project_root: Path
    config: ReleaseConfig
    version: str
    previous_version: str
    dry_run: bool = False
    skip_tests: bool = False
    skip_ci: bool = False
    verbose: bool = False

    # State tracking
    tag_name: str = ""
    commit_sha: str = ""
    release_notes: str = ""

    def __post_init__(self) -> None:
        """Initialize computed fields."""
        self.tag_name = f"{self.config.version.tag_prefix}{self.version}"

    def run(self) -> bool:
        """Execute the complete release workflow.

        Returns:
            True if release completed successfully
        """
        steps = [
            ("Bumping version", self.bump_version),
            ("Generating changelog", self.generate_changelog),
            ("Committing changes", self.commit_changes),
            ("Creating tag", self.create_tag),
            ("Pushing to remote", self.push_to_remote),
        ]

        if not self.skip_ci:
            steps.append(("Waiting for CI", self.wait_for_ci))

        steps.extend([
            ("Creating GitHub release", self.create_github_release),
            ("Running publishers", self.run_publishers),
            ("Verifying publication", self.verify_publication),
        ])

        for step_name, step_func in steps:
            console.print(f"\n[bold cyan]>[/bold cyan] {step_name}...")

            try:
                result = step_func()
                if not result.success:
                    console.print(f"[red]  Failed: {result.message}[/red]")
                    if result.details:
                        console.print(f"[dim]  {result.details}[/dim]")
                    return False

                console.print(f"[green]  {result.message}[/green]")

            except ReleaseError as e:
                console.print(f"[red]  Error: {e}[/red]")
                if e.details:
                    console.print(f"[dim]  {e.details}[/dim]")
                return False

        return True

    def bump_version(self) -> WorkflowResult:
        """Bump version in project files.

        Uses ecosystem-specific version bumping.
        """
        if self.dry_run:
            return WorkflowResult(
                success=True,
                message=f"Would bump version to {self.version}",
            )

        # Detect ecosystem and bump version
        from release.ecosystems import EcosystemRegistry

        ecosystem = None
        for eco_name in EcosystemRegistry.list_registered():
            eco_class = EcosystemRegistry.get(eco_name)
            if eco_class:
                eco_instance = eco_class(self.project_root)
                if eco_instance.detect():
                    ecosystem = eco_instance
                    break

        if ecosystem is None:
            # Fallback: Try npm version command directly
            try:
                run(
                    ["npm", "version", self.version, "--no-git-tag-version"],
                    cwd=self.project_root,
                    check=True,
                )
                return WorkflowResult(
                    success=True,
                    message=f"Version bumped to {self.version}",
                )
            except ShellError as e:
                return WorkflowResult(
                    success=False,
                    message="Failed to bump version",
                    details=str(e),
                )

        try:
            ecosystem.set_version(self.version)
            return WorkflowResult(
                success=True,
                message=f"Version bumped to {self.version} ({ecosystem.name})",
            )
        except Exception as e:
            return WorkflowResult(
                success=False,
                message=f"Failed to bump version in {ecosystem.name}",
                details=str(e),
            )

    def generate_changelog(self) -> WorkflowResult:
        """Generate changelog using git-cliff or similar."""
        if self.dry_run:
            return WorkflowResult(
                success=True,
                message="Would generate changelog",
            )

        # Try git-cliff first
        try:
            result = run(
                [
                    "git-cliff",
                    "--tag", self.tag_name,
                    "--unreleased",
                    "--strip", "all",
                ],
                cwd=self.project_root,
                check=False,
            )

            if result.returncode == 0 and result.stdout.strip():
                self.release_notes = result.stdout.strip()
                return WorkflowResult(
                    success=True,
                    message="Changelog generated with git-cliff",
                    data={"notes": self.release_notes},
                )
        except (ShellError, FileNotFoundError):
            pass

        # Fallback: Generate from git log
        try:
            # Get commits since last tag
            last_tag = git_queries.get_latest_tag(self.project_root)
            range_spec = f"{last_tag}..HEAD" if last_tag else "HEAD~10..HEAD"

            result = run(
                ["git", "log", range_spec, "--pretty=format:- %s"],
                cwd=self.project_root,
                check=True,
            )

            self.release_notes = f"## Changes in {self.version}\n\n{result.stdout}"

            return WorkflowResult(
                success=True,
                message="Changelog generated from git log",
                data={"notes": self.release_notes},
            )

        except ShellError as e:
            # Use minimal changelog
            self.release_notes = f"Release {self.version}"
            return WorkflowResult(
                success=True,
                message="Using minimal changelog",
            )

    def commit_changes(self) -> WorkflowResult:
        """Commit version bump and changelog."""
        if self.dry_run:
            return WorkflowResult(
                success=True,
                message="Would commit version bump",
            )

        # Check for changes to commit
        try:
            # Use git status to check for changes
            result = run(
                ["git", "status", "--porcelain"],
                cwd=self.project_root,
                check=False,
            )
            if not result.stdout.strip():
                return WorkflowResult(
                    success=True,
                    message="No changes to commit",
                )
        except ShellError:
            pass  # Continue with commit attempt

        try:
            commit_message = f"chore(release): Bump version to {self.version}"
            self.commit_sha = git_ops.commit(
                message=commit_message,
                files=".",  # Stage all changes
                sign=self.config.git.sign_commits,
                cwd=self.project_root,
            )

            return WorkflowResult(
                success=True,
                message=f"Committed: {self.commit_sha[:7]}",
                data={"sha": self.commit_sha},
            )

        except GitError as e:
            return WorkflowResult(
                success=False,
                message="Failed to commit changes",
                details=str(e),
            )

    def create_tag(self) -> WorkflowResult:
        """Create annotated git tag."""
        if self.dry_run:
            return WorkflowResult(
                success=True,
                message=f"Would create tag {self.tag_name}",
            )

        try:
            git_ops.tag(
                name=self.tag_name,
                message=f"Release {self.version}",
                sign=self.config.git.sign_tags,
                cwd=self.project_root,
            )

            return WorkflowResult(
                success=True,
                message=f"Created tag {self.tag_name}",
            )

        except GitError as e:
            return WorkflowResult(
                success=False,
                message=f"Failed to create tag {self.tag_name}",
                details=str(e),
            )

    def push_to_remote(self) -> WorkflowResult:
        """Push commits and tag to remote."""
        if self.dry_run:
            return WorkflowResult(
                success=True,
                message=f"Would push to {self.config.git.remote}",
            )

        remote = self.config.git.remote

        try:
            # Push commits first
            git_ops.push(
                remote=remote,
                branch=self.config.git.main_branch,
                cwd=self.project_root,
            )

            # Push tag separately (to trigger CI properly)
            git_ops.push_tag(
                tag=self.tag_name,
                remote=remote,
                cwd=self.project_root,
            )

            return WorkflowResult(
                success=True,
                message=f"Pushed to {remote} with tag {self.tag_name}",
            )

        except GitError as e:
            return WorkflowResult(
                success=False,
                message="Failed to push",
                details=str(e),
            )

    def wait_for_ci(self) -> WorkflowResult:
        """Wait for CI workflows to complete."""
        if self.dry_run:
            return WorkflowResult(
                success=True,
                message="Would wait for CI",
            )

        timeout = self.config.timeouts.ci_workflow
        # Get workflow name from config (ci.workflow.name)
        workflow_name = self.config.ci.workflow.name
        required_workflows = [workflow_name] if workflow_name else []

        if not required_workflows:
            return WorkflowResult(
                success=True,
                message="No CI workflows configured",
            )

        console.print(f"[dim]  Waiting for: {', '.join(required_workflows)}[/dim]")

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            task = progress.add_task("Waiting for CI...", total=None)

            start_time = time.time()
            while time.time() - start_time < timeout:
                # Check workflow status using gh CLI
                try:
                    result = run(
                        ["gh", "run", "list", "--limit", "5", "--json", "status,conclusion,name"],
                        cwd=self.project_root,
                        check=False,
                    )

                    if result.returncode == 0:
                        import json
                        runs = json.loads(result.stdout)

                        all_passed = True
                        any_failed = False

                        for workflow_name in required_workflows:
                            matching = [r for r in runs if workflow_name.lower() in r.get("name", "").lower()]
                            if matching:
                                latest = matching[0]
                                status = latest.get("status", "")
                                conclusion = latest.get("conclusion", "")

                                if status == "completed":
                                    if conclusion != "success":
                                        any_failed = True
                                else:
                                    all_passed = False

                        if any_failed:
                            return WorkflowResult(
                                success=False,
                                message="CI workflow failed",
                                details="Check GitHub Actions for details",
                            )

                        if all_passed:
                            return WorkflowResult(
                                success=True,
                                message="All CI workflows passed",
                            )

                except (ShellError, json.JSONDecodeError):
                    pass

                progress.update(task, description=f"Waiting for CI... ({int(time.time() - start_time)}s)")
                time.sleep(10)

        return WorkflowResult(
            success=False,
            message="CI timeout",
            details=f"Timed out after {timeout}s waiting for workflows",
        )

    def create_github_release(self) -> WorkflowResult:
        """Create GitHub release with notes."""
        if self.dry_run:
            return WorkflowResult(
                success=True,
                message=f"Would create GitHub release {self.tag_name}",
            )

        # Get the commit SHA for the release target
        target_sha = self.commit_sha
        if not target_sha:
            try:
                result = run(
                    ["git", "rev-parse", "HEAD"],
                    cwd=self.project_root,
                    check=True,
                )
                target_sha = result.stdout.strip()
            except ShellError:
                target_sha = ""

        try:
            # Build gh release command
            cmd = [
                "gh", "release", "create", self.tag_name,
                "--title", self.tag_name,
            ]

            if target_sha:
                cmd.extend(["--target", target_sha])

            if self.release_notes:
                cmd.extend(["--notes", self.release_notes])
            else:
                cmd.append("--generate-notes")

            if self.config.github.draft:
                cmd.append("--draft")

            if self.config.github.prerelease:
                cmd.append("--prerelease")

            run(cmd, cwd=self.project_root, check=True)

            return WorkflowResult(
                success=True,
                message=f"Created GitHub release {self.tag_name}",
            )

        except ShellError as e:
            return WorkflowResult(
                success=False,
                message="Failed to create GitHub release",
                details=str(e),
            )

    def run_publishers(self) -> WorkflowResult:
        """Run all applicable publishers."""
        # Create publish context
        context = PublishContext(
            project_root=self.project_root,
            config=self.config,
            version=self.version,
            tag_name=self.tag_name,
            release_notes=self.release_notes,
            dry_run=self.dry_run,
            verbose=self.verbose,
        )

        # Get enabled publishers from config
        enabled_publishers = getattr(self.config, "publishers", [])
        if not enabled_publishers:
            # Auto-detect from discovery
            from release.discovery import discover_project
            discovery = discover_project(self.project_root, self.config)
            enabled_publishers = [p.name for p in discovery.publishers if p.detected]

        if not enabled_publishers:
            return WorkflowResult(
                success=True,
                message="No publishers configured",
            )

        results = PublisherRegistry.publish_all(context, enabled_publishers)

        # Check results
        failed = [r for r in results if r.status == PublishStatus.FAILED]
        succeeded = [r for r in results if r.status == PublishStatus.SUCCESS]

        if failed:
            messages = [f"{r.message}" for r in failed]
            return WorkflowResult(
                success=False,
                message=f"{len(failed)} publisher(s) failed",
                details="; ".join(messages),
            )

        return WorkflowResult(
            success=True,
            message=f"{len(succeeded)} publisher(s) completed",
        )

    def verify_publication(self) -> WorkflowResult:
        """Verify packages were published successfully."""
        if self.dry_run:
            return WorkflowResult(
                success=True,
                message="Would verify publication",
            )

        # Create publish context for verification
        context = PublishContext(
            project_root=self.project_root,
            config=self.config,
            version=self.version,
            tag_name=self.tag_name,
            release_notes=self.release_notes,
            dry_run=False,
            verbose=self.verbose,
        )

        # Get enabled publishers
        enabled_publishers = getattr(self.config, "publishers", [])

        if not enabled_publishers:
            return WorkflowResult(
                success=True,
                message="No publishers to verify",
            )

        verified = 0
        failed = 0

        for pub_name in enabled_publishers:
            pub_class = PublisherRegistry.get(pub_name)
            if pub_class:
                publisher = pub_class()
                if publisher.should_publish(context):
                    if publisher.verify(context):
                        verified += 1
                        console.print(f"[dim]  {publisher.display_name}: verified[/dim]")
                    else:
                        failed += 1
                        console.print(f"[yellow]  {publisher.display_name}: not yet visible[/yellow]")

        if failed > 0:
            return WorkflowResult(
                success=True,  # Don't fail release for verification issues
                message=f"Verified {verified}, pending {failed}",
                details="Some packages may take a few minutes to appear",
            )

        return WorkflowResult(
            success=True,
            message=f"All {verified} publisher(s) verified",
        )


def execute_release(
    project_root: Path,
    config: ReleaseConfig,
    version: str,
    previous_version: str,
    dry_run: bool = False,
    skip_tests: bool = False,
    skip_ci: bool = False,
    verbose: bool = False,
) -> bool:
    """Execute a complete release workflow.

    This is the main entry point for running a release.

    Args:
        project_root: Path to project root
        config: Release configuration
        version: New version to release
        previous_version: Current version
        dry_run: Whether to simulate without changes
        skip_tests: Whether to skip tests
        skip_ci: Whether to skip CI wait
        verbose: Whether to show detailed output

    Returns:
        True if release completed successfully
    """
    workflow = ReleaseWorkflow(
        project_root=project_root,
        config=config,
        version=version,
        previous_version=previous_version,
        dry_run=dry_run,
        skip_tests=skip_tests,
        skip_ci=skip_ci,
        verbose=verbose,
    )

    console.print(
        Panel(
            f"[bold]Release {version}[/bold]\n"
            f"Tag: {workflow.tag_name}\n"
            f"{'[yellow]DRY RUN[/yellow]' if dry_run else ''}",
            title="Starting Release",
            border_style="cyan",
        )
    )

    success = workflow.run()

    if success:
        console.print(
            Panel(
                f"[bold green]Release {version} completed successfully![/bold green]",
                border_style="green",
            )
        )
    else:
        console.print(
            Panel(
                f"[bold red]Release {version} failed[/bold red]\n"
                f"Run 'release rollback {version}' to clean up",
                border_style="red",
            )
        )

    return success
