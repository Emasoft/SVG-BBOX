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
 *     [--auto-open]  # Opens PNG in Chrome/Chromium ONLY (not Safari!)
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
const { execFile: _execFile } = require('child_process');
const { openInChrome } = require('./browser-utils.cjs');
const {
  getVersion,
  printVersion: _printVersion,
  hasVersionFlag: _hasVersionFlag
} = require('./version.cjs');
const { BROWSER_TIMEOUT_MS, FONT_TIMEOUT_MS } = require('./config/timeouts.cjs');

// SECURITY: Import security utilities
const {
  validateFilePath,
  validateOutputPath,
  readSVGFileSafe,
  sanitizeSVGContent,
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

// ---------- CLI parsing ----------

function printHelp() {
  console.log(`
╔════════════════════════════════════════════════════════════════════════════╗
║ sbb-render.cjs - Render SVG to PNG via Headless Chrome             ║
╚════════════════════════════════════════════════════════════════════════════╝

DESCRIPTION:
  High-quality SVG to PNG rendering using Chrome's rendering engine with
  precise control over what gets rendered and how.

USAGE:
  node sbb-render.cjs input.svg output.png [options]

ARGUMENTS:
  input.svg           Input SVG file to render
  output.png          Output PNG file path

═══════════════════════════════════════════════════════════════════════════════

RENDERING MODES (--mode):

  --mode visible      (DEFAULT)
    Render only content inside current viewBox
    Respects viewBox clipping exactly as browser would display it
    Best for: SVGs with correct viewBox already set

  --mode full
    Render whole drawing, ignoring current viewBox
    Computes full visual bbox and adjusts viewBox automatically
    Best for: SVGs with missing/incorrect viewBox, seeing all content

  --mode element --element-id <ID>
    Render single element only
    Hides all other elements, crops viewBox to element bbox
    Best for: Extracting individual objects/icons from larger SVG

═══════════════════════════════════════════════════════════════════════════════

OPTIONS:

  --mode <mode>
      Rendering mode: visible | full | element
      Default: visible

  --element-id <ID>
      Element ID to render (required with --mode element)

  --scale <number>
      Resolution multiplier (default: 4)
      Higher = better quality but larger file
      Example: --scale 2 for lower res, --scale 8 for very high res

  --width <pixels> --height <pixels>
      Override output dimensions in pixels
      If not specified, computed from viewBox and scale

  --background <color>
      Background color (default: white)
      Options:
        - transparent (for PNG transparency)
        - white, black, red, blue, etc. (CSS color names)
        - #RRGGBB (hex colors)
        - rgba(r, g, b, a) (CSS rgba format)

  --margin <number>
      Extra padding in SVG user units (default: 0)
      In visible mode, margin clamped to viewBox boundaries

  --auto-open
      Automatically open PNG in Chrome/Chromium after rendering

  --help, -h
      Show this help message

═══════════════════════════════════════════════════════════════════════════════

EXAMPLES:

  # Render with default settings (visible mode, white background)
  node sbb-render.cjs drawing.svg output.png

  # Render full drawing regardless of viewBox
  node sbb-render.cjs drawing.svg full.png --mode full

  # Render with transparent background at high resolution
  node sbb-render.cjs icon.svg icon.png --background transparent --scale 8

  # Render only a specific element
  node sbb-render.cjs sprites.svg logo.png \\
    --mode element --element-id logo_main --margin 5

  # Custom dimensions and background color
  node sbb-render.cjs chart.svg chart.png \\
    --width 1920 --height 1080 --background "#f0f0f0"

  # Render and immediately view
  node sbb-render.cjs drawing.svg preview.png --auto-open

═══════════════════════════════════════════════════════════════════════════════

MARGIN BEHAVIOR:

  SVG user units (not pixels):
    Margin is specified in the SVG's coordinate system
    Example: viewBox="0 0 100 100" with --margin 10
    → Adds 10 units on each side

  Mode-specific behavior:
    • visible mode: Margin clamped to original viewBox boundaries
    • full mode: Margin added around full drawing bbox
    • element mode: Margin added around element bbox

USE CASES:
  • Generate preview images for SVG libraries
  • Create thumbnails for SVG galleries
  • Export individual sprites/icons from sprite sheets
  • Render charts/diagrams for documentation
  • Convert SVGs for platforms that don't support SVG

`);
}

function parseArgs(argv) {
  const args = argv.slice(2);

  // Check for --help
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  if (args.length < 2) {
    printHelp();
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

// SECURITY: Secure Puppeteer options
const PUPPETEER_OPTIONS = {
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
};

async function renderSvgWithModes(opts) {
  const { input, output } = opts;

  // SECURITY: Validate and sanitize input path
  const safePath = validateFilePath(input, {
    requiredExtensions: ['.svg'],
    mustExist: true
  });

  // SECURITY: Read SVG with size limit and validation
  const svgContent = readSVGFileSafe(safePath);

  // SECURITY: Sanitize SVG content (remove scripts, event handlers)
  const sanitizedSvg = sanitizeSVGContent(svgContent);

  // Decide background CSS + omitBackground
  const bgLower = (opts.background || '').toString().toLowerCase();
  const isTransparentBg = bgLower === 'transparent';
  const bgCSS = isTransparentBg ? 'transparent' : opts.background || 'white';

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

    // Let the page use the library to:
    //  - synthesize a viewBox if missing
    //  - pick a visual bbox depending on mode (full/visible/element)
    //  - apply margin in SVG units
    //  - optionally hide other elements (element mode)
    //  - compute suggested pixel width/height if not given
    const measure = await page.evaluate(
      async (optsInPage) => {
        /* eslint-disable no-undef */
        const SvgVisualBBox = window.SvgVisualBBox;
        if (!SvgVisualBBox) {
          throw new Error('SvgVisualBBox not found on window. Did the script load?');
        }

        const svg = document.querySelector('svg');
        if (!svg) {
          throw new Error('No <svg> element found in the document.');
        }

        // Ensure fonts are loaded as best as we can (with timeout)
        await SvgVisualBBox.waitForDocumentFonts(document, optsInPage.fontTimeout || 8000);

        const mode = (optsInPage.mode || 'visible').toLowerCase();
        const marginUser =
          typeof optsInPage.margin === 'number' && optsInPage.margin > 0 ? optsInPage.margin : 0;

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
          /** @type {Element | ParentNode | null} */
          let node = el;
          while (node) {
            allowed.add(node);
            // Type assertion: we know svg is an Element and node is Element | ParentNode
            if (/** @type {Element} */ (node) === svg) {
              break;
            }
            node = /** @type {Element | null} */ (node.parentNode);
          }

          // Add all descendants of the target element
          // CRITICAL: Without this, child elements like <textPath> inside <text>
          // would get display="none" and render as invisible/empty
          /**
           * Recursively add element and all descendants to allowed set
           * @param {HTMLElement} n - Element to process
           * @returns {void}
           */
          (function addDescendants(n) {
            allowed.add(n);
            const children = n.children;
            for (let i = 0; i < children.length; i++) {
              // @ts-ignore - children[i] is Element in browser context, HTMLElement in type system
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
        svg.setAttribute(
          'viewBox',
          `${expanded.x} ${expanded.y} ${expanded.width} ${expanded.height}`
        );

        // Compute suggested pixel size
        const scale =
          typeof optsInPage.scale === 'number' && isFinite(optsInPage.scale) && optsInPage.scale > 0
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
        /* eslint-enable no-undef */
      },
      {
        mode: opts.mode,
        elementId: opts.elementId,
        scale: opts.scale,
        width: opts.width,
        height: opts.height,
        margin: opts.margin,
        fontTimeout: FONT_TIMEOUT_MS
      }
    );

    // Now set the Puppeteer viewport to match the chosen PNG size
    await page.setViewport({
      width: measure.pixelWidth,
      height: measure.pixelHeight,
      deviceScaleFactor: 1
    });

    // Small delay to allow re-layout after we tweaked the SVG
    await new Promise((resolve) => setTimeout(resolve, 100));

    // SECURITY: Validate output path
    const safeOutPath = validateOutputPath(output, {
      requiredExtensions: ['.png', '.jpg', '.jpeg']
    });

    // Screenshot exactly the viewport area
    await page.screenshot({
      path: safeOutPath,
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

    printSuccess(`Rendered: ${safeOutPath}`);
    printInfo(`mode: ${measure.mode}`);
    printInfo(`viewBox: ${measure.viewBox}`);
    console.log('  bbox (original target):', measure.targetBBox);
    console.log('  bbox (with margin):', measure.expandedBBox);
    printInfo(`size: ${measure.pixelWidth}×${measure.pixelHeight}px`);
    console.log(`  background: ${opts.background}`);
    console.log(`  margin (user units): ${opts.margin}`);

    // Auto-open PNG in Chrome/Chromium if requested
    // CRITICAL: Must use Chrome/Chromium (other browsers have poor image rendering)
    if (opts.autoOpen) {
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

// ---------- entry point ----------

async function main() {
  // Display version
  printInfo(`sbb-render v${getVersion()} | svg-bbox toolkit\n`);

  const opts = parseArgs(process.argv);
  await renderSvgWithModes(opts);
}

runCLI(main);
