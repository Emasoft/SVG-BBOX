#!/usr/bin/env node
/**
 * extract_svg_objects.js
 *
 * Advanced SVG object tooling using Puppeteer + SvgVisualBBox.
 *
 * MODES
 * =====
 *
 * 1) LIST OBJECTS (HTML overview + optional fixed SVG with IDs)
 * ------------------------------------------------------------
 *   node extract_svg_objects.js input.svg --list
 *     [--assign-ids --out-fixed fixed.svg]
 *     [--out-html list.html]
 *     [--auto-open]  # Opens HTML in Chrome/Chromium ONLY (not Safari!)
 *     [--json]
 *
 *   • Produces an HTML page with a big table of objects:
 *       - Column 1: OBJECT ID
 *       - Column 2: Tag name (<path>, <g>, <use>, …)
 *       - Column 3: Small preview <svg> using the object’s visual bbox
 *                   and <use href="#OBJECT_ID"> so we only embed one
 *                   hidden SVG and reuse it.
 *       - Column 4: “New ID name” – a text box + checkbox for renaming.
 *
 *   • The HTML page adds a “Save JSON with renaming” button:
 *       - It gathers rows where the checkbox is checked and the text box
 *         contains a new ID, validates them, and downloads a JSON file
 *         with mappings [{from, to}, …].
 *       - Validates:
 *           1. ID syntax (XML-ish ID: /^[A-Za-z_][A-Za-z0-9_.:-]*$/)
 *           2. No collision with existing IDs in the SVG
 *           3. No collision with earlier new IDs in the table
 *              (higher rows win, lower rows are rejected)
 *
 *   • Filters in the HTML (client-side, JS):
 *       - Regex filter (applies to ID, tag name, group IDs)
 *       - Tag filter (type: path/rect/g/etc.)
 *       - Area filter by bbox coordinates (minX, minY, maxX, maxY)
 *       - Group filter: only show objects that are descendants of a
 *         given group ID.
 *
 *   • --assign-ids:
 *       - Auto-assigns IDs (e.g. "auto_id_path_1") to objects that have
 *         no ID, IN-MEMORY.
 *       - With --out-fixed, saves a fixed SVG with those IDs.
 *
 *   • --json:
 *       - Prints JSON metadata about the listing instead of human text.
 *
 *
 * 2) RENAME IDS USING A JSON MAPPING
 * ----------------------------------
 *   node extract_svg_objects.js input.svg --rename mapping.json output.svg
 *     [--json]
 *
 *   • Applies ID renaming according to mapping.json, typically generated
 *     by the HTML from --list.
 *
 *   • JSON format (produced by HTML page):
 *       {
 *         "sourceSvgFile": "original.svg",
 *         "createdAt": "ISO timestamp",
 *         "mappings": [
 *           { "from": "oldId", "to": "newId" },
 *           ...
 *         ]
 *       }
 *
 *   • Also accepts:
 *       - A plain array: [ {from,to}, ... ]
 *       - A simple object: { "oldId": "newId", ... }
 *
 *   • The script:
 *       - Resolves mappings in order (row order priority).
 *       - Skips mappings whose "from" ID doesn’t exist.
 *       - Validates ID syntax.
 *       - Avoids collisions:
 *           * If target already exists on a different element, mapping is skipped.
 *           * If target was already used by a previous mapping, this mapping is skipped.
 *           * If the same "from" appears multiple times, the first mapping wins.
 *       - Updates references in:
 *           * href / xlink:href attributes equal to "#oldId"
 *           * Any attribute containing "url(#oldId)" (e.g. fill, stroke, filter, mask)
 *
 *   • Writes a new SVG file with renamed IDs and updated references.
 *
 *
 * 3) EXTRACT ONE OBJECT BY ID
 * ---------------------------
 *   node extract_svg_objects.js input.svg --extract id output.svg
 *     [--margin N] [--include-context] [--json]
 *
 *   • Computes the "visual" bbox of the object (including strokes, filters,
 *     markers, etc.) using SvgVisualBBox.
 *   • Sets the root <svg> viewBox to that bbox (+ margin).
 *   • Copies <defs> from the original SVG so filters, patterns, etc. keep working.
 *
 *   Two important behaviors:
 *
 *   - Default (NO --include-context): "pure cut-out"
 *       • Only the chosen object and its ancestor groups are kept.
 *       • No siblings, no overlay rectangles, no other objects.
 *       • Clean asset you can reuse elsewhere.
 *
 *   - With --include-context: "cut-out with context"
 *       • All other objects remain (just like in the full drawing).
 *       • The root viewBox is still cropped to the object’s bbox + margin.
 *       • So a big semi-transparent blue rectangle above the object, or a
 *         big blur filter, still changes how the object looks, but you
 *         only see the area of the object’s bbox region.
 *
 *
 * 4) EXPORT ALL OBJECTS
 * ---------------------
 *   node extract_svg_objects.js input.svg --export-all out-dir
 *     [--margin N] [--export-groups] [--json]
 *
 *   • “Objects” = path, rect, circle, ellipse, polygon, polyline, text,
 *                 image, use, symbol, and (optionally) g.
 *   • Each object is exported to its own SVG file with:
 *       - A viewBox = visual bbox (+ margin).
 *       - The ancestor chain from root to object, so transforms/groups
 *         are preserved for that object.
 *       - All <defs>.
 *   • If --export-groups is used:
 *       - Each <g> is also exported as its own SVG, with its subtree.
 *       - Recursively, each child object/group inside that group is exported
 *         again as a separate SVG (prefixed file names).
 *       - Even if two groups have the same content or one is nested in the
 *         other, each group gets its own SVG.
 *
 *
 * JSON OUTPUT (--json)
 * ====================
 *   • For any mode, adding --json returns a machine-readable summary:
 *       - list: objects, any fixed svg/html written, etc.
 *       - rename: applied + skipped mappings, output path.
 *       - extract: bbox + paths.
 *       - exportAll: array of exported objects with ids, files, bboxes.
 *
 *
 * INTERNAL NORMALIZATION
 * ======================
 *   On load, the script uses SvgVisualBBox to compute the full visual bbox
 *   of the root <svg>. If the SVG is missing viewBox / width / height:
 *     - It sets them IN MEMORY ONLY, so all bboxes are computed in a sane
 *       coordinate system.
 *   Your original SVG file is not modified by this script.
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { execFile: _execFile } = require('child_process');
const { openInChrome } = require('./browser-utils.cjs');
const {
  getVersion,
  printVersion: _printVersion,
  hasVersionFlag: _hasVersionFlag
} = require('./version.cjs');
const { BROWSER_TIMEOUT_MS } = require('./config/timeouts.cjs');

// SECURITY: Import security utilities
const {
  validateFilePath,
  validateOutputPath,
  readSVGFileSafe,
  sanitizeSVGContent,
  writeFileSafe,
  readJSONFileSafe,
  validateRenameMapping,
  SVGBBoxError,
  ValidationError,
  FileSystemError: _FileSystemError
} = require('./lib/security-utils.cjs');

const {
  runCLI,
  printSuccess: _printSuccess,
  printError: _printError,
  printInfo,
  printWarning
} = require('./lib/cli-utils.cjs');

// -------- CLI parsing --------

function parseArgs(argv) {
  const { createModeArgParser } = require('./lib/cli-utils.cjs');

  // Create the mode-aware parser with flag-based mode triggers
  const parser = createModeArgParser({
    name: 'sbb-extract',
    description: 'Extract and rename SVG objects',
    defaultMode: 'list',
    modeFlags: {
      '--list': 'list',
      '--extract': { mode: 'extract', consumesValue: true, valueTarget: 'extractId' },
      '--export-all': { mode: 'exportAll', consumesValue: true, valueTarget: 'outDir' },
      '--rename': { mode: 'rename', consumesValue: true, valueTarget: 'renameJson' }
    },
    globalFlags: [
      { name: 'json', alias: 'j', type: 'boolean', description: 'Output in JSON format' },
      { name: 'auto-open', type: 'boolean', description: 'Open result in Chrome' },
      {
        name: 'ignore-resolution',
        type: 'boolean',
        description: 'Use full drawing bbox instead of width/height for viewBox'
      }
    ],
    modes: {
      list: {
        description: 'List all extractable objects in the SVG',
        flags: [
          { name: 'assign-ids', type: 'boolean', description: 'Assign IDs to unnamed objects' },
          { name: 'out-fixed', type: 'string', description: 'Output fixed SVG with assigned IDs' },
          { name: 'out-html', type: 'string', description: 'Output HTML preview' }
        ],
        positional: [{ name: 'input', required: true, description: 'Input SVG file' }]
      },
      extract: {
        description: 'Extract a single object by ID',
        flags: [
          {
            name: 'margin',
            alias: 'm',
            type: 'number',
            default: 0,
            description: 'Margin in pixels',
            validator: (v) => v >= 0,
            validationError: 'Margin must be >= 0'
          },
          { name: 'include-context', type: 'boolean', description: 'Include context elements' }
        ],
        positional: [
          { name: 'input', required: true, description: 'Input SVG file' },
          { name: 'output', required: true, description: 'Output SVG file' }
        ]
      },
      exportAll: {
        description: 'Export all named objects to a directory',
        flags: [
          {
            name: 'margin',
            alias: 'm',
            type: 'number',
            default: 0,
            description: 'Margin in pixels',
            validator: (v) => v >= 0,
            validationError: 'Margin must be >= 0'
          },
          { name: 'export-groups', type: 'boolean', description: 'Export groups too' }
        ],
        positional: [{ name: 'input', required: true, description: 'Input SVG file' }]
      },
      rename: {
        description: 'Rename objects according to a JSON mapping',
        positional: [
          { name: 'input', required: true, description: 'Input SVG file' },
          { name: 'output', required: true, description: 'Output SVG file' }
        ]
      }
    }
  });

  // Parse the arguments
  const result = parser(argv);

  // Map parser output to the expected legacy format for backward compatibility
  const options = {
    input: result.positional[0] || null,
    mode: result.mode,
    extractId: result.flags.extractId || null,
    outSvg: null,
    outDir: result.flags.outDir || null,
    margin: result.flags.margin || 0,
    includeContext: result.flags['include-context'] || false,
    assignIds: result.flags['assign-ids'] || false,
    outFixed: result.flags['out-fixed'] || null,
    exportGroups: result.flags['export-groups'] || false,
    json: result.flags.json || false,
    outHtml: result.flags['out-html'] || null,
    renameJson: result.flags.renameJson || null,
    renameOut: null,
    autoOpen: result.flags['auto-open'] || false,
    ignoreResolution: result.flags['ignore-resolution'] || false
  };

  // Mode-specific positional argument handling
  if (result.mode === 'extract') {
    options.outSvg = result.positional[1] || null;
  }

  if (result.mode === 'rename') {
    options.renameOut = result.positional[1] || null;
  }

  // Apply default values for list mode
  if (result.mode === 'list' && options.assignIds && !options.outFixed) {
    options.outFixed = options.input.replace(/\.svg$/i, '') + '.ids.svg';
  }
  if (result.mode === 'list' && !options.outHtml) {
    options.outHtml = options.input.replace(/\.svg$/i, '') + '.objects.html';
  }

  return options;
}

// -------- shared browser/page setup --------

async function withPageForSvg(inputPath, handler, options = {}) {
  const { ignoreResolution = false } = options;

  // SECURITY: Validate and read SVG file safely
  const safePath = validateFilePath(inputPath, {
    requiredExtensions: ['.svg'],
    mustExist: true
  });

  const svgContent = readSVGFileSafe(safePath);
  const sanitizedSvg = sanitizeSVGContent(svgContent);

  // SECURITY: Launch browser with security args and timeout
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    timeout: BROWSER_TIMEOUT_MS
  });

  try {
    const page = await browser.newPage();

    // SECURITY: Set browser timeout
    page.setDefaultTimeout(BROWSER_TIMEOUT_MS);

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>SVG Tool</title>
</head>
<body>
${sanitizedSvg}
</body>
</html>`;

    await page.setContent(html, { waitUntil: 'networkidle0' });

    const libPath = path.resolve(__dirname, 'SvgVisualBBox.js');
    if (!fs.existsSync(libPath)) {
      throw new Error('SvgVisualBBox.js not found at: ' + libPath);
    }
    await page.addScriptTag({ path: libPath });

    // Shared "initial import": normalize viewBox + width/height in memory.
    // IMPORTANT: Respects existing viewBox. Only synthesizes when truly missing.
    const normalizationWarning = await page.evaluate(async (useIgnoreResolution) => {
      /* eslint-disable no-undef */
      const SvgVisualBBox = window.SvgVisualBBox;
      if (!SvgVisualBBox) {
        throw new Error('SvgVisualBBox not found.');
      }

      const rootSvg = document.querySelector('svg');
      if (!rootSvg) {
        throw new Error('No <svg> found in document.');
      }

      // SECURITY: Wait for fonts with timeout
      await SvgVisualBBox.waitForDocumentFonts(document, 8000);
      /* eslint-enable no-undef */

      let warning = null;
      const vbVal = rootSvg.viewBox && rootSvg.viewBox.baseVal;
      const hasViewBox = vbVal && vbVal.width && vbVal.height;

      if (!hasViewBox) {
        // No viewBox - check if we have width/height attributes
        const widthAttr = rootSvg.getAttribute('width');
        const heightAttr = rootSvg.getAttribute('height');
        const hasWidth = widthAttr && parseFloat(widthAttr) > 0;
        const hasHeight = heightAttr && parseFloat(heightAttr) > 0;

        if (hasWidth && hasHeight && !useIgnoreResolution) {
          // Use width/height as viewBox (preserves original coordinate system)
          const w = parseFloat(widthAttr);
          const h = parseFloat(heightAttr);
          rootSvg.setAttribute('viewBox', `0 0 ${w} ${h}`);
          warning = {
            type: 'resolution_used',
            message:
              `No viewBox found. Using width/height (${w}x${h}) as viewBox="0 0 ${w} ${h}". ` +
              'Use --ignore-resolution to use full drawing bbox instead.'
          };
        } else {
          // No viewBox and no width/height (or --ignore-resolution) - compute full bbox
          const both = await SvgVisualBBox.getSvgElementVisibleAndFullBBoxes(rootSvg, {
            coarseFactor: 3,
            fineFactor: 24,
            useLayoutScale: true
          });
          const full = both.full;
          if (full && full.width > 0 && full.height > 0) {
            rootSvg.setAttribute('viewBox', `${full.x} ${full.y} ${full.width} ${full.height}`);
            if (!hasWidth) {
              rootSvg.setAttribute('width', String(full.width));
            }
            if (!hasHeight) {
              rootSvg.setAttribute('height', String(full.height));
            }
            warning = {
              type: 'bbox_computed',
              message:
                `No viewBox found. Computed full drawing bbox: viewBox="${full.x} ${full.y} ${full.width} ${full.height}". ` +
                'This may affect coordinate calculations if the SVG was designed with a different viewport.'
            };
          }
        }
      } else {
        // Has viewBox - just ensure width/height are set for proper rendering
        const hasW = !!rootSvg.getAttribute('width');
        const hasH = !!rootSvg.getAttribute('height');
        const vb = rootSvg.viewBox.baseVal;
        const aspect = vb.width > 0 && vb.height > 0 ? vb.width / vb.height : 1;
        if (!hasW && !hasH) {
          rootSvg.setAttribute('width', String(vb.width || 1000));
          rootSvg.setAttribute('height', String(vb.height || 1000));
        } else if (!hasW && hasH) {
          const h = parseFloat(rootSvg.getAttribute('height'));
          const w = isFinite(h) && h > 0 && aspect > 0 ? h * aspect : vb.width || 1000;
          rootSvg.setAttribute('width', String(w));
        } else if (hasW && !hasH) {
          const w = parseFloat(rootSvg.getAttribute('width'));
          const h = isFinite(w) && w > 0 && aspect > 0 ? w / aspect : vb.height || 1000;
          rootSvg.setAttribute('height', String(h));
        }
      }
      return warning;
    }, ignoreResolution);

    // Print warning if normalization occurred
    if (normalizationWarning) {
      printWarning(`⚠️  ${normalizationWarning.message}`);
    }

    return await handler(page);
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

