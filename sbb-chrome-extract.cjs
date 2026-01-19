#!/usr/bin/env node
/**
 * sbb-chrome-extract.cjs - Extract SVG elements using Chrome's native .getBBox()
 *
 * This tool demonstrates the standard SVG .getBBox() method's behavior for comparison
 * with SvgVisualBBox and Inkscape extraction methods.
 */

/**
 * @typedef {Object} BBox
 * @property {number} x - X coordinate
 * @property {number} y - Y coordinate
 * @property {number} width - Width
 * @property {number} height - Height
 */

/**
 * @typedef {Object} ExtractOptions
 * @property {string} inputFile - Path to input SVG file
 * @property {string} elementId - ID of element to extract
 * @property {string} outputSvg - Path for output SVG file
 * @property {string|null} outputPng - Path for output PNG file (optional)
 * @property {number} margin - Margin around bbox in SVG units
 * @property {string} background - Background color for PNG
 * @property {number} scale - Resolution multiplier for PNG
 * @property {number|null} width - Exact PNG width in pixels (optional)
 * @property {number|null} height - Exact PNG height in pixels (optional)
 */

/**
 * @typedef {Object} RenderOptions
 * @property {number|null} width - Exact PNG width in pixels (optional)
 * @property {number|null} height - Exact PNG height in pixels (optional)
 * @property {number} scale - Resolution multiplier
 * @property {string} background - Background color
 * @property {BBox} viewBox - ViewBox dimensions
 */

/**
 * @typedef {Object} ParsedOptions
 * @property {string|null} id - Element ID to extract
 * @property {string|null} output - Output SVG file path
 * @property {string|null} png - Output PNG file path (optional)
 * @property {number} margin - Margin around bbox
 * @property {number} scale - Resolution multiplier
 * @property {number|null} width - Exact PNG width
 * @property {number|null} height - Exact PNG height
 * @property {string} background - Background color
 * @property {string|null} batch - Batch file path (optional)
 * @property {string} [input] - Input SVG file path (set in single mode)
 * @property {boolean} quiet - Minimal output mode (only essential info)
 * @property {boolean} verbose - Detailed progress information
 */

/**
 * @typedef {Object} BatchEntry
 * @property {string} input - Input SVG file path
 * @property {string} objectId - Element ID to extract
 * @property {string} output - Output SVG file path
 */

/**
 * @typedef {Object} BatchResult
 * @property {string} inputPath - Input file path
 * @property {string} objectId - Element ID
 * @property {string} outputPath - Output file path
 * @property {string} [error] - Error message if failed
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { getVersion } = require('./version.cjs');
const { printError, printSuccess, printInfo, printBanner, runCLI } = require('./lib/cli-utils.cjs');
// SECURITY: Import security utilities
const { SHELL_METACHARACTERS, SVGBBoxError } = require('./lib/security-utils.cjs');

// WHY: Module-level flags for output verbosity control
// Set by parseArgs() and respected by log functions
let MODULE_QUIET = false;
let MODULE_VERBOSE = false;

/**
 * Log info message (respects quiet/verbose flags)
 * @param {string} message - Message to log
 * @param {'info'|'verbose'|'essential'} level - Message level
 *   - 'info': Normal output, suppressed in quiet mode
 *   - 'verbose': Only shown in verbose mode
 *   - 'essential': Always shown (file paths, errors)
 */
function log(message, level = 'info') {
  if (level === 'essential') {
    // WHY: Essential output (file paths) always shown
    console.log(message);
  } else if (level === 'verbose') {
    // WHY: Verbose output only in verbose mode (and not in quiet mode)
    if (MODULE_VERBOSE && !MODULE_QUIET) {
      console.log(message);
    }
  } else {
    // WHY: Normal info output suppressed in quiet mode
    if (!MODULE_QUIET) {
      console.log(message);
    }
  }
}

/**
 * Extract SVG element using native .getBBox() method
 * @param {ExtractOptions} options - Extraction options
 * @returns {Promise<void>}
 */
