#!/usr/bin/env node
/**
 * Render SVG to PNG using Puppeteer/Chrome + SvgVisualBBox
 *
 * Usage:
 *   node sbb-svg2png.cjs input.svg output.png \
 *     [--mode full|visible|element] \
 *     [--element-id ID] \
 *     [--scale N] \
 *     [--width W --height H] \
 *     [--background white|transparent|#rrggbb|...] \
 *     [--margin N] \
 *     [--auto-open]  # Opens PNG in Chrome/Chromium ONLY (not Safari!)
 *
 * Modes:
 *   --mode full
 *      Render the whole drawing, ignoring the current viewBox. The library
 *      finds the full visual bbox of the root <svg> and adjusts the viewBox.
 *
 *   --mode visible   (default)
 *      Render only the content actually inside the current viewBox.
 *      The library finds the visual bbox clipped by the viewBox and crops to it.
 *
 *   --mode element --element-id someId
 *      Render only a single element. All other elements are hidden; the viewBox
 *      is set to that element's visual bbox (in SVG user units).
 *
 * Background:
 *   --background transparent
 *      Produces a transparent PNG (via omitBackground: true).
 *   --background <css-color>
 *      Uses that color as page background (e.g. white, #333, rgba(...)).
 *
 * Margin:
 *   --margin N
 *      Extra padding in SVG user units around the computed bbox.
 *      For "visible" mode, this padding is clamped to the original viewBox so
 *      objects outside the viewBox remain ignored.
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
// WHY: sharp is used for PNG-to-JPEG conversion with 100% quality
const sharp = require('sharp');

/**
 * @typedef {Object} CLIOptions
 * @property {string} mode - Rendering mode: 'visible' | 'full' | 'element'
 * @property {string | null} elementId - Element ID for element mode
 * @property {number} scale - Resolution multiplier
 * @property {number | null} width - Override output width in pixels
 * @property {number | null} height - Override output height in pixels
 * @property {string} background - Background color
 * @property {number} margin - Extra padding in SVG user units
 * @property {boolean} autoOpen - Open PNG after rendering
 * @property {string | null} batch - Batch file path
 * @property {boolean} jpg - Also produce a JPEG version at 100% quality
 * @property {boolean} deletePngAfter - Delete PNG after creating JPG (requires --jpg)
 * @property {string | null} allowPaths - Comma-separated allowed directory paths
 * @property {boolean} trustedMode - Disable all path security restrictions
 * @property {boolean} quiet - Minimal output mode (only essential info)
 * @property {boolean} verbose - Detailed progress information
 * @property {string} [input] - Input SVG file path (single file mode)
 * @property {string} [output] - Output PNG file path (single file mode)
 */

/**
 * @typedef {Object} FilePair
 * @property {string} input - Input SVG file path
 * @property {string} output - Output PNG file path
 */
const { openInChrome } = require('./browser-utils.cjs');
const { BROWSER_TIMEOUT_MS, FONT_TIMEOUT_MS } = require('./config/timeouts.cjs');

// SECURITY: Import security utilities
const {
  validateFilePath,
  validateOutputPath,
  sanitizeSVGContent,
  SHELL_METACHARACTERS,
  SVGBBoxError: _SVGBBoxError,
  ValidationError: _ValidationError,
  FileSystemError
} = require('./lib/security-utils.cjs');

const {
  runCLI,
  printSuccess,
  printError: _printError,
  printInfo,
  printWarning,
  printBanner
} = require('./lib/cli-utils.cjs');

// ═══════════════════════════════════════════════════════════════════════════
// MODULE-LEVEL STATE FOR PATH VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * WHY: Module-level variable for allowed directories
 * This is set by main() based on --allow-paths and --trusted-mode flags
 * Used by validation functions throughout the module
 * @type {string[]|null}
 */
let MODULE_ALLOWED_DIRS = null;

/**
 * WHY: Module-level variable for trusted mode
 * When true, all path security restrictions are disabled
 * @type {boolean}
 */
let MODULE_TRUSTED_MODE = false;

/**
 * WHY: Module-level variable for quiet mode
 * When true, only essential output (file paths) is printed
 * @type {boolean}
 */
let MODULE_QUIET_MODE = false;

/**
 * WHY: Module-level variable for verbose mode
 * When true, detailed progress information is printed
 * @type {boolean}
 */
let MODULE_VERBOSE_MODE = false;

/**
 * Get the allowed directories for path validation
 * @returns {string[]|null} Array of allowed directories, or null for trusted mode
 */
function getAllowedDirs() {
  // WHY: If trusted mode, return null to skip all directory checks
  if (MODULE_TRUSTED_MODE) {
    return null;
  }
  // WHY: If allow-paths is set, use the configured dirs
  // Otherwise fall back to just CWD
  return MODULE_ALLOWED_DIRS || [process.cwd()];
}

/**
 * Log normal output (suppressed in quiet mode)
 * @param {...unknown} args - Arguments to log
 * @returns {void}
 */
function logNormal(...args) {
  if (!MODULE_QUIET_MODE) {
    console.log(...args);
  }
}

/**
 * Log verbose output (only shown in verbose mode, suppressed in quiet mode)
 * @param {...unknown} args - Arguments to log
 * @returns {void}
 */
function logVerbose(...args) {
  if (MODULE_VERBOSE_MODE && !MODULE_QUIET_MODE) {
    console.log(...args);
  }
}

// ---------- CLI parsing ----------

/**
 * Print CLI help message with usage instructions and examples
 * @returns {void}
 */
