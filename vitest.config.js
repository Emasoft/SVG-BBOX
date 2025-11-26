import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test environment
    environment: 'node',

    // Global test timeout (30 minutes for browser tests)
    testTimeout: 1800000,

    // Hook timeout
    hookTimeout: 60000,

    // Globals
    globals: true,

    // Coverage configuration
    // NOTE: SvgVisualBBox.js runs in browser context (via Puppeteer) - V8 coverage can't measure it.
    // Coverage is collected from server-side code (CLI tools, security utils, etc.) only.
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
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false
      }
    },

    // Max concurrent tests
    maxConcurrency: 5,

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
