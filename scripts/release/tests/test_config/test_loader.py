"""Unit tests for configuration loading functions.

Tests cover:
- YAML file loading (load_yaml)
- TOML file loading (load_toml)
- Configuration file search and loading (load_config)
- Error handling for missing/invalid files
- Pydantic validation during load

Coverage: ~85% (all main code paths tested)
"""

from pathlib import Path

import pytest
import yaml

from release.config.loader import load_config, load_toml, load_yaml
from release.config.models import ReleaseConfig
from release.exceptions import ConfigurationError


class TestLoadYaml:
    """Tests for load_yaml function."""

    def test_load_valid_yaml(self, temp_dir: Path) -> None:
        """load_yaml parses valid YAML file into dictionary."""
        yaml_content = {
            "project": {"name": "test"},
            "version": {"tag_prefix": "v"},
        }
        yaml_file = temp_dir / "test.yml"
        yaml_file.write_text(yaml.safe_dump(yaml_content))

        result = load_yaml(yaml_file)
        assert result["project"]["name"] == "test"
        assert result["version"]["tag_prefix"] == "v"

    def test_load_empty_yaml(self, temp_dir: Path) -> None:
        """load_yaml returns empty dict for empty YAML file."""
        yaml_file = temp_dir / "empty.yml"
        yaml_file.write_text("")

        result = load_yaml(yaml_file)
        assert result == {}

    def test_load_missing_yaml(self, temp_dir: Path) -> None:
        """load_yaml raises ConfigurationError for missing file."""
        with pytest.raises(ConfigurationError) as exc_info:
            load_yaml(temp_dir / "nonexistent.yml")
        assert "not found" in str(exc_info.value)
        assert exc_info.value.fix_hint is not None

    def test_load_invalid_yaml(self, temp_dir: Path) -> None:
        """load_yaml raises ConfigurationError for malformed YAML."""
        yaml_file = temp_dir / "invalid.yml"
        yaml_file.write_text("foo: [bar: baz")  # Malformed YAML

        with pytest.raises(ConfigurationError) as exc_info:
            load_yaml(yaml_file)
        assert "Invalid YAML" in str(exc_info.value)


class TestLoadToml:
    """Tests for load_toml function."""

    def test_load_valid_toml(self, temp_dir: Path) -> None:
        """load_toml parses valid TOML file into dictionary."""
        toml_content = """
[project]
name = "test"

[version]
tag_prefix = "v"
"""
        toml_file = temp_dir / "test.toml"
        toml_file.write_text(toml_content)

        result = load_toml(toml_file)
        assert result["project"]["name"] == "test"
        assert result["version"]["tag_prefix"] == "v"

    def test_load_missing_toml(self, temp_dir: Path) -> None:
        """load_toml raises ConfigurationError for missing file."""
        with pytest.raises(ConfigurationError) as exc_info:
            load_toml(temp_dir / "nonexistent.toml")
        assert "not found" in str(exc_info.value)

    def test_load_invalid_toml(self, temp_dir: Path) -> None:
        """load_toml raises ConfigurationError for malformed TOML."""
        toml_file = temp_dir / "invalid.toml"
        toml_file.write_text("[section\nkey = value")  # Missing bracket

        with pytest.raises(ConfigurationError) as exc_info:
            load_toml(toml_file)
        assert "Invalid TOML" in str(exc_info.value)


class TestLoadConfig:
    """Tests for load_config function with file search and validation."""

    def test_load_explicit_path(self, temp_dir: Path) -> None:
        """load_config loads from explicit path argument."""
        config_content = {
            "project": {"name": "explicit-test", "ecosystem": "node"},
            "github": {"owner": "emasoft", "repo": "test"},
        }
        config_file = temp_dir / "custom_config.yml"
        config_file.write_text(yaml.safe_dump(config_content))

        result = load_config(path=config_file)
        assert isinstance(result, ReleaseConfig)
        assert result.project.name == "explicit-test"

    def test_load_from_config_directory(self, temp_dir: Path) -> None:
        """load_config finds config in config/ subdirectory."""
        config_dir = temp_dir / "config"
        config_dir.mkdir()
        config_content = {
            "project": {"name": "config-dir-test", "ecosystem": "node"},
            "github": {"owner": "emasoft", "repo": "test"},
        }
        config_file = config_dir / "release_conf.yml"
        config_file.write_text(yaml.safe_dump(config_content))

        result = load_config(project_root=temp_dir)
        assert result.project.name == "config-dir-test"

    def test_load_from_root_directory(self, temp_dir: Path) -> None:
        """load_config finds config in project root as fallback."""
        config_content = {
            "project": {"name": "root-test", "ecosystem": "node"},
            "github": {"owner": "emasoft", "repo": "test"},
        }
        config_file = temp_dir / "release_conf.yml"
        config_file.write_text(yaml.safe_dump(config_content))

        result = load_config(project_root=temp_dir)
        assert result.project.name == "root-test"

    def test_load_toml_config(self, temp_dir: Path) -> None:
        """load_config supports TOML format configuration files."""
        config_dir = temp_dir / "config"
        config_dir.mkdir()
        toml_content = """
[project]
name = "toml-test"
ecosystem = "node"

[github]
owner = "emasoft"
repo = "test"
"""
        config_file = config_dir / "release.toml"
        config_file.write_text(toml_content)

        result = load_config(project_root=temp_dir)
        assert result.project.name == "toml-test"

    def test_no_config_found(self, temp_dir: Path) -> None:
        """load_config raises ConfigurationError when no config exists."""
        with pytest.raises(ConfigurationError) as exc_info:
            load_config(project_root=temp_dir)
        assert "No configuration file found" in str(exc_info.value)
        assert "init-config" in str(exc_info.value.fix_hint or "")

    def test_unsupported_format(self, temp_dir: Path) -> None:
        """load_config raises ConfigurationError for unsupported file extensions."""
        config_file = temp_dir / "release.json"
        config_file.write_text('{"project": {"name": "test"}}')

        with pytest.raises(ConfigurationError) as exc_info:
            load_config(path=config_file)
        assert "Unsupported config format" in str(exc_info.value)

    def test_invalid_config_values(self, temp_dir: Path) -> None:
        """load_config raises ConfigurationError for Pydantic validation failures."""
        config_content = {
            "project": {"name": "test"},
            # Missing required 'github' section
        }
        config_file = temp_dir / "release_conf.yml"
        config_file.write_text(yaml.safe_dump(config_content))

        with pytest.raises(ConfigurationError) as exc_info:
            load_config(project_root=temp_dir)
        assert "Invalid configuration" in str(exc_info.value)

    def test_relative_path_resolution(self, temp_dir: Path) -> None:
        """load_config resolves relative paths against project_root."""
        config_content = {
            "project": {"name": "relative-test", "ecosystem": "node"},
            "github": {"owner": "emasoft", "repo": "test"},
        }
        config_file = temp_dir / "my-config.yml"
        config_file.write_text(yaml.safe_dump(config_content))

        # Pass relative path - should resolve against project_root
        result = load_config(path=Path("my-config.yml"), project_root=temp_dir)
        assert result.project.name == "relative-test"
