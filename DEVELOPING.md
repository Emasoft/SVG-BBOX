# Development Guide

This guide covers the development setup, architecture, and workflows for SVG-BBOX contributors.

## Prerequisites

- **Node.js** ≥ 18.0.0
- **pnpm** (recommended) or npm
- **Chrome/Chromium** browser installed
- **Git** for version control

## Initial Setup

### 1. Clone and Install

```bash
git clone https://github.com/YOUR_USERNAME/svg-bbox.git
cd svg-bbox
pnpm install
```

### 2. Install Browser Dependencies

SVG-BBOX requires Chrome/Chromium for visual bbox computation:

```bash
# Install Playwright Chromium and Puppeteer Chrome
pnpm run install-browsers
```

This installs:
- Playwright's Chromium (for E2E tests)
- Puppeteer's Chrome (for CLI tools)

### 3. Verify Setup

```bash
# Run all tests to verify everything works
pnpm test

# Run E2E tests
pnpm test:e2e

# Try CLI tools
node sbb-getbbox.cjs samples/test_text_to_path_advanced.svg
```

## Project Structure

```
svg-bbox/
├── SvgVisualBBox.js           # Core library (browser-side)
├── sbb-*.cjs                  # CLI tools (Node.js)
│   ├── sbb-getbbox.cjs        # Compute visual bboxes
│   ├── sbb-export.cjs         # Extract/export SVG objects
│   ├── sbb-fix-viewbox.cjs    # Fix missing viewBox/dimensions
│   ├── sbb-render.cjs         # Render SVG to PNG
│   └── sbb-test.cjs           # Test harness
├── browser-utils.cjs          # Browser launch utilities
├── tests/                     # Test suites
│   ├── unit/                  # Unit tests (fast, mocked)
│   ├── integration/           # Integration tests (real SVG files)
│   └── e2e/                   # End-to-end tests (full CLI workflows)
├── samples/                   # Test SVG files
└── docs_dev/                  # Development documentation (gitignored)
```

## Development Workflow

### Running Tests

```bash
# All tests (unit + integration + e2e)
pnpm test

# Watch mode (auto-rerun on file changes)
pnpm test:watch

# Specific test suites
pnpm test:unit          # Unit tests only
pnpm test:integration   # Integration tests only
pnpm test:e2e           # Playwright E2E tests

# Coverage report
pnpm test:coverage

# Interactive UI
pnpm test:ui
```

### Linting and Formatting

```bash
# Check code style
pnpm lint

# Auto-fix issues
pnpm lint:fix

# Format code
pnpm format
```

### Type Checking

```bash
# Run TypeScript type checker (using JSDoc types)
pnpm typecheck
```

### CI Pipeline (Local)

Run the same checks as GitHub Actions:

```bash
pnpm run ci
```

This runs:
1. ESLint + Prettier checks
2. TypeScript type checking
3. Unit + integration tests with coverage
4. Playwright E2E tests

## Architecture Deep Dive

### Core Library: SvgVisualBBox.js

**Purpose:** Browser-side library for computing visual bounding boxes.

**Key Concepts:**
- **Two-pass rasterization** - Coarse pass finds rough bounds, fine pass measures precisely
- **Coordinate system** - All results in root SVG user units (viewBox space)
- **Clipped vs unclipped** - Respect or ignore viewBox boundaries

**Main Functions:**
1. `getSvgElementVisualBBoxTwoPassAggressive(target, options)` - Single element bbox
2. `getSvgElementsUnionVisualBBox(targets[], options)` - Union bbox for multiple elements
3. `getSvgElementVisibleAndFullBBoxes(target, options)` - Both clipped and unclipped
4. `getSvgRootViewBoxExpansionForFullDrawing(svgRootOrId, options)` - ViewBox expansion
5. `waitForDocumentFonts(doc?, timeoutMs?)` - Font loading helper

**How It Works:**
1. Create offscreen canvas
2. Render SVG region to canvas at specified resolution
3. Scan pixels to find non-transparent bounds
4. Convert pixel coordinates back to SVG user units
5. Apply safety margins and return bbox

**Options:**
```javascript
{
  mode: 'clipped',           // or 'unclipped'
  coarseFactor: 3,           // Pass 1 resolution (px/unit)
  fineFactor: 24,            // Pass 2 resolution (px/unit)
  safetyMarginUser: null,    // Auto-calculated if null
  useLayoutScale: true,      // Derive px/unit from layout
  fontTimeoutMs: 8000        // Max font loading wait
}
```

### CLI Tools Architecture

All CLI tools follow a similar pattern:

1. **Parse arguments** - Extract file paths, options, flags
2. **Launch Puppeteer** - Start headless Chrome instance
3. **Load SVG** - Inject SVG into HTML page
4. **Inject library** - Add SvgVisualBBox.js via script tag
5. **Execute in browser** - Run computation via page.evaluate()
6. **Process results** - Format and output results
7. **Cleanup** - Close browser

**Example: sbb-getbbox.cjs flow**
```javascript
async function computeBBox(svgPath, options) {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();

  // Load SVG into page
  await page.setContent(svgHtml);

  // Inject SvgVisualBBox.js
  await page.addScriptTag({ path: 'SvgVisualBBox.js' });

  // Compute bbox in browser context
  const bbox = await page.evaluate(async (opts) => {
    const svg = document.querySelector('svg');
    return await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(svg, opts);
  }, options);

  await browser.close();
  return bbox;
}
```