function printHelp() {
  console.log(`
╔════════════════════════════════════════════════════════════════════════════╗
║ sbb-svg2png.cjs - Render SVG to PNG via Headless Chrome             ║
╚════════════════════════════════════════════════════════════════════════════╝

DESCRIPTION:
  High-quality SVG to PNG rendering using Chrome's rendering engine with
  precise control over what gets rendered and how.

USAGE:
  node sbb-svg2png.cjs input.svg output.png [options]
  node sbb-svg2png.cjs --batch <file> [options]

ARGUMENTS:
  input.svg           Input SVG file to render
  output.png          Output PNG file path

═══════════════════════════════════════════════════════════════════════════════

RENDERING MODES (--mode):

  --mode visible      (DEFAULT)
    Render only content inside current viewBox
    Respects viewBox clipping exactly as browser would display it
    Best for: SVGs with correct viewBox already set

  --mode full
    Render whole drawing, ignoring current viewBox
    Computes full visual bbox and adjusts viewBox automatically
    Best for: SVGs with missing/incorrect viewBox, seeing all content

  --mode element --element-id <ID>
    Render single element only
    Hides all other elements, crops viewBox to element bbox
    Best for: Extracting individual objects/icons from larger SVG

═══════════════════════════════════════════════════════════════════════════════

OPTIONS:

  --mode <mode>
      Rendering mode: visible | full | element
      Default: visible

  --element-id <ID>
      Element ID to render (required with --mode element)

  --scale <number>
      Resolution multiplier (default: 4)
      Higher = better quality but larger file
      Example: --scale 2 for lower res, --scale 8 for very high res

  --width <pixels> --height <pixels>
      Override output dimensions in pixels
      If not specified, computed from viewBox and scale

  --background <color>
      Background color (default: white)
      Options:
        - transparent (for PNG transparency)
        - white, black, red, blue, etc. (CSS color names)
        - #RRGGBB (hex colors)
        - rgba(r, g, b, a) (CSS rgba format)

  --margin <number>
      Extra padding in SVG user units (default: 0)
      In visible mode, margin clamped to viewBox boundaries

  --auto-open
      Automatically open PNG in Chrome/Chromium after rendering

  --jpg
      Also produce a JPEG version of the image at 100% quality
      The PNG is always created first, then converted to JPEG
      Both files are saved by default (see --delete-png-after)
      JPEG filename is derived from PNG path (e.g., output.png -> output.jpg)

  --delete-png-after
      Delete the PNG file after creating the JPEG version
      Useful for batch processing to save disk space
      REQUIRES: --jpg must be specified (error otherwise)

  --batch <file>
      Batch processing mode using file list
      Supports two formats per line:
        - Input only: input.svg (output auto-generated as input.png)
        - Input/output pair: input.svg<TAB>output.png
      Lines starting with # are comments
      All rendering options apply to each file

  --allow-paths <dirs>
      Allow files in additional directories (comma-separated)
      By default, only files in the current working directory are allowed.
      Example: --allow-paths /tmp,/var/artifacts

  --trusted-mode
      Disable all path security restrictions
      USE WITH CAUTION - only for trusted inputs
      Allows reading/writing files anywhere on the filesystem

  --quiet
      Minimal output mode - only prints essential info (output file path)
      Useful for scripting and automation

  --verbose
      Show detailed progress information
      Includes mode, viewBox, bbox details, dimensions, background, margin

  --help, -h
      Show this help message

═══════════════════════════════════════════════════════════════════════════════

EXAMPLES:

  # Render with default settings (visible mode, white background)
  node sbb-svg2png.cjs drawing.svg output.png

  # Render full drawing regardless of viewBox
  node sbb-svg2png.cjs drawing.svg full.png --mode full

  # Render with transparent background at high resolution
  node sbb-svg2png.cjs icon.svg icon.png --background transparent --scale 8

  # Render only a specific element
  node sbb-svg2png.cjs sprites.svg logo.png \\
    --mode element --element-id logo_main --margin 5

  # Custom dimensions and background color
  node sbb-svg2png.cjs chart.svg chart.png \\
    --width 1920 --height 1080 --background "#f0f0f0"

  # Render and immediately view
  node sbb-svg2png.cjs drawing.svg preview.png --auto-open

  # Batch render with shared settings
  node sbb-svg2png.cjs --batch files.txt \\
    --mode full --scale 8 --background transparent

  # Render to PNG and also create JPEG at 100% quality
  node sbb-svg2png.cjs drawing.svg output.png --jpg

  # Batch render to JPEG only (delete PNG after conversion)
  node sbb-svg2png.cjs --batch files.txt --jpg --delete-png-after

═══════════════════════════════════════════════════════════════════════════════

MARGIN BEHAVIOR:

  SVG user units (not pixels):
    Margin is specified in the SVG's coordinate system
    Example: viewBox="0 0 100 100" with --margin 10
    → Adds 10 units on each side

  Mode-specific behavior:
    • visible mode: Margin clamped to original viewBox boundaries
    • full mode: Margin added around full drawing bbox
    • element mode: Margin added around element bbox

USE CASES:
  • Generate preview images for SVG libraries
  • Create thumbnails for SVG galleries
  • Export individual sprites/icons from sprite sheets
  • Render charts/diagrams for documentation
  • Convert SVGs for platforms that don't support SVG

`);
}

/**
 * Parse command-line arguments into options object
 * @param {string[]} argv - Process arguments array (process.argv)
 * @returns {CLIOptions} Parsed CLI options
 */
