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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      include: ['SvgVisualBBox.js', '*-svg-*.js', 'export-svg-objects.js'],
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
        '**/*.spec.js'
      ],
      // Coverage thresholds
      statements: 80,
      branches: 70,
      functions: 80,
      lines: 80
    },

    // Test include patterns
    include: ['tests/**/*.test.js', 'tests/**/*.spec.js'],

    // Test exclude patterns
    exclude: [
      'node_modules/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      '**/node_modules/**',
      '**/.{idea,git,cache,output,temp}/**'
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
