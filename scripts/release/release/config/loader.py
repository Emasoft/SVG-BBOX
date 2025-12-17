"""Configuration file loading utilities.

Supports loading configuration from YAML and TOML files with:
- Automatic format detection
- Error reporting with file location
- Default value merging
"""

import sys
from pathlib import Path
from typing import Any

import yaml

from release.config.models import ReleaseConfig
from release.exceptions import ConfigurationError

# Import tomli for Python < 3.11, tomllib for 3.11+
if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib


def load_yaml(path: Path) -> dict[str, Any]:
    """Load a YAML configuration file.

    Args:
        path: Path to the YAML file

    Returns:
        Parsed YAML as dictionary

    Raises:
        ConfigurationError: If file cannot be read or parsed
    """
    try:
        with open(path, encoding="utf-8") as f:
            data = yaml.safe_load(f)
            return data if data else {}
    except FileNotFoundError:
        raise ConfigurationError(
            f"Configuration file not found: {path}",
            fix_hint="Create the file or use 'release init-config' to generate one",
        ) from None
    except yaml.YAMLError as e:
        raise ConfigurationError(
            f"Invalid YAML in {path}",
            details=str(e),
            fix_hint="Check YAML syntax at the indicated line",
        ) from e


def load_toml(path: Path) -> dict[str, Any]:
    """Load a TOML configuration file.

    Args:
        path: Path to the TOML file

    Returns:
        Parsed TOML as dictionary

    Raises:
        ConfigurationError: If file cannot be read or parsed
    """
    try:
        with open(path, "rb") as f:
            # Explicit type annotation to satisfy mypy (tomllib.load returns dict[str, Any])
            data: dict[str, Any] = tomllib.load(f)
            return data
    except FileNotFoundError:
        raise ConfigurationError(
            f"Configuration file not found: {path}",
            fix_hint="Create the file or use 'release init-config' to generate one",
        ) from None
    except tomllib.TOMLDecodeError as e:
        raise ConfigurationError(
            f"Invalid TOML in {path}",
            details=str(e),
            fix_hint="Check TOML syntax at the indicated line",
        ) from e


def load_config(
    path: Path | None = None,
    project_root: Path | None = None,
) -> ReleaseConfig:
    """Load release configuration from file.

    Search order if path not specified:
    1. config/release_conf.yml
    2. config/release_conf.yaml
    3. release_conf.yml
    4. release_conf.yaml
    5. config/release.toml
    6. release.toml

    Args:
        path: Explicit path to config file
        project_root: Project root directory (defaults to cwd)

    Returns:
        Validated ReleaseConfig instance

    Raises:
        ConfigurationError: If config not found or invalid
    """
    if project_root is None:
        project_root = Path.cwd()

    # Find config file - search_paths defined early for use in error messages
    search_paths = [
        "config/release_conf.yml",
        "config/release_conf.yaml",
        "release_conf.yml",
        "release_conf.yaml",
        "config/release.toml",
        "release.toml",
    ]
    config_path: Path | None = None
    if path:
        config_path = Path(path)
        if not config_path.is_absolute():
            config_path = project_root / config_path
    else:
        # Search for config file in standard locations
        for search_path in search_paths:
            candidate = project_root / search_path
            if candidate.exists():
                config_path = candidate
                break

    # Check moved outside else block for mypy type narrowing
    if config_path is None:
        raise ConfigurationError(
            "No configuration file found",
            details=f"Searched in: {', '.join(search_paths)}",
            fix_hint="Run 'release init-config' to create a configuration file",
        )

    # Load based on extension
    if config_path.suffix in (".yml", ".yaml"):
        data = load_yaml(config_path)
    elif config_path.suffix == ".toml":
        data = load_toml(config_path)
    else:
        raise ConfigurationError(
            f"Unsupported config format: {config_path.suffix}",
            fix_hint="Use .yml, .yaml, or .toml extension",
        )

    # Validate and create config
    from pydantic import ValidationError as PydanticValidationError

    try:
        return ReleaseConfig(**data)
    except PydanticValidationError as e:
        # Pydantic validation errors - expected failures
        raise ConfigurationError(
            f"Invalid configuration in {config_path}",
            details=str(e),
            fix_hint="Check the configuration values match expected types",
        ) from e
    except Exception as e:
        # Unexpected errors - include type info for debugging
        raise ConfigurationError(
            f"Unexpected error loading {config_path}",
            details=f"{type(e).__name__}: {e}",
        ) from e
