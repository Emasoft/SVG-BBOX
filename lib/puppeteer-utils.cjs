#!/usr/bin/env node
/**
 * puppeteer-utils.cjs
 *
 * Shared Puppeteer browser utilities for SVG-BBOX CLI tools.
 *
 * This module centralizes browser launch, cleanup, and page setup code
 * that was previously duplicated across 6 CLI tools (~130-190 lines).
 *
 * WHAT THIS FIXES:
 * - DRY violation: Browser launch code duplicated in 6 files
 * - Inconsistent args: Some tools had --disable-dev-shm-usage, some didn't
 * - Inconsistent cleanup: Some tools had force-kill fallback, some didn't
 * - Inconsistent timeouts: Some tools configured timeouts, some didn't
 *
 * WHY CENTRALIZE:
 * - Single source of truth for browser configuration
 * - Consistent security args across all tools
 * - Consistent cleanup behavior (prevents orphan browser processes)
 * - Easy to update all tools when Puppeteer changes
 *
 * USAGE:
 *   const {
 *     launchSecureBrowser,
 *     closeBrowserSafely,
 *     createPageWithTimeout,
 *     injectSvgVisualBBoxLibrary
 *   } = require('./lib/puppeteer-utils.cjs');
 *
 *   const browser = await launchSecureBrowser();
 *   try {
 *     const page = await createPageWithTimeout(browser);
 *     await injectSvgVisualBBoxLibrary(page);
 *     // ... do work ...
 *   } finally {
 *     await closeBrowserSafely(browser);
 *   }
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { ensureBrowserSync } = require('./ensure-browser.cjs');

// Import centralized timeout configuration
const { BROWSER_TIMEOUT_MS } = require('../config/timeouts.cjs');

// Import security utilities for error classes
const { FileSystemError } = require('./security-utils.cjs');

// ============================================================================
// Security Configuration
// ============================================================================

/**
 * SECURE_BROWSER_ARGS: Standard security args for headless Chrome
 *
 * WHY THESE ARGS:
 * - --no-sandbox: Required for Docker/CI environments without sandbox support
 * - --disable-setuid-sandbox: Companion to --no-sandbox for Linux
 * - --disable-dev-shm-usage: Prevents crashes on small /dev/shm (Docker default is 64MB)
 *
 * SECURITY NOTE:
 * These args reduce Chrome's security sandbox. This is acceptable because:
 * - We process trusted local SVG files (not arbitrary web content)
 * - We run in controlled environments (CI, local dev, Docker)
 * - Headless mode has limited attack surface
 *
 * WHAT NOT TO DO:
 * - Don't add --disable-web-security (allows XSS in loaded content)
 * - Don't add --allow-file-access-from-files (local file access from web content)
 * - Don't remove these args (CI will fail)
 */
const SECURE_BROWSER_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];

/**
 * DEFAULT_PUPPETEER_OPTIONS: Standard Puppeteer launch options
 *
 * Combines security args with timeout configuration.
 * All CLI tools should use these options for consistency.
 */
const DEFAULT_PUPPETEER_OPTIONS = {
  headless: true,
  args: SECURE_BROWSER_ARGS,
  timeout: BROWSER_TIMEOUT_MS
};

// ============================================================================
// Browser Launch
// ============================================================================

/**
 * Launch a headless Chrome browser with secure defaults.
 *
 * @param {Object} options - Optional overrides for Puppeteer launch options
 * @param {boolean} [options.headless=true] - Run in headless mode
 * @param {string[]} [options.args] - Additional Chrome args (merged with secure defaults)
 * @param {number} [options.timeout] - Browser launch timeout in ms
 * @returns {Promise<import('puppeteer').Browser>} - Puppeteer browser instance
 *
 * @example
 * // Basic usage
 * const browser = await launchSecureBrowser();
 *
 * @example
 * // With custom timeout
 * const browser = await launchSecureBrowser({ timeout: 60000 });
 *
 * @example
 * // With additional Chrome args
 * const browser = await launchSecureBrowser({
 *   args: ['--window-size=1920,1080']
 * });
 */
