#!/usr/bin/env node
/**
 * sbb-test.cjs
 *
 * Usage:
 *    node sbb-test.cjs path/to/file.svg
 *
 * What it does:
 *  - launches Chrome/Chromium via Puppeteer (headless).
 *  - falls back to system Chrome via chrome-launcher if bundled Chromium is missing.
 *  - creates an empty HTML page and injects ONLY the SVG.
 *  - loads SvgVisualBBox.js into the page.
 *  - runs all exported functions:
 *      - getSvgElementVisualBBoxTwoPassAggressive
 *      - getSvgElementsUnionVisualBBox
 *      - getSvgElementVisibleAndFullBBoxes
 *      - getSvgRootViewBoxExpansionForFullDrawing
 *  - writes:
 *      - <svgbasename>-bbox-results.json  (data)
 *      - <svgbasename>-bbox-errors.log    (errors & diagnostics)
 *
 * Works on Linux and macOS (and should work on Windows as well).
 */

const fs = require('fs');
const path = require('path');
// NOTE: puppeteer and chrome-launcher are loaded lazily inside launchBrowserWithFallback()
// to allow --help and --version to work even when Chrome binaries are not installed
const {
  getVersion,
  printVersion: _printVersion,
  hasVersionFlag: _hasVersionFlag
} = require('./version.cjs');

// SECURITY: Import security utilities
const {
  validateFilePath,
  validateOutputPath,
  readSVGFileSafe,
  sanitizeSVGContent,
  writeFileSafe,
  SVGBBoxError: _SVGBBoxError,
  ValidationError,
  FileSystemError: _FileSystemError
} = require('./lib/security-utils.cjs');

const {
  runCLI,
  printSuccess,
  printError: _printError,
  printInfo,
  printWarning: _printWarning
} = require('./lib/cli-utils.cjs');

// Centralized timeout configuration
const { BROWSER_TIMEOUT_MS } = require('./config/timeouts.cjs');

// ========================= JSDoc Type Definitions =========================

/**
 * @typedef {Object} BBoxResultSummary
 * @property {string|null} [rootSvgId] - ID of the root SVG element
 * @property {string} [note] - Optional note about the test execution
 */

/**
 * @typedef {Object} RandomElementInfo
 * @property {string} tagName - Tag name of the random element
 * @property {string|null} id - ID of the element or null
 * @property {number} index - Index in the candidates array
 */

/**
 * @typedef {Object} BBoxTestResults
 * @property {BBoxResultSummary} summary - Summary information
 * @property {Object|null} rootVisibleAndFull - Root element visible and full bboxes
 * @property {RandomElementInfo|null} randomElementInfo - Info about randomly selected element
 * @property {Object|null} randomVisibleAndFull - Random element visible and full bboxes
 * @property {Object|null} randomAggressive - Random element aggressive bbox
 * @property {Object|null} unionRootAndRandom - Union of root and random element
 * @property {Object|null} unionAll - Union of all drawable elements
 * @property {Object|null} viewBoxExpansion - ViewBox expansion result
 * @property {string[]} errors - Array of error messages
 */

/**
 * Launch Puppeteer with the best available browser:
 *  1. Try bundled Chromium (default Puppeteer behavior).
 *  2. If that fails, try to find a system Chrome/Chromium via chrome-launcher
 *     and launch Puppeteer using its executablePath.
 */
/**
 * Launch browser with fallback to system Chrome
 * @param {string[]} errorLogMessages - Array to collect error messages
 * @returns {Promise<import('puppeteer').Browser>}
 */
