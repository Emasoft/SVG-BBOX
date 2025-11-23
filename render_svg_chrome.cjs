#!/usr/bin/env node
/**
 * Render SVG to PNG using Puppeteer/Chrome + SvgVisualBBox
 *
 * Usage:
 *   node render_svg_chrome.js input.svg output.png \
 *     [--mode full|visible|element] \
 *     [--element-id ID] \
 *     [--scale N] \
 *     [--width W --height H] \
 *     [--background white|transparent|#rrggbb|...] \
 *     [--margin N] \
 *     [--auto-open]
 *
 * Modes:
 *   --mode full
 *      Render the whole drawing, ignoring the current viewBox. The library
 *      finds the full visual bbox of the root <svg> and adjusts the viewBox.
 *
 *   --mode visible   (default)
 *      Render only the content actually inside the current viewBox.
 *      The library finds the visual bbox clipped by the viewBox and crops to it.
 *
 *   --mode element --element-id someId
 *      Render only a single element. All other elements are hidden; the viewBox
 *      is set to that element's visual bbox (in SVG user units).
 *
 * Background:
 *   --background transparent
 *      Produces a transparent PNG (via omitBackground: true).
 *   --background <css-color>
 *      Uses that color as page background (e.g. white, #333, rgba(...)).
 *
 * Margin:
 *   --margin N
 *      Extra padding in SVG user units around the computed bbox.
 *      For "visible" mode, this padding is clamped to the original viewBox so
 *      objects outside the viewBox remain ignored.
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// ---------- simple CLI parsing ----------

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length < 2) {
    console.error(
      'Usage: node render_svg_chrome.js input.svg output.png [--mode full|visible|element] [--element-id ID] [--scale N] [--width W --height H] [--background white|transparent|#rrggbb|...] [--margin N] [--auto-open]'
    );
    process.exit(1);
  }

  const positional = [];
  const options = {
    mode: 'visible',
    elementId: null,
    scale: 4,
    width: null,
    height: null,
    background: 'white',
    margin: 0,
    autoOpen: false
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
        case 'mode':
          options.mode = (next || 'visible').toLowerCase();
          useNext();
          break;
        case 'element-id':
          options.elementId = next || null;
          useNext();
          break;
        case 'scale':
          options.scale = parseFloat(next);
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
          options.background = next || 'white';
          useNext();
          break;
        case 'margin':
          options.margin = parseFloat(next);
          if (!isFinite(options.margin) || options.margin < 0) {
            options.margin = 0;
          }
          useNext();
          break;
        case 'auto-open':
          options.autoOpen = true;
          break;
        default:
          console.warn('Unknown option:', key);
      }
    } else {
      positional.push(a);
    }
  }

  if (positional.length < 2) {
    console.error('You must provide at least input.svg and output.png.');
    process.exit(1);
  }

  options.input = positional[0];
  options.output = positional[1];

  return options;
}

// ---------- core render logic ----------

async function renderSvgWithModes(opts) {
  const { input, output } = opts;

  const svgPath = path.resolve(input);
  if (!fs.existsSync(svgPath)) {
    throw new Error('SVG file does not exist: ' + svgPath);
  }

  const svgContent = fs.readFileSync(svgPath, 'utf8');

  // Decide background CSS + omitBackground
  const bgLower = (opts.background || '').toString().toLowerCase();
  const isTransparentBg = bgLower === 'transparent';
  const bgCSS = isTransparentBg ? 'transparent' : (opts.background || 'white');

  // Launch browser
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();

    // Minimal HTML wrapper; SVG injected as raw markup
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    html, body {
      margin: 0;
      padding: 0;
    }
    body {
      background: ${bgCSS};
    }
    svg {
      display: block;
    }
  </style>
</head>
<body>
${svgContent}
</body>
</html>`;

    await page.setContent(html, { waitUntil: 'networkidle0' });

    // Inject SvgVisualBBox.js into the page
    const libPath = path.resolve(__dirname, 'SvgVisualBBox.js');
    if (!fs.existsSync(libPath)) {
      throw new Error('SvgVisualBBox.js not found at: ' + libPath);
    }
    await page.addScriptTag({ path: libPath });

    // Let the page use the library to:
    //  - synthesize a viewBox if missing
    //  - pick a visual bbox depending on mode (full/visible/element)
    //  - apply margin in SVG units
    //  - optionally hide other elements (element mode)
    //  - compute suggested pixel width/height if not given
    const measure = await page.evaluate(async (optsInPage) => {
      const SvgVisualBBox = window.SvgVisualBBox;
      if (!SvgVisualBBox) {
        throw new Error('SvgVisualBBox not found on window. Did the script load?');
      }

      const svg = document.querySelector('svg');
      if (!svg) {
        throw new Error('No <svg> element found in the document.');
      }

      // Ensure fonts are loaded as best as we can (with timeout)
      await SvgVisualBBox.waitForDocumentFonts(document, 8000);

      const mode = (optsInPage.mode || 'visible').toLowerCase();
      const marginUser = (typeof optsInPage.margin === 'number' && optsInPage.margin > 0)
        ? optsInPage.margin
        : 0;

      // Helper: ensure the root <svg> has a reasonable viewBox.
      // If missing, we use the full drawing bbox (unclipped).
      async function ensureViewBox() {
        const vb = svg.viewBox && svg.viewBox.baseVal;
        if (vb && vb.width && vb.height) {
          return { x: vb.x, y: vb.y, width: vb.width, height: vb.height };
        }
        // No viewBox → use full drawing bbox (unclipped)
        const both = await SvgVisualBBox.getSvgElementVisibleAndFullBBoxes(svg, {
          coarseFactor: 3,
          fineFactor: 24,
          useLayoutScale: true
        });
        const full = both.full;
        if (!full) {
          throw new Error('Cannot determine full drawing bbox for SVG without a viewBox.');
        }
        const newVB = {
          x: full.x,
          y: full.y,
          width: full.width,
          height: full.height
        };
        svg.setAttribute('viewBox', `${newVB.x} ${newVB.y} ${newVB.width} ${newVB.height}`);
        return newVB;
      }

      const originalViewBox = await ensureViewBox(); // used for clamping in "visible" mode
      let targetBBox = null;

      if (mode === 'full') {
        // Full drawing, ignoring current viewBox
        const both = await SvgVisualBBox.getSvgElementVisibleAndFullBBoxes(svg, {
          coarseFactor: 3,
          fineFactor: 24,
          useLayoutScale: true
        });
        if (!both.full) {
          throw new Error('Full drawing bbox is empty (nothing to render).');
        }
        targetBBox = {
          x: both.full.x,
          y: both.full.y,
          width: both.full.width,
          height: both.full.height
        };
      } else if (mode === 'element') {
        const id = optsInPage.elementId;
        if (!id) {
          throw new Error('--mode element requires --element-id');
        }
        const el = svg.ownerDocument.getElementById(id);
        if (!el) {
          throw new Error('No element found with id="' + id + '"');
        }

        const bbox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(el, {
          mode: 'unclipped',
          coarseFactor: 3,
          fineFactor: 24,
          useLayoutScale: true
        });
        if (!bbox) {
          throw new Error('Element with id="' + id + '" has no visible pixels.');
        }
        targetBBox = {
          x: bbox.x,
          y: bbox.y,
          width: bbox.width,
          height: bbox.height
        };

        // Hide everything except this element (and <defs>)
        const allowed = new Set();
        let node = el;
        while (node) {
          allowed.add(node);
          if (node === svg) {
            break;
          }
          node = node.parentNode;
        }

        // Add all descendants of the target element
        // CRITICAL: Without this, child elements like <textPath> inside <text>
        // would get display="none" and render as invisible/empty
        (function addDescendants(n) {
          allowed.add(n);
          const children = n.children;
          for (let i = 0; i < children.length; i++) {
            addDescendants(children[i]);
          }
        })(el);

        const all = Array.from(svg.querySelectorAll('*'));
        for (const child of all) {
          const tag = child.tagName && child.tagName.toLowerCase();
          if (tag === 'defs') {
            continue;
          }
          if (!allowed.has(child) && !child.contains(el)) {
            child.setAttribute('display', 'none');
          }
        }
      } else {
        // "visible" → content actually inside the current viewBox
        const both = await SvgVisualBBox.getSvgElementVisibleAndFullBBoxes(svg, {
          coarseFactor: 3,
          fineFactor: 24,
          useLayoutScale: true
        });
        if (!both.visible) {
          throw new Error('Visible bbox is empty (nothing inside viewBox).');
        }
        targetBBox = {
          x: both.visible.x,
          y: both.visible.y,
          width: both.visible.width,
          height: both.visible.height
        };
      }

      if (!targetBBox) {
        throw new Error('No target bounding box could be computed.');
      }

      // Apply margin in SVG units
      const expanded = {
        x: targetBBox.x,
        y: targetBBox.y,
        width: targetBBox.width,
        height: targetBBox.height
      };

      if (marginUser > 0) {
        expanded.x -= marginUser;
        expanded.y -= marginUser;
        expanded.width += marginUser * 2;
        expanded.height += marginUser * 2;
      }

      // For "visible" mode, clamp the expanded bbox to the original viewBox
      if (mode === 'visible' && expanded.width > 0 && expanded.height > 0) {
        const ov = originalViewBox;
        const bx0 = expanded.x;
        const by0 = expanded.y;
        const bx1 = expanded.x + expanded.width;
        const by1 = expanded.y + expanded.height;

        const clampedX0 = Math.max(ov.x, bx0);
        const clampedY0 = Math.max(ov.y, by0);
        const clampedX1 = Math.min(ov.x + ov.width, bx1);
        const clampedY1 = Math.min(ov.y + ov.height, by1);

        expanded.x = clampedX0;
        expanded.y = clampedY0;
        expanded.width = Math.max(0, clampedX1 - clampedX0);
        expanded.height = Math.max(0, clampedY1 - clampedY0);
      }

      // Now set the viewBox to the expanded bbox
      if (expanded.width <= 0 || expanded.height <= 0) {
        throw new Error('Expanded bbox is empty after clamping/margin.');
      }
      svg.setAttribute('viewBox', `${expanded.x} ${expanded.y} ${expanded.width} ${expanded.height}`);

      // Compute suggested pixel size
      const scale = (typeof optsInPage.scale === 'number' && isFinite(optsInPage.scale) && optsInPage.scale > 0)
        ? optsInPage.scale
        : 4;

      const pixelWidth = optsInPage.width || Math.max(1, Math.round(expanded.width * scale));
      const pixelHeight = optsInPage.height || Math.max(1, Math.round(expanded.height * scale));

      // Update SVG sizing in the DOM
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      svg.style.width = pixelWidth + 'px';
      svg.style.height = pixelHeight + 'px';

      return {
        mode,
        targetBBox,
        expandedBBox: expanded,
        viewBox: svg.getAttribute('viewBox'),
        pixelWidth,
        pixelHeight
      };
    }, {
      mode: opts.mode,
      elementId: opts.elementId,
      scale: opts.scale,
      width: opts.width,
      height: opts.height,
      margin: opts.margin
    });

    // Now set the Puppeteer viewport to match the chosen PNG size
    await page.setViewport({
      width: measure.pixelWidth,
      height: measure.pixelHeight,
      deviceScaleFactor: 1
    });

    // Small delay to allow re-layout after we tweaked the SVG
    await new Promise(resolve => setTimeout(resolve, 100));

    // Screenshot exactly the viewport area
    await page.screenshot({
      path: output,
      type: 'png',
      fullPage: false,
      omitBackground: isTransparentBg,
      clip: {
        x: 0,
        y: 0,
        width: measure.pixelWidth,
        height: measure.pixelHeight
      }
    });

    console.log(`✓ Rendered: ${output}`);
    console.log(`  mode: ${measure.mode}`);
    console.log(`  viewBox: ${measure.viewBox}`);
    console.log('  bbox (original target):', measure.targetBBox);
    console.log('  bbox (with margin):', measure.expandedBBox);
    console.log(`  size: ${measure.pixelWidth}×${measure.pixelHeight}px`);
    console.log(`  background: ${opts.background}`);
    console.log(`  margin (user units): ${opts.margin}`);

    // Auto-open PNG in browser/viewer if requested
    if (opts.autoOpen) {
      const absolutePath = path.resolve(output);

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
          console.log(`\n✓ Opened in viewer: ${absolutePath}`);
        }
      });
    }
  } finally {
    await browser.close();
  }
}

// ---------- entry point ----------

(async () => {
  const opts = parseArgs(process.argv);
  try {
    await renderSvgWithModes(opts);
  } catch (err) {
    console.error('Error:', err.message || err);
    process.exit(1);
  }
})();