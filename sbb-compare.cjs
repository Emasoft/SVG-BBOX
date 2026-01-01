#!/usr/bin/env node
/**
 * sbb-compare.cjs
 *
 * Compare two SVG files by rendering them to PNG and performing pixel-by-pixel comparison.
 * Returns difference percentage and generates a visual diff image.
 *
 * Part of the svg-bbox toolkit.
 */

// ═══════════════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS (JSDoc)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @typedef {import('puppeteer').Browser} Browser
 */

/**
 * @typedef {Object} ViewBoxInfo
 * @property {number} x - ViewBox x origin
 * @property {number} y - ViewBox y origin
 * @property {number} width - ViewBox width
 * @property {number} height - ViewBox height
 * @property {number} centerX - ViewBox center X coordinate
 * @property {number} centerY - ViewBox center Y coordinate
 */

/**
 * @typedef {Object} SVGAnalysis
 * @property {ViewBoxInfo|null} viewBox - ViewBox information
 * @property {number|null} width - Width attribute value
 * @property {number|null} height - Height attribute value
 * @property {{x: number, y: number}} origin - Origin point
 * @property {string|null} preserveAspectRatio - preserveAspectRatio attribute
 */

/**
 * @typedef {Object} ComparisonArgs
 * @property {string|null} svg1 - First SVG file path
 * @property {string|null} svg2 - Second SVG file path
 * @property {string|null} outDiff - Output diff PNG file path
 * @property {number} threshold - Pixel difference threshold (1-255)
 * @property {string} alignment - Alignment mode
 * @property {{x: number, y: number}|string|null} alignmentParam - Alignment parameter
 * @property {string} resolution - Resolution mode
 * @property {string} meetRule - Meet rule for scaling
 * @property {string} sliceRule - Slice rule for clipping
 * @property {boolean} json - Output as JSON
 * @property {boolean} verbose - Verbose output
 * @property {string|null} batch - Batch file path
 * @property {boolean} addMissingViewbox - Force regenerate viewBox
 * @property {number} aspectRatioThreshold - Max aspect ratio difference
 * @property {number} scale - Resolution multiplier
 * @property {boolean} [headless] - Alias for no-html
 * @property {boolean} [noHtml] - Do not open HTML report
 */

/**
 * @typedef {Object} ComparisonResult
 * @property {string} svg1 - First SVG path
 * @property {string} svg2 - Second SVG path
 * @property {number} [totalPixels] - Total pixels compared
 * @property {number} [differentPixels] - Number of different pixels
 * @property {number} diffPercentage - Difference percentage
 * @property {number} [threshold] - Threshold used
 * @property {string} [diffImage] - Path to diff image
 * @property {SVGAnalysis} [svgAnalysis1] - Analysis of first SVG
 * @property {SVGAnalysis} [svgAnalysis2] - Analysis of second SVG
 * @property {boolean} [aspectRatioMismatch] - Whether aspect ratios mismatched
 * @property {string} [error] - Error message if failed
 * @property {boolean} [failed] - Whether comparison failed
 */

/**
 * @typedef {Object} ImageCompareResult
 * @property {number} totalPixels - Total pixels compared
 * @property {number} differentPixels - Number of different pixels
 * @property {string} diffPercentage - Difference percentage as string
 */

/**
 * @typedef {Object} AspectRatioInfo
 * @property {number|null} ratio - The calculated aspect ratio
 * @property {string} source - Where the ratio came from
 * @property {boolean} needsRegeneration - Whether viewBox needs regeneration
 * @property {string} [reason] - Reason for regeneration
 */

/**
 * @typedef {Object} RenderParams
 * @property {{offsetX: number, offsetY: number, width: number, height: number}} svg1 - SVG1 params
 * @property {{offsetX: number, offsetY: number, width: number, height: number}} svg2 - SVG2 params
 * @property {number} canvasWidth - Canvas width
 * @property {number} canvasHeight - Canvas height
 */

/**
 * @typedef {Object} SVGPair
 * @property {string} svg1 - First SVG path
 * @property {string} svg2 - Second SVG path
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const puppeteer = require('puppeteer');
const { getVersion } = require('./version.cjs');
const { BROWSER_TIMEOUT_MS, FONT_TIMEOUT_MS } = require('./config/timeouts.cjs');

const execFilePromise = promisify(execFile);

// SECURITY: Import security utilities
const {
  validateFilePath,
  validateOutputPath,
  readSVGFileSafe,
  sanitizeSVGContent,
  writeFileSafe,
  SVGBBoxError,
  ValidationError,
  FileSystemError: _FileSystemError
} = require('./lib/security-utils.cjs');

const {
  runCLI,
  printSuccess,
  printError: _printError,
  printInfo,
  printWarning
} = require('./lib/cli-utils.cjs');

// ═══════════════════════════════════════════════════════════════════════════
// HELP TEXT
// ═══════════════════════════════════════════════════════════════════════════

function _printHelp() {
  console.log(`
╔════════════════════════════════════════════════════════════════════════════╗
║ sbb-compare.cjs - SVG Visual Comparison Tool                        ║
╚════════════════════════════════════════════════════════════════════════════╝

DESCRIPTION:
  Compares two SVG files by rendering them to PNG and performing pixel-by-pixel
  comparison. Returns difference percentage and generates a visual diff image.

USAGE:
  node sbb-compare.cjs svg1.svg svg2.svg [options]

OPTIONS:
  --out-diff <file>         Output diff PNG file (white=different, black=same)
                            Default: <svg1>_vs_<svg2>_diff.png

  --threshold <1-255>       Pixel difference threshold (default: 1)
                            Pixels differ if any RGBA channel differs by more
                            than threshold/256. Range: 1-255

  --alignment <mode>        How to align the two SVGs (default: origin)
    origin                  Align using respective SVG origins (0,0)
    viewbox-topleft         Align using top-left corners of viewBox
    viewbox-center          Align using centers of viewBox
    object:<id>             Align using coordinates of specified object ID
    custom:<x>,<y>          Align using custom coordinates

  --resolution <mode>       How to determine render resolution (default: viewbox)
    nominal                 Use respective nominal resolutions (no viewBox)
    viewbox                 Use respective viewBox dimensions
    full                    Use full drawing content (ignore viewBox)
    scale                   Scale to match larger SVG (uniform, meet rules)
    stretch                 Stretch to match larger SVG (non-uniform)
    clip                    Clip to match smaller SVG (slice rules)

  --meet-rule <rule>        Aspect ratio rule for 'scale' mode (default: xMidYMid)
    xMinYMin, xMinYMid, xMinYMax
    xMidYMin, xMidYMid, xMidYMax
    xMaxYMin, xMaxYMid, xMaxYMax

  --slice-rule <rule>       Aspect ratio rule for 'clip' mode (default: xMidYMid)
    (same options as --meet-rule)

  --batch <file>            Batch comparison mode using tab-separated file
                            Format: svg1_path.svg<TAB>svg2_path.svg (one pair per line)
                            Output will be in JSON format with results array

  --add-missing-viewbox     Force regenerate viewBox for SVGs that lack one
                            Uses sbb-fix-viewbox --force to generate accurate viewBox

  --aspect-ratio-threshold <n>  Maximum allowed difference in aspect ratios (default: 0.001)
                            SVGs with aspect ratios differing beyond this threshold
                            will be rejected with 100% difference

  --scale <number>          Resolution multiplier for rendering (default: 4)
                            SVGs are extremely detailed - fine differences hidden at low
                            resolution become visible at higher resolution. A flower and
                            a planet may look identical at 1024px but are completely
                            different at 4096px. Use higher values for more precision.

  --json                    Output results as JSON
  --verbose                 Show detailed progress information
  --no-html                 Do not open HTML report in browser (report is still generated)
  --headless                Alias for --no-html (do not open browser)
  --help                    Show this help
  --version                 Show version

EXAMPLES:

  # Basic comparison with default settings
  node sbb-compare.cjs original.svg modified.svg

  # Compare with custom diff output and threshold
  node sbb-compare.cjs v1.svg v2.svg --out-diff diff.png --threshold 5

  # Align by viewBox centers, scale to match larger
  node sbb-compare.cjs icon1.svg icon2.svg \\
    --alignment viewbox-center \\
    --resolution scale \\
    --meet-rule xMidYMid

  # Compare specific objects by ID
  node sbb-compare.cjs sprite1.svg sprite2.svg \\
    --alignment object:icon_home

  # JSON output for automation
  node sbb-compare.cjs test1.svg test2.svg --json

  # Batch comparison from tab-separated file
  node sbb-compare.cjs --batch comparisons.txt

OUTPUT:
  Returns:
  • Difference percentage (0-100%)
  • Total pixels compared
  • Number of different pixels
  • Diff PNG image (white pixels = different, black = identical)

  Exit codes:
  • 0: Comparison successful
  • 1: Error occurred
  • 2: Invalid arguments
`);
}

/**
 * Print version information
 * @param {string} toolName - Name of the tool
 * @returns {void}
 */
function _printVersion(toolName) {
  const version = getVersion();
  console.log(`${toolName} v${version} | svg-bbox toolkit`);
}

// ═══════════════════════════════════════════════════════════════════════════
// ARGUMENT PARSING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse command line arguments
 * @param {string[]} argv - Command line arguments
 * @returns {ComparisonArgs} Parsed arguments
 */
