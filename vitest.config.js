import { defineConfig } from 'vitest/config';
import { TEST_TIMEOUT_MS, HOOK_TIMEOUT_MS } from './config/timeouts.js';

// Parallel execution configuration
// Why 10: Puppeteer tests are I/O-bound (waiting for browser), not CPU-bound.
// Higher concurrency (vs default 5) maximizes throughput without CPU saturation.
const MAX_CONCURRENT_TESTS = 10;

export default defineConfig({
  test: {
    // Test environment
    environment: 'node',

    // Global test timeout
    testTimeout: TEST_TIMEOUT_MS,

    // Hook timeout (browser launch + font discovery)
    hookTimeout: HOOK_TIMEOUT_MS,

    // Globals
    globals: true,

    // Coverage configuration
    // Browser-only code (SvgVisualBBox.js) runs via Puppeteer and cannot be measured by V8.
    // Only server-side code (CLI tools, security utils) is covered.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['lib/**/*.cjs', 'sbb-*.cjs'],
      exclude: [
        'tests/**',
        'node_modules/**',
        'coverage/**',
        'test-results/**',
        'playwright-report/**',
        'samples/**',
        'docs_dev/**',
        'scripts_dev/**',
        'libs_dev/**',
        'examples_dev/**',
        '**/*.test.js',
        '**/*.spec.js',
        // Browser-only code - runs in Puppeteer, can't be measured by V8
        'SvgVisualBBox.js',
        'SvgVisualBBox.min.js'
      ]
      // NOTE: Coverage thresholds removed - browser-only code can't be measured by V8.
      // The actual functionality is thoroughly tested via E2E tests using Playwright.
    },

    // Test include patterns
    include: ['tests/**/*.test.js', 'tests/**/*.spec.js'],

    // Test exclude patterns
    // IMPORTANT: E2E tests (tests/e2e/*.spec.js) are excluded because they use Playwright
    // and must be run via `pnpm run test:e2e` (playwright test), not Vitest.
    // Running Playwright tests through Vitest causes "two different versions of @playwright/test" errors.
    exclude: [
      'node_modules/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      '**/node_modules/**',
      '**/.{idea,git,cache,output,temp}/**',
      'tests/e2e/**' // Playwright E2E tests - run separately via test:e2e
    ],

    // Reporter
    reporters: ['verbose'],

    // Disable isolation for faster tests
    isolate: true,

    // Pool options for parallel execution
    // WORKAROUND: Using 'threads' instead of 'forks' to avoid Vitest 4.0.14 worker fork crash bug
    // See: https://github.com/vitest-dev/vitest/issues/...
    pool: 'threads',

    // Max concurrent tests
    maxConcurrency: MAX_CONCURRENT_TESTS,

    // Retry failed tests once
    retry: 1,

    // Bail on first failure in CI
    bail: process.env.CI ? 1 : 0,

    // Sequence
    sequence: {
      shuffle: false
    }
  }
});
