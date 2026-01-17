#!/usr/bin/env node
/**
 * Browser Detection Verification Script
 *
 * WHY: This script is used by CI to verify that Chrome/Chromium browser
 * detection is working correctly on all platforms (Ubuntu, macOS, Windows).
 * Having this as a separate file avoids shell escaping issues with inline
 * node -e commands in GitHub Actions workflows.
 */

'use strict';

const {
  findBrowser,
  findSystemChrome,
  findSystemChromium,
  getPuppeteerBrowserPath,
  isBrowserInstalled
} = require('../lib/ensure-browser.cjs');

console.log('=== Browser Detection Verification ===');
console.log('Platform:', process.platform);
console.log('');

// WHY: Check puppeteer's bundled browser first - most reliable option
const puppeteerPath = getPuppeteerBrowserPath();
console.log('Puppeteer browser:', puppeteerPath ? '✓ Found' : '✗ Not found');
if (puppeteerPath) console.log('  Path:', puppeteerPath);

// WHY: Check system Chrome as fallback
const chromePath = findSystemChrome();
console.log('System Chrome:', chromePath ? '✓ Found' : '✗ Not found');
if (chromePath) console.log('  Path:', chromePath);

// WHY: Check system Chromium as last resort
const chromiumPath = findSystemChromium();
console.log('System Chromium:', chromiumPath ? '✓ Found' : '✗ Not found');
if (chromiumPath) console.log('  Path:', chromiumPath);

// WHY: Show which browser will actually be used
const browser = findBrowser();
console.log('');
console.log('Selected browser:', browser ? browser.source : 'NONE');
if (browser) console.log('  Path:', browser.path);

// WHY: Fail CI if no browser is available
if (!isBrowserInstalled()) {
  console.error('');
  console.error('ERROR: No Chrome or Chromium browser detected!');
  process.exit(1);
}

console.log('');
console.log('✓ Browser detection verification passed');
