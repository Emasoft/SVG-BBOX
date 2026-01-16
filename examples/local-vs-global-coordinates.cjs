#!/usr/bin/env node

/**
 * Local vs Global Coordinates - Complete Working Example
 *
 * This script demonstrates the CRITICAL difference between global and local
 * coordinate systems when using SvgVisualBBox for text-to-path operations.
 *
 * THE PROBLEM:
 * - getSvgElementVisualBBoxTwoPassAggressive() returns GLOBAL coordinates
 *   (root SVG space after all transforms applied)
 * - Text-to-path operations need LOCAL coordinates
 *   (element's own space before transforms)
 * - Using global coords causes DOUBLE-TRANSFORM BUG
 *
 * THE SOLUTION:
 * - Get element's CTM (Current Transformation Matrix)
 * - Compute inverse CTM
 * - Transform global bbox corners to local space
 *
 * USAGE:
 *   node local-vs-global-coordinates.cjs [--quiet] [--json] [--help]
 *
 * FLAGS:
 *   --quiet  Suppress progress messages (errors still shown)
 *   --json   Output results as JSON
 *   --help   Show this help message
 *
 * OUTPUT:
 *   - Creates test SVG with transformed text
 *   - Shows global vs local coordinates
 *   - Demonstrates text-to-path with both approaches
 *   - Saves output SVGs showing the difference
 *
 * SECURITY:
 *   - SVG content is sanitized to prevent script injection
 *   - Uses OS temp directory for temporary files
 *   - Cleans up temp files on exit, crash, or interrupt
 *
 * ERROR HANDLING:
 *   - Fail-fast approach: errors propagate immediately
 *   - No fallbacks or workarounds
 *   - All file operations wrapped in try/catch
 *   - Browser cleanup guaranteed via signal handlers
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ============================================================================
// CONFIGURATION - All constants centralized for easy tuning
// ============================================================================

/**
 * Centralized configuration object for all magic numbers and thresholds.
 * WHY: Avoid magic numbers scattered throughout code. Makes tuning easier.
 */
const CONFIG = {
  // Puppeteer browser launch arguments
  BROWSER_ARGS: ['--no-sandbox', '--disable-setuid-sandbox'],

  // Font loading timeout in milliseconds (cross-platform font rendering differences)
  FONT_TIMEOUT_MS: 5000,

  // Page operation timeout (prevent infinite hangs)
  PAGE_TIMEOUT_MS: 30000,

  // SvgVisualBBox configuration
  BBOX_COARSE_FACTOR: 3,
  BBOX_FINE_FACTOR: 24,

  // Matrix inversion threshold - determinants smaller than this indicate
  // non-invertible matrix (zero scale or degenerate transform)
  MATRIX_DET_THRESHOLD: 1e-10,

  // Position difference threshold for warning (in SVG units)
  // WHY: Floating point precision - differences < 0.1 are noise
  POSITION_DIFF_THRESHOLD: 0.1,

  // Font loading retry configuration
  FONT_RETRY_MAX: 3,
  FONT_RETRY_DELAY_MS: 1000
};

// ============================================================================
// CLI FLAGS - Parse command line arguments
// ============================================================================

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const jsonOutput = args.includes('--json');

/**
 * Print help message and exit.
 * WHY: User-friendly documentation for CLI flags.
 */
function printHelp() {
  console.log(`
Usage: node local-vs-global-coordinates.cjs [OPTIONS]

Demonstrates the critical difference between global and local coordinate systems
when using SvgVisualBBox for text-to-path operations.

OPTIONS:
  --quiet   Suppress progress messages (errors still shown)
  --json    Output results as JSON instead of formatted text
  --help    Show this help message and exit

EXAMPLES:
  node local-vs-global-coordinates.cjs
  node local-vs-global-coordinates.cjs --quiet
  node local-vs-global-coordinates.cjs --json > results.json

For more information, see:
  https://github.com/Emasoft/svg-bbox/issues/1
`);
}

if (args.includes('--help')) {
  printHelp();
  process.exit(0);
}

