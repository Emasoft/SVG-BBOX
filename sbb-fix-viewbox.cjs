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
const { execFile } = require('child_process');
const { openInChrome } = require('./browser-utils.cjs');

function printHelp() {
  console.log(`
╔════════════════════════════════════════════════════════════════════════════╗
║ sbb-fix-viewbox.cjs - Repair Missing SVG ViewBox & Dimensions              ║
╚════════════════════════════════════════════════════════════════════════════╝

DESCRIPTION:
  Automatically fixes SVG files missing viewBox, width, or height attributes
  by computing the full visual bbox of all content.

USAGE:
  node sbb-fix-viewbox.cjs input.svg [output.svg] [--auto-open] [--help]

ARGUMENTS:
  input.svg           Input SVG file to fix
  output.svg          Output file path (default: input.fixed.svg)

OPTIONS:
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

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--auto-open') {
      autoOpen = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      printHelp();
      process.exit(0);
    } else {
      positional.push(args[i]);
    }
  }

  const input = positional[0];
  const output = positional[1] || (input.replace(/\.svg$/i, '') + '.fixed.svg');
  return { input, output, autoOpen };
}

async function fixSvgFile(inputPath, outputPath, autoOpen = false) {
  const svgPath = path.resolve(inputPath);
  if (!fs.existsSync(svgPath)) {
    throw new Error('SVG file does not exist: ' + svgPath);
  }

  const svgContent = fs.readFileSync(svgPath, 'utf8');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();

    // Minimal HTML; we’ll inject the SVG markup and run our library in-page
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Fix SVG</title>
</head>
<body>
${svgContent}
</body>
</html>`;

    await page.setContent(html, { waitUntil: 'networkidle0' });

    // Inject SvgVisualBBox.js
    const libPath = path.resolve(__dirname, 'SvgVisualBBox.js');
    if (!fs.existsSync(libPath)) {
      throw new Error('SvgVisualBBox.js not found at: ' + libPath);
    }
    await page.addScriptTag({ path: libPath });

    // Run the fix inside the browser context
    const fixedSvgString = await page.evaluate(async () => {
      const SvgVisualBBox = window.SvgVisualBBox;
      if (!SvgVisualBBox) {
        throw new Error('SvgVisualBBox not found on window. Did the script load?');
      }

      const svg = document.querySelector('svg');
      if (!svg) {
        throw new Error('No <svg> element found in the document.');
      }

      // Make sure fonts are reasonably loaded to avoid text layout shifts
      await SvgVisualBBox.waitForDocumentFonts(document, 8000);

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

      // 2) Ensure viewBox
      let vb = svg.viewBox && svg.viewBox.baseVal;
      if (!vb || !vb.width || !vb.height) {
        // No viewBox → set it to full drawing bbox
        svg.setAttribute('viewBox', `${full.x} ${full.y} ${full.width} ${full.height}`);
        vb = { x: full.x, y: full.y, width: full.width, height: full.height };
      } else {
        // If there *is* a viewBox already, we won't change it here.
        vb = { x: vb.x, y: vb.y, width: vb.width, height: vb.height };
      }

      // 3) Ensure width/height attributes
      const widthAttr = svg.getAttribute('width');
      const heightAttr = svg.getAttribute('height');

      const hasWidth = !!widthAttr;
      const hasHeight = !!heightAttr;

      // We use the viewBox aspect ratio as the "truth"
      const vbAspect = vb.width > 0 && vb.height > 0 ? vb.width / vb.height : 1;

      let newWidth = widthAttr;
      let newHeight = heightAttr;

      if (!hasWidth && !hasHeight) {
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
        // both width and height exist: keep as-is
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
      return serializer.serializeToString(svg);
    });

    // Wrap the fixed <svg> in an XML prolog if you like, or just save as-is
    fs.writeFileSync(outputPath, fixedSvgString, 'utf8');
    console.log(`✓ Fixed SVG saved to: ${outputPath}`);

    // Auto-open SVG in Chrome/Chromium if requested
    // CRITICAL: Must use Chrome/Chromium (other browsers have poor SVG support)
    if (autoOpen) {
      const absolutePath = path.resolve(outputPath);

      openInChrome(absolutePath).then(result => {
        if (result.success) {
          console.log(`\n✓ Opened in Chrome: ${absolutePath}`);
        } else {
          console.log(`\n⚠️  ${result.error}`);
          console.log(`   Please open manually in Chrome/Chromium: ${absolutePath}`);
        }
      }).catch(err => {
        console.log(`\n⚠️  Failed to auto-open: ${err.message}`);
        console.log(`   Please open manually in Chrome/Chromium: ${absolutePath}`);
      });
    }
  } finally {
    await browser.close();
  }
}

// -------- entry point --------

(async () => {
  const { input, output, autoOpen } = parseArgs(process.argv);
  try {
    await fixSvgFile(input, output, autoOpen);
  } catch (err) {
    console.error('Error fixing SVG:', err.message || err);
    process.exit(1);
  }
})();
