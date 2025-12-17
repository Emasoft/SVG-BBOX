"""GitHub Actions workflow monitoring and waiting."""

import json
import time
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any

from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn, TimeElapsedColumn

from release.exceptions import CIError
from release.utils.shell import ShellError, run


class WorkflowStatus(Enum):
    """GitHub Actions workflow run status."""

    QUEUED = "queued"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    SKIPPED = "skipped"
    TIMED_OUT = "timed_out"


@dataclass
class WorkflowResult:
    """Result of a GitHub Actions workflow run."""

    status: WorkflowStatus
    name: str
    conclusion: str | None = None  # success, failure, cancelled, etc.
    run_id: int | None = None
    url: str | None = None
    duration_seconds: int | None = None
    details: str | None = None


def parse_workflow_run(data: dict[str, Any]) -> WorkflowResult:
    """Parse GitHub CLI JSON output into WorkflowResult.

    Args:
        data: JSON data from gh run list command

    Returns:
        WorkflowResult with parsed data
    """
    # Map gh CLI status to WorkflowStatus enum
    status_str = data.get("status", "").lower()
    status_map = {
        "queued": WorkflowStatus.QUEUED,
        "in_progress": WorkflowStatus.IN_PROGRESS,
        "completed": WorkflowStatus.COMPLETED,
    }
    status = status_map.get(status_str, WorkflowStatus.COMPLETED)

    # If completed, check conclusion for more specific status
    conclusion = data.get("conclusion", "").lower() if data.get("conclusion") else None
    if status == WorkflowStatus.COMPLETED and conclusion:
        if conclusion == "failure":
            status = WorkflowStatus.FAILED
        elif conclusion == "cancelled":
            status = WorkflowStatus.CANCELLED
        elif conclusion == "skipped":
            status = WorkflowStatus.SKIPPED
        elif conclusion == "timed_out":
            status = WorkflowStatus.TIMED_OUT

    # Calculate duration if we have timestamps
    duration_seconds = None
    if data.get("createdAt") and data.get("updatedAt"):
        # This is approximate - would need proper timestamp parsing for accuracy
        # For now, we'll leave it as None and calculate it elsewhere if needed
        pass

    # Build workflow URL
    url = None
    if data.get("databaseId"):
        # GitHub Actions URL format: https://github.com/OWNER/REPO/actions/runs/RUN_ID
        # We don't have owner/repo in the data, so we'll construct it from gh CLI context
        url = f"https://github.com/actions/runs/{data['databaseId']}"

    return WorkflowResult(
        status=status,
        name=data.get("name", ""),
        conclusion=conclusion,
        run_id=data.get("databaseId"),
        url=url,
        duration_seconds=duration_seconds,
        details=None,
    )


def format_duration(seconds: int) -> str:
    """Format duration as human-readable string.

    Args:
        seconds: Duration in seconds

    Returns:
        Formatted string like "2m 30s" or "45s"
    """
    if seconds < 60:
        return f"{seconds}s"
    minutes = seconds // 60
    remaining_seconds = seconds % 60
    if remaining_seconds == 0:
        return f"{minutes}m"
    return f"{minutes}m {remaining_seconds}s"