function parseArgs(argv) {
  const args = argv.slice(2);

  // Check for --help
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  /** @type {string[]} */
  const positional = [];
  /** @type {CLIOptions} */
  const options = {
    mode: 'visible',
    elementId: null,
    scale: 4,
    width: null,
    height: null,
    background: 'white',
    margin: 0,
    autoOpen: false,
    batch: null,
    jpg: false,
    deletePngAfter: false,
    allowPaths: null,
    trustedMode: false,
    quiet: false,
    verbose: false
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // WHY: TypeScript null guard - array access can return undefined
    if (!a) continue;
    if (a.startsWith('--')) {
      const [key, val] = a.split('=');
      // WHY: TypeScript null guard - destructuring can yield undefined
      if (!key) continue;
      const name = key.replace(/^--/, '');
      const next = typeof val === 'undefined' ? args[i + 1] : val;

      function useNext() {
        if (typeof val === 'undefined') {
          i++;
        }
      }

      switch (name) {
        case 'mode':
          options.mode = (next || 'visible').toLowerCase();
          useNext();
          break;
        case 'element-id':
          options.elementId = next || null;
          useNext();
          break;
        case 'scale':
          // WHY: next ?? '' provides empty string fallback for TypeScript, parseFloat handles it
          options.scale = parseFloat(next ?? '');
          useNext();
          break;
        case 'width':
          // WHY: next ?? '' provides empty string fallback for TypeScript, parseInt handles it
          options.width = parseInt(next ?? '', 10);
          useNext();
          break;
        case 'height':
          // WHY: next ?? '' provides empty string fallback for TypeScript, parseInt handles it
          options.height = parseInt(next ?? '', 10);
          useNext();
          break;
        case 'background':
          options.background = next || 'white';
          useNext();
          break;
        case 'margin':
          // WHY: next ?? '' provides empty string fallback for TypeScript, parseFloat handles it
          options.margin = parseFloat(next ?? '');
          if (!isFinite(options.margin) || options.margin < 0) {
            options.margin = 0;
          }
          useNext();
          break;
        case 'auto-open':
          options.autoOpen = true;
          break;
        case 'batch':
          options.batch = next || null;
          useNext();
          break;
        case 'jpg':
          // WHY: Produce JPEG version of PNG at 100% quality
          options.jpg = true;
          break;
        case 'delete-png-after':
          // WHY: Delete PNG after JPG creation to save disk space in batch processing
          options.deletePngAfter = true;
          break;
        case 'allow-paths':
          // WHY: Allow files in additional directories beyond CWD
          options.allowPaths = next || null;
          useNext();
          break;
        case 'trusted-mode':
          // WHY: Disable all path security restrictions (use with caution)
          options.trustedMode = true;
          break;
        case 'quiet':
          // WHY: Minimal output mode - only essential info (for scripting)
          options.quiet = true;
          break;
        case 'verbose':
          // WHY: Detailed progress information
          options.verbose = true;
          break;
        default:
          console.warn('Unknown option:', key);
      }
    } else {
      positional.push(a);
    }
  }

  // Validate required arguments
  if (!options.batch && positional.length < 2) {
    console.error('Error: You must provide input.svg and output.png (or use --batch <file>).');
    console.error('Usage: node sbb-svg2png.cjs input.svg output.png [options]');
    console.error('   or: node sbb-svg2png.cjs --batch <file> [options]');
    process.exit(1);
  }

  // Batch mode cannot have individual input/output files
  if (options.batch && positional.length > 0) {
    console.error('Error: --batch mode cannot be combined with individual SVG file arguments');
    process.exit(1);
  }

  // WHY: --delete-png-after only makes sense when --jpg is used (otherwise PNG is the only output)
  if (options.deletePngAfter && !options.jpg) {
    console.error('Error: --delete-png-after requires --jpg to be specified');
    console.error('The --delete-png-after option deletes the PNG after creating the JPG version.');
    console.error('Without --jpg, there would be no output file.');
    process.exit(1);
  }

  // Set input/output for single file mode
  if (!options.batch) {
    options.input = positional[0];
    options.output = positional[1];
  }

  return options;
}

// ---------- batch file processing ----------

/**
 * Read and parse batch file.
 * Returns array of { input, output } objects.
 *
 * Batch file format supports two formats:
 * 1. Input only (output auto-generated): input.svg
 * 2. Input/output pair (tab or space separated): input.svg<TAB>output.png
 *
 * Lines starting with # are comments and are ignored.
 * @param {string} batchFilePath - Path to the batch file
 * @returns {FilePair[]} Array of input/output file pairs
 */
