"""Ecosystem detection and management modules."""

from release.ecosystems.base import Ecosystem, EcosystemRegistry

# Import ecosystem implementations to trigger registration
from release.ecosystems import (
    go,  # noqa: F401
    nodejs,  # noqa: F401
    python,  # noqa: F401
    rust,  # noqa: F401
)

__all__ = ["Ecosystem", "EcosystemRegistry"]
