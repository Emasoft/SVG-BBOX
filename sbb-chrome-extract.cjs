#!/usr/bin/env node
/**
 * sbb-chrome-extract.cjs - Extract SVG elements using Chrome's native .getBBox()
 *
 * This tool demonstrates the standard SVG .getBBox() method's behavior for comparison
 * with SvgVisualBBox and Inkscape extraction methods.
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { getVersion } = require('./version.cjs');
const { printError, printSuccess, printInfo, runCLI } = require('./lib/cli-utils.cjs');
// SECURITY: Import security utilities
const { SHELL_METACHARACTERS, SVGBBoxError } = require('./lib/security-utils.cjs');

/**
 * Extract SVG element using native .getBBox() method
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
          svgViewBox: svg.getAttribute('viewBox'),
          element: {
            tagName: element.tagName,
            id: element.id
          }
        };
      },
      elementId,
      margin
    );

    printInfo(
      `Standard .getBBox() result: ${result.originalBbox.width.toFixed(2)} × ${result.originalBbox.height.toFixed(2)}`
    );
    printInfo(
      `With margin (${margin}): ${result.bbox.width.toFixed(2)} × ${result.bbox.height.toFixed(2)}`
    );

    // Create a new SVG with just this element and the getBBox dimensions
    const extractedSvg = await page.evaluate(
      (id, bbox) => {
        const element = /** @type {SVGGraphicsElement} */ (
          /* eslint-disable-next-line no-undef */
          /** @type {unknown} */ (document.getElementById(id))
        );
        const svg = element.ownerSVGElement;

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
    printSuccess(`SVG extracted to: ${outputSvg}`);

    // Render PNG if requested
    if (outputPng) {
      await renderToPng(page, extractedSvg, outputPng, {
        width,
        height,
        scale,
        background,
        viewBox: result.bbox
      });
      printSuccess(`PNG rendered to: ${outputPng}`);
    }
  } finally {
    await browser.close();
  }
}

/**
 * Render SVG to PNG using Puppeteer
 */
async function renderToPng(page, svgContent, outputPath, options) {
  const { width, height, scale, background, viewBox } = options;

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

  printInfo(`PNG size: ${pngWidth}×${pngHeight}px (scale: ${scale}x, background: ${background})`);
}

/**
 * Print help message
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
    if (parts.length === 1) {
      // Look for pattern: input.svg object_id output.svg (three parts)
      const svgMatch = line.match(/^(.+\.svg)\s+(\S+)\s+(.+\.svg)$/i);
      if (svgMatch) {
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

    const inputFile = parts[0];
    const objectId = parts[1];
    const outputFile = parts[2];

    return { input: inputFile, objectId, output: outputFile };
  });

  return entries;
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
    id: null,
    output: null,
    png: null,
    margin: 5,
    scale: 4,
    width: null,
    height: null,
    background: 'transparent',
    batch: null
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
          options.margin = parseFloat(next);
          if (!isFinite(options.margin) || options.margin < 0) {
            printError('Margin must be a non-negative number');
            process.exit(1);
          }
          useNext();
          break;
        case 'scale':
          options.scale = parseFloat(next);
          if (!isFinite(options.scale) || options.scale <= 0 || options.scale > 20) {
            printError('Scale must be between 0 and 20');
            process.exit(1);
          }
          useNext();
          break;
        case 'width':
          options.width = parseInt(next, 10);
          useNext();
          break;
        case 'height':
          options.height = parseInt(next, 10);
          useNext();
          break;
        case 'background':
          options.background = next || 'transparent';
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

    // Check input file exists
    if (!fs.existsSync(options.input)) {
      printError(`Input file not found: ${options.input}`);
      process.exit(1);
    }
  }

  return options;
}

/**
 * Main CLI entry point
 */
async function main() {
  printInfo(`sbb-chrome-extract v${getVersion()} | svg-bbox toolkit\n`);

  const options = parseArgs(process.argv);

  // BATCH MODE
  if (options.batch) {
    const entries = readBatchFile(options.batch);
    const results = [];

    printInfo(`Processing ${entries.length} extraction(s) in batch mode...\n`);

    for (let i = 0; i < entries.length; i++) {
      const { input: inputFile, objectId, output: outputFile } = entries[i];

      try {
        printInfo(`[${i + 1}/${entries.length}] Extracting "${objectId}" from ${inputFile}...`);

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

        console.log(`  ✓ ${path.basename(outputFile)}`);
      } catch (err) {
        const errorResult = {
          inputPath: inputFile,
          objectId,
          outputPath: outputFile,
          error: err.message
        };
        results.push(errorResult);

        console.error(`  ✗ Failed: ${inputFile}`);
        console.error(`    ${err.message}`);
      }
    }

    // Output batch summary
    console.log('');
    const successful = results.filter((r) => !r.error).length;
    const failed = results.filter((r) => r.error).length;

    if (failed === 0) {
      printSuccess(`Batch complete! ${successful}/${entries.length} extraction(s) successful.`);
    } else {
      printInfo(`Batch complete with errors: ${successful} succeeded, ${failed} failed.`);
    }

    return;
  }

  // SINGLE FILE MODE
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