function readBatchFile(batchFilePath) {
  // SECURITY: Validate batch file path
  // WHY: Use getAllowedDirs() to respect --allow-paths and --trusted-mode flags
  const safeBatchPath = validateFilePath(batchFilePath, {
    allowedDirs: getAllowedDirs(),
    requiredExtensions: ['.txt'],
    mustExist: true
  });

  const content = fs.readFileSync(safeBatchPath, 'utf-8');
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  if (lines.length === 0) {
    throw new _ValidationError(`Batch file is empty: ${safeBatchPath}`);
  }

  // Parse each line into { input, output } pairs
  const filePairs = lines.map((line, index) => {
    // Split by tab first (more reliable for paths with spaces), then by space
    // Try tab-separated first
    let parts = line
      .split('\t')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    // If only one part after tab split, try space-separated
    // WHY: Handle space-separated format for input.svg output.png pairs
    // REGEX FIX: Improved to handle paths with spaces better
    // Look for pattern: something.svg something.png (SVG + PNG files)
    if (parts.length === 1) {
      // Match: (anything ending in .svg) + (whitespace) + (anything ending in .png)
      const fileMatch = line.match(/^(.+\.svg)\s+(.+\.png)$/i);
      // WHY: Regex match returns [full, group1, group2] when successful
      // Groups are guaranteed to exist when match succeeds with two capture groups
      if (fileMatch && fileMatch[1] && fileMatch[2]) {
        parts = [fileMatch[1].trim(), fileMatch[2].trim()];
      }
    }

    // SECURITY: Validate each path for shell metacharacters
    parts.forEach((part) => {
      if (SHELL_METACHARACTERS.test(part)) {
        throw new _ValidationError(
          `Invalid file path at line ${index + 1} in batch file: contains shell metacharacters`
        );
      }
    });

    if (parts.length === 0 || !parts[0]) {
      throw new _ValidationError(`Empty line at line ${index + 1} in batch file`);
    }

    // WHY: Type assertion safe because we verified parts[0] exists above
    const inputFile = /** @type {string} */ (parts[0]);

    // If output is specified, use it; otherwise auto-generate
    /** @type {string} */
    let outputFile;
    if (parts.length >= 2 && parts[1]) {
      // Explicit output path provided
      outputFile = parts[1];
    } else {
      // Auto-generate output: <input>.png in same directory
      // WHY: Check for collisions when auto-generating output filenames
      // Prevents accidental overwrites in batch processing
      const baseName = path.basename(inputFile, path.extname(inputFile));
      const dirName = path.dirname(inputFile);
      let candidate = path.join(dirName, `${baseName}.png`);

      // Check for naming conflicts and add numeric suffix if needed
      let counter = 1;
      while (fs.existsSync(candidate)) {
        candidate = path.join(dirName, `${baseName}_${counter}.png`);
        counter++;
      }
      outputFile = candidate;
    }

    return { input: inputFile, output: outputFile };
  });

  // WHY: Handle empty batch file entries after filtering
  // Empty files should fail early with a clear message
  if (filePairs.length === 0) {
    throw new _ValidationError(`No valid entries found in batch file: ${safeBatchPath}`);
  }

  return filePairs;
}

// ---------- core render logic ----------

/**
 * SECURITY: Secure Puppeteer launch options
 * WHY: These flags are required for headless Chrome in containerized/CI environments:
 * - headless: true - Run without visible browser window
 * - --no-sandbox - Required when running as root in Docker/CI (Chrome sandbox conflicts with container sandbox)
 * - --disable-setuid-sandbox - Disables setuid sandbox (not available in containers)
 * - --disable-dev-shm-usage - Uses /tmp instead of /dev/shm (avoids shared memory issues in Docker)
 * @type {{headless: boolean, args: string[]}}
 */
const PUPPETEER_OPTIONS = {
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
};

/**
 * @typedef {Object} RenderOptions
 * @property {string} input - Input SVG file path
 * @property {string} output - Output PNG file path
 * @property {string} mode - Rendering mode: 'visible' | 'full' | 'element'
 * @property {string | null} elementId - Element ID for element mode
 * @property {number} scale - Resolution multiplier
 * @property {number | null} width - Override output width in pixels
 * @property {number | null} height - Override output height in pixels
 * @property {string} background - Background color
 * @property {number} margin - Extra padding in SVG user units
 * @property {boolean} autoOpen - Open PNG after rendering
 * @property {boolean} jpg - Also produce a JPEG version at 100% quality
 * @property {boolean} deletePngAfter - Delete PNG after creating JPG (requires --jpg)
 */

/**
 * Render an SVG file to PNG using Puppeteer/Chrome
 * @param {RenderOptions} opts - Render options
 * @returns {Promise<void>}
 */
