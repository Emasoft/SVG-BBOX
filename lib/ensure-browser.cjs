#!/usr/bin/env node
/**
 * Ensures Chromium browser is available for puppeteer
 * Downloads automatically on first use if not present
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Check if Chromium is already downloaded
 * @returns {boolean} True if browser is available
 */
function isBrowserInstalled() {
  try {
    // Try to get the browser path from puppeteer
    const puppeteer = require('puppeteer');
    const browserPath = puppeteer.executablePath();
    return fs.existsSync(browserPath);
  } catch {
    return false;
  }
}

/**
 * Download Chromium browser for puppeteer
 * Shows progress to user
 */
function downloadBrowser() {
  const isCI = process.env.CI === 'true' || process.env.CI === '1';

  if (!isCI) {
    console.log('\x1b[36m[svg-bbox]\x1b[0m Downloading Chromium browser (first-time setup)...');
    console.log('\x1b[2mThis only happens once and takes about 1-2 minutes.\x1b[0m\n');
  }

  try {
    // Use puppeteer's built-in browser installer
    const puppeteerPath = require.resolve('puppeteer');
    const puppeteerDir = path.dirname(puppeteerPath);
    const installScript = path.join(puppeteerDir, 'install.mjs');

    // Check if install script exists (puppeteer v19+)
    if (fs.existsSync(installScript)) {
      execSync(`node "${installScript}"`, {
        stdio: isCI ? 'ignore' : 'inherit',
        env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: '' }
      });
    } else {
      // Fallback for older puppeteer versions
      const { install } = require('puppeteer/lib/cjs/puppeteer/node/install.js');
      install();
    }

    if (!isCI) {
      console.log('\n\x1b[32m[svg-bbox]\x1b[0m Chromium installed successfully!\n');
    }
    return true;
  } catch (error) {
    console.error('\x1b[31m[svg-bbox]\x1b[0m Failed to download Chromium:', error.message);
    console.error('\x1b[33mTry running:\x1b[0m npx puppeteer browsers install chrome');
    return false;
  }
}

/**
 * Ensure browser is available, download if needed
 * @returns {Promise<boolean>} True if browser is ready
 */
async function ensureBrowser() {
  if (isBrowserInstalled()) {
    return true;
  }
  return downloadBrowser();
}

/**
 * Synchronous version for CLI startup
 * @returns {boolean} True if browser is ready
 */
function ensureBrowserSync() {
  if (isBrowserInstalled()) {
    return true;
  }
  return downloadBrowser();
}

module.exports = {
  ensureBrowser,
  ensureBrowserSync,
  isBrowserInstalled,
  downloadBrowser
};
