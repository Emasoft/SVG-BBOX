"""Safe subprocess execution utilities.

Provides secure, robust shell command execution with:
- ANSI escape code stripping (prevents contamination in version strings)
- Proper error handling and reporting
- Timeout support
- Environment variable injection
"""

import os
import re
import shlex
import subprocess
from pathlib import Path


class ShellError(Exception):
    """Exception raised when a shell command fails.

    Attributes:
        cmd: The command that failed
        returncode: Exit code of the failed command
        stdout: Standard output (ANSI stripped)
        stderr: Standard error (ANSI stripped)
    """

    def __init__(
        self,
        cmd: str,
        returncode: int,
        stdout: str,
        stderr: str,
    ) -> None:
        self.cmd = cmd
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr
        super().__init__(f"Command failed with exit code {returncode}: {cmd}")

    def __str__(self) -> str:
        parts = [f"Command failed: {self.cmd}"]
        parts.append(f"Exit code: {self.returncode}")
        if self.stderr:
            parts.append(f"Stderr: {self.stderr}")
        if self.stdout:
            parts.append(f"Stdout: {self.stdout}")
        return "\n".join(parts)


# Regex pattern for ANSI escape sequences
# Matches: ESC[...m, ESC[...;...m, and other control sequences
ANSI_PATTERN = re.compile(
    r"\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[PX^_][^\x1b]*\x1b\\"
)

# Additional pattern for control characters that might slip through
CONTROL_CHARS_PATTERN = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def strip_ansi(text: str) -> str:
    """Remove ANSI escape sequences and control characters from text.

    This is critical for preventing ANSI code contamination in version
    strings and git tag names. The bash script had multiple bugs caused
    by ANSI codes leaking into version variables.

    Args:
        text: Input text potentially containing ANSI codes

    Returns:
        Clean text with all ANSI sequences removed
    """
    if not text:
        return ""
    # Remove ANSI escape sequences
    result = ANSI_PATTERN.sub("", text)
    # Remove stray control characters
    result = CONTROL_CHARS_PATTERN.sub("", result)
    return result


def run(
    cmd: str | list[str],
    cwd: Path | None = None,
    capture: bool = True,
    check: bool = True,
    timeout: int = 300,
    env: dict[str, str] | None = None,
    strip_output: bool = True,
) -> subprocess.CompletedProcess[str]:
    """Execute a shell command safely.

    Key security features:
    - Always uses shell=False to prevent shell injection
    - Strips ANSI codes from output by default
    - Raises ShellError with context on failure

    Args:
        cmd: Command to execute (string or list of arguments)
        cwd: Working directory for the command
        capture: Whether to capture stdout/stderr
        check: Whether to raise ShellError on non-zero exit
        timeout: Maximum execution time in seconds
        env: Additional environment variables
        strip_output: Whether to strip ANSI codes from output

    Returns:
        CompletedProcess with stdout/stderr (ANSI stripped if requested)

    Raises:
        ShellError: If command fails and check=True
        subprocess.TimeoutExpired: If command exceeds timeout
    """
    # Convert string command to list for shell=False
    cmd_list = shlex.split(cmd) if isinstance(cmd, str) else list(cmd)

    # Merge environment
    merged_env = {**os.environ}
    if env:
        merged_env.update(env)

    # Execute command
    result = subprocess.run(
        cmd_list,
        cwd=cwd,
        capture_output=capture,
        text=True,
        timeout=timeout,
        env=merged_env,
    )

    # Strip ANSI codes from output
    if capture and strip_output:
        result.stdout = strip_ansi(result.stdout) if result.stdout else ""
        result.stderr = strip_ansi(result.stderr) if result.stderr else ""

    # Check for errors
    if check and result.returncode != 0:
        raise ShellError(
            cmd=" ".join(cmd_list),
            returncode=result.returncode,
            stdout=result.stdout or "",
            stderr=result.stderr or "",
        )

    return result


def run_silent(
    cmd: str | list[str],
    cwd: Path | None = None,
    timeout: int = 300,
    env: dict[str, str] | None = None,
) -> bool:
    """Execute a command silently, returning success/failure.

    Useful for checking if a command succeeds without caring about output.

    Args:
        cmd: Command to execute
        cwd: Working directory
        timeout: Maximum execution time
        env: Additional environment variables

    Returns:
        True if command succeeded (exit code 0), False otherwise
    """
    try:
        result = run(cmd, cwd=cwd, capture=True, check=False, timeout=timeout, env=env)
        return result.returncode == 0  # Check actual exit code, not just no exception
    except subprocess.TimeoutExpired:
        return False


def which(program: str) -> Path | None:
    """Find the full path to a program.

    Uses shutil.which() from standard library for safety and portability.
    Avoids shell injection vulnerabilities from string interpolation.

    Args:
        program: Name of the program to find

    Returns:
        Path to the program, or None if not found
    """
    import shutil

    path_str = shutil.which(program)
    return Path(path_str) if path_str else None


def is_command_available(cmd: str) -> bool:
    """Check if a command is available in PATH.

    Args:
        cmd: Command name to check

    Returns:
        True if command is available
    """
    import shutil

    return shutil.which(cmd) is not None
