"""Ecosystem detection and management modules."""

from release.ecosystems.base import Ecosystem, EcosystemRegistry

# Import ecosystem implementations to trigger registration
from release.ecosystems.nodejs import NodeJSEcosystem

__all__ = ["Ecosystem", "EcosystemRegistry", "NodeJSEcosystem"]
