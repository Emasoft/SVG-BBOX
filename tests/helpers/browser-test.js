/**
 * Browser Test Helper
 *
 * Utilities for testing SvgVisualBBox library in Puppeteer browser context.
 * Provides helpers to load SVGs, inject the library, and run tests.
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { FONT_TIMEOUT_MS, CLI_TIMEOUT_MS } from '../../config/timeouts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

/**
 * Shared browser instance for all tests
 * @type {import('puppeteer').Browser | null}
 */
let sharedBrowser = null;

/**
 * Get or create the shared browser instance
 * @returns {Promise<import('puppeteer').Browser>}
 */
export async function getBrowser() {
  if (!sharedBrowser) {
    sharedBrowser = await puppeteer.launch({
      headless: /** @type {boolean} */ (true), // Use true instead of 'new' for type compatibility
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security', // Allow local file loading
        '--allow-file-access-from-files'
      ]
    });
  }
  return sharedBrowser;
}

/**
 * Close the shared browser instance
 * @param {number} [timeout=10000] - Maximum time to wait for browser to close
 */
export async function closeBrowser(timeout = 10000) {
  if (sharedBrowser) {
    const browser = sharedBrowser;
    sharedBrowser = null; // Clear reference immediately to prevent double-close

    try {
      // Race between browser.close() and timeout
      await Promise.race([
        browser.close(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Browser close timeout')), timeout)
        )
      ]);
    } catch {
      // If close times out or fails, try to force kill the process
      try {
        const browserProcess = browser.process();
        if (browserProcess && !browserProcess.killed) {
          browserProcess.kill('SIGKILL');
        }
      } catch {
        // Process may already be dead - that's fine
      }
    }
  }
}

// Register signal handlers to ensure browser cleanup on process termination
// This prevents orphaned Chrome processes when vitest is interrupted
const cleanupOnExit = async () => {
  await closeBrowser(5000); // Quick cleanup on exit
};

// Handle graceful shutdown signals
process.on('SIGTERM', cleanupOnExit);
process.on('SIGINT', cleanupOnExit);
process.on('beforeExit', cleanupOnExit);

/**
 * Load SVG content from a fixture file
 * @param {string} fixturePath - Relative path from tests/fixtures/
 * @returns {string} SVG content
 */
