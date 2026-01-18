#!/usr/bin/env node
/**
 * sbb-inkscape-getbbox.cjs - Get bounding box using Inkscape's query commands
 *
 * This tool demonstrates Inkscape's bbox calculation for comparison
 * with SvgVisualBBox and Chrome .getBBox() methods.
 *
 * Requires Inkscape to be installed on your system.
 * Part of the svg-bbox toolkit - Inkscape Tools Collection.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { getVersion } = require('./version.cjs');

// Import CLI utilities including shared JSON output function
// WHY: writeJSONOutput centralizes JSON output handling (DRY principle)
// DO NOT: Implement custom saveJSON - use writeJSONOutput instead
// NOTE: printSuccess removed - writeJSONOutput handles success feedback internally
const { runCLI, printError, printInfo, writeJSONOutput } = require('./lib/cli-utils.cjs');
const { validateFilePath, VALID_ID_PATTERN } = require('./lib/security-utils.cjs');

const execFilePromise = promisify(execFile);

// WHY 15000ms timeout: Inkscape can take 10+ seconds to start on systems with many fonts
// as it needs to build/load the font cache on first run
const INKSCAPE_VERSION_TIMEOUT = 15000;

// WHY 15000ms timeout: Inkscape queries can hang indefinitely if the file is malformed
// or if Inkscape encounters an internal error during rendering
const INKSCAPE_QUERY_TIMEOUT = 15000;

// WHY: Common installation paths for Inkscape across different platforms
// Users may have Inkscape installed in non-PATH locations
const INKSCAPE_COMMON_PATHS = [
  'inkscape', // PATH lookup
  '/opt/homebrew/bin/inkscape', // macOS Homebrew ARM
  '/usr/local/bin/inkscape', // macOS Homebrew Intel
  '/usr/bin/inkscape', // Linux
  '/Applications/Inkscape.app/Contents/MacOS/inkscape', // macOS app bundle
  'C:\\Program Files\\Inkscape\\bin\\inkscape.exe' // Windows
];

// Module-level variable to store discovered Inkscape path
// WHY: Avoids re-discovering path for each operation
/** @type {string | null} */
let discoveredInkscapePath = null;

/**
 * @typedef {Object} BBox
 * @property {number} x - X coordinate
 * @property {number} y - Y coordinate
 * @property {number} width - Width
 * @property {number} height - Height
 */

/**
 * @typedef {Object} BBoxResult
 * @property {BBox} [bbox] - Bounding box if found
 * @property {string} [error] - Error message if failed
 * @property {number} [objectCount] - Number of objects (for whole content)
 * @property {{id: string}} [element] - Element info
 */

/**
 * @typedef {Object} InkscapeResult
 * @property {string} filename - SVG filename
 * @property {string} path - Full path to SVG
 * @property {Record<string, BBoxResult>} results - Results keyed by element ID
 */

/**
 * @typedef {Object} InkscapeOptions
 * @property {string} inputFile - Input SVG file path
 * @property {string[]} elementIds - Element IDs to get bbox for
 */

/**
 * @typedef {Object} CLIOptions
 * @property {string | null} json - JSON output path or null
 * @property {string} input - Input SVG file path
 * @property {string[]} elementIds - Element IDs to query
 * @property {string | null} inkscapePath - Custom Inkscape executable path
 */

/**
 * Get bbox using Inkscape query commands
 * @param {InkscapeOptions} options - Options with inputFile and elementIds
 * @returns {Promise<InkscapeResult>} Result with filename, path, and results
 */