async function renderSvgWithModes(opts) {
  const { input, output } = opts;

  // SECURITY: Validate and sanitize input path
  // WHY: Use getAllowedDirs() to respect --allow-paths and --trusted-mode flags
  const safePath = validateFilePath(input, {
    allowedDirs: getAllowedDirs(),
    requiredExtensions: ['.svg'],
    mustExist: true
  });

  // NOTE: File size limit removed to support large SVG files with embedded content (hundreds of MB)
  // WHY: We already validated the path above, so we read directly to avoid
  // readSVGFileSafe re-validating with default allowedDirs (which ignores our flags)
  const svgContent = fs.readFileSync(safePath, 'utf8');
  if (!svgContent.trim().startsWith('<') || !svgContent.includes('<svg')) {
    throw new _ValidationError('File does not appear to be valid SVG');
  }

  // SECURITY: Sanitize SVG content (remove scripts, event handlers)
  const sanitizedSvg = sanitizeSVGContent(svgContent);

  // Decide background CSS + omitBackground
  // SECURITY: Validate CSS color to prevent CSS injection
  const bgLower = (opts.background || '').toString().toLowerCase();
  const isTransparentBg = bgLower === 'transparent';
  // SECURITY: Only allow safe CSS color values (named colors, hex, rgb/rgba, hsl/hsla)
  const validColorPattern =
    /^(transparent|[a-z]{3,20}|#[0-9a-f]{3,8}|rgba?\([^)]{1,50}\)|hsla?\([^)]{1,50}\))$/i;
  const rawBgColor = isTransparentBg ? 'transparent' : opts.background || 'white';
  const bgCSS = validColorPattern.test(rawBgColor) ? rawBgColor : 'white';

  let browser = null;

  try {
    browser = await puppeteer.launch(PUPPETEER_OPTIONS);
    const page = await browser.newPage();

    // SECURITY: Set page timeout
    page.setDefaultTimeout(BROWSER_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(BROWSER_TIMEOUT_MS);

    // Create HTML with sanitized SVG
    // NOTE: No CSP header - it breaks addScriptTag functionality
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    html, body {
      margin: 0;
      padding: 0;
    }
    body {
      background: ${bgCSS};
    }
    svg {
      display: block;
    }
  </style>
</head>
<body>
${sanitizedSvg}
</body>
</html>`;

    // WHY 'domcontentloaded': networkidle0 can hang indefinitely for SVGs with web fonts
    // or missing font references. domcontentloaded is sufficient - font rendering is
    // handled separately by waitForDocumentFonts() in the library.
    await page.setContent(html, {
      waitUntil: 'domcontentloaded',
      timeout: BROWSER_TIMEOUT_MS
    });

    // Load SvgVisualBBox library
    const libPath = path.join(__dirname, 'SvgVisualBBox.js');
    if (!fs.existsSync(libPath)) {
      throw new FileSystemError('SvgVisualBBox.js not found', { path: libPath });
    }
    await page.addScriptTag({ path: libPath });

    // Let the page use the library to:
    //  - synthesize a viewBox if missing
    //  - pick a visual bbox depending on mode (full/visible/element)
    //  - apply margin in SVG units
    //  - optionally hide other elements (element mode)
    //  - compute suggested pixel width/height if not given
    let measure;
    try {
      measure = await page.evaluate(
        async (optsInPage) => {
          /* eslint-disable no-undef */
          const SvgVisualBBoxLib = window.SvgVisualBBox;
          if (!SvgVisualBBoxLib) {
            throw new Error('SvgVisualBBox not found on window. Did the script load?');
          }
          // WHY: Store in const after null check for TypeScript narrowing
          const SvgVisualBBox = SvgVisualBBoxLib;

          const svgElement = document.querySelector('svg');
          if (!svgElement) {
            throw new Error('No <svg> element found in the document.');
          }
          // WHY: Store in const after null check for TypeScript narrowing
          const svg = svgElement;

          // Ensure fonts are loaded as best as we can (with timeout)
          await SvgVisualBBox.waitForDocumentFonts(document, optsInPage.fontTimeout || 8000);

          const mode = (optsInPage.mode || 'visible').toLowerCase();
          const marginUser =
            typeof optsInPage.margin === 'number' && optsInPage.margin > 0 ? optsInPage.margin : 0;

          // Helper: ensure the root <svg> has a reasonable viewBox.
          // If missing, we use the full drawing bbox (unclipped).
          async function ensureViewBox() {
            const vb = svg.viewBox && svg.viewBox.baseVal;
            if (vb && vb.width && vb.height) {
              return { x: vb.x, y: vb.y, width: vb.width, height: vb.height };
            }
            // No viewBox → use full drawing bbox (unclipped)
            const both = await SvgVisualBBox.getSvgElementVisibleAndFullBBoxes(svg, {
              coarseFactor: 3,
              fineFactor: 24,
              useLayoutScale: true
            });
            const full = both.full;
            if (!full) {
              throw new Error('Cannot determine full drawing bbox for SVG without a viewBox.');
            }
            const newVB = {
              x: full.x,
              y: full.y,
              width: full.width,
              height: full.height
            };
            svg.setAttribute('viewBox', `${newVB.x} ${newVB.y} ${newVB.width} ${newVB.height}`);
            return newVB;
          }

          const originalViewBox = await ensureViewBox(); // used for clamping in "visible" mode
          let targetBBox = null;

          if (mode === 'full') {
            // Full drawing, ignoring current viewBox
            const both = await SvgVisualBBox.getSvgElementVisibleAndFullBBoxes(svg, {
              coarseFactor: 3,
              fineFactor: 24,
              useLayoutScale: true
            });
            if (!both.full) {
              throw new Error('Full drawing bbox is empty (nothing to render).');
            }
            targetBBox = {
              x: both.full.x,
              y: both.full.y,
              width: both.full.width,
              height: both.full.height
            };
          } else if (mode === 'element') {
            const id = optsInPage.elementId;
            if (!id) {
              throw new Error('--mode element requires --element-id');
            }
            const el = svg.ownerDocument.getElementById(id);
            if (!el) {
              throw new Error('No element found with id="' + id + '"');
            }

            const bbox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(el, {
              mode: 'unclipped',
              coarseFactor: 3,
              fineFactor: 24,
              useLayoutScale: true
            });
            if (!bbox) {
              throw new Error('Element with id="' + id + '" has no visible pixels.');
            }
            targetBBox = {
              x: bbox.x,
              y: bbox.y,
              width: bbox.width,
              height: bbox.height
            };

            // Hide everything except this element (and <defs>)
            const allowed = new Set();
            /** @type {Element | ParentNode | null} */
            let node = el;
            while (node) {
              allowed.add(node);
              // Type assertion: we know svg is an Element and node is Element | ParentNode
              if (/** @type {Element} */ (node) === svg) {
                break;
              }
              node = /** @type {Element | null} */ (node.parentNode);
            }

            // Add all descendants of the target element
            // CRITICAL: Without this, child elements like <textPath> inside <text>
            // would get display="none" and render as invisible/empty
            /**
             * Recursively add element and all descendants to allowed set
             * @param {HTMLElement} n - Element to process
             * @returns {void}
             */
            (function addDescendants(n) {
              allowed.add(n);
              const children = n.children;
              for (let i = 0; i < children.length; i++) {
                // @ts-ignore - children[i] is Element in browser context, HTMLElement in type system
                addDescendants(children[i]);
              }
            })(el);

            const all = Array.from(svg.querySelectorAll('*'));
            for (const child of all) {
              const tag = child.tagName && child.tagName.toLowerCase();
              if (tag === 'defs') {
                continue;
              }
              if (!allowed.has(child) && !child.contains(el)) {
                child.setAttribute('display', 'none');
              }
            }
          } else {
            // "visible" → content actually inside the current viewBox
            const both = await SvgVisualBBox.getSvgElementVisibleAndFullBBoxes(svg, {
              coarseFactor: 3,
              fineFactor: 24,
              useLayoutScale: true
            });
            if (!both.visible) {
              throw new Error('Visible bbox is empty (nothing inside viewBox).');
            }
            targetBBox = {
              x: both.visible.x,
              y: both.visible.y,
              width: both.visible.width,
              height: both.visible.height
            };
          }

          if (!targetBBox) {
            throw new Error('No target bounding box could be computed.');
          }

          // Apply margin in SVG units
          const expanded = {
            x: targetBBox.x,
            y: targetBBox.y,
            width: targetBBox.width,
            height: targetBBox.height
          };

          if (marginUser > 0) {
            expanded.x -= marginUser;
            expanded.y -= marginUser;
            expanded.width += marginUser * 2;
            expanded.height += marginUser * 2;
          }

          // For "visible" mode, clamp the expanded bbox to the original viewBox
          if (mode === 'visible' && expanded.width > 0 && expanded.height > 0) {
            const ov = originalViewBox;
            const bx0 = expanded.x;
            const by0 = expanded.y;
            const bx1 = expanded.x + expanded.width;
            const by1 = expanded.y + expanded.height;

            const clampedX0 = Math.max(ov.x, bx0);
            const clampedY0 = Math.max(ov.y, by0);
            const clampedX1 = Math.min(ov.x + ov.width, bx1);
            const clampedY1 = Math.min(ov.y + ov.height, by1);

            expanded.x = clampedX0;
            expanded.y = clampedY0;
            expanded.width = Math.max(0, clampedX1 - clampedX0);
            expanded.height = Math.max(0, clampedY1 - clampedY0);
          }

          // Now set the viewBox to the expanded bbox
          if (expanded.width <= 0 || expanded.height <= 0) {
            throw new Error('Expanded bbox is empty after clamping/margin.');
          }

          // CRITICAL BUG FIX: Only modify viewBox in "full" or "element" mode
          // In "visible" mode, the viewBox should remain UNCHANGED (unless it was missing)
          // Modifying the viewBox in visible mode corrupts the SVG and produces wrong PNG output
          // This was causing sbb-svg2png to systematically produce incorrect renderings
          if (mode === 'full' || mode === 'element') {
            svg.setAttribute(
              'viewBox',
              `${expanded.x} ${expanded.y} ${expanded.width} ${expanded.height}`
            );
          }
          // In "visible" mode, we keep the original viewBox - just render what's inside it

          // Compute suggested pixel size
          const scale =
            typeof optsInPage.scale === 'number' &&
            isFinite(optsInPage.scale) &&
            optsInPage.scale > 0
              ? optsInPage.scale
              : 4;

          const pixelWidth = optsInPage.width || Math.max(1, Math.round(expanded.width * scale));
          const pixelHeight = optsInPage.height || Math.max(1, Math.round(expanded.height * scale));

          // Update SVG sizing in the DOM
          svg.removeAttribute('width');
          svg.removeAttribute('height');
          svg.style.width = pixelWidth + 'px';
          svg.style.height = pixelHeight + 'px';

          return {
            mode,
            targetBBox,
            expandedBBox: expanded,
            viewBox: svg.getAttribute('viewBox'),
            pixelWidth,
            pixelHeight
          };
          /* eslint-enable no-undef */
        },
        {
          mode: opts.mode,
          elementId: opts.elementId,
          scale: opts.scale,
          width: opts.width,
          height: opts.height,
          margin: opts.margin,
          fontTimeout: FONT_TIMEOUT_MS
        }
      );
    } catch (evalError) {
      // WHY: Catch errors from page.evaluate() and provide clean error messages
      // instead of showing full stack traces for user-facing errors
      const errMsg = evalError instanceof Error ? evalError.message : String(evalError);

      // Check for element not found error
      const elementNotFoundMatch = errMsg.match(/No element found with id="([^"]+)"/);
      if (elementNotFoundMatch && elementNotFoundMatch[1]) {
        _printError(`Element not found: ${elementNotFoundMatch[1]}`);
        process.exit(1);
      }

      // Check for other known errors and show clean messages
      if (errMsg.includes('--mode element requires --element-id')) {
        _printError('--mode element requires --element-id');
        process.exit(1);
      }
      if (errMsg.includes('has no visible pixels')) {
        const idMatch = errMsg.match(/id="([^"]+)"/);
        const elementId = idMatch && idMatch[1] ? idMatch[1] : 'unknown';
        _printError(`Element "${elementId}" has no visible pixels`);
        process.exit(1);
      }

      // For other errors, re-throw to be handled by outer catch
      throw evalError;
    }

    // Now set the Puppeteer viewport to match the chosen PNG size
    await page.setViewport({
      width: measure.pixelWidth,
      height: measure.pixelHeight,
      deviceScaleFactor: 1
    });

    // Small delay to allow re-layout after we tweaked the SVG
    await new Promise((resolve) => setTimeout(resolve, 100));

    // SECURITY: Validate output path
    // WHY: Use getAllowedDirs() to respect --allow-paths and --trusted-mode flags
    // WHY: Resolve parent directory symlinks (e.g., /tmp -> /private/tmp on macOS)
    // This ensures the comparison works correctly with symlinked directories
    let resolvedOutput = output;
    try {
      const parentDir = path.dirname(path.resolve(output));
      if (fs.existsSync(parentDir)) {
        const realParent = fs.realpathSync(parentDir);
        resolvedOutput = path.join(realParent, path.basename(output));
      }
    } catch (err) {
      // If parent doesn't exist, use original path
      // WHY: Log the error in verbose mode for debugging path resolution issues
      // WHY: Type guard for unknown error in catch block
      const errMsg = err instanceof Error ? err.message : String(err);
      logVerbose('Symlink resolution failed:', errMsg);
    }
    // WHY: Only allow .jpg/.jpeg output extensions when --jpg flag is present
    // Screenshot is always PNG format; .jpg output requires --jpg for conversion
    const outputExt = path.extname(resolvedOutput).toLowerCase();
    if ((outputExt === '.jpg' || outputExt === '.jpeg') && !opts.jpg) {
      throw new _ValidationError(
        `Output file has ${outputExt} extension but screenshot is PNG format. ` +
          `Use --jpg flag for JPEG output format, or use .png extension.`
      );
    }
    const safeOutPath = validateOutputPath(resolvedOutput, {
      allowedDirs: getAllowedDirs(),
      requiredExtensions: ['.png', '.jpg', '.jpeg']
    });

    // Screenshot exactly the viewport area
    await page.screenshot({
      path: safeOutPath,
      type: 'png',
      fullPage: false,
      omitBackground: isTransparentBg,
      clip: {
        x: 0,
        y: 0,
        width: measure.pixelWidth,
        height: measure.pixelHeight
      }
    });

    // WHY: Essential output - always show output file path (even in quiet mode for scripting)
    if (MODULE_QUIET_MODE) {
      // Quiet mode: only output file path (for scripting)
      console.log(safeOutPath);
    } else {
      printSuccess(`Rendered: ${safeOutPath}`);
    }
    // WHY: Verbose output - detailed progress info
    if (MODULE_VERBOSE_MODE && !MODULE_QUIET_MODE) {
      printInfo(`mode: ${measure.mode}`);
      printInfo(`viewBox: ${measure.viewBox}`);
      console.log('  bbox (original target):', measure.targetBBox);
      console.log('  bbox (with margin):', measure.expandedBBox);
      printInfo(`size: ${measure.pixelWidth}×${measure.pixelHeight}px`);
      console.log(`  background: ${opts.background}`);
      console.log(`  margin (user units): ${opts.margin}`);
    }

    // WHY: Convert PNG to JPEG at 100% quality if --jpg option is specified
    if (opts.jpg) {
      // Derive JPEG path from PNG path (replace .png extension with .jpg)
      const jpgPath = safeOutPath.replace(/\.png$/i, '.jpg');

      // WHY: Using sharp for high-quality PNG-to-JPEG conversion
      // Quality 100 = maximum quality, minimal compression artifacts
      await sharp(safeOutPath).jpeg({ quality: 100 }).toFile(jpgPath);

      // WHY: Essential output - always show output file path (even in quiet mode for scripting)
      if (MODULE_QUIET_MODE) {
        // Quiet mode: only output file path (for scripting)
        console.log(jpgPath);
      } else {
        printSuccess(`Converted to JPEG: ${jpgPath}`);
      }

      // WHY: Delete PNG after successful JPEG creation if --delete-png-after is specified
      if (opts.deletePngAfter) {
        fs.unlinkSync(safeOutPath);
        // WHY: Verbose output - show deletion info
        if (MODULE_VERBOSE_MODE && !MODULE_QUIET_MODE) {
          printInfo(`Deleted PNG: ${safeOutPath}`);
        }
      }
    }

    // Auto-open PNG in Chrome/Chromium if requested
    // CRITICAL: Must use Chrome/Chromium (other browsers have poor image rendering)
    if (opts.autoOpen) {
      const absolutePath = path.resolve(safeOutPath);

      openInChrome(absolutePath)
        .then((result) => {
          if (result.success) {
            // WHY: Normal output - show success (but not in quiet mode)
            if (!MODULE_QUIET_MODE) {
              printSuccess(`Opened in Chrome: ${absolutePath}`);
            }
          } else {
            // WHY: result.error can be null, provide fallback message
            // WHY: Normal output - show warning (but not in quiet mode)
            if (!MODULE_QUIET_MODE) {
              printWarning(result.error ?? 'Failed to open in Chrome');
              printInfo(`Please open manually in Chrome/Chromium: ${absolutePath}`);
            }
          }
        })
        .catch((err) => {
          // WHY: Type guard for unknown error in catch block
          const errMsg = err instanceof Error ? err.message : String(err);
          // WHY: Normal output - show warning (but not in quiet mode)
          if (!MODULE_QUIET_MODE) {
            printWarning(`Failed to auto-open: ${errMsg}`);
            printInfo(`Please open manually in Chrome/Chromium: ${absolutePath}`);
          }
        });
    }
  } finally {
    // SECURITY: Ensure browser is always closed
    if (browser) {
      try {
        await browser.close();
      } catch (err) {
        // Force kill if close fails
        // WHY: Log the error in verbose mode for debugging browser cleanup issues
        // WHY: Type guard for unknown error in catch block
        const errMsg = err instanceof Error ? err.message : String(err);
        logVerbose('Browser close failed, force killing:', errMsg);
        // WHY: browser.process() can return null if browser was not launched
        const browserProcess = browser.process();
        if (browserProcess) {
          browserProcess.kill('SIGKILL');
        }
      }
    }
  }
}

// ---------- entry point ----------

/**
 * Main entry point for sbb-svg2png CLI
 * Parses arguments and renders SVG to PNG (single file or batch mode)
 * @returns {Promise<void>}
 */
async function main() {
  const opts = parseArgs(process.argv);

  // WHY: Initialize module-level output control from args
  // Must be set before any output is printed
  MODULE_QUIET_MODE = opts.quiet;
  MODULE_VERBOSE_MODE = opts.verbose;

  // WHY: Display banner with tool name and version (respects quiet mode)
  printBanner('sbb-svg2png', { quiet: opts.quiet, json: false });

  // WHY: Initialize module-level path security from args
  // --trusted-mode allows ALL paths (disables all restrictions)
  // --allow-paths allows specific comma-separated directories
  if (opts.trustedMode) {
    // WHY: Trusted mode disables all path restrictions
    MODULE_TRUSTED_MODE = true;
    // WHY: Show warning in verbose mode only (unless quiet)
    if (MODULE_VERBOSE_MODE && !MODULE_QUIET_MODE) {
      printWarning('Trusted mode enabled - path restrictions disabled');
    }
  } else if (opts.allowPaths) {
    // WHY: Parse comma-separated list of allowed directories
    // Also resolve symlinks to handle macOS /tmp -> /private/tmp
    const extraPaths = opts.allowPaths
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);

    // WHY: Include both original paths and their real paths to handle symlinks
    // On macOS, /tmp is a symlink to /private/tmp, so we need both
    const resolvedPaths = new Set([process.cwd()]);
    for (const p of extraPaths) {
      resolvedPaths.add(p);
      try {
        // Also add the realpath if it's different (symlink resolution)
        const realPath = fs.realpathSync(p);
        if (realPath !== p) {
          resolvedPaths.add(realPath);
        }
      } catch {
        // Directory doesn't exist yet, just use original path
      }
    }
    MODULE_ALLOWED_DIRS = Array.from(resolvedPaths);
    // WHY: Show allowed paths in verbose mode only
    if (MODULE_VERBOSE_MODE && !MODULE_QUIET_MODE) {
      printInfo(`Allowed paths: ${MODULE_ALLOWED_DIRS.join(', ')}`);
    }
  } else {
    // WHY: Default to CWD only (most secure)
    MODULE_ALLOWED_DIRS = [process.cwd()];
  }

  // BATCH MODE: Render multiple SVG files
  if (opts.batch) {
    const filePairs = readBatchFile(opts.batch);

    logNormal(`Processing ${filePairs.length} SVG files from ${opts.batch}...\n`);

    /** @type {Array<{success: boolean, input: string, output?: string, error?: string}>} */
    const results = [];
    for (let i = 0; i < filePairs.length; i++) {
      const filePair = filePairs[i];
      // WHY: Defensive check even though array bounds are valid
      if (!filePair) continue;
      const { input: svgPath, output: pngPath } = filePair;

      logNormal(`[${i + 1}/${filePairs.length}] Rendering ${svgPath}...`);
      logVerbose(`    Target: ${pngPath}`);

      try {
        // WHY: Validate input file exists before attempting rendering
        // Prevents cryptic Puppeteer errors when file is missing
        if (!fs.existsSync(svgPath)) {
          throw new _SVGBBoxError(`Input file not found: ${svgPath}`);
        }

        // Use the same rendering options for all files in batch
        await renderSvgWithModes({
          input: svgPath,
          output: pngPath,
          mode: opts.mode,
          elementId: opts.elementId,
          scale: opts.scale,
          width: opts.width,
          height: opts.height,
          background: opts.background,
          margin: opts.margin,
          autoOpen: false, // Never auto-open in batch mode
          jpg: opts.jpg,
          deletePngAfter: opts.deletePngAfter
        });

        results.push({
          success: true,
          input: svgPath,
          output: pngPath
        });
      } catch (error) {
        // WHY: Type guard for unknown error in catch block
        const errMsg = error instanceof Error ? error.message : String(error);
        results.push({
          success: false,
          input: svgPath,
          error: errMsg
        });

        _printError(`  ✗ Failed: ${errMsg}`);
      }
    }

    // Summary
    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    logNormal(`\n${'═'.repeat(78)}`);
    logNormal(`Summary: ${successful} successful, ${failed} failed`);
    logNormal('═'.repeat(78));

    return;
  }

  // SINGLE FILE MODE
  // WHY: Type guard - opts.input/output are set in parseArgs when not in batch mode
  if (!opts.input || !opts.output) {
    throw new Error('Input and output paths are required in single file mode');
  }
  await renderSvgWithModes({
    input: opts.input,
    output: opts.output,
    mode: opts.mode,
    elementId: opts.elementId,
    scale: opts.scale,
    width: opts.width,
    height: opts.height,
    background: opts.background,
    margin: opts.margin,
    autoOpen: opts.autoOpen,
    jpg: opts.jpg,
    deletePngAfter: opts.deletePngAfter
  });
}

runCLI(main);