### Test Architecture

#### Unit Tests (tests/unit/*.test.js)
- **Fast** - Mock Puppeteer, file system, external dependencies
- **Isolated** - Test single functions/modules
- **Coverage** - Aim for >80% coverage

Example:
```javascript
import { describe, test, expect, vi } from 'vitest';

describe('SvgVisualBBox coordinate conversion', () => {
  test('converts pixel coords to SVG user units correctly', () => {
    const result = pixelToUserCoords(120, 80, { scale: 2, viewBox: { x: 0, y: 0 } });
    expect(result).toEqual({ x: 60, y: 40 });
  });
});
```

#### Integration Tests (tests/integration/*.test.js)
- **Real SVG files** - Use actual files from `samples/`
- **Real browser** - Launch actual Puppeteer instance
- **End-to-end flows** - Test complete operations

Example:
```javascript
import { describe, test, expect } from 'vitest';
import { computeVisualBBox } from '../sbb-getbbox.cjs';

describe('Visual bbox computation with real SVG', () => {
  test('computes correct bbox for rotated text', async () => {
    const bbox = await computeVisualBBox('samples/test_text_to_path_advanced.svg');
    expect(bbox.width).toBeGreaterThan(0);
    expect(bbox.height).toBeGreaterThan(0);
  });
});
```

#### E2E Tests (tests/e2e/*.test.js)
- **Playwright** - Test browser interactions
- **Full CLI workflows** - Test actual user scenarios
- **HTML output** - Verify interactive features

Example:
```javascript
import { test, expect } from '@playwright/test';

test('HTML list preview shows correct element count', async ({ page }) => {
  await page.goto('file:///path/to/output.objects.html');
  const rows = await page.locator('tr.object-row').count();
  expect(rows).toBeGreaterThan(0);
});
```

## Common Development Tasks

### Adding a New CLI Tool

1. Create file: `sbb-my-tool.cjs`
2. Add shebang: `#!/usr/bin/env node`
3. Implement help screen with `printHelp()`
4. Add argument parsing with `parseArgs()`
5. Implement main async function
6. Export for testing (if needed)
7. Add to `package.json` bin entries
8. Write tests
9. Update README.md

### Adding a New Option to SvgVisualBBox

1. Update options interface in JSDoc comments
2. Implement option handling in relevant functions
3. Add validation and defaults
4. Update tests to cover new option
5. Document in README.md and CLAUDE.md

### Debugging Tips

#### Visual Debugging
```javascript
// Save intermediate canvas for inspection
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');
// ... render SVG ...
const imgData = canvas.toDataURL('image/png');
console.log(imgData); // Copy to browser to view
```

#### Browser Console Access
```javascript
// In page.evaluate(), use console.log
await page.evaluate(() => {
  console.log('Debug info:', someVariable);
});

// In Node.js, listen to console events
page.on('console', msg => console.log('BROWSER:', msg.text()));
```

#### Test Isolation
```bash
# Run single test file
pnpm test tests/unit/my-test.test.js

# Run tests matching pattern
pnpm test --grep "bbox computation"

# Debug mode (add --inspect-brk to node)
node --inspect-brk node_modules/vitest/vitest.mjs run tests/unit/my-test.test.js
```

## Performance Profiling

### Measuring Bbox Computation Time
```javascript
console.time('bbox-computation');
const bbox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(element);
console.timeEnd('bbox-computation');
```

### Optimizing Resolution
- **Lower coarseFactor** (e.g., 2) - Faster coarse pass, may miss small features
- **Lower fineFactor** (e.g., 12) - Faster fine pass, less precision
- **Trade-off**: Accuracy vs speed

### Profiling Tests
```bash
# Run with Node.js profiler
node --prof node_modules/vitest/vitest.mjs run
node --prof-process isolate-*.log > processed.txt
```

## Release Checklist

Before releasing a new version:

- [ ] All tests passing (`pnpm run ci`)
- [ ] Version bumped in `package.json`
- [ ] CHANGELOG.md updated
- [ ] README.md accurate
- [ ] No uncommitted changes
- [ ] Git tag created (`git tag v1.2.3`)
- [ ] npm publish (maintainers only)
- [ ] GitHub release created

## Troubleshooting

### Puppeteer Launch Fails
```bash
# Install system dependencies (Linux)
sudo apt-get install -y chromium-browser

# Use existing Chrome
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Verify Chrome available
which chromium-browser
which google-chrome
```

### Fonts Not Loading
- Web fonts: Check network requests in page.on('request')
- System fonts: Install locally or use Docker with fonts
- Timeout: Increase `fontTimeoutMs` option

### Canvas Tainting Errors
- Ensure all external resources are same-origin or CORS-enabled
- Local file:// URLs may need special handling
- Use data URLs for embedded images

### Tests Timing Out
- Increase timeout in test: `test('...', async () => { ... }, 30000)`
- Check for infinite loops or hung browser processes
- Verify browser launches successfully

## Resources

- [Puppeteer Documentation](https://pptr.dev/)
- [Playwright Documentation](https://playwright.dev/)
- [Vitest Documentation](https://vitest.dev/)
- [SVG Specification](https://www.w3.org/TR/SVG2/)
- [Canvas API](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API)

## Getting Help

- Open an issue on GitHub
- Check existing discussions
- Review CLAUDE.md for AI assistant guidance
- Ask in PR comments

Happy developing! 🚀
