/**
 * Playwright configuration for E2E testing of HTML interactive features
 * Compatible with Playwright 1.x in ESM mode
 * @type {import('@playwright/test').PlaywrightTestConfig}
 */
import { PLAYWRIGHT_TEST_TIMEOUT_MS, PLAYWRIGHT_ACTION_TIMEOUT_MS } from './config/timeouts.js';

export default {
  testDir: './tests/e2e',

  // Maximum time one test can run for (imported from centralized config)
  timeout: PLAYWRIGHT_TEST_TIMEOUT_MS,

  // Test execution settings
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,

  // Reporter to use
  reporter: [['html', { outputFolder: 'playwright-report', open: 'never' }], ['list']],

  // Shared settings for all projects
  use: {
    // Collect trace when retrying the failed test
    trace: 'on-first-retry',

    // Screenshots
    screenshot: 'only-on-failure',

    // Video
    video: 'retain-on-failure',

    // Viewport
    viewport: { width: 1280, height: 720 },

    // Ignore HTTPS errors for local testing
    ignoreHTTPSErrors: true,

    // Timeout for each action (e.g., click, fill) - imported from centralized config
    actionTimeout: PLAYWRIGHT_ACTION_TIMEOUT_MS
  },

  // Configure projects for major browsers
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        channel: 'chrome'
      }
    }
  ]
};
