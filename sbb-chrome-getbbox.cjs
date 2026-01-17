#!/usr/bin/env node
/**
 * sbb-chrome-getbbox.cjs - Get bounding box using Chrome's native .get BBox()
 *
 * This tool demonstrates the standard SVG .getBBox() method's behavior for comparison
 * with SvgVisualBBox algorithm. It returns bbox information without extraction.
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { getVersion } = require('./version.cjs');

// Import CLI utilities including shared JSON output function
// WHY: writeJSONOutput centralizes JSON output handling (DRY principle)
// DO NOT: Implement custom saveJSON - use writeJSONOutput instead
// NOTE: printSuccess removed - writeJSONOutput handles success feedback internally
const { printError, printInfo, runCLI, writeJSONOutput } = require('./lib/cli-utils.cjs');

/**
 * @typedef {Object} BBoxRect
 * @property {number} x - X coordinate
 * @property {number} y - Y coordinate
 * @property {number} width - Width
 * @property {number} height - Height
 */

/**
 * @typedef {Object} BBoxResultSuccess
 * @property {BBoxRect} bbox - Bounding box with margin applied
 * @property {BBoxRect} originalBbox - Original bounding box without margin
 * @property {string | null} [svgViewBox] - SVG viewBox attribute (for WHOLE CONTENT)
 * @property {{tagName: string, id: string}} [element] - Element info (for specific elements)
 */

/**
 * @typedef {Object} BBoxResultError
 * @property {string} error - Error message
 */

/**
 * @typedef {BBoxResultSuccess | BBoxResultError} BBoxResult
 */

/**
 * @typedef {Object.<string, BBoxResult>} BBoxResults
 */

/**
 * @typedef {Object} GetBBoxResult
 * @property {string} filename - Base filename
 * @property {string} path - Full file path
 * @property {BBoxResults} results - Results keyed by element ID or 'WHOLE CONTENT'
 */

/**
 * @typedef {Object} GetBBoxOptions
 * @property {string} inputFile - Input SVG file path
 * @property {string[]} elementIds - Element IDs to get bbox for
 * @property {number} margin - Margin to apply around bbox
 */

/**
 * @typedef {Object} CLIOptions
 * @property {number} margin - Margin around bbox
 * @property {string | null} json - JSON output path or null
 * @property {string} input - Input SVG file path
 * @property {string[]} elementIds - Element IDs to get bbox for
 * @property {boolean} quiet - Minimal output mode (only bbox values)
 * @property {boolean} verbose - Verbose output mode (detailed progress)
 */

/**
 * Get bbox using native .getBBox() method
 * @param {GetBBoxOptions} options - Options for getting bounding box
 * @returns {Promise<GetBBoxResult>} Result with bounding box information
 */
async function getBBoxWithChrome(options) {
  const { inputFile, elementIds, margin } = options;

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

    // Get bbox for all requested elements
    const results = await page.evaluate(
      /**
       * @param {string[]} elementIds - Element IDs to get bbox for
       * @param {number} marginValue - Margin to apply
       */
      (elementIds, marginValue) => {
        /* eslint-disable no-undef */
        const svg = document.querySelector('svg');
        if (!svg) {
          return { error: 'No SVG element found' };
        }

        /** @type {Object.<string, unknown>} */
        const output = {};

        // If no element IDs specified, compute whole content bbox
        if (elementIds.length === 0) {
          try {
            /** @type {SVGGraphicsElement} */
            const svgEl = /** @type {any} */ (svg);
            const bbox = svgEl.getBBox();

            const bboxWithMargin = {
              x: bbox.x - marginValue,
              y: bbox.y - marginValue,
              width: bbox.width + 2 * marginValue,
              height: bbox.height + 2 * marginValue
            };

            output['WHOLE CONTENT'] = {
              bbox: bboxWithMargin,
              originalBbox: {
                x: bbox.x,
                y: bbox.y,
                width: bbox.width,
                height: bbox.height
              },
              svgViewBox: svg.getAttribute('viewBox')
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            output['WHOLE CONTENT'] = { error: message };
          }
        } else {
          // Get bbox for each element ID
          for (const id of elementIds) {
            const element = /** @type {SVGGraphicsElement} */ (
              /** @type {unknown} */ (document.getElementById(id))
            );

            if (!element) {
              output[id] = { error: 'Element not found' };
              continue;
            }

            try {
              // Get the standard SVG .getBBox()
              const bbox = element.getBBox();

              // Apply margin
              const bboxWithMargin = {
                x: bbox.x - marginValue,
                y: bbox.y - marginValue,
                width: bbox.width + 2 * marginValue,
                height: bbox.height + 2 * marginValue
              };

              output[id] = {
                bbox: bboxWithMargin,
                originalBbox: {
                  x: bbox.x,
                  y: bbox.y,
                  width: bbox.width,
                  height: bbox.height
                },
                element: {
                  tagName: element.tagName,
                  id: element.id
                }
              };
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              output[id] = { error: message };
            }
          }
        }

        return output;
        /* eslint-enable no-undef */
      },
      elementIds,
      margin
    );

    return {
      filename: path.basename(inputFile),
      path: inputFile,
      results: /** @type {BBoxResults} */ (results)
    };
  } finally {
    await browser.close();
  }
}

