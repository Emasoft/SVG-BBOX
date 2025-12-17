"""Security validators for release checks.

Validates security concerns before release:
- Secret detection in publishable files
- Dependency vulnerability audits
"""

import json
import re
import subprocess
from pathlib import Path
from typing import Any, ClassVar

from release.validators.base import (
    ReleaseContext,
    ValidationResult,
    Validator,
    ValidatorRegistry,
)

# Common secret patterns to detect in source files
SECRET_PATTERNS = [
    (r"(?i)api[_-]?key\s*[:=]\s*[\"']?[\w-]{20,}", "API key"),
    (r"(?i)secret[_-]?key\s*[:=]\s*[\"']?[\w-]{20,}", "Secret key"),
    (r"ghp_[a-zA-Z0-9]{36}", "GitHub personal access token"),
    (r"npm_[a-zA-Z0-9]{36}", "npm access token"),
    (r"AKIA[0-9A-Z]{16}", "AWS access key"),
    (r"-----BEGIN (RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----", "Private key"),
]

# Contexts that indicate the match is safe (example/test/placeholder code)
SAFE_CONTEXTS = [
    "example",
    "sample",
    "placeholder",
    "YOUR_",
    "XXX",
    "test",
    "demo",
    "REPLACE_ME",
    "INSERT_",
]


def is_safe_context(line: str, match: str) -> bool:
    """Check if a potential secret is in a safe context.

    Args:
        line: The line containing the match
        match: The matched secret pattern

    Returns:
        True if the match is in a safe context (example/placeholder)
    """
    line_lower = line.lower()
    match_lower = match.lower()

    return any(
        safe.lower() in line_lower or safe.lower() in match_lower
        for safe in SAFE_CONTEXTS
    )


def get_publishable_files(project_root: Path) -> list[Path]:
    """Get list of files that would be published to package registry.

    Excludes files in .gitignore, node_modules, common dev/test directories.

    Args:
        project_root: Root directory of the project

    Returns:
        List of file paths that would be published
    """
    publishable_files = []
    excluded_dirs = {
        "node_modules",
        ".git",
        "tests",
        "test",
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        "coverage",
        ".coverage",
        "dist",
        "build",
        ".venv",
        "venv",
        ".env",
        "docs",
        "examples",
    }

    # Get files tracked by git (these are publishable)
    try:
        result = subprocess.run(
            ["git", "ls-files"],
            cwd=project_root,
            capture_output=True,
            text=True,
            check=True,
        )
        tracked_files = result.stdout.strip().split("\n")

        for file_path in tracked_files:
            path = project_root / file_path
            # Skip if file doesn't exist or is in excluded directory
            if not path.exists() or not path.is_file():
                continue

            # Check if in excluded directory
            if any(excluded in path.parts for excluded in excluded_dirs):
                continue

            publishable_files.append(path)

    except subprocess.CalledProcessError:
        # If git ls-files fails, fall back to scanning directory
        # This is less accurate but better than nothing
        for path in project_root.rglob("*"):
            if not path.is_file():
                continue

            # Skip excluded directories
            if any(excluded in path.parts for excluded in excluded_dirs):
                continue

            # Skip hidden files
            if any(part.startswith(".") for part in path.parts):
                continue

            publishable_files.append(path)

    return publishable_files


