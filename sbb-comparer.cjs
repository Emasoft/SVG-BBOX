#!/usr/bin/env node
/**
 * sbb-comparer.cjs
 *
 * Compare two SVG files by rendering them to PNG and performing pixel-by-pixel comparison.
 * Returns difference percentage and generates a visual diff image.
 *
 * Part of the svg-bbox toolkit.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const puppeteer = require('puppeteer');
const { getVersion } = require('./version.cjs');

const execFilePromise = promisify(execFile);

// SECURITY: Constants for timeouts and limits
const BROWSER_TIMEOUT_MS = 30000;  // 30 seconds
const FONT_TIMEOUT_MS = 8000;       // 8 seconds

// SECURITY: Import security utilities
const {
  validateFilePath,
  validateOutputPath,
  readSVGFileSafe,
  sanitizeSVGContent,
  writeFileSafe,
  SVGBBoxError,
  ValidationError,
  FileSystemError
} = require('./lib/security-utils.cjs');

const {
  runCLI,
  printSuccess,
  printError,
  printInfo,
  printWarning
} = require('./lib/cli-utils.cjs');

// ═══════════════════════════════════════════════════════════════════════════
// HELP TEXT
// ═══════════════════════════════════════════════════════════════════════════

function printHelp() {
  console.log(`
╔════════════════════════════════════════════════════════════════════════════╗
║ sbb-comparer.cjs - SVG Visual Comparison Tool                        ║
╚════════════════════════════════════════════════════════════════════════════╝

DESCRIPTION:
  Compares two SVG files by rendering them to PNG and performing pixel-by-pixel
  comparison. Returns difference percentage and generates a visual diff image.

USAGE:
  node sbb-comparer.cjs svg1.svg svg2.svg [options]

OPTIONS:
  --out-diff <file>         Output diff PNG file (white=different, black=same)
                            Default: <svg1>_vs_<svg2>_diff.png

  --threshold <1-20>        Pixel difference threshold (default: 1)
                            Pixels differ if any RGBA channel differs by more
                            than threshold/256. Range: 1-20

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

  --json                    Output results as JSON
  --verbose                 Show detailed progress information
  --help                    Show this help
  --version                 Show version

EXAMPLES:

  # Basic comparison with default settings
  node sbb-comparer.cjs original.svg modified.svg

  # Compare with custom diff output and threshold
  node sbb-comparer.cjs v1.svg v2.svg --out-diff diff.png --threshold 5

  # Align by viewBox centers, scale to match larger
  node sbb-comparer.cjs icon1.svg icon2.svg \\
    --alignment viewbox-center \\
    --resolution scale \\
    --meet-rule xMidYMid

  # Compare specific objects by ID
  node sbb-comparer.cjs sprite1.svg sprite2.svg \\
    --alignment object:icon_home

  # JSON output for automation
  node sbb-comparer.cjs test1.svg test2.svg --json

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

function printVersion(toolName) {
  const version = getVersion();
  console.log(`${toolName} v${version} | svg-bbox toolkit`);
}

// ═══════════════════════════════════════════════════════════════════════════
// ARGUMENT PARSING
// ═══════════════════════════════════════════════════════════════════════════

function parseArgs(argv) {
  const args = {
    svg1: null,
    svg2: null,
    outDiff: null,
    threshold: 1,
    alignment: 'origin',
    alignmentParam: null,
    resolution: 'viewbox',
    meetRule: 'xMidYMid',
    sliceRule: 'xMidYMid',
    json: false,
    verbose: false
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--version' || arg === '-v') {
      printVersion('sbb-comparer');
      process.exit(0);
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--verbose') {
      args.verbose = true;
    } else if (arg === '--out-diff' && i + 1 < argv.length) {
      args.outDiff = argv[++i];
    } else if (arg === '--threshold' && i + 1 < argv.length) {
      args.threshold = parseInt(argv[++i], 10);
      if (args.threshold < 1 || args.threshold > 20) {
        console.error('Error: --threshold must be between 1 and 20');
        process.exit(2);
      }
    } else if (arg === '--alignment' && i + 1 < argv.length) {
      const alignValue = argv[++i];
      if (alignValue.startsWith('object:')) {
        args.alignment = 'object';
        args.alignmentParam = alignValue.substring(7);
      } else if (alignValue.startsWith('custom:')) {
        args.alignment = 'custom';
        const coords = alignValue.substring(7).split(',');
        if (coords.length !== 2) {
          console.error('Error: custom alignment requires x,y coordinates');
          process.exit(2);
        }
        args.alignmentParam = { x: parseFloat(coords[0]), y: parseFloat(coords[1]) };
      } else {
        args.alignment = alignValue;
      }
    } else if (arg === '--resolution' && i + 1 < argv.length) {
      args.resolution = argv[++i];
    } else if (arg === '--meet-rule' && i + 1 < argv.length) {
      args.meetRule = argv[++i];
    } else if (arg === '--slice-rule' && i + 1 < argv.length) {
      args.sliceRule = argv[++i];
    } else if (!arg.startsWith('-')) {
      if (!args.svg1) {
        args.svg1 = arg;
      } else if (!args.svg2) {
        args.svg2 = arg;
      } else {
        console.error(`Error: Unexpected argument: ${arg}`);
        process.exit(2);
      }
    } else {
      console.error(`Error: Unknown option: ${arg}`);
      process.exit(2);
    }
  }

  // Validate required arguments
  if (!args.svg1 || !args.svg2) {
    console.error('Error: Two SVG files required');
    console.error('Usage: node sbb-comparer.cjs svg1.svg svg2.svg [options]');
    process.exit(2);
  }

  // Set default output diff file
  if (!args.outDiff) {
    const base1 = path.basename(args.svg1, path.extname(args.svg1));
    const base2 = path.basename(args.svg2, path.extname(args.svg2));
    args.outDiff = `${base1}_vs_${base2}_diff.png`;
  }

  return args;
}

// ═══════════════════════════════════════════════════════════════════════════
// SVG ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

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
    const svg = document.querySelector('svg');
    if (!svg) return null;

    const result = {
      viewBox: null,
      width: null,
      height: null,
      origin: { x: 0, y: 0 }
    };

    // Get viewBox
    const vb = svg.viewBox.baseVal;
    if (vb && vb.width && vb.height) {
      result.viewBox = {
        x: vb.x,
        y: vb.y,
        width: vb.width,
        height: vb.height,
        centerX: vb.x + vb.width / 2,
        centerY: vb.y + vb.height / 2
      };
    }

    // Get width/height attributes
    const widthAttr = svg.getAttribute('width');
    const heightAttr = svg.getAttribute('height');
    if (widthAttr) result.width = parseFloat(widthAttr);
    if (heightAttr) result.height = parseFloat(heightAttr);

    return result;
  });

  await page.close();
  return analysis;
}

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

  const bbox = await page.evaluate((id) => {
    const element = document.getElementById(id);
    if (!element) return null;

    const rect = element.getBBox();
    return {
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2
    };
  }, objectId);

  await page.close();
  return bbox;
}

// ═══════════════════════════════════════════════════════════════════════════
// ALIGNMENT & RESOLUTION CALCULATION
// ═══════════════════════════════════════════════════════════════════════════

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
      if (analysis1.viewBox) align1 = { x: analysis1.viewBox.x, y: analysis1.viewBox.y };
      if (analysis2.viewBox) align2 = { x: analysis2.viewBox.x, y: analysis2.viewBox.y };
      break;

    case 'viewbox-center':
      if (analysis1.viewBox) align1 = { x: analysis1.viewBox.centerX, y: analysis1.viewBox.centerY };
      if (analysis2.viewBox) align2 = { x: analysis2.viewBox.centerX, y: analysis2.viewBox.centerY };
      break;

    case 'object':
      const bbox1 = await getObjectBBox(svg1Path, args.alignmentParam, browser);
      const bbox2 = await getObjectBBox(svg2Path, args.alignmentParam, browser);
      if (bbox1) align1 = bbox1;
      if (bbox2) align2 = bbox2;
      break;

    case 'custom':
      align1 = args.alignmentParam;
      align2 = args.alignmentParam;
      break;
  }

  // Determine resolution based on mode
  let width1, height1, width2, height2;

  switch (args.resolution) {
    case 'nominal':
      width1 = analysis1.width || 800;
      height1 = analysis1.height || 600;
      width2 = analysis2.width || 800;
      height2 = analysis2.height || 600;
      break;

    case 'viewbox':
      width1 = analysis1.viewBox?.width || analysis1.width || 800;
      height1 = analysis1.viewBox?.height || analysis1.height || 600;
      width2 = analysis2.viewBox?.width || analysis2.width || 800;
      height2 = analysis2.viewBox?.height || analysis2.height || 600;
      break;

    case 'full':
      // Would need to compute full drawing bbox - use viewbox as fallback for now
      width1 = analysis1.viewBox?.width || analysis1.width || 800;
      height1 = analysis1.viewBox?.height || analysis1.height || 600;
      width2 = analysis2.viewBox?.width || analysis2.width || 800;
      height2 = analysis2.viewBox?.height || analysis2.height || 600;
      break;

    case 'scale':
      // Scale both to match the larger one (uniform scaling)
      width1 = analysis1.viewBox?.width || analysis1.width || 800;
      height1 = analysis1.viewBox?.height || analysis1.height || 600;
      width2 = analysis2.viewBox?.width || analysis2.width || 800;
      height2 = analysis2.viewBox?.height || analysis2.height || 600;

      const maxWidth = Math.max(width1, width2);
      const maxHeight = Math.max(height1, height2);
      width1 = width2 = maxWidth;
      height1 = height2 = maxHeight;
      break;

    case 'stretch':
      // Stretch both to match the larger one (non-uniform)
      width1 = analysis1.viewBox?.width || analysis1.width || 800;
      height1 = analysis1.viewBox?.height || analysis1.height || 600;
      width2 = analysis2.viewBox?.width || analysis2.width || 800;
      height2 = analysis2.viewBox?.height || analysis2.height || 600;

      const stretchWidth = Math.max(width1, width2);
      const stretchHeight = Math.max(height1, height2);
      width1 = width2 = stretchWidth;
      height1 = height2 = stretchHeight;
      break;

    case 'clip':
      // Clip both to match the smaller one
      width1 = analysis1.viewBox?.width || analysis1.width || 800;
      height1 = analysis1.viewBox?.height || analysis1.height || 600;
      width2 = analysis2.viewBox?.width || analysis2.width || 800;
      height2 = analysis2.viewBox?.height || analysis2.height || 600;

      const minWidth = Math.min(width1, width2);
      const minHeight = Math.min(height1, height2);
      width1 = width2 = minWidth;
      height1 = height2 = minHeight;
      break;

    default:
      width1 = width2 = 800;
      height1 = height2 = 600;
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
  await new Promise(resolve => setTimeout(resolve, FONT_TIMEOUT_MS));

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
  const thresholdValue = threshold; // threshold is already 1-20

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;

      // Get pixel values (handle images of different sizes)
      const r1 = x < png1.width && y < png1.height ? png1.data[idx] : 0;
      const g1 = x < png1.width && y < png1.height ? png1.data[idx + 1] : 0;
      const b1 = x < png1.width && y < png1.height ? png1.data[idx + 2] : 0;
      const a1 = x < png1.width && y < png1.height ? png1.data[idx + 3] : 0;

      const r2 = x < png2.width && y < png2.height ? png2.data[idx] : 0;
      const g2 = x < png2.width && y < png2.height ? png2.data[idx + 1] : 0;
      const b2 = x < png2.width && y < png2.height ? png2.data[idx + 2] : 0;
      const a2 = x < png2.width && y < png2.height ? png2.data[idx + 3] : 0;

      // Check if pixels are different (any channel differs by more than threshold)
      const rDiff = Math.abs(r1 - r2);
      const gDiff = Math.abs(g1 - g2);
      const bDiff = Math.abs(b1 - b2);
      const aDiff = Math.abs(a1 - a2);

      const isDifferent = rDiff > thresholdValue || gDiff > thresholdValue ||
                         bDiff > thresholdValue || aDiff > thresholdValue;

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

async function generateHtmlReport(svg1Path, svg2Path, diffPngPath, result, args, svgAnalysis1, svgAnalysis2) {
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
  const formatDate = (date) => {
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };
  const svg1Modified = formatDate(svg1Stats.mtime);
  const svg2Modified = formatDate(svg2Stats.mtime);

  // Format viewBox info
  const formatViewBox = (vb) => {
    if (!vb) return 'none';
    return `${vb.x} ${vb.y} ${vb.width} ${vb.height}`;
  };

  // Format resolution info
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

      /* Dotted border matching sbb-extractor - shows actual SVG boundary */
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

    <h1 data-tooltip="Visual comparison report generated by sbb-comparer tool">📊 SVG Comparison Report</h1>

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
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  // Display version
  printInfo(`sbb-comparer v${getVersion()} | svg-bbox toolkit\n`);

  const args = parseArgs(process.argv);

  // SECURITY: Validate input SVG files
  const safeSvg1Path = validateFilePath(args.svg1, {
    requiredExtensions: ['.svg'],
    mustExist: true
  });
  const safeSvg2Path = validateFilePath(args.svg2, {
    requiredExtensions: ['.svg'],
    mustExist: true
  });

  if (args.verbose && !args.json) {
    console.log('Starting SVG comparison...');
    console.log(`SVG 1: ${safeSvg1Path}`);
    console.log(`SVG 2: ${safeSvg2Path}`);
    console.log(`Alignment: ${args.alignment}`);
    console.log(`Resolution: ${args.resolution}`);
    console.log(`Threshold: ${args.threshold}/256`);
  }

  let browser = null;
  try {
    // SECURITY: Launch browser with security args and timeout
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      timeout: BROWSER_TIMEOUT_MS
    });

    // Calculate render parameters
    if (args.verbose && !args.json) {
      console.log('Analyzing SVG files...');
    }
    const params = await calculateRenderParams(safeSvg1Path, safeSvg2Path, args, browser);

    // Store SVG analysis for HTML report
    const svgAnalysis1 = await analyzeSvg(safeSvg1Path, browser);
    const svgAnalysis2 = await analyzeSvg(safeSvg2Path, browser);

    // Render SVGs to PNG
    const tempDir = path.join(process.cwd(), '.tmp-compare');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const png1Path = path.join(tempDir, 'svg1.png');
    const png2Path = path.join(tempDir, 'svg2.png');

    if (args.verbose && !args.json) {
      console.log('Rendering SVG 1 to PNG...');
    }
    await renderSvgToPng(safeSvg1Path, png1Path, params.svg1.width, params.svg1.height, browser);

    if (args.verbose && !args.json) {
      console.log('Rendering SVG 2 to PNG...');
    }
    await renderSvgToPng(safeSvg2Path, png2Path, params.svg2.width, params.svg2.height, browser);

    // Compare images
    if (args.verbose && !args.json) {
      console.log('Comparing images...');
    }
    const result = await compareImages(png1Path, png2Path, args.outDiff, args.threshold);

    // Clean up temp files
    fs.unlinkSync(png1Path);
    fs.unlinkSync(png2Path);
    fs.rmdirSync(tempDir);

    // Output results
    if (args.json) {
      console.log(JSON.stringify({
        svg1: args.svg1,
        svg2: args.svg2,
        totalPixels: result.totalPixels,
        differentPixels: result.differentPixels,
        diffPercentage: parseFloat(result.diffPercentage),
        threshold: args.threshold,
        diffImage: args.outDiff
      }, null, 2));
    } else {
      console.log('\n╔════════════════════════════════════════════════════════════════════════╗');
      console.log('║ COMPARISON RESULTS                                                     ║');
      console.log('╚════════════════════════════════════════════════════════════════════════╝\n');
      console.log(`  SVG 1:              ${args.svg1}`);
      console.log(`  SVG 2:              ${args.svg2}`);
      console.log(`  Total pixels:       ${result.totalPixels.toLocaleString()}`);
      console.log(`  Different pixels:   ${result.differentPixels.toLocaleString()}`);
      console.log(`  Difference:         ${result.diffPercentage}%`);
      console.log(`  Threshold:          ${args.threshold}/256`);
      console.log(`  Diff image:         ${args.outDiff}\n`);
    }

    // Generate HTML report
    if (!args.json) {
      if (args.verbose) {
        console.log('Generating HTML report...');
      }
      const htmlPath = await generateHtmlReport(
        safeSvg1Path,
        safeSvg2Path,
        args.outDiff,
        result,
        args,
        svgAnalysis1,
        svgAnalysis2
      );

      printSuccess(`HTML report: ${htmlPath}`);

      // Auto-open in browser
      if (args.verbose) {
        console.log('Opening HTML report in browser...');
      }
      const { openInChrome } = require('./browser-utils.cjs');
      await openInChrome(htmlPath);
    }

  } catch (error) {
    throw new SVGBBoxError(`Comparison failed: ${error.message}`, error);
  } finally {
    // SECURITY: Ensure browser is always closed
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        // Force kill if close fails
        if (browser.process()) {
          browser.process().kill('SIGKILL');
        }
      }
    }
  }
}

// SECURITY: Run with CLI error handling
runCLI(main);

module.exports = { main };