async function extractWithGetBBox(options) {
  const { inputFile, elementId, outputSvg, outputPng, margin, background, scale, width, height } =
    options;

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();

    // Read the SVG file
    const svgContent = fs.readFileSync(inputFile, 'utf-8');

    // Load it into the page
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { margin: 0; padding: 0; }
            svg { display: block; }
          </style>
        </head>
        <body>${svgContent}</body>
      </html>
    `);

    // Get bbox using standard .getBBox()
    const result = await page.evaluate(
      (id, marginValue) => {
        const element = /** @type {SVGGraphicsElement} */ (
          /* eslint-disable-next-line no-undef */
          /** @type {unknown} */ (document.getElementById(id))
        );
        if (!element) {
          throw new Error(`Element with id "${id}" not found`);
        }

        // Get the standard SVG .getBBox()
        const bbox = element.getBBox();

        // Get SVG root and its viewBox
        const svg = element.ownerSVGElement;

        // Apply margin
        const bboxWithMargin = {
          x: bbox.x - marginValue,
          y: bbox.y - marginValue,
          width: bbox.width + 2 * marginValue,
          height: bbox.height + 2 * marginValue
        };

        return {
          bbox: bboxWithMargin,
          originalBbox: {
            x: bbox.x,
            y: bbox.y,
            width: bbox.width,
            height: bbox.height
          },
          svgViewBox: svg ? svg.getAttribute('viewBox') : null,
          element: {
            tagName: element.tagName,
            id: element.id
          }
        };
      },
      elementId,
      margin
    );

    // WHY: Verbose output for bbox dimensions
    log(
      `Standard .getBBox() result: ${result.originalBbox.width.toFixed(2)} × ${result.originalBbox.height.toFixed(2)}`,
      'verbose'
    );
    log(
      `With margin (${margin}): ${result.bbox.width.toFixed(2)} × ${result.bbox.height.toFixed(2)}`,
      'verbose'
    );

    // Create a new SVG with just this element and the getBBox dimensions
    const extractedSvg = await page.evaluate(
      (id, bbox) => {
        const element = /** @type {SVGGraphicsElement} */ (
          /* eslint-disable-next-line no-undef */
          /** @type {unknown} */ (document.getElementById(id))
        );
        const svg = element.ownerSVGElement;
        if (!svg) {
          throw new Error('Element is not part of an SVG document');
        }

        // Clone the element
        const clone = element.cloneNode(true);

        // Get defs if any
        const defs = svg.querySelectorAll('defs');
        let defsContent = '';
        defs.forEach((def) => {
          defsContent += /** @type {Element} */ (def).outerHTML + '\n';
        });

        // Create new SVG with viewBox set to getBBox result
        const newViewBox = `${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}`;

        return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg id="getbbox_extraction" version="1.1" x="0px" y="0px" width="${bbox.width}" height="${bbox.height}" viewBox="${newViewBox}" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg">
${defsContent}${/** @type {Element} */ (clone).outerHTML}
</svg>`;
      },
      elementId,
      result.bbox
    );

    // Write the extracted SVG
    fs.writeFileSync(outputSvg, extractedSvg);
    // WHY: File paths are essential output (always shown, even in quiet mode)
    log(`SVG extracted to: ${outputSvg}`, 'essential');

    // Render PNG if requested
    if (outputPng) {
      await renderToPng(page, extractedSvg, outputPng, {
        width,
        height,
        scale,
        background,
        viewBox: result.bbox
      });
      // WHY: File paths are essential output (always shown, even in quiet mode)
      log(`PNG rendered to: ${outputPng}`, 'essential');
    }
  } finally {
    await browser.close();
  }
}

/**
 * Render SVG to PNG using Puppeteer
 * @param {import('puppeteer').Page} page - Puppeteer page instance
 * @param {string} svgContent - SVG content to render
 * @param {string} outputPath - Output PNG file path
 * @param {RenderOptions} options - Render options
 * @returns {Promise<void>}
 */
