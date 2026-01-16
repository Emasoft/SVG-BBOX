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
 * 4. If none found, download puppeteer's Chrome (unless disabled)
 *
 * ENVIRONMENT VARIABLES:
 * - SVG_BBOX_SKIP_BROWSER_DOWNLOAD=1  - Skip automatic Chrome download
 * - SVG_BBOX_BROWSER_PATH=/path/to/chrome - Use specific browser executable
 * - PUPPETEER_EXECUTABLE_PATH=/path/to/chrome - Puppeteer's native override
 *
 * @module ensure-browser
 */

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ============================================================================
// Configuration
// ============================================================================

/**
 * Maximum retries for browser download
 * @type {number}
 */
const MAX_DOWNLOAD_RETRIES = 3;

/**
 * Delay between retries in milliseconds
 * @type {number}
 */
const RETRY_DELAY_MS = 2000;

/**
 * Check if browser auto-download is disabled
 * @returns {boolean} True if download should be skipped
 */
function isDownloadDisabled() {
  return (
    process.env.SVG_BBOX_SKIP_BROWSER_DOWNLOAD === '1' ||
    process.env.SVG_BBOX_SKIP_BROWSER_DOWNLOAD === 'true'
  );
}

/**
 * Get user-specified browser path from environment
 * @returns {string|null} Path to browser or null
 */