@ValidatorRegistry.register
class SecretDetectionValidator(Validator):
    """Detects exposed secrets in publishable files.

    Scans files that would be published to the package registry
    for common secret patterns (API keys, tokens, private keys).
    Returns warnings (not errors) to allow manual review.
    """

    name: ClassVar[str] = "secret_detection"
    description: ClassVar[str] = "Check for exposed secrets in publishable files"
    category: ClassVar[str] = "security"

    def validate(self, context: ReleaseContext) -> ValidationResult:
        """Scan publishable files for potential secrets.

        Args:
            context: Release context with project root

        Returns:
            ValidationResult warning if potential secrets found
        """
        project_root = context.project_root
        publishable_files = get_publishable_files(project_root)

        findings: list[tuple[Path, int, str, str]] = []

        # Scan each publishable file
        for file_path in publishable_files:
            # Skip binary files and large files
            try:
                if file_path.stat().st_size > 1_000_000:  # 1MB limit
                    continue

                with open(file_path, encoding="utf-8", errors="ignore") as f:
                    lines = f.readlines()

            except (OSError, UnicodeDecodeError):
                # Skip files that can't be read as text
                continue

            # Check each line against secret patterns
            for line_num, line in enumerate(lines, start=1):
                for pattern, description in SECRET_PATTERNS:
                    for match in re.finditer(pattern, line):
                        matched_text = match.group(0)

                        # Skip if in safe context
                        if is_safe_context(line, matched_text):
                            continue

                        findings.append(
                            (
                                file_path.relative_to(project_root),
                                line_num,
                                description,
                                matched_text[:50],  # Truncate for display
                            )
                        )

        if not findings:
            return ValidationResult.success("No secrets detected in publishable files")

        # Format findings for detailed message
        details_lines = ["Potential secrets found in publishable files:\n"]
        for file_path, line_num, description, match_preview in findings[:10]:
            details_lines.append(
                f"  {file_path}:{line_num} - {description}\n"
                f"    Preview: {match_preview}..."
            )

        if len(findings) > 10:
            details_lines.append(f"\n  ... and {len(findings) - 10} more findings")

        details_lines.append(
            "\n\nThese may be false positives. Please review each finding:\n"
            "- If legitimate secrets: Remove or use environment variables\n"
            "- If test/example data: Add to .gitignore or mark as safe\n"
            "- If false positive: Ignore this warning"
        )

        return ValidationResult.warning(
            message=f"Found {len(findings)} potential secret(s) in publishable files",
            details="".join(details_lines),
            fix_command="Review findings and remove secrets or add to .gitignore",
        )