function parseArgs(argv) {
  const { createModeArgParser } = require('./lib/cli-utils.cjs');

  // Create the mode-aware parser with flag-based mode triggers
  const parser = createModeArgParser({
    name: 'sbb-compare',
    description: 'Compare two SVG files visually',
    defaultMode: 'normal',
    modeFlags: {
      '--batch': { mode: 'batch', consumesValue: true, valueTarget: 'batchFile' }
    },
    globalFlags: [
      { name: 'json', type: 'boolean', description: 'Output results as JSON' },
      { name: 'verbose', type: 'boolean', description: 'Show detailed progress information' },
      {
        name: 'no-html',
        type: 'boolean',
        description: 'Do not open HTML report in browser (report still generated)'
      },
      {
        name: 'headless',
        type: 'boolean',
        description: 'Alias for --no-html (do not open browser)'
      },
      { name: 'out-diff', type: 'string', description: 'Output diff PNG file path' },
      {
        name: 'threshold',
        type: 'number',
        default: 1,
        description: 'Pixel difference threshold (1-255)'
      },
      {
        name: 'alignment',
        type: 'string',
        default: 'origin',
        description: 'Alignment mode: origin|viewbox-topleft|viewbox-center|object:ID|custom:x,y'
      },
      {
        name: 'resolution',
        type: 'string',
        default: 'viewbox',
        description: 'Resolution mode: nominal|viewbox|full|scale|stretch|clip'
      },
      {
        name: 'meet-rule',
        type: 'string',
        default: 'xMidYMid',
        description: 'Aspect ratio rule for scale mode'
      },
      {
        name: 'slice-rule',
        type: 'string',
        default: 'xMidYMid',
        description: 'Aspect ratio rule for clip mode'
      },
      {
        name: 'add-missing-viewbox',
        type: 'boolean',
        description: 'Force regenerate viewBox for SVGs without one'
      },
      {
        name: 'aspect-ratio-threshold',
        type: 'number',
        default: 0.001,
        description: 'Maximum allowed aspect ratio difference (0-1)'
      },
      {
        name: 'scale',
        type: 'number',
        default: 4,
        description: 'Resolution multiplier for rendering (default: 4x for detailed comparison)'
      }
    ],
    modes: {
      normal: {
        description: 'Compare two SVG files',
        positional: [
          { name: 'svg1', required: true, description: 'First SVG file' },
          { name: 'svg2', required: true, description: 'Second SVG file' }
        ]
      },
      batch: {
        description: 'Compare multiple SVG pairs from a file',
        positional: [] // No positional args, uses batchFile from modeFlag
      }
    }
  });

  // Parse the arguments
  const result = parser(argv);

  // Map parser output to the expected legacy format for backward compatibility
  /** @type {ComparisonArgs} */
  const args = {
    svg1: result.positional[0] || null,
    svg2: result.positional[1] || null,
    outDiff: result.flags['out-diff'] || null,
    threshold: result.flags.threshold || 1,
    alignment: 'origin', // Will be set below after parsing
    /** @type {{x: number, y: number}|string|null} */
    alignmentParam: null, // Will be set below after parsing
    resolution: result.flags.resolution || 'viewbox',
    meetRule: result.flags['meet-rule'] || 'xMidYMid',
    sliceRule: result.flags['slice-rule'] || 'xMidYMid',
    json: result.flags.json || false,
    verbose: result.flags.verbose || false,
    batch: result.flags.batchFile || null,
    addMissingViewbox: result.flags['add-missing-viewbox'] || false,
    aspectRatioThreshold: result.flags['aspect-ratio-threshold'] || 0.001,
    // CRITICAL: Default scale of 4x for detailed SVG comparison
    // SVGs are extremely detailed - differences hidden at low resolution become visible at 4x
    // A flower and a planet may look identical at 1024px but completely different at 4096px
    scale: result.flags.scale || 4,
    headless: result.flags.headless || false,
    noHtml: result.flags['no-html'] || false
  };

  // Validate threshold range (1-255)
  if (args.threshold < 1 || args.threshold > 255) {
    throw new Error('--threshold must be between 1 and 255');
  }

  // Validate aspectRatioThreshold range (0-1)
  if (args.aspectRatioThreshold < 0 || args.aspectRatioThreshold > 1) {
    throw new Error('--aspect-ratio-threshold must be between 0 and 1');
  }

  // Parse alignment flag (handle object:ID and custom:x,y syntax)
  const alignValue = result.flags.alignment || 'origin';
  if (alignValue.startsWith('object:')) {
    args.alignment = 'object';
    args.alignmentParam = alignValue.substring(7);
    if (!args.alignmentParam) {
      throw new Error('--alignment object: requires an ID (e.g., object:myElementId)');
    }
  } else if (alignValue.startsWith('custom:')) {
    args.alignment = 'custom';
    const coordStr = alignValue.substring(7);
    const coords = coordStr.split(',');
    if (coords.length !== 2) {
      throw new Error('--alignment custom: requires x,y coordinates (e.g., custom:100,200)');
    }
    const x = parseFloat(coords[0]);
    const y = parseFloat(coords[1]);
    if (!isFinite(x) || !isFinite(y)) {
      throw new Error('--alignment custom: coordinates must be valid numbers');
    }
    args.alignmentParam = { x, y };
  } else {
    args.alignment = alignValue;
  }

  // Set default output diff file (only for non-batch mode)
  if (!args.batch && !args.outDiff && args.svg1 && args.svg2) {
    const base1 = path.basename(args.svg1, path.extname(args.svg1));
    const base2 = path.basename(args.svg2, path.extname(args.svg2));
    args.outDiff = `${base1}_vs_${base2}_diff.png`;
  }

  return args;
}

// ═══════════════════════════════════════════════════════════════════════════
// BATCH FILE PROCESSING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Read and parse batch comparison file (tab-separated: svg1\tsvg2)
 * Returns array of {svg1, svg2} pairs
 * @param {string} batchFilePath - Path to the batch file
 * @returns {SVGPair[]} Array of SVG pairs
 */
function readBatchFile(batchFilePath) {
  // SECURITY: Validate batch file path
  const safeBatchPath = validateFilePath(batchFilePath, {
    requiredExtensions: ['.txt'],
    mustExist: true
  });

  const content = fs.readFileSync(safeBatchPath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'));

  /** @type {SVGPair[]} */
  const pairs = [];
  for (let i = 0; i < lines.length; i++) {
    const lineRaw = lines[i];
    // Type guard: lines[i] cannot be undefined due to loop condition
    if (lineRaw === undefined) continue;
    const line = lineRaw.trim();
    const parts = line.split('\t');

    if (parts.length !== 2) {
      throw new ValidationError(
        `Invalid batch file format at line ${i + 1}: expected 2 tab-separated columns, got ${parts.length}. ` +
          'Format: svg1_path.svg<TAB>svg2_path.svg'
      );
    }

    const part0 = parts[0];
    const part1 = parts[1];
    // Type guard: parts[0] and parts[1] exist since length === 2
    if (part0 === undefined || part1 === undefined) continue;
    const svg1 = part0.trim();
    const svg2 = part1.trim();

    if (!svg1 || !svg2) {
      throw new ValidationError(`Invalid batch file format at line ${i + 1}: empty SVG path`);
    }

    pairs.push({ svg1, svg2 });
  }

  if (pairs.length === 0) {
    throw new ValidationError('Batch file is empty or contains no valid comparison pairs');
  }

  return pairs;
}

// ═══════════════════════════════════════════════════════════════════════════
// SVG ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Analyze an SVG file to extract viewBox, dimensions, and other attributes
 * @param {string} svgPath - Path to the SVG file
 * @param {Browser} browser - Puppeteer browser instance
 * @returns {Promise<SVGAnalysis|null>} Analysis result or null if SVG not found
 */
async function analyzeSvg(svgPath, browser) {
  // SECURITY: Read and sanitize SVG
  const safePath = validateFilePath(svgPath, {
    requiredExtensions: ['.svg'],
    mustExist: true
  });
  const svgContent = readSVGFileSafe(safePath);
  const sanitizedSvg = sanitizeSVGContent(svgContent);

  const page = await browser.newPage();

  // SECURITY: Set page timeout
  page.setDefaultTimeout(BROWSER_TIMEOUT_MS);

  await page.setContent(`
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { margin: 0; padding: 0; }
        svg { display: block; }
      </style>
    </head>
    <body>
      ${sanitizedSvg}
    </body>
    </html>
  `);

  const analysis = await page.evaluate(() => {
    // eslint-disable-next-line no-undef
    const svg = document.querySelector('svg');
    if (!svg) {
      return null;
    }

    /** @type {{x: number, y: number, width: number, height: number, centerX: number, centerY: number}|null} */
    let viewBox = null;
    /** @type {number|null} */
    let width = null;
    /** @type {number|null} */
    let height = null;
    /** @type {string|null} */
    let preserveAspectRatio = null;

    // Get viewBox
    // SAFETY: Use optional chaining in case svg.viewBox is null/undefined
    const vb = svg.viewBox?.baseVal;
    if (vb && vb.width && vb.height) {
      viewBox = {
        x: vb.x,
        y: vb.y,
        width: vb.width,
        height: vb.height,
        centerX: vb.x + vb.width / 2,
        centerY: vb.y + vb.height / 2
      };
    }

    // Get width/height attributes
    // CRITICAL FIX: Ignore percentage values (width="100%")
    // parseFloat("100%") = 100, which is wrong - we need absolute pixel values
    const widthAttr = svg.getAttribute('width');
    const heightAttr = svg.getAttribute('height');
    if (widthAttr && !widthAttr.includes('%')) {
      width = parseFloat(widthAttr);
    }
    if (heightAttr && !heightAttr.includes('%')) {
      height = parseFloat(heightAttr);
    }

    // Get preserveAspectRatio attribute
    const preserveAspectRatioAttr = svg.getAttribute('preserveAspectRatio');
    if (preserveAspectRatioAttr) {
      preserveAspectRatio = preserveAspectRatioAttr;
    }

    return {
      viewBox,
      width,
      height,
      origin: { x: 0, y: 0 },
      preserveAspectRatio
    };
  });

  await page.close();
  return analysis;
}

/**
 * Get bounding box center coordinates for a specific object in an SVG
 * @param {string} svgPath - Path to the SVG file
 * @param {string} objectId - ID of the element to get bbox for
 * @param {Browser} browser - Puppeteer browser instance
 * @returns {Promise<{x: number, y: number}|null>} Center coordinates or null
 */
async function getObjectBBox(svgPath, objectId, browser) {
  // SECURITY: Read and sanitize SVG
  const safePath = validateFilePath(svgPath, {
    requiredExtensions: ['.svg'],
    mustExist: true
  });
  const svgContent = readSVGFileSafe(safePath);
  const sanitizedSvg = sanitizeSVGContent(svgContent);

  const page = await browser.newPage();

  // SECURITY: Set page timeout
  page.setDefaultTimeout(BROWSER_TIMEOUT_MS);

  await page.setContent(`
    <!DOCTYPE html>
    <html>
    <head>
      <style>body { margin: 0; padding: 0; }</style>
    </head>
    <body>${sanitizedSvg}</body>
    </html>
  `);

  const bbox = await page.evaluate(
    /** @param {string} id */
    (id) => {
      // eslint-disable-next-line no-undef
      const element = document.getElementById(id);
      if (!element) {
        return null;
      }

      // Type assertion: getBBox is only available on SVGGraphicsElement
      // Cast through unknown to satisfy TypeScript's strict type checking
      const svgElement = /** @type {SVGGraphicsElement} */ (/** @type {unknown} */ (element));
      const rect = svgElement.getBBox();
      return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2
      };
    },
    objectId
  );

  await page.close();
  return bbox;
}

// ═══════════════════════════════════════════════════════════════════════════
// ALIGNMENT & RESOLUTION CALCULATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calculate render parameters for comparing two SVGs
 * @param {string} svg1Path - Path to first SVG file
 * @param {string} svg2Path - Path to second SVG file
 * @param {ComparisonArgs} args - Comparison arguments
 * @param {Browser} browser - Puppeteer browser instance
 * @returns {Promise<RenderParams>} Render parameters
 */
async function calculateRenderParams(svg1Path, svg2Path, args, browser) {
  const analysis1 = await analyzeSvg(svg1Path, browser);
  const analysis2 = await analyzeSvg(svg2Path, browser);

  if (!analysis1 || !analysis2) {
    throw new Error('Failed to analyze SVG files');
  }

  const params = {
    svg1: { offsetX: 0, offsetY: 0, width: 800, height: 600 },
    svg2: { offsetX: 0, offsetY: 0, width: 800, height: 600 },
    canvasWidth: 800,
    canvasHeight: 600
  };

  // Determine alignment offset
  let align1 = { x: 0, y: 0 };
  let align2 = { x: 0, y: 0 };

  switch (args.alignment) {
    case 'origin':
      // Both aligned at (0, 0) - default
      break;

    case 'viewbox-topleft':
      if (analysis1.viewBox) {
        align1 = { x: analysis1.viewBox.x, y: analysis1.viewBox.y };
      }
      if (analysis2.viewBox) {
        align2 = { x: analysis2.viewBox.x, y: analysis2.viewBox.y };
      }
      break;

    case 'viewbox-center':
      if (analysis1.viewBox) {
        align1 = { x: analysis1.viewBox.centerX, y: analysis1.viewBox.centerY };
      }
      if (analysis2.viewBox) {
        align2 = { x: analysis2.viewBox.centerX, y: analysis2.viewBox.centerY };
      }
      break;

    case 'object': {
      // alignmentParam is a string (object ID) in 'object' mode
      const objectId = /** @type {string} */ (args.alignmentParam);
      const bbox1 = await getObjectBBox(svg1Path, objectId, browser);
      const bbox2 = await getObjectBBox(svg2Path, objectId, browser);
      if (bbox1) {
        align1 = bbox1;
      }
      if (bbox2) {
        align2 = bbox2;
      }
      break;
    }

    case 'custom': {
      // alignmentParam is {x, y} object in 'custom' mode
      const customAlign = /** @type {{x: number, y: number}} */ (args.alignmentParam);
      align1 = customAlign;
      align2 = customAlign;
      break;
    }
  }

  // CRITICAL BUG FIX: Apply scale factor for detailed comparison
  // SVGs are extremely detailed - differences hidden at low resolution become visible at higher resolution
  // Example: A flower and a planet may look identical at 1024px but completely different at 4096px
  // Default scale is 4x to ensure fine details are captured in the diff
  const scale = args.scale || 4;

  // Determine resolution based on mode
  let width1, height1, width2, height2;

  switch (args.resolution) {
    case 'nominal':
      width1 = (analysis1.width || 800) * scale;
      height1 = (analysis1.height || 600) * scale;
      width2 = (analysis2.width || 800) * scale;
      height2 = (analysis2.height || 600) * scale;
      break;

    case 'viewbox':
      // BUG FIX: Use width/height attributes if available, NOT viewBox dimensions
      // When an SVG has both width/height attributes AND viewBox, the attributes
      // define the natural rendering size. Using viewBox dimensions for CSS sizing
      // causes incorrect rendering when the aspect ratios differ.
      // THEN apply scale factor for detailed comparison
      width1 = (analysis1.width || analysis1.viewBox?.width || 800) * scale;
      height1 = (analysis1.height || analysis1.viewBox?.height || 600) * scale;
      width2 = (analysis2.width || analysis2.viewBox?.width || 800) * scale;
      height2 = (analysis2.height || analysis2.viewBox?.height || 600) * scale;
      break;

    case 'full':
      // Would need to compute full drawing bbox - use viewbox as fallback for now
      // Apply scale factor for detailed comparison
      width1 = (analysis1.viewBox?.width || analysis1.width || 800) * scale;
      height1 = (analysis1.viewBox?.height || analysis1.height || 600) * scale;
      width2 = (analysis2.viewBox?.width || analysis2.width || 800) * scale;
      height2 = (analysis2.viewBox?.height || analysis2.height || 600) * scale;
      break;

    case 'scale': {
      // Scale both to match the larger one (uniform scaling)
      // Apply scale factor for detailed comparison
      const base1w = (analysis1.viewBox?.width || analysis1.width || 800) * scale;
      const base1h = (analysis1.viewBox?.height || analysis1.height || 600) * scale;
      const base2w = (analysis2.viewBox?.width || analysis2.width || 800) * scale;
      const base2h = (analysis2.viewBox?.height || analysis2.height || 600) * scale;

      const maxWidth = Math.max(base1w, base2w);
      const maxHeight = Math.max(base1h, base2h);
      width1 = width2 = maxWidth;
      height1 = height2 = maxHeight;
      break;
    }

    case 'stretch': {
      // Stretch both to match the larger one (non-uniform)
      // Apply scale factor for detailed comparison
      const base1w = (analysis1.viewBox?.width || analysis1.width || 800) * scale;
      const base1h = (analysis1.viewBox?.height || analysis1.height || 600) * scale;
      const base2w = (analysis2.viewBox?.width || analysis2.width || 800) * scale;
      const base2h = (analysis2.viewBox?.height || analysis2.height || 600) * scale;

      const stretchWidth = Math.max(base1w, base2w);
      const stretchHeight = Math.max(base1h, base2h);
      width1 = width2 = stretchWidth;
      height1 = height2 = stretchHeight;
      break;
    }

    case 'clip': {
      // Clip both to match the smaller one
      // Apply scale factor for detailed comparison
      const base1w = (analysis1.viewBox?.width || analysis1.width || 800) * scale;
      const base1h = (analysis1.viewBox?.height || analysis1.height || 600) * scale;
      const base2w = (analysis2.viewBox?.width || analysis2.width || 800) * scale;
      const base2h = (analysis2.viewBox?.height || analysis2.height || 600) * scale;

      const minWidth = Math.min(base1w, base2w);
      const minHeight = Math.min(base1h, base2h);
      width1 = width2 = minWidth;
      height1 = height2 = minHeight;
      break;
    }

    default:
      width1 = width2 = 800 * scale;
      height1 = height2 = 600 * scale;
  }

  // Calculate canvas size and offsets
  params.canvasWidth = Math.max(width1, width2);
  params.canvasHeight = Math.max(height1, height2);

  params.svg1.width = width1;
  params.svg1.height = height1;
  params.svg1.offsetX = align1.x - align2.x;
  params.svg1.offsetY = align1.y - align2.y;

  params.svg2.width = width2;
  params.svg2.height = height2;
  params.svg2.offsetX = 0;
  params.svg2.offsetY = 0;

  return params;
}

// ═══════════════════════════════════════════════════════════════════════════
// PNG RENDERING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Render an SVG file to PNG
 * @param {string} svgPath - Path to the SVG file
 * @param {string} outputPath - Path for the output PNG
 * @param {number} width - Target width in pixels
 * @param {number} height - Target height in pixels
 * @param {Browser} browser - Puppeteer browser instance
 * @returns {Promise<void>}
 */