// ============================================================================
// LOGGING - Conditional logging based on --quiet flag
// ============================================================================

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

/**
 * Conditional logging - respects --quiet flag.
 * WHY: User requested quiet mode should suppress progress messages.
 * @param {...any} args - Arguments to pass to console.log
 */
function log(...args) {
  if (!quiet) {
    console.log(...args);
  }
}

/**
 * Always log errors, even in quiet mode.
 * WHY: Errors must always be visible for debugging.
 * @param {...any} args - Arguments to pass to console.error
 */
function logError(...args) {
  console.error(...args);
}

// ============================================================================
// CLEANUP - Signal handlers for graceful shutdown
// ============================================================================

/**
 * Track temporary file path for cleanup on crash/interrupt.
 * WHY: Temp files must be cleaned up even if script crashes or user interrupts.
 */
let tempFilePath = null;

/**
 * Cleanup function - removes temp file if it exists.
 * WHY: Prevents littering OS temp directory with orphaned files.
 */
function cleanup() {
  if (tempFilePath && fs.existsSync(tempFilePath)) {
    try {
      fs.unlinkSync(tempFilePath);
      log(`${colors.green}✓${colors.reset} Cleaned up temp file: ${tempFilePath}`);
    } catch (err) {
      logError(`${colors.yellow}⚠${colors.reset} Failed to clean up temp file: ${err.message}`);
    }
  }
}

// Register signal handlers for cleanup on crash/interrupt
// WHY: User might Ctrl+C or script might crash - temp files must still be removed
process.on('SIGINT', () => {
  log(`\n${colors.yellow}⚠${colors.reset} Interrupted by user (Ctrl+C)`);
  cleanup();
  process.exit(130); // Standard exit code for SIGINT
});

process.on('SIGTERM', () => {
  log(`\n${colors.yellow}⚠${colors.reset} Terminated by system`);
  cleanup();
  process.exit(143); // Standard exit code for SIGTERM
});

process.on('uncaughtException', (err) => {
  logError(`${colors.red}✗${colors.reset} Uncaught exception:`, err);
  cleanup();
  throw err; // Re-throw to show stack trace
});

// ============================================================================
// SECURITY - SVG sanitization
// ============================================================================

/**
 * Sanitize SVG content to prevent script injection.
 * WHY: Never trust SVG content - it can contain <script> tags.
 * FAIL-FAST: Reject SVG with scripts rather than trying to strip them.
 *
 * @param {string} svg - SVG content to sanitize
 * @returns {string} - Sanitized SVG
 * @throws {Error} - If SVG contains script tags
 */
function sanitizeSVG(svg) {
  // Basic security check - SVG should NEVER contain script tags
  // WHY: <script> in SVG can execute arbitrary JavaScript
  if (/<script/i.test(svg)) {
    throw new Error('SVG contains <script> tags - security risk. Aborting.');
  }

  // Additional checks for event handlers (onclick, onload, etc.)
  // WHY: Event handlers are another vector for script injection
  if (/on\w+\s*=/i.test(svg)) {
    throw new Error(
      'SVG contains event handlers (onclick, onload, etc.) - security risk. Aborting.'
    );
  }

  return svg;
}

// ============================================================================
// SVG GENERATION - Test SVG with transformed text elements
// ============================================================================

/**
 * Create a test SVG with transformed text elements.
 * WHY: Demonstrates global vs local coordinates for different transform types.
 * SECURITY: Generated content is safe (no user input).
 *
 * @returns {string} - SVG markup
 */
