#!/usr/bin/env node
/**
 * Fix SVG files missing width/height/viewBox using Puppeteer + SvgVisualBBox.
 *
 * Usage:
 *   node sbb-fix-viewbox.cjs input.svg [output.svg] [--auto-open]
 *
 * If output.svg is omitted, the script writes a new file named:
 *   <input>.fixed.svg
 *
 * Options:
 *   --auto-open: Automatically open the fixed SVG in Chrome/Chromium ONLY
 *                (other browsers have poor SVG support)
 *
 * What it does:
 *   - Loads the SVG into a headless browser.
 *   - Injects SvgVisualBBox.js.
 *   - Computes the full visual bbox of the root <svg> (unclipped).
 *   - If the <svg> has no viewBox, sets viewBox to that bbox.
 *   - If width/height are missing, synthesizes them from the viewBox and aspect ratio.
 *   - Serializes the updated SVG and saves it.
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { execFile: _execFile } = require('child_process');
const { openInChrome } = require('./browser-utils.cjs');
const { getVersion, printVersion, hasVersionFlag: _hasVersionFlag } = require('./version.cjs');
const { BROWSER_TIMEOUT_MS, FONT_TIMEOUT_MS } = require('./config/timeouts.cjs');

// SECURITY: Import security utilities
const {
  validateFilePath,
  validateOutputPath,
  readSVGFileSafe,
  sanitizeSVGContent,
  writeFileSafe,
  SVGBBoxError: _SVGBBoxError,
  ValidationError: _ValidationError,
  FileSystemError
} = require('./lib/security-utils.cjs');

const {
  runCLI,
  printSuccess,
  printError: _printError,
  printInfo,
  printWarning
} = require('./lib/cli-utils.cjs');

function printHelp() {
  console.log(`
╔════════════════════════════════════════════════════════════════════════════╗
║ sbb-fix-viewbox.cjs - Repair Missing SVG ViewBox & Dimensions              ║
╚════════════════════════════════════════════════════════════════════════════╝

DESCRIPTION:
  Automatically fixes SVG files missing viewBox, width, or height attributes
  by computing the full visual bbox of all content.

USAGE:
  node sbb-fix-viewbox.cjs input.svg [output.svg] [--auto-open] [--force] [--overwrite] [--help]

ARGUMENTS:
  input.svg           Input SVG file to fix
  output.svg          Output file path (default: input_fixed.svg)

OPTIONS:
  --force             Force regeneration of viewBox and dimensions (ignore existing)
  --overwrite         Overwrite input file (USE WITH CAUTION - loses original viewBox!)
  --auto-open         Automatically open fixed SVG in Chrome/Chromium
  --help, -h          Show this help message

WHAT IT DOES:
  1. Loads SVG in headless Chrome
  2. Computes full visual bbox of root <svg> (unclipped mode)
  3. If viewBox is missing:
     → Sets viewBox to computed bbox
  4. If width/height are missing:
     → Synthesizes them from viewBox aspect ratio
  5. Saves repaired SVG to output file

AUTO-REPAIR RULES:
  • viewBox missing:
      Set to full visual bbox of content

  • width & height both missing:
      Use viewBox width/height as px values

  • Only width missing:
      Derive width from height × (viewBox aspect ratio)

  • Only height missing:
      Derive height from width ÷ (viewBox aspect ratio)

  • preserveAspectRatio:
      Not modified (browser defaults apply)

EXAMPLES:
  # Fix SVG with default output name
  node sbb-fix-viewbox.cjs broken.svg
  → Creates: broken.fixed.svg

  # Fix with custom output path
  node sbb-fix-viewbox.cjs broken.svg repaired.svg

  # Fix and automatically open in browser
  node sbb-fix-viewbox.cjs broken.svg --auto-open

USE CASES:
  • SVG exports from design tools missing viewBox
  • Dynamically generated SVGs without proper dimensions
  • SVGs that appear blank due to missing/incorrect viewBox
  • Preparing SVGs for responsive web use

`);
}

function parseArgs(argv) {
  const args = argv.slice(2);

  // Check for --help
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  if (args.length < 1) {
    printHelp();
    process.exit(1);
  }

  const positional = [];
  let autoOpen = false;
  let force = false;
  let overwrite = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--auto-open') {
      autoOpen = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--overwrite') {
      overwrite = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--version' || arg === '-v') {
      printVersion('sbb-fix-viewbox');
      process.exit(0);
    } else {
      positional.push(arg);
    }
  }

  const input = positional[0];
  // SECURITY: Default to _fixed.svg suffix to preserve original
  // Only overwrite if explicitly requested with --overwrite flag
  let output;
  if (overwrite) {
    output = input;
  } else if (positional[1]) {
    output = positional[1];
  } else {
    output = input.replace(/\.svg$/i, '') + '_fixed.svg';
  }

  return { input, output, autoOpen, force, overwrite };
}

// SECURITY: Secure Puppeteer options
const PUPPETEER_OPTIONS = {
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
};

async function fixSvgFile(inputPath, outputPath, autoOpen = false, force = false) {
  // SECURITY: Validate and sanitize input path
  const safePath = validateFilePath(inputPath, {
    requiredExtensions: ['.svg'],
    mustExist: true
  });

  // SECURITY: Read SVG with size limit and validation
  const svgContent = readSVGFileSafe(safePath);

  // SECURITY: Sanitize SVG content (remove scripts, event handlers)
  const sanitizedSvg = sanitizeSVGContent(svgContent);

  let browser = null;

  try {
    browser = await puppeteer.launch(PUPPETEER_OPTIONS);
    const page = await browser.newPage();

    // SECURITY: Set page timeout
    page.setDefaultTimeout(BROWSER_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(BROWSER_TIMEOUT_MS);

    // Create HTML with sanitized SVG
    // NOTE: No CSP header - it breaks addScriptTag functionality
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Fix SVG</title>
</head>
<body>
${sanitizedSvg}
</body>
</html>`;

    await page.setContent(html, {
      waitUntil: 'networkidle0',
      timeout: BROWSER_TIMEOUT_MS
    });

    // Load SvgVisualBBox library
    const libPath = path.join(__dirname, 'SvgVisualBBox.js');
    if (!fs.existsSync(libPath)) {
      throw new FileSystemError('SvgVisualBBox.js not found', { path: libPath });
    }
    await page.addScriptTag({ path: libPath });

    // Wait for fonts to load (with timeout)
    await page.evaluate(async (timeout) => {
      /* eslint-disable no-undef */
      if (window.SvgVisualBBox && window.SvgVisualBBox.waitForDocumentFonts) {
        await window.SvgVisualBBox.waitForDocumentFonts(document, timeout);
      }
      /* eslint-enable no-undef */
    }, FONT_TIMEOUT_MS);

    // Run the fix inside the browser context
    const fixedSvgString = await page.evaluate(async (forceRegenerate) => {
      /* eslint-disable no-undef */
      const SvgVisualBBox = window.SvgVisualBBox;
      if (!SvgVisualBBox) {
        throw new Error('SvgVisualBBox not found on window. Did the script load?');
      }

      const svg = document.querySelector('svg');
      if (!svg) {
        throw new Error('No <svg> element found in the document.');
      }

      // 1) Compute full visual bbox of the root <svg> (unclipped)
      const both = await SvgVisualBBox.getSvgElementVisibleAndFullBBoxes(svg, {
        coarseFactor: 3,
        fineFactor: 24,
        useLayoutScale: true
      });

      if (!both.full) {
        throw new Error('Full drawing bbox is empty; nothing to fix.');
      }

      const full = both.full; // {x,y,width,height} in SVG user units

      // 2) FORCE MODE: Delete existing attributes to ensure clean regeneration
      if (forceRegenerate) {
        // Remove existing viewBox, width, height to ensure no contamination
        svg.removeAttribute('viewBox');
        svg.removeAttribute('width');
        svg.removeAttribute('height');
      }

      // 3) Ensure viewBox
      // Define viewBox-like object type (not a full DOMRect, just coordinates)
      /** @type {{ x: number; y: number; width: number; height: number }} */
      let vb;
      const viewBoxBaseVal = svg.viewBox && svg.viewBox.baseVal;
      if (forceRegenerate || !viewBoxBaseVal || !viewBoxBaseVal.width || !viewBoxBaseVal.height) {
        // Force mode or no viewBox → set it to full drawing bbox
        svg.setAttribute('viewBox', `${full.x} ${full.y} ${full.width} ${full.height}`);
        vb = { x: full.x, y: full.y, width: full.width, height: full.height };
      } else {
        // If there *is* a viewBox already and not forcing, we won't change it here.
        vb = {
          x: viewBoxBaseVal.x,
          y: viewBoxBaseVal.y,
          width: viewBoxBaseVal.width,
          height: viewBoxBaseVal.height
        };
      }

      // 4) Ensure width/height attributes
      const widthAttr = svg.getAttribute('width');
      const heightAttr = svg.getAttribute('height');

      const hasWidth = !!widthAttr;
      const hasHeight = !!heightAttr;

      // We use the viewBox aspect ratio as the "truth"
      const vbAspect = vb.width > 0 && vb.height > 0 ? vb.width / vb.height : 1;

      let newWidth = widthAttr;
      let newHeight = heightAttr;

      if (forceRegenerate) {
        // Force mode: always regenerate width/height from viewBox (already deleted above)
        newWidth = String(vb.width);
        newHeight = String(vb.height);
      } else if (!hasWidth && !hasHeight) {
        // Neither width nor height set → use viewBox width/height as px
        newWidth = String(vb.width);
        newHeight = String(vb.height);
      } else if (!hasWidth && hasHeight) {
        // height given, width missing → derive width from aspect ratio
        const h = parseFloat(heightAttr);
        if (isFinite(h) && h > 0 && vbAspect > 0) {
          newWidth = String(h * vbAspect);
        } else {
          newWidth = String(vb.width || 1000);
        }
      } else if (hasWidth && !hasHeight) {
        // width given, height missing → derive height from aspect ratio
        const w = parseFloat(widthAttr);
        if (isFinite(w) && w > 0 && vbAspect > 0) {
          newHeight = String(w / vbAspect);
        } else {
          newHeight = String(vb.height || 1000);
        }
      } else {
        // both width and height exist: keep as-is (unless forcing)
      }

      if (newWidth) {
        svg.setAttribute('width', newWidth);
      }
      if (newHeight) {
        svg.setAttribute('height', newHeight);
      }

      // 4) Serialize the fixed <svg> back to string
      const serializer = new XMLSerializer();
      // In case the original file had extra stuff around the root, we just output the <svg> itself.
      /* eslint-enable no-undef */
      return serializer.serializeToString(svg);
    }, force);

    // SECURITY: Validate output path and write safely
    const safeOutPath = validateOutputPath(outputPath, {
      requiredExtensions: ['.svg']
    });
    writeFileSafe(safeOutPath, fixedSvgString, 'utf8');
    printSuccess(`Fixed SVG saved to: ${safeOutPath}`);

    // Auto-open SVG in Chrome/Chromium if requested
    // CRITICAL: Must use Chrome/Chromium (other browsers have poor SVG support)
    if (autoOpen) {
      const absolutePath = path.resolve(safeOutPath);

      openInChrome(absolutePath)
        .then((result) => {
          if (result.success) {
            printSuccess(`Opened in Chrome: ${absolutePath}`);
          } else {
            printWarning(result.error);
            printInfo(`Please open manually in Chrome/Chromium: ${absolutePath}`);
          }
        })
        .catch((err) => {
          printWarning(`Failed to auto-open: ${err.message}`);
          printInfo(`Please open manually in Chrome/Chromium: ${absolutePath}`);
        });
    }
  } finally {
    // SECURITY: Ensure browser is always closed
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Force kill if close fails
        if (browser.process()) {
          browser.process().kill('SIGKILL');
        }
      }
    }
  }
}

// -------- entry point --------

async function main() {
  // Display version
  printInfo(`sbb-fix-viewbox v${getVersion()} | svg-bbox toolkit\n`);

  const { input, output, autoOpen, force, overwrite } = parseArgs(process.argv);

  // SECURITY: Warn when overwriting original file
  if (overwrite) {
    printWarning('⚠️  --overwrite flag detected: Original viewBox information will be lost!');
    printWarning('   Original file will be overwritten. Press Ctrl+C to cancel...');
    // Give user 2 seconds to cancel
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  await fixSvgFile(input, output, autoOpen, force);
}

runCLI(main);
