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
const { printError, printSuccess, printInfo, runCLI } = require('./lib/cli-utils.cjs');

/**
 * Get bbox using native .getBBox() method
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
      (elementIds, marginValue) => {
        /* eslint-disable no-undef */
        const svg = document.querySelector('svg');
        if (!svg) {
          return { error: 'No SVG element found' };
        }

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
            output['WHOLE CONTENT'] = { error: err.message };
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
              output[id] = { error: err.message };
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
      results
    };
  } finally {
    await browser.close();
  }
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
  const orig = bbox.originalBbox;
  const withMargin = bbox.bbox;
  return `{x: ${orig.x.toFixed(2)}, y: ${orig.y.toFixed(2)}, width: ${orig.width.toFixed(2)}, height: ${orig.height.toFixed(2)}} (with margin: ${withMargin.width.toFixed(2)} × ${withMargin.height.toFixed(2)})`;
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
  --json <path>           Save results as JSON to specified file
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
    margin: 5,
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
        case 'margin':
          options.margin = parseFloat(next);
          if (!isFinite(options.margin) || options.margin < 0) {
            printError('Margin must be a non-negative number');
            process.exit(1);
          }
          useNext();
          break;
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
    console.log('\nUsage: sbb-chrome-getbbox <input.svg> [element-ids...] [options]');
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
  printInfo(`sbb-chrome-getbbox v${getVersion()} | svg-bbox toolkit\n`);

  const options = parseArgs(process.argv);

  // Get bbox using Chrome .getBBox()
  const result = await getBBoxWithChrome({
    inputFile: options.input,
    elementIds: options.elementIds,
    margin: options.margin
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

module.exports = { getBBoxWithChrome };
