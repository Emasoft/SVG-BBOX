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
 *     [--auto-open]
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
const { execFile } = require('child_process');

// -------- CLI parsing --------

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length < 2 && !(args.length === 2 && args[1] === '--list')) {
    console.error(
      'Usage:\n' +
      '  # LIST OBJECTS (HTML + optional fixed SVG with IDs)\n' +
      '  node extract_svg_objects.js input.svg --list\n' +
      '    [--assign-ids --out-fixed fixed.svg]\n' +
      '    [--out-html list.html]\n' +
      '    [--auto-open]\n' +
      '    [--json]\n\n' +
      '  # RENAME IDs USING A JSON MAPPING\n' +
      '  node extract_svg_objects.js input.svg --rename mapping.json output.svg [--json]\n\n' +
      '  # EXTRACT ONE OBJECT BY ID\n' +
      '  node extract_svg_objects.js input.svg --extract id output.svg\n' +
      '    [--margin N] [--include-context] [--json]\n\n' +
      '  # EXPORT ALL OBJECTS\n' +
      '  node extract_svg_objects.js input.svg --export-all out-dir\n' +
      '    [--margin N] [--export-groups] [--json]\n\n' +
      'Concepts:\n' +
      '  • Cut-out WITHOUT context (extract, no --include-context):\n' +
      '      Only the chosen object and its ancestor groups are included.\n' +
      '      Great for clean icons and assets.\n' +
      '  • Cut-out WITH context (extract + --include-context):\n' +
      '      All objects remain (filters, overlays, other shapes), but the\n' +
      '      viewBox is cropped to the bbox of the target object (+ margin).\n' +
      '      This preserves the “look” of the object in its environment.\n' +
      '  • Renaming workflow:\n' +
      '      1) Run --list to generate an HTML overview page.\n' +
      '      2) Open the HTML in a browser, use the last column to specify\n' +
      '         new IDs, tick the checkboxes, and click “Save JSON with\n' +
      '         renaming” to download a JSON mapping file.\n' +
      '      3) Run --rename with that JSON file and an output SVG.\n'
    );
    process.exit(1);
  }

  const positional = [];
  const options = {
    input: null,
    mode: null,           // 'list', 'extract', 'exportAll', 'rename'
    extractId: null,
    outSvg: null,
    outDir: null,
    margin: 0,
    includeContext: false,
    assignIds: false,
    outFixed: null,
    exportGroups: false,
    json: false,
    outHtml: null,
    renameJson: null,
    renameOut: null,
    autoOpen: false       // automatically open HTML in browser
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
        case 'list':
          options.mode = 'list';
          break;
        case 'assign-ids':
          options.assignIds = true;
          break;
        case 'out-fixed':
          options.outFixed = next;
          useNext();
          break;
        case 'out-html':
          options.outHtml = next;
          useNext();
          break;
        case 'extract':
          options.mode = 'extract';
          options.extractId = next;
          useNext();
          break;
        case 'export-all':
          options.mode = 'exportAll';
          options.outDir = next;
          useNext();
          break;
        case 'margin':
          options.margin = parseFloat(next);
          if (!isFinite(options.margin) || options.margin < 0) {
            options.margin = 0;
          }
          useNext();
          break;
        case 'include-context':
          options.includeContext = true;
          break;
        case 'export-groups':
          options.exportGroups = true;
          break;
        case 'json':
          options.json = true;
          break;
        case 'auto-open':
          options.autoOpen = true;
          break;
        case 'rename':
          options.mode = 'rename';
          options.renameJson = next;
          useNext();
          break;
        default:
          console.warn('Unknown option:', key);
      }
    } else {
      positional.push(a);
    }
  }

  if (!positional[0]) {
    console.error('You must provide an input.svg file.');
    process.exit(1);
  }
  options.input = positional[0];

  // extract: need outSvg
  if (options.mode === 'extract') {
    if (!options.extractId) {
      console.error('--extract requires an element id');
      process.exit(1);
    }
    if (!positional[1]) {
      console.error('--extract requires an output SVG path');
      process.exit(1);
    }
    options.outSvg = positional[1];
  }

  // exportAll: need outDir
  if (options.mode === 'exportAll') {
    if (!options.outDir) {
      console.error('--export-all requires an output directory');
      process.exit(1);
    }
  }

  // rename: need mapping json and output
  if (options.mode === 'rename') {
    if (!options.renameJson) {
      console.error('--rename requires a mapping.json file');
      process.exit(1);
    }
    if (!positional[1]) {
      console.error('--rename requires an output SVG path');
      process.exit(1);
    }
    options.renameOut = positional[1];
  }

  // list defaults
  if (options.mode === 'list' && options.assignIds && !options.outFixed) {
    options.outFixed = options.input.replace(/\.svg$/i, '') + '.ids.svg';
  }
  if (options.mode === 'list' && !options.outHtml) {
    options.outHtml = options.input.replace(/\.svg$/i, '') + '.objects.html';
  }

  if (!options.mode) {
    options.mode = 'list';
  }

  return options;
}