function getUserSpecifiedBrowserPath() {
  // Check svg-bbox specific env var first
  const svgBboxPath = process.env.SVG_BBOX_BROWSER_PATH;
  if (svgBboxPath) {
    return svgBboxPath;
  }

  // Check puppeteer's native env var
  const puppeteerPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (puppeteerPath) {
    return puppeteerPath;
  }

  return null;
}

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
    // Cross-platform: Use path.join() for user home directory paths
    ...(process.env.HOME
      ? [path.join(process.env.HOME, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')]
      : [])
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chrome',
    '/opt/google/chrome/chrome',
    '/opt/google/chrome/google-chrome'
  ],
  win32: [
    // Windows paths must use backslashes - use string concatenation to preserve them
    // Provide fallback paths when env vars aren't set (e.g., running tests on non-Windows)
    (process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local') +
      '\\Google\\Chrome\\Application\\chrome.exe',
    (process.env.PROGRAMFILES || 'C:\\Program Files') + '\\Google\\Chrome\\Application\\chrome.exe',
    (process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)') +
      '\\Google\\Chrome\\Application\\chrome.exe'
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
    // Cross-platform: Use path.join() for user home directory paths
    ...(process.env.HOME
      ? [path.join(process.env.HOME, 'Applications/Chromium.app/Contents/MacOS/Chromium')]
      : [])
  ],
  linux: [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/lib/chromium/chromium',
    '/usr/lib/chromium-browser/chromium-browser'
  ],
  win32: [
    // Windows paths must use backslashes - use string concatenation to preserve them
    // Provide fallback paths when env vars aren't set (e.g., running tests on non-Windows)
    (process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local') +
      '\\Chromium\\Application\\chrome.exe',
    (process.env.PROGRAMFILES || 'C:\\Program Files') + '\\Chromium\\Application\\chrome.exe'
  ],
  // OpenBSD - Chromium is common as it's in ports
  openbsd: ['/usr/local/bin/chromium', '/usr/local/bin/chromium-browser'],
  // FreeBSD - Chromium is common as it's in ports/packages
  freebsd: ['/usr/local/bin/chromium', '/usr/local/bin/chromium-browser']
};

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Resolve symlinks and verify executable exists
 * @param {string} execPath - Path to check
 * @returns {string|null} - Resolved real path or null if invalid
 */
function resolveExecutablePath(execPath) {
  if (!execPath) return null;

  try {
    // Check if path exists
    if (!fs.existsSync(execPath)) {
      return null;
    }

    // Resolve symlinks to get real path
    const realPath = fs.realpathSync(execPath);

    // Verify the resolved path exists and is a file
    const stats = fs.statSync(realPath);
    if (!stats.isFile()) {
      return null;
    }

    // On Unix, check if executable
    if (process.platform !== 'win32') {
      try {
        fs.accessSync(realPath, fs.constants.X_OK);
      } catch {
        // Not executable
        return null;
      }
    }

    return realPath;
  } catch {
    // Path resolution failed (broken symlink, permission issues, etc.)
    return null;
  }
}

/**
 * Find an executable in the given paths, resolving symlinks
 * @param {string[]} paths - Array of paths to check
 * @returns {string|null} - Path to executable or null if not found
 */
function findExecutable(paths) {
  for (const execPath of paths) {
    const resolved = resolveExecutablePath(execPath);
    if (resolved) {
      return execPath; // Return original path (may be symlink)
    }
  }
  return null;
}

/**
 * Validate that a browser path is usable
 * @param {string} browserPath - Path to validate
 * @returns {{valid: boolean, error?: string}} - Validation result
 */
function validateBrowserPath(browserPath) {
  if (!browserPath) {
    return { valid: false, error: 'Browser path is empty' };
  }

  if (!fs.existsSync(browserPath)) {
    return { valid: false, error: `Browser not found at: ${browserPath}` };
  }

  try {
    const realPath = fs.realpathSync(browserPath);
    const stats = fs.statSync(realPath);

    if (!stats.isFile()) {
      return { valid: false, error: `Not a file: ${browserPath}` };
    }

    // On Unix, check executable permission
    if (process.platform !== 'win32') {
      fs.accessSync(realPath, fs.constants.X_OK);
    }

    return { valid: true };
  } catch (err) {
    const error = /** @type {Error} */ (err);
    return { valid: false, error: `Invalid browser path: ${error.message}` };
  }
}

// ============================================================================
// Browser Detection
// ============================================================================

/**
 * Check if puppeteer's bundled browser is installed
 * @returns {string|null} - Path to puppeteer's browser or null
 */
function getPuppeteerBrowserPath() {
  try {
    const puppeteer = require('puppeteer');
    const browserPath = puppeteer.executablePath();
    if (resolveExecutablePath(browserPath)) {
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
 * 1. User-specified path (SVG_BBOX_BROWSER_PATH or PUPPETEER_EXECUTABLE_PATH)
 * 2. Puppeteer's bundled Chrome (for consistency)
 * 3. System Chrome (faster startup, no download)
 * 4. System Chromium (common on Linux)
 *
 * @returns {{path: string, source: string}|null} - Browser info or null
 */
function findBrowser() {
  // 0. Check user-specified path first
  const userPath = getUserSpecifiedBrowserPath();
  if (userPath) {
    const validation = validateBrowserPath(userPath);
    if (validation.valid) {
      return { path: userPath, source: 'user-specified' };
    }
    // User specified invalid path - warn but continue
    console.warn(`\x1b[33m[svg-bbox]\x1b[0m Warning: ${validation.error}`);
  }

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
 * Sleep for a specified duration
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if we appear to be offline
 * @returns {boolean} True if offline
 */
function isOffline() {
  try {
    // Try to resolve a common domain
    execSync("node -e \"require('dns').resolve('registry.npmjs.org', () => {})\"", {
      stdio: 'ignore',
      timeout: 5000
    });
    return false;
  } catch {
    return true;
  }
}

/**
 * Download Chrome browser for puppeteer with retry logic
 * Shows progress to user (unless in CI)
 * @param {number} [retryCount=0] - Current retry count
 * @returns {boolean} True if download succeeded
 */
function downloadBrowser(retryCount = 0) {
  // Check if download is disabled
  if (isDownloadDisabled()) {
    console.log(
      '\x1b[33m[svg-bbox]\x1b[0m Browser auto-download disabled (SVG_BBOX_SKIP_BROWSER_DOWNLOAD=1)'
    );
    console.log('\x1b[33m[svg-bbox]\x1b[0m Please install Chrome/Chromium manually or run:');
    console.log('  npx puppeteer browsers install chrome');
    return false;
  }

  const isCI = process.env.CI === 'true' || process.env.CI === '1';

  // Check for offline status
  if (isOffline()) {
    console.error('\x1b[31m[svg-bbox]\x1b[0m Network appears to be offline.');
    console.error(
      '\x1b[33m[svg-bbox]\x1b[0m Please check your internet connection or install Chrome manually.'
    );
    return false;
  }

  if (!isCI && retryCount === 0) {
    console.log('\x1b[36m[svg-bbox]\x1b[0m Downloading Chrome browser (first-time setup)...');
    console.log('\x1b[2mThis only happens once and takes about 1-2 minutes.\x1b[0m\n');
  } else if (!isCI && retryCount > 0) {
    console.log(`\x1b[33m[svg-bbox]\x1b[0m Retry ${retryCount}/${MAX_DOWNLOAD_RETRIES}...`);
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
        env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: '' },
        timeout: 300000 // 5 minute timeout
      });
    } else {
      // Fallback: use npx to install browser
      execSync('npx puppeteer browsers install chrome', {
        stdio: isCI ? 'ignore' : 'inherit',
        timeout: 300000 // 5 minute timeout
      });
    }

    if (!isCI) {
      console.log('\n\x1b[32m[svg-bbox]\x1b[0m Chrome installed successfully!\n');
    }
    return true;
  } catch (err) {
    const error = /** @type {Error} */ (err);

    // Retry on failure
    if (retryCount < MAX_DOWNLOAD_RETRIES) {
      if (!isCI) {
        console.warn(`\x1b[33m[svg-bbox]\x1b[0m Download failed: ${error.message}`);
        console.warn(`\x1b[33m[svg-bbox]\x1b[0m Retrying in ${RETRY_DELAY_MS / 1000}s...`);
      }

      // Synchronous delay for retry
      execSync(`node -e "setTimeout(() => {}, ${RETRY_DELAY_MS})"`, { stdio: 'ignore' });

      return downloadBrowser(retryCount + 1);
    }

    console.error('\x1b[31m[svg-bbox]\x1b[0m Failed to download Chrome:', error.message);
    console.error('\x1b[33m[svg-bbox]\x1b[0m Manual installation options:');
    console.error('  npx puppeteer browsers install chrome');
    console.error('  sudo apt install chromium-browser  # Debian/Ubuntu');
    console.error('  brew install --cask chromium       # macOS');
    console.error('  pkg install chromium               # FreeBSD');
    console.error('');
    console.error(
      '\x1b[33m[svg-bbox]\x1b[0m Or set SVG_BBOX_BROWSER_PATH to your browser executable.'
    );
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

/**
 * Get browser status information
 * @returns {{installed: boolean, path: string|null, source: string|null, downloadDisabled: boolean}}
 */
function getBrowserStatus() {
  const browser = findBrowser();
  return {
    installed: browser !== null,
    path: browser?.path || null,
    source: browser?.source || null,
    downloadDisabled: isDownloadDisabled()
  };
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

  // Validation functions
  validateBrowserPath,
  resolveExecutablePath,

  // Status functions
  getBrowserStatus,
  isDownloadDisabled,
  getUserSpecifiedBrowserPath,

  // Download function
  downloadBrowser,

  // Utility functions
  isOffline,

  // Path constants (for testing)
  CHROME_PATHS,
  CHROMIUM_PATHS,

  // Configuration constants
  MAX_DOWNLOAD_RETRIES,
  RETRY_DELAY_MS
};
