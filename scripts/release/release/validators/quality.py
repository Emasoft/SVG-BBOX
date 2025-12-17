"""Quality check validators for release checks.

Validates code quality before release:
- Linting
- Type checking
- Test execution
"""

from pathlib import Path
from typing import ClassVar

from release.utils.shell import ShellError, is_command_available, run
from release.validators.base import (
    ReleaseContext,
    ValidationResult,
    Validator,
    ValidatorRegistry,
)


def detect_linter(project_root: Path) -> str | None:
    """Detect linter based on project files.

    Args:
        project_root: Project root directory

    Returns:
        Linter command or None if not detected
    """
    # Check for Node.js linters
    if (project_root / "package.json").exists():
        if is_command_available("eslint"):
            return "eslint ."
        # Check if project uses eslint in package.json
        import json

        try:
            with open(project_root / "package.json") as f:
                pkg = json.load(f)
                scripts = pkg.get("scripts", {})
                if "lint" in scripts:
                    return "pnpm run lint"
        except (json.JSONDecodeError, OSError):
            pass

    # Check for Python linters
    if (project_root / "pyproject.toml").exists() or (
        project_root / "setup.py"
    ).exists():
        if is_command_available("ruff"):
            return "ruff check ."
        if is_command_available("pylint"):
            return "pylint src/"
        if is_command_available("flake8"):
            return "flake8 src/"

    return None


def detect_typechecker(project_root: Path) -> str | None:
    """Detect type checker based on project files.

    Args:
        project_root: Project root directory

    Returns:
        Type checker command or None if not detected
    """
    # Check for TypeScript
    if (project_root / "tsconfig.json").exists():
        if is_command_available("tsc"):
            return "tsc --noEmit"
        # Check if project uses typecheck in package.json
        if (project_root / "package.json").exists():
            import json

            try:
                with open(project_root / "package.json") as f:
                    pkg = json.load(f)
                    scripts = pkg.get("scripts", {})
                    if "typecheck" in scripts:
                        return "pnpm run typecheck"
            except (json.JSONDecodeError, OSError):
                pass

    # Check for Python type checkers
    if (project_root / "pyproject.toml").exists() or (
        project_root / "setup.py"
    ).exists():
        if is_command_available("mypy"):
            return "mypy src/"
        if is_command_available("pyright"):
            return "pyright"

    return None


def detect_test_runner(project_root: Path) -> str | None:
    """Detect test runner based on project files.

    Args:
        project_root: Project root directory

    Returns:
        Test runner command or None if not detected
    """
    # Check for Node.js test runners
    if (project_root / "package.json").exists():
        import json

        try:
            with open(project_root / "package.json") as f:
                pkg = json.load(f)
                scripts = pkg.get("scripts", {})
                if "test" in scripts:
                    return "pnpm test"
        except (json.JSONDecodeError, OSError):
            pass

        # Check for specific test frameworks
        if (project_root / "vitest.config.ts").exists() or (
            project_root / "vitest.config.js"
        ).exists():
            return "vitest run"
        if (project_root / "jest.config.js").exists() or (
            project_root / "jest.config.ts"
        ).exists():
            return "jest"

    # Check for Python test frameworks
    if (project_root / "pyproject.toml").exists() or (
        project_root / "setup.py"
    ).exists():
        if is_command_available("pytest"):
            return "pytest"
        if is_command_available("python"):
            return "python -m unittest discover"

    return None


@ValidatorRegistry.register
class LintValidator(Validator):
    """Validates that project linting passes.

    Runs the configured linter command or attempts to detect the
    appropriate linter for the project ecosystem.
    """

    name: ClassVar[str] = "lint"
    description: ClassVar[str] = "Check if linting passes"
    category: ClassVar[str] = "quality"

    def should_run(self, context: ReleaseContext) -> bool:
        """Check if this validator should run.

        Args:
            context: Release context

        Returns:
            True if lint check is enabled in config
        """
        return context.config.quality_checks.lint.enabled

    def validate(self, context: ReleaseContext) -> ValidationResult:
        """Validate that linting passes.

        Args:
            context: Release context with project root and config

        Returns:
            ValidationResult indicating if linting passed
        """
        # Get lint command from config or detect
        lint_config = context.config.quality_checks.lint
        command = lint_config.command

        # If no command configured, try to detect
        if not command or command == "pnpm run lint":
            detected = detect_linter(context.project_root)
            if detected:
                command = detected

        if not command:
            return ValidationResult.warning(
                message="Lint check skipped: no linter detected",
                details="Could not detect a linter for this project. "
                "Configure quality_checks.lint.command in release_conf.yml",
            )

        # Run linter
        try:
            run(
                command,
                cwd=context.project_root,
                capture=True,
                check=True,
                timeout=context.config.timeouts.test_execution,
            )

            return ValidationResult.success(f"Linting passed: {command}")

        except ShellError as e:
            # Check if auto-fix command is available
            fix_cmd = lint_config.auto_fix_command
            if not fix_cmd and "eslint" in command:
                fix_cmd = command + " --fix"
            elif not fix_cmd and "ruff" in command:
                fix_cmd = command.replace("check", "check --fix")

            details = "Linting failed. Output:\n" + (e.stderr or e.stdout or "")

            return ValidationResult.error(
                message=f"Linting failed: {command}",
                details=details,
                fix_command=fix_cmd,
            )


