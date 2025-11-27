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
const { runCLI, printSuccess, printError, printInfo } = require('./lib/cli-utils.cjs');
const { validateFilePath } = require('./lib/security-utils.cjs');

const execFilePromise = promisify(execFile);

/**
 * Get bbox using Inkscape query commands
 */
async function getBBoxWithInkscape(options) {
  const { inputFile, elementIds } = options;

  // Validate input file
  const safePath = validateFilePath(inputFile, {
    requiredExtensions: ['.svg'],
    mustExist: true
  });

  const results = {};

  // If no element IDs specified, get whole document bbox
  if (elementIds.length === 0) {
    try {
      // Query all objects in the file
      const { stdout } = await execFilePromise('inkscape', ['--query-all', safePath]);

      const lines = stdout.trim().split('\n');
      if (lines.length === 0) {
        results['WHOLE CONTENT'] = { error: 'No objects found' };
      } else {
        // Parse first object as representative
        const firstLine = lines[0];
        const parts = firstLine.split(',');
        if (parts.length >= 5) {
          const [, x, y, width, height] = parts;
          results['WHOLE CONTENT'] = {
            bbox: {
              x: parseFloat(x),
              y: parseFloat(y),
              width: parseFloat(width),
              height: parseFloat(height)
            },
            objectCount: lines.length
          };
        }
      }
    } catch (err) {
      results['WHOLE CONTENT'] = { error: err.message };
    }
  } else {
    // Get bbox for each element ID
    for (const id of elementIds) {
      try {
        const { stdout } = await execFilePromise('inkscape', [
          `--query-id=${id}`,
          '--query-x',
          '--query-y',
          '--query-width',
          '--query-height',
          safePath
        ]);

        const lines = stdout.trim().split('\n');
        if (lines.length >= 4) {
          const [x, y, width, height] = lines.map(parseFloat);
          results[id] = {
            bbox: { x, y, width, height },
            element: { id }
          };
        } else {
          results[id] = { error: 'Element not found or query failed' };
        }
      } catch (err) {
        results[id] = { error: err.message };
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
 */
function formatBBox(bbox) {
  if (!bbox) {
    return 'null';
  }
  if (bbox.error) {
    return `ERROR: ${bbox.error}`;
  }
  const b = bbox.bbox;
  let result = `{x: ${b.x.toFixed(2)}, y: ${b.y.toFixed(2)}, width: ${b.width.toFixed(2)}, height: ${b.height.toFixed(2)}}`;
  if (bbox.objectCount) {
    result += ` (${bbox.objectCount} objects total)`;
  }
  return result;
}

/**
 * Print results to console
 */
function printResults(result) {
  console.log(`\nSVG: ${result.path}`);

  const keys = Object.keys(result.results);
  keys.forEach((key, idx) => {
    const isLast = idx === keys.length - 1;
    const prefix = isLast ? '└─' : '├─';
    console.log(`${prefix} ${key}: ${formatBBox(result.results[key])}`);
  });
}

/**
 * Save results as JSON
 */
function saveJSON(result, outputPath) {
  const json = {};
  json[result.path] = result.results;

  fs.writeFileSync(outputPath, JSON.stringify(json, null, 2), 'utf8');
  printSuccess(`JSON saved to: ${outputPath}`);
}

/**
 * Print help message
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
  --json <path>           Save results as JSON to specified file
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
 * Check if Inkscape is available
 */
async function checkInkscapeAvailable() {
  try {
    await execFilePromise('inkscape', ['--version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse command line arguments
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

  const positional = [];
  const options = {
    json: null
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const [key, val] = a.split('=');
      const name = key.replace(/^--/, '');
      const next = typeof val === 'undefined' ? args[i + 1] : val;

      function useNext() {
        if (typeof val === 'undefined') {
          i++;
        }
      }

      switch (name) {
        case 'json':
          options.json = next || null;
          useNext();
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
  if (positional.length < 1) {
    printError('Missing required argument: input.svg');
    console.log('\nUsage: sbb-inkscape-getbbox <input.svg> [element-ids...] [options]');
    process.exit(1);
  }

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
  printInfo(`sbb-inkscape-getbbox v${getVersion()} | svg-bbox toolkit\n`);

  // Check if Inkscape is available
  const inkscapeAvailable = await checkInkscapeAvailable();
  if (!inkscapeAvailable) {
    printError('Inkscape not found. Please install Inkscape and ensure it is in your PATH.');
    process.exit(1);
  }

  const options = parseArgs(process.argv);

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
