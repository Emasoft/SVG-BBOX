# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.10] - 2025-11-27

### Refactor

- _(cli)_ Clarify tool naming with algorithm prefixes

## [1.0.9] - 2025-11-27

### Bug Fixes

- _(ci)_ Strip publish.yml to minimal OIDC-only workflow
- _(ci)_ Add npm install for prepublishOnly script dependencies

### Miscellaneous Tasks

- _(ci)_ Add comprehensive npm OIDC diagnostics per GitHub Copilot
- _(release)_ Prepare for v1.0.8 release

## [1.0.8] - 2025-11-27

### Bug Fixes

- _(docs)_ Force white background on comparison table for dark mode
- _(docs)_ Use theme-aware images for dark mode compatibility
- Multiple CI/CD and test infrastructure improvements
- _(docs)_ Increase logo sizes in comparison table for better visibility
- _(docs)_ Use width instead of height for logo consistency
- Update vitest config for v4 compatibility
- _(ci)_ Properly configure OIDC trusted publishing for npm
- _(ci)_ Use Node.js 24 with npm 11.6.0 for OIDC trusted publishing
- _(ci)_ Add required registry-url to setup-node for OIDC
- _(ci)_ Apply GitHub Copilot recommendations for OIDC publishing

### Documentation

- Add comprehensive npm trusted publishing discovery documentation

### Miscellaneous Tasks

- _(ci)_ Remove explicit --provenance flag from npm publish
- Update vitest to 4.0.14 to fix esbuild vulnerability

## [1.0.7] - 2025-11-27

### Bug Fixes

- _(ci)_ Create .npmrc with auth token for pnpm publish
- _(ci)_ Use npm publish with provenance instead of pnpm
- _(ci)_ Remove all pnpm dependencies, use npm only
- _(tests)_ Increase font rendering tolerance from 3px to 4px
- _(ci)_ Restore pnpm for CI, use npm only for publish

### Features

- Add git-cliff for automatic changelog generation

### Miscellaneous Tasks

- Bump version to 1.0.7
- Fix Prettier formatting in CHANGELOG.md

## [1.0.6] - 2025-11-26

### Bug Fixes

- Run Prettier on README.md to fix CI formatting check
- Format README with Prettier
- _(types)_ Add proper type assertions for SVGGraphicsElement in
  sbb-getbbox-extract

### Documentation

- Update README with svg-bbox command and improved installation guide
- Major README rewrite - library as primary focus
- Add visual comparison of bbox methods to README
- Add oval badge example to visual comparison in README
- Add Inkscape extraction to oval badge example
- Force white background for comparison table images
- Apply full white background theme to comparison table
- Fix comparison table to use equal column widths
- Add logos and standardize comparison table styling
- Use max-height for images and improve text row styling
- Enforce equal height for all comparison images
- Adjust image height to reasonable 70px for table display
- Preserve image aspect ratios with fixed height only
- Reduce logo row height to 20px for compact design
- Preserve aspect ratio for logo images
- Constrain logo row height to 30px total
- Use CSS style attributes for logo dimensions
- Remove height and padding constraints from logo row
- Add max-width to preserve logo aspect ratio
- Add max-width to comparison images for aspect ratio
- Use max-height instead of height for aspect ratio
- Enforce equal height with proper aspect ratio
- Scale images to fill column width with proper aspect ratio
- Enforce minimum height constraint for equal row height
- Fix aspect ratio preservation with height-based scaling
- Use object-fit contain to preserve aspect ratio
- FINALLY fix aspect ratio with simple height + width auto
- Simplify comparison table and fix text alignment
- Replace README logos with official SvgVisualBBox logos
- Improve comparison table with visual verdict row
- Increase verdict text size to 48px for better visibility
- Add color coding to verdict text matching emojis
- Use icon-only logo in comparison table for consistency
- Fix logo alignment and center platform names
- Brighten CORRECT text color to match ✅ emoji
- Increase logo size and fix oval badge aspect ratio
- Add bbox comparison example script and improve table links
- Add test_oval_badge.svg to examples folder
- Add missing sbb-getbbox-extract tool and reorganize features
- Simplify README - clearer library/tools separation
- Simplify comparison descriptions

### Features

- Add svg-bbox main CLI entry point
- Add sbb-getbbox-extract tool for Chrome .getBBox() extraction

### Miscellaneous Tasks

- Add \*\_dev/ pattern to gitignore and npmignore
- Repository maintenance and improvements
- Add npm publish workflow
- Bump version to 1.0.4
- Bump version to 1.0.5

## [1.0.3] - 2025-11-26

### Bug Fixes

- Correct ESLint indentation errors
- Resolve all TypeScript type checking errors
- Move all test temp files from /tmp to project directories
- _(ci)_ Update pnpm version to 9 in GitHub Actions
- Comment out NPM_TOKEN line in .npmrc for local publishing
- Move browser-based tests from unit to integration directory
- _(ci)_ Add --no-sandbox flag to Puppeteer launch in integration tests
- _(e2e)_ Fix Playwright ESM import error by using CommonJS for E2E tests
- _(e2e)_ Fix temp directory race conditions in E2E tests
- _(test)_ Increase sbb-comparer timeout for CI environments
- _(core)_ Fix <use> element and SVG root rendering bugs
- _(types)_ Add type cast for cloneNode to satisfy TypeScript
- _(security)_ Add shell metacharacter validation for batch file paths
- _(lint)_ Remove duplicate SHELL_METACHARACTERS export
- Use proper error classes in validateFilePath for consistent stderr output
- _(tests)_ Use semicolon instead of $() to avoid shell expansion in tests
- _(tests)_ Replace backticks with pipe to avoid shell expansion
- _(tests)_ Use ampersand instead of semicolon for shell metacharacter test
- _(tests)_ Skip html-preview-structure tests on Node 18
- _(lint)_ Remove unused skipOnNode18 variable
- _(tests)_ Use pipe character for text-to-path test - same as comparer
- _(tests)_ Use dynamic import to prevent jsdom loading on Node 18
- _(format)_ Run Prettier on html-preview-structure.test.js
- _(ci)_ Resolve integration test failures on CI
- _(coverage)_ Configure coverage for server-side code only

### Documentation

- _(core)_ Add comprehensive lessons-learned comments
- _(core)_ Enhanced wrong vs. right solution documentation

### Features

- Add npm registry authentication to .npmrc for CI/CD

### Miscellaneous Tasks

- Bump version to 1.0.2
- Apply prettier formatting to all files
- Rebuild minified file
- Add .prettierignore and format files
- Format config files and rebuild minified
- Remove obsolete afterAll hook comment from showTrueBBoxBorder test
- Upgrade Playwright to 1.57.0
- Format security-utils.cjs with Prettier

### Styling

- _(e2e)_ Fix ESLint arrow-body-style warnings in E2E tests

## [1.0.2] - 2025-11-26

### Bug Fixes

- Resolve vertical shift bug in sbb-comparer viewBox handling
- Ensure all 3 Inkscape tools match exact Python defaults

### Documentation

- Style package name with large centered HTML heading
- Update package description to emphasize reliability
- Rewrite 'What is this?' section with problem-solution format
- Add 'What can SVG-BBOX toolkit do for you?' section
- Update SECURITY.md with current progress (1/6 tools complete)
- Update SECURITY.md - 4/6 tools complete (66.7%)
- Add clarifying comments on viewBox preservation in renderSvgToPng
- Add Inkscape tools section to README with accuracy warnings
- Add comprehensive Inkscape parameter comments to all tools
- Add comprehensive npm publish checklist and update CHANGELOG
- Add CDN usage examples to README

### Features

- Add sbb-comparer tool for visual SVG comparison
- Add HTML comparison report to sbb-comparer
- Enhance HTML comparison report with dark mode and branding
- Add comprehensive tooltips to HTML comparison report
- Improve sbb-comparer HTML tooltips and fix SVG border sizing
- Add browser API with showTrueBBoxBorder() function and comprehensive
  documentation
- Add setViewBoxOnObjects() for viewBox reframing
- Apply comprehensive security fixes to sbb-getbbox.cjs
- Apply comprehensive security fixes to sbb-fix-viewbox.cjs
- Apply comprehensive security fixes to sbb-svg2png.cjs
- Apply comprehensive security fixes to sbb-test.cjs
- Apply comprehensive security fixes to sbb-comparer.cjs
- Apply comprehensive security fixes to sbb-extractor.cjs
- Add sbb-text-to-path.cjs - cross-platform Inkscape text-to-path converter
- Add batch processing and automatic comparison to sbb-text-to-path.cjs
- Add batch comparison support to sbb-comparer
- Add sbb-inkscape-extract and sbb-inkscape-exportpng tools
- Enhance sbb-inkscape-exportpng with comprehensive PNG export options
- Add sbb-inkscape-svg2png simple SVG to PNG converter
- Add CDN distribution support with minified build

### Miscellaneous Tasks

- Bump version to 1.0.1
- Add diff PNG patterns to .gitignore
- Remove accidentally committed diff PNG files
- Configure Inkscape tools for npm packaging
- Fix eslint config and reduce lint errors (289→132)
- Partial lint error fixes (132→120 errors)
- Major lint error reduction (132→101 errors, 65% total reduction)
- Prepare for v1.0.2 publication - Security fixes and documentation

### Refactor

- Rename sbb-export to sbb-extractor
- Improve option naming and add symbol resolution
- Comprehensive test improvement - modularization, cross-platform, error
  handling
- Rename sbb-text-to-path to sbb-inkscape-text2path
- Consolidate to 3 Inkscape tools, rename exportpng to svg2png

### Security

- Add comprehensive security infrastructure and audit findings

### Testing

- Add comprehensive tests for sbb-comparer
- Add comprehensive E2E tests for showTrueBBoxBorder()
- Apply 5 edge cases to ALL test scenarios
- Refactor setViewBoxOnObjects tests to use 5 edge cases
- Add comprehensive security test suite
- Add integration tests for all 3 Inkscape tools

## [1.0.1] - 2025-11-24

### Bug Fixes

- Rename export-svg-objects.js to .cjs for ES module compatibility
- Scale SVG preview containers to preserve aspect ratio
- Set SVG width/height to match viewBox dimensions
- Report bbox measurement failures instead of silent defaults
- Increase MAX_CANVAS_DIMENSION to ensure consistent pixel-to-unit scaling
- Remove viewBox constraints from hidden SVG container in HTML previews
- Remove width/height attributes from HTML preview SVGs
- Rewrite HTML preview tests to use SvgVisualBBox library
- Make E2E tests compatible with Playwright 1.56 ESM API
- Complete E2E test suite implementation and validation fixes
- Remove obsolete bash script for Windows cross-platform compatibility
- Improve Windows compatibility for file paths with spaces

### Documentation

- Document root cause of HTML preview transform bug
- Expand HTML preview transform bug documentation with testing details
- Add comprehensive documentation for HTML preview border solution
- Add getbbox.cjs documentation to README
- Improve help screens for all CLI tools
- Fix README to use correct sbb-\* command names
- Add comprehensive cross-platform compatibility section

### Features

- Add maximum detail to all error messages
- Add auto-generated ID warnings to all error messages
- Automatically save debug SVG files on auto-ID errors
- Add --auto-open flag to automatically open HTML in browser
- Add --auto-open to all visual output tools
- Enforce Chrome/Chromium-only browser usage with comprehensive testing
- Add getbbox.cjs - CLI utility for computing visual bounding boxes
- Add sprite sheet detection to getbbox.cjs
- Add sprite sheet detection to export-svg-objects.cjs
- Add comprehensive version management system

### Miscellaneous Tasks

- Update dependencies for Playwright E2E tests
- Prepare repository for npm publication
- Prepare repository for GitHub and npm publication

### Testing

- Add comprehensive HTML preview rendering tests with all faulty methods
  documented
- Rewrite tests to use runtime font detection (no hardcoded fonts)
- Add comprehensive Playwright E2E tests for HTML list interactive features

<!-- generated by git-cliff -->