async function launchSecureBrowser(options = {}) {
  // Ensure Chromium is downloaded (lazy download on first use)
  ensureBrowserSync();

  const mergedOptions = {
    ...DEFAULT_PUPPETEER_OPTIONS,
    ...options,
    // Merge args arrays (secure args + custom args)
    args: [...SECURE_BROWSER_ARGS, ...(options.args || [])]
  };

  return puppeteer.launch(mergedOptions);
}

// ============================================================================
// Browser Cleanup
// ============================================================================

/**
 * Safely close a Puppeteer browser with force-kill fallback.
 *
 * WHY FORCE-KILL FALLBACK:
 * - browser.close() can hang if Chrome is unresponsive
 * - Orphan Chrome processes consume memory and CPU
 * - CI environments accumulate orphans over time
 * - SIGKILL ensures process termination even if hung
 *
 * @param {import('puppeteer').Browser|null} browser - Browser instance to close
 * @returns {Promise<void>}
 *
 * @example
 * // In try/finally block (recommended pattern)
 * let browser;
 * try {
 *   browser = await launchSecureBrowser();
 *   // ... do work ...
 * } finally {
 *   await closeBrowserSafely(browser);
 * }
 */
async function closeBrowserSafely(browser) {
  if (!browser) {
    return; // Nothing to close
  }

  try {
    await browser.close();
  } catch {
    // browser.close() failed - likely Chrome is unresponsive
    // Force kill the process to prevent orphans
    const browserProcess = browser.process();
    if (browserProcess) {
      try {
        browserProcess.kill('SIGKILL');
      } catch {
        // Process already dead or inaccessible - acceptable
      }
    }
  }
}

// ============================================================================
// Page Setup
// ============================================================================

/**
 * Create a new page with timeout configuration.
 *
 * @param {import('puppeteer').Browser} browser - Browser instance
 * @param {number} [timeoutMs] - Timeout in ms (defaults to BROWSER_TIMEOUT_MS)
 * @returns {Promise<import('puppeteer').Page>} - Configured page instance
 *
 * @example
 * const browser = await launchSecureBrowser();
 * const page = await createPageWithTimeout(browser);
 * await page.setContent('<svg>...</svg>');
 */
async function createPageWithTimeout(browser, timeoutMs = BROWSER_TIMEOUT_MS) {
  // WHY: Defensive programming - fail fast if browser is null/undefined
  // Prevents cryptic "Cannot read property 'newPage' of null" errors
  if (!browser) {
    throw new Error('browser parameter is required');
  }

  const page = await browser.newPage();

  // Configure timeouts for all page operations
  page.setDefaultTimeout(timeoutMs);
  page.setDefaultNavigationTimeout(timeoutMs);

  return page;
}

/**
 * Set page content with SVG and wait for network idle.
 *
 * @param {import('puppeteer').Page} page - Puppeteer page
 * @param {string} svgContent - SVG content to load
 * @param {number} [timeoutMs] - Timeout in ms
 * @returns {Promise<void>}
 *
 * @example
 * const page = await createPageWithTimeout(browser);
 * await setPageContent(page, svgContent);
 */