// -------- LIST mode: data + HTML with filters & rename UI --------

async function listAndAssignIds(
  inputPath,
  assignIds,
  outFixedPath,
  outHtmlPath,
  jsonMode,
  autoOpen,
  ignoreResolution = false
) {
  const result = await withPageForSvg(
    inputPath,
    async (page) => {
      const evalResult = await page.evaluate(async (assignIds) => {
        /* eslint-disable no-undef */
        const SvgVisualBBox = window.SvgVisualBBox;
        if (!SvgVisualBBox) {
          throw new Error('SvgVisualBBox not found.');
        }

        const rootSvg = document.querySelector('svg');
        if (!rootSvg) {
          throw new Error('No <svg> found');
        }

        const serializer = new XMLSerializer();

        // Sprite sheet detection function (runs in browser context)
        function detectSpriteSheet(rootSvg) {
          const children = Array.from(rootSvg.children).filter((el) => {
            const tag = el.tagName.toLowerCase();
            return (
              tag !== 'defs' &&
              tag !== 'style' &&
              tag !== 'script' &&
              tag !== 'title' &&
              tag !== 'desc' &&
              tag !== 'metadata'
            );
          });

          if (children.length < 3) {
            return { isSprite: false, sprites: [], grid: null, stats: null };
          }

          const sprites = [];
          for (const child of children) {
            const id = child.id || `auto_${child.tagName}_${sprites.length}`;
            const bbox = child.getBBox ? child.getBBox() : null;

            if (bbox && bbox.width > 0 && bbox.height > 0) {
              sprites.push({
                id,
                tag: child.tagName.toLowerCase(),
                x: bbox.x,
                y: bbox.y,
                width: bbox.width,
                height: bbox.height,
                hasId: !!child.id
              });
            }
          }

          if (sprites.length < 3) {
            return { isSprite: false, sprites: [], grid: null, stats: null };
          }

          const widths = sprites.map((s) => s.width);
          const heights = sprites.map((s) => s.height);
          const areas = sprites.map((s) => s.width * s.height);

          const avgWidth = widths.reduce((a, b) => a + b, 0) / widths.length;
          const avgHeight = heights.reduce((a, b) => a + b, 0) / heights.length;
          const avgArea = areas.reduce((a, b) => a + b, 0) / areas.length;

          const widthStdDev = Math.sqrt(
            widths.reduce((sum, w) => sum + Math.pow(w - avgWidth, 2), 0) / widths.length
          );
          const heightStdDev = Math.sqrt(
            heights.reduce((sum, h) => sum + Math.pow(h - avgHeight, 2), 0) / heights.length
          );
          const areaStdDev = Math.sqrt(
            areas.reduce((sum, a) => sum + Math.pow(a - avgArea, 2), 0) / areas.length
          );

          const widthCV = widthStdDev / avgWidth;
          const heightCV = heightStdDev / avgHeight;
          const areaCV = areaStdDev / avgArea;

          const idPatterns = [
            /^icon[-_]/i,
            /^sprite[-_]/i,
            /^symbol[-_]/i,
            /^glyph[-_]/i,
            /[-_]\d+$/,
            /^\d+$/
          ];

          const hasCommonPattern =
            sprites.filter((s) => s.hasId && idPatterns.some((p) => p.test(s.id))).length /
              sprites.length >
            0.5;

          const xPositions = [...new Set(sprites.map((s) => Math.round(s.x)))].sort(
            (a, b) => a - b
          );
          const yPositions = [...new Set(sprites.map((s) => Math.round(s.y)))].sort(
            (a, b) => a - b
          );

          const isGridArranged = xPositions.length >= 2 && yPositions.length >= 2;

          const isSpriteSheet =
            (widthCV < 0.3 && heightCV < 0.3) || areaCV < 0.3 || hasCommonPattern || isGridArranged;

          return {
            isSprite: isSpriteSheet,
            sprites: sprites.map((s) => ({ id: s.id, tag: s.tag })),
            grid: isGridArranged
              ? {
                  rows: yPositions.length,
                  cols: xPositions.length
                }
              : null,
            stats: {
              count: sprites.length,
              avgSize: { width: avgWidth, height: avgHeight },
              uniformity: {
                widthCV: widthCV.toFixed(3),
                heightCV: heightCV.toFixed(3),
                areaCV: areaCV.toFixed(3)
              },
              hasCommonPattern,
              isGridArranged
            }
          };
        }

        // Detect if this is a sprite sheet
        const spriteInfo = detectSpriteSheet(rootSvg);

        const selector = [
          'g',
          'path',
          'rect',
          'circle',
          'ellipse',
          'polygon',
          'polyline',
          'text',
          'image',
          'use',
          'symbol'
        ].join(',');

        const els = Array.from(rootSvg.querySelectorAll(selector));

        const seenIds = new Set();
        function ensureUniqueId(base) {
          let id = base;
          let counter = 1;
          while (seenIds.has(id) || document.getElementById(id)) {
            id = base + '_' + counter++;
          }
          seenIds.add(id);
          return id;
        }

        for (const el of els) {
          if (el.id) {
            seenIds.add(el.id);
          }
        }

        const info = [];
        let changed = false;

        for (const el of els) {
          let id = el.id || null;

          if (assignIds && !id) {
            const base = 'auto_id_' + el.tagName.toLowerCase();
            const newId = ensureUniqueId(base);
            el.setAttribute('id', newId);
            id = newId;
            changed = true;
          }

          // Compute group ancestors (IDs of ancestor <g>)
          const groupIds = [];
          /** @type {HTMLElement | null} */
          let parent = el.parentElement;
          while (parent && parent !== /** @type {unknown} */ (rootSvg)) {
            if (parent.tagName && parent.tagName.toLowerCase() === 'g' && parent.id) {
              groupIds.push(parent.id);
            }
            parent = parent.parentElement;
          }

          // Compute visual bbox (may fail / be null)
          let bbox = null;
          let bboxError = null;
          try {
            const b = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(el, {
              mode: 'unclipped',
              coarseFactor: 3,
              fineFactor: 24,
              useLayoutScale: true,
              fontTimeoutMs: 15000 // Longer timeout for font loading
            });
            if (b) {
              bbox = { x: b.x, y: b.y, width: b.width, height: b.height };
            } else {
              // Check if it's a text element - likely font issue
              const tagLower = el.tagName && el.tagName.toLowerCase();
              if (tagLower === 'text') {
                bboxError = 'No visible pixels (likely missing fonts)';
              } else {
                bboxError = 'No visible pixels detected';
              }
            }
          } catch (err) {
            bboxError = err.message || 'BBox measurement failed';
          }

          info.push({
            tagName: el.tagName,
            id,
            bbox,
            bboxError,
            groups: groupIds
          });
        }

        let fixedSvgString = null;
        if (assignIds && changed) {
          fixedSvgString = serializer.serializeToString(rootSvg);
        }

        // ═══════════════════════════════════════════════════════════════════════════════
        // CRITICAL FIX #1: Remove viewBox/width/height/x/y from hidden container SVG
        // ═══════════════════════════════════════════════════════════════════════════════
        //
        // WHY THIS IS NECESSARY:
        // The hidden SVG container (which holds all element definitions for <use> references)
        // MUST NOT have viewBox, width, height, x, or y attributes because they constrain
        // the coordinate system and cause incorrect clipping of referenced elements.
        //
        // WHAT HAPPENS IF WE DON'T REMOVE THESE:
        // 1. The viewBox creates a "viewport coordinate system" for the container
        // 2. When <use href="#element-id" /> references an element, the browser tries to
        //    fit it within the container's viewBox
        // 3. Elements with coordinates outside the container viewBox get clipped
        // 4. This causes preview SVGs to show partial/empty content even though their
        //    individual viewBox is correct
        //
        // EXAMPLE OF THE BUG:
        // - Container has viewBox="0 0 1037.227 2892.792"
        // - Element rect1851 has bbox at x=42.34, y=725.29 (inside container viewBox) ✓
        // - Element text8 has bbox at x=-455.64 (OUTSIDE container viewBox, negative!) ✗
        // - Result: text8 preview appears empty because container viewBox clips it
        //
        // HOW WE TESTED THIS:
        // 1. Generated HTML with container viewBox → text8, text9, rect1851 broken
        // 2. Removed container viewBox → All previews showed correctly
        // 3. Extracted objects to individual SVG files (--extract) → All worked perfectly
        //    (proving bbox calculations are correct, issue is HTML-specific)
        //
        // WHY THIS FIX IS CORRECT:
        // According to SVG spec, a <use> element inherits the coordinate system from
        // its context (the preview SVG), NOT from the element's original container.
        // By removing the container's viewBox, we allow <use> to work purely with
        // the preview SVG's viewBox, which is correctly sized to the element's bbox.
        //
        // COMPREHENSIVE TESTS PROVING THIS FIX:
        // See tests/unit/html-preview-rendering.test.js
        // - "Elements with negative coordinates get clipped when container has viewBox"
        //   → Proves faulty method (container with viewBox) clips elements
        // - "Elements with negative coordinates render fully when container has NO viewBox"
        //   → Proves correct method (no viewBox) works
        // - "EDGE CASE: Element far outside container viewBox (negative coordinates)"
        //   → Tests real bug from text8 at x=-455.64
        // - "EDGE CASE: Element with coordinates in all quadrants"
        //   → Tests negative X, negative Y, positive X, positive Y
        const clonedForMarkup = /** @type {Element} */ (rootSvg.cloneNode(true));
        clonedForMarkup.removeAttribute('viewBox');
        clonedForMarkup.removeAttribute('width');
        clonedForMarkup.removeAttribute('height');
        clonedForMarkup.removeAttribute('x');
        clonedForMarkup.removeAttribute('y');
        const rootSvgMarkup = serializer.serializeToString(clonedForMarkup);

        // ═══════════════════════════════════════════════════════════════════════════════
        // CRITICAL FIX #2: Collect parent group transforms for <use> elements
        // ═══════════════════════════════════════════════════════════════════════════════
        //
        // ROOT CAUSE OF THE TRANSFORM BUG (discovered after extensive testing):
        // ───────────────────────────────────────────────────────────────────────────────
        // When using <use href="#element-id" />, SVG does NOT apply parent group transforms!
        // This is a fundamental SVG specification behavior that MUST be handled explicitly.
        //
        // DETAILED EXPLANATION:
        // In the original SVG document, elements inherit transforms from their parent groups:
        //
        //   <g id="g37" transform="translate(-13.613145,-10.209854)">
        //     <text id="text8" transform="scale(0.86535508,1.155595)">Λοπ</text>
        //   </g>
        //
        // When the browser renders this, text8's FINAL transform matrix is:
        //   1. Apply g37's translate(-13.613145,-10.209854)
        //   2. Apply text8's scale(0.86535508,1.155595)
        //   3. Render text content
        //
        // But when HTML preview creates:
        //   <svg viewBox="-455.64 1474.75 394.40 214.40">
        //     <use href="#text8" />
        //   </svg>
        //
        // The <use> element ONLY applies text8's LOCAL transform:
        //   ✓ scale(0.86535508,1.155595) from text8's transform attribute
        //   ✗ MISSING translate(-13.613145,-10.209854) from parent g37!
        //
        // RESULT: Preview is shifted/mispositioned by exactly the parent transform amount
        //
        // REAL-WORLD EXAMPLE FROM test_text_to_path_advanced.svg:
        // ───────────────────────────────────────────────────────────────────────────────
        // Elements that BROKE in HTML preview:
        // - text8: Has parent g37 with translate(-13.613145,-10.209854)
        //   → Preview shifted 13.6 pixels left, 10.2 pixels up
        // - text9: Has parent g37 with translate(-13.613145,-10.209854)
        //   → Preview shifted 13.6 pixels left, 10.2 pixels up
        // - rect1851: Has parent g1 with translate(-1144.8563,517.64642)
        //   → Preview shifted 1144.8 pixels left, 517.6 pixels down (appeared empty!)
        //
        // Elements that WORKED in HTML preview:
        // - text37: Direct child of root SVG, NO parent group
        //   → No parent transforms to miss, worked perfectly
        // - text2: Has parent g6 with translate(0,0)
        //   → Parent transform is identity, no visible shift
        //
        // HOW WE DEBUGGED THIS:
        // ───────────────────────────────────────────────────────────────────────────────
        // 1. Initial hypothesis: bbox calculation wrong
        //    TEST: Extracted text8 to individual SVG file with --extract --margin 0
        //    RESULT: Extracted SVG rendered PERFECTLY in browser! ✓
        //    CONCLUSION: Bbox calculations are correct, bug is HTML-specific ✓
        //
        // 2. Second hypothesis: viewBox constraining coordinates
        //    TEST: Removed viewBox from hidden container SVG
        //    RESULT: Still broken! ✗
        //    CONCLUSION: Not the root cause
        //
        // 3. Third hypothesis: width/height conflicting with viewBox
        //    TEST: Removed width/height from preview SVGs
        //    RESULT: Still broken! ✗
        //    CONCLUSION: Not the root cause
        //
        // 4. Fourth hypothesis: <use> element not inheriting transforms
        //    COMPARISON: Analyzed working vs broken elements:
        //    - text37 (works): No parent group
        //    - text2 (works): Parent g6 has translate(0,0)
        //    - text8 (broken): Parent g37 has translate(-13.613145,-10.209854)
        //    - text9 (broken): Parent g37 has translate(-13.613145,-10.209854)
        //    PATTERN: All broken elements have non-identity parent transforms! ✓
        //    CONCLUSION: This is the root cause! ✓
        //
        // THE SOLUTION:
        // ───────────────────────────────────────────────────────────────────────────────
        // Wrap <use> in a <g> element with explicitly collected parent transforms:
        //
        //   <svg viewBox="-455.64 1474.75 394.40 214.40">
        //     <g transform="translate(-13.613145,-10.209854)">  ← Parent transform
        //       <use href="#text8" />  ← Element with local scale transform
        //     </g>
        //   </svg>
        //
        // Now the transform chain is COMPLETE:
        //   1. Apply wrapper <g>'s translate (parent transform from g37)
        //   2. Apply text8's scale (local transform from text8)
        //   3. Render text content
        //
        // This exactly matches the original SVG's transform chain! ✓
        //
        // VERIFICATION THAT THIS FIX WORKS:
        // ───────────────────────────────────────────────────────────────────────────────
        // After implementing this fix:
        // - text8 preview: Renders perfectly, text fully visible ✓
        // - text9 preview: Renders perfectly, text fully visible ✓
        // - rect1851 preview: Renders perfectly, red oval fully visible ✓
        // - All other elements: Still working correctly ✓
        //
        // User confirmation: "yes, it worked!"
        //
        // IMPLEMENTATION DETAILS:
        // ───────────────────────────────────────────────────────────────────────────────
        // We collect transforms by walking UP the DOM tree from each element to the root:
        // 1. Start at element's parent
        // 2. For each ancestor group until root SVG:
        //    a. Get transform attribute if present
        //    b. Prepend to list (unshift) to maintain parent→child order
        // 3. Join all transforms with spaces
        // 4. Store in parentTransforms[id] for use in HTML generation
        //
        // Example transform collection for text8:
        //   text8 → g37 (transform="translate(-13.613145,-10.209854)") → root SVG
        //   parentTransforms["text8"] = "translate(-13.613145,-10.209854)"
        //
        // Example transform collection for deeply nested element:
        //   elem → g3 (transform="rotate(45)") → g2 (transform="scale(2)") → g1 (transform="translate(10,20)") → root
        //   parentTransforms["elem"] = "translate(10,20) scale(2) rotate(45)"
        //   (Note: parent→child order is preserved!)
        //
        // WHY THIS APPROACH IS CORRECT:
        // ───────────────────────────────────────────────────────────────────────────────
        // SVG transform matrices multiply from RIGHT to LEFT (parent first, then child):
        //   final_matrix = child_matrix × parent_matrix
        //
        // When we write:
        //   <g transform="translate(10,20) scale(2) rotate(45)">
        //
        // The browser computes:
        //   matrix = rotate(45) × scale(2) × translate(10,20)
        //
        // By collecting parent→child order and letting the browser parse it,
        // we get the exact same transform chain as the original SVG! ✓
        //
        // COMPREHENSIVE TESTS PROVING THIS FIX:
        // See tests/unit/html-preview-rendering.test.js
        // - "Element with parent translate transform renders incorrectly without wrapper"
        //   → Proves faulty method (<use> alone) is shifted by parent transform amount
        // - "Element with multiple nested parent transforms requires all transforms"
        //   → Tests complex case: translate(100,200) scale(2,2) rotate(45) chain
        // - "EDGE CASE: Element with no parent transforms (direct child of root)"
        //   → Tests text37 from test_text_to_path_advanced.svg (works without wrapper)
        // - "EDGE CASE: Element with identity parent transform (translate(0,0))"
        //   → Tests text2 from test_text_to_path_advanced.svg (no-op transform)
        // - "EDGE CASE: Large parent transform (rect1851 bug - shifted 1144px)"
        //   → Tests rect1851 real bug: translate(-1144.8563,517.64642) made it empty!
        // - "REAL-WORLD REGRESSION TEST: text8, text9, rect1851"
        //   → Tests exact production bug with all three broken elements
        //   → User confirmation: "yes, it worked!"
        const parentTransforms = {};
        info.forEach((obj) => {
          const el = rootSvg.getElementById(obj.id);
          if (!el) {
            return;
          }

          // Collect transforms from all ancestor groups (bottom-up, then reverse for correct order)
          const transforms = [];
          /** @type {Node | null} */
          let node = el.parentNode;
          while (node && node !== rootSvg) {
            // Type guard: Check if node is an Element before accessing getAttribute
            if (node.nodeType === Node.ELEMENT_NODE) {
              const transform = /** @type {Element} */ (node).getAttribute('transform');
              if (transform) {
                transforms.unshift(transform); // Prepend to maintain parent→child order
              }
            }
            node = node.parentNode;
          }

          if (transforms.length > 0) {
            parentTransforms[obj.id] = transforms.join(' ');
          }
        });

        /* eslint-enable no-undef */
        return { info, fixedSvgString, rootSvgMarkup, parentTransforms, spriteInfo };
      }, assignIds);
      return evalResult;
    },
    { ignoreResolution }
  );

  // Build HTML listing file
  const html = buildListHtml(
    path.basename(inputPath),
    result.rootSvgMarkup,
    result.info,
    result.parentTransforms
  );

  // SECURITY: Validate and write HTML file safely
  const safeHtmlPath = validateOutputPath(outHtmlPath, {
    requiredExtensions: ['.html']
  });
  writeFileSafe(safeHtmlPath, html, 'utf-8');

  if (assignIds && result.fixedSvgString && outFixedPath) {
    // SECURITY: Validate and write fixed SVG file safely
    const safeFixedPath = validateOutputPath(outFixedPath, {
      requiredExtensions: ['.svg']
    });
    writeFileSafe(safeFixedPath, result.fixedSvgString, 'utf-8');
  }

  // Count bbox failures
  const totalObjects = result.info.length;
  const failedObjects = result.info.filter((obj) => obj.bboxError).length;
  const zeroSizeObjects = result.info.filter(
    (obj) => obj.bbox && (obj.bbox.width === 0 || obj.bbox.height === 0)
  ).length;

  if (jsonMode) {
    const jsonOut = {
      mode: 'list',
      input: path.resolve(inputPath),
      objects: result.info || [],
      totalObjects,
      bboxFailures: failedObjects,
      zeroSizeObjects,
      fixedSvgWritten: !!(assignIds && result.fixedSvgString && outFixedPath),
      fixedSvgPath: assignIds && outFixedPath ? path.resolve(outFixedPath) : null,
      htmlWritten: !!outHtmlPath,
      htmlPath: outHtmlPath ? path.resolve(outHtmlPath) : null,
      spriteInfo: result.spriteInfo
    };
    console.log(JSON.stringify(jsonOut, null, 2));
  } else {
    console.log(`✓ HTML listing written to: ${outHtmlPath}`);
    if (assignIds && result.fixedSvgString && outFixedPath) {
      console.log(`✓ Fixed SVG with assigned IDs saved to: ${outFixedPath}`);
      console.log('  Rename IDs in that file manually if you prefer, or use the');
      console.log('  HTML page to generate a JSON mapping and then use --rename.');
    } else {
      console.log('Tip: open the HTML file in your browser, use the filters to find');
      console.log('     objects, and fill the "New ID name" column to generate a');
      console.log('     JSON rename mapping.');
    }

    // Display sprite sheet detection info
    if (result.spriteInfo && result.spriteInfo.isSprite) {
      console.log('');
      console.log('🎨 Sprite sheet detected!');
      console.log(`   Sprites: ${result.spriteInfo.stats.count}`);
      if (result.spriteInfo.grid) {
        console.log(
          `   Grid: ${result.spriteInfo.grid.rows} rows × ${result.spriteInfo.grid.cols} cols`
        );
      }
      console.log(
        `   Avg size: ${result.spriteInfo.stats.avgSize.width.toFixed(1)} × ${result.spriteInfo.stats.avgSize.height.toFixed(1)}`
      );
      console.log(
        `   Uniformity: width CV=${result.spriteInfo.stats.uniformity.widthCV}, height CV=${result.spriteInfo.stats.uniformity.heightCV}`
      );
      console.log('   💡 Tip: Use --export-all to extract each sprite as a separate SVG file');
    }

    console.log('');
    console.log(`Objects found: ${totalObjects}`);
    if (failedObjects > 0) {
      console.log(
        `⚠️  BBox measurement FAILED for ${failedObjects} object(s) - marked with ❌ in HTML`
      );
    }
    if (zeroSizeObjects > 0) {
      console.log(
        `⚠️  ${zeroSizeObjects} object(s) have zero width/height - marked with ⚠️ in HTML`
      );
    }

    // Auto-open HTML in Chrome/Chromium if requested
    // CRITICAL: Must use Chrome/Chromium (other browsers have poor SVG support)
    if (autoOpen) {
      const absolutePath = path.resolve(outHtmlPath);

      openInChrome(absolutePath)
        .then((result) => {
          if (result.success) {
            console.log(`\n✓ Opened in Chrome: ${absolutePath}`);
          } else {
            console.log(`\n⚠️  ${result.error}`);
            console.log(`   Please open manually in Chrome/Chromium: ${absolutePath}`);
          }
        })
        .catch((err) => {
          console.log(`\n⚠️  Failed to auto-open: ${err.message}`);
          console.log(`   Please open manually in Chrome/Chromium: ${absolutePath}`);
        });
    }
  }
}

