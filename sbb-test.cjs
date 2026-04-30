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
const { getVersion } = require('./version.cjs');

// SECURITY: Import security utilities
const {
  validateFilePath,
  validateOutputPath,
  readSVGFileSafe,
  sanitizeSVGContent,
  writeFileSafe,
  ValidationError
} = require('./lib/security-utils.cjs');

const { runCLI, printSuccess, printInfo, printBanner } = require('./lib/cli-utils.cjs');
const helpFormatter = require('./lib/help-formatter.cjs');

// FBF.SVG (Frame-By-Frame SVG, https://github.com/Emasoft/svg2fbf) helper.
// Used by --fbf-frame N to pin PROSKENION to a specific frame BEFORE the
// SVG is injected into the test page, so the library's bbox/union/expansion
// functions are exercised against that single frame instead of the union
// of all PROSKENION targets the SMIL timeline would visit.
const { extractFbfFrame } = require('./lib/fbf.cjs');

// Centralized timeout configuration
const { BROWSER_TIMEOUT_MS, PROTOCOL_TIMEOUT_MS } = require('./config/timeouts.cjs');
// WHY launchOrConnect/safeShutdown: see lib/puppeteer-utils.cjs.
const { launchOrConnect, safeShutdown } = require('./lib/puppeteer-utils.cjs');

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
 * Launch browser with fallback to system Chrome
 * @param {string[]} errorLogMessages - Array to collect error messages
 * @returns {Promise<import('puppeteer').Browser>}
 */
