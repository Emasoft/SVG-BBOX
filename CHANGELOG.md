# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial public release
- Core library `SvgVisualBBox.js` with visual bbox computation
- CLI tool `sbb-getbbox` for computing visual bounding boxes
- CLI tool `sbb-export` for listing, extracting, and exporting SVG objects
- CLI tool `sbb-fix-viewbox` for fixing missing viewBox/dimensions
- CLI tool `sbb-render` for rendering SVG to PNG
- CLI tool `sbb-test` for testing library functions
- Sprite sheet detection and batch processing
- Interactive HTML catalog for SVG object exploration
- Comprehensive test suite (unit, integration, E2E)
- GitHub Actions CI/CD pipeline
- Documentation: README, CONTRIBUTING, DEVELOPING, SECURITY

### Features
- Two-pass rasterization for high-precision bbox measurement
- Clipped and unclipped bbox modes
- Font-aware text bounds (complex scripts, ligatures, textPath)
- Filter-safe bounds (blur, shadows, masks, clipping)
- Stroke-aware bounds (stroke width, caps, joins, markers)
- ViewBox repair and dimension synthesis
- Visual object catalog with filtering and renaming
- Clean cut-outs and standalone SVG exports
- PNG rendering with multiple modes (full, visible, element)
- Auto-detection of sprite sheets

## [1.0.0] - 2025-01-XX

### Added
- Initial release

[Unreleased]: https://github.com/Emasoft/SVG-BBOX/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Emasoft/SVG-BBOX/releases/tag/v1.0.0