async function renderToPng(page, svgContent, outputPath, options) {
  const { width, height, scale, background, viewBox } = options;

  // SECURITY FIX (S9): Check for zero-dimension viewBox to prevent division by zero
  // WHY: If viewBox.width or viewBox.height is 0, division would produce NaN or Infinity,
  // leading to invalid PNG dimensions or Puppeteer errors
  if (viewBox.width === 0 || viewBox.height === 0) {
    throw new SVGBBoxError(
      `Cannot render PNG: viewBox has zero ${viewBox.width === 0 ? 'width' : 'height'} (element may have no visible content)`
    );
  }

  // Calculate dimensions
  let pngWidth, pngHeight;
  if (width && height) {
    pngWidth = width;
    pngHeight = height;
  } else if (width) {
    pngWidth = width;
    pngHeight = Math.round((width / viewBox.width) * viewBox.height);
  } else if (height) {
    pngHeight = height;
    pngWidth = Math.round((height / viewBox.height) * viewBox.width);
  } else {
    // Use scale factor
    pngWidth = Math.round(viewBox.width * scale);
    pngHeight = Math.round(viewBox.height * scale);
  }

  // Set page size
  await page.setViewport({
    width: pngWidth,
    height: pngHeight,
    deviceScaleFactor: 1
  });

  // Determine background style
  let bgStyle = '';
  if (background === 'transparent') {
    bgStyle = 'background: transparent;';
  } else {
    bgStyle = `background: ${background};`;
  }

  // Render the SVG
  await page.setContent(`
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          html, body {
            width: ${pngWidth}px;
            height: ${pngHeight}px;
            ${bgStyle}
            overflow: hidden;
          }
          svg {
            display: block;
            width: 100%;
            height: 100%;
          }
        </style>
      </head>
      <body>${svgContent}</body>
    </html>
  `);

  // Take screenshot
  await page.screenshot({
    path: outputPath,
    type: 'png',
    omitBackground: background === 'transparent'
  });

  // WHY: PNG details are verbose output
  log(
    `PNG size: ${pngWidth}×${pngHeight}px (scale: ${scale}x, background: ${background})`,
    'verbose'
  );
}

/**
 * Print help message
 * @returns {void}
 */
function printHelp() {
  const version = getVersion();
  console.log(`
╔════════════════════════════════════════════════════════════════════════════╗
║ sbb-chrome-extract - Extract using Chrome .getBBox()                      ║
╚════════════════════════════════════════════════════════════════════════════╝

ℹ Version ${version}

DESCRIPTION:
  Extract SVG elements using Chrome's native .getBBox() method.
  This tool is for comparison with SvgVisualBBox and Inkscape extraction.

USAGE:
  sbb-chrome-extract input.svg --id <element-id> --output <output.svg> [options]
  sbb-chrome-extract --batch <file> [options]

REQUIRED ARGUMENTS (SINGLE MODE):
  input.svg               Input SVG file path
  --id <element-id>       ID of the element to extract

OUTPUT OPTIONS:
  --output <path>         Output SVG file path (required in single mode)
  --png <path>            Also render PNG to this path (optional)

BATCH PROCESSING:
  --batch <file>          Process multiple extractions from batch file
                          Format per line: input.svg object_id output.svg
                          (tab or space separated)
                          Lines starting with # are comments

BATCH FILE FORMAT:
  Each line contains: input.svg object_id output.svg
  - Tab-separated or space-separated
  - Lines starting with # are comments

  Example batch file (extractions.txt):
    # Extract text elements from drawing
    drawing.svg text39 text39.svg
    drawing.svg text40 text40.svg
    drawing.svg logo logo.svg

BBOX OPTIONS:
  --margin <number>       Margin around bbox in SVG units (default: 5)

PNG RENDERING OPTIONS:
  --scale <number>        Resolution multiplier (default: 4)
                          Higher = better quality but larger file

  --width <pixels>        Exact PNG width in pixels
  --height <pixels>       Exact PNG height in pixels
                          If only one dimension specified, other is computed
                          If both omitted, uses scale factor

  --background <color>    Background color (default: transparent)
                          Options:
                            - transparent (PNG transparency)
                            - white, black, red, etc. (CSS colors)
                            - #RRGGBB (hex colors)
                            - rgba(r,g,b,a) (CSS rgba format)

GENERAL OPTIONS:
  --help, -h              Show this help message
  --version, -v           Show version number
  --quiet                 Minimal output - only prints extracted file paths
                          Useful for scripting and automation
  --verbose               Show detailed progress information

═══════════════════════════════════════════════════════════════════════════════

EXAMPLES:

  # Extract element with default margin
  sbb-chrome-extract drawing.svg --id text39 --output text39.svg

  # Extract and render PNG with transparent background
  sbb-chrome-extract drawing.svg --id text39 \\
    --output text39.svg --png text39.png

  # Extract with custom margin and white background PNG
  sbb-chrome-extract drawing.svg --id logo \\
    --output logo.svg --png logo.png \\
    --margin 10 --background white

  # Extract with exact PNG dimensions at high resolution
  sbb-chrome-extract chart.svg --id graph \\
    --output graph.svg --png graph.png \\
    --width 1920 --height 1080 --background "#f0f0f0"

  # Extract with custom scale and colored background
  sbb-chrome-extract icon.svg --id main_icon \\
    --output icon.svg --png icon.png \\
    --scale 8 --background "rgba(255, 255, 255, 0.9)"

  # Batch extraction from file list
  sbb-chrome-extract --batch extractions.txt

  # Batch extraction with margin and PNG output
  sbb-chrome-extract --batch extractions.txt --margin 10

═══════════════════════════════════════════════════════════════════════════════

COMPARISON NOTES:

  This tool uses Chrome's native .getBBox() method, which:
  • Uses geometric calculations based on element bounds
  • Often OVERSIZES vertically due to font metrics (ascender/descender)
  • Ignores visual effects like filters, shadows, glows
  • May not accurately reflect actual rendered pixels

  Compare with:
  • sbb-extract: Uses SvgVisualBBox (pixel-accurate canvas rasterization)
  • sbb-inkscape-extract: Uses Inkscape (often UNDERSIZES due to font issues)

USE CASES:
  • Demonstrate .getBBox() limitations vs SvgVisualBBox
  • Create comparison test cases
  • Benchmark against other extraction methods
  • Educational purposes showing why accurate bbox matters
`);
}