async function launchBrowserWithFallback(errorLogMessages) {
  // Lazy load chrome-launcher to allow --help/--version to work
  // even when Chrome binaries are not installed (e.g., in CI package tests)
  const chromeLauncher = require('chrome-launcher');

  try {
    // WHY launchOrConnect: in test mode connects to shared $SBB_BROWSER_WS;
    // in production launches fresh Chromium with --headless=new.
    const browser = await launchOrConnect({
      // @ts-ignore - 'new' is valid for newer puppeteer versions
      headless: 'new', // new headless mode in recent Chrome versions
      protocolTimeout: PROTOCOL_TIMEOUT_MS
    });
    return browser;
  } catch (err) {
    errorLogMessages.push(
      '[launch] Failed to launch bundled Chromium with Puppeteer: ' +
        /** @type {Error} */ (err).message
    );
  }

  // Fallback: use chrome-launcher to find a system Chrome/Chromium
  // (Only reached in launch mode; connect mode succeeds or throws above.)
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
    // System Chrome fallback — always launch (connect mode would have
    // succeeded above if applicable).
    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      // @ts-ignore - 'new' is valid for newer puppeteer versions
      headless: 'new',
      executablePath: chosen,
      // WHY protocolTimeout: see config/timeouts.cjs (PROTOCOL_TIMEOUT_MS).
      // Default 30s for CDP RPC calls is too short under parallel test load.
      protocolTimeout: PROTOCOL_TIMEOUT_MS
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
 * @returns {string} HTML document string with empty body for SVG injection
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
  console.log(
    helpFormatter.renderHelp({
      toolName: 'sbb-test',
      tagline:
        'Diagnostic test runner — exercises every SvgVisualBBox library function on one SVG.',
      description:
        'Loads an SVG into headless Chromium, injects SvgVisualBBox.js, then runs every ' +
        'exported bbox function on the root element and on a randomly chosen child element. ' +
        'Writes structured JSON results and an error log to the current directory. Use this ' +
        'to verify that the library is computing visual bounding boxes correctly on a given ' +
        'SVG, or to capture diagnostics for bug reports.',
      usage: ['sbb-test <path/to/file.svg> [options]'],
      examples: [
        {
          title: 'Run all bbox functions on logo.svg:',
          command: 'sbb-test logo.svg'
        },
        {
          title: 'Test an asset and show detailed progress:',
          command: 'sbb-test assets/icon.svg --verbose'
        },
        {
          title: 'Quiet mode — print only pass/fail (good for CI):',
          command: 'sbb-test scene.svg --quiet'
        },
        {
          title: 'Pin frame 7 of an FBF.SVG before running the tests:',
          command: 'sbb-test scene.fbf.svg --fbf-frame 7'
        }
      ],
      commonOptions: helpFormatter.DEFAULT_COMMON_OPTIONS,
      options: [
        {
          name: 'quiet',
          type: 'boolean',
          description: 'Minimal output — only print the pass/fail test results.'
        },
        {
          name: 'verbose',
          type: 'boolean',
          description: 'Show detailed progress information for every step.'
        },
        {
          name: 'fbf-frame',
          type: 'number',
          valueLabel: '<N>',
          description:
            'FBF.SVG only: pin frame N (1-based) before running the tests so every bbox ' +
            'function exercises that specific frame instead of the union of all frames the ' +
            'SMIL timeline would visit. Single-file mode only.'
        }
      ],
      fbf: {
        flags: [
          {
            flag: '--fbf-frame <N>',
            description:
              "Pin frame N (1-based) of an FBF.SVG before running the tests. PROSKENION's " +
              '<use> is rewritten to #FRAMEnnnnn and its <animate> is dropped, so all bbox ' +
              'functions run against that single frame.'
          }
        ]
      },
      exitCodes: [
        [0, 'Success — tests ran (see JSON for individual function results)'],
        [1, 'Runtime error (browser launch failed, library missing, etc.)'],
        [2, 'Invalid arguments or input file not readable']
      ],
      notes:
        'Output files (written to the current directory): ' +
        '<basename>-bbox-results.json (test results) and ' +
        '<basename>-bbox-errors.log (errors and diagnostics). ' +
        'Functions tested: getSvgElementVisualBBoxTwoPassAggressive, ' +
        'getSvgElementsUnionVisualBBox, getSvgElementVisibleAndFullBBoxes, ' +
        'getSvgRootViewBoxExpansionForFullDrawing.'
    })
  );
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
 * @returns {Promise<void>} Resolves when test completes, writes results to JSON and log files
 */
async function runTest() {
  const args = process.argv.slice(2);

  // WHY: Print banner at the very start for consistent CLI branding
  printBanner('sbb-test', { quiet: false, json: false });

  // Handle --help and --version flags FIRST (before any validation)
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
  }
  if (args.includes('--version') || args.includes('-v')) {
    showVersion();
  }

  // WHY: Parse output verbosity flags for controlling console output
  const quietMode = args.includes('--quiet');
  const verboseMode = args.includes('--verbose');

  /**
   * Log function that respects quiet/verbose flags
   * @param {string} message - Message to log
   * @param {'info'|'verbose'|'result'} level - Log level (default: 'info')
   * @returns {void}
   */
  const log = (message, level = 'info') => {
    // WHY: Results always show regardless of flags (pass/fail output)
    if (level === 'result') {
      console.log(message);
      return;
    }
    // WHY: Quiet mode suppresses all non-result output
    if (quietMode) return;
    // WHY: Verbose messages only show when --verbose is set
    if (level === 'verbose' && !verboseMode) return;
    console.log(message);
  };

  // Display version header after flag checks (respects quiet mode)
  if (!quietMode) {
    printInfo(`sbb-test v${getVersion()} | svg-bbox toolkit\n`);
  }

  // WHY: Walk args once so --fbf-frame can consume its numeric value and
  // we can collect any positional file paths in the same pass. The earlier
  // args.find() approach couldn't read the value that followed --fbf-frame.
  /** @type {string[]} */
  const positional = [];
  /** @type {number|null} */
  let fbfFrame = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === '--fbf-frame') {
      // WHY: Pin a specific frame of an FBF.SVG (svg2fbf format) before
      // injecting the SVG so all four bbox functions exercise that single
      // frame rather than the union of frames PROSKENION animates over.
      const raw = args[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        throw new ValidationError(
          `--fbf-frame must be a positive integer (1-based frame number), got: ${raw}`
        );
      }
      fbfFrame = n;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
    // WHY: Unknown flags (--quiet, --verbose, --help, --version) are
    // already handled above via args.includes(); silently skip them here
    // so we don't have to duplicate the option list.
  }

  // WHY: --fbf-frame N pins one specific frame, which only makes sense for
  // a single FBF.SVG input. sbb-test only ever processes one positional
  // file today, but enforce the invariant explicitly so future batch-mode
  // additions don't silently force every file to be FBF.
  if (fbfFrame !== null && positional.length > 1) {
    throw new ValidationError(
      'Cannot use --fbf-frame with multiple input files (single-file mode only).'
    );
  }

  const inputPath = positional[0];
  if (!inputPath) {
    throw new ValidationError(
      'Usage: node sbb-test.cjs path/to/file.svg\nUse --help for more information.'
    );
  }

  // WHY: Log verbose progress information when --verbose is set
  if (verboseMode && !quietMode) {
    log(`Processing file: ${inputPath}`, 'verbose');
  }

  // SECURITY: Validate and sanitize input path
  const safePath = validateFilePath(inputPath, {
    requiredExtensions: ['.svg'],
    mustExist: true
  });

  // SECURITY: Read SVG with size limit and validation
  // WHY `let` (not const): --fbf-frame may rewrite svgContent below to pin
  // a single FBF.SVG frame before sanitization runs.
  // WHY size limits are intentionally Infinity in lib/security-utils.cjs:
  // FBF.SVG files can pack millions of frames (multi-hour animations) into
  // a single SVG; capping the read would refuse legitimate inputs.
  let svgContent = readSVGFileSafe(safePath);

  // FBF.SVG: pin a specific frame BEFORE sanitization so the helper sees
  // the original PROSKENION/animate structure as authored. The pinned SVG
  // is still a normal SVG, so sanitization and the rest of the pipeline
  // work unchanged.
  if (typeof fbfFrame === 'number' && fbfFrame >= 1) {
    const pinned = extractFbfFrame(svgContent, fbfFrame);
    svgContent = pinned.svg;
    if (verboseMode && !quietMode) {
      log(
        `FBF: pinned frame ${pinned.frameNumber} (#${pinned.frameId}) of ${pinned.totalFrames}`,
        'verbose'
      );
    }
  }

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
    if (verboseMode && !quietMode) {
      log('Launching browser...', 'verbose');
    }
    browser = await launchBrowserWithFallback(errorLogMessages);
    if (verboseMode && !quietMode) {
      log('Browser launched successfully', 'verbose');
    }
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
    if (verboseMode && !quietMode) {
      log('SvgVisualBBox library injected', 'verbose');
    }

    // 3. Now run tests in the browser context
    if (verboseMode && !quietMode) {
      log('Running tests in browser context...', 'verbose');
    }
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
          // WHY: Type guard for array access - Math.random() index should always
          // be valid, but TypeScript can't prove array[index] is defined. We set
          // a note instead of throwing because this is a non-critical test path.
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

    // WHY: Always show test results (pass/fail), respecting quiet mode for extra info
    if (quietMode) {
      // WHY: In quiet mode, just show minimal pass/fail summary
      const errorCount = results && Array.isArray(results.errors) ? results.errors.length : 0;
      console.log(errorCount === 0 ? 'PASS' : `FAIL (${errorCount} errors)`);
    } else {
      printSuccess(`Results written to: ${safeJsonPath}`);
      printInfo(`Errors written to: ${safeErrPath}`);
      // WHY: Verbose mode shows additional test execution details
      if (verboseMode && results) {
        log(`Tests completed. Errors: ${results.errors?.length || 0}`, 'verbose');
        if (results.randomElementInfo) {
          log(
            `Random element tested: <${results.randomElementInfo.tagName}> (index: ${results.randomElementInfo.index})`,
            'verbose'
          );
        }
      }
    }
  } catch (err) {
    // Type guard for unknown error
    const errorStack = err instanceof Error ? err.stack : String(err);
    errorLogMessages.push('[fatal in runTest] ' + errorStack);
    // SECURITY: Write error log with path validation
    const safeErrPath = validateOutputPath(errLogPath);
    writeFileSafe(safeErrPath, errorLogMessages.join('\n'), 'utf8');
    throw new Error(`Fatal error; see error log: ${safeErrPath}`);
  } finally {
    // SECURITY: Ensure browser is always cleaned up
    // WHY safeShutdown: closes if launched, disconnects if connected to
    // shared Chromium (prevents tests from killing the shared instance).
    if (browser) {
      try {
        await safeShutdown(browser, page);
      } catch {
        // WHY: safeShutdown can throw if browser crashed or connection was
        // lost. Force-killing ensures no zombie Chrome processes remain. We
        // swallow the error because cleanup should not cause test failure.
        // (Only relevant in launch mode; connect mode has nothing to kill.)
        const browserProcess = browser.process();
        if (browserProcess) {
          browserProcess.kill('SIGKILL');
        }
      }
    }
  }
}

// Run CLI only when invoked directly. When required by tests via
// in-process-cli helper, expose main() so it can be called without spawning
// a subprocess.
if (require.main === module) {
  runCLI(runTest);
}

// WHY bare runTest (not runCLI(runTest)): tests handle exit-code capture themselves.
module.exports = { main: runTest };