async function launchBrowserWithFallback(errorLogMessages) {
  // Lazy load puppeteer and chrome-launcher to allow --help/--version to work
  // even when Chrome binaries are not installed (e.g., in CI package tests)
  const puppeteer = require('puppeteer');
  const chromeLauncher = require('chrome-launcher');

  try {
    const browser = await puppeteer.launch({
      // @ts-ignore - 'new' is valid for newer puppeteer versions
      headless: 'new' // new headless mode in recent Chrome versions
    });
    return browser;
  } catch (err) {
    errorLogMessages.push(
      '[launch] Failed to launch bundled Chromium with Puppeteer: ' +
        /** @type {Error} */ (err).message
    );
  }

  // Fallback: use chrome-launcher to find a system Chrome/Chromium
  let chromePaths;
  try {
    chromePaths = chromeLauncher.Launcher.getInstallations();
  } catch (err) {
    errorLogMessages.push(
      '[launch] chrome-launcher.getInstallations failed: ' + /** @type {Error} */ (err).message
    );
    throw new Error(
      'Could not launch any browser (no bundled Chromium and chrome-launcher failed).'
    );
  }

  if (!chromePaths || chromePaths.length === 0) {
    throw new Error(
      'No Chrome/Chromium installations found by chrome-launcher; cannot launch browser.'
    );
  }

  const chosen = chromePaths[0];
  errorLogMessages.push('[launch] Using system Chrome/Chromium at: ' + chosen);

  try {
    const browser = await puppeteer.launch({
      // @ts-ignore - 'new' is valid for newer puppeteer versions
      headless: 'new',
      executablePath: chosen
    });
    return browser;
  } catch (err) {
    errorLogMessages.push(
      '[launch] Failed to launch Puppeteer with system Chrome: ' +
        /** @type {Error} */ (err).message
    );
    throw new Error('Could not launch system Chrome/Chromium with Puppeteer.');
  }
}

/**
 * Generate a very simple HTML shell. SVG is injected later via page.evaluate()
 * using DOMParser, so this page starts empty on purpose.
 */
function makeHtmlShell() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>SvgVisualBBox Test</title>
    <style>
      html, body {
        margin: 0;
        padding: 0;
        background: #ffffff;
      }
    </style>
  </head>
  <body>
    <!-- SVG will be injected here -->
  </body>
</html>`;
}

/**
 * Print help message and exit.
 */
function showHelp() {
  console.log(`sbb-test v${getVersion()} - Test all SvgVisualBBox library functions

Usage:
  sbb-test <path/to/file.svg>
  sbb-test [options]

Description:
  Loads an SVG file, runs all exported SvgVisualBBox functions, and writes
  results to JSON and error log files in the current directory.

Options:
  -h, --help      Show this help message
  -v, --version   Show version information

Output Files:
  <basename>-bbox-results.json   Test results (JSON)
  <basename>-bbox-errors.log     Errors and diagnostics

Functions Tested:
  - getSvgElementVisualBBoxTwoPassAggressive
  - getSvgElementsUnionVisualBBox
  - getSvgElementVisibleAndFullBBoxes
  - getSvgRootViewBoxExpansionForFullDrawing

Examples:
  sbb-test logo.svg           Test logo.svg
  sbb-test assets/icon.svg    Test icon.svg
