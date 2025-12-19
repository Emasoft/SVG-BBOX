"""Unit tests for release.publishers.base module.

Tests for:
- PublisherRegistry.register() - registering publisher classes
- PublisherRegistry.get() - retrieving registered publishers
- PublisherRegistry.list_registered() - listing all registered publisher names
- PublishContext - creation and attribute access

Coverage: 4 tests covering core publisher registry and context functionality.
"""

from pathlib import Path
from typing import ClassVar
from unittest.mock import MagicMock

from release.config.models import GitHubConfig, ProjectConfig, ReleaseConfig
from release.publishers.base import (
    PublishContext,
    Publisher,
    PublisherRegistry,
    PublishResult,
)


class TestPublisherRegistry:
    """Tests for PublisherRegistry class."""

    def test_register_adds_publisher_to_registry(self) -> None:
        """Test that register() correctly adds a publisher class to the registry.

        Creates a mock publisher class with all required class attributes
        and verifies it is properly registered and can be retrieved by name.
        """
        # Save original registry state
        original_publishers = PublisherRegistry._publishers.copy()

        try:
            # Create a test publisher class with required attributes
            class TestPublisher(Publisher):
                name: ClassVar[str] = "test_publisher"
                display_name: ClassVar[str] = "Test Publisher"
                registry_name: ClassVar[str] = "test.registry.com"

                def publish(self, context: PublishContext) -> PublishResult:
                    return PublishResult.success("Test publish")

                def verify(self, context: PublishContext) -> bool:
                    return True

            # Register the publisher
            result = PublisherRegistry.register(TestPublisher)

            # Verify registration succeeded
            assert result is TestPublisher, "register() should return the class"
            assert "test_publisher" in PublisherRegistry._publishers, (
                "Publisher should be in registry"
            )
            assert PublisherRegistry._publishers["test_publisher"] is TestPublisher, (
                "Registry should contain the correct class"
            )
        finally:
            # Restore original registry state
            PublisherRegistry._publishers = original_publishers

    def test_get_returns_registered_publisher(self) -> None:
        """Test that get() retrieves a registered publisher by name.

        Verifies that after registration, get() returns the correct publisher
        class, and returns None for unregistered names.
        """
        # Save original registry state
        original_publishers = PublisherRegistry._publishers.copy()

        try:
            # Create and register a test publisher
            class RetrievablePublisher(Publisher):
                name: ClassVar[str] = "retrievable_publisher"
                display_name: ClassVar[str] = "Retrievable Publisher"
                registry_name: ClassVar[str] = "retrieve.test.com"

                def publish(self, context: PublishContext) -> PublishResult:
                    return PublishResult.success("Published")

                def verify(self, context: PublishContext) -> bool:
                    return True

            PublisherRegistry.register(RetrievablePublisher)

            # Test retrieval of existing publisher
            retrieved = PublisherRegistry.get("retrievable_publisher")
            assert retrieved is RetrievablePublisher, (
                "get() should return the registered publisher class"
            )

            # Test retrieval of non-existent publisher
            not_found = PublisherRegistry.get("nonexistent_publisher")
            assert not_found is None, "get() should return None for unregistered names"
        finally:
            # Restore original registry state
            PublisherRegistry._publishers = original_publishers

    def test_list_registered_returns_all_publisher_names(self) -> None:
        """Test that list_registered() returns names of all registered publishers.

        Registers multiple publishers and verifies that list_registered()
        returns a list containing all their names.
        """
        # Save original registry state
        original_publishers = PublisherRegistry._publishers.copy()

        try:
            # Clear registry for clean test
            PublisherRegistry._publishers = {}

            # Create and register multiple test publishers
            class FirstPublisher(Publisher):
                name: ClassVar[str] = "first_pub"
                display_name: ClassVar[str] = "First Publisher"
                registry_name: ClassVar[str] = "first.test.com"

                def publish(self, context: PublishContext) -> PublishResult:
                    return PublishResult.success("First")

                def verify(self, context: PublishContext) -> bool:
                    return True

            class SecondPublisher(Publisher):
                name: ClassVar[str] = "second_pub"
                display_name: ClassVar[str] = "Second Publisher"
                registry_name: ClassVar[str] = "second.test.com"

                def publish(self, context: PublishContext) -> PublishResult:
                    return PublishResult.success("Second")

                def verify(self, context: PublishContext) -> bool:
                    return True

            PublisherRegistry.register(FirstPublisher)
            PublisherRegistry.register(SecondPublisher)

            # Get list of registered names
            registered_names = PublisherRegistry.list_registered()

            # Verify both publishers are listed
            assert isinstance(registered_names, list), "Should return a list"
            assert "first_pub" in registered_names, "First publisher should be listed"
            assert "second_pub" in registered_names, "Second publisher should be listed"
            assert len(registered_names) == 2, "Should have exactly 2 publishers"
        finally:
            # Restore original registry state
            PublisherRegistry._publishers = original_publishers


class TestPublishContext:
    """Tests for PublishContext dataclass."""

    def test_publish_context_creation_with_all_fields(self, project_dir: Path) -> None:
        """Test that PublishContext can be created with all required fields.

        Creates a complete PublishContext with realistic values and verifies
        all attributes are accessible and have correct values.
        """
        # Create a minimal ReleaseConfig mock
        mock_config = MagicMock(spec=ReleaseConfig)
        mock_config.project = ProjectConfig(name="test-project", description="Test")
        mock_config.github = GitHubConfig(owner="testowner", repo="testrepo")

        # Create release notes content
        release_notes = """## What's Changed

### Features
- Added new feature X
- Improved performance of Y

### Bug Fixes
- Fixed issue with Z
"""

        # Create PublishContext with all fields
        context = PublishContext(
            project_root=project_dir,
            config=mock_config,
            version="2.1.0",
            tag_name="v2.1.0",
            release_notes=release_notes,
            dry_run=False,
            verbose=True,
        )

        # Verify all attributes
        assert context.project_root == project_dir, "project_root should match input"
        assert context.config is mock_config, "config should match input"
        assert context.version == "2.1.0", "version should be '2.1.0'"
        assert context.tag_name == "v2.1.0", "tag_name should be 'v2.1.0'"
        assert "What's Changed" in context.release_notes, (
            "release_notes should contain expected content"
        )
        assert context.dry_run is False, "dry_run should be False"
        assert context.verbose is True, "verbose should be True"

        # Verify default values work when omitted
        context_minimal = PublishContext(
            project_root=project_dir,
            config=mock_config,
            version="1.0.0",
            tag_name="v1.0.0",
            release_notes="Initial release",
        )
        assert context_minimal.dry_run is False, "dry_run default should be False"
        assert context_minimal.verbose is False, "verbose default should be False"