/**
 * Read and parse batch file list.
 * Returns array of { input, objectId, output } objects.
 *
 * Batch file format:
 * - Each line: input.svg object_id output.svg
 * - Tab or space separated
 * - Lines starting with # are comments
 *
 * @param {string} batchFilePath - Path to batch file
 * @returns {BatchEntry[]} Array of batch entries
 */
function readBatchFile(batchFilePath) {
  // Check batch file exists
  if (!fs.existsSync(batchFilePath)) {
    throw new SVGBBoxError(`Batch file not found: ${batchFilePath}`);
  }

  const content = fs.readFileSync(batchFilePath, 'utf-8');
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  if (lines.length === 0) {
    throw new SVGBBoxError(`Batch file is empty: ${batchFilePath}`);
  }

  // Parse each line into { input, objectId, output } objects
  const entries = lines.map((line, index) => {
    // Split by tab first (more reliable for paths with spaces), then by space
    let parts = line
      .split('\t')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    // If only one part after tab split, try space-separated
    // WHY: Handle space-separated format, but be careful with paths containing spaces
    // REGEX FIX: Match .svg file, then non-whitespace object ID, then .svg file
    // This works for paths with spaces if they're quoted or separated clearly
    if (parts.length === 1) {
      // Look for pattern: input.svg object_id output.svg (three parts)
      // Match: (anything ending in .svg) + (whitespace) + (non-whitespace ID) + (whitespace) + (anything ending in .svg)
      const svgMatch = line.match(/^(.+\.svg)\s+(\S+)\s+(.+\.svg)$/i);
      // WHY: Regex has 3 capturing groups, so indices 1-3 are always defined when match succeeds
      if (svgMatch && svgMatch[1] && svgMatch[2] && svgMatch[3]) {
        parts = [svgMatch[1].trim(), svgMatch[2].trim(), svgMatch[3].trim()];
      }
    }

    // SECURITY: Validate each path for shell metacharacters
    parts.forEach((part) => {
      if (SHELL_METACHARACTERS.test(part)) {
        throw new SVGBBoxError(
          `Invalid file path at line ${index + 1} in batch file: contains shell metacharacters`
        );
      }
    });

    if (parts.length < 3) {
      throw new SVGBBoxError(
        `Invalid format at line ${index + 1} in batch file.\n` +
          `Expected: input.svg object_id output.svg\n` +
          `Got: ${line}`
      );
    }

    // WHY: We verified parts.length >= 3 above, so indices 0-2 are always defined
    const inputFile = /** @type {string} */ (parts[0]);
    const objectId = /** @type {string} */ (parts[1]);
    const outputFile = /** @type {string} */ (parts[2]);

    return { input: inputFile, objectId, output: outputFile };
  });

  // WHY: Handle empty batch file entries after filtering
  // Empty files should fail early with a clear message
  if (entries.length === 0) {
    throw new SVGBBoxError(`No valid entries found in batch file: ${batchFilePath}`);
  }

  return entries;
}

/**
 * Parse command line arguments
 * @param {string[]} argv - Command line arguments array (process.argv)
 * @returns {ParsedOptions} Parsed options object
 */
