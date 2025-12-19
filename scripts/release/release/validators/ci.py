"""CI workflow validators for release checks.

Validates GitHub Actions workflow configuration for releases:
- Workflow file existence
- Workflow configuration correctness
- npm trusted publishing setup for Node.js projects
"""

import re
from pathlib import Path
from typing import Any, ClassVar, cast

import yaml

from release.validators.base import (
    ReleaseContext,
    ValidationResult,
    Validator,
    ValidatorRegistry,
)


def find_workflow_files(workflows_dir: Path) -> list[Path]:
    """Find all workflow files in .github/workflows directory.

    Args:
        workflows_dir: Path to .github/workflows directory

    Returns:
        List of workflow file paths (*.yml, *.yaml)
    """
    if not workflows_dir.exists() or not workflows_dir.is_dir():
        return []

    workflow_files: list[Path] = []
    for pattern in ("*.yml", "*.yaml"):
        workflow_files.extend(workflows_dir.glob(pattern))

    return sorted(workflow_files)


def parse_workflow_file(workflow_path: Path) -> dict[str, Any] | None:
    """Parse a GitHub Actions workflow YAML file.

    Args:
        workflow_path: Path to workflow file

    Returns:
        Parsed workflow data as dict, or None if parsing fails
    """
    try:
        with open(workflow_path, encoding="utf-8") as f:
            data = yaml.safe_load(f)
            # yaml.safe_load can return Any type, ensure it's a dict or None
            if isinstance(data, dict):
                return data
            return None
    except (yaml.YAMLError, OSError):
        return None


def get_node_version_from_workflow(workflow_data: dict[str, Any]) -> int | None:
    """Extract Node.js version from workflow configuration.

    Args:
        workflow_data: Parsed workflow YAML data

    Returns:
        Node.js major version number, or None if not found
    """
    jobs = workflow_data.get("jobs", {})
    for job_data in jobs.values():
        if not isinstance(job_data, dict):
            continue

        steps = job_data.get("steps", [])
        for step in steps:
            if not isinstance(step, dict):
                continue

            # Look for setup-node action
            uses = step.get("uses", "")
            if "actions/setup-node" not in uses:
                continue

            # Extract Node.js version from 'with.node-version'
            with_config = step.get("with", {})
            node_version = with_config.get("node-version")

            if node_version:
                # Handle various formats: 24, "24", "24.x", etc.
                version_str = str(node_version).strip("'\"")
                match = re.match(r"^(\d+)", version_str)
                if match:
                    return int(match.group(1))

    return None


def has_id_token_permission(workflow_data: dict[str, Any]) -> bool:
    """Check if workflow has id-token: write permission.

    Args:
        workflow_data: Parsed workflow YAML data

    Returns:
        True if id-token: write permission is present
    """
    # Check job-level permissions (most specific)
    jobs = workflow_data.get("jobs", {})
    for job_data in jobs.values():
        if not isinstance(job_data, dict):
            continue

        permissions = job_data.get("permissions", {})
        if isinstance(permissions, dict):
            id_token_perm = permissions.get("id-token")
            if id_token_perm == "write":
                return True

    # Check workflow-level permissions
    permissions = workflow_data.get("permissions", {})
    if isinstance(permissions, dict):
        id_token_perm = permissions.get("id-token")
        if id_token_perm == "write":
            return True

    return False


def triggers_on_tags(workflow_data: dict[str, Any]) -> bool:
    """Check if workflow triggers on tag pushes.

    Args:
        workflow_data: Parsed workflow YAML data

    Returns:
        True if workflow triggers on tag pushes (e.g., v*)
    """
    # YAML parses 'on' as boolean True, so check both "on" and True as keys
    on_config = workflow_data.get("on")
    if on_config is None:
        # Cast to access with boolean key - YAML parses "on:" as True
        raw_data = cast("dict[object, Any]", workflow_data)
        on_config = raw_data.get(True, {})

    # Handle 'on: push' with tags filter
    if isinstance(on_config, dict):
        push_config = on_config.get("push", {})
        if isinstance(push_config, dict):
            tags = push_config.get("tags", [])
            if isinstance(tags, list) and tags:
                # Check for patterns like 'v*', 'v[0-9]*', etc.
                return any("v" in str(tag) for tag in tags)

    return False