class WorkflowMonitor:
    """Monitor GitHub Actions workflow runs."""

    def __init__(self, project_root: Path, timeout_seconds: int = 900):
        """Initialize workflow monitor.

        Args:
            project_root: Path to the project root directory
            timeout_seconds: Default timeout for workflow waits (default: 15 minutes)
        """
        self.project_root = project_root
        self.timeout_seconds = timeout_seconds
        self.console = Console()

    def get_latest_run(
        self, workflow_name: str, branch: str = "main"
    ) -> WorkflowResult:
        """Get the latest workflow run for a workflow.

        Args:
            workflow_name: Name of the workflow (e.g., "CI", "publish.yml")
            branch: Branch to filter by (default: "main")

        Returns:
            WorkflowResult with latest run data

        Raises:
            CIError: If workflow not found or gh CLI fails
        """
        try:
            # Get latest run for this workflow
            result = run(
                [
                    "gh",
                    "run",
                    "list",
                    f"--workflow={workflow_name}",
                    f"--branch={branch}",
                    "--limit=1",
                    "--json",
                    "databaseId,status,conclusion,name,headSha,createdAt,updatedAt",
                ],
                cwd=self.project_root,
                capture=True,
                check=True,
            )

            # Parse JSON output
            runs = json.loads(result.stdout)
            if not runs:
                raise CIError(
                    f"No workflow runs found for '{workflow_name}' on branch '{branch}'"
                )

            return parse_workflow_run(runs[0])

        except ShellError as e:
            raise CIError(f"Failed to get workflow run: {e}") from e
        except json.JSONDecodeError as e:
            raise CIError(f"Failed to parse workflow run JSON: {e}") from e

    def wait_for_workflow(
        self,
        workflow_name: str,
        commit_sha: str,
        timeout_seconds: int | None = None,
        poll_interval: int = 15,
    ) -> WorkflowResult:
        """Wait for a workflow run to complete.

        Args:
            workflow_name: Name of the workflow to wait for
            commit_sha: Commit SHA that should trigger the workflow
            timeout_seconds: Timeout in seconds (default: use instance timeout)
            poll_interval: How often to poll for updates in seconds (default: 15)

        Returns:
            WorkflowResult when workflow completes

        Raises:
            CIError: If workflow fails, times out, or is cancelled
        """
        timeout = (
            timeout_seconds if timeout_seconds is not None else self.timeout_seconds
        )
        start_time = time.time()
        workflow_found = False

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            TimeElapsedColumn(),
            console=self.console,
        ) as progress:
            task = progress.add_task(
                f"Waiting for workflow '{workflow_name}'...", total=None
            )

            while True:
                # Check timeout
                elapsed = time.time() - start_time
                if elapsed > timeout:
                    raise CIError(
                        f"Timeout waiting for workflow '{workflow_name}' after {format_duration(int(elapsed))}"
                    )

                try:
                    # Get latest runs for this workflow
                    result = run(
                        [
                            "gh",
                            "run",
                            "list",
                            f"--workflow={workflow_name}",
                            "--limit=5",
                            "--json",
                            "databaseId,status,conclusion,name,headSha,createdAt,updatedAt",
                        ],
                        cwd=self.project_root,
                        capture=True,
                        check=True,
                    )

                    runs = json.loads(result.stdout)

                    # Find run matching our commit SHA
                    matching_run = None
                    for run_data in runs:
                        if run_data.get("headSha", "").startswith(commit_sha[:7]):
                            matching_run = run_data
                            workflow_found = True
                            break

                    if matching_run:
                        workflow_result = parse_workflow_run(matching_run)

                        # Update progress description with status
                        status_text = workflow_result.status.value.replace(
                            "_", " "
                        ).title()
                        progress.update(
                            task,
                            description=f"Workflow '{workflow_name}': {status_text}",
                        )

                        # Check if workflow is complete
                        if workflow_result.status in [
                            WorkflowStatus.COMPLETED,
                            WorkflowStatus.FAILED,
                            WorkflowStatus.CANCELLED,
                            WorkflowStatus.SKIPPED,
                            WorkflowStatus.TIMED_OUT,
                        ]:
                            # Calculate final duration
                            workflow_result.duration_seconds = int(elapsed)

                            # Check for failures
                            if workflow_result.status == WorkflowStatus.FAILED:
                                raise CIError(
                                    f"Workflow '{workflow_name}' failed with conclusion '{workflow_result.conclusion}'\n"
                                    f"View logs: gh run view {workflow_result.run_id} --log"
                                )
                            elif workflow_result.status == WorkflowStatus.CANCELLED:
                                raise CIError(
                                    f"Workflow '{workflow_name}' was cancelled"
                                )
                            elif workflow_result.status == WorkflowStatus.TIMED_OUT:
                                raise CIError(f"Workflow '{workflow_name}' timed out")

                            return workflow_result
                    elif not workflow_found:
                        # Workflow hasn't started yet
                        progress.update(
                            task,
                            description=f"Waiting for workflow '{workflow_name}' to start...",
                        )

                except ShellError:
                    # gh CLI error - continue polling
                    progress.update(task, description="Retrying (gh CLI error)...")
                except json.JSONDecodeError:
                    # JSON parse error - continue polling
                    progress.update(task, description="Retrying (JSON parse error)...")

                # Wait before next poll
                time.sleep(poll_interval)

    def wait_for_all_workflows(
        self,
        workflow_names: list[str],
        commit_sha: str,
    ) -> list[WorkflowResult]:
        """Wait for multiple workflows to complete.

        Note: This waits for workflows sequentially, not in parallel.
        For true parallel waiting, use asyncio or threading.

        Args:
            workflow_names: List of workflow names to wait for
            commit_sha: Commit SHA that should trigger the workflows

        Returns:
            List of WorkflowResults for all workflows

        Raises:
            CIError: If any workflow fails
        """
        results = []
        for workflow_name in workflow_names:
            result = self.wait_for_workflow(workflow_name, commit_sha)
            results.append(result)
        return results

    def get_run_logs(self, run_id: int, max_lines: int = 1000) -> str:
        """Get logs for a workflow run.

        Args:
            run_id: Workflow run ID
            max_lines: Maximum number of log lines to return (default: 1000)

        Returns:
            Log output (truncated if too long)

        Raises:
            CIError: If gh CLI fails
        """
        try:
            result = run(
                ["gh", "run", "view", str(run_id), "--log"],
                cwd=self.project_root,
                capture=True,
                check=True,
            )

            logs = result.stdout
            lines = logs.splitlines()

            # Truncate if too many lines
            if len(lines) > max_lines:
                truncated_lines = lines[:max_lines]
                truncated_lines.append(
                    f"\n... (truncated {len(lines) - max_lines} lines) ..."
                )
                return "\n".join(truncated_lines)

            return logs

        except ShellError as e:
            raise CIError(f"Failed to get workflow logs: {e}") from e
