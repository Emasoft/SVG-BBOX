# SVG Visual BBox Toolkit - Testing Guide

This directory contains comprehensive tests for the SVG Visual BBox Toolkit.

## Quick Start

```bash
# Install dependencies
pnpm install

# Install browser binaries
pnpm run install-browsers
# or: just install-browsers

# Run all tests
pnpm test
# or: just test

# Run with coverage
pnpm run test:coverage
# or: just test-coverage

# Run in watch mode (for development)
pnpm run test:watch
# or: just test-watch
```

## Test Structure

```
tests/
├── fixtures/          # SVG test files
│   ├── simple/        # Basic shapes (rect, circle, path, group)
│   ├── text/          # Text with CJK, Arabic, ligatures, textPath, tspan
│   ├── filters/       # Blur, drop-shadow, complex filter chains
│   ├── stroke/        # Thick strokes, markers, non-scaling stroke
│   ├── broken/        # Missing viewBox, invalid IDs, empty SVGs
│   ├── use-defs/      # <use>, <symbol>, gradients, patterns
│   └── transforms/    # Rotation, scaling, nested groups
├── unit/              # Unit tests for core library functions
├── integration/       # Integration tests for CLI tools
├── e2e/               # End-to-end tests with Playwright
└── helpers/           # Test utilities and browser helpers
```

## Test Categories

### Unit Tests (Vitest + Puppeteer)

Test core library functions in real browser context:

- **rasterization.test.js** - Canvas tainting, ROI handling, pixel scanning
- **two-pass-aggressive.test.js** - Two-pass algorithm accuracy
- **union-bbox.test.js** - Multiple element unions
- **visible-and-full.test.js** - Clipped vs unclipped modes
- **viewbox-expansion.test.js** - ViewBox padding calculations

Run: `just test-unit` or `pnpm run test:unit`

### Integration Tests (Vitest + Puppeteer)

Test CLI tools with real SVG files:

- **test-svg-bbox.test.js** - Test harness CLI
- **export-objects-list.test.js** - LIST mode (HTML generation, auto-IDs)
- **export-objects-rename.test.js** - RENAME mode (ID updates, reference
  updates)
- **export-objects-extract.test.js** - EXTRACT mode (cut-outs, context)
- **export-objects-export-all.test.js** - EXPORT-ALL mode (bulk export, groups)
- **fix-viewbox.test.js** - ViewBox repair
- **render-svg.test.js** - PNG rendering (modes, backgrounds, scaling)

Run: `just test-integration` or `pnpm run test:integration`

### E2E Tests (Playwright)

Test interactive HTML features:

- **html-rename-ui.test.js** - Filters, validation, JSON export
- **full-workflow.test.js** - Complete renaming workflow

Run: `just test-e2e` or `pnpm run test:e2e`

## Test Fixtures

### Creating New Fixtures

1. Create SVG file in appropriate subdirectory under `tests/fixtures/`
2. Ensure SVG has proper structure:
   - Valid XML header: `<?xml version="1.0" encoding="UTF-8"?>`
   - xmlns attribute: `xmlns="http://www.w3.org/2000/svg"`
   - viewBox and dimensions (unless testing broken SVGs)
   - Elements with IDs for easy reference

Example:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <rect id="test-element" x="50" y="50" width="100" height="80" fill="#3498db" />
</svg>
```

### Current Fixtures (25+ files)

- **Simple:** rect, circle, path, group
- **Text:** CJK, Arabic RTL, ligatures, textPath, nested tspan, text-anchor
- **Filters:** blur-10px, drop-shadow, filter-chain
- **Stroke:** thick-stroke, markers, non-scaling
- **Broken:** no-viewbox, no-dimensions, empty, invalid-ids, duplicate-ids
- **Use/Defs:** use-symbol, gradients
- **Transforms:** rotation, nested-groups

## Browser Test Helpers

Located in `tests/helpers/browser-test.js`:

```javascript
import {
  createPageWithSvg,
  getBBoxById,
  closeBrowser,
  assertValidBBox
} from '../helpers/browser-test.js';

// Load SVG and create page
const page = await createPageWithSvg('simple/rect.svg');

// Get bbox for an element
const bbox = await getBBoxById(page, 'test-rect');

// Assert bbox is valid
assertValidBBox(bbox, { minWidth: 50, minHeight: 30 });

