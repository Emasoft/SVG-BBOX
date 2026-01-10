#!/usr/bin/env node
/**
 * Ensures Chrome or Chromium browser is available for puppeteer
 * Downloads automatically on first use if not present
 *
 * BROWSER SUPPORT:
 * - Chrome (preferred)
 * - Chromium (for Linux distros that only have Chromium)
 * - Other browsers are NOT supported
 *
 * DETECTION ORDER:
 * 1. Puppeteer's bundled Chrome (if downloaded)
 * 2. System-installed Chrome
 * 3. System-installed Chromium
 * 4. If none found, download puppeteer's Chrome
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ============================================================================
// Browser Detection Paths
// ============================================================================

/**
 * Common Chrome executable paths by platform
 * SUPPORTED PLATFORMS: darwin, linux, win32, openbsd, freebsd
 * @type {Record<string, string[]>}
 */
const CHROME_PATHS = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    process.env.HOME + '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chrome',
    '/opt/google/chrome/chrome',
    '/opt/google/chrome/google-chrome'
  ],
  win32: [
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe'
  ],
  // OpenBSD - packages installed to /usr/local
  openbsd: ['/usr/local/bin/chrome', '/usr/local/bin/google-chrome'],
  // FreeBSD - similar to OpenBSD
  freebsd: ['/usr/local/bin/chrome', '/usr/local/bin/google-chrome']
};

/**
 * Common Chromium executable paths by platform
 * WHY: Many Linux distros (Debian, Ubuntu) ship Chromium instead of Chrome
 * SUPPORTED PLATFORMS: darwin, linux, win32, openbsd, freebsd
 * @type {Record<string, string[]>}
 */
const CHROMIUM_PATHS = {
  darwin: [
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    process.env.HOME + '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ],
  linux: [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/lib/chromium/chromium',
    '/usr/lib/chromium-browser/chromium-browser'
  ],
  win32: [
    process.env.LOCALAPPDATA + '\\Chromium\\Application\\chrome.exe',
    process.env.PROGRAMFILES + '\\Chromium\\Application\\chrome.exe'
  ],
  // OpenBSD - Chromium is common as it's in ports
  openbsd: ['/usr/local/bin/chromium', '/usr/local/bin/chromium-browser'],
  // FreeBSD - Chromium is common as it's in ports/packages
  freebsd: ['/usr/local/bin/chromium', '/usr/local/bin/chromium-browser']
};

// ============================================================================
// Browser Detection
// ============================================================================

/**
 * Find an executable in the given paths
 * @param {string[]} paths - Array of paths to check
 * @returns {string|null} - Path to executable or null if not found
 */
function findExecutable(paths) {
  for (const execPath of paths) {
    if (execPath && fs.existsSync(execPath)) {
      return execPath;
    }
  }
  return null;
}

/**
 * Check if puppeteer's bundled browser is installed
 * @returns {string|null} - Path to puppeteer's browser or null
 */
function getPuppeteerBrowserPath() {
  try {
    const puppeteer = require('puppeteer');
    const browserPath = puppeteer.executablePath();
    if (fs.existsSync(browserPath)) {
      return browserPath;
    }
  } catch {
    // Puppeteer browser not downloaded yet
  }
  return null;
}

/**
 * Find system-installed Chrome
 * @returns {string|null} - Path to Chrome or null
 */
function findSystemChrome() {
  const platform = process.platform;
  const paths = CHROME_PATHS[platform] || [];
  return findExecutable(paths);
}

/**
 * Find system-installed Chromium
 * WHY: Linux distros like Debian/Ubuntu often only have Chromium
 * @returns {string|null} - Path to Chromium or null
 */
function findSystemChromium() {
  const platform = process.platform;
  const paths = CHROMIUM_PATHS[platform] || [];
  return findExecutable(paths);
}

/**
 * Find any available Chrome/Chromium browser
 * PRIORITY ORDER:
 * 1. Puppeteer's bundled Chrome (for consistency)
 * 2. System Chrome (faster startup, no download)
 * 3. System Chromium (common on Linux)
 *
 * @returns {{path: string, source: string}|null} - Browser info or null
 */
function findBrowser() {
  // 1. Check puppeteer's bundled browser first (most reliable for svg-bbox)
  const puppeteerPath = getPuppeteerBrowserPath();
  if (puppeteerPath) {
    return { path: puppeteerPath, source: 'puppeteer' };
  }

  // 2. Check for system Chrome
  const chromePath = findSystemChrome();
  if (chromePath) {
    return { path: chromePath, source: 'system-chrome' };
  }

  // 3. Check for system Chromium (common on Linux distros)
  const chromiumPath = findSystemChromium();
  if (chromiumPath) {
    return { path: chromiumPath, source: 'system-chromium' };
  }

  return null;
}

/**
 * Check if any supported browser is installed
 * @returns {boolean} True if Chrome or Chromium is available
 */
function isBrowserInstalled() {
  return findBrowser() !== null;
}

/**
 * Get the path to the browser executable
 * @returns {string|null} - Path to browser or null if not installed
 */
function getBrowserPath() {
  const browser = findBrowser();
  return browser ? browser.path : null;
}

// ============================================================================
// Browser Download
// ============================================================================

/**
 * Download Chrome browser for puppeteer
 * Shows progress to user (unless in CI)
 * @returns {boolean} True if download succeeded
 */
function downloadBrowser() {
  const isCI = process.env.CI === 'true' || process.env.CI === '1';

  if (!isCI) {
    console.log('\x1b[36m[svg-bbox]\x1b[0m Downloading Chrome browser (first-time setup)...');
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
      // Fallback: use npx to install browser
      execSync('npx puppeteer browsers install chrome', {
        stdio: isCI ? 'ignore' : 'inherit'
      });
    }

    if (!isCI) {
      console.log('\n\x1b[32m[svg-bbox]\x1b[0m Chrome installed successfully!\n');
    }
    return true;
  } catch (err) {
    const error = /** @type {Error} */ (err);
    console.error('\x1b[31m[svg-bbox]\x1b[0m Failed to download Chrome:', error.message);
    console.error('\x1b[33mTry running:\x1b[0m npx puppeteer browsers install chrome');
    console.error('\x1b[33mOr install Chromium:\x1b[0m sudo apt install chromium-browser');
    return false;
  }
}

// ============================================================================
// Main Functions
// ============================================================================

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
  // Main functions
  ensureBrowser,
  ensureBrowserSync,

  // Detection functions
  isBrowserInstalled,
  getBrowserPath,
  findBrowser,
  findSystemChrome,
  findSystemChromium,
  getPuppeteerBrowserPath,

  // Download function
  downloadBrowser,

  // Path constants (for testing)
  CHROME_PATHS,
  CHROMIUM_PATHS
};