async function setPageContent(page, svgContent, timeoutMs = BROWSER_TIMEOUT_MS) {
  // WHY: Defensive programming - fail fast if page is null/undefined
  // Prevents cryptic "Cannot read property 'setContent' of null" errors
  if (!page) {
    throw new Error('page parameter is required');
  }

  // WHY: Defensive programming - fail fast if svgContent is null/undefined
  // Prevents silent bugs from interpolating "undefined" into HTML template
  if (svgContent === null || svgContent === undefined) {
    throw new Error('svgContent parameter is required');
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    html, body { margin: 0; padding: 0; }
  </style>
</head>
<body>
  ${svgContent}
</body>
</html>`;

  await page.setContent(html, {
    waitUntil: 'networkidle0',
    timeout: timeoutMs
  });
}

// ============================================================================
// Script Injection
// ============================================================================

/**
 * Inject the SvgVisualBBox library into a page.
 *
 * @param {import('puppeteer').Page} page - Puppeteer page
 * @param {string | null} [libPath] - Path to SvgVisualBBox.js (auto-detected if not provided)
 * @returns {Promise<void>}
 * @throws {FileSystemError} If library file is not found
 *
 * @example
 * const page = await createPageWithTimeout(browser);
 * await setPageContent(page, svgContent);
 * await injectSvgVisualBBoxLibrary(page);
 * // Now page has access to SvgVisualBBox.getTrueBBox()
 */
async function injectSvgVisualBBoxLibrary(page, libPath = null) {
  // WHY: Defensive programming - fail fast if page is null/undefined
  // Prevents cryptic "Cannot read property 'addScriptTag' of null" errors
  if (!page) {
    throw new Error('page parameter is required');
  }

  // Auto-detect library path if not provided
  if (!libPath) {
    // Try common locations relative to this file
    const candidates = [
      path.join(__dirname, '..', 'SvgVisualBBox.js'),
      path.join(__dirname, 'SvgVisualBBox.js'),
      path.resolve('SvgVisualBBox.js')
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        libPath = candidate;
        break;
      }
    }

    if (!libPath) {
      throw new FileSystemError('SvgVisualBBox.js not found', {
        searchPaths: candidates,
        hint: 'Ensure SvgVisualBBox.js is in the project root or lib/ directory'
      });
    }
  }

  // Verify file exists before injection
  if (!fs.existsSync(libPath)) {
    throw new FileSystemError('SvgVisualBBox.js not found', {
      path: libPath,
      hint: 'Ensure the library file exists at the specified path'
    });
  }

  await page.addScriptTag({ path: libPath });
}

// ============================================================================
// Convenience Wrappers
// ============================================================================

/**
 * Execute a function with a browser, ensuring cleanup.
 *
 * This is the recommended pattern for browser operations.
 * It handles launch, execution, and cleanup automatically.
 *
 * @template T
 * @param {function(import('puppeteer').Browser): Promise<T>} fn - Function to execute with browser
 * @param {Object} [options] - Browser launch options
 * @returns {Promise<T>} - Result of fn
 *
 * @example
 * // Simple bbox computation
 * const bbox = await withBrowser(async (browser) => {
 *   const page = await createPageWithTimeout(browser);
 *   await setPageContent(page, svgContent);
 *   await injectSvgVisualBBoxLibrary(page);
 *   return page.evaluate(() => SvgVisualBBox.getTrueBBox('myElement'));
 * });
 *
 * @example
 * // With custom timeout
 * const result = await withBrowser(
 *   async (browser) => { ... },
 *   { timeout: 60000 }
 * );
 */
async function withBrowser(fn, options = {}) {
  const browser = await launchSecureBrowser(options);
  try {
    return await fn(browser);
  } finally {
    await closeBrowserSafely(browser);
  }
}

/**
 * Execute a function with a page, ensuring browser cleanup.
 *
 * Higher-level wrapper that creates both browser and page.
 *
 * @template T
 * @param {function(import('puppeteer').Page): Promise<T>} fn - Function to execute with page
 * @param {{headless?: boolean, args?: string[], timeout?: number}} [options] - Browser launch options
 * @returns {Promise<T>} - Result of fn
 *
 * @example
 * // Simplest usage
 * const bbox = await withPage(async (page) => {
 *   await setPageContent(page, svgContent);
 *   await injectSvgVisualBBoxLibrary(page);
 *   return page.evaluate(() => SvgVisualBBox.getTrueBBox('myElement'));
 * });
 */
async function withPage(fn, options = {}) {
  return withBrowser(async (browser) => {
    const page = await createPageWithTimeout(browser, options.timeout);
    return fn(page);
  }, options);
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  // Constants
  SECURE_BROWSER_ARGS,
  DEFAULT_PUPPETEER_OPTIONS,

  // Browser lifecycle
  launchSecureBrowser,
  closeBrowserSafely,

  // Page setup
  createPageWithTimeout,
  setPageContent,

  // Script injection
  injectSvgVisualBBoxLibrary,

  // Convenience wrappers
  withBrowser,
  withPage
};
