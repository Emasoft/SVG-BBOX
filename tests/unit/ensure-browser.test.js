/**
 * @file Tests for ensure-browser.cjs - Browser detection and download logic
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';

// We need to import the module dynamically to allow mocking
let ensureBrowser;

describe('ensure-browser', () => {
  beforeEach(async () => {
    // Reset module cache and reload
    vi.resetModules();
    ensureBrowser = await import('../../lib/ensure-browser.cjs');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('CHROME_PATHS and CHROMIUM_PATHS', () => {
    it('should have paths defined for all supported platforms', () => {
      const supportedPlatforms = ['darwin', 'linux', 'win32', 'openbsd', 'freebsd'];

      for (const platform of supportedPlatforms) {
        expect(ensureBrowser.CHROME_PATHS[platform]).toBeDefined();
        expect(Array.isArray(ensureBrowser.CHROME_PATHS[platform])).toBe(true);
        expect(ensureBrowser.CHROME_PATHS[platform].length).toBeGreaterThan(0);

        expect(ensureBrowser.CHROMIUM_PATHS[platform]).toBeDefined();
        expect(Array.isArray(ensureBrowser.CHROMIUM_PATHS[platform])).toBe(true);
        expect(ensureBrowser.CHROMIUM_PATHS[platform].length).toBeGreaterThan(0);
      }
    });

    it('should have valid path formats for darwin', () => {
      const chromePaths = ensureBrowser.CHROME_PATHS.darwin;
      expect(chromePaths.some((p) => p.includes('/Applications/'))).toBe(true);
      expect(chromePaths.some((p) => p.includes('Google Chrome'))).toBe(true);
    });

    it('should have valid path formats for linux', () => {
      const chromePaths = ensureBrowser.CHROME_PATHS.linux;
      expect(chromePaths.some((p) => p.startsWith('/usr/bin/'))).toBe(true);

      const chromiumPaths = ensureBrowser.CHROMIUM_PATHS.linux;
      expect(chromiumPaths.some((p) => p.includes('chromium'))).toBe(true);
    });

    it('should have valid path formats for win32', () => {
      const chromePaths = ensureBrowser.CHROME_PATHS.win32;
      expect(chromePaths.some((p) => p.includes('\\Google\\Chrome\\'))).toBe(true);
    });

    it('should have valid path formats for BSD systems', () => {
      const openbsdChrome = ensureBrowser.CHROME_PATHS.openbsd;
      const freebsdChrome = ensureBrowser.CHROME_PATHS.freebsd;

      expect(openbsdChrome.some((p) => p.startsWith('/usr/local/'))).toBe(true);
      expect(freebsdChrome.some((p) => p.startsWith('/usr/local/'))).toBe(true);
    });
  });

  describe('isDownloadDisabled', () => {
    it('should return false when env var is not set', () => {
      delete process.env.SVG_BBOX_SKIP_BROWSER_DOWNLOAD;
      vi.resetModules();
      const mod = require('../../lib/ensure-browser.cjs');
      expect(mod.isDownloadDisabled()).toBe(false);
    });

    it('should return true when env var is "1"', () => {
      process.env.SVG_BBOX_SKIP_BROWSER_DOWNLOAD = '1';
      vi.resetModules();
      const mod = require('../../lib/ensure-browser.cjs');
      expect(mod.isDownloadDisabled()).toBe(true);
      delete process.env.SVG_BBOX_SKIP_BROWSER_DOWNLOAD;
    });

    it('should return true when env var is "true"', () => {
      process.env.SVG_BBOX_SKIP_BROWSER_DOWNLOAD = 'true';
      vi.resetModules();
      const mod = require('../../lib/ensure-browser.cjs');
      expect(mod.isDownloadDisabled()).toBe(true);
      delete process.env.SVG_BBOX_SKIP_BROWSER_DOWNLOAD;
    });

    it('should return false for other values', () => {
      process.env.SVG_BBOX_SKIP_BROWSER_DOWNLOAD = 'false';
      vi.resetModules();
      const mod = require('../../lib/ensure-browser.cjs');
      expect(mod.isDownloadDisabled()).toBe(false);
      delete process.env.SVG_BBOX_SKIP_BROWSER_DOWNLOAD;
    });
  });

  describe('getUserSpecifiedBrowserPath', () => {
    afterEach(() => {
      delete process.env.SVG_BBOX_BROWSER_PATH;
      delete process.env.PUPPETEER_EXECUTABLE_PATH;
    });

    it('should return null when no env vars are set', () => {
      expect(ensureBrowser.getUserSpecifiedBrowserPath()).toBeNull();
    });

    it('should return SVG_BBOX_BROWSER_PATH when set', () => {
      process.env.SVG_BBOX_BROWSER_PATH = '/custom/chrome';
      vi.resetModules();
      const mod = require('../../lib/ensure-browser.cjs');
      expect(mod.getUserSpecifiedBrowserPath()).toBe('/custom/chrome');
    });

    it('should prefer SVG_BBOX_BROWSER_PATH over PUPPETEER_EXECUTABLE_PATH', () => {
      process.env.SVG_BBOX_BROWSER_PATH = '/svg-bbox/chrome';
      process.env.PUPPETEER_EXECUTABLE_PATH = '/puppeteer/chrome';
      vi.resetModules();
      const mod = require('../../lib/ensure-browser.cjs');
      expect(mod.getUserSpecifiedBrowserPath()).toBe('/svg-bbox/chrome');
    });

    it('should fall back to PUPPETEER_EXECUTABLE_PATH', () => {
      process.env.PUPPETEER_EXECUTABLE_PATH = '/puppeteer/chrome';
      vi.resetModules();
      const mod = require('../../lib/ensure-browser.cjs');
      expect(mod.getUserSpecifiedBrowserPath()).toBe('/puppeteer/chrome');
    });
  });

  describe('resolveExecutablePath', () => {
    it('should return null for empty path', () => {
      expect(ensureBrowser.resolveExecutablePath('')).toBeNull();
      expect(ensureBrowser.resolveExecutablePath(null)).toBeNull();
      expect(ensureBrowser.resolveExecutablePath(undefined)).toBeNull();
    });

    it('should return null for non-existent path', () => {
      expect(ensureBrowser.resolveExecutablePath('/nonexistent/path')).toBeNull();
    });

    it('should return null for directory path', () => {
      expect(ensureBrowser.resolveExecutablePath('/tmp')).toBeNull();
    });

    it('should resolve valid executable path', () => {
      // node executable should always exist and be executable
      const nodePath = process.execPath;
      const resolved = ensureBrowser.resolveExecutablePath(nodePath);
      expect(resolved).not.toBeNull();
      expect(fs.existsSync(resolved)).toBe(true);
    });
  });

  describe('validateBrowserPath', () => {
    it('should return invalid for empty path', () => {
      const result = ensureBrowser.validateBrowserPath('');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should return invalid for non-existent path', () => {
      const result = ensureBrowser.validateBrowserPath('/nonexistent/browser');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should return invalid for directory', () => {
      const result = ensureBrowser.validateBrowserPath('/tmp');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Not a file');
    });

    it('should return valid for node executable', () => {
      const result = ensureBrowser.validateBrowserPath(process.execPath);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe('findBrowser', () => {
    it('should return browser info with path and source', () => {
      const browser = ensureBrowser.findBrowser();

      // In test environment, at least puppeteer's browser should be available
      if (browser) {
        expect(browser).toHaveProperty('path');
        expect(browser).toHaveProperty('source');
        expect(typeof browser.path).toBe('string');
        expect(['puppeteer', 'system-chrome', 'system-chromium', 'user-specified']).toContain(
          browser.source
        );
      }
    });
  });

  describe('isBrowserInstalled', () => {
    it('should return boolean', () => {
      const result = ensureBrowser.isBrowserInstalled();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('getBrowserPath', () => {
    it('should return string or null', () => {
      const result = ensureBrowser.getBrowserPath();
      expect(result === null || typeof result === 'string').toBe(true);
    });
  });

  describe('getBrowserStatus', () => {
    it('should return status object with all required fields', () => {
      const status = ensureBrowser.getBrowserStatus();

      expect(status).toHaveProperty('installed');
      expect(status).toHaveProperty('path');
      expect(status).toHaveProperty('source');
      expect(status).toHaveProperty('downloadDisabled');

      expect(typeof status.installed).toBe('boolean');
      expect(typeof status.downloadDisabled).toBe('boolean');
    });

    it('should have consistent path and source values', () => {
      const status = ensureBrowser.getBrowserStatus();

      if (status.installed) {
        expect(status.path).not.toBeNull();
        expect(status.source).not.toBeNull();
      } else {
        expect(status.path).toBeNull();
        expect(status.source).toBeNull();
      }
    });
  });

  describe('configuration constants', () => {
    it('should have MAX_DOWNLOAD_RETRIES defined', () => {
      expect(ensureBrowser.MAX_DOWNLOAD_RETRIES).toBeDefined();
      expect(typeof ensureBrowser.MAX_DOWNLOAD_RETRIES).toBe('number');
      expect(ensureBrowser.MAX_DOWNLOAD_RETRIES).toBeGreaterThan(0);
    });

    it('should have RETRY_DELAY_MS defined', () => {
      expect(ensureBrowser.RETRY_DELAY_MS).toBeDefined();
      expect(typeof ensureBrowser.RETRY_DELAY_MS).toBe('number');
      expect(ensureBrowser.RETRY_DELAY_MS).toBeGreaterThan(0);
    });
  });

  describe('findSystemChrome', () => {
    it('should return string or null', () => {
      const result = ensureBrowser.findSystemChrome();
      expect(result === null || typeof result === 'string').toBe(true);
    });
  });

  describe('findSystemChromium', () => {
    it('should return string or null', () => {
      const result = ensureBrowser.findSystemChromium();
      expect(result === null || typeof result === 'string').toBe(true);
    });
  });

  describe('getPuppeteerBrowserPath', () => {
    it('should return string or null', () => {
      const result = ensureBrowser.getPuppeteerBrowserPath();
      expect(result === null || typeof result === 'string').toBe(true);
    });
  });
});

describe('ensure-browser integration', () => {
  it('should detect at least one browser in test environment', async () => {
    const ensureBrowser = await import('../../lib/ensure-browser.cjs');

    // In CI/test environment, puppeteer browser should be installed
    const browser = ensureBrowser.findBrowser();

    // This test verifies the browser detection works
    // It should find at least one browser (puppeteer's Chrome is installed in test setup)
    expect(browser).not.toBeNull();
    expect(browser.path).toBeDefined();
    expect(fs.existsSync(browser.path)).toBe(true);
  });

  it('should be able to launch browser with detected path', async () => {
    const puppeteerUtils = await import('../../lib/puppeteer-utils.cjs');

    const browser = await puppeteerUtils.launchSecureBrowser();
    expect(browser).toBeDefined();

    const page = await browser.newPage();
    expect(page).toBeDefined();

    await page.setContent('<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>');

    const svgExists = await page.evaluate(() => document.querySelector('svg') !== null);
    expect(svgExists).toBe(true);

    await puppeteerUtils.closeBrowserSafely(browser);
  });
});
