#!/usr/bin/env node
/**
 * Browser Launch Verification Script
 *
 * WHY: This script is used by CI to verify that Chrome/Chromium can actually
 * launch and load content on all platforms (Ubuntu, macOS, Windows).
 * Having this as a separate file avoids shell escaping issues with backticks
 * in template literals when using inline node -e commands in GitHub Actions.
 */

'use strict';

const {
  launchSecureBrowser,
  closeBrowserSafely,
  createPageWithTimeout
} = require('../lib/puppeteer-utils.cjs');

// WHY: Simple SVG content to verify the browser can render SVG
// Using a variable avoids any shell escaping issues with template literals
const testSvgContent = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>';

async function main() {
  console.log('=== Browser Launch Verification ===');

  console.log('Launching browser...');
  const browser = await launchSecureBrowser();
  console.log('✓ Browser launched successfully');

  const page = await createPageWithTimeout(browser);
  console.log('✓ Page created');

  // WHY: Load SVG content to verify browser can handle SVG rendering
  await page.setContent(testSvgContent);
  console.log('✓ SVG content loaded');

  // WHY: Access page properties to verify full browser functionality
  const title = await page.title();
  console.log('✓ Page accessible (title:', title || 'empty', ')');

  await closeBrowserSafely(browser);
  console.log('✓ Browser closed successfully');

  console.log('');
  console.log('✓ Browser launch verification passed');
}

// WHY: Handle errors gracefully and exit with non-zero code on failure
main().catch((err) => {
  console.error('ERROR: Browser launch verification failed');
  console.error(err.message);
  process.exit(1);
});