async function renderSvgToPng(svgPath, outputPath, width, height, browser) {
  // SECURITY: Read and sanitize SVG
  const safePath = validateFilePath(svgPath, {
    requiredExtensions: ['.svg'],
    mustExist: true
  });
  const svgContent = readSVGFileSafe(safePath);
  const sanitizedSvg = sanitizeSVGContent(svgContent);

  // SECURITY: Validate output path
  const safeOutputPath = validateOutputPath(outputPath, {
    requiredExtensions: ['.png']
  });

  const page = await browser.newPage();

  // SECURITY: Set page timeout
  page.setDefaultTimeout(BROWSER_TIMEOUT_MS);

  await page.setViewport({ width: Math.ceil(width), height: Math.ceil(height) });

  // BUG FIX: The width/height parameters now correctly use the SVG's width/height
  // attributes (not viewBox dimensions). This ensures proper rendering when the
  // SVG has both attributes and viewBox with different aspect ratios.
  //
  // See calculateRenderParams() 'viewbox' mode for details on dimension selection.
  await page.setContent(`
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body {
          margin: 0;
          padding: 0;
          background: transparent;
        }
        svg {
          display: block;
          width: ${width}px;
          height: ${height}px;
        }
      </style>
    </head>
    <body>
      ${sanitizedSvg}
    </body>
    </html>
  `);

  // Wait for fonts and rendering
  await new Promise((resolve) => setTimeout(resolve, FONT_TIMEOUT_MS));

  await page.screenshot({
    path: safeOutputPath,
    type: 'png',
    omitBackground: true
  });

  await page.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// PIXEL COMPARISON
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compare two PNG images pixel by pixel
 * @param {string} png1Path - Path to first PNG
 * @param {string} png2Path - Path to second PNG
 * @param {string} diffPath - Path for the diff output PNG
 * @param {number} threshold - Difference threshold (1-255)
 * @returns {Promise<ImageCompareResult>} Comparison result
 */
async function compareImages(png1Path, png2Path, diffPath, threshold) {
  // SECURITY: Validate PNG input paths
  const safePng1Path = validateFilePath(png1Path, {
    requiredExtensions: ['.png'],
    mustExist: true
  });
  const safePng2Path = validateFilePath(png2Path, {
    requiredExtensions: ['.png'],
    mustExist: true
  });

  // SECURITY: Validate diff output path
  const safeDiffPath = validateOutputPath(diffPath, {
    requiredExtensions: ['.png']
  });

  // Read PNG files using a simple PNG library approach
  // For now, we'll use a Node.js implementation
  const { PNG } = require('pngjs');

  const png1Data = fs.readFileSync(safePng1Path);
  const png2Data = fs.readFileSync(safePng2Path);

  const png1 = PNG.sync.read(png1Data);
  const png2 = PNG.sync.read(png2Data);

  // Ensure images are same size
  const width = Math.max(png1.width, png2.width);
  const height = Math.max(png1.height, png2.height);

  // Create diff image
  const diff = new PNG({ width, height });

  let differentPixels = 0;
  const totalPixels = width * height;
  const thresholdValue = threshold; // threshold is already 1-255

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;

      // Get pixel values (handle images of different sizes)
      // Use ?? 0 to satisfy TypeScript's undefined check on array access
      const r1 = x < png1.width && y < png1.height ? (png1.data[idx] ?? 0) : 0;
      const g1 = x < png1.width && y < png1.height ? (png1.data[idx + 1] ?? 0) : 0;
      const b1 = x < png1.width && y < png1.height ? (png1.data[idx + 2] ?? 0) : 0;
      const a1 = x < png1.width && y < png1.height ? (png1.data[idx + 3] ?? 0) : 0;

      const r2 = x < png2.width && y < png2.height ? (png2.data[idx] ?? 0) : 0;
      const g2 = x < png2.width && y < png2.height ? (png2.data[idx + 1] ?? 0) : 0;
      const b2 = x < png2.width && y < png2.height ? (png2.data[idx + 2] ?? 0) : 0;
      const a2 = x < png2.width && y < png2.height ? (png2.data[idx + 3] ?? 0) : 0;

      // Check if pixels are different (any channel differs by more than threshold)
      const rDiff = Math.abs(r1 - r2);
      const gDiff = Math.abs(g1 - g2);
      const bDiff = Math.abs(b1 - b2);
      const aDiff = Math.abs(a1 - a2);

      const isDifferent =
        rDiff > thresholdValue ||
        gDiff > thresholdValue ||
        bDiff > thresholdValue ||
        aDiff > thresholdValue;

      if (isDifferent) {
        differentPixels++;
        // White pixel for different
        diff.data[idx] = 255;
        diff.data[idx + 1] = 255;
        diff.data[idx + 2] = 255;
        diff.data[idx + 3] = 255;
      } else {
        // Black pixel for same
        diff.data[idx] = 0;
        diff.data[idx + 1] = 0;
        diff.data[idx + 2] = 0;
        diff.data[idx + 3] = 255;
      }
    }
  }

  // SECURITY: Write diff image with safe write
  const buffer = PNG.sync.write(diff);
  writeFileSafe(safeDiffPath, buffer);

  const diffPercentage = (differentPixels / totalPixels) * 100;

  return {
    totalPixels,
    differentPixels,
    diffPercentage: diffPercentage.toFixed(2)
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// HTML REPORT GENERATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate an HTML report for SVG comparison
 * @param {string} svg1Path - Path to first SVG file
 * @param {string} svg2Path - Path to second SVG file
 * @param {string} diffPngPath - Path to the diff PNG image
 * @param {{totalPixels: number, differentPixels: number, diffPercentage: string}} result - Comparison result
 * @param {ComparisonArgs} args - Comparison arguments
 * @param {SVGAnalysis} svgAnalysis1 - Analysis of first SVG
 * @param {SVGAnalysis} svgAnalysis2 - Analysis of second SVG
 * @returns {Promise<string>} Path to the generated HTML report
 */
async function generateHtmlReport(
  svg1Path,
  svg2Path,
  diffPngPath,
  result,
  args,
  svgAnalysis1,
  svgAnalysis2
) {
  // SECURITY: Validate and read SVG files
  const safeSvg1Path = validateFilePath(svg1Path, {
    requiredExtensions: ['.svg'],
    mustExist: true
  });
  const safeSvg2Path = validateFilePath(svg2Path, {
    requiredExtensions: ['.svg'],
    mustExist: true
  });
  const svg1Content = readSVGFileSafe(safeSvg1Path);
  const svg2Content = readSVGFileSafe(safeSvg2Path);

  // SECURITY: Sanitize SVG content (for embedding in HTML)
  const sanitizedSvg1 = sanitizeSVGContent(svg1Content);
  const sanitizedSvg2 = sanitizeSVGContent(svg2Content);

  // SECURITY: Validate diff PNG path
  const safeDiffPngPath = validateFilePath(diffPngPath, {
    requiredExtensions: ['.png'],
    mustExist: true
  });
  const diffPngBuffer = fs.readFileSync(safeDiffPngPath);
  const diffPngBase64 = diffPngBuffer.toString('base64');

  // Get relative paths for links
  const svg1Relative = path.relative(process.cwd(), svg1Path);
  const svg2Relative = path.relative(process.cwd(), svg2Path);

  // Get file modification dates
  const svg1Stats = fs.statSync(svg1Path);
  const svg2Stats = fs.statSync(svg2Path);
  /** @param {Date} date - Date to format */
  const formatDate = (date) =>
    date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  const svg1Modified = formatDate(svg1Stats.mtime);
  const svg2Modified = formatDate(svg2Stats.mtime);

  // Format viewBox info
  /** @param {ViewBoxInfo|null} vb - ViewBox info to format */
  const formatViewBox = (vb) => {
    if (!vb) {
      return 'none';
    }
    return `${vb.x} ${vb.y} ${vb.width} ${vb.height}`;
  };

  // Format resolution info
  /** @param {SVGAnalysis} analysis - SVG analysis to format */
  const formatResolution = (analysis) => {
    const w = analysis.width || (analysis.viewBox ? analysis.viewBox.width : 'none');
    const h = analysis.height || (analysis.viewBox ? analysis.viewBox.height : 'none');
    return `${w} × ${h}`;
  };

  const html = `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SVG Comparison Report - SVG-BBOX</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    /* Light theme (default) */
    :root, [data-theme="light"] {
      --bg-primary: #f5f5f5;
      --bg-secondary: white;
      --bg-tertiary: #fafafa;
      --bg-settings: #ecf0f1;
      --bg-result: #e8f5e9;
      --text-primary: #333;
      --text-secondary: #555;
      --text-tertiary: #2c3e50;
      --border-primary: #ddd;
      --border-secondary: #e0e0e0;
      --border-tertiary: #f0f0f0;
      --accent-primary: #3498db;
      --accent-secondary: #4caf50;
      --accent-result: #2e7d32;
      --shadow: rgba(0,0,0,0.1);
      /* Tooltip colors - soft pastel blue */
      --tooltip-bg: #e3f2fd;
      --tooltip-text: #1565c0;
      --tooltip-border: #90caf9;
      --tooltip-shadow: rgba(33, 150, 243, 0.15);
    }

    /* Dark theme */
    [data-theme="dark"] {
      --bg-primary: #1a1a1a;
      --bg-secondary: #2d2d2d;
      --bg-tertiary: #252525;
      --bg-settings: #3a3a3a;
      --bg-result: #1e3a1e;
      --text-primary: #e0e0e0;
      --text-secondary: #b0b0b0;
      --text-tertiary: #f0f0f0;
      --border-primary: #404040;
      --border-secondary: #505050;
      --border-tertiary: #353535;
      --accent-primary: #5dade2;
      --accent-secondary: #66bb6a;
      --accent-result: #81c784;
      --shadow: rgba(0,0,0,0.5);
      /* Tooltip colors - soft pastel purple/blue */
      --tooltip-bg: #4a4a6a;
      --tooltip-text: #e8eaf6;
      --tooltip-border: #7986cb;
      --tooltip-shadow: rgba(63, 81, 181, 0.3);
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: var(--bg-primary);
      padding: 20px;
      color: var(--text-primary);
      transition: background-color 0.3s, color 0.3s;
    }

    .container {
      max-width: 1800px;
      margin: 0 auto;
      background: var(--bg-secondary);
      border-radius: 8px;
      box-shadow: 0 2px 8px var(--shadow);
      padding: 30px;
    }

    h1 {
      color: var(--text-tertiary);
      margin-bottom: 20px;
      font-size: 28px;
      text-align: center;
    }

    .settings-summary {
      background: var(--bg-settings);
      padding: 20px;
      border-radius: 6px;
      margin-bottom: 30px;
      border-left: 4px solid var(--accent-primary);
    }

    .settings-summary h2 {
      font-size: 18px;
      margin-bottom: 12px;
      color: var(--text-tertiary);
    }

    .settings-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 12px;
    }

    .setting-item {
      display: flex;
      align-items: baseline;
    }

    .setting-label {
      font-weight: 600;
      margin-right: 8px;
      color: var(--text-secondary);
    }

    .setting-value {
      color: var(--text-tertiary);
      font-family: 'Courier New', monospace;
    }

    .comparison-grid {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 20px;
      margin-top: 20px;
    }

    .svg-panel {
      border: 1px solid var(--border-primary);
      border-radius: 6px;
      padding: 15px;
      background: var(--bg-tertiary);
    }

    .panel-header {
      margin-bottom: 12px;
    }

    .panel-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-tertiary);
      margin-bottom: 8px;
    }

    .file-link {
      display: inline-block;
      color: var(--accent-primary);
      text-decoration: none;
      font-size: 13px;
      word-break: break-all;
      padding: 4px 8px;
      background: var(--bg-secondary);
      border-radius: 4px;
      border: 1px solid var(--border-primary);
      transition: all 0.2s;
    }

    .file-link:hover {
      background: var(--accent-primary);
      color: white;
    }

    .svg-container {
      background: var(--bg-secondary);
      border: 1px solid var(--border-primary);
      border-radius: 4px;
      padding: 15px;
      margin: 12px 0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 300px;
    }

    .svg-container svg {
      display: block;

      /* ═══════════════════════════════════════════════════════════════════════
       * CRITICAL: SVG Border Sizing - DO NOT MODIFY
       * ═══════════════════════════════════════════════════════════════════════
       *
       * GOAL: Border must wrap tightly around SVG at its rendered size,
       *       NOT expand with browser window or container.
       *
       * SOLUTION:
       *   - width: auto    (SVG uses intrinsic width, NOT container width)
       *   - height: auto   (SVG uses intrinsic height, maintains aspect ratio)
       *   - max-width: 600px   (constrains large SVGs to fit viewport)
       *   - max-height: 500px  (constrains large SVGs to fit viewport)
       *
       * WHY THIS WORKS:
       *   - "width: auto" means SVG does NOT stretch to fill container
       *   - SVG renders at natural size, limited by max-width/max-height
       *   - Border wraps actual rendered SVG, not container boundaries
       *   - When window expands, border stays with SVG (doesn't expand)
       *
       * WHAT DOESN'T WORK:
       *   ❌ max-width: 100%     (makes SVG expand with container)
       *   ❌ width: 100%         (forces SVG to fill container width)
       *   ❌ wrapper span        (adds complexity, still expands)
       *   ❌ no max constraints  (SVGs too large for viewport)
       *
       * TESTED AND VERIFIED - DO NOT CHANGE UNLESS TESTING NEW APPROACH
       * ═══════════════════════════════════════════════════════════════════════
       */
      max-width: 600px;
      max-height: 500px;
      width: auto;
      height: auto;

      /* Dotted border matching sbb-extract - shows actual SVG boundary */
      border: 1px dashed rgba(0,0,0,0.4);
      padding: 4px;
    }

    [data-theme="dark"] .svg-container svg {
      border-color: rgba(255,255,255,0.3);
    }

    .diff-container {
      background: var(--bg-secondary);
      border: 1px solid var(--border-primary);
      border-radius: 4px;
      padding: 15px;
      margin: 12px 0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 300px;
    }

    .diff-container img {
      max-width: 100%;
      max-height: 500px;
      height: auto;
      image-rendering: pixelated;
    }

    .info-panel {
      background: var(--bg-secondary);
      border: 1px solid var(--border-secondary);
      border-radius: 4px;
      padding: 12px;
      font-size: 13px;
      margin-top: 12px;
    }

    .info-row {
      display: flex;
      justify-content: space-between;
      padding: 6px 0;
      border-bottom: 1px solid var(--border-tertiary);
    }

    .info-row:last-child {
      border-bottom: none;
    }

    .info-label {
      font-weight: 600;
      color: var(--text-secondary);
    }

    .info-value {
      color: var(--text-tertiary);
      font-family: 'Courier New', monospace;
      text-align: right;
    }

    .result-panel {
      background: var(--bg-result);
      border: 2px solid var(--accent-secondary);
      border-radius: 6px;
      padding: 20px;
      text-align: center;
      margin-top: 12px;
    }

    .result-percentage {
      font-size: 48px;
      font-weight: 700;
      color: var(--accent-result);
      margin: 10px 0;
    }

    .result-label {
      font-size: 14px;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .result-stats {
      margin-top: 15px;
      font-size: 13px;
      color: var(--text-secondary);
    }

    /* Header with logo */
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 2px solid var(--border-primary);
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo-emoji {
      font-size: 36px;
      line-height: 1;
    }

    .logo-text {
      font-size: 24px;
      font-weight: 700;
      color: var(--text-tertiary);
      letter-spacing: -0.5px;
    }

    /* Theme switcher */
    .theme-switcher {
      display: flex;
      align-items: center;
      gap: 10px;
      background: var(--bg-tertiary);
      padding: 8px 12px;
      border-radius: 20px;
      border: 1px solid var(--border-primary);
    }

    .theme-label {
      font-size: 13px;
      color: var(--text-secondary);
      font-weight: 500;
    }

    .theme-toggle {
      background: var(--accent-primary);
      border: none;
      border-radius: 16px;
      padding: 6px 12px;
      color: white;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s;
      font-weight: 500;
    }

    .theme-toggle:hover {
      transform: scale(1.05);
      opacity: 0.9;
    }

    .theme-toggle:active {
      transform: scale(0.95);
    }

    /* File modification date */
    .file-modified {
      font-size: 11px;
      color: var(--text-secondary);
      margin-top: 4px;
      font-style: italic;
    }

    /* Tooltips */
    [data-tooltip] {
      position: relative;
      cursor: help;
    }

    /* Hide parent tooltip when hovering child with tooltip */
    [data-tooltip]:has([data-tooltip]:hover)::before,
    [data-tooltip]:has([data-tooltip]:hover)::after {
      opacity: 0 !important;
    }

    [data-tooltip]::before {
      content: attr(data-tooltip);
      position: absolute;
      bottom: 100%;
      left: 50%;
      transform: translateX(-50%) translateY(-8px);
      padding: 10px 14px;
      background: var(--tooltip-bg);
      color: var(--tooltip-text);
      border: 1px solid var(--tooltip-border);
      border-radius: 8px;
      font-size: 14px;
      white-space: nowrap;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.3s, transform 0.3s;
      z-index: 1000;
      box-shadow: 0 4px 12px var(--tooltip-shadow);
      max-width: 320px;
      white-space: normal;
      text-align: center;
      line-height: 1.5;
      font-weight: 500;
    }

    [data-tooltip]::after {
      content: '';
      position: absolute;
      bottom: 100%;
      left: 50%;
      transform: translateX(-50%) translateY(-2px);
      border: 7px solid transparent;
      border-top-color: var(--tooltip-bg);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.3s, transform 0.3s;
      z-index: 1000;
      filter: drop-shadow(0 1px 1px var(--tooltip-shadow));
    }

    [data-tooltip]:hover::before,
    [data-tooltip]:hover::after {
      opacity: 1;
      transform: translateX(-50%) translateY(-4px);
    }

    /* Tooltip positioning variants */
    [data-tooltip-pos="right"]::before {
      left: 100%;
      top: 50%;
      bottom: auto;
      transform: translateY(-50%) translateX(8px);
    }

    [data-tooltip-pos="right"]::after {
      left: 100%;
      top: 50%;
      bottom: auto;
      transform: translateY(-50%) translateX(2px);
      border: 7px solid transparent;
      border-right-color: var(--tooltip-bg);
      border-top-color: transparent;
    }

    [data-tooltip-pos="right"]:hover::before {
      transform: translateY(-50%) translateX(12px);
    }

    [data-tooltip-pos="right"]:hover::after {
      transform: translateY(-50%) translateX(6px);
    }

    @media (max-width: 1200px) {
      .comparison-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
  <script>
    // Theme detection and switching
    (function() {
      // Detect system theme preference
      function getSystemTheme() {
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
          return 'dark';
        }
        return 'light';
      }

      // Get stored theme or use system preference
      function getInitialTheme() {
        const stored = localStorage.getItem('svg-bbox-theme');
        return stored || getSystemTheme();
      }

      // Apply theme
      function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('svg-bbox-theme', theme);
        updateThemeButton(theme);
      }

      // Update button text
      function updateThemeButton(theme) {
        const button = document.getElementById('theme-toggle');
        if (button) {
          button.textContent = theme === 'dark' ? '☀️ Light' : '🌙 Dark';
        }
      }

      // Toggle theme
      window.toggleTheme = function() {
        const current = document.documentElement.getAttribute('data-theme') || 'light';
        const next = current === 'dark' ? 'light' : 'dark';
        applyTheme(next);
      };

      // Listen for system theme changes
      if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
          if (!localStorage.getItem('svg-bbox-theme')) {
            applyTheme(e.matches ? 'dark' : 'light');
          }
        });
      }

      // Apply initial theme
      applyTheme(getInitialTheme());
    })();
  </script>
</head>
<body>
  <div class="container">
    <!-- Header with logo and theme switcher -->
    <div class="header">
      <div class="logo" data-tooltip="Part of the SVG-BBOX toolkit - reliable SVG bounding box computation and manipulation tools">
        <span class="logo-emoji">📦</span>
        <span class="logo-text">SVG-BBOX</span>
      </div>
      <div class="theme-switcher">
        <span class="theme-label" data-tooltip="Choose between light and dark color themes. Auto-detects your system preference.">Theme:</span>
        <button id="theme-toggle" class="theme-toggle" onclick="toggleTheme()" data-tooltip="Toggle between light and dark theme. Your preference is saved locally.">🌙 Dark</button>
      </div>
    </div>

    <h1 data-tooltip="Visual comparison report generated by sbb-compare tool">📊 SVG Comparison Report</h1>

    <div class="settings-summary" data-tooltip="Configuration parameters used for this comparison">
      <h2>⚙️ Comparison Settings</h2>
      <div class="settings-grid">
        <div class="setting-item">
          <span class="setting-label" data-tooltip="How the two SVGs are positioned relative to each other before comparison">Alignment:</span>
          <span class="setting-value" data-tooltip="Alignment mode: ${args.alignment}${args.alignmentParam ? '. Parameters: ' + JSON.stringify(args.alignmentParam) : ''}">${args.alignment}${args.alignmentParam ? ` (${JSON.stringify(args.alignmentParam)})` : ''}</span>
        </div>
        <div class="setting-item">
          <span class="setting-label" data-tooltip="How the render resolution is determined for comparison">Resolution:</span>
          <span class="setting-value" data-tooltip="Resolution mode determines the pixel dimensions used for rendering both SVGs">${args.resolution}</span>
        </div>
        <div class="setting-item">
          <span class="setting-label" data-tooltip="Sensitivity for pixel difference detection">Threshold:</span>
          <span class="setting-value" data-tooltip="Pixels differ if any RGBA channel differs by more than ${args.threshold}/256. Lower = more sensitive.">${args.threshold}/256</span>
        </div>
        <div class="setting-item">
          <span class="setting-label" data-tooltip="Aspect ratio preservation rule when scaling (uniform)">Meet Rule:</span>
          <span class="setting-value" data-tooltip="SVG preserveAspectRatio 'meet' rule for uniform scaling">${args.meetRule}</span>
        </div>
        <div class="setting-item">
          <span class="setting-label" data-tooltip="Aspect ratio rule when clipping (non-uniform)">Slice Rule:</span>
          <span class="setting-value" data-tooltip="SVG preserveAspectRatio 'slice' rule for clipping overflow">${args.sliceRule}</span>
        </div>
      </div>
    </div>

    <div class="comparison-grid">
      <!-- SVG 1 Panel -->
      <div class="svg-panel" data-tooltip="First SVG file in comparison">
        <div class="panel-header">
          <div class="panel-title" data-tooltip="The first SVG file being compared">📄 SVG 1</div>
          <a href="${svg1Relative}" class="file-link" target="_blank" data-tooltip="Click to open original SVG file: ${svg1Relative}">${svg1Relative}</a>
          <div class="file-modified" data-tooltip="File last modified timestamp from filesystem">${svg1Modified}</div>
        </div>
        <div class="svg-container" data-tooltip="Embedded SVG preview. Dotted border shows SVG boundaries.">
          ${sanitizedSvg1}
        </div>
        <div class="info-panel" data-tooltip="SVG attributes extracted from the file">
          <div class="info-row">
            <span class="info-label" data-tooltip="The viewBox attribute defines the coordinate system and aspect ratio">ViewBox:</span>
            <span class="info-value" data-tooltip="Format: x y width height. From SVG viewBox attribute.">${formatViewBox(svgAnalysis1.viewBox)}</span>
          </div>
          <div class="info-row">
            <span class="info-label" data-tooltip="The width attribute in the SVG root element">Width:</span>
            <span class="info-value" data-tooltip="From SVG width attribute. 'none' means not specified.">${svgAnalysis1.width || 'none'}</span>
          </div>
          <div class="info-row">
            <span class="info-label" data-tooltip="The height attribute in the SVG root element">Height:</span>
            <span class="info-value" data-tooltip="From SVG height attribute. 'none' means not specified.">${svgAnalysis1.height || 'none'}</span>
          </div>
          <div class="info-row">
            <span class="info-label" data-tooltip="Calculated resolution used for rendering">Resolution:</span>
            <span class="info-value" data-tooltip="Computed from width/height attributes or viewBox dimensions">${formatResolution(svgAnalysis1)}</span>
          </div>
        </div>
      </div>

      <!-- SVG 2 Panel -->
      <div class="svg-panel" data-tooltip="Second SVG file in comparison">
        <div class="panel-header">
          <div class="panel-title" data-tooltip="The second SVG file being compared">📄 SVG 2</div>
          <a href="${svg2Relative}" class="file-link" target="_blank" data-tooltip="Click to open original SVG file: ${svg2Relative}">${svg2Relative}</a>
          <div class="file-modified" data-tooltip="File last modified timestamp from filesystem">${svg2Modified}</div>
        </div>
        <div class="svg-container" data-tooltip="Embedded SVG preview. Dotted border shows SVG boundaries.">
          ${sanitizedSvg2}
        </div>
        <div class="info-panel" data-tooltip="SVG attributes extracted from the file">
          <div class="info-row">
            <span class="info-label" data-tooltip="The viewBox attribute defines the coordinate system and aspect ratio">ViewBox:</span>
            <span class="info-value" data-tooltip="Format: x y width height. From SVG viewBox attribute.">${formatViewBox(svgAnalysis2.viewBox)}</span>
          </div>
          <div class="info-row">
            <span class="info-label" data-tooltip="The width attribute in the SVG root element">Width:</span>
            <span class="info-value" data-tooltip="From SVG width attribute. 'none' means not specified.">${svgAnalysis2.width || 'none'}</span>
          </div>
          <div class="info-row">
            <span class="info-label" data-tooltip="The height attribute in the SVG root element">Height:</span>
            <span class="info-value" data-tooltip="From SVG height attribute. 'none' means not specified.">${svgAnalysis2.height || 'none'}</span>
          </div>
          <div class="info-row">
            <span class="info-label" data-tooltip="Calculated resolution used for rendering">Resolution:</span>
            <span class="info-value" data-tooltip="Computed from width/height attributes or viewBox dimensions">${formatResolution(svgAnalysis2)}</span>
          </div>
        </div>
      </div>

      <!-- Diff Panel -->
      <div class="svg-panel" data-tooltip="Visual difference map showing which pixels differ between the two SVGs">
        <div class="panel-header">
          <div class="panel-title" data-tooltip="Pixel-by-pixel comparison result">🔍 Visual Difference</div>
          <span class="file-link" style="cursor: default; pointer-events: none;" data-tooltip="Color coding: white pixels = different, black pixels = identical">White = Different, Black = Same</span>
        </div>
        <div class="diff-container" data-tooltip="Difference visualization PNG. Each pixel is white if any RGBA channel differs by more than threshold.">
          <img src="data:image/png;base64,${diffPngBase64}" alt="Difference visualization" data-tooltip="Generated by comparing rendered PNGs pixel-by-pixel. White = different, Black = same.">
        </div>
        <div class="result-panel" data-tooltip="Summary statistics of the comparison">
          <div class="result-label" data-tooltip="Percentage of pixels that differ between the two SVGs">Difference</div>
          <div class="result-percentage" data-tooltip="Calculated as: (different pixels / total pixels) × 100%">${result.diffPercentage}%</div>
          <div class="result-stats" data-tooltip="Pixel count: ${result.differentPixels.toLocaleString()} different out of ${result.totalPixels.toLocaleString()} total pixels">
            ${result.differentPixels.toLocaleString()} of ${result.totalPixels.toLocaleString()} pixels differ
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;

  // Generate HTML filename
  const svg1Base = path.basename(svg1Path, path.extname(svg1Path));
  const svg2Base = path.basename(svg2Path, path.extname(svg2Path));
  const htmlPath = `${svg1Base}_vs_${svg2Base}_comparison.html`;

  // SECURITY: Validate and write HTML output
  const safeHtmlPath = validateOutputPath(htmlPath, {
    requiredExtensions: ['.html']
  });
  writeFileSafe(safeHtmlPath, html, 'utf-8');

  return safeHtmlPath;
}

// ═══════════════════════════════════════════════════════════════════════════
// VIEWBOX REGENERATION & ASPECT RATIO VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Regenerate viewBox for an SVG file using sbb-fix-viewbox with --force
 * Returns path to the fixed SVG file
 *
 * DEPENDENCY NOTE:
 * This function depends on sbb-fix-viewbox.cjs as a subprocess.
 * It relies on the output being a valid SVG file with properly set
 * viewBox, width, and height attributes.
 *
 * The output format of sbb-fix-viewbox is a design contract - see the
 * "OUTPUT FORMAT CONTRACT" comment in sbb-fix-viewbox.cjs header.
 *
 * @param {string} svgPath - Path to the SVG file needing viewBox regeneration
 * @returns {Promise<string>} Path to the fixed SVG file with viewBox set
 * @throws {SVGBBoxError} If sbb-fix-viewbox fails to regenerate the viewBox
 */
async function regenerateViewBox(svgPath) {
  // Create output path with _viewbox_fixed suffix
  const outputPath = svgPath.replace(/\.svg$/i, '_viewbox_fixed.svg');

  // Run sbb-fix-viewbox with --force flag
  const fixViewboxScript = path.join(__dirname, 'sbb-fix-viewbox.cjs');

  try {
    await execFilePromise('node', [fixViewboxScript, svgPath, outputPath, '--force'], {
      timeout: BROWSER_TIMEOUT_MS
    });
    return outputPath;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new SVGBBoxError(
      `Failed to regenerate viewBox for ${svgPath}: ${errorMessage}`,
      'VIEWBOX_REGENERATION_FAILED'
    );
  }
}

/**
 * Get aspect ratio for an SVG analysis
 * Returns { ratio, source, needsRegeneration }
 * - ratio: the calculated aspect ratio (width/height)
 * - source: where the ratio came from ('viewBox', 'attributes', or 'regenerated')
 * - needsRegeneration: true if viewBox needs to be regenerated
 * @param {SVGAnalysis} analysis - The SVG analysis object containing viewBox, width, height
 * @param {boolean} addMissingViewbox - Whether to regenerate missing viewBox
 * @returns {AspectRatioInfo}
 */
function getAspectRatioInfo(analysis, addMissingViewbox) {
  // Priority 1: Use viewBox if it exists
  if (analysis.viewBox && analysis.viewBox.width && analysis.viewBox.height) {
    return {
      ratio: analysis.viewBox.width / analysis.viewBox.height,
      source: 'viewBox',
      needsRegeneration: false
    };
  }

  // Priority 2: Use width/height attributes if they exist
  if (analysis.width && analysis.height) {
    return {
      ratio: analysis.width / analysis.height,
      source: 'attributes',
      needsRegeneration: false
    };
  }

  // Priority 3: Regenerate viewBox if:
  // - --add-missing-viewbox flag is set, OR
  // - No viewBox AND no width/height (mandatory regeneration)
  const mandatoryRegeneration = !analysis.viewBox && !analysis.width && !analysis.height;

  if (addMissingViewbox || mandatoryRegeneration) {
    return {
      ratio: null, // Will be calculated after regeneration
      source: 'regenerated',
      needsRegeneration: true,
      reason: mandatoryRegeneration ? 'mandatory' : 'flag'
    };
  }

  // If we get here, something is wrong - should not happen
  throw new ValidationError(
    'Cannot determine aspect ratio: no viewBox, no width/height attributes, and regeneration not enabled'
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SINGLE COMPARISON
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Perform a single SVG comparison
 * Returns comparison result object
 * @param {string} svg1Path - Path to first SVG file
 * @param {string} svg2Path - Path to second SVG file
 * @param {ComparisonArgs} args - Comparison arguments
 * @param {import('puppeteer').Browser} browser - Puppeteer browser instance
 * @returns {Promise<ComparisonResult>}
 */
async function performSingleComparison(svg1Path, svg2Path, args, browser) {
  // SECURITY: Validate input SVG files
  const safeSvg1Path = validateFilePath(svg1Path, {
    requiredExtensions: ['.svg'],
    mustExist: true
  });
  const safeSvg2Path = validateFilePath(svg2Path, {
    requiredExtensions: ['.svg'],
    mustExist: true
  });

  // Set default output diff file if not provided
  let outDiff = args.outDiff;
  if (!outDiff) {
    const base1 = path.basename(svg1Path, path.extname(svg1Path));
    const base2 = path.basename(svg2Path, path.extname(svg2Path));
    outDiff = `${base1}_vs_${base2}_diff.png`;
  }

  if (args.verbose && !args.json) {
    console.log(`Comparing: ${safeSvg1Path} vs ${safeSvg2Path}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 1: Analyze SVGs and validate aspect ratios
  // ═══════════════════════════════════════════════════════════════════════

  // Analyze both SVGs
  let svgAnalysis1 = await analyzeSvg(safeSvg1Path, browser);
  let svgAnalysis2 = await analyzeSvg(safeSvg2Path, browser);

  // Ensure SVG analysis succeeded for both files
  if (!svgAnalysis1 || !svgAnalysis2) {
    throw new ValidationError('Failed to analyze one or both SVG files');
  }

  // Get aspect ratio info for both SVGs
  const ratioInfo1 = getAspectRatioInfo(svgAnalysis1, args.addMissingViewbox);
  const ratioInfo2 = getAspectRatioInfo(svgAnalysis2, args.addMissingViewbox);

  // Track which SVGs got regenerated (for cleanup later)
  let svg1PathToUse = safeSvg1Path;
  let svg2PathToUse = safeSvg2Path;
  const regeneratedFiles = [];

  // Regenerate viewBox if needed for SVG1
  if (ratioInfo1.needsRegeneration) {
    if (args.verbose && !args.json) {
      const reason =
        ratioInfo1.reason === 'mandatory'
          ? 'no viewBox and no width/height attributes'
          : '--add-missing-viewbox flag';
      printWarning(`SVG1 requires viewBox regeneration (${reason})`);
    }
    svg1PathToUse = await regenerateViewBox(safeSvg1Path);
    regeneratedFiles.push(svg1PathToUse);
    const newAnalysis1 = await analyzeSvg(svg1PathToUse, browser);
    if (!newAnalysis1) {
      throw new ValidationError('Failed to analyze regenerated SVG1');
    }
    svgAnalysis1 = newAnalysis1;
    ratioInfo1.ratio = getAspectRatioInfo(svgAnalysis1, false).ratio;
    if (args.verbose && !args.json) {
      printInfo(`SVG1 viewBox regenerated: ${svg1PathToUse}`);
    }
  }

  // Regenerate viewBox if needed for SVG2
  if (ratioInfo2.needsRegeneration) {
    if (args.verbose && !args.json) {
      const reason =
        ratioInfo2.reason === 'mandatory'
          ? 'no viewBox and no width/height attributes'
          : '--add-missing-viewbox flag';
      printWarning(`SVG2 requires viewBox regeneration (${reason})`);
    }
    svg2PathToUse = await regenerateViewBox(safeSvg2Path);
    regeneratedFiles.push(svg2PathToUse);
    const newAnalysis2 = await analyzeSvg(svg2PathToUse, browser);
    if (!newAnalysis2) {
      throw new ValidationError('Failed to analyze regenerated SVG2');
    }
    svgAnalysis2 = newAnalysis2;
    ratioInfo2.ratio = getAspectRatioInfo(svgAnalysis2, false).ratio;
    if (args.verbose && !args.json) {
      printInfo(`SVG2 viewBox regenerated: ${svg2PathToUse}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 2: Validate aspect ratios
  // ═══════════════════════════════════════════════════════════════════════

  // At this point, ratios should be non-null after regeneration (if needed)
  const ratio1Value = ratioInfo1.ratio ?? 0;
  const ratio2Value = ratioInfo2.ratio ?? 0;
  const aspectRatioDiff = Math.abs(ratio1Value - ratio2Value);

  if (aspectRatioDiff > args.aspectRatioThreshold) {
    // CRITICAL: Aspect ratios differ beyond threshold
    // Comparison is meaningless - exit with 100% difference

    // Clean up regenerated files
    for (const file of regeneratedFiles) {
      try {
        fs.unlinkSync(file);
        // eslint-disable-next-line no-unused-vars
      } catch (_err) {
        // Ignore cleanup errors
      }
    }

    const ratio1 = ratio1Value.toFixed(6);
    const ratio2 = ratio2Value.toFixed(6);

    const message = `Images have different aspect ratios (${ratio1} vs ${ratio2}, difference: ${aspectRatioDiff.toFixed(6)} > threshold: ${args.aspectRatioThreshold}). Pixel-by-pixel comparison is meaningless. Returning 100% difference.`;

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            svg1: svg1Path,
            svg2: svg2Path,
            aspectRatioMismatch: true,
            aspectRatio1: parseFloat(ratio1),
            aspectRatio2: parseFloat(ratio2),
            aspectRatioDiff,
            threshold: args.aspectRatioThreshold,
            diffPercentage: 100,
            message
          },
          null,
          2
        )
      );
      return {
        svg1: svg1Path,
        svg2: svg2Path,
        aspectRatioMismatch: true,
        diffPercentage: 100
      };
    } else {
      console.log('\n╔════════════════════════════════════════════════════════════════════════╗');
      console.log('║ ASPECT RATIO MISMATCH - COMPARISON ABORTED                             ║');
      console.log('╚════════════════════════════════════════════════════════════════════════╝\n');
      console.log(`  SVG 1:              ${svg1Path}`);
      console.log(`  Aspect ratio 1:     ${ratio1} (from ${ratioInfo1.source})`);
      console.log(`  SVG 2:              ${svg2Path}`);
      console.log(`  Aspect ratio 2:     ${ratio2} (from ${ratioInfo2.source})`);
      console.log(`  Difference:         ${aspectRatioDiff.toFixed(6)}`);
      console.log(`  Threshold:          ${args.aspectRatioThreshold}`);
      console.log(`\n  ${message}\n`);

      return {
        svg1: svg1Path,
        svg2: svg2Path,
        aspectRatioMismatch: true,
        diffPercentage: 100
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 3: Check preserveAspectRatio (warning only, not blocking)
  // ═══════════════════════════════════════════════════════════════════════

  if (
    svgAnalysis1.preserveAspectRatio &&
    svgAnalysis2.preserveAspectRatio &&
    svgAnalysis1.preserveAspectRatio !== svgAnalysis2.preserveAspectRatio
  ) {
    if (!args.json) {
      printWarning(
        `SVGs have different preserveAspectRatio attributes: "${svgAnalysis1.preserveAspectRatio}" vs "${svgAnalysis2.preserveAspectRatio}". This may affect rendering.`
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 4: Continue with normal comparison
  // ═══════════════════════════════════════════════════════════════════════

  // Calculate render parameters
  const params = await calculateRenderParams(svg1PathToUse, svg2PathToUse, args, browser);

  // Render SVGs to PNG
  // BUGFIX: Ensure temp directory exists before rendering
  // Windows CI had race condition where directory creation wasn't complete before file writes
  const tempDir = path.join(process.cwd(), '.tmp-compare');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  // Verify directory was created successfully
  if (!fs.existsSync(tempDir)) {
    throw new Error(`Failed to create temporary directory: ${tempDir}`);
  }

  const png1Path = path.join(
    tempDir,
    `svg1_${Date.now()}_${Math.random().toString(36).slice(2, 11)}.png`
  );
  const png2Path = path.join(
    tempDir,
    `svg2_${Date.now()}_${Math.random().toString(36).slice(2, 11)}.png`
  );

  try {
    await renderSvgToPng(svg1PathToUse, png1Path, params.svg1.width, params.svg1.height, browser);
    await renderSvgToPng(svg2PathToUse, png2Path, params.svg2.width, params.svg2.height, browser);

    // Compare images
    const result = await compareImages(png1Path, png2Path, outDiff, args.threshold);

    // Clean up temp PNG files
    fs.unlinkSync(png1Path);
    fs.unlinkSync(png2Path);

    // Clean up regenerated SVG files
    for (const file of regeneratedFiles) {
      try {
        fs.unlinkSync(file);
        // eslint-disable-next-line no-unused-vars
      } catch (_err) {
        // Ignore cleanup errors
      }
    }

    return {
      svg1: svg1Path,
      svg2: svg2Path,
      totalPixels: result.totalPixels,
      differentPixels: result.differentPixels,
      diffPercentage: parseFloat(result.diffPercentage),
      threshold: args.threshold,
      diffImage: outDiff,
      svgAnalysis1,
      svgAnalysis2
    };
  } catch (error) {
    // Clean up temp files on error
    try {
      if (fs.existsSync(png1Path)) {
        fs.unlinkSync(png1Path);
      }
      if (fs.existsSync(png2Path)) {
        fs.unlinkSync(png2Path);
      }
      // Clean up regenerated SVG files
      for (const file of regeneratedFiles) {
        try {
          if (fs.existsSync(file)) {
            fs.unlinkSync(file);
          }
          // eslint-disable-next-line no-unused-vars
        } catch (_err) {
          // Ignore cleanup errors
        }
      }
      // eslint-disable-next-line no-unused-vars
    } catch (_cleanupErr) {
      // Ignore cleanup errors
    }
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const args = parseArgs(process.argv);

  // Display version (but not in JSON mode or batch mode)
  if (!args.json && !args.batch) {
    printInfo(`sbb-compare v${getVersion()} | svg-bbox toolkit\n`);
  }

  let browser = null;
  try {
    // SECURITY: Launch browser with security args and timeout
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      timeout: BROWSER_TIMEOUT_MS
    });

    // BATCH MODE: Process multiple comparisons from file
    if (args.batch) {
      const pairs = readBatchFile(args.batch);

      if (args.verbose) {
        console.log(`Processing ${pairs.length} comparison pairs from ${args.batch}`);
      }

      const results = [];
      for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i];
        // Type guard: pairs[i] cannot be undefined due to loop condition
        if (!pair) continue;
        const { svg1, svg2 } = pair;

        if (args.verbose) {
          console.log(`[${i + 1}/${pairs.length}] Comparing ${svg1} vs ${svg2}`);
        }

        try {
          const result = await performSingleComparison(svg1, svg2, args, browser);
          results.push(result);
        } catch (error) {
          // In batch mode, continue processing other pairs even if one fails
          const errorMessage = error instanceof Error ? error.message : String(error);
          results.push({
            svg1,
            svg2,
            error: errorMessage,
            failed: true
          });

          if (args.verbose) {
            console.error(`  Error: ${errorMessage}`);
          }
        }
      }

      // Clean up temp directory if it exists and is empty
      const tempDir = path.join(process.cwd(), '.tmp-compare');
      if (fs.existsSync(tempDir)) {
        try {
          fs.rmdirSync(tempDir);
          // eslint-disable-next-line no-unused-vars
        } catch (_err) {
          // Directory not empty or other error - ignore
        }
      }

      // Output batch results as JSON
      console.log(
        JSON.stringify(
          {
            batchFile: args.batch,
            totalComparisons: pairs.length,
            successful: results.filter((r) => !('failed' in r && r.failed)).length,
            failed: results.filter((r) => 'failed' in r && r.failed).length,
            results
          },
          null,
          2
        )
      );

      return;
    }

    // SINGLE COMPARISON MODE
    // Validate that SVG paths are provided
    if (!args.svg1 || !args.svg2) {
      throw new ValidationError('Both SVG file paths are required for comparison');
    }

    if (args.verbose && !args.json) {
      console.log('Starting SVG comparison...');
      console.log(`SVG 1: ${args.svg1}`);
      console.log(`SVG 2: ${args.svg2}`);
      console.log(`Alignment: ${args.alignment}`);
      console.log(`Resolution: ${args.resolution}`);
      console.log(`Threshold: ${args.threshold}/256`);
    }

    const result = await performSingleComparison(args.svg1, args.svg2, args, browser);

    // Clean up temp directory if it exists and is empty
    const tempDir = path.join(process.cwd(), '.tmp-compare');
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmdirSync(tempDir);
        // eslint-disable-next-line no-unused-vars
      } catch (_err) {
        // Directory not empty or other error - ignore
      }
    }

    // Output results
    if (args.json) {
      console.log(
        JSON.stringify(
          {
            svg1: result.svg1,
            svg2: result.svg2,
            totalPixels: result.totalPixels,
            differentPixels: result.differentPixels,
            diffPercentage: result.diffPercentage,
            threshold: result.threshold,
            diffImage: result.diffImage
          },
          null,
          2
        )
      );
    } else {
      console.log('\n╔════════════════════════════════════════════════════════════════════════╗');
      console.log('║ COMPARISON RESULTS                                                     ║');
      console.log('╚════════════════════════════════════════════════════════════════════════╝\n');
      console.log(`  SVG 1:              ${result.svg1}`);
      console.log(`  SVG 2:              ${result.svg2}`);

      // Check if we have full comparison results (not an aspect ratio mismatch)
      const totalPixels = result.totalPixels ?? 0;
      const differentPixels = result.differentPixels ?? 0;
      console.log(`  Total pixels:       ${totalPixels.toLocaleString()}`);
      console.log(`  Different pixels:   ${differentPixels.toLocaleString()}`);
      console.log(`  Difference:         ${result.diffPercentage}%`);
      console.log(`  Threshold:          ${result.threshold ?? args.threshold}/256`);
      console.log(`  Diff image:         ${result.diffImage ?? 'N/A'}\n`);

      // Generate HTML report only if we have full results
      if (result.diffImage && result.svgAnalysis1 && result.svgAnalysis2) {
        if (args.verbose) {
          console.log('Generating HTML report...');
        }
        const htmlPath = await generateHtmlReport(
          result.svg1,
          result.svg2,
          result.diffImage,
          {
            totalPixels,
            differentPixels,
            diffPercentage: result.diffPercentage.toFixed(2)
          },
          args,
          result.svgAnalysis1,
          result.svgAnalysis2
        );

        printSuccess(`HTML report: ${htmlPath}`);

        // Auto-open in browser (unless --no-html or --headless is set)
        // NOTE: HTML report is ALWAYS generated; these flags only suppress browser opening
        const suppressBrowser = args.noHtml || args.headless;
        if (!suppressBrowser) {
          if (args.verbose) {
            console.log('Opening HTML report in browser...');
          }
          const { openInChrome } = require('./browser-utils.cjs');
          await openInChrome(htmlPath);
        } else if (args.verbose) {
          console.log('Skipping browser open (--no-html or --headless mode)');
        }
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new SVGBBoxError(`Comparison failed: ${errorMessage}`, 'COMPARISON_FAILED');
  } finally {
    // SECURITY: Ensure browser is always closed
    if (browser) {
      try {
        await browser.close();
        // eslint-disable-next-line no-unused-vars
      } catch (_closeErr) {
        // Force kill if close fails
        const browserProcess = browser.process();
        if (browserProcess) {
          browserProcess.kill('SIGKILL');
        }
      }
    }
  }
}

// SECURITY: Run with CLI error handling
runCLI(main);

module.exports = { main };