def runs_npm_publish(workflow_data: dict[str, Any]) -> bool:
    """Check if workflow runs npm publish command.

    Args:
        workflow_data: Parsed workflow YAML data

    Returns:
        True if workflow contains npm publish step
    """
    jobs = workflow_data.get("jobs", {})
    for job_data in jobs.values():
        if not isinstance(job_data, dict):
            continue

        steps = job_data.get("steps", [])
        for step in steps:
            if not isinstance(step, dict):
                continue

            # Check 'run' commands
            run_command = step.get("run", "")
            if "npm publish" in run_command:
                return True

    return False


@ValidatorRegistry.register
class WorkflowExistsValidator(Validator):
    """Validates that required CI workflows exist.

    Checks for common workflow files (ci.yml, test.yml, lint.yml, publish.yml)
    and ensures at least some CI automation is configured.
    """

    name: ClassVar[str] = "workflow_exists"
    description: ClassVar[str] = "Check that required CI workflows exist"
    category: ClassVar[str] = "ci"

    def validate(self, context: ReleaseContext) -> ValidationResult:
        """Validate that workflow files exist.

        Args:
            context: Release context with project root

        Returns:
            ValidationResult indicating if workflows are configured
        """
        workflows_dir = context.project_root / ".github" / "workflows"

        if not workflows_dir.exists():
            return ValidationResult.error(
                message="No .github/workflows directory found",
                details="GitHub Actions workflows are not configured. "
                "CI automation is recommended for releases.",
                fix_command="mkdir -p .github/workflows",
            )

        workflow_files = find_workflow_files(workflows_dir)

        if not workflow_files:
            return ValidationResult.error(
                message="No workflow files found in .github/workflows",
                details="No *.yml or *.yaml workflow files exist. "
                "CI automation is recommended for releases.",
            )

        # Check for publish workflow
        publish_workflows = [
            f
            for f in workflow_files
            if "publish" in f.stem.lower() or "release" in f.stem.lower()
        ]

        if not publish_workflows:
            return ValidationResult.warning(
                message="No publish workflow found",
                details=f"Found {len(workflow_files)} workflow(s) but none appear to be for publishing/releasing.\n"
                "Common names: publish.yml, release.yml, npm-publish.yml",
            )

        workflow_names = ", ".join(f.name for f in workflow_files)
        return ValidationResult.success(
            f"Found {len(workflow_files)} workflow file(s): {workflow_names}"
        )


@ValidatorRegistry.register
class WorkflowConfigValidator(Validator):
    """Validates workflow configuration for common best practices.

    Checks workflow files for:
    - Tag-based triggers (for publish workflows)
    - Appropriate Node.js version (for npm projects)
    - OIDC permissions (for trusted publishing)
    """

    name: ClassVar[str] = "workflow_config"
    description: ClassVar[str] = "Validate CI workflow configuration"
    category: ClassVar[str] = "ci"

    def validate(self, context: ReleaseContext) -> ValidationResult:
        """Validate workflow configuration.

        Args:
            context: Release context with project root

        Returns:
            ValidationResult indicating if workflow config is valid
        """
        workflows_dir = context.project_root / ".github" / "workflows"

        if not workflows_dir.exists():
            # No workflows directory - skip this validator
            return ValidationResult.success("No workflows configured (skipping check)")

        workflow_files = find_workflow_files(workflows_dir)

        if not workflow_files:
            # No workflow files - skip this validator
            return ValidationResult.success("No workflow files (skipping check)")

        issues = []
        warnings = []

        for workflow_file in workflow_files:
            workflow_data = parse_workflow_file(workflow_file)
            if workflow_data is None:
                warnings.append(
                    f"{workflow_file.name}: Failed to parse YAML (syntax error?)"
                )
                continue

            # Check for tag triggers
            if triggers_on_tags(workflow_data):
                # This is likely a publish workflow - check Node.js version
                node_version = get_node_version_from_workflow(workflow_data)

                if node_version is not None and node_version < 24:
                    issues.append(
                        f"{workflow_file.name}: Node.js version {node_version} < 24 "
                        "(npm 11.5.1+ required for OIDC trusted publishing)"
                    )

                # Check for id-token permission
                if runs_npm_publish(workflow_data) and not has_id_token_permission(
                    workflow_data
                ):
                    warnings.append(
                        f"{workflow_file.name}: Missing 'permissions.id-token: write' "
                        "(required for npm trusted publishing with OIDC)"
                    )

        if issues:
            return ValidationResult.error(
                message="Workflow configuration issues detected",
                details="The following issues were found:\n"
                + "\n".join(f"  - {issue}" for issue in issues),
            )

        if warnings:
            return ValidationResult.warning(
                message="Workflow configuration warnings",
                details="The following recommendations apply:\n"
                + "\n".join(f"  - {warning}" for warning in warnings),
            )

        return ValidationResult.success("Workflow configuration looks good")


@ValidatorRegistry.register
class PublishWorkflowValidator(Validator):
    """Validates npm publish workflow for trusted publishing.

    Ensures the publish workflow is correctly configured for
    npm trusted publishing with OIDC authentication:
    - Triggers on version tags (v*)
    - Uses Node.js 24+ (for npm 11.5.1+ OIDC support)
    - Has id-token: write permission
    - Runs npm publish command
    """

    name: ClassVar[str] = "publish_workflow"
    description: ClassVar[str] = "Validate npm publish workflow for trusted publishing"
    category: ClassVar[str] = "ci"

    def validate(self, context: ReleaseContext) -> ValidationResult:
        """Validate npm publish workflow configuration.

        Args:
            context: Release context with project root

        Returns:
            ValidationResult indicating if publish workflow is configured correctly
        """
        # Only run for Node.js projects
        package_json = context.project_root / "package.json"
        if not package_json.exists():
            return ValidationResult.success(
                "Not a Node.js project (skipping npm publish check)"
            )

        workflows_dir = context.project_root / ".github" / "workflows"

        if not workflows_dir.exists():
            return ValidationResult.warning(
                message="No publish workflow configured",
                details="Node.js project detected but no .github/workflows directory found.\n"
                "Automated npm publishing via GitHub Actions is recommended.",
            )

        workflow_files = find_workflow_files(workflows_dir)

        if not workflow_files:
            return ValidationResult.warning(
                message="No publish workflow configured",
                details="Node.js project detected but no workflow files found.\n"
                "Automated npm publishing via GitHub Actions is recommended.",
            )

        # Find publish workflows
        publish_workflows = [
            f
            for f in workflow_files
            if "publish" in f.stem.lower() or "release" in f.stem.lower()
        ]

        if not publish_workflows:
            return ValidationResult.warning(
                message="No publish workflow found",
                details=f"Found {len(workflow_files)} workflow(s) but none appear to be for publishing.\n"
                "Create a publish.yml workflow for automated npm releases.",
            )

        # Validate each publish workflow
        issues = []
        for workflow_file in publish_workflows:
            workflow_data = parse_workflow_file(workflow_file)
            if workflow_data is None:
                issues.append(f"{workflow_file.name}: Failed to parse YAML")
                continue

            workflow_issues = []

            # Check for tag trigger
            if not triggers_on_tags(workflow_data):
                workflow_issues.append(
                    "Missing trigger on tags (e.g., 'on.push.tags: v*')"
                )

            # Check for id-token permission
            if not has_id_token_permission(workflow_data):
                workflow_issues.append(
                    "Missing 'permissions.id-token: write' (required for OIDC)"
                )

            # Check Node.js version
            node_version = get_node_version_from_workflow(workflow_data)
            if node_version is None:
                workflow_issues.append("Node.js version not found in workflow")
            elif node_version < 24:
                workflow_issues.append(
                    f"Node.js version {node_version} < 24 (npm 11.5.1+ required for OIDC)"
                )

            # Check for npm publish command
            if not runs_npm_publish(workflow_data):
                workflow_issues.append("No 'npm publish' command found")

            if workflow_issues:
                issues.append(
                    f"{workflow_file.name}:\n"
                    + "\n".join(f"  - {issue}" for issue in workflow_issues)
                )

        if issues:
            return ValidationResult.warning(
                message="Publish workflow needs configuration updates",
                details="The following publish workflows have issues:\n\n"
                + "\n\n".join(issues)
                + "\n\nFor npm trusted publishing with OIDC, ensure:\n"
                "  1. Workflow triggers on tags: v*\n"
                "  2. Uses Node.js 24 (for npm 11.5.1+ OIDC support)\n"
                "  3. Has permissions.id-token: write\n"
                "  4. Runs npm publish --access public",
            )

        return ValidationResult.success(
            f"Publish workflow configured correctly: {', '.join(f.name for f in publish_workflows)}"
        )
