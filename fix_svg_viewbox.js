#!/usr/bin/env node
/**
 * Fix SVG files missing width/height/viewBox using Puppeteer + SvgVisualBBox.
 *
 * Usage:
 *   node fix_svg_viewbox.js input.svg [output.svg] [--auto-open]
 *
 * If output.svg is omitted, the script writes a new file named:
 *   <input>.fixed.svg
 *
 * Options:
 *   --auto-open: Automatically open the fixed SVG in Google Chrome
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

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node fix_svg_viewbox.js input.svg [output.svg] [--auto-open]');
    process.exit(1);
  }

  const positional = [];
  let autoOpen = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--auto-open') {
      autoOpen = true;
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

    // Auto-open SVG in browser if requested
    if (autoOpen) {
      const absolutePath = path.resolve(outputPath);

      // Use execFile for security (no shell injection)
      let command, args;
      if (process.platform === 'darwin') {
        command = 'open';
        args = ['-a', 'Google Chrome', absolutePath];
      } else if (process.platform === 'win32') {
        command = 'cmd';
        args = ['/c', 'start', 'chrome', absolutePath];
      } else {
        command = 'xdg-open';
        args = [absolutePath];
      }

      execFile(command, args, (error) => {
        if (error) {
          console.log(`\n⚠️  Could not auto-open: ${error.message}`);
          console.log(`   Please open manually: ${absolutePath}`);
        } else {
          console.log(`\n✓ Opened in browser: ${absolutePath}`);
        }
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