/**
 * Format bbox for console output
 * @param {BBoxResult | null | undefined} bbox - Bounding box result to format
 * @returns {string} Formatted bbox string
 */
function formatBBox(bbox) {
  if (!bbox) {
    return 'null';
  }
  // WHY: Handle string errors from root-level error responses (e.g., "No SVG element found")
  // The 'in' operator throws TypeError on primitives, so check type first
  if (typeof bbox === 'string') {
    return `ERROR: ${bbox}`;
  }
  // Type narrowing: check if it's an error result object
  if (typeof bbox === 'object' && bbox !== null && 'error' in bbox) {
    return `ERROR: ${bbox.error}`;
  }
  // Now TypeScript knows bbox is BBoxResultSuccess
  const orig = bbox.originalBbox;
  const withMargin = bbox.bbox;
  return `{x: ${orig.x.toFixed(2)}, y: ${orig.y.toFixed(2)}, width: ${orig.width.toFixed(2)}, height: ${orig.height.toFixed(2)}} (with margin: ${withMargin.width.toFixed(2)} × ${withMargin.height.toFixed(2)})`;
}

/**
 * Print results to console
 * @param {GetBBoxResult} result - Result object with path and results
 * @param {boolean} [quiet=false] - Minimal output mode (only bbox values)
 */
function printResults(result, quiet = false) {
  // WHY: In quiet mode, only print the raw bbox values without decoration
  if (quiet) {
    const keys = Object.keys(result.results);
    keys.forEach((key) => {
      const bbox = result.results[key];
      // WHY: Check bbox is an object before using 'in' operator
      // The 'in' operator throws TypeError on primitives (string errors from root-level)
      if (bbox && typeof bbox === 'object' && !('error' in bbox)) {
        // Output format: key: x,y,width,height (original bbox without margin)
        const orig = bbox.originalBbox;
        console.log(
          `${key}: ${orig.x.toFixed(2)},${orig.y.toFixed(2)},${orig.width.toFixed(2)},${orig.height.toFixed(2)}`
        );
      } else if (typeof bbox === 'string') {
        // WHY: Handle string errors from root-level error responses
        console.log(`${key}: ERROR: ${bbox}`);
      } else if (bbox && typeof bbox === 'object' && 'error' in bbox) {
        console.log(`${key}: ERROR: ${bbox.error}`);
      }
    });
    return;
  }

  // Normal output mode with full formatting
  console.log(`\nSVG: ${result.path}`);

  const keys = Object.keys(result.results);
  keys.forEach((key, idx) => {
    const isLast = idx === keys.length - 1;
    const prefix = isLast ? '└─' : '├─';
    console.log(`${prefix} ${key}: ${formatBBox(result.results[key])}`);
  });
}

/**
 * Save results as JSON.
 *
 * DELEGATES TO: writeJSONOutput (lib/cli-utils.cjs)
 * WHY: Centralized JSON output handling ensures consistent behavior across all CLI tools
 * DO NOT: Implement custom JSON output logic here - use writeJSONOutput
 *
 * @param {GetBBoxResult} result - Result object with path and results properties
 * @param {string} outputPath - Output JSON file path, or `-` for stdout
 */
function saveJSON(result, outputPath) {
  // Transform result into path-keyed object (consistent with sbb-getbbox format)
  /** @type {Object.<string, BBoxResults>} */
  const json = {};
  json[result.path] = result.results;

  // DELEGATE: Use shared writeJSONOutput for all JSON output handling
  // WHY: DRY principle - centralized logic for stdout, file validation, EPIPE handling
  writeJSONOutput(json, outputPath);
}

/**
 * Print help message
 */
