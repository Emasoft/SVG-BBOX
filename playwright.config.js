import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for E2E testing of HTML interactive features
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './tests/e2e',

  // Maximum time one test can run for
  timeout: 120 * 1000,

  // Test execution settings
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,

  // Reporter to use
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['list']
  ],

  // Shared settings for all projects
  use: {
    // Base URL for navigating in tests
    baseURL: 'file://' + process.cwd(),

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

    // Timeout for each action (e.g., click, fill)
    actionTimeout: 10 * 1000
  },

  // Configure projects for major browsers
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }

    // Uncomment to test on Firefox and WebKit
    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] }
    // },
    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] }
    // }
  ]

  // Run local dev server before starting tests (if needed)
  // webServer: {
  //   command: 'npm run start',
  //   url: 'http://localhost:3000',
  //   reuseExistingServer: !process.env.CI
  // }
});