function parseArgs(argv) {
  const args = argv.slice(2);

  // Check for --help
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  // Check for --version
  if (args.includes('--version') || args.includes('-v')) {
    console.log(getVersion());
    process.exit(0);
  }

  /** @type {string[]} */
  const positional = [];
  /** @type {ParsedOptions} */
  const options = {
    id: null,
    output: null,
    png: null,
    margin: 5,
    scale: 4,
    width: null,
    height: null,
    background: 'transparent',
    batch: null,
    input: undefined,
    quiet: false,
    verbose: false
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // WHY: TypeScript doesn't know args[i] is always defined within the loop bounds
    if (!a) continue;
    if (a.startsWith('--')) {
      const splitResult = a.split('=');
      const key = splitResult[0];
      const val = splitResult[1];
      // WHY: key is always defined since split always returns at least one element
      if (!key) continue;
      const name = key.replace(/^--/, '');
      const next = typeof val === 'undefined' ? args[i + 1] : val;

      function useNext() {
        if (typeof val === 'undefined') {
          i++;
        }
      }

      switch (name) {
        case 'batch':
          options.batch = next || null;
          useNext();
          break;
        case 'id':
          options.id = next || null;
          useNext();
          break;
        case 'output':
          options.output = next || null;
          useNext();
          break;
        case 'png':
          options.png = next || null;
          useNext();
          break;
        case 'margin':
          // WHY: parseFloat needs a string, but next could be undefined - use empty string as fallback (results in NaN)
          options.margin = parseFloat(next || '');
          if (!isFinite(options.margin) || options.margin < 0) {
            printError('Margin must be a non-negative number');
            process.exit(1);
          }
          useNext();
          break;
        case 'scale':
          // WHY: parseFloat needs a string, but next could be undefined - use empty string as fallback (results in NaN)
          options.scale = parseFloat(next || '');
          if (!isFinite(options.scale) || options.scale <= 0 || options.scale > 20) {
            printError('Scale must be between 0 and 20');
            process.exit(1);
          }
          useNext();
          break;
        case 'width': {
          // WHY: parseInt needs a string, use empty string fallback (results in NaN)
          const widthVal = parseInt(next || '', 10);
          // SECURITY FIX (2026-01-05 audit): Validate NaN to prevent silent failures
          if (Number.isNaN(widthVal) || widthVal <= 0) {
            printError(`Invalid width value: ${next} (must be a positive integer)`);
            process.exit(1);
          }
          options.width = widthVal;
          useNext();
          break;
        }
        case 'height': {
          // WHY: parseInt needs a string, use empty string fallback (results in NaN)
          const heightVal = parseInt(next || '', 10);
          // SECURITY FIX (2026-01-05 audit): Validate NaN to prevent silent failures
          if (Number.isNaN(heightVal) || heightVal <= 0) {
            printError(`Invalid height value: ${next} (must be a positive integer)`);
            process.exit(1);
          }
          options.height = heightVal;
          useNext();
          break;
        }
        case 'background':
          options.background = next || 'transparent';
          useNext();
          break;
        case 'quiet':
          // WHY: Quiet mode - only output essential info (extracted file paths)
          options.quiet = true;
          break;
        case 'verbose':
          // WHY: Verbose mode - show detailed progress information
          options.verbose = true;
          break;
        default:
          printError(`Unknown option: ${key}`);
          process.exit(1);
      }
    } else {
      positional.push(a);
    }
  }

  // Validate batch vs single mode
  if (options.batch && positional.length > 0) {
    printError('Cannot use both --batch and input file argument');
    process.exit(1);
  }

  // Validate required arguments
  if (!options.batch && positional.length < 1) {
    printError('Missing required argument: input.svg');
    console.log('\nUsage: sbb-chrome-extract input.svg --id <element-id> --output <output.svg>');
    console.log('   or: sbb-chrome-extract --batch <file> [options]');
    process.exit(1);
  }

  // In single mode, --id and --output are required
  // In batch mode, they are NOT required (come from batch file)
  if (!options.batch) {
    if (!options.id) {
      printError('Missing required option: --id <element-id>');
      process.exit(1);
    }

    if (!options.output) {
      printError('Missing required option: --output <output.svg>');
      process.exit(1);
    }

    options.input = positional[0];

    // SECURITY FIX (S10): Validate paths for shell metacharacters in single mode
    // WHY: Same security validation applied to batch mode should apply to single mode
    // Prevents command injection if paths are ever used in shell contexts
    if (options.input && SHELL_METACHARACTERS.test(options.input)) {
      printError('Invalid input path: contains shell metacharacters');
      process.exit(1);
    }
    if (options.output && SHELL_METACHARACTERS.test(options.output)) {
      printError('Invalid output path: contains shell metacharacters');
      process.exit(1);
    }
    if (options.png && SHELL_METACHARACTERS.test(options.png)) {
      printError('Invalid PNG path: contains shell metacharacters');
      process.exit(1);
    }

    // Check input file exists
    // WHY: TypeScript needs explicit null check since options.input is string | undefined
    const inputPath = options.input;
    if (!inputPath || !fs.existsSync(inputPath)) {
      printError(`Input file not found: ${options.input ?? '(none)'}`);
      process.exit(1);
    }
  }

  return options;
}