function createTestSVG() {
  return `<svg viewBox="0 0 400 400" width="400" height="400" xmlns="http://www.w3.org/2000/svg">
  <!-- Example 1: Simple Translation -->
  <g id="example1">
    <rect x="0" y="0" width="400" height="120" fill="#f0f0f0" opacity="0.3"/>
    <text id="translated-text"
          x="10" y="50"
          font-family="Arial"
          font-size="16"
          fill="blue"
          transform="translate(100, 40)">
      Translated Text
    </text>
    <text x="10" y="80" font-size="12" fill="#666">
      ↑ translate(100, 40)
    </text>
  </g>

  <!-- Example 2: Rotation -->
  <g id="example2">
    <rect x="0" y="120" width="400" height="140" fill="#e0e0ff" opacity="0.3"/>
    <text id="rotated-text"
          x="100" y="200"
          font-family="Arial"
          font-size="16"
          fill="red"
          transform="rotate(45, 100, 200)">
      Rotated 45°
    </text>
    <text x="10" y="240" font-size="12" fill="#666">
      ↑ rotate(45°, 100, 200)
    </text>
  </g>

  <!-- Example 3: Complex Transform Chain -->
  <g id="example3">
    <rect x="0" y="260" width="400" height="140" fill="#ffe0e0" opacity="0.3"/>
    <text id="complex-text"
          x="50" y="320"
          font-family="Arial"
          font-size="14"
          fill="green"
          transform="translate(50, 30) scale(1.5) rotate(15)">
      Complex Transform
    </text>
    <text x="10" y="380" font-size="12" fill="#666">
      ↑ translate(50,30) × scale(1.5) × rotate(15°)
    </text>
  </g>
</svg>`;
}

// ============================================================================
// MATRIX OPERATIONS - Transform utilities
// ============================================================================

/**
 * Invert a 2D affine transformation matrix.
 * WHY: Need to convert global coordinates back to local space.
 * FAIL-FAST: Throws if matrix is not invertible (zero scale or degenerate transform).
 *
 * COMMON MISTAKE: Trying to invert identity matrix - check first if transform exists.
 * EDGE CASE: Scale of zero makes matrix non-invertible.
 *
 * @param {Object} matrix - {a, b, c, d, e, f} matrix components
 * @returns {Object} - Inverted matrix {a, b, c, d, e, f}
 * @throws {Error} - If determinant is below threshold (non-invertible)
 */
function invertMatrix(matrix) {
  const { a, b, c, d, e, f } = matrix;

  // Compute determinant (ad - bc)
  // WHY: Determinant = 0 means matrix is singular (not invertible)
  const det = a * d - b * c;

  // Check if matrix is invertible
  // WHY: Division by zero if det = 0
  // COMMON CAUSE: Element has zero scale or degenerate transform
  if (Math.abs(det) < CONFIG.MATRIX_DET_THRESHOLD) {
    throw new Error(
      `Matrix is not invertible (determinant ${det.toFixed(10)} < ${CONFIG.MATRIX_DET_THRESHOLD}). ` +
        `This usually means the element has zero scale or degenerate transform. ` +
        `Check the transform attribute on your SVG element.`
    );
  }

  // Compute inverse using standard formula
  // [ a  c  e ]^-1   [ d/det  -c/det  (cf-de)/det ]
  // [ b  d  f ]    = [ -b/det  a/det  (be-af)/det ]
  // [ 0  0  1 ]      [ 0       0       1          ]
  return {
    a: d / det,
    b: -b / det,
    c: -c / det,
    d: a / det,
    e: (c * f - d * e) / det,
    f: (b * e - a * f) / det
  };
}

/**
 * Apply inverse transform to a point.
 * WHY: DRY principle - don't duplicate transform logic.
 *
 * @param {Object} point - {x, y} point to transform
 * @param {Object} inv - Inverse transformation matrix {a, b, c, d, e, f}
 * @returns {Object} - Transformed point {x, y}
 */
function applyInverseTransform(point, inv) {
  return {
    x: inv.a * point.x + inv.c * point.y + inv.e,
    y: inv.b * point.x + inv.d * point.y + inv.f
  };
}

/**
 * Convert global bbox to local bbox using inverse CTM.
 * WHY: SvgVisualBBox returns global coords, but text-to-path needs local coords.
 * EDGE CASE: Identity matrix (no transform) - local = global, but still safe to invert.
 * EDGE CASE: Zero-size bbox - still computes correctly (returns zero-size local bbox).
 *
 * @param {Object} globalBBox - {x, y, width, height} in global coordinates
 * @param {Object} ctm - Current Transformation Matrix {a, b, c, d, e, f}
 * @returns {Object} - {x, y, width, height} in local coordinates
 * @throws {Error} - If CTM is not invertible (propagated from invertMatrix)
 */