async function getBBoxWithInkscape(options) {
  const { inputFile, elementIds } = options;

  // Validate input file
  const safePath = validateFilePath(inputFile, {
    requiredExtensions: ['.svg'],
    mustExist: true
  });

  /** @type {Record<string, BBoxResult>} */
  const results = {};

  // WHY: Use discovered path instead of hardcoded 'inkscape' for cross-platform compatibility
  const inkscapeCmd = discoveredInkscapePath || 'inkscape';

  // If no element IDs specified, get whole document bbox
  if (elementIds.length === 0) {
    try {
      // Query all objects in the file
      const { stdout } = await execFilePromise(inkscapeCmd, ['--query-all', safePath], {
        timeout: INKSCAPE_QUERY_TIMEOUT
      });

      const lines = stdout.trim().split('\n');
      if (lines.length === 0 || !lines[0]) {
        results['WHOLE CONTENT'] = { error: 'No objects found' };
      } else {
        // Parse first object as representative
        const firstLine = lines[0];
        const parts = firstLine.split(',');
        if (parts.length >= 5) {
          // Extract coordinates - parts[0] is the ID, parts[1-4] are x,y,width,height
          // WHY: parseFloat returns NaN for invalid input, not null/undefined
          // so we must explicitly check for NaN and use 0 as fallback
          /**
           * @param {string | undefined} str
           * @returns {number}
           */
          const parseCoord = (str) => {
            const val = parseFloat(str || '');
            return Number.isNaN(val) ? 0 : val;
          };
          results['WHOLE CONTENT'] = {
            bbox: {
              x: parseCoord(parts[1]),
              y: parseCoord(parts[2]),
              width: parseCoord(parts[3]),
              height: parseCoord(parts[4])
            },
            objectCount: lines.length
          };
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results['WHOLE CONTENT'] = { error: message };
    }
  } else {
    // Get bbox for each element ID
    for (const id of elementIds) {
      // WHY: Validate ID format before passing to Inkscape to prevent command injection
      // IDs are passed via --query-id flag and could contain shell metacharacters
      // VALID_ID_PATTERN ensures IDs match XML spec: start with letter/underscore, followed by word chars, periods, hyphens
      if (!VALID_ID_PATTERN.test(id)) {
        results[id] = {
          error: `Invalid ID format: "${id}". IDs must start with a letter or underscore, followed by letters, digits, underscores, periods, or hyphens.`
        };
        continue;
      }

      try {
        const { stdout } = await execFilePromise(
          inkscapeCmd,
          [
            `--query-id=${id}`,
            '--query-x',
            '--query-y',
            '--query-width',
            '--query-height',
            safePath
          ],
          {
            timeout: INKSCAPE_QUERY_TIMEOUT
          }
        );

        const lines = stdout.trim().split('\n');
        if (lines.length >= 4) {
          // WHY: parseFloat returns NaN for invalid input, not null/undefined
          // so we must explicitly check for NaN and use 0 as fallback
          /**
           * @param {string | undefined} str
           * @returns {number}
           */
          const parseCoord = (str) => {
            const val = parseFloat(str || '');
            return Number.isNaN(val) ? 0 : val;
          };
          const x = parseCoord(lines[0]);
          const y = parseCoord(lines[1]);
          const width = parseCoord(lines[2]);
          const height = parseCoord(lines[3]);
          results[id] = {
            bbox: { x, y, width, height },
            element: { id }
          };
        } else {
          results[id] = { error: 'Element not found or query failed' };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results[id] = { error: message };
      }
    }
  }

  return {
    filename: path.basename(safePath),
    path: safePath,
    results
  };
}

/**
 * Format bbox for console output
 * @param {BBoxResult | null} bbox - Bounding box result to format
 * @returns {string} Formatted string representation
 */
function formatBBox(bbox) {
  if (!bbox) {
    return 'null';
  }
  if (bbox.error) {
    return `ERROR: ${bbox.error}`;
  }
  const b = bbox.bbox;
  if (!b) {
    return 'null';
  }
  let result = `{x: ${b.x.toFixed(2)}, y: ${b.y.toFixed(2)}, width: ${b.width.toFixed(2)}, height: ${b.height.toFixed(2)}}`;
  if (bbox.objectCount) {
    result += ` (${bbox.objectCount} objects total)`;
  }
  return result;
}

/**
 * Print results to console
 * @param {InkscapeResult} result - Result from getBBoxWithInkscape
 * @returns {void}
 */
function printResults(result) {
  console.log(`\nSVG: ${result.path}`);

  const keys = Object.keys(result.results);
  keys.forEach((key, idx) => {
    const isLast = idx === keys.length - 1;
    const prefix = isLast ? '└─' : '├─';
    // Use nullish coalescing to handle potential undefined (for type safety)
    const bboxResult = result.results[key] ?? null;
    console.log(`${prefix} ${key}: ${formatBBox(bboxResult)}`);
  });
}

/**
 * Save results as JSON.
 *
 * DELEGATES TO: writeJSONOutput (lib/cli-utils.cjs)
 * WHY: Centralized JSON output handling ensures consistent behavior across all CLI tools
 * DO NOT: Implement custom JSON output logic here - use writeJSONOutput
 *
 * @param {InkscapeResult} result - Result object with path and results properties
 * @param {string} outputPath - Output JSON file path, or `-` for stdout
 * @returns {void}
 */
function saveJSON(result, outputPath) {
  // Transform result into path-keyed object (consistent with sbb-getbbox format)
  /** @type {Record<string, Record<string, BBoxResult>>} */
  const json = {};
  json[result.path] = result.results;

  // DELEGATE: Use shared writeJSONOutput for all JSON output handling
  // WHY: DRY principle - centralized logic for stdout, file validation, EPIPE handling
  writeJSONOutput(json, outputPath);
}

/**
 * Print help message
 * @returns {void}
 */
function printHelp() {
  const version = getVersion();
  console.log(`
╔════════════════════════════════════════════════════════════════════════════╗
║ sbb-inkscape-getbbox - Get bbox using Inkscape                            ║
╚════════════════════════════════════════════════════════════════════════════╝

ℹ Version ${version}

DESCRIPTION:
  Get bounding box information using Inkscape's query commands.
  This tool is for comparison with SvgVisualBBox and Chrome .getBBox().

  ⚠️  REQUIRES: Inkscape must be installed and in your PATH

USAGE:
  sbb-inkscape-getbbox <input.svg> [element-ids...] [options]

REQUIRED ARGUMENTS:
  input.svg               Input SVG file path

OPTIONAL ARGUMENTS:
  element-ids...          Element IDs to get bbox for (if omitted, gets whole content)

OPTIONS:
  --json <path>           Save results as JSON to specified file (use - for stdout)
  --inkscape-path <path>  Specify custom Inkscape executable path
  --help, -h              Show this help message
  --version, -v           Show version number

═══════════════════════════════════════════════════════════════════════════════

EXAMPLES:

  # Get bbox for whole content
  sbb-inkscape-getbbox drawing.svg

  # Get bbox for specific elements
  sbb-inkscape-getbbox drawing.svg text39 rect42 path55

  # Save results as JSON
  sbb-inkscape-getbbox drawing.svg --json results.json

  # Specify custom Inkscape path (macOS Homebrew ARM)
  sbb-inkscape-getbbox drawing.svg --inkscape-path /opt/homebrew/bin/inkscape

  # Specify custom Inkscape path (macOS app bundle)
  sbb-inkscape-getbbox drawing.svg --inkscape-path /Applications/Inkscape.app/Contents/MacOS/inkscape

═══════════════════════════════════════════════════════════════════════════════

COMPARISON NOTES:

  This tool uses Inkscape's query commands (--query-x, --query-y, etc.), which:
  • Often UNDERSIZES text elements due to font rendering differences
  • May not accurately reflect visual appearance in browsers
  • Depends on Inkscape's internal SVG rendering

  Compare with:
  • sbb-getbbox: Uses SvgVisualBBox (pixel-accurate canvas rasterization)
  • sbb-chrome-getbbox: Uses Chrome's .getBBox() (often OVERSIZES vertically)

USE CASES:
  • Demonstrate Inkscape bbox limitations vs SvgVisualBBox
  • Create comparison test cases
  • Benchmark against other bbox methods
  • Verify Inkscape's bbox calculation for your SVGs
`);
}

/**
 * Check if Inkscape is available and return the working path
 * WHY: Inkscape may be installed in non-PATH locations depending on platform/installation method
 *
 * @param {string | null} customPath - Custom Inkscape path specified by user
 * @returns {Promise<{found: boolean, path: string | null, checkedPaths: Array<{path: string, status: string}>}>}
 *          Result object with found status, working path, and list of checked paths with their status
 */
async function checkInkscapeAvailable(customPath = null) {
  /** @type {Array<{path: string, status: string}>} */
  const checkedPaths = [];

  // If custom path provided, only check that path
  if (customPath) {
    try {
      await execFilePromise(customPath, ['--version'], {
        timeout: INKSCAPE_VERSION_TIMEOUT
      });
      checkedPaths.push({ path: customPath, status: 'found' });
      return { found: true, path: customPath, checkedPaths };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      checkedPaths.push({ path: customPath, status: `not found (${message})` });
      return { found: false, path: null, checkedPaths };
    }
  }

  // Try each common path
  for (const inkscapePath of INKSCAPE_COMMON_PATHS) {
    try {
      await execFilePromise(inkscapePath, ['--version'], {
        timeout: INKSCAPE_VERSION_TIMEOUT
      });
      // WHY: Mark as found and return immediately on success
      checkedPaths.push({ path: inkscapePath, status: 'found' });
      return { found: true, path: inkscapePath, checkedPaths };
    } catch {
      // WHY: Track failed paths for detailed error message
      checkedPaths.push({ path: inkscapePath, status: 'not found' });
    }
  }

  return { found: false, path: null, checkedPaths };
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
    json: null,
    input: '',
    elementIds: [],
    inkscapePath: null
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Skip undefined entries (for type safety)
    if (!arg) {
      continue;
    }
    if (arg.startsWith('--')) {
      const parts = arg.split('=');
      const key = parts[0] ?? '';
      const val = parts[1];
      const name = key.replace(/^--/, '');
      const next = typeof val === 'undefined' ? args[i + 1] : val;

      function useNext() {
        if (typeof val === 'undefined') {
          i++;
        }
      }

      switch (name) {
        case 'json':
          options.json = next ?? null;
          useNext();
          break;
        case 'inkscape-path':
          options.inkscapePath = next ?? null;
          useNext();
          break;
        default:
          printError(`Unknown option: ${key}`);
          process.exit(1);
      }
    } else {
      positional.push(arg);
    }
  }

  // Validate required arguments
  if (positional.length < 1) {
    printError('Missing required argument: input.svg');
    console.log('\nUsage: sbb-inkscape-getbbox <input.svg> [element-ids...] [options]');
    process.exit(1);
  }

  // Assign input (guaranteed to exist after length check above)
  const inputFile = positional[0];
  if (!inputFile) {
    printError('Missing required argument: input.svg');
    process.exit(1);
  }
  options.input = inputFile;
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
 * @returns {Promise<void>}
 */
async function main() {
  printInfo(`sbb-inkscape-getbbox v${getVersion()} | svg-bbox toolkit\n`);

  // Parse args first to get custom inkscape path if provided
  const options = parseArgs(process.argv);

  // Check if Inkscape is available (with optional custom path)
  const inkscapeCheck = await checkInkscapeAvailable(options.inkscapePath);
  if (!inkscapeCheck.found) {
    // WHY: Detailed error message helps users diagnose installation issues
    printError('Inkscape not found. Checked:');
    for (const check of inkscapeCheck.checkedPaths) {
      console.log(`  - ${check.path}: ${check.status}`);
    }
    console.log('');
    console.log('Install Inkscape or specify path with --inkscape-path <path>');
    process.exit(1);
  }

  // WHY: Store discovered path for use by getBBoxWithInkscape
  discoveredInkscapePath = inkscapeCheck.path;

  // Get bbox using Inkscape
  const result = await getBBoxWithInkscape({
    inputFile: options.input,
    elementIds: options.elementIds
  });

  // Output results
  if (options.json) {
    saveJSON(result, options.json);
  } else {
    printResults(result);
  }
}

// Run CLI
runCLI(main);

module.exports = { getBBoxWithInkscape };