// Clean up
await page.close();
await closeBrowser(); // In afterAll hook
```

## Debugging Tests

### Vitest UI

Interactive test runner with GUI:

```bash
just test-ui
# or: pnpm run test:ui
```

Opens browser at `http://localhost:51204/__vitest__/`

### Node Inspector

Debug specific test file:

```bash
just test-debug tests/unit/two-pass-aggressive.test.js
```

Then open `chrome://inspect` in Chrome.

### Playwright Debug Mode

```bash
PWDEBUG=1 pnpm run test:e2e
```

Opens Playwright Inspector for step-by-step debugging.

### Screenshots and Videos

Playwright automatically captures:

- Screenshots on test failure
- Videos when tests fail (if configured)

Find them in:

- `test-results/` - Screenshots
- `playwright-report/` - HTML report with videos

## Coverage

Generate coverage report:

```bash
just test-coverage
# or: pnpm run test:coverage
```

Open in browser:

```bash
just coverage-report
```

Coverage thresholds (in `vitest.config.js`):

- Statements: 80%
- Branches: 70%
- Functions: 80%
- Lines: 80%

## CI/CD

Tests run automatically on:

- Push to main/develop branches
- Pull requests

See `.github/workflows/test.yml` for configuration.

### Platforms Tested

- **Linux (Ubuntu)** - Primary platform, all Node versions (18, 20, 22)
- **macOS** - Cross-platform compatibility
- **Windows** - Path handling, line endings

## Common Issues

### Browser Launch Fails

Install Chrome/Chromium:

```bash
# Install Puppeteer's Chromium
npx puppeteer browsers install chrome

# Install Playwright browsers
npx playwright install --with-deps chromium
```

### Font Loading Timeouts

Increase `fontTimeoutMs` in test options:

```javascript
await getBBoxById(page, 'cjk-text', { fontTimeoutMs: 10000 });
```

### Canvas Tainting Errors

Check if SVG references external resources without CORS headers. Tests should
use local fixtures to avoid this.

### Tests Hang

Check for:

- Unclosed browser pages: Always `await page.close()`
- Missing `await` keywords
- Infinite loops in evaluated code

## Best Practices

### Do's

✅ Use real SVG fixtures (no mocks) ✅ Test in real browser context
(Puppeteer/Playwright) ✅ Close pages and browsers properly ✅ Use descriptive
test names ✅ Group related tests with `describe` blocks ✅ Add comments
explaining complex assertions ✅ Test edge cases and error conditions

### Don'ts

❌ Don't mock the browser or DOM ❌ Don't skip cleanup (`afterAll`,
`page.close()`) ❌ Don't use hard-coded paths (use helpers) ❌ Don't test
implementation details ❌ Don't create flaky tests (use proper waits) ❌ Don't
commit failing tests

## Writing New Tests

### Unit Test Template

```javascript
import { describe, it, expect, afterAll } from 'vitest';
import {
  createPageWithSvg,
  getBBoxById,
  closeBrowser
} from '../helpers/browser-test.js';

describe('My Feature', () => {
  afterAll(async () => {
    await closeBrowser();
  });

  it('should do something', async () => {
    const page = await createPageWithSvg('simple/rect.svg');
    const bbox = await getBBoxById(page, 'test-rect');

    expect(bbox).toBeTruthy();
    expect(bbox.width).toBeGreaterThan(0);

    await page.close();
  });
});
```

### Integration Test Template

```javascript
import { describe, it, expect } from 'vitest';
import { runCLI } from '../helpers/browser-test.js';
import fs from 'fs';

describe('My CLI Tool', () => {
  it('should process SVG correctly', async () => {
    const { stdout, stderr, exitCode } = await runCLI('my-tool.js', [
      'input.svg'
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');

    // Check output files
    const output = fs.readFileSync('output.svg', 'utf8');
    expect(output).toContain('expected content');
  });
});
```

## Performance

- **Parallel execution:** Tests run in parallel (configurable in
  `vitest.config.js`)
- **Browser reuse:** Shared browser instance across tests
- **Fixture caching:** SVG files loaded once
- **Timeout:** 30 minutes per test (browser operations can be slow)

## Contributing

Before submitting PR:

1. Run full test suite: `just ci`
2. Ensure all tests pass locally
3. Check coverage meets thresholds
4. Add tests for new features
5. Update fixtures if needed

## Support

- **Vitest docs:** https://vitest.dev
- **Playwright docs:** https://playwright.dev
- **Puppeteer docs:** https://pptr.dev
- **Project issues:** Create GitHub issue with failing test
