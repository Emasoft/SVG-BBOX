#!/usr/bin/env node
/**
 * sbb-chrome-getbbox.cjs - Get bounding box using Chrome's native .getBBox()
 *
 * This tool demonstrates the standard SVG .getBBox() method's behavior for comparison
 * with SvgVisualBBox algorithm. It returns bbox information without extraction.
 */

const fs = require('fs');
const path = require('path');
const { getVersion } = require('./version.cjs');
const { PROTOCOL_TIMEOUT_MS } = require('./config/timeouts.cjs');
// WHY launchOrConnect/safeShutdown: see lib/puppeteer-utils.cjs.
const { launchOrConnect, safeShutdown } = require('./lib/puppeteer-utils.cjs');

// FBF.SVG (Frame-By-Frame SVG, https://github.com/Emasoft/svg2fbf) helper.
// Used by --fbf-frame N to pin PROSKENION to a specific frame so the
// resulting bbox describes that frame instead of the full PROSKENION
// boundary the SMIL timeline would visit across all frames.
const { extractFbfFrame } = require('./lib/fbf.cjs');

// Import CLI utilities including shared JSON output function
// WHY: writeJSONOutput centralizes JSON output handling (DRY principle)
// DO NOT: Implement custom saveJSON - use writeJSONOutput instead
// NOTE: printSuccess removed - writeJSONOutput handles success feedback internally
const {
  printBanner,
  printError,
  printInfo,
  runCLI,
  writeJSONOutput
} = require('./lib/cli-utils.cjs');

// Unified help-screen formatter — single source of truth for the
// branded header box, sectioned options, batch/FBF blocks, etc.
const helpFormatter = require('./lib/help-formatter.cjs');

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
 * @property {number | null} [fbfFrame] - 1-based FBF.SVG frame number to pin before computation
 * @property {boolean} [verbose] - Whether to print FBF pin info
 * @property {boolean} [quiet] - Whether to suppress FBF pin info
 */

/**
 * @typedef {Object} CLIOptions
 * @property {number} margin - Margin around bbox
 * @property {string | null} json - JSON output path or null
 * @property {string} input - Input SVG file path
 * @property {string[]} elementIds - Element IDs to get bbox for
 * @property {boolean} quiet - Minimal output mode (only bbox values)
 * @property {boolean} verbose - Verbose output mode (detailed progress)
 * @property {number | null} fbfFrame - 1-based FBF.SVG frame number to pin before computation
 */

/**
 * Get bbox using native .getBBox() method
 * @param {GetBBoxOptions} options - Options for getting bounding box
 * @returns {Promise<GetBBoxResult>} Result with bounding box information
 */