// -------- shared browser/page setup --------

async function withPageForSvg(inputPath, handler) {
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

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>SVG Tool</title>
</head>
<body>
${svgContent}
</body>
</html>`;

    await page.setContent(html, { waitUntil: 'networkidle0' });

    const libPath = path.resolve(__dirname, 'SvgVisualBBox.js');
    if (!fs.existsSync(libPath)) {
      throw new Error('SvgVisualBBox.js not found at: ' + libPath);
    }
    await page.addScriptTag({ path: libPath });

    // Shared "initial import": normalize viewBox + width/height in memory.
    await page.evaluate(async () => {
      const SvgVisualBBox = window.SvgVisualBBox;
      if (!SvgVisualBBox) {
        throw new Error('SvgVisualBBox not found.');
      }

      const rootSvg = document.querySelector('svg');
      if (!rootSvg) {
        throw new Error('No <svg> found in document.');
      }

      await SvgVisualBBox.waitForDocumentFonts(document, 8000);

      const vbVal = rootSvg.viewBox && rootSvg.viewBox.baseVal;
      if (!vbVal || !vbVal.width || !vbVal.height) {
        const both = await SvgVisualBBox.getSvgElementVisibleAndFullBBoxes(rootSvg, {
          coarseFactor: 3,
          fineFactor: 24,
          useLayoutScale: true
        });
        const full = both.full;
        if (full && full.width > 0 && full.height > 0) {
          rootSvg.setAttribute('viewBox', `${full.x} ${full.y} ${full.width} ${full.height}`);
          if (!rootSvg.getAttribute('width')) {
            rootSvg.setAttribute('width', String(full.width));
          }
          if (!rootSvg.getAttribute('height')) {
            rootSvg.setAttribute('height', String(full.height));
          }
        }
      } else {
        const hasW = !!rootSvg.getAttribute('width');
        const hasH = !!rootSvg.getAttribute('height');
        const vb = rootSvg.viewBox.baseVal;
        const aspect = vb.width > 0 && vb.height > 0 ? vb.width / vb.height : 1;
        if (!hasW && !hasH) {
          rootSvg.setAttribute('width', String(vb.width || 1000));
          rootSvg.setAttribute('height', String(vb.height || 1000));
        } else if (!hasW && hasH) {
          const h = parseFloat(rootSvg.getAttribute('height'));
          const w = (isFinite(h) && h > 0 && aspect > 0) ? h * aspect : (vb.width || 1000);
          rootSvg.setAttribute('width', String(w));
        } else if (hasW && !hasH) {
          const w = parseFloat(rootSvg.getAttribute('width'));
          const h = (isFinite(w) && w > 0 && aspect > 0) ? w / aspect : (vb.height || 1000);
          rootSvg.setAttribute('height', String(h));
        }
      }
    });

    return await handler(page);
  } finally {
    await browser.close();
  }
}

// -------- LIST mode: data + HTML with filters & rename UI --------

async function listAndAssignIds(inputPath, assignIds, outFixedPath, outHtmlPath, jsonMode, autoOpen) {
  const result = await withPageForSvg(inputPath, async (page) => await page.evaluate(async (assignIds) => {
    const SvgVisualBBox = window.SvgVisualBBox;
    if (!SvgVisualBBox) {
      throw new Error('SvgVisualBBox not found.');
    }

    const rootSvg = document.querySelector('svg');
    if (!rootSvg) {
      throw new Error('No <svg> found');
    }

    const serializer = new XMLSerializer();

    const selector = [
      'g', 'path', 'rect', 'circle', 'ellipse',
      'polygon', 'polyline', 'text', 'image', 'use', 'symbol'
    ].join(',');

    const els = Array.from(rootSvg.querySelectorAll(selector));

    const seenIds = new Set();
    function ensureUniqueId(base) {
      let id = base;
      let counter = 1;
      while (seenIds.has(id) || document.getElementById(id)) {
        id = base + '_' + (counter++);
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
      let parent = el.parentElement;
      while (parent && parent !== rootSvg) {
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
          fontTimeoutMs: 15000  // Longer timeout for font loading
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

    // CRITICAL FIX: Remove viewBox, width, height, x, y from root SVG in hidden container
    // These attributes constrain the coordinate system and cause preview viewBoxes to be wrong
    // When <use> references elements, they should not be clipped by the original viewBox
    const clonedForMarkup = rootSvg.cloneNode(true);
    clonedForMarkup.removeAttribute('viewBox');
    clonedForMarkup.removeAttribute('width');
    clonedForMarkup.removeAttribute('height');
    clonedForMarkup.removeAttribute('x');
    clonedForMarkup.removeAttribute('y');
    const rootSvgMarkup = serializer.serializeToString(clonedForMarkup);

    return { info, fixedSvgString, rootSvgMarkup };
  }, assignIds));

  // Build HTML listing file
  const html = buildListHtml(
    path.basename(inputPath),
    result.rootSvgMarkup,
    result.info
  );
  fs.writeFileSync(outHtmlPath, html, 'utf8');

  if (assignIds && result.fixedSvgString && outFixedPath) {
    fs.writeFileSync(outFixedPath, result.fixedSvgString, 'utf8');
  }

  // Count bbox failures
  const totalObjects = result.info.length;
  const failedObjects = result.info.filter(obj => obj.bboxError).length;
  const zeroSizeObjects = result.info.filter(obj =>
    obj.bbox && (obj.bbox.width === 0 || obj.bbox.height === 0)
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
      fixedSvgPath: (assignIds && outFixedPath) ? path.resolve(outFixedPath) : null,
      htmlWritten: !!outHtmlPath,
      htmlPath: outHtmlPath ? path.resolve(outHtmlPath) : null
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
    console.log('');
    console.log(`Objects found: ${totalObjects}`);
    if (failedObjects > 0) {
      console.log(`⚠️  BBox measurement FAILED for ${failedObjects} object(s) - marked with ❌ in HTML`);
    }
    if (zeroSizeObjects > 0) {
      console.log(`⚠️  ${zeroSizeObjects} object(s) have zero width/height - marked with ⚠️ in HTML`);
    }

    // Auto-open HTML in browser if requested
    if (autoOpen) {
      const absolutePath = path.resolve(outHtmlPath);

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
          console.log(`\n⚠️  Could not auto-open browser: ${error.message}`);
          console.log(`   Please open manually: ${absolutePath}`);
        } else {
          console.log(`\n✓ Opened in browser: ${absolutePath}`);
        }
      });
    }
  }
}

function buildListHtml(titleName, rootSvgMarkup, objects) {
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
        previewCell = `
          <div style="width:120px; height:120px; display:flex; align-items:center; justify-content:center; border:1px solid #ccc; background:#fdfdfd;">
            <svg viewBox="${viewBoxStr}"
                 style="max-width:120px; max-height:120px; display:block;">
              ${id ? `<use href="#${id}" />` : ''}
            </svg>
          </div>`;
      }

      dataAttrs = `
        data-x="${x}"
        data-y="${y}"
        data-w="${w}"
        data-h="${h}"`;
    }

    rows.push(`
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
            <span class="row-error" style="font-size:0.75rem; color:#b00020;"></span>
          </label>
        </td>
      </tr>`.trim());
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
      background: #ffe5e5 !important; /* subtle red */
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
          const errSpan = row.querySelector('.row-error');
          if (errSpan) errSpan.textContent = '';
        });
        errorArea.textContent = '';

        rows.forEach(row => {
          const fromId = (row.getAttribute('data-id') || '').trim();
          if (!fromId) return;

          const rowIndex = parseInt(row.getAttribute('data-row-index'), 10) || 0;
          const checkbox = row.querySelector('.rename-check');
          const input = row.querySelector('.rename-input');
          const rowError = row.querySelector('.row-error');
          if (!checkbox || !input || !rowError) return;

          const newId = (input.value || '').trim();

          // If checkbox not checked or no change, we don't propose a mapping here.
          if (!checkbox.checked || !newId || newId === fromId) {
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

async function extractSingleObject(inputPath, elementId, outSvgPath, margin, includeContext, jsonMode) {
  const result = await withPageForSvg(inputPath, async (page) => await page.evaluate(async (elementId, marginUser, includeContext) => {
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

    const clonedRoot = rootSvg.cloneNode(false);
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
      let node = el;
      while (node && node !== rootSvg) {
        ancestors.unshift(node);
        node = node.parentNode;
      }
      let currentParent = clonedRoot;
      for (const original of ancestors) {
        const clone = original.cloneNode(false);
        if (original === el) {
          const fullSubtree = original.cloneNode(true);
          currentParent.appendChild(fullSubtree);
        } else {
          const nextParent = clone;
          currentParent.appendChild(nextParent);
          currentParent = nextParent;
        }
      }
    } else {
      const children = Array.from(rootSvg.childNodes);
      for (const child of children) {
        if (child.nodeType === Node.ELEMENT_NODE && child.tagName.toLowerCase() === 'defs') {
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
  }, elementId, margin, includeContext));

  fs.writeFileSync(outSvgPath, result.svgString, 'utf8');

  if (jsonMode) {
    console.log(JSON.stringify({
      mode: 'extract',
      input: path.resolve(inputPath),
      elementId,
      output: path.resolve(outSvgPath),
      margin,
      includeContext,
      bbox: result.bbox
    }, null, 2));
  } else {
    console.log(`✓ Extracted "${elementId}" to: ${outSvgPath}`);
    console.log('  bbox:', result.bbox);
    console.log('  margin (user units):', margin);
    console.log('  includeContext (keep other objects?):', includeContext);
  }
}

// -------- EXPORT-ALL mode --------

async function exportAllObjects(inputPath, outDir, margin, exportGroups, jsonMode) {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const exports = await withPageForSvg(inputPath, async (page) => await page.evaluate(async (marginUser, exportGroups) => {
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
      'path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline',
      'text', 'image', 'use', 'symbol'
    ];
    const groupTag = 'g';

    const selector = exportGroups
      ? baseTags.concat(groupTag).join(',')
      : baseTags.join(',');

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
        id = base + '_' + (i++);
      }
      el.setAttribute('id', id);
      usedIds.add(id);
      return id;
    }

    const defsList = Array.from(rootSvg.querySelectorAll('defs'));

    function makeRootSvgWithBBox(bbox) {
      const clonedRoot = rootSvg.cloneNode(false);
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
  }, margin, exportGroups));

  if (!exports || exports.length === 0) {
    if (jsonMode) {
      console.log(JSON.stringify({
        mode: 'exportAll',
        input: path.resolve(inputPath),
        outputDir: path.resolve(outDir),
        margin,
        exportGroups,
        exported: []
      }, null, 2));
    } else {
      console.log('No objects exported (none with visible bbox).');
    }
    return;
  }

  const exportedMeta = [];

  for (const ex of exports) {
    const outPath = path.join(outDir, ex.fileName);
    fs.writeFileSync(outPath, ex.svgString, 'utf8');
    exportedMeta.push({
      id: ex.id,
      file: outPath,
      bbox: ex.bbox
    });
    if (!jsonMode) {
      console.log(`✓ Exported ${ex.id} -> ${outPath}`);
    }
  }

  if (jsonMode) {
    console.log(JSON.stringify({
      mode: 'exportAll',
      input: path.resolve(inputPath),
      outputDir: path.resolve(outDir),
      margin,
      exportGroups,
      exported: exportedMeta
    }, null, 2));
  } else {
    console.log('\nExport completed.');
  }
}

// -------- RENAME mode --------

async function renameIds(inputPath, renameJsonPath, renameOutPath, jsonMode) {
  const raw = fs.readFileSync(renameJsonPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('Failed to parse JSON mapping file: ' + e.message);
  }

  let mappings = [];
  if (Array.isArray(parsed)) {
    mappings = parsed;
  } else if (Array.isArray(parsed.mappings)) {
    mappings = parsed.mappings;
  } else if (parsed && typeof parsed === 'object') {
    mappings = Object.entries(parsed).map(([from, to]) => ({ from, to }));
  }

  mappings = mappings
    .filter(m => m && typeof m.from === 'string' && typeof m.to === 'string')
    .map(m => ({ from: m.from.trim(), to: m.to.trim() }))
    .filter(m => m.from && m.to);

  if (!mappings.length) {
    throw new Error('No valid mappings found in JSON.');
  }

  const result = await withPageForSvg(inputPath, async (page) => await page.evaluate((mappings) => {
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
    allWithId.forEach(el => existingIds.add(el.id));

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

      allEls.forEach(node => {
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
  }, mappings));

  fs.writeFileSync(renameOutPath, result.svgString, 'utf8');

  if (jsonMode) {
    console.log(JSON.stringify({
      mode: 'rename',
      input: path.resolve(inputPath),
      mappingFile: path.resolve(renameJsonPath),
      output: path.resolve(renameOutPath),
      applied: result.applied,
      skipped: result.skipped
    }, null, 2));
  } else {
    console.log(`✓ Renamed IDs using ${renameJsonPath} -> ${renameOutPath}`);
    console.log(`  Applied mappings: ${result.applied.length}`);
    if (result.skipped.length) {
      console.log(`  Skipped mappings: ${result.skipped.length}`);
      result.skipped.slice(0, 10).forEach(s => {
        console.log('   -', s.mapping.from, '→', s.mapping.to, '(', s.reason, ')');
      });
      if (result.skipped.length > 10) {
        console.log('    ... (more skipped mappings not shown)');
      }
    }
  }
}

// -------- main entry --------

(async () => {
  const opts = parseArgs(process.argv);

  try {
    if (opts.mode === 'list') {
      await listAndAssignIds(opts.input, opts.assignIds, opts.outFixed, opts.outHtml, opts.json, opts.autoOpen);
    } else if (opts.mode === 'extract') {
      await extractSingleObject(
        opts.input,
        opts.extractId,
        opts.outSvg,
        opts.margin,
        opts.includeContext,
        opts.json
      );
    } else if (opts.mode === 'exportAll') {
      await exportAllObjects(
        opts.input,
        opts.outDir,
        opts.margin,
        opts.exportGroups,
        opts.json
      );
    } else if (opts.mode === 'rename') {
      await renameIds(
        opts.input,
        opts.renameJson,
        opts.renameOut,
        opts.json
      );
    } else {
      console.error('Unknown mode', opts.mode);
      process.exit(1);
    }
  } catch (err) {
    if (opts.json) {
      console.log(JSON.stringify({
        error: true,
        message: err.message || String(err)
      }, null, 2));
    } else {
      console.error('Error:', err.message || err);
    }
    process.exit(1);
  }
})();