# Contributing to SVG-BBOX

Thank you for considering contributing to SVG-BBOX! This document provides
guidelines and information for contributors.

## Code of Conduct

Be respectful, inclusive, and professional in all interactions. We welcome
contributions from everyone.

## How to Contribute

### Reporting Bugs

Before creating a bug report:

- Check existing issues to avoid duplicates
- Use the latest version of SVG-BBOX
- Provide clear reproduction steps

Include in your bug report:

- SVG-BBOX version (`npm list svg-bbox`)
- Node.js version (`node --version`)
- Operating system
- Minimal SVG file that reproduces the issue
- Expected vs actual behavior
- Complete error messages

### Suggesting Enhancements

Enhancement suggestions are welcome! Please:

- Check existing issues/discussions first
- Explain the use case clearly
- Provide examples of how it would work
- Consider implementation complexity

### Pull Requests

1. **Fork and Clone**

   ```bash
   git clone https://github.com/YOUR_USERNAME/SVG-BBOX.git
   cd svg-bbox
   bun install
   ```

2. **Create a Branch**

   ```bash
   git checkout -b feature/my-feature
   # or
   git checkout -b fix/my-bugfix
   ```

3. **Make Changes**
   - Follow the existing code style
   - Write clear commit messages
   - Add tests for new functionality
   - Update documentation as needed

4. **Test Your Changes**

   ```bash
   # Run all tests
   bun run test

   # Run specific test suites
   bun run test:unit
   bun run test:integration
   bun run test:e2e

   # Check coverage
   bun run test:coverage

   # Lint and format
   bun run lint
   bun run format
   ```

5. **Commit Guidelines**
   - Use conventional commit format:
     - `feat:` for new features
     - `fix:` for bug fixes
     - `docs:` for documentation changes
     - `test:` for test additions/changes
     - `refactor:` for code refactoring
     - `perf:` for performance improvements
     - `chore:` for maintenance tasks

   Example:

   ```
   feat: Add support for preserveAspectRatio detection

   - Implement aspect ratio parsing in SvgVisualBBox
   - Add tests for meet/slice alignment modes
   - Update documentation with new options
   ```

6. **Push and Create PR**

   ```bash
   git push origin feature/my-feature
   ```

   - Create PR on GitHub
   - Fill out the PR template
   - Link related issues

## Development Setup

See [DEVELOPING.md](DEVELOPING.md) for detailed development instructions.

## Build pipeline (CDN bundle)

The minified browser bundle published to npm — and from there to unpkg /
jsDelivr — is `SvgVisualBBox.min.js`. The default `npm run build` script
produces it via **Terser** (`scripts/build-min.cjs`), not Bun. **Do not switch
the publish pipeline to `bun run build.js`** even though the file exists.
Background:

- `SvgVisualBBox.js` is a hand-authored UMD module that side-effects
  `root.SvgVisualBBox = factory()` so a `<script>` tag exposes it as a global.
  Browser CDN consumers depend on that side-effect.
- `Bun.build()` always wraps the entry in a synthetic CJS scope before running
  it. The UMD's runtime detection sees that scope's `module.exports` and takes
  the CJS branch (`e.exports = factory()`) — the global-assignment branch never
  runs. The minified file looks fine but `window.SvgVisualBBox` ends up
  `undefined` in browsers.
- Terser minifies the source byte-for-byte without inserting any wrapper, which
  preserves the UMD's three-way detection. Verified against Bun 1.3.13 with
  every `format` / `target` combination.
- CI guards against accidental regressions: `.github/workflows/ci.yml` fails the
  build if `SvgVisualBBox.min.js` ever contains `export default`.
- Re-evaluate this choice when Bun grows a real `globalName` option (esbuild has
  one) or stops wrapping IIFE entries in synthetic CJS scopes. Until then,
  Terser is the right tool.

The Node CJS shim `SvgVisualBBox.cjs` is hand-written, not built — it re-exports
the FBF helpers from `lib/fbf.cjs` and stubs the DOM-bound functions with
actionable error messages. Edit it directly when you need to change either of
those concerns.

The same FBF helper logic lives in three places:

- `lib/fbf.cjs` — single source of truth for Node CommonJS.
- `SvgVisualBBox.js` — inlined into the UMD because the browser bundle cannot
  `require()`.
- `SvgVisualBBox.cjs` — Node shim; re-exports from `lib/fbf.cjs`.

Keep these in lockstep when touching FBF behaviour. The regression test
`tests/integration/fbf-cross-runtime.test.js` (or your preferred location)
should pin all three to the same fixture.

## Testing Guidelines

### Unit Tests

- Test individual functions and modules
- Mock external dependencies (Puppeteer, file system)
- Fast execution (< 1 second each)

### Integration Tests

- Test tool interactions with real SVG files
- Use sample SVG files from `samples/`
- Verify complete workflows

### E2E Tests

- Test full CLI command execution
- Use real browser instances
- Cover common user scenarios

### Test Naming

```javascript
// ✓ Good
test('getSvgElementVisualBBoxTwoPassAggressive returns correct bbox for rotated text', async () => {
  // ...
});

// ✗ Bad
test('test1', async () => {
  // ...
});
```

### Reference Renderer Tests

The project includes a Python reference SVG renderer
(`tests/lib/reference_renderer.py`) that produces byte-identical output to
Chrome for testing purposes.

**Setup:**

```bash
cd tests
python3 -m venv .venv
source .venv/bin/activate
pip install Pillow lxml
```

**Test Fixtures:**

- `tests/fixtures/raster-specimens/` - SVG specimens for alpha/color testing
- `tests/fixtures/diff-specimens/` - SVG specimens for diff score verification

**Key Test Files:**

- `reference-renderer-comparison.test.js` - Compares Chrome vs Python rendering
- `diff-score-accuracy.test.js` - Verifies diff score formula accuracy
- `rasterization-pipeline.test.js` - Tests RGBA value accuracy

**What These Tests Catch:**

- Changes in Chrome's SVG rendering (alpha compositing, color accuracy)
- Regressions in diff score calculation formula
- Alpha channel handling errors (transparent/opaque/semi-transparent)
- Black/white edge cases with special alpha treatment

## Documentation

### Code Comments

- Explain **why**, not what
- Document edge cases and limitations
- Add JSDoc for public APIs

### README Updates

- Keep command examples accurate
- Update feature lists
- Maintain table of contents

### CHANGELOG

- Add entries for all user-facing changes
- Follow Keep a Changelog format
- Group by type: Added, Changed, Fixed, etc.

## Code Style

### JavaScript/Node.js

- Use ES6+ features (async/await, destructuring, etc.)
- Prefer `const` over `let`, avoid `var`
- Use meaningful variable names
- Keep functions focused and small
- Handle errors explicitly (no silent failures)

### File Naming

- CLI tools: `sbb-*.cjs` (e.g., `sbb-getbbox.cjs`)
- Libraries: `PascalCase.js` (e.g., `SvgVisualBBox.js`)
- Utilities: `kebab-case.cjs` (e.g., `browser-utils.cjs`)
- Tests: `*.test.js` or `*.spec.js`

### Error Handling

```javascript
// ✓ Good - Explicit error with context
if (!svgElement) {
  throw new Error(`Element not found: ${elementId}`);
}

// ✗ Bad - Silent failure
if (!svgElement) return null;
```

## Performance Considerations

- Visual bbox computation is CPU-intensive
- Cache results when possible
- Consider `coarseFactor` and `fineFactor` trade-offs
- Profile before optimizing

## Release Process

Releases are managed by maintainers using the unified release pipeline:

```bash
./scripts/release.sh patch   # For bug fixes (1.0.10 → 1.0.11)
./scripts/release.sh minor   # For new features (1.0.10 → 1.1.0)
./scripts/release.sh major   # For breaking changes (1.0.10 → 2.0.0)
```

The release script handles everything automatically:

- Version bump in `package.json`
- Changelog update with git-cliff
- Git commit and tag creation
- Push to GitHub
- Wait for CI to pass
- Create GitHub Release
- Publish to npm via trusted publishing
- Verify package installation

**Never** perform release steps manually - always use the unified pipeline.

## Questions?

- Open a discussion on GitHub
- Check existing documentation
- Review closed issues for similar questions

Thank you for contributing! 🎨