export function loadFixture(fixturePath) {
  const fullPath = path.resolve(PROJECT_ROOT, 'tests/fixtures', fixturePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Fixture not found: ${fullPath}`);
  }
  return fs.readFileSync(fullPath, 'utf8');
}

/**
 * Create a new page with SVG and SvgVisualBBox library loaded
 * @param {string} svgContent - SVG markup or fixture path
 * @param {object} [options]
 * @param {number} [options.fontTimeoutMs] - Timeout for font loading (defaults to FONT_TIMEOUT_MS from config)
 * @param {number} [options.pageTimeoutMs] - Timeout for page.setContent navigation (defaults to 30000ms)
 * @returns {Promise<import('puppeteer').Page>}
 */
export async function createPageWithSvg(svgContent, options = {}) {
  // WHY use FONT_TIMEOUT_MS from config: Centralized timeout management
  // Allows CI environment overrides without changing test code
  // WHY separate pageTimeoutMs: page.setContent timeout is for Puppeteer navigation,
  // while fontTimeoutMs is for library's font detection. Font tests need both longer.
  const { fontTimeoutMs = FONT_TIMEOUT_MS, pageTimeoutMs = 30000 } = options;

  const browser = await getBrowser();
  const page = await browser.newPage();

  // Set viewport
  await page.setViewport({ width: 1280, height: 720 });

  // Load SVG (treat as fixture path if doesn't start with <)
  let svg = svgContent;
  if (!svgContent.trim().startsWith('<')) {
    svg = loadFixture(svgContent);
  }

  // Create HTML page with SVG
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>SVG Test</title>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      background: #ffffff;
    }
  </style>
</head>
<body>
${svg}
</body>
</html>`;

  // WHY waitUntil networkidle0 + custom timeout: For most tests, waiting for all network
  // activity to cease ensures fonts are loaded. But for tests with external/missing fonts,
  // the default 30s timeout is insufficient. The pageTimeoutMs option allows callers to
  // increase the timeout for font-heavy tests.
  await page.setContent(html, { waitUntil: 'networkidle0', timeout: pageTimeoutMs });

  // Inject SvgVisualBBox library
  const libPath = path.resolve(PROJECT_ROOT, 'SvgVisualBBox.js');
  if (!fs.existsSync(libPath)) {
    throw new Error('SvgVisualBBox.js not found at: ' + libPath);
  }
  await page.addScriptTag({ path: libPath });

  // Wait for fonts with reduced timeout for tests
  await page.evaluate(async (timeout) => {
    if (window.SvgVisualBBox && window.SvgVisualBBox.waitForDocumentFonts) {
      await window.SvgVisualBBox.waitForDocumentFonts(document, timeout);
    }
  }, fontTimeoutMs);

  return page;
}

/**
 * Call a SvgVisualBBox library function in the page context
 * @param {import('puppeteer').Page} page
 * @param {string} functionName - Name of the function (e.g., 'getSvgElementVisualBBoxTwoPassAggressive')
 * @param {...any} args - Arguments to pass to the function
 * @returns {Promise<any>}
 */
export async function callLibraryFunction(page, functionName, ...args) {
  return page.evaluate(
    async (fn, ...fnArgs) => {
      const lib = window.SvgVisualBBox;
      if (!lib || typeof lib[fn] !== 'function') {
        throw new Error(`Function ${fn} not found on SvgVisualBBox`);
      }
      return lib[fn](...fnArgs);
    },
    functionName,
    ...args
  );
}

/**
 * Get bbox of an element by ID
 * @param {import('puppeteer').Page} page
 * @param {string} elementId
 * @param {object} [options]
 * @returns {Promise<object|null>}
 */
export async function getBBoxById(page, elementId, options = {}) {
  try {
    return await page.evaluate(
      async (id, opts) => {
        const lib = window.SvgVisualBBox;
        if (!lib) {
          throw new Error('SvgVisualBBox not loaded');
        }
        const el = document.getElementById(id);
        if (!el) {
          throw new Error(`Element not found: ${id}`);
        }
        return lib.getSvgElementVisualBBoxTwoPassAggressive(el, opts);
      },
      elementId,
      options
    );
  } catch (error) {
    // Check if there's debug SVG data to save
    const debugData = await page.evaluate(
      () => /** @type {any} */ (window).__DEBUG_SVG_DATA__ || null
    );

    if (debugData && debugData.content && debugData.filename) {
      // Save debug SVG to current directory
      const debugPath = path.join(process.cwd(), debugData.filename);
      fs.writeFileSync(debugPath, debugData.content, 'utf8');

      // Add the saved path to error message
      if (
        error &&
        typeof error === 'object' &&
        'message' in error &&
        typeof error.message === 'string'
      ) {
        error.message = error.message.replace(
          /DEBUG SVG WILL BE AUTOMATICALLY SAVED:\s+([^\n]+)/,
          `DEBUG SVG AUTOMATICALLY SAVED:\n   ✓ ${debugPath}`
        );
      }
    }

    throw error;
  }
}

/**
 * Get root SVG element info
 * @param {import('puppeteer').Page} page
 * @returns {Promise<{viewBox: object|null, width: string|null, height: string|null}>}
 */
export async function getRootSvgInfo(page) {
  return page.evaluate(() => {
    const svg = document.querySelector('svg');
    if (!svg) {
      return null;
    }

    const vb = svg.viewBox && svg.viewBox.baseVal;
    const viewBox =
      vb && vb.width && vb.height ? { x: vb.x, y: vb.y, width: vb.width, height: vb.height } : null;

    return {
      viewBox,
      width: svg.getAttribute('width'),
      height: svg.getAttribute('height')
    };
  });
}

/**
 * Check if an element exists by ID
 * @param {import('puppeteer').Page} page
 * @param {string} elementId
 * @returns {Promise<boolean>}
 */
export async function elementExists(page, elementId) {
  return page.evaluate((id) => !!document.getElementById(id), elementId);
}

/**
 * Capture console output from page
 * @param {import('puppeteer').Page} page
 * @returns {Array<{type: string, text: string}>}
 */
export function captureConsole(page) {
  const logs = [];

  page.on('console', (msg) => {
    logs.push({
      type: msg.type(),
      text: msg.text()
    });
  });

  page.on('pageerror', (err) => {
    logs.push({
      type: 'error',
      text: err.toString()
    });
  });

  return logs;
}

/**
 * Assert bbox properties are valid
 * @param {object|null} bbox
 * @param {object} [expectations]
 */
export function assertValidBBox(bbox, expectations = {}) {
  if (bbox === null) {
    if (expectations.allowNull) {
      return;
    }
    throw new Error('Expected bbox but got null');
  }

  if (typeof bbox !== 'object') {
    throw new Error(`Expected bbox to be object, got ${typeof bbox}`);
  }

  const requiredProps = ['x', 'y', 'width', 'height'];
  for (const prop of requiredProps) {
    if (typeof bbox[prop] !== 'number' || !isFinite(bbox[prop])) {
      throw new Error(`Invalid bbox.${prop}: ${bbox[prop]}`);
    }
  }

  if (bbox.width < 0 || bbox.height < 0) {
    throw new Error(`BBox has negative dimensions: ${bbox.width}x${bbox.height}`);
  }

  // Check expectations
  if (expectations.minWidth !== undefined && bbox.width < expectations.minWidth) {
    throw new Error(`BBox width ${bbox.width} < expected min ${expectations.minWidth}`);
  }
  if (expectations.minHeight !== undefined && bbox.height < expectations.minHeight) {
    throw new Error(`BBox height ${bbox.height} < expected min ${expectations.minHeight}`);
  }
  if (expectations.maxWidth !== undefined && bbox.width > expectations.maxWidth) {
    throw new Error(`BBox width ${bbox.width} > expected max ${expectations.maxWidth}`);
  }
  if (expectations.maxHeight !== undefined && bbox.height > expectations.maxHeight) {
    throw new Error(`BBox height ${bbox.height} > expected max ${expectations.maxHeight}`);
  }
}

/**
 * Helper to run CLI tool and return output
 * @param {string} scriptPath - Path to script (e.g., 'sbb-test.cjs')
 * @param {string[]} args - Command line arguments
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
export async function runCLI(scriptPath, args = []) {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  const fullScriptPath = path.resolve(PROJECT_ROOT, scriptPath);

  try {
    const { stdout, stderr } = await execFileAsync('node', [fullScriptPath, ...args], {
      cwd: PROJECT_ROOT,
      // WHY use CLI_TIMEOUT_MS: Centralized timeout management for CLI operations
      // Allows CI environment overrides (slower CI needs longer timeouts)
      timeout: CLI_TIMEOUT_MS * 2 // 2x for CLI wrapper overhead + browser launch
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      exitCode: error.code || 1
    };
  }
}
