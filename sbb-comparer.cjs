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
  const svgContent = fs.readFileSync(svgPath, 'utf-8');
  const page = await browser.newPage();

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
      ${svgContent}
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
  const svgContent = fs.readFileSync(svgPath, 'utf-8');
  const page = await browser.newPage();

  await page.setContent(`
    <!DOCTYPE html>
    <html>
    <head>
      <style>body { margin: 0; padding: 0; }</style>
    </head>
    <body>${svgContent}</body>
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
  const svgContent = fs.readFileSync(svgPath, 'utf-8');
  const page = await browser.newPage();

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
      ${svgContent}
    </body>
    </html>
  `);

  // Wait for fonts and rendering
  await new Promise(resolve => setTimeout(resolve, 500));

  await page.screenshot({
    path: outputPath,
    type: 'png',
    omitBackground: true
  });

  await page.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// PIXEL COMPARISON
// ═══════════════════════════════════════════════════════════════════════════

async function compareImages(png1Path, png2Path, diffPath, threshold) {
  // Read PNG files using a simple PNG library approach
  // For now, we'll use a Node.js implementation
  const { PNG } = require('pngjs');

  const png1Data = fs.readFileSync(png1Path);
  const png2Data = fs.readFileSync(png2Path);

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

  // Write diff image
  const buffer = PNG.sync.write(diff);
  fs.writeFileSync(diffPath, buffer);

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
  // Read files and convert to base64 for embedding
  const svg1Content = fs.readFileSync(svg1Path, 'utf-8');
  const svg2Content = fs.readFileSync(svg2Path, 'utf-8');
  const diffPngBuffer = fs.readFileSync(diffPngPath);
  const diffPngBase64 = diffPngBuffer.toString('base64');

  // Get relative paths for links
  const svg1Relative = path.relative(process.cwd(), svg1Path);
  const svg2Relative = path.relative(process.cwd(), svg2Path);

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
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SVG Comparison Report</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #f5f5f5;
      padding: 20px;
      color: #333;
    }

    .container {
      max-width: 1800px;
      margin: 0 auto;
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      padding: 30px;
    }

    h1 {
      color: #2c3e50;
      margin-bottom: 20px;
      font-size: 28px;
      text-align: center;
    }

    .settings-summary {
      background: #ecf0f1;
      padding: 20px;
      border-radius: 6px;
      margin-bottom: 30px;
      border-left: 4px solid #3498db;
    }

    .settings-summary h2 {
      font-size: 18px;
      margin-bottom: 12px;
      color: #2c3e50;
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
      color: #555;
    }

    .setting-value {
      color: #2c3e50;
      font-family: 'Courier New', monospace;
    }

    .comparison-grid {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 20px;
      margin-top: 20px;
    }

    .svg-panel {
      border: 1px solid #ddd;
      border-radius: 6px;
      padding: 15px;
      background: #fafafa;
    }

    .panel-header {
      margin-bottom: 12px;
    }

    .panel-title {
      font-size: 16px;
      font-weight: 600;
      color: #2c3e50;
      margin-bottom: 8px;
    }

    .file-link {
      display: inline-block;
      color: #3498db;
      text-decoration: none;
      font-size: 13px;
      word-break: break-all;
      padding: 4px 8px;
      background: white;
      border-radius: 4px;
      border: 1px solid #ddd;
      transition: all 0.2s;
    }

    .file-link:hover {
      background: #3498db;
      color: white;
    }

    .svg-container {
      background: white;
      border: 1px solid #ddd;
      border-radius: 4px;
      padding: 15px;
      margin: 12px 0;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 300px;
    }

    .svg-container svg {
      max-width: 100%;
      max-height: 500px;
      height: auto;
    }

    .diff-container {
      background: white;
      border: 1px solid #ddd;
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
      background: white;
      border: 1px solid #e0e0e0;
      border-radius: 4px;
      padding: 12px;
      font-size: 13px;
      margin-top: 12px;
    }

    .info-row {
      display: flex;
      justify-content: space-between;
      padding: 6px 0;
      border-bottom: 1px solid #f0f0f0;
    }

    .info-row:last-child {
      border-bottom: none;
    }

    .info-label {
      font-weight: 600;
      color: #555;
    }

    .info-value {
      color: #2c3e50;
      font-family: 'Courier New', monospace;
      text-align: right;
    }

    .result-panel {
      background: #e8f5e9;
      border: 2px solid #4caf50;
      border-radius: 6px;
      padding: 20px;
      text-align: center;
      margin-top: 12px;
    }

    .result-percentage {
      font-size: 48px;
      font-weight: 700;
      color: #2e7d32;
      margin: 10px 0;
    }

    .result-label {
      font-size: 14px;
      color: #555;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .result-stats {
      margin-top: 15px;
      font-size: 13px;
      color: #666;
    }

    @media (max-width: 1200px) {
      .comparison-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>📊 SVG Comparison Report</h1>

    <div class="settings-summary">
      <h2>⚙️ Comparison Settings</h2>
      <div class="settings-grid">
        <div class="setting-item">
          <span class="setting-label">Alignment:</span>
          <span class="setting-value">${args.alignment}${args.alignmentParam ? ` (${JSON.stringify(args.alignmentParam)})` : ''}</span>
        </div>
        <div class="setting-item">
          <span class="setting-label">Resolution:</span>
          <span class="setting-value">${args.resolution}</span>
        </div>
        <div class="setting-item">
          <span class="setting-label">Threshold:</span>
          <span class="setting-value">${args.threshold}/256</span>
        </div>
        <div class="setting-item">
          <span class="setting-label">Meet Rule:</span>
          <span class="setting-value">${args.meetRule}</span>
        </div>
        <div class="setting-item">
          <span class="setting-label">Slice Rule:</span>
          <span class="setting-value">${args.sliceRule}</span>
        </div>
      </div>
    </div>

    <div class="comparison-grid">
      <!-- SVG 1 Panel -->
      <div class="svg-panel">
        <div class="panel-header">
          <div class="panel-title">📄 SVG 1</div>
          <a href="${svg1Relative}" class="file-link" target="_blank">${svg1Relative}</a>
        </div>
        <div class="svg-container">
          ${svg1Content}
        </div>
        <div class="info-panel">
          <div class="info-row">
            <span class="info-label">ViewBox:</span>
            <span class="info-value">${formatViewBox(svgAnalysis1.viewBox)}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Width:</span>
            <span class="info-value">${svgAnalysis1.width || 'none'}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Height:</span>
            <span class="info-value">${svgAnalysis1.height || 'none'}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Resolution:</span>
            <span class="info-value">${formatResolution(svgAnalysis1)}</span>
          </div>
        </div>
      </div>

      <!-- SVG 2 Panel -->
      <div class="svg-panel">
        <div class="panel-header">
          <div class="panel-title">📄 SVG 2</div>
          <a href="${svg2Relative}" class="file-link" target="_blank">${svg2Relative}</a>
        </div>
        <div class="svg-container">
          ${svg2Content}
        </div>
        <div class="info-panel">
          <div class="info-row">
            <span class="info-label">ViewBox:</span>
            <span class="info-value">${formatViewBox(svgAnalysis2.viewBox)}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Width:</span>
            <span class="info-value">${svgAnalysis2.width || 'none'}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Height:</span>
            <span class="info-value">${svgAnalysis2.height || 'none'}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Resolution:</span>
            <span class="info-value">${formatResolution(svgAnalysis2)}</span>
          </div>
        </div>
      </div>

      <!-- Diff Panel -->
      <div class="svg-panel">
        <div class="panel-header">
          <div class="panel-title">🔍 Visual Difference</div>
          <span class="file-link" style="cursor: default; pointer-events: none;">White = Different, Black = Same</span>
        </div>
        <div class="diff-container">
          <img src="data:image/png;base64,${diffPngBase64}" alt="Difference visualization">
        </div>
        <div class="result-panel">
          <div class="result-label">Difference</div>
          <div class="result-percentage">${result.diffPercentage}%</div>
          <div class="result-stats">
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

  fs.writeFileSync(htmlPath, html, 'utf-8');

  return htmlPath;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const args = parseArgs(process.argv);

  // Verify input files exist
  if (!fs.existsSync(args.svg1)) {
    console.error(`Error: File not found: ${args.svg1}`);
    process.exit(1);
  }
  if (!fs.existsSync(args.svg2)) {
    console.error(`Error: File not found: ${args.svg2}`);
    process.exit(1);
  }

  if (args.verbose && !args.json) {
    console.log('Starting SVG comparison...');
    console.log(`SVG 1: ${args.svg1}`);
    console.log(`SVG 2: ${args.svg2}`);
    console.log(`Alignment: ${args.alignment}`);
    console.log(`Resolution: ${args.resolution}`);
    console.log(`Threshold: ${args.threshold}/256`);
  }

  let browser;
  try {
    // Launch browser
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    // Calculate render parameters
    if (args.verbose && !args.json) {
      console.log('Analyzing SVG files...');
    }
    const params = await calculateRenderParams(args.svg1, args.svg2, args, browser);

    // Store SVG analysis for HTML report
    const svgAnalysis1 = await analyzeSvg(args.svg1, browser);
    const svgAnalysis2 = await analyzeSvg(args.svg2, browser);

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
    await renderSvgToPng(args.svg1, png1Path, params.svg1.width, params.svg1.height, browser);

    if (args.verbose && !args.json) {
      console.log('Rendering SVG 2 to PNG...');
    }
    await renderSvgToPng(args.svg2, png2Path, params.svg2.width, params.svg2.height, browser);

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
        args.svg1,
        args.svg2,
        args.outDiff,
        result,
        args,
        svgAnalysis1,
        svgAnalysis2
      );

      console.log(`  HTML report:        ${htmlPath}`);

      // Auto-open in browser
      if (args.verbose) {
        console.log('Opening HTML report in browser...');
      }
      const { openInChrome } = require('./browser-utils.cjs');
      await openInChrome(htmlPath);
    }

  } catch (error) {
    console.error('Error:', error.message);
    if (args.verbose) {
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { main };
