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
 * @property {string} [input] - Input SVG file path (single file mode)
 * @property {string} [output] - Output PNG file path (single file mode)
 */

/**
 * @typedef {Object} FilePair
 * @property {string} input - Input SVG file path
 * @property {string} output - Output PNG file path
 */
const { execFile: _execFile } = require('child_process');
const { openInChrome } = require('./browser-utils.cjs');
const {
  getVersion,
  printVersion: _printVersion,
  hasVersionFlag: _hasVersionFlag
} = require('./version.cjs');
const { BROWSER_TIMEOUT_MS, FONT_TIMEOUT_MS } = require('./config/timeouts.cjs');

// SECURITY: Import security utilities
const {
  validateFilePath,
  validateOutputPath,
  readSVGFileSafe,
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
  printWarning
} = require('./lib/cli-utils.cjs');

// ---------- CLI parsing ----------

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

  --batch <file>
      Batch processing mode using file list
      Supports two formats per line:
        - Input only: input.svg (output auto-generated as input.png)
        - Input/output pair: input.svg<TAB>output.png
      Lines starting with # are comments
      All rendering options apply to each file

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
    batch: null
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
  const safeBatchPath = validateFilePath(batchFilePath, {
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

// SECURITY: Secure Puppeteer options
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
 */

/**
 * Render an SVG file to PNG using Puppeteer/Chrome
 * @param {RenderOptions} opts - Render options
 * @returns {Promise<void>}
 */
async function renderSvgWithModes(opts) {
  const { input, output } = opts;

  // SECURITY: Validate and sanitize input path
  const safePath = validateFilePath(input, {
    requiredExtensions: ['.svg'],
    mustExist: true
  });

  // SECURITY: Read SVG with size limit and validation
  const svgContent = readSVGFileSafe(safePath);

  // SECURITY: Sanitize SVG content (remove scripts, event handlers)
  const sanitizedSvg = sanitizeSVGContent(svgContent);

  // Decide background CSS + omitBackground
  const bgLower = (opts.background || '').toString().toLowerCase();
  const isTransparentBg = bgLower === 'transparent';
  const bgCSS = isTransparentBg ? 'transparent' : opts.background || 'white';

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

    await page.setContent(html, {
      waitUntil: 'networkidle0',
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
    const measure = await page.evaluate(
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
          typeof optsInPage.scale === 'number' && isFinite(optsInPage.scale) && optsInPage.scale > 0
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

    // Now set the Puppeteer viewport to match the chosen PNG size
    await page.setViewport({
      width: measure.pixelWidth,
      height: measure.pixelHeight,
      deviceScaleFactor: 1
    });

    // Small delay to allow re-layout after we tweaked the SVG
    await new Promise((resolve) => setTimeout(resolve, 100));

    // SECURITY: Validate output path
    const safeOutPath = validateOutputPath(output, {
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

    printSuccess(`Rendered: ${safeOutPath}`);
    printInfo(`mode: ${measure.mode}`);
    printInfo(`viewBox: ${measure.viewBox}`);
    console.log('  bbox (original target):', measure.targetBBox);
    console.log('  bbox (with margin):', measure.expandedBBox);
    printInfo(`size: ${measure.pixelWidth}×${measure.pixelHeight}px`);
    console.log(`  background: ${opts.background}`);
    console.log(`  margin (user units): ${opts.margin}`);

    // Auto-open PNG in Chrome/Chromium if requested
    // CRITICAL: Must use Chrome/Chromium (other browsers have poor image rendering)
    if (opts.autoOpen) {
      const absolutePath = path.resolve(safeOutPath);

      openInChrome(absolutePath)
        .then((result) => {
          if (result.success) {
            printSuccess(`Opened in Chrome: ${absolutePath}`);
          } else {
            // WHY: result.error can be null, provide fallback message
            printWarning(result.error ?? 'Failed to open in Chrome');
            printInfo(`Please open manually in Chrome/Chromium: ${absolutePath}`);
          }
        })
        .catch((err) => {
          // WHY: Type guard for unknown error in catch block
          const errMsg = err instanceof Error ? err.message : String(err);
          printWarning(`Failed to auto-open: ${errMsg}`);
          printInfo(`Please open manually in Chrome/Chromium: ${absolutePath}`);
        });
    }
  } finally {
    // SECURITY: Ensure browser is always closed
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Force kill if close fails
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

async function main() {
  // Display version
  printInfo(`sbb-svg2png v${getVersion()} | svg-bbox toolkit\n`);

  const opts = parseArgs(process.argv);

  // BATCH MODE: Render multiple SVG files
  if (opts.batch) {
    const filePairs = readBatchFile(opts.batch);

    console.log(`Processing ${filePairs.length} SVG files from ${opts.batch}...\n`);

    /** @type {Array<{success: boolean, input: string, output?: string, error?: string}>} */
    const results = [];
    for (let i = 0; i < filePairs.length; i++) {
      const filePair = filePairs[i];
      // WHY: Defensive check even though array bounds are valid
      if (!filePair) continue;
      const { input: svgPath, output: pngPath } = filePair;

      console.log(`[${i + 1}/${filePairs.length}] Rendering ${svgPath}...`);
      console.log(`    Target: ${pngPath}`);

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
          autoOpen: false // Never auto-open in batch mode
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

    console.log(`\n${'═'.repeat(78)}`);
    console.log(`Summary: ${successful} successful, ${failed} failed`);
    console.log('═'.repeat(78));

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
    autoOpen: opts.autoOpen
  });
}

runCLI(main);