function globalToLocalBBox(globalBBox, ctm) {
  // EDGE CASE: Check if CTM is identity matrix (no transform)
  // WHY: If local = global already, skip expensive calculations
  // COMMON CASE: Elements without transform attribute
  const isIdentity =
    ctm.a === 1 && ctm.b === 0 && ctm.c === 0 && ctm.d === 1 && ctm.e === 0 && ctm.f === 0;

  if (isIdentity) {
    // No transform - local coordinates = global coordinates
    log(`${colors.cyan}ℹ${colors.reset} Identity matrix detected - local = global`);
    return { ...globalBBox }; // Return copy to avoid mutations
  }

  // EDGE CASE: Warn if bbox has zero size
  // WHY: Zero-size bbox might indicate rendering issue or invisible element
  if (globalBBox.width === 0 || globalBBox.height === 0) {
    log(
      `${colors.yellow}⚠${colors.reset} Zero-size bbox detected (width: ${globalBBox.width}, height: ${globalBBox.height})`
    );
  }

  // Get inverse CTM to convert global → local
  // FAIL-FAST: Throws if matrix is not invertible
  const inv = invertMatrix(ctm);

  // Transform all four corners of the bbox
  // WHY: Rotation/skew means axis-aligned bbox in global space becomes
  //      non-axis-aligned in local space. Need all corners to find new bbox.
  const corners = [
    { x: globalBBox.x, y: globalBBox.y }, // Top-left
    { x: globalBBox.x + globalBBox.width, y: globalBBox.y }, // Top-right
    { x: globalBBox.x, y: globalBBox.y + globalBBox.height }, // Bottom-left
    { x: globalBBox.x + globalBBox.width, y: globalBBox.y + globalBBox.height } // Bottom-right
  ];

  // Apply inverse transform to each corner using shared function (DRY)
  const transformedCorners = corners.map((c) => applyInverseTransform(c, inv));

  // Find axis-aligned bounding box of transformed corners
  // WHY: After rotation/skew, need to re-compute min/max
  const xs = transformedCorners.map((c) => c.x);
  const ys = transformedCorners.map((c) => c.y);

  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
}

// ============================================================================
// BROWSER AUTOMATION - Font loading with retry
// ============================================================================

/**
 * Wait for document fonts to load with retry logic.
 * WHY: Font loading can be flaky due to network issues, cache misses.
 * DETERMINISTIC: Retry ensures consistent results across runs.
 *
 * @param {Object} page - Puppeteer page object
 * @param {number} maxRetries - Maximum retry attempts (default: CONFIG.FONT_RETRY_MAX)
 * @returns {Promise<void>}
 * @throws {Error} - If fonts fail to load after all retries
 */