`);
  process.exit(0);
}

/**
 * Print version and exit.
 */
function showVersion() {
  console.log(`sbb-test v${getVersion()}`);
  process.exit(0);
}

/**
 * Main test runner.
 */
async function runTest() {
  const args = process.argv.slice(2);

  // Handle --help and --version flags FIRST (before any validation)
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
  }
  if (args.includes('--version') || args.includes('-v')) {
    showVersion();
  }

  // Display version header after flag checks
  printInfo(`sbb-test v${getVersion()} | svg-bbox toolkit\n`);

  const inputPath = args[0];
  if (!inputPath) {
    throw new ValidationError(
      'Usage: node sbb-test.cjs path/to/file.svg\nUse --help for more information.'
    );
  }

  // SECURITY: Validate and sanitize input path
  const safePath = validateFilePath(inputPath, {
    requiredExtensions: ['.svg'],
    mustExist: true
  });

  // SECURITY: Read SVG with size limit and validation
  const svgContent = readSVGFileSafe(safePath);

  // SECURITY: Sanitize SVG content (remove scripts, event handlers)
  const sanitizedSvg = sanitizeSVGContent(svgContent);

  const baseName = path.basename(safePath, path.extname(safePath));
  const outJsonPath = path.resolve(process.cwd(), `${baseName}-bbox-results.json`);
  const errLogPath = path.resolve(process.cwd(), `${baseName}-bbox-errors.log`);

  /** @type {string[]} */
  const errorLogMessages = [];

  /** @type {import('puppeteer').Browser|null} */
  let browser = null;
  try {
    browser = await launchBrowserWithFallback(errorLogMessages);
  } catch (err) {
    // Type guard for unknown error
    const errorStack = err instanceof Error ? err.stack : String(err);
    errorLogMessages.push('[fatal] ' + errorStack);
    // SECURITY: Use writeFileSafe for error log
    const safeErrPath = validateOutputPath(errLogPath);
    writeFileSafe(safeErrPath, errorLogMessages.join('\n'), 'utf8');
    throw new Error(`Failed to launch browser; see error log: ${safeErrPath}`);
  }

  const page = await browser.newPage();

  // SECURITY: Set page timeout
  page.setDefaultTimeout(BROWSER_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(BROWSER_TIMEOUT_MS);

  // Collect page console + errors into error log
  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    errorLogMessages.push(`[page console ${type}] ${text}`);
  });

  page.on('pageerror', (err) => {
    errorLogMessages.push('[page error] ' + /** @type {Error} */ (err).stack);
  });

  try {
    // 1. Load a minimal HTML shell
    await page.setContent(makeHtmlShell(), { waitUntil: 'load' });

    // 2. Inject SvgVisualBBox.js (UMD) from local file
    const libPath = path.resolve(__dirname, 'SvgVisualBBox.js');
    if (!fs.existsSync(libPath)) {
      throw new Error('SvgVisualBBox.js not found at: ' + libPath);
    }
    await page.addScriptTag({ path: libPath });

    // 3. Now run tests in the browser context
    const results = await page.evaluate(async (svgString) => {
      /* eslint-disable no-undef */
      /**
       * @type {{
       *   summary: { rootSvgId?: string|null, note?: string },
       *   rootVisibleAndFull: Object|null,
       *   randomElementInfo: { tagName: string, id: string|null, index: number }|null,
       *   randomVisibleAndFull: Object|null,
       *   randomAggressive: Object|null,
       *   unionRootAndRandom: Object|null,
       *   unionAll: Object|null,
       *   viewBoxExpansion: Object|null,
       *   errors: string[]
       * }}
       */
      const res = {
        summary: {},
        rootVisibleAndFull: null,
        randomElementInfo: null,
        randomVisibleAndFull: null,
        randomAggressive: null,
        unionRootAndRandom: null,
        unionAll: null,
        viewBoxExpansion: null,
        errors: []
      };

      try {
        if (!window.SvgVisualBBox) {
          throw new Error('SvgVisualBBox not found on window; library did not load.');
        }

        const SvgVisualBBox = window.SvgVisualBBox;

        // Parse and import SVG safely with DOMParser
        let parser;
        try {
          parser = new DOMParser();
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          throw new Error('DOMParser not available: ' + errMsg);
        }

        const svgDoc = parser.parseFromString(svgString, 'image/svg+xml');
        const originalSvg = svgDoc.documentElement;

        if (!originalSvg || originalSvg.nodeName.toLowerCase() !== 'svg') {
          throw new Error('Provided file does not appear to be a valid <svg> root.');
        }

        const importedSvg = document.importNode(originalSvg, true);

        // Ensure it has an id for easier debugging
        if (!importedSvg.id) {
          importedSvg.id = 'rootSvg';
        }

        document.body.appendChild(importedSvg);

        res.summary.rootSvgId = importedSvg.id || null;

        // --- 1) root: visible + full bboxes -----------------------
        try {
          res.rootVisibleAndFull = await SvgVisualBBox.getSvgElementVisibleAndFullBBoxes(
            importedSvg,
            {
              coarseFactor: 3,
              fineFactor: 24,
              useLayoutScale: true
            }
          );
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          res.errors.push('[rootVisibleAndFull] ' + errMsg);
        }

        // --- 2) pick a random element (excluding defs/metadata/etc.) -----
        const allCandidates = Array.from(importedSvg.querySelectorAll('*')).filter((el) => {
          const tag = el.tagName.toLowerCase();
          // skip non-rendering / meta elements
          if (['defs', 'title', 'desc', 'metadata', 'script', 'style'].includes(tag)) {
            return false;
          }
          // we also skip the root in this pool; we'll include it explicitly
          if (el === importedSvg) {
            return false;
          }
          return true;
        });

        /** @type {Element|null} */
        let randomElement = null;
        if (allCandidates.length > 0) {
          const index = Math.floor(Math.random() * allCandidates.length);
          const selectedElement = allCandidates[index];
          // Type guard - ensure element exists before proceeding
          if (!selectedElement) {
            res.summary.note = 'Failed to select random element from candidates.';
          } else {
            randomElement = selectedElement;

            res.randomElementInfo = {
              tagName: randomElement.tagName,
              id: randomElement.id || null,
              index
            };

            // random element visible+full
            try {
              res.randomVisibleAndFull = await SvgVisualBBox.getSvgElementVisibleAndFullBBoxes(
                randomElement,
                {
                  coarseFactor: 3,
                  fineFactor: 24,
                  useLayoutScale: true
                }
              );
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res.errors.push('[randomVisibleAndFull] ' + errMsg);
            }

            // random element aggressive direct bbox
            try {
              res.randomAggressive = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(
                randomElement,
                {
                  mode: 'clipped', // test default mode
                  coarseFactor: 3,
                  fineFactor: 24,
                  useLayoutScale: true
                }
              );
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res.errors.push('[randomAggressive] ' + errMsg);
            }

            // --- 3) union of root + random element -------------------------
            try {
              res.unionRootAndRandom = await SvgVisualBBox.getSvgElementsUnionVisualBBox(
                [importedSvg, randomElement],
                {
                  mode: 'clipped',
                  coarseFactor: 3,
                  fineFactor: 24,
                  useLayoutScale: true
                }
              );
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              res.errors.push('[unionRootAndRandom] ' + errMsg);
            }
          }
        } else {
          res.summary.note = 'No suitable random elements found (only defs/metadata).';
        }

        // --- 4) union of *all* drawable elements (if any) ---------------
        if (allCandidates.length > 0) {
          // @ts-ignore - concat types work correctly at runtime
          const unionTargets = [importedSvg].concat(allCandidates.slice(0, 20)); // limit for sanity
          try {
            res.unionAll = await SvgVisualBBox.getSvgElementsUnionVisualBBox(unionTargets, {
              mode: 'clipped',
              coarseFactor: 3,
              fineFactor: 24,
              useLayoutScale: true
            });
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            res.errors.push('[unionAll] ' + errMsg);
          }
        }

        // --- 5) root: viewBox expansion for full drawing ----------------
        try {
          // @ts-ignore - getSvgRootViewBoxExpansionForFullDrawing exists at runtime
          res.viewBoxExpansion = await SvgVisualBBox.getSvgRootViewBoxExpansionForFullDrawing(
            importedSvg,
            {
              coarseFactor: 3,
              fineFactor: 24,
              useLayoutScale: true
            }
          );
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          res.errors.push('[viewBoxExpansion] ' + errMsg);
        }
      } catch (e) {
        const errInfo = e instanceof Error ? e.stack || e.message : String(e);
        res.errors.push('[top-level evaluate] ' + errInfo);
      }

      return res;
      /* eslint-enable no-undef */
    }, sanitizedSvg);

    // SECURITY: Write output JSON with path validation
    const safeJsonPath = validateOutputPath(outJsonPath, {
      requiredExtensions: ['.json']
    });
    writeFileSafe(safeJsonPath, JSON.stringify(results, null, 2), 'utf8');

    // Append any page-accumulated errors to error log
    if (results && Array.isArray(results.errors) && results.errors.length > 0) {
      errorLogMessages.push('--- errors from browser context ---');
      for (const msg of results.errors) {
        errorLogMessages.push(msg);
      }
    }

    // SECURITY: Write error log with path validation
    const safeErrPath = validateOutputPath(errLogPath);
    writeFileSafe(safeErrPath, errorLogMessages.join('\n'), 'utf8');

    printSuccess(`Results written to: ${safeJsonPath}`);
    printInfo(`Errors written to: ${safeErrPath}`);
  } catch (err) {
    // Type guard for unknown error
    const errorStack = err instanceof Error ? err.stack : String(err);
    errorLogMessages.push('[fatal in runTest] ' + errorStack);
    // SECURITY: Write error log with path validation
    const safeErrPath = validateOutputPath(errLogPath);
    writeFileSafe(safeErrPath, errorLogMessages.join('\n'), 'utf8');
    throw new Error(`Fatal error; see error log: ${safeErrPath}`);
  } finally {
    // SECURITY: Ensure browser is always closed
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Force kill if close fails - browser.process() may return null
        const browserProcess = browser.process();
        if (browserProcess) {
          browserProcess.kill('SIGKILL');
        }
      }
    }
  }
}

runCLI(runTest);
