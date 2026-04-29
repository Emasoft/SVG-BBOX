import { defineConfig } from 'vitest/config';
import { TEST_TIMEOUT_MS, HOOK_TIMEOUT_MS } from './config/timeouts.js';

// Parallel execution configuration
// Why 5 (was 10): Puppeteer tests share a browser pool. With CI capping
// SVG_BBOX_MAX_BROWSERS at 2, raising vitest concurrency above the pool
// size queues tests behind browser allocation. Locally without that cap
// the OS happily spawns more Chromium instances, but each one fights
// for shared GPU + font + memory resources, causing the
// "should handle SVG with text elements" / "should handle threshold
// correctly" tests to time out under load (60-120s test timeouts hit
// even after retry: 2). Five is a headroom-friendly value that still
// runs the suite at near-peak throughput on modern hardware.
const MAX_CONCURRENT_TESTS = 5;

// Generate timestamped log filename for test output
// Format: tests/logs/vitest-YYYY-MM-DD-HH-MM-SS.log
const getLogFilename = () => {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `tests/logs/vitest-${timestamp}.log`;
};

export default defineConfig({
  test: {
    // Test environment
    environment: 'node',

    // Global test timeout
    testTimeout: TEST_TIMEOUT_MS,

    // Hook timeout (browser launch + font discovery)
    hookTimeout: HOOK_TIMEOUT_MS,

    // Teardown timeout - maximum time for afterAll/afterEach hooks
    // If teardown takes longer, vitest will force terminate
    // This prevents infinite hangs when browser.close() gets stuck
    teardownTimeout: 30000, // 30 seconds max for cleanup

    // Note: Shutdown timeout is handled by globalTeardown with a 5-second force exit timer
    // See tests/helpers/global-teardown.js

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

    // Reporter configuration
    // - 'verbose' for console output (always)
    // - 'json' writes a structured log file for offline analysis. WHY in CI:
    //   the verbose reporter's interleaved parallel output frequently gets
    //   truncated mid-stream by the GitHub Actions log captor, leaving no
    //   "Test Files X failed" summary anywhere — making failures
    //   undebuggable. The JSON log is a deterministic, complete record.
    reporters: ['verbose', 'json'],

    // Output file for JSON reporter (timestamped log file).
    // In CI we still produce this file; it's tiny vs the verbose stream
    // and is the source of truth when the captured stdout is incomplete.
    outputFile: getLogFilename(),

    // Disable isolation for faster tests
    isolate: true,

    // Pool options for parallel execution
    // WORKAROUND: Using 'threads' instead of 'forks' to avoid Vitest 4.0.14 worker fork crash bug
    // See: https://github.com/vitest-dev/vitest/issues/...
    pool: 'threads',

    // Max concurrent tests
    maxConcurrency: MAX_CONCURRENT_TESTS,

    // Retry failed tests — 2 retries (3 total attempts) everywhere.
    // WHY: A handful of integration tests depend on Puppeteer browser-pool
    //   timing and on system font availability for CJK / Arabic / web-font
    //   fallback rendering. They pass deterministically when re-run alone
    //   but flake under load — both in CI's RAM-constrained parallel slice
    //   (SVG_BBOX_MAX_BROWSERS=2) AND in local full-suite runs (the release
    //   script's pre-publish phase, which exercises ~640 tests at once
    //   when package.json or another global file changes).
    //   v1.2.1 release attempt 1 hit exactly this: 7 flaky tests blocked
    //   the publish even though the FBF code under change was 100% green.
    //   2 retries is the standard mitigation; broken tests still fail
    //   loudly across all attempts. The slowdown on green runs is
    //   essentially zero (retries only fire on failure).
    retry: 2,

    // WHY bail: 0 always: Previously used bail: 1 in CI to fail fast, but this caused
    // only the first failure to be visible in CI logs. With bail: 0, all tests run
    // and we see ALL failures, making debugging much easier.
    // The trade-off (slightly longer CI time on failure) is worth the debugging clarity.
    bail: 0,

    // Sequence
    sequence: {
      shuffle: false
    },

    // Global setup/teardown for browser cleanup
    // globalTeardown ensures all browser processes are killed even if tests crash
    globalSetup: undefined,
    // @ts-ignore - globalTeardown is a valid Vitest option but types may be incomplete
    globalTeardown: './tests/helpers/global-teardown.js',

    // Detect and report open handles that prevent exit
    // This helps debug hanging tests
    // Note: dangerouslyIgnoreUnhandledErrors not recommended for production
    // but we have proper cleanup in globalTeardown
    passWithNoTests: true
  }
});