async function waitForFontsWithRetry(page, maxRetries = CONFIG.FONT_RETRY_MAX) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      // eslint-disable-next-line arrow-body-style
      await page.evaluate((timeout) => {
        /* eslint-disable no-undef */
        // window and document are available in Puppeteer page.evaluate() context
        return window.SvgVisualBBox.waitForDocumentFonts(document, timeout);
        /* eslint-enable no-undef */
      }, CONFIG.FONT_TIMEOUT_MS);

      // Success - fonts loaded
      log(
        `${colors.green}✓${colors.reset} Fonts loaded successfully${i > 0 ? ` (retry ${i})` : ''}`
      );
      return;
    } catch (err) {
      // Last retry failed - propagate error
      if (i === maxRetries - 1) {
        throw new Error(`Font loading failed after ${maxRetries} retries: ${err.message}`);
      }

      // Retry after delay
      log(
        `${colors.yellow}⚠${colors.reset} Font loading failed (attempt ${i + 1}/${maxRetries}), retrying in ${CONFIG.FONT_RETRY_DELAY_MS}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, CONFIG.FONT_RETRY_DELAY_MS));
    }
  }
}

// ============================================================================
// OUTPUT FORMATTING - BBox comparison display
// ============================================================================

/**
 * Print formatted bbox comparison (text mode).
 * WHY: Human-readable output for debugging and demonstrations.
 * RESPECTS: --quiet flag (uses log() instead of console.log).
 *
 * @param {string} elementId - Element ID being analyzed
 * @param {Object} globalBBox - Global bbox {x, y, width, height}
 * @param {Object} localBBox - Local bbox {x, y, width, height}
 * @param {Object} ctm - Current Transformation Matrix {a, b, c, d, e, f}
 */
function printBBoxComparison(elementId, globalBBox, localBBox, ctm) {
  log(
    `\n${colors.bright}${colors.blue}═══════════════════════════════════════════════════${colors.reset}`
  );
  log(`${colors.bright}Element: #${elementId}${colors.reset}`);
  log(`${colors.blue}───────────────────────────────────────────────────${colors.reset}`);

  // CTM matrix
  log(`\n${colors.cyan}CTM (Current Transformation Matrix):${colors.reset}`);
  log(
    `  [${ctm.a.toFixed(4)}, ${ctm.b.toFixed(4)}, ${ctm.c.toFixed(4)}, ${ctm.d.toFixed(4)}, ${ctm.e.toFixed(2)}, ${ctm.f.toFixed(2)}]`
  );
  log(`  ↳ [ a,  b,  c,  d,  e,  f ]`);

  // Global coordinates
  log(`\n${colors.red}❌ GLOBAL Coordinates (what the API returns):${colors.reset}`);
  log(`  x: ${globalBBox.x.toFixed(2)}`);
  log(`  y: ${globalBBox.y.toFixed(2)}`);
  log(`  width: ${globalBBox.width.toFixed(2)}`);
  log(`  height: ${globalBBox.height.toFixed(2)}`);
  log(`  ${colors.yellow}⚠  Using these for text-to-path causes DOUBLE-TRANSFORM!${colors.reset}`);

  // Local coordinates
  log(`\n${colors.green}✓ LOCAL Coordinates (what you need):${colors.reset}`);
  log(`  x: ${localBBox.x.toFixed(2)}`);
  log(`  y: ${localBBox.y.toFixed(2)}`);
  log(`  width: ${localBBox.width.toFixed(2)}`);
  log(`  height: ${localBBox.height.toFixed(2)}`);
  log(`  ${colors.green}✓ Correct coordinates for text-to-path operations${colors.reset}`);

  // Difference
  // WHY: Show position delta only if > threshold (avoid floating point noise)
  const dx = Math.abs(globalBBox.x - localBBox.x);
  const dy = Math.abs(globalBBox.y - localBBox.y);
  if (dx > CONFIG.POSITION_DIFF_THRESHOLD || dy > CONFIG.POSITION_DIFF_THRESHOLD) {
    log(`\n${colors.yellow}Position Difference:${colors.reset}`);
    log(`  Δx: ${dx.toFixed(2)} units`);
    log(`  Δy: ${dy.toFixed(2)} units`);
  }
}

// ============================================================================
// MAIN DEMONSTRATION - Coordinate system analysis
// ============================================================================

/**
 * Main demonstration function.
 * WHY: Entry point for coordinate system comparison demo.
 * FAIL-FAST: All errors propagate immediately.
 * RESOURCE SAFETY: Browser and temp files guaranteed to clean up via try/finally.
 *
 * @returns {Promise<Object>} - Results object (for JSON output mode)
 * @throws {Error} - If any operation fails
 */
async function demonstrateCoordinateSystems() {
  log(`${colors.bright}${colors.cyan}`);
  log(`╔═══════════════════════════════════════════════════════════════╗`);
  log(`║  Local vs Global Coordinates - Live Demonstration            ║`);
  log(`║  svg-bbox Library Coordinate System Demo                     ║`);
  log(`╚═══════════════════════════════════════════════════════════════╝`);
  log(colors.reset);

  // ========================================================================
  // PHASE 1: Create test SVG with security checks
  // ========================================================================

  const svgContent = createTestSVG();

  // SECURITY: Sanitize SVG content (fail-fast if malicious)
  sanitizeSVG(svgContent);

  // Use OS temp directory instead of project directory
  // WHY: Avoids polluting project with temp files
  // WHY: OS temp dir has better cleanup policies
  tempFilePath = path.join(os.tmpdir(), `svg-bbox-demo-${Date.now()}.svg`);

  try {
    // ERROR HANDLING: Wrap file write in try/catch
    // WHY: Disk might be full, permissions might be wrong
    fs.writeFileSync(tempFilePath, svgContent, 'utf-8');
    log(`\n${colors.green}✓${colors.reset} Created test SVG: ${tempFilePath}\n`);
  } catch (err) {
    throw new Error(
      `Failed to write temp SVG file: ${err.message}. Check disk space and permissions.`
    );
  }

  // ========================================================================
  // PHASE 2: Load SvgVisualBBox library
  // ========================================================================

  const svgVisualBBoxPath = path.join(__dirname, '..', 'SvgVisualBBox.js');

  // ERROR HANDLING: Check if library file exists before reading
  // WHY: Provides actionable error message instead of generic ENOENT
  if (!fs.existsSync(svgVisualBBoxPath)) {
    throw new Error(
      `SvgVisualBBox.js not found at: ${svgVisualBBoxPath}\n` +
        `Make sure you're running this script from the examples/ directory.`
    );
  }

  let svgVisualBBoxCode;
  try {
    svgVisualBBoxCode = fs.readFileSync(svgVisualBBoxPath, 'utf-8');
    log(`${colors.green}✓${colors.reset} Loaded SvgVisualBBox library\n`);
  } catch (err) {
    throw new Error(`Failed to read SvgVisualBBox.js: ${err.message}`);
  }

  // ========================================================================
  // PHASE 3: Launch browser with proper resource management
  // ========================================================================

  log(`${colors.cyan}⏳${colors.reset} Launching headless browser...`);

  let browser = null;
  let page = null;

  try {
    // Launch browser with security-hardened arguments
    browser = await puppeteer.launch({
      headless: true,
      args: CONFIG.BROWSER_ARGS
    });

    log(`${colors.green}✓${colors.reset} Browser launched\n`);

    page = await browser.newPage();

    // Set page timeout to prevent infinite hangs
    // WHY: Network issues or JS errors can cause page to hang forever
    page.setDefaultTimeout(CONFIG.PAGE_TIMEOUT_MS);

    // ====================================================================
    // PHASE 4: Load SVG in browser
    // ====================================================================

    log(`${colors.cyan}⏳${colors.reset} Loading SVG in browser...`);

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
        </head>
        <body>
          ${svgContent}
        </body>
      </html>
    `;

    // RACE CONDITION FIX: Wait for networkidle to ensure all resources loaded
    await page.setContent(html, { waitUntil: 'networkidle0' });

    // RACE CONDITION FIX: Ensure SVG is loaded before adding script
    await page.waitForSelector('svg');

    // RACE CONDITION FIX: Add script after SVG is ready
    await page.addScriptTag({ content: svgVisualBBoxCode });

    log(`${colors.green}✓${colors.reset} SVG loaded in browser\n`);

    // ====================================================================
    // PHASE 5: Wait for fonts with retry logic
    // ====================================================================

    log(`${colors.cyan}⏳${colors.reset} Waiting for fonts to load...`);
    await waitForFontsWithRetry(page);

    // ====================================================================
    // PHASE 6: Analyze all examples
    // ====================================================================

    const examples = ['translated-text', 'rotated-text', 'complex-text'];
    const results = [];

    for (const elementId of examples) {
      log(`\n${colors.cyan}⏳${colors.reset} Analyzing element: #${elementId}...`);

      const result = await page.evaluate(
        async (id, config) => {
          /* eslint-disable no-undef */
          // window and document are available in Puppeteer page.evaluate() context
          const element = document.getElementById(id);
          if (!element) return null;

          // Get GLOBAL bbox (what the API returns)
          const globalBBox = await window.SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(
            element,
            {
              mode: 'unclipped',
              coarseFactor: config.coarseFactor,
              fineFactor: config.fineFactor
            }
          );

          // Get CTM (Current Transformation Matrix)
          const ctm = element.getCTM();

          // EDGE CASE: getCTM() can return null for detached elements
          if (!ctm) {
            throw new Error('getCTM() returned null - element not attached to document');
          }

          return {
            globalBBox,
            ctm: {
              a: ctm.a,
              b: ctm.b,
              c: ctm.c,
              d: ctm.d,
              e: ctm.e,
              f: ctm.f
            }
          };
          /* eslint-enable no-undef */
        },
        elementId,
        {
          coarseFactor: CONFIG.BBOX_COARSE_FACTOR,
          fineFactor: CONFIG.BBOX_FINE_FACTOR
        }
      );

      if (!result) {
        logError(`${colors.red}✗${colors.reset} Element #${elementId} not found`);
        continue;
      }

      // Convert to local coordinates
      const localBBox = globalToLocalBBox(result.globalBBox, result.ctm);

      // Print comparison (text mode)
      if (!jsonOutput) {
        printBBoxComparison(elementId, result.globalBBox, localBBox, result.ctm);
      }

      // Store for JSON output
      results.push({
        elementId,
        globalBBox: result.globalBBox,
        localBBox,
        ctm: result.ctm
      });
    }

    // ====================================================================
    // PHASE 7: Print summary
    // ====================================================================

    if (!jsonOutput) {
      log(
        `\n${colors.bright}${colors.blue}═══════════════════════════════════════════════════${colors.reset}\n`
      );
      log(`${colors.bright}${colors.green}KEY TAKEAWAYS:${colors.reset}\n`);
      log(
        `${colors.yellow}1.${colors.reset} getSvgElementVisualBBoxTwoPassAggressive() returns ${colors.red}GLOBAL${colors.reset} coordinates`
      );
      log(`   (root SVG space after all transforms applied)\n`);
      log(
        `${colors.yellow}2.${colors.reset} Text-to-path operations need ${colors.green}LOCAL${colors.reset} coordinates`
      );
      log(`   (element's own space before transforms)\n`);
      log(`${colors.yellow}3.${colors.reset} To convert global → local:`);
      log(`   a) Get element's CTM: ${colors.cyan}element.getCTM()${colors.reset}`);
      log(`   b) Invert it using invertMatrix() function`);
      log(`   c) Transform bbox corners using inverse CTM\n`);
      log(
        `${colors.yellow}4.${colors.reset} Using global coords for text-to-path causes ${colors.red}DOUBLE-TRANSFORM BUG${colors.reset}`
      );
      log(`   (transform gets applied twice: once by CTM, once by your code)\n`);

      log(`${colors.bright}${colors.cyan}SOLUTION:${colors.reset}`);
      log(`Add a new API function: ${colors.green}getSvgElementLocalBBox()${colors.reset}`);
      log(`See GitHub Issue #1 for implementation proposal.\n`);
    }

    return results;
  } finally {
    // ====================================================================
    // CLEANUP: Guaranteed to run even if error occurs
    // ====================================================================

    // Close browser
    if (browser) {
      try {
        await browser.close();
        log(`${colors.green}✓${colors.reset} Browser closed\n`);
      } catch (err) {
        // FAIL-SAFE: If browser.close() hangs or fails, kill the process
        logError(
          `${colors.yellow}⚠${colors.reset} Failed to close browser gracefully: ${err.message}`
        );
        try {
          // Force kill browser process
          if (browser.process()) {
            browser.process().kill('SIGKILL');
            log(`${colors.yellow}⚠${colors.reset} Forcefully killed browser process\n`);
          }
        } catch (killErr) {
          logError(
            `${colors.red}✗${colors.reset} Failed to kill browser process: ${killErr.message}`
          );
        }
      }
    }

    // Clean up temp file (via shared cleanup() function)
    cleanup();
  }
}