function printHelp() {
  const version = getVersion();
  console.log(`
╔════════════════════════════════════════════════════════════════════════════╗
║ sbb-chrome-getbbox - Get bbox using Chrome .getBBox()                     ║
╚════════════════════════════════════════════════════════════════════════════╝

ℹ Version ${version}

DESCRIPTION:
  Get bounding box information using Chrome's native .getBBox() method.
  This tool is for comparison with SvgVisualBBox algorithm.

USAGE:
  sbb-chrome-getbbox <input.svg> [element-ids...] [options]

REQUIRED ARGUMENTS:
  input.svg               Input SVG file path

OPTIONAL ARGUMENTS:
  element-ids...          Element IDs to get bbox for (if omitted, gets whole content)

OPTIONS:
  --margin <number>       Margin around bbox in SVG units (default: 5)
  --json <path>           Save results as JSON to specified file (use - for stdout)
  --quiet                 Minimal output - only prints bounding box values
  --verbose               Show detailed progress information
  --help, -h              Show this help message
  --version, -v           Show version number

═══════════════════════════════════════════════════════════════════════════════

EXAMPLES:

  # Get bbox for whole content
  sbb-chrome-getbbox drawing.svg

  # Get bbox for specific elements
  sbb-chrome-getbbox drawing.svg text39 rect42 path55

  # Get bbox with custom margin
  sbb-chrome-getbbox drawing.svg logo --margin 10

  # Save results as JSON
  sbb-chrome-getbbox drawing.svg --json results.json

═══════════════════════════════════════════════════════════════════════════════

COMPARISON NOTES:

  This tool uses Chrome's native .getBBox() method, which:
  • Uses geometric calculations based on element bounds
  • Often OVERSIZES vertically due to font metrics (ascender/descender)
  • Ignores visual effects like filters, shadows, glows
  • May not accurately reflect actual rendered pixels

  Compare with:
  • sbb-getbbox: Uses SvgVisualBBox (pixel-accurate canvas rasterization)
  • sbb-inkscape-extract: Uses Inkscape (often UNDERSIZES due to font issues)

USE CASES:
  • Demonstrate .getBBox() limitations vs SvgVisualBBox
  • Create comparison test cases
  • Benchmark against other bbox methods
  • Educational purposes showing why accurate bbox matters
`);
}

/**
 * Parse command line arguments
 * @param {string[]} argv - Command line arguments (process.argv)
 * @returns {CLIOptions} Parsed options
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
  /** @type {CLIOptions} */
  const options = {
    margin: 5,
    json: null,
    input: '',
    elementIds: [],
    quiet: false,
    verbose: false
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a.startsWith('--')) {
      const parts = a.split('=');
      const key = parts[0] || '';
      const val = parts[1];
      const name = key.replace(/^--/, '');
      const next = val !== undefined ? val : args[i + 1] || '';

      /**
       * Advance to next arg if value was not inline (--key value vs --key=value)
       */
      function useNext() {
        if (val === undefined) {
          i++;
        }
      }

      switch (name) {
        case 'margin':
          options.margin = parseFloat(next);
          if (!isFinite(options.margin) || options.margin < 0) {
            printError('Margin must be a non-negative number');
            process.exit(1);
          }
          useNext();
          break;
        case 'json':
          // BUG FIX (2026-01-05 audit): Prevent --json from consuming the input file
          // If next value looks like an SVG file, it's likely the input, not json output
          if (!next || next.endsWith('.svg') || next.endsWith('.SVG')) {
            printError('Missing required argument for --json: output path (use - for stdout)');
            console.log('  Example: sbb-chrome-getbbox drawing.svg --json results.json');
            process.exit(1);
          }
          options.json = next;
          useNext();
          break;
        case 'quiet':
          // WHY: Minimal output mode - only prints bounding box values
          options.quiet = true;
          break;
        case 'verbose':
          // WHY: Detailed progress information for debugging
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

  // Validate required arguments
  if (positional.length < 1 || positional[0] === undefined) {
    printError('Missing required argument: input.svg');
    console.log('\nUsage: sbb-chrome-getbbox <input.svg> [element-ids...] [options]');
    process.exit(1);
  }

  // TypeScript now knows positional[0] is defined after the check above
  options.input = positional[0];
  options.elementIds = positional.slice(1);

  // Check input file exists
  if (!fs.existsSync(options.input)) {
    printError(`Input file not found: ${options.input}`);
    process.exit(1);
  }

  return options;
}

/**
 * Main CLI entry point
 */
async function main() {
  // WHY: Parse args first to know if quiet/verbose mode is enabled before printing
  const options = parseArgs(process.argv);

  // WHY: Suppress version banner in quiet mode - only show bbox values
  if (!options.quiet) {
    printInfo(`sbb-chrome-getbbox v${getVersion()} | svg-bbox toolkit\n`);
  }

  // WHY: Verbose mode shows detailed progress information for debugging
  if (options.verbose && !options.quiet) {
    printInfo(`Processing: ${options.input}`);
    printInfo(
      `Element IDs: ${options.elementIds.length > 0 ? options.elementIds.join(', ') : 'WHOLE CONTENT'}`
    );
    printInfo(`Margin: ${options.margin}`);
    printInfo('Launching browser...');
  }

  // Get bbox using Chrome .getBBox()
  const result = await getBBoxWithChrome({
    inputFile: options.input,
    elementIds: options.elementIds,
    margin: options.margin
  });

  // WHY: Verbose mode confirms browser completed successfully
  if (options.verbose && !options.quiet) {
    printInfo('Browser operation completed');
  }

  // Output results
  if (options.json) {
    saveJSON(result, options.json);
  } else {
    printResults(result, options.quiet);
  }
}

// Run CLI
runCLI(main);

module.exports = { getBBoxWithChrome };