@ValidatorRegistry.register
class DependencyAuditValidator(Validator):
    """Checks for vulnerable dependencies using package manager audit.

    Runs dependency audit command (npm audit or pnpm audit) and
    checks for known security vulnerabilities. Returns warnings for
    low/moderate severity, errors for high/critical severity.
    """

    name: ClassVar[str] = "dependency_audit"
    description: ClassVar[str] = "Check for known vulnerabilities in dependencies"
    category: ClassVar[str] = "security"

    def _detect_package_manager(self, project_root: Path) -> str | None:
        """Detect which package manager is in use.

        Args:
            project_root: Project root directory

        Returns:
            "pnpm", "npm", or None if no package.json found
        """
        if not (project_root / "package.json").exists():
            return None

        # Check for pnpm-lock.yaml
        if (project_root / "pnpm-lock.yaml").exists():
            return "pnpm"

        # Default to npm
        return "npm"

    def _run_audit(
        self, package_manager: str, project_root: Path
    ) -> dict[str, list[dict[str, Any]]] | None:
        """Run package manager audit and parse results.

        Args:
            package_manager: "npm" or "pnpm"
            project_root: Project root directory

        Returns:
            Dict with vulnerability lists by severity, or None if audit fails
        """
        try:
            # Run audit command
            result = subprocess.run(
                [package_manager, "audit", "--json"],
                cwd=project_root,
                capture_output=True,
                text=True,
                timeout=30,
            )

            # npm/pnpm audit returns non-zero if vulnerabilities found
            # We still want to parse the output, so don't check=True

            # Parse JSON output
            try:
                audit_data = json.loads(result.stdout)
            except json.JSONDecodeError:
                # Try parsing line-by-line (npm audit outputs NDJSON)
                audit_data = {"vulnerabilities": {}}
                for line in result.stdout.strip().split("\n"):
                    if line:
                        try:
                            data = json.loads(line)
                            if "vulnerabilities" in data:
                                audit_data = data
                                break
                        except json.JSONDecodeError:
                            continue

            # Categorize vulnerabilities by severity
            vulnerabilities: dict[str, list[dict[str, Any]]] = {
                "critical": [],
                "high": [],
                "moderate": [],
                "low": [],
                "info": [],
            }

            # Parse npm audit format
            if "vulnerabilities" in audit_data:
                for name, vuln in audit_data["vulnerabilities"].items():
                    severity = vuln.get("severity", "unknown").lower()
                    if severity in vulnerabilities:
                        vulnerabilities[severity].append(
                            {
                                "name": name,
                                "severity": severity,
                                "title": vuln.get("via", [{}])[0].get(
                                    "title", "Unknown"
                                ),
                                "url": vuln.get("via", [{}])[0].get("url", ""),
                            }
                        )

            # Parse pnpm audit format (similar to npm)
            elif "advisories" in audit_data:
                for advisory in audit_data["advisories"].values():
                    severity = advisory.get("severity", "unknown").lower()
                    if severity in vulnerabilities:
                        vulnerabilities[severity].append(
                            {
                                "name": advisory.get("module_name", "unknown"),
                                "severity": severity,
                                "title": advisory.get("title", "Unknown"),
                                "url": advisory.get("url", ""),
                            }
                        )

            return vulnerabilities

        except (subprocess.TimeoutExpired, subprocess.CalledProcessError, OSError):
            return None

    def validate(self, context: ReleaseContext) -> ValidationResult:
        """Check for vulnerable dependencies.

        Args:
            context: Release context with project root

        Returns:
            ValidationResult with vulnerability findings
        """
        project_root = context.project_root

        # Detect package manager
        package_manager = self._detect_package_manager(project_root)
        if package_manager is None:
            # No package.json - skip audit
            return ValidationResult.success(
                "No package.json found - skipping dependency audit"
            )

        # Run audit
        vulnerabilities = self._run_audit(package_manager, project_root)
        if vulnerabilities is None:
            return ValidationResult.warning(
                message="Failed to run dependency audit",
                details=f"Could not execute {package_manager} audit command. "
                "Check that dependencies are installed and package manager is available.",
                fix_command=f"{package_manager} install",
            )

        # Count vulnerabilities
        critical_count = len(vulnerabilities["critical"])
        high_count = len(vulnerabilities["high"])
        moderate_count = len(vulnerabilities["moderate"])
        low_count = len(vulnerabilities["low"])

        total_count = critical_count + high_count + moderate_count + low_count

        if total_count == 0:
            return ValidationResult.success("No known vulnerabilities in dependencies")

        # Format findings
        details_lines = ["Dependency vulnerabilities found:\n"]

        # Show critical and high severity vulnerabilities
        for vuln in vulnerabilities["critical"][:5]:
            details_lines.append(
                f"  [CRITICAL] {vuln['name']}: {vuln['title']}\n    {vuln['url']}"
            )

        for vuln in vulnerabilities["high"][:5]:
            details_lines.append(
                f"  [HIGH] {vuln['name']}: {vuln['title']}\n    {vuln['url']}"
            )

        # Summarize moderate and low
        if moderate_count > 0:
            details_lines.append(f"\n  {moderate_count} moderate severity issues")
        if low_count > 0:
            details_lines.append(f"\n  {low_count} low severity issues")

        details_lines.append(
            f"\n\nRun `{package_manager} audit` for full details.\n"
            f"Fix with: `{package_manager} audit fix`"
        )

        # Return error for critical/high, warning for moderate/low
        if critical_count > 0 or high_count > 0:
            return ValidationResult.error(
                message=f"Found {critical_count + high_count} critical/high severity vulnerabilities",
                details="".join(details_lines),
                fix_command=f"{package_manager} audit fix",
            )

        return ValidationResult.warning(
            message=f"Found {moderate_count + low_count} moderate/low severity vulnerabilities",
            details="".join(details_lines),
            fix_command=f"{package_manager} audit fix",
        )