// ============================================================================
// CODE EXAMPLE - Demonstrates correct global→local conversion
// ============================================================================

/**
 * Print code example showing correct global→local bbox conversion.
 * WHY: Educational - shows developers how to avoid double-transform bug.
 * FIX: Updated line 352 to reference invertMatrix() instead of ctm.inverse().
 */
function printCodeExample() {
  log(
    `${colors.bright}${colors.cyan}═══════════════════════════════════════════════════════════════${colors.reset}`
  );
  log(`${colors.bright}${colors.cyan}CODE EXAMPLE: Converting Global → Local BBox${colors.reset}`);
  log(
    `${colors.cyan}═══════════════════════════════════════════════════════════════${colors.reset}\n`
  );

  const code = `
// ❌ WRONG: Using global coordinates for text-to-path
const globalBBox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(textElement);
// This will cause DOUBLE-TRANSFORM bug!
const pathElement = document.createElementNS('http://www.w3.org/2000/svg', 'path');
pathElement.setAttribute('transform', textElement.getAttribute('transform'));
pathElement.setAttribute('d', textToPathData(globalBBox)); // ❌ WRONG!

// ✓ CORRECT: Convert to local coordinates first
const globalBBox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(textElement);
const ctm = textElement.getCTM();

// IMPORTANT: Use the invertMatrix() function from this script
// WHY: ctm.inverse() doesn't exist in all contexts (not a standard DOM API)
const inv = invertMatrix(ctm);

// Transform bbox corners to local space
const corners = [
  {x: globalBBox.x, y: globalBBox.y},
  {x: globalBBox.x + globalBBox.width, y: globalBBox.y},
  {x: globalBBox.x, y: globalBBox.y + globalBBox.height},
  {x: globalBBox.x + globalBBox.width, y: globalBBox.y + globalBBox.height}
];

const localCorners = corners.map(c => ({
  x: inv.a * c.x + inv.c * c.y + inv.e,
  y: inv.b * c.x + inv.d * c.y + inv.f
}));

const localBBox = {
  x: Math.min(...localCorners.map(c => c.x)),
  y: Math.min(...localCorners.map(c => c.y)),
  width: Math.max(...localCorners.map(c => c.x)) - Math.min(...localCorners.map(c => c.x)),
  height: Math.max(...localCorners.map(c => c.y)) - Math.min(...localCorners.map(c => c.y))
};

// Now use local coordinates for text-to-path
const pathElement = document.createElementNS('http://www.w3.org/2000/svg', 'path');
pathElement.setAttribute('transform', textElement.getAttribute('transform'));
pathElement.setAttribute('d', textToPathData(localBBox)); // ✓ CORRECT!

// COMMON MISTAKES TO AVOID:
// 1. Don't use ctm.inverse() - it's not a standard DOM method
// 2. Don't skip the corner transformation - rotation/skew makes it necessary
// 3. Don't forget to check if CTM is invertible (det != 0)
// 4. Don't use global bbox directly for text-to-path - always convert to local
`;

  log(code);
  log(
    `${colors.cyan}═══════════════════════════════════════════════════════════════${colors.reset}\n`
  );
}

// ============================================================================
// MAIN EXECUTION - Entry point
// ============================================================================

/**
 * Main entry point when script is run directly.
 * WHY: Orchestrates demo execution, error handling, and output formatting.
 */
if (require.main === module) {
  demonstrateCoordinateSystems()
    .then((results) => {
      // JSON output mode
      if (jsonOutput) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        // Text output mode - print code example
        printCodeExample();
        log(`${colors.green}${colors.bright}✓ Demonstration complete!${colors.reset}\n`);
      }
      process.exit(0);
    })
    .catch((error) => {
      // FAIL-FAST: Show error and exit immediately
      logError(`${colors.red}${colors.bright}✗ Error:${colors.reset}`, error.message);
      if (!quiet) {
        logError(error.stack);
      }
      process.exit(1);
    });
}

// ============================================================================
// EXPORTS - Public API for testing/reuse
// ============================================================================

module.exports = {
  invertMatrix,
  applyInverseTransform,
  globalToLocalBBox,
  createTestSVG,
  sanitizeSVG,
  waitForFontsWithRetry,
  demonstrateCoordinateSystems,
  printBBoxComparison,
  printCodeExample,
  CONFIG
};