function buildListHtml(titleName, rootSvgMarkup, objects, parentTransforms = {}) {
  const safeTitle = String(titleName || 'SVG');
  const rows = [];

  objects.forEach((obj, index) => {
    const rowIndex = index + 1;
    const id = obj.id || '';
    const tagName = obj.tagName || '';
    const bbox = obj.bbox;
    const bboxError = obj.bboxError;
    const groups = Array.isArray(obj.groups) ? obj.groups : [];

    const groupsStr = groups.join(',');

    // If bbox measurement failed, show error instead of default
    let previewCell;
    let dataAttrs;

    if (bboxError || !bbox) {
      const errorMsg = bboxError || 'BBox is null';
      previewCell = `
        <div style="width:120px; height:120px; display:flex; align-items:center; justify-content:center; border:1px solid #f00; background:#ffe5e5; padding:8px; box-sizing:border-box;">
          <div style="font-size:0.7rem; color:#b00020; text-align:center;">
            ❌ BBox Failed<br>
            <span style="font-size:0.65rem;">${errorMsg.replace(/"/g, '&quot;')}</span>
          </div>
        </div>`;
      dataAttrs = `
        data-x=""
        data-y=""
        data-w=""
        data-h=""
        data-bbox-error="${errorMsg.replace(/"/g, '&quot;')}"`;
    } else {
      const x = isFinite(bbox.x) ? bbox.x : 0;
      const y = isFinite(bbox.y) ? bbox.y : 0;
      const w = isFinite(bbox.width) && bbox.width > 0 ? bbox.width : 0;
      const h = isFinite(bbox.height) && bbox.height > 0 ? bbox.height : 0;

      if (w === 0 || h === 0) {
        previewCell = `
          <div style="width:120px; height:120px; display:flex; align-items:center; justify-content:center; border:1px solid #f90; background:#fff3e5; padding:8px; box-sizing:border-box;">
            <div style="font-size:0.7rem; color:#f60; text-align:center;">
              ⚠️ Zero Size<br>
              <span style="font-size:0.65rem;">w=${w} h=${h}</span>
            </div>
          </div>`;
      } else {
        const viewBoxStr = `${x} ${y} ${w} ${h}`;
        // Apply parent transforms if they exist (critical for elements with local transforms)
        const parentTransform = parentTransforms[id] || '';
        const useElement = id
          ? parentTransform
            ? `<g transform="${parentTransform}"><use href="#${id}" /></g>`
            : `<use href="#${id}" />`
          : '';

        // ════════════════════════════════════════════════════════════════════════════════
        // PREVIEW CELL WITH VISIBLE BBOX BORDER
        // ════════════════════════════════════════════════════════════════════════════════
        //
        // CRITICAL REQUIREMENTS:
        // 1. Border must be COMPLETELY EXTERNAL to SVG content (no overlap)
        // 2. Border must be visible on both light and dark SVG content
        // 3. Border must be exactly 1px wide (not thicker)
        // 4. SVG must display at correct size with proper centering
        //
        // WHY THIS IS HARD:
        // - CSS border/outline on SVG always overlaps the content (border draws half inside/half outside)
        // - SVG with only viewBox (no width/height) collapses to 0x0 size
        // - SVG coordinate system makes stroke-width scale incorrectly
        // - display:none doesn't work in headless browsers (must use CSS class)
        //
        // WRONG APPROACHES (DON'T USE):
        // ❌ outline on SVG - overlaps content on top/right, not bottom/left (asymmetric)
        // ❌ border on SVG - always overlaps content by half the border width
        // ❌ SVG <rect> with stroke - stroke-width in user units scales unpredictably
        // ❌ SVG <rect> with vector-effect="non-scaling-stroke" - offset in user units is tiny
        // ❌ box-shadow - creates solid line, can't achieve dashed pattern
        // ❌ wrapper div with flex - collapses SVG to 0x0 size
        // ❌ wrapper div with padding - padding blocks SVG rendering (blank output)
        // ❌ rgba() alpha + opacity together - makes color too light (double transparency)
        //
        // CORRECT SOLUTION:
        // 1. Wrapper <span> with display:inline-block + line-height:0
        //    - inline-block shrink-wraps to SVG size
        //    - line-height:0 removes extra spacing from inline element
        // 2. Border on the wrapper span (NOT on SVG)
        //    - border draws completely outside the wrapper
        //    - wrapper tightly wraps the SVG, so border is just outside SVG
        // 3. SVG with width="100%" height="100%"
        //    - gives SVG actual dimensions (not 0x0)
        //    - 100% fills the wrapper exactly
        //    - max-width/max-height constraints keep it ≤ 120px
        // 4. Border: 1px dashed rgba(0,0,0,0.4)
        //    - dashed pattern for visibility
        //    - 40% opacity is subtle but visible on any background
        //    - pure black with alpha (NOT mixing alpha in rgba() with CSS opacity)
        //
        // ANTIALIASING NOTE:
        // You may see slight "bleeding" of SVG colors over the border edge.
        // This is normal browser antialiasing and NOT a bug - leave it alone!
        //
        previewCell = `
          <div style="width:120px; height:120px; display:flex; align-items:center; justify-content:center; border:1px solid #ccc; background:#fdfdfd;">
            <span style="display:inline-block; border:1px dashed rgba(0,0,0,0.4); line-height:0;">
              <svg viewBox="${viewBoxStr}" width="100%" height="100%"
                   style="max-width:120px; max-height:120px; display:block;">
                ${useElement}
              </svg>
            </span>
          </div>`;
      }

      dataAttrs = `
        data-x="${x}"
        data-y="${y}"
        data-w="${w}"
        data-h="${h}"`;
    }

    rows.push(
      `
      <tr
        data-row-index="${rowIndex}"
        data-id="${id.replace(/"/g, '&quot;')}"
        data-tag="${tagName.replace(/"/g, '&quot;')}"
        data-groups="${groupsStr.replace(/"/g, '&quot;')}"
        ${dataAttrs}
      >
        <td class="row-index-cell">${rowIndex}</td>
        <td style="white-space:nowrap;"><code>${id}</code></td>
        <td><code>&lt;${tagName}&gt;</code></td>
        <td>${previewCell}</td>
        <td>
          <label style="display:flex; flex-direction:column; gap:2px;">
            <span style="display:flex; gap:4px; align-items:center;">
              <input type="checkbox" class="rename-check">
              <input type="text"
                     class="rename-input"
                     placeholder="new-id"
                     value="${id.replace(/"/g, '&quot;')}"
                     style="flex:1; font-size:0.8rem;">
            </span>
            <span class="error-message" style="font-size:0.75rem; color:#b00020;"></span>
          </label>
        </td>
      </tr>`.trim()
    );
  });

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>SVG Objects - ${safeTitle}</title>
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      margin: 16px;
      background: #f5f5f5;
    }
    h1 {
      margin-top: 0;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      background: #fff;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 6px 8px;
      vertical-align: middle;
    }
    th {
      background: #f0f0f0;
      text-align: left;
    }
    tr:nth-child(even) {
      background: #fafafa;
    }
    code {
      font-family: "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 0.85rem;
    }
    .hint {
      font-size: 0.9rem;
      color: #555;
      max-width: 70em;
    }
    .hidden-svg-container {
      position: absolute;
      width: 0;
      height: 0;
      overflow: hidden;
      visibility: hidden;
    }
    .filters {
      margin-bottom: 12px;
      padding: 8px;
      background: #fff;
      border: 1px solid #ddd;
    }
    .filters fieldset {
      border: 1px dashed #ccc;
      padding: 6px 8px 10px;
      margin-bottom: 8px;
    }
    .filters legend {
      font-size: 0.85rem;
      font-weight: 600;
      color: #555;
    }
    .filters label {
      font-size: 0.8rem;
      margin-right: 6px;
    }
    .filters input[type="text"],
    .filters input[type="number"],
    .filters select {
      font-size: 0.8rem;
      padding: 2px 4px;
      margin-right: 4px;
    }
    .filters-buttons {
      display: flex;
      gap: 8px;
      margin-top: 4px;
    }
    button {
      font-size: 0.8rem;
      padding: 4px 10px;
      cursor: pointer;
    }
    button[disabled] {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .error-msg {
      color: #b00020;
      font-size: 0.8rem;
      margin-top: 4px;
      white-space: pre-wrap;
    }
    tr.invalid-rename td {
      background: rgb(255, 200, 200) !important; /* red background for validation errors */
    }
    .row-index-cell {
      width: 32px;
      text-align: right;
      font-size: 0.75rem;
      color: #666;
    }
  </style>
</head>
<body>
  <h1>SVG Objects for <code>${safeTitle}</code></h1>
  <p class="hint">
    Each row shows an OBJECT ID, tag, and a small preview clipped to that
    object’s visual bounding box. Use the filters below to explore, then
    optionally fill the “New ID name” column and click
    <em>Save JSON with renaming</em> to generate a mapping file.
  </p>

  <div class="filters">
    <fieldset>
      <legend>Text / Regex filter</legend>
      <label>
        Regex (ID / tag / group IDs):
        <input type="text" id="filterRegex" placeholder="e.g. icon_.* or ^auto_id_">
      </label>
    </fieldset>

    <fieldset>
      <legend>Element type &amp; group filter</legend>
      <label>
        Tag:
        <select id="filterTag">
          <option value="">(any)</option>
        </select>
      </label>
      <label>
        Descendant of group ID:
        <input type="text" id="filterGroupId" placeholder="group id">
      </label>
    </fieldset>

    <fieldset>
      <legend>Area filter (bbox intersection)</legend>
      <label>Xmin: <input type="number" step="any" id="areaX1" style="width:70px;"></label>
      <label>Ymin: <input type="number" step="any" id="areaY1" style="width:70px;"></label>
      <label>Xmax: <input type="number" step="any" id="areaX2" style="width:70px;"></label>
      <label>Ymax: <input type="number" step="any" id="areaY2" style="width:70px;"></label>
    </fieldset>

    <div class="filters-buttons">
      <button id="applyFiltersBtn">Apply filters</button>
      <button id="clearFiltersBtn">Clear filters</button>
      <button id="saveRenameJsonBtn" disabled>Save JSON with renaming</button>
    </div>
    <div id="errorArea" class="error-msg"></div>
  </div>

  <!-- Hidden source SVG with all original content; previews use <use href="#id"> -->
  <div class="hidden-svg-container">
    ${rootSvgMarkup}
  </div>

  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>OBJECT ID</th>
        <th>Tag</th>
        <th>Preview (bbox viewBox)</th>
        <th>New ID name (for JSON rename)</th>
      </tr>
    </thead>
    <tbody>
      ${rows.join('\n')}
    </tbody>
  </table>

  <script>
    (function() {
      const tbody = document.querySelector('tbody');
      const rows = Array.from(tbody.querySelectorAll('tr'));
      const filterRegexInput = document.getElementById('filterRegex');
      const filterTagSelect = document.getElementById('filterTag');
      const filterGroupInput = document.getElementById('filterGroupId');
      const areaX1Input = document.getElementById('areaX1');
      const areaY1Input = document.getElementById('areaY1');
      const areaX2Input = document.getElementById('areaX2');
      const areaY2Input = document.getElementById('areaY2');
      const applyBtn = document.getElementById('applyFiltersBtn');
      const clearBtn = document.getElementById('clearFiltersBtn');
      const saveBtn = document.getElementById('saveRenameJsonBtn');
      const errorArea = document.getElementById('errorArea');

      // Build tag filter options
      const tags = new Set();
      rows.forEach(r => {
        const t = (r.getAttribute('data-tag') || '').toLowerCase();
        if (t) tags.add(t);
      });
      Array.from(tags).sort().forEach(t => {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t;
        filterTagSelect.appendChild(opt);
      });

      // Cache base existing IDs from hidden SVG
      const rootSvg = document.querySelector('.hidden-svg-container svg');
      const baseExistingIds = new Set();
      if (rootSvg) {
        rootSvg.querySelectorAll('[id]').forEach(el => {
          baseExistingIds.add(el.id);
        });
      }

      function applyFilters() {
        errorArea.textContent = '';
        let regex = null;
        const regexStr = filterRegexInput.value.trim();
        if (regexStr) {
          try {
            regex = new RegExp(regexStr, 'i');
          } catch (e) {
            errorArea.textContent = 'Regex error: ' + e.message;
          }
        }

        const tagFilter = (filterTagSelect.value || '').toLowerCase();
        const groupFilter = filterGroupInput.value.trim();

        const x1 = parseFloat(areaX1Input.value);
        const y1 = parseFloat(areaY1Input.value);
        const x2 = parseFloat(areaX2Input.value);
        const y2 = parseFloat(areaY2Input.value);
        const useArea = [x1, y1, x2, y2].some(v => !isNaN(v));

        rows.forEach(row => {
          let visible = true;

          const id = row.getAttribute('data-id') || '';
          const tag = (row.getAttribute('data-tag') || '').toLowerCase();
          const groups = (row.getAttribute('data-groups') || '');
          const groupList = groups ? groups.split(',') : [];

          const rx = parseFloat(row.getAttribute('data-x'));
          const ry = parseFloat(row.getAttribute('data-y'));
          const rw = parseFloat(row.getAttribute('data-w'));
          const rh = parseFloat(row.getAttribute('data-h'));

          if (regex) {
            const hay = [id, tag, groups].join(' ');
            if (!regex.test(hay)) visible = false;
          }

          if (visible && tagFilter && tag !== tagFilter) {
            visible = false;
          }

          if (visible && groupFilter) {
            if (!groupList.includes(groupFilter)) visible = false;
          }

          if (visible && useArea && isFinite(rx) && isFinite(ry) && isFinite(rw) && isFinite(rh)) {
            const bx0 = rx;
            const by0 = ry;
            const bx1 = rx + rw;
            const by1 = ry + rh;

            const ax0 = isNaN(x1) ? -Infinity : x1;
            const ay0 = isNaN(y1) ? -Infinity : y1;
            const ax1 = isNaN(x2) ?  Infinity : x2;
            const ay1 = isNaN(y2) ?  Infinity : y2;

            const intersects =
              bx1 >= ax0 && bx0 <= ax1 &&
              by1 >= ay0 && by0 <= ay1;

            if (!intersects) visible = false;
          }

          row.style.display = visible ? '' : 'none';
        });
      }

      function clearFilters() {
        filterRegexInput.value = '';
        filterTagSelect.value = '';
        filterGroupInput.value = '';
        areaX1Input.value = '';
        areaY1Input.value = '';
        areaX2Input.value = '';
        areaY2Input.value = '';
        errorArea.textContent = '';
        rows.forEach(r => r.style.display = '');
      }

      function isValidIdName(id) {
        return /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(id);
      }

      /**
       * Validate all rename inputs at once, respecting row order.
       * - Adds/removes .invalid-rename on rows
       * - Sets per-row warning message
       * - Enables/disables Save JSON button based on validity
       * Returns: { mappings, hasErrors }
       */
      function validateAllRenames() {
        const existingIdsSet = new Set(baseExistingIds);
        const usedTargets = new Set();
        const seenFrom = new Set();
        let hasErrors = false;
        const mappings = [];

        // Clear old messages & classes
        rows.forEach(row => {
          row.classList.remove('invalid-rename');
          const errSpan = row.querySelector('.error-message');
          if (errSpan) errSpan.textContent = '';
        });
        errorArea.textContent = '';

        rows.forEach(row => {
          const fromId = (row.getAttribute('data-id') || '').trim();
          if (!fromId) return;

          const rowIndex = parseInt(row.getAttribute('data-row-index'), 10) || 0;
          const checkbox = row.querySelector('.rename-check');
          const input = row.querySelector('.rename-input');
          const rowError = row.querySelector('.error-message');
          if (!checkbox || !input || !rowError) return;

          const newId = (input.value || '').trim();

          // If checkbox not checked, skip validation
          if (!checkbox.checked) {
            return;
          }

          // If checkbox IS checked but input is empty, that's an error
          if (!newId) {
            hasErrors = true;
            row.classList.add('invalid-rename');
            rowError.textContent = 'New ID cannot be empty.';
            return;
          }

          // If no change (same as current ID), skip
          if (newId === fromId) {
            return;
          }

          // Syntax
          if (!isValidIdName(newId)) {
            hasErrors = true;
            row.classList.add('invalid-rename');
            rowError.textContent = 'Invalid ID syntax.';
            return;
          }

          // Same "from" twice => lower row loses
          if (seenFrom.has(fromId)) {
            hasErrors = true;
            row.classList.add('invalid-rename');
            rowError.textContent = 'Duplicate source ID; higher row keeps the rename.';
            return;
          }

          // Collision with existing ids (different element)
          if (existingIdsSet.has(newId) && newId !== fromId) {
            hasErrors = true;
            row.classList.add('invalid-rename');
            rowError.textContent = 'ID already exists in SVG.';
            return;
          }

          // Collision with previous new IDs
          if (usedTargets.has(newId) && newId !== fromId) {
            hasErrors = true;
            row.classList.add('invalid-rename');
            rowError.textContent = 'ID already used by a previous row.';
            return;
          }

          // Accept mapping
          seenFrom.add(fromId);
          usedTargets.add(newId);
          existingIdsSet.delete(fromId);
          existingIdsSet.add(newId);
          mappings.push({ from: fromId, to: newId });
        });

        // Enable/disable save button
        // Rule: disabled if any error. We don't force at least one mapping.
        saveBtn.disabled = hasErrors;

        return { mappings, hasErrors };
      }

      function saveRenameJson() {
        const { mappings, hasErrors } = validateAllRenames();

        if (hasErrors) {
          errorArea.textContent = 'Some rows have invalid renames. Fix the fields marked in red before saving.';
          return;
        }
        if (!mappings.length) {
          errorArea.textContent = 'No valid renames selected. Check the checkboxes and adjust new ID fields.';
          return;
        }

        const payload = {
          sourceSvgFile: '${safeTitle}',
          createdAt: new Date().toISOString(),
          mappings
        };

        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = '${safeTitle.replace(/[^a-zA-Z0-9._-]+/g, '_')}.rename.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }

      // Revalidate whenever user types or toggles a checkbox
      rows.forEach(row => {
        const checkbox = row.querySelector('.rename-check');
        const input = row.querySelector('.rename-input');
        if (checkbox) {
          checkbox.addEventListener('change', validateAllRenames);
        }
        if (input) {
          input.addEventListener('input', validateAllRenames);
        }
      });

      // Filter buttons
      applyBtn.addEventListener('click', applyFilters);
      clearBtn.addEventListener('click', () => {
        clearFilters();
        validateAllRenames(); // keep save-btn state consistent
      });
      saveBtn.addEventListener('click', saveRenameJson);

      // Live re-filter on changes
      filterRegexInput.addEventListener('input', applyFilters);
      filterTagSelect.addEventListener('change', applyFilters);
      filterGroupInput.addEventListener('input', applyFilters);
      areaX1Input.addEventListener('input', applyFilters);
      areaY1Input.addEventListener('input', applyFilters);
      areaX2Input.addEventListener('input', applyFilters);
      areaY2Input.addEventListener('input', applyFilters);

      // Initial validation state
      validateAllRenames();
    })();
  </script>
</body>
</html>`;
}

// -------- EXTRACT mode --------

async function extractSingleObject(
  inputPath,
  elementId,
  outSvgPath,
  margin,
  includeContext,
  jsonMode,
  ignoreResolution = false
) {
  const result = await withPageForSvg(
    inputPath,
    async (page) => {
      const evalResult = await page.evaluate(
        async (elementId, marginUser, includeContext) => {
          /* eslint-disable no-undef */
          const SvgVisualBBox = window.SvgVisualBBox;
          if (!SvgVisualBBox) {
            throw new Error('SvgVisualBBox not found.');
          }

          const rootSvg = document.querySelector('svg');
          if (!rootSvg) {
            throw new Error('No <svg> found');
          }

          const el = rootSvg.ownerDocument.getElementById(elementId);
          if (!el) {
            throw new Error('No element found with id="' + elementId + '"');
          }

          const bboxData = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(el, {
            mode: 'unclipped',
            coarseFactor: 3,
            fineFactor: 24,
            useLayoutScale: true
          });
          if (!bboxData) {
            throw new Error('Element id="' + elementId + '" has no visible pixels.');
          }

          let x = bboxData.x;
          let y = bboxData.y;
          let w = bboxData.width;
          let h = bboxData.height;
          if (marginUser > 0) {
            x -= marginUser;
            y -= marginUser;
            w += 2 * marginUser;
            h += 2 * marginUser;
          }
          if (w <= 0 || h <= 0) {
            throw new Error('Degenerate bbox after margin.');
          }

          const clonedRoot = /** @type {Element} */ (rootSvg.cloneNode(false));
          if (!clonedRoot.getAttribute('xmlns')) {
            clonedRoot.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
          }
          const xlinkNS = rootSvg.getAttribute('xmlns:xlink');
          if (xlinkNS && !clonedRoot.getAttribute('xmlns:xlink')) {
            clonedRoot.setAttribute('xmlns:xlink', xlinkNS);
          }

          clonedRoot.setAttribute('viewBox', `${x} ${y} ${w} ${h}`);
          clonedRoot.setAttribute('width', String(w));
          clonedRoot.setAttribute('height', String(h));

          const defsList = Array.from(rootSvg.querySelectorAll('defs'));
          for (const defs of defsList) {
            clonedRoot.appendChild(defs.cloneNode(true));
          }

          if (!includeContext) {
            const ancestors = [];
            /** @type {Node | null} */
            let node = el;
            while (node && node !== rootSvg) {
              ancestors.unshift(node);
              node = node.parentNode;
            }
            /** @type {Element} */
            let currentParent = clonedRoot;
            for (const original of ancestors) {
              const clone = original.cloneNode(false);
              if (original === el) {
                const fullSubtree = original.cloneNode(true);
                currentParent.appendChild(fullSubtree);
              } else {
                const nextParent = /** @type {Element} */ (clone);
                currentParent.appendChild(nextParent);
                currentParent = nextParent;
              }
            }
          } else {
            const children = Array.from(rootSvg.childNodes);
            for (const child of children) {
              // Type guard: Check if child is an Element before accessing tagName
              if (
                child.nodeType === Node.ELEMENT_NODE &&
                /** @type {Element} */ (child).tagName.toLowerCase() === 'defs'
              ) {
                continue;
              }
              clonedRoot.appendChild(child.cloneNode(true));
            }
          }

          const serializer = new XMLSerializer();
          const svgString = serializer.serializeToString(clonedRoot);

          return {
            bbox: { x, y, width: w, height: h },
            svgString
          };
          /* eslint-enable no-undef */
        },
        elementId,
        margin,
        includeContext
      );
      return evalResult;
    },
    { ignoreResolution }
  );

  // SECURITY: Validate and write extracted SVG file safely
  const safeOutputPath = validateOutputPath(outSvgPath, {
    requiredExtensions: ['.svg']
  });
  writeFileSafe(safeOutputPath, result.svgString, 'utf-8');

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          mode: 'extract',
          input: path.resolve(inputPath),
          elementId,
          output: path.resolve(outSvgPath),
          margin,
          includeContext,
          bbox: result.bbox
        },
        null,
        2
      )
    );
  } else {
    console.log(`✓ Extracted "${elementId}" to: ${outSvgPath}`);
    console.log('  bbox:', result.bbox);
    console.log('  margin (user units):', margin);
    console.log('  includeContext (keep other objects?):', includeContext);
  }
}

// -------- EXPORT-ALL mode --------

async function exportAllObjects(
  inputPath,
  outDir,
  margin,
  exportGroups,
  jsonMode,
  ignoreResolution = false
) {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const exports = await withPageForSvg(
    inputPath,
    async (page) => {
      const evalResult = await page.evaluate(
        async (marginUser, exportGroups) => {
          /* eslint-disable no-undef */
          const SvgVisualBBox = window.SvgVisualBBox;
          if (!SvgVisualBBox) {
            throw new Error('SvgVisualBBox not found.');
          }

          const rootSvg = document.querySelector('svg');
          if (!rootSvg) {
            throw new Error('No <svg> found');
          }

          const serializer = new XMLSerializer();

          const baseTags = [
            'path',
            'rect',
            'circle',
            'ellipse',
            'polygon',
            'polyline',
            'text',
            'image',
            'use',
            'symbol'
          ];
          const groupTag = 'g';

          const selector = exportGroups ? baseTags.concat(groupTag).join(',') : baseTags.join(',');

          const allCandidates = Array.from(rootSvg.querySelectorAll(selector));

          const usedIds = new Set();
          for (const el of allCandidates) {
            if (el.id) {
              usedIds.add(el.id);
            }
          }
          function ensureId(el) {
            if (el.id) {
              return el.id;
            }
            const base = 'auto_id_' + el.tagName.toLowerCase();
            let id = base;
            let i = 1;
            while (usedIds.has(id) || document.getElementById(id)) {
              id = base + '_' + i++;
            }
            el.setAttribute('id', id);
            usedIds.add(id);
            return id;
          }

          const defsList = Array.from(rootSvg.querySelectorAll('defs'));

          function makeRootSvgWithBBox(bbox) {
            const clonedRoot = /** @type {Element} */ (rootSvg.cloneNode(false));
            if (!clonedRoot.getAttribute('xmlns')) {
              clonedRoot.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
            }
            const xlinkNS = rootSvg.getAttribute('xmlns:xlink');
            if (xlinkNS && !clonedRoot.getAttribute('xmlns:xlink')) {
              clonedRoot.setAttribute('xmlns:xlink', xlinkNS);
            }
            let { x, y, width, height } = bbox;
            if (marginUser > 0) {
              x -= marginUser;
              y -= marginUser;
              width += 2 * marginUser;
              height += 2 * marginUser;
            }
            if (width <= 0 || height <= 0) {
              return null;
            }
            clonedRoot.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
            clonedRoot.setAttribute('width', String(width));
            clonedRoot.setAttribute('height', String(height));
            for (const defs of defsList) {
              clonedRoot.appendChild(defs.cloneNode(true));
            }
            return clonedRoot;
          }

          function tagEquals(el, tagName) {
            return el.tagName && el.tagName.toLowerCase() === tagName.toLowerCase();
          }

          const exports = [];

          async function exportElement(el, prefix) {
            const id = ensureId(el);
            const bboxData = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(el, {
              mode: 'unclipped',
              coarseFactor: 3,
              fineFactor: 24,
              useLayoutScale: true
            });
            if (!bboxData) {
              return;
            }

            const rootForExport = makeRootSvgWithBBox(bboxData);
            if (!rootForExport) {
              return;
            }

            const ancestors = [];
            let node = el;
            while (node && node !== rootSvg) {
              ancestors.unshift(node);
              node = node.parentNode;
            }

            let currentParent = rootForExport;
            for (const original of ancestors) {
              const shallowClone = original.cloneNode(false);
              if (original === el) {
                const subtree = original.cloneNode(true);
                currentParent.appendChild(subtree);
              } else {
                const nextParent = shallowClone;
                currentParent.appendChild(nextParent);
                currentParent = nextParent;
              }
            }

            const svgString = serializer.serializeToString(rootForExport);
            const fileName = (prefix ? prefix + '_' : '') + id + '.svg';

            exports.push({
              id,
              fileName,
              bbox: {
                x: bboxData.x,
                y: bboxData.y,
                width: bboxData.width,
                height: bboxData.height
              },
              svgString
            });

            if (exportGroups && tagEquals(el, groupTag)) {
              const children = Array.from(el.children);
              for (const child of children) {
                const tag = child.tagName.toLowerCase();
                if (baseTags.includes(tag) || tag === groupTag) {
                  await exportElement(child, id);
                }
              }
            }
          }

          for (const el of allCandidates) {
            await exportElement(el, '');
          }

          return exports;
          /* eslint-enable no-undef */
        },
        margin,
        exportGroups
      );
      return evalResult;
    },
    { ignoreResolution }
  );

  if (!exports || exports.length === 0) {
    if (jsonMode) {
      console.log(
        JSON.stringify(
          {
            mode: 'exportAll',
            input: path.resolve(inputPath),
            outputDir: path.resolve(outDir),
            margin,
            exportGroups,
            exported: []
          },
          null,
          2
        )
      );
    } else {
      console.log('No objects exported (none with visible bbox).');
    }
    return;
  }

  const exportedMeta = [];

  for (const ex of exports) {
    const outPath = path.join(outDir, ex.fileName);
    // SECURITY: Validate and write exported SVG file safely
    const safeOutputPath = validateOutputPath(outPath, {
      requiredExtensions: ['.svg']
    });
    writeFileSafe(safeOutputPath, ex.svgString, 'utf-8');
    exportedMeta.push({
      id: ex.id,
      file: safeOutputPath,
      bbox: ex.bbox
    });
    if (!jsonMode) {
      console.log(`✓ Exported ${ex.id} -> ${safeOutputPath}`);
    }
  }

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          mode: 'exportAll',
          input: path.resolve(inputPath),
          outputDir: path.resolve(outDir),
          margin,
          exportGroups,
          exported: exportedMeta
        },
        null,
        2
      )
    );
  } else {
    console.log('\nExport completed.');
  }
}

// -------- RENAME mode --------

async function renameIds(
  inputPath,
  renameJsonPath,
  renameOutPath,
  jsonMode,
  ignoreResolution = false
) {
  // SECURITY: Read and validate JSON mapping file safely
  const safeJsonPath = validateFilePath(renameJsonPath, {
    requiredExtensions: ['.json'],
    mustExist: true
  });
  const parsed = readJSONFileSafe(safeJsonPath);

  let mappings = [];
  if (Array.isArray(parsed)) {
    mappings = parsed;
  } else if (Array.isArray(parsed.mappings)) {
    mappings = parsed.mappings;
  } else if (parsed && typeof parsed === 'object') {
    mappings = Object.entries(parsed).map(([from, to]) => ({ from, to }));
  }

  // SECURITY: Validate mapping structure
  mappings = mappings
    .filter((m) => m && typeof m.from === 'string' && typeof m.to === 'string')
    .map((m) => ({ from: m.from.trim(), to: m.to.trim() }))
    .filter((m) => m.from && m.to);

  if (!mappings.length) {
    throw new ValidationError('No valid mappings found in JSON.');
  }

  // SECURITY: Validate each mapping
  validateRenameMapping(mappings);

  const result = await withPageForSvg(
    inputPath,
    async (page) => {
      const evalResult = await page.evaluate((mappings) => {
        /* eslint-disable no-undef */
        const SvgVisualBBox = window.SvgVisualBBox;
        if (!SvgVisualBBox) {
          throw new Error('SvgVisualBBox not found.');
        }

        const rootSvg = document.querySelector('svg');
        if (!rootSvg) {
          throw new Error('No <svg> found');
        }

        function isValidIdName(id) {
          return /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(id);
        }

        const allWithId = rootSvg.ownerDocument.querySelectorAll('[id]');
        const existingIds = new Set();
        allWithId.forEach((el) => existingIds.add(el.id));

        const applied = [];
        const skipped = [];
        const usedTargets = new Set();
        const seenFrom = new Set();

        for (const m of mappings) {
          const from = m.from;
          const to = m.to;

          if (!from || !to) {
            skipped.push({ mapping: m, reason: 'Empty from/to' });
            continue;
          }

          if (!isValidIdName(to)) {
            skipped.push({ mapping: m, reason: 'Invalid target ID syntax' });
            continue;
          }

          if (seenFrom.has(from)) {
            skipped.push({ mapping: m, reason: 'Duplicate source ID; earlier mapping wins' });
            continue;
          }

          const el = rootSvg.ownerDocument.getElementById(from);
          if (!el) {
            skipped.push({ mapping: m, reason: 'Source ID not found in SVG' });
            continue;
          }

          if (from === to) {
            skipped.push({ mapping: m, reason: 'Source and target IDs are the same' });
            continue;
          }

          if (existingIds.has(to) && to !== from) {
            skipped.push({ mapping: m, reason: 'Target ID already exists in SVG' });
            continue;
          }

          if (usedTargets.has(to) && to !== from) {
            skipped.push({ mapping: m, reason: 'Target ID already used by a previous mapping' });
            continue;
          }

          // Apply the rename
          seenFrom.add(from);
          usedTargets.add(to);
          existingIds.delete(from);
          existingIds.add(to);

          el.setAttribute('id', to);

          // Update references: href, xlink:href, url(#from) in attributes
          const allEls = rootSvg.ownerDocument.querySelectorAll('*');
          const oldRef = '#' + from;
          const newRef = '#' + to;
          const urlOld = 'url(#' + from + ')';
          const urlNew = 'url(#' + to + ')';

          allEls.forEach((node) => {
            if (node.hasAttribute('href')) {
              const v = node.getAttribute('href');
              if (v === oldRef) {
                node.setAttribute('href', newRef);
              }
            }
            if (node.hasAttributeNS('http://www.w3.org/1999/xlink', 'href')) {
              const v = node.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
              if (v === oldRef) {
                node.setAttributeNS('http://www.w3.org/1999/xlink', 'href', newRef);
              }
            }
            for (const attr of Array.from(node.attributes)) {
              const val = attr.value;
              if (!val) {
                continue;
              }
              if (val.indexOf(urlOld) !== -1) {
                node.setAttribute(attr.name, val.split(urlOld).join(urlNew));
              }
            }
          });

          applied.push({ from, to });
        }

        const serializer = new XMLSerializer();
        const svgString = serializer.serializeToString(rootSvg);

        return { svgString, applied, skipped };
        /* eslint-enable no-undef */
      }, mappings);
      return evalResult;
    },
    { ignoreResolution }
  );

  // SECURITY: Validate and write renamed SVG file safely
  const safeOutputPath = validateOutputPath(renameOutPath, {
    requiredExtensions: ['.svg']
  });
  writeFileSafe(safeOutputPath, result.svgString, 'utf-8');

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          mode: 'rename',
          input: path.resolve(inputPath),
          mappingFile: path.resolve(renameJsonPath),
          output: path.resolve(renameOutPath),
          applied: result.applied,
          skipped: result.skipped
        },
        null,
        2
      )
    );
  } else {
    console.log(`✓ Renamed IDs using ${renameJsonPath} -> ${renameOutPath}`);
    console.log(`  Applied mappings: ${result.applied.length}`);
    if (result.skipped.length) {
      console.log(`  Skipped mappings: ${result.skipped.length}`);
      result.skipped.slice(0, 10).forEach((s) => {
        console.log('   -', s.mapping.from, '→', s.mapping.to, '(', s.reason, ')');
      });
      if (result.skipped.length > 10) {
        console.log('    ... (more skipped mappings not shown)');
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  // Display version
  printInfo(`sbb-extract v${getVersion()} | svg-bbox toolkit\n`);

  const opts = parseArgs(process.argv);

  try {
    if (opts.mode === 'list') {
      await listAndAssignIds(
        opts.input,
        opts.assignIds,
        opts.outFixed,
        opts.outHtml,
        opts.json,
        opts.autoOpen,
        opts.ignoreResolution
      );
    } else if (opts.mode === 'extract') {
      await extractSingleObject(
        opts.input,
        opts.extractId,
        opts.outSvg,
        opts.margin,
        opts.includeContext,
        opts.json,
        opts.ignoreResolution
      );
    } else if (opts.mode === 'exportAll') {
      await exportAllObjects(
        opts.input,
        opts.outDir,
        opts.margin,
        opts.exportGroups,
        opts.json,
        opts.ignoreResolution
      );
    } else if (opts.mode === 'rename') {
      await renameIds(
        opts.input,
        opts.renameJson,
        opts.renameOut,
        opts.json,
        opts.ignoreResolution
      );
    } else {
      throw new SVGBBoxError(`Unknown mode: ${opts.mode}`);
    }
  } catch (error) {
    throw new SVGBBoxError(`Operation failed: ${error.message}`, error);
  }
}

// SECURITY: Run with CLI error handling
runCLI(main);

module.exports = { main };