@ValidatorRegistry.register
class TypecheckValidator(Validator):
    """Validates that type checking passes.

    Runs the configured type checker or attempts to detect the
    appropriate type checker for the project ecosystem.
    """

    name: ClassVar[str] = "typecheck"
    description: ClassVar[str] = "Check if type checking passes"
    category: ClassVar[str] = "quality"

    def should_run(self, context: ReleaseContext) -> bool:
        """Check if this validator should run.

        Args:
            context: Release context

        Returns:
            True if typecheck is enabled in config
        """
        return context.config.quality_checks.typecheck.enabled

    def validate(self, context: ReleaseContext) -> ValidationResult:
        """Validate that type checking passes.

        Args:
            context: Release context with project root and config

        Returns:
            ValidationResult indicating if type checking passed
        """
        # Get typecheck command from config or detect
        typecheck_config = context.config.quality_checks.typecheck
        command = typecheck_config.command

        # If no command configured, try to detect
        if not command or command == "pnpm run typecheck":
            detected = detect_typechecker(context.project_root)
            if detected:
                command = detected

        if not command:
            return ValidationResult.warning(
                message="Type check skipped: no type checker detected",
                details="Could not detect a type checker for this project. "
                "Configure quality_checks.typecheck.command in release_conf.yml",
            )

        # Run type checker
        try:
            run(
                command,
                cwd=context.project_root,
                capture=True,
                check=True,
                timeout=context.config.timeouts.test_execution,
            )

            return ValidationResult.success(f"Type checking passed: {command}")

        except ShellError as e:
            details = "Type checking failed. Output:\n" + (e.stderr or e.stdout or "")

            return ValidationResult.error(
                message=f"Type checking failed: {command}",
                details=details,
                fix_command="Review and fix type errors in the code",
            )


@ValidatorRegistry.register
class TestValidator(Validator):
    """Validates that tests pass.

    Runs the configured test command or attempts to detect the
    appropriate test runner for the project ecosystem.
    """

    name: ClassVar[str] = "test"
    description: ClassVar[str] = "Check if tests pass"
    category: ClassVar[str] = "quality"

    def should_run(self, context: ReleaseContext) -> bool:
        """Check if this validator should run.

        Args:
            context: Release context

        Returns:
            True if tests are enabled in config
        """
        return context.config.quality_checks.tests.enabled

    def validate(self, context: ReleaseContext) -> ValidationResult:
        """Validate that tests pass.

        Args:
            context: Release context with project root and config

        Returns:
            ValidationResult indicating if tests passed
        """
        # Get test command from config or detect
        tests_config = context.config.quality_checks.tests
        mode = tests_config.mode

        # Determine which command to use based on mode
        if mode == "selective" and tests_config.selective_command:
            command = tests_config.selective_command
        else:
            command = tests_config.full_command

        # If no command configured, try to detect
        if not command or command == "pnpm test":
            detected = detect_test_runner(context.project_root)
            if detected:
                command = detected

        if not command:
            return ValidationResult.warning(
                message="Tests skipped: no test runner detected",
                details="Could not detect a test runner for this project. "
                "Configure quality_checks.tests.full_command in release_conf.yml",
            )

        # Run tests
        try:
            run(
                command,
                cwd=context.project_root,
                capture=True,
                check=True,
                timeout=context.config.timeouts.test_execution,
            )

            return ValidationResult.success(f"Tests passed ({mode} mode): {command}")

        except ShellError as e:
            details = "Tests failed. Output:\n" + (e.stderr or e.stdout or "")

            return ValidationResult.error(
                message=f"Tests failed ({mode} mode): {command}",
                details=details,
                fix_command="Review and fix failing tests",
            )