/**
 * Main CLI entry point
 * @returns {Promise<void>}
 */
async function main() {
  const options = parseArgs(process.argv);

  // WHY: Set module-level flags before any output
  MODULE_QUIET = options.quiet;
  MODULE_VERBOSE = options.verbose;

  // WHY: Print banner unless quiet mode
  printBanner('sbb-chrome-extract', { quiet: options.quiet, json: false });

  // BATCH MODE
  if (options.batch) {
    const entries = readBatchFile(options.batch);
    /** @type {BatchResult[]} */
    const results = [];

    // WHY: Batch progress info suppressed in quiet mode
    if (!MODULE_QUIET) {
      printInfo(`Processing ${entries.length} extraction(s) in batch mode...\n`);
    }

    for (let i = 0; i < entries.length; i++) {
      // WHY: TypeScript needs explicit null check for array element access
      const entry = entries[i];
      if (!entry) continue;
      const { input: inputFile, objectId, output: outputFile } = entry;

      try {
        // WHY: Validate input file exists before attempting extraction
        // Prevents cryptic Puppeteer errors when file is missing
        if (!fs.existsSync(inputFile)) {
          throw new SVGBBoxError(`Input file not found: ${inputFile}`);
        }

        // WHY: Progress info suppressed in quiet mode
        if (!MODULE_QUIET) {
          printInfo(`[${i + 1}/${entries.length}] Extracting "${objectId}" from ${inputFile}...`);
        }

        /** @type {ExtractOptions} */
        const extractOptions = {
          inputFile,
          elementId: objectId,
          outputSvg: outputFile,
          outputPng: null, // PNG not supported in batch mode (could be extended)
          margin: options.margin,
          background: options.background,
          scale: options.scale,
          width: options.width,
          height: options.height
        };

        await extractWithGetBBox(extractOptions);

        results.push({
          inputPath: inputFile,
          objectId,
          outputPath: outputFile,
          error: undefined
        });

        // WHY: Success indicator suppressed in quiet mode (file path already shown by extractWithGetBBox)
        if (!MODULE_QUIET) {
          console.log(`  ✓ ${path.basename(outputFile)}`);
        }
      } catch (err) {
        // WHY: TypeScript requires type guard for catch block errors (type 'unknown')
        const errorMessage = err instanceof Error ? err.message : String(err);
        /** @type {BatchResult} */
        const errorResult = {
          inputPath: inputFile,
          objectId,
          outputPath: outputFile,
          error: errorMessage
        };
        results.push(errorResult);

        // WHY: Errors always shown (essential output)
        console.error(`  ✗ Failed: ${inputFile}`);
        console.error(`    ${errorMessage}`);
      }
    }

    // Output batch summary
    // WHY: Summary suppressed in quiet mode
    if (!MODULE_QUIET) {
      console.log('');
      const successful = results.filter((r) => !r.error).length;
      const failed = results.filter((r) => r.error).length;

      if (failed === 0) {
        printSuccess(`Batch complete! ${successful}/${entries.length} extraction(s) successful.`);
      } else {
        printInfo(`Batch complete with errors: ${successful} succeeded, ${failed} failed.`);
      }
    }

    return;
  }

  // SINGLE FILE MODE
  // WHY: In single mode, parseArgs() validates these fields exist before returning.
  // TypeScript doesn't know this, so we use non-null assertions.
  if (!options.input || !options.id || !options.output) {
    // This should never happen due to parseArgs validation, but satisfies TypeScript
    throw new SVGBBoxError('Missing required options in single mode');
  }
  /** @type {ExtractOptions} */
  const extractOptions = {
    inputFile: options.input,
    elementId: options.id,
    outputSvg: options.output,
    outputPng: options.png,
    margin: options.margin,
    background: options.background,
    scale: options.scale,
    width: options.width,
    height: options.height
  };

  // Run extraction
  await extractWithGetBBox(extractOptions);
}

// Run CLI
runCLI(main);

module.exports = { extractWithGetBBox };