async function getBBoxWithChrome(options) {
  const {
    inputFile,
    elementIds,
    margin,
    fbfFrame = null,
    verbose = false,
    quiet = false
  } = options;

  const browser = await launchOrConnect({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    protocolTimeout: PROTOCOL_TIMEOUT_MS
  });

  /** @type {import('puppeteer').Page | null} */
  let page = null;
  try {
    page = await browser.newPage();

    // Read the SVG file
    // WHY `let`: --fbf-frame N rewrites the markup before we hand it to
    // the Chrome page, so svgContent must be reassignable.
    let svgContent = fs.readFileSync(inputFile, 'utf-8');

    // FBF.SVG: pin a specific frame BEFORE the SVG is loaded into Chrome
    // so .getBBox() describes that single frame instead of the union the
    // running PROSKENION animation would visit. Pure string rewrite — the
    // pinned SVG is still a normal SVG, so the rest of the pipeline works
    // unchanged. extractFbfFrame throws an actionable error if the input
    // isn't an FBF.SVG or the frame number is out of range.
    if (typeof fbfFrame === 'number' && fbfFrame >= 1) {
      const pinned = extractFbfFrame(svgContent, fbfFrame);
      svgContent = pinned.svg;
      if (verbose && !quiet) {
        printInfo(
          `FBF: pinned frame ${pinned.frameNumber} (#${pinned.frameId}) of ${pinned.totalFrames}`
        );
      }
    }

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
    // WHY safeShutdown: closes if launched, disconnects if connected
    // to shared Chromium (test mode).
    await safeShutdown(browser, page || undefined);
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
 * Print help message using the unified help formatter.
 * @returns {void}
 */
function printHelp() {
  console.log(
    helpFormatter.renderHelp({
      toolName: 'sbb-chrome-getbbox',
      tagline: "Read SVG geometry through Chrome's native getBBox() — the canonical browser bbox.",
      description:
        "Launches headless Chromium, parses the SVG with the browser's own SVG engine, " +
        "and returns each element's bbox via the standard SVGGraphicsElement.getBBox() " +
        'API. This is the geometric bbox the browser uses for layout and hit-testing — ' +
        'not the painted-pixel bbox. Useful for comparing against the rasterized result ' +
        'from sbb-getbbox (which IS pixel-accurate) and against the path-extents result ' +
        'from sbb-inkscape-extract. Differences across the three tools surface font, ' +
        'stroke, and filter effects that geometric bbox cannot see.',
      usage: ['sbb-chrome-getbbox <input.svg> [element-ids...] [options]'],
      examples: [
        {
          title: 'Bbox of the whole drawing:',
          command: 'sbb-chrome-getbbox drawing.svg'
        },
        {
          title: 'Bbox of one or more named elements:',
          command: 'sbb-chrome-getbbox drawing.svg text39 rect42 path55'
        },
        {
          title: 'Add a margin around every bbox (in SVG user units):',
          command: 'sbb-chrome-getbbox drawing.svg logo --margin 10'
        },
        {
          title: 'Emit a JSON report next to the input file:',
          command: 'sbb-chrome-getbbox drawing.svg --json results.json'
        },
        {
          title: 'Pipe JSON to another tool (use - for stdout):',
          command: 'sbb-chrome-getbbox icons.svg --json - | jq .'
        },
        {
          title: 'Pin frame 12 of an FBF.SVG before measuring:',
          command: 'sbb-chrome-getbbox animation.fbf.svg --fbf-frame 12'
        },
        {
          title: 'Compare browser-bbox vs pixel-bbox for the same element:',
          command: [
            'sbb-chrome-getbbox icons.svg star --json -',
            'sbb-getbbox icons.svg star --json -'
          ]
        }
      ],
      commonOptions: helpFormatter.DEFAULT_COMMON_OPTIONS,
      options: [
        {
          name: 'margin',
          type: 'number',
          valueLabel: '<number>',
          description:
            'Padding around each reported bbox, in SVG user units (not pixels). ' +
            'The original (un-padded) bbox is also kept in the JSON output under ' +
            'originalBbox.',
          default: 5
        },
        {
          name: 'json',
          type: 'string',
          valueLabel: '<path|->',
          description:
            'Emit a JSON report instead of human-readable text. Pass an explicit ' +
            'file path, or a single dash (-) to write JSON to stdout (handy for ' +
            'piping into jq or other tooling).'
        },
        {
          name: 'fbf-frame',
          type: 'number',
          valueLabel: '<N>',
          description:
            'FBF.SVG only: pin frame N (1-based) before measuring. The PROSKENION ' +
            '<use> is rewritten to #FRAMEnnnnn and its <animate> is dropped, so the ' +
            'bbox describes that specific frame instead of the union across the ' +
            'entire SMIL timeline.'
        },
        {
          name: 'quiet',
          type: 'boolean',
          description: 'Minimal output — only print the bounding-box values.'
        },
        {
          name: 'verbose',
          type: 'boolean',
          description: 'Show detailed progress information for long batch runs.'
        }
      ],
      fbf: {
        flags: [
          {
            flag: '--fbf-frame <N>',
            description:
              'Pin frame N (1-based) of an FBF.SVG so the bbox describes that ' +
              'specific frame, not the union across the SMIL timeline.'
          }
        ]
      },
      exitCodes: [
        [0, 'Success'],
        [1, 'Invalid argument or runtime error'],
        [2, 'File not found / unreadable']
      ],
      notes:
        'sbb-chrome-getbbox returns the geometric bbox computed by the browser ' +
        '— the same value layout and hit-testing use. It does NOT account for ' +
        'stroke width, filters, or rendered ink. For pixel-accurate bbox, use ' +
        'sbb-getbbox; for path-extents bbox, use sbb-inkscape-extract.'
    })
  );
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
    verbose: false,
    fbfFrame: null
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // WHY: Defensive check - TypeScript strict mode requires explicit undefined handling
    if (arg === undefined) continue;
    if (arg.startsWith('--')) {
      const parts = arg.split('=');
      const key = parts[0] || '';
      const val = parts[1];
      const name = key.replace(/^--/, '');
      const next = val !== undefined ? val : args[i + 1] || '';

      /**
       * Advance to next arg if value was not inline (--key value vs --key=value)
       * WHY: Defined inside loop intentionally to capture `i` variable in closure
       * for incrementing when consuming the next argument as a value
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
        case 'fbf-frame': {
          // WHY: Pin a specific frame of an FBF.SVG (svg2fbf format)
          // before bbox computation. Validation is intentionally strict
          // (positive integer, 1-based) — non-integers and zero are
          // common typos that would silently disable the pin.
          const fbfRaw = next;
          const fbfNum = Number(fbfRaw);
          if (!Number.isInteger(fbfNum) || fbfNum < 1) {
            printError('--fbf-frame must be a positive integer (1-based)');
            process.exit(1);
          }
          options.fbfFrame = fbfNum;
          useNext();
          break;
        }
        default:
          printError(`Unknown option: ${key}`);
          process.exit(1);
      }
    } else {
      positional.push(arg);
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
 * @returns {Promise<void>} Resolves when CLI execution completes
 */
async function main() {
  // WHY: Parse args first to know if quiet/verbose mode is enabled before printing
  const options = parseArgs(process.argv);

  // WHY: Print banner unless in quiet/json mode
  printBanner('sbb-chrome-getbbox', { quiet: options.quiet, json: !!options.json });

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
    margin: options.margin,
    // WHY: 1-based FBF.SVG frame number to pin (svg2fbf format) before
    // bbox computation. null means "no pinning, use the SVG as-is".
    fbfFrame: options.fbfFrame,
    verbose: options.verbose,
    quiet: options.quiet
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

// Run CLI only when invoked directly. When required by tests via
// in-process-cli helper, expose main() so it can be called without spawning
// a subprocess (saves ~1-3s per test on Chromium boot).
if (require.main === module) {
  runCLI(main);
}

// WHY bare main (not runCLI(main)): tests handle exit-code capture themselves.
module.exports = {
  main,
  getBBoxWithChrome
};
