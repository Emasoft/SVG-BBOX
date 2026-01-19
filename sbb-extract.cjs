#!/usr/bin/env node
/**
 * sbb-extract.cjs
 *
 * Advanced SVG object tooling using Puppeteer + SvgVisualBBox.
 *
 * MODES
 * =====
 *
 * 1) LIST OBJECTS (HTML overview + optional fixed SVG with IDs)
 * ------------------------------------------------------------
 *   node sbb-extract.cjs input.svg --list
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
 *   node sbb-extract.cjs input.svg --rename mapping.json output.svg
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
 *   node sbb-extract.cjs input.svg --extract id output.svg
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
 *   node sbb-extract.cjs input.svg --export-all out-dir
 *     [--margin N] [--export-groups] [--json]
 *
 *   • "Objects" = path, rect, circle, ellipse, polygon, polyline, text,
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
 *   BATCH MODE:
 *   -----------
 *   node sbb-extract.cjs --export-all out-dir --batch files.txt
 *     [--margin N] [--export-groups] [--json]
 *
 *   • Process multiple SVG files listed in a batch file (one path per line)
 *   • Lines starting with # are ignored (comments)
 *   • Each SVG's objects are exported to a timestamped subfolder:
 *       out-dir/<basename>_YYYYMMDD_HHMMSS/
 *   • Example batch file (files.txt):
 *       # My SVG files to process
 *       drawing1.svg
 *       /path/to/drawing2.svg
 *       icons/sprite-sheet.svg
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
const { openInChrome } = require('./browser-utils.cjs');
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
  SHELL_METACHARACTERS,
  SVGBBoxError,
  ValidationError
} = require('./lib/security-utils.cjs');

const { runCLI, printError, printInfo, printWarning, printBanner } = require('./lib/cli-utils.cjs');

// -------- CLI parsing --------

/**
 * @typedef {Object} ParsedOptions
 * @property {string | null} input - Input SVG file path
 * @property {string} mode - Operation mode (list, extract, exportAll, rename)
 * @property {string | null} extractId - ID of element to extract
 * @property {string | null} outSvg - Output SVG file path
 * @property {string | null} outDir - Output directory for export-all
 * @property {number} margin - Margin in pixels
 * @property {boolean} includeContext - Include context elements
 * @property {boolean} assignIds - Assign IDs to unnamed objects
 * @property {string | null} outFixed - Output fixed SVG with assigned IDs
 * @property {boolean} exportGroups - Export groups too
 * @property {string | null} batch - Batch file path
 * @property {boolean} json - Output in JSON format
 * @property {string | null} outHtml - Output HTML preview path
 * @property {string | null} renameJson - JSON mapping file path
 * @property {string | null} renameOut - Output renamed SVG path
 * @property {boolean} autoOpen - Open result in Chrome
 * @property {boolean} ignoreResolution - Use full drawing bbox instead of width/height
 * @property {string | null} batchIds - Batch IDs file path for extracting multiple elements
 * @property {string | null} batchOutDir - Output directory for batch extraction
 * @property {boolean} quiet - Minimal output mode - only prints essential info
 * @property {boolean} verbose - Show detailed progress information
 */

/**
 * Parse command-line arguments for sbb-extract
 * @param {string[]} argv - Command-line arguments array
 * @returns {ParsedOptions} Parsed options object
 */
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
      '--rename': { mode: 'rename', consumesValue: true, valueTarget: 'renameJson' },
      // WHY: --batch-ids also triggers extract mode for batch extraction of multiple elements
      '--batch-ids': { mode: 'extract', consumesValue: true, valueTarget: 'batch-ids' }
    },
    globalFlags: [
      { name: 'json', alias: 'j', type: 'boolean', description: 'Output in JSON format' },
      { name: 'auto-open', type: 'boolean', description: 'Open result in Chrome' },
      {
        name: 'ignore-resolution',
        type: 'boolean',
        description: 'Use full drawing bbox instead of width/height for viewBox'
      },
      {
        name: 'quiet',
        alias: 'q',
        type: 'boolean',
        description: 'Minimal output - only essential info'
      },
      {
        name: 'verbose',
        alias: 'v',
        type: 'boolean',
        description: 'Show detailed progress information'
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
            validator: /** @param {number} v */ (v) => v >= 0,
            validationError: 'Margin must be >= 0'
          },
          { name: 'include-context', type: 'boolean', description: 'Include context elements' },
          {
            name: 'output',
            alias: 'o',
            type: 'string',
            description: 'Output SVG file (alternative to positional)'
          },
          {
            name: 'batch-ids',
            type: 'string',
            description: 'File with IDs to extract (one per line, format: id or id|output.svg)'
          },
          {
            name: 'out-dir',
            type: 'string',
            description: 'Output directory for batch extraction'
          }
        ],
        positional: [
          { name: 'input', required: true, description: 'Input SVG file' },
          { name: 'output', required: false, description: 'Output SVG file' }
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
            validator: /** @param {number} v */ (v) => v >= 0,
            validationError: 'Margin must be >= 0'
          },
          { name: 'export-groups', type: 'boolean', description: 'Export groups too' },
          { name: 'batch', type: 'string', description: 'Batch file with SVG paths (one per line)' }
        ],
        positional: [{ name: 'input', required: false, description: 'Input SVG file' }]
      },
      rename: {
        description: 'Rename objects according to a JSON mapping',
        flags: [
          {
            name: 'output',
            alias: 'o',
            type: 'string',
            description: 'Output SVG file (alternative to positional)'
          }
        ],
        positional: [
          { name: 'input', required: true, description: 'Input SVG file' },
          { name: 'output', required: false, description: 'Output SVG file' }
        ]
      }
    }
  });

  // Parse the arguments
  const result = parser(argv);

  // Map parser output to the expected legacy format for backward compatibility
  /** @type {ParsedOptions} */
  const options = {
    input: result.positional[0] || null,
    mode: result.mode,
    extractId: result.flags.extractId || null,
    outSvg: /** @type {string | null} */ (null),
    outDir: result.flags.outDir || null,
    margin: result.flags.margin || 0,
    includeContext: result.flags['include-context'] || false,
    assignIds: result.flags['assign-ids'] || false,
    outFixed: result.flags['out-fixed'] || null,
    exportGroups: result.flags['export-groups'] || false,
    batch: result.flags.batch || null,
    json: result.flags.json || false,
    outHtml: result.flags['out-html'] || null,
    renameJson: result.flags.renameJson || null,
    renameOut: /** @type {string | null} */ (null),
    autoOpen: result.flags['auto-open'] || false,
    ignoreResolution: result.flags['ignore-resolution'] || false,
    // WHY: Batch IDs extraction allows extracting multiple elements by ID from a single SVG
    batchIds: result.flags['batch-ids'] || null,
    // WHY: Output directory for batch extraction (defaults to input directory)
    batchOutDir: result.flags['out-dir'] || null,
    // WHY: Quiet mode for scripting - only outputs essential info (file paths)
    quiet: result.flags.quiet || false,
    // WHY: Verbose mode for debugging - shows detailed progress
    verbose: result.flags.verbose || false
  };

  // Mode-specific positional argument handling
  // Support both positional output and -o/--output flag (flag takes precedence)
  if (result.mode === 'extract') {
    // Use -o/--output flag if provided, otherwise fall back to positional
    options.outSvg = result.flags.output || result.positional[1] || null;
    // WHY: Only require output file if not using batch-ids mode
    // Batch-ids mode uses --out-dir or defaults to input file directory
    if (!options.outSvg && !options.batchIds) {
      // WHY: ValidationError already imported at top of file, no need to re-require
      throw new ValidationError(
        `Missing output file.\n\n` +
          `Usage:\n` +
          `  sbb-extract <input.svg> --extract <element-id> <output.svg>\n` +
          `  sbb-extract <input.svg> --extract <element-id> -o <output.svg>\n` +
          `  sbb-extract <input.svg> --batch-ids ids.txt [--out-dir output-dir]\n\n` +
          `Example:\n` +
          `  sbb-extract drawing.svg --extract myIcon icon.svg\n` +
          `  sbb-extract drawing.svg --batch-ids ids.txt`
      );
    }
  }

  if (result.mode === 'rename') {
    // Use -o/--output flag if provided, otherwise fall back to positional
    options.renameOut = result.flags.output || result.positional[1] || null;
    // Validate that output is provided (either via flag or positional)
    if (!options.renameOut) {
      // WHY: ValidationError already imported at top of file, no need to re-require
      throw new ValidationError(
        `Missing output file.\n\n` +
          `Usage:\n` +
          `  sbb-extract <input.svg> --rename <mapping.json> <output.svg>\n` +
          `  sbb-extract <input.svg> --rename <mapping.json> -o <output.svg>\n\n` +
          `Example:\n` +
          `  sbb-extract drawing.svg --rename ids.json renamed.svg\n` +
          `  sbb-extract drawing.svg --rename ids.json -o renamed.svg`
      );
    }
  }

  // Apply default values for list mode (only if input is not null)
  if (result.mode === 'list' && options.input !== null && options.assignIds && !options.outFixed) {
    options.outFixed = options.input.replace(/\.svg$/i, '') + '.ids.svg';
  }
  if (result.mode === 'list' && options.input !== null && !options.outHtml) {
    options.outHtml = options.input.replace(/\.svg$/i, '') + '.objects.html';
  }

  return options;
}

// -------- Batch File Reading --------

/**
 * Read and parse batch file list for --export-all mode.
 * Returns array of SVG file paths.
 *
 * Batch file format:
 * - One SVG file path per line
 * - Lines starting with # are comments and are ignored
 * - Empty lines are ignored
 * @param {string} batchFilePath - Path to the batch file containing SVG paths
 * @returns {string[]} Array of SVG file paths
 */
function readBatchFile(batchFilePath) {
  // SECURITY: Validate batch file
  const safeBatchPath = validateFilePath(batchFilePath, {
    requiredExtensions: ['.txt'],
    mustExist: true
  });

  const content = fs.readFileSync(safeBatchPath, 'utf-8');
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  if (lines.length === 0) {
    throw new ValidationError(`Batch file is empty: ${safeBatchPath}`);
  }

  // SECURITY: Validate each path for shell metacharacters
  lines.forEach((line, index) => {
    if (SHELL_METACHARACTERS.test(line)) {
      throw new ValidationError(
        `Invalid file path at line ${index + 1} in batch file: contains shell metacharacters`
      );
    }
  });

  return lines;
}

/**
 * Read and parse batch IDs file for extract mode.
 * Returns array of {id, output} objects.
 *
 * File format:
 * - One entry per line
 * - Format: id or id|output-filename.svg
 * - Lines starting with # are comments
 * - Empty lines are ignored
 *
 * WHY: Using | as divider because it cannot be used in file names on any OS
 * (Windows, macOS, Linux all prohibit | in filenames)
 *
 * @param {string} batchFilePath - Path to the batch IDs file
 * @returns {{id: string, output: string | null}[]} Array of ID/output pairs
 */
function readBatchIdsFile(batchFilePath) {
  // SECURITY: Validate batch file
  const safeBatchPath = validateFilePath(batchFilePath, {
    requiredExtensions: ['.txt'],
    mustExist: true
  });

  const content = fs.readFileSync(safeBatchPath, 'utf-8');
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  if (lines.length === 0) {
    throw new ValidationError(`Batch IDs file is empty: ${safeBatchPath}`);
  }

  // WHY: Using | as divider because it cannot be used in file names on any OS
  const DIVIDER = '|';

  return lines.map((line, index) => {
    const parts = line.split(DIVIDER);
    // WHY: parts[0] is always defined after split (even empty string for empty line)
    // but TypeScript doesn't know this, so we use fallback to empty string
    const id = (parts[0] || '').trim();
    const output = parts.length > 1 && parts[1] ? parts[1].trim() : null;

    if (!id) {
      throw new ValidationError(`Invalid entry at line ${index + 1}: empty ID`);
    }

    // SECURITY: Validate output filename if provided
    if (output && SHELL_METACHARACTERS.test(output)) {
      throw new ValidationError(
        `Invalid output filename at line ${index + 1}: contains shell metacharacters`
      );
    }

    return { id, output };
  });
}

// -------- shared browser/page setup --------

/**
 * @typedef {Object} WithPageOptions
 * @property {boolean} [ignoreResolution] - Use full drawing bbox instead of width/height for viewBox
 */

/**
 * Execute a handler function with a Puppeteer page loaded with the given SVG
 * @template T
 * @param {string} inputPath - Path to the SVG file
 * @param {(page: import('puppeteer').Page) => Promise<T>} handler - Handler function to execute with the page
 * @param {WithPageOptions} [options] - Options for page setup
 * @returns {Promise<T>} Result from the handler function
 */
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

    // WHY 'domcontentloaded': networkidle0 can hang indefinitely for SVGs with web fonts
    // or missing font references. domcontentloaded is sufficient - font rendering is
    // handled separately by waitForDocumentFonts() in the library.
    await page.setContent(html, { waitUntil: 'domcontentloaded' });

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
          const heightAttr = rootSvg.getAttribute('height');
          const h = heightAttr !== null ? parseFloat(heightAttr) : NaN;
          const w = isFinite(h) && h > 0 && aspect > 0 ? h * aspect : vb.width || 1000;
          rootSvg.setAttribute('width', String(w));
        } else if (hasW && !hasH) {
          const widthAttr = rootSvg.getAttribute('width');
          const w = widthAttr !== null ? parseFloat(widthAttr) : NaN;
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
        const browserProcess = browser.process();
        if (browserProcess) {
          browserProcess.kill('SIGKILL');
        }
      }
    }
  }
}

// -------- LIST mode: data + HTML with filters & rename UI --------

/**
 * @typedef {Object} BBoxInfo
 * @property {number} x - X coordinate
 * @property {number} y - Y coordinate
 * @property {number} width - Width
 * @property {number} height - Height
 */

/**
 * @typedef {Object} ObjectInfo
 * @property {string} tagName - SVG element tag name
 * @property {string | null} id - Element ID
 * @property {BBoxInfo | null} bbox - Bounding box info
 * @property {string | null} bboxError - Error message if bbox calculation failed
 * @property {string[]} groups - IDs of ancestor groups
 */

/**
 * @typedef {Object} SpriteStats
 * @property {number} count - Number of sprites
 * @property {{ width: number, height: number }} avgSize - Average sprite size
 * @property {{ widthCV: string, heightCV: string, areaCV: string }} uniformity - Uniformity coefficients
 * @property {boolean} hasCommonPattern - Whether sprites have common ID patterns
 * @property {boolean} isGridArranged - Whether sprites are arranged in a grid
 */

/**
 * @typedef {Object} SpriteInfo
 * @property {boolean} isSprite - Whether the SVG is a sprite sheet
 * @property {Array<{ id: string, tag: string }>} sprites - Sprite elements
 * @property {{ rows: number, cols: number } | null} grid - Grid dimensions if arranged in grid
 * @property {SpriteStats | null} stats - Sprite statistics
 */

/**
 * @typedef {Object} ListResult
 * @property {ObjectInfo[]} info - Object information array
 * @property {string | null} fixedSvgString - Fixed SVG string if IDs were assigned
 * @property {string} rootSvgMarkup - Root SVG markup for HTML preview
 * @property {Record<string, string>} parentTransforms - Parent transforms by element ID
 * @property {SpriteInfo} spriteInfo - Sprite sheet detection info
 */

/**
 * List and optionally assign IDs to objects in an SVG file
 * @param {string} inputPath - Input SVG file path
 * @param {boolean} assignIds - Whether to assign IDs to unnamed objects
 * @param {string | null} outFixedPath - Output path for fixed SVG with assigned IDs
 * @param {string | null} outHtmlPath - Output path for HTML preview
 * @param {boolean} jsonMode - Whether to output JSON format
 * @param {boolean} autoOpen - Whether to open result in Chrome
 * @param {boolean} [ignoreResolution] - Use full drawing bbox instead of width/height
 * @param {boolean} [quiet] - Minimal output mode - only prints essential info
 * @param {boolean} [verbose] - Show detailed progress information
 * @returns {Promise<void>}
 */
async function listAndAssignIds(
  inputPath,
  assignIds,
  outFixedPath,
  outHtmlPath,
  jsonMode,
  autoOpen,
  ignoreResolution = false,
  quiet = false,
  verbose = false
) {
  const result = await withPageForSvg(
    inputPath,
    async (page) => {
      const evalResult = await page.evaluate(async (/** @type {boolean} */ assignIds) => {
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
        /**
         * @param {SVGSVGElement} rootSvg - Root SVG element
         */
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

          /** @type {Array<{id: string, tag: string, x: number, y: number, width: number, height: number, hasId: boolean}>} */
          const sprites = [];
          for (const child of children) {
            /** @type {string} */
            const id = child.id || `auto_${child.tagName}_${sprites.length}`;
            // Cast to SVGGraphicsElement to access getBBox method (available on SVG graphic elements)
            const svgChild = /** @type {SVGGraphicsElement} */ (child);
            const bbox = typeof svgChild.getBBox === 'function' ? svgChild.getBBox() : null;

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

        /** @type {Set<string>} */
        const seenIds = new Set();
        /**
         * @param {string} base - Base ID to make unique
         * @returns {string} Unique ID
         */
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

        /** @type {Array<{tagName: string, id: string | null, bbox: {x: number, y: number, width: number, height: number} | null, bboxError: string | null, groups: string[]}>} */
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
            // Type guard: err is unknown, check if it has a message property
            bboxError =
              err instanceof Error
                ? err.message
                : typeof err === 'string'
                  ? err
                  : 'BBox measurement failed';
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
        //    CONCLUSION: BBox calculations are correct, bug is HTML-specific ✓
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
        /** @type {Record<string, string>} */
        const parentTransforms = {};
        info.forEach((obj) => {
          // Skip if obj.id is null (can't look up element without an ID)
          if (obj.id === null) {
            return;
          }
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

  // Ensure outHtmlPath is not null before proceeding
  if (outHtmlPath === null) {
    throw new ValidationError('Output HTML path is required for list mode');
  }

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
  } else if (quiet) {
    // WHY: Quiet mode - only output file paths for scripting
    if (outHtmlPath) {
      console.log(outHtmlPath);
    }
    if (assignIds && result.fixedSvgString && outFixedPath) {
      console.log(outFixedPath);
    }
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
    if (result.spriteInfo && result.spriteInfo.isSprite && result.spriteInfo.stats) {
      const stats = result.spriteInfo.stats;
      console.log('');
      console.log('🎨 Sprite sheet detected!');
      console.log(`   Sprites: ${stats.count}`);
      if (result.spriteInfo.grid) {
        console.log(
          `   Grid: ${result.spriteInfo.grid.rows} rows × ${result.spriteInfo.grid.cols} cols`
        );
      }
      console.log(
        `   Avg size: ${stats.avgSize.width.toFixed(1)} × ${stats.avgSize.height.toFixed(1)}`
      );
      console.log(
        `   Uniformity: width CV=${stats.uniformity.widthCV}, height CV=${stats.uniformity.heightCV}`
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

    // WHY: Verbose mode - show additional detailed info
    if (verbose) {
      console.log('');
      console.log('📋 Detailed info:');
      console.log(`   Input: ${path.resolve(inputPath)}`);
      if (outHtmlPath) {
        console.log(`   HTML output: ${path.resolve(outHtmlPath)}`);
      }
      if (outFixedPath && result.fixedSvgString) {
        console.log(`   Fixed SVG: ${path.resolve(outFixedPath)}`);
      }
    }

    // Auto-open HTML in Chrome/Chromium if requested
    // CRITICAL: Must use Chrome/Chromium (other browsers have poor SVG support)
    if (autoOpen && outHtmlPath !== null) {
      const absolutePath = path.resolve(outHtmlPath);

      openInChrome(absolutePath)
        .then((/** @type {{ success: boolean, error: string | null }} */ openResult) => {
          if (openResult.success) {
            console.log(`\n✓ Opened in Chrome: ${absolutePath}`);
          } else {
            console.log(`\n⚠️  ${openResult.error || 'Unknown error'}`);
            console.log(`   Please open manually in Chrome/Chromium: ${absolutePath}`);
          }
        })
        .catch((/** @type {Error} */ err) => {
          console.log(`\n⚠️  Failed to auto-open: ${err.message}`);
          console.log(`   Please open manually in Chrome/Chromium: ${absolutePath}`);
        });
    }
  }
}

/**
 * Build an HTML page listing all objects in an SVG
 * @param {string} titleName - Title for the HTML page
 * @param {string} rootSvgMarkup - Serialized SVG markup for the hidden container
 * @param {ObjectInfo[]} objects - Array of object info objects
 * @param {Record<string, string>} [parentTransforms] - Map of element IDs to parent transform strings
 * @returns {string} Complete HTML page as a string
 */
function buildListHtml(titleName, rootSvgMarkup, objects, parentTransforms = {}) {
  const safeTitle = String(titleName || 'SVG');
  // SECURITY: Escape for JavaScript string context to prevent XSS
  const safeTitleJS = JSON.stringify(safeTitle);
  /** @type {string[]} */
  const rows = [];

  objects.forEach((/** @type {ObjectInfo} */ obj, /** @type {number} */ index) => {
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
          sourceSvgFile: ${safeTitleJS},
          createdAt: new Date().toISOString(),
          mappings
        };

        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = ${JSON.stringify(safeTitle.replace(/[^a-zA-Z0-9._-]+/g, '_') + '.rename.json')};
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

/**
 * Extract a single object from an SVG file by ID
 * @param {string} inputPath - Input SVG file path
 * @param {string} elementId - ID of element to extract
 * @param {string} outSvgPath - Output SVG file path
 * @param {number} margin - Margin in pixels around the extracted element
 * @param {boolean} includeContext - Include context elements in output
 * @param {boolean} jsonMode - Output in JSON format
 * @param {boolean} [ignoreResolution] - Use full drawing bbox instead of width/height
 * @param {boolean} [quiet] - Minimal output mode - only prints essential info
 * @param {boolean} [verbose] - Show detailed progress information
 * @returns {Promise<void>}
 */
async function extractSingleObject(
  inputPath,
  elementId,
  outSvgPath,
  margin,
  includeContext,
  jsonMode,
  ignoreResolution = false,
  quiet = false,
  verbose = false
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
  } else if (quiet) {
    // WHY: Quiet mode - only output the extracted file path for scripting
    console.log(safeOutputPath);
  } else {
    console.log(`✓ Extracted "${elementId}" to: ${outSvgPath}`);
    console.log('  bbox:', result.bbox);
    console.log('  margin (user units):', margin);
    console.log('  includeContext (keep other objects?):', includeContext);

    // WHY: Verbose mode - show additional detailed info
    if (verbose) {
      console.log('');
      console.log('📋 Detailed extraction info:');
      console.log(`   Input: ${path.resolve(inputPath)}`);
      console.log(`   Element ID: ${elementId}`);
      console.log(`   Output: ${path.resolve(outSvgPath)}`);
    }
  }
}

// -------- EXPORT-ALL mode --------

/**
 * Export all named objects from an SVG file
 * @param {string} inputPath - Input SVG file path
 * @param {string} outDir - Output directory for exported SVGs
 * @param {number} margin - Margin in pixels around each exported element
 * @param {boolean} exportGroups - Whether to export group elements too
 * @param {boolean} jsonMode - Output in JSON format
 * @param {boolean} [ignoreResolution] - Use full drawing bbox instead of width/height
 * @param {boolean} [quiet] - Minimal output mode - only prints essential info
 * @param {boolean} [verbose] - Show detailed progress information
 * @returns {Promise<void>}
 */
async function exportAllObjects(
  inputPath,
  outDir,
  margin,
  exportGroups,
  jsonMode,
  ignoreResolution = false,
  quiet = false,
  verbose = false
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

          /** @type {Set<string>} */
          const usedIds = new Set();
          for (const el of allCandidates) {
            if (el.id) {
              usedIds.add(el.id);
            }
          }
          /**
           * Ensure element has an ID, generating one if needed
           * @param {Element} el - The element to ensure has an ID
           * @returns {string} The element's ID
           */
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

          /**
           * Create a root SVG element with the specified bounding box
           * @param {{ x: number, y: number, width: number, height: number }} bbox - Bounding box dimensions
           * @returns {Element | null} Cloned root SVG element or null if dimensions are invalid
           */
          function makeRootSvgWithBBox(bbox) {
            if (!rootSvg) {
              return null;
            }
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

          /**
           * Check if element's tag name matches
           * @param {Element} el - Element to check
           * @param {string} tagName - Tag name to compare
           * @returns {boolean} True if tag names match
           */
          function tagEquals(el, tagName) {
            return !!(el.tagName && el.tagName.toLowerCase() === tagName.toLowerCase());
          }

          /** @type {Array<{id: string, fileName: string, bbox: {x: number, y: number, width: number, height: number}, svgString: string}>} */
          const exports = [];

          /**
           * Export a single element to the exports array
           * @param {Element} el - Element to export
           * @param {string} prefix - Prefix for the file name
           * @returns {Promise<void>}
           */
          async function exportElement(el, prefix) {
            // Guard: SvgVisualBBox must be available
            if (!SvgVisualBBox) {
              return;
            }
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

            /** @type {Element[]} */
            const ancestors = [];
            /** @type {Element | null} */
            let node = el;
            while (node && node !== rootSvg) {
              ancestors.unshift(node);
              node = /** @type {Element | null} */ (node.parentNode);
            }

            /** @type {Element} */
            let currentParent = rootForExport;
            for (const original of ancestors) {
              const shallowClone = /** @type {Element} */ (original.cloneNode(false));
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
    } else if (!quiet) {
      // WHY: Quiet mode skips this message since there's nothing to output
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
    // WHY: Quiet mode outputs only file paths, verbose shows per-file messages
    if (!jsonMode && !quiet) {
      if (verbose) {
        console.log(`✓ Exported ${ex.id} -> ${safeOutputPath}`);
      }
    }
    if (quiet) {
      // WHY: Quiet mode - output only file path per line for scripting
      console.log(safeOutputPath);
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
  } else if (!quiet) {
    console.log(`\nExport completed. ${exportedMeta.length} object(s) exported to ${outDir}`);
    // WHY: Verbose mode - show additional details
    if (verbose) {
      console.log(`  Input: ${path.resolve(inputPath)}`);
      console.log(`  Margin: ${margin}`);
      console.log(`  Export groups: ${exportGroups}`);
    }
  }
}

// -------- RENAME mode --------

/**
 * Rename element IDs in an SVG file based on a JSON mapping
 * @param {string} inputPath - Input SVG file path
 * @param {string} renameJsonPath - Path to JSON file containing ID mappings
 * @param {string} renameOutPath - Output SVG file path
 * @param {boolean} jsonMode - Output in JSON format
 * @param {boolean} [ignoreResolution] - Use full drawing bbox instead of width/height
 * @param {boolean} [quiet] - Minimal output mode - only prints essential info
 * @param {boolean} [verbose] - Show detailed progress information
 * @returns {Promise<void>}
 */
async function renameIds(
  inputPath,
  renameJsonPath,
  renameOutPath,
  jsonMode,
  ignoreResolution = false,
  quiet = false,
  verbose = false
) {
  // SECURITY: Read and validate JSON mapping file safely
  const safeJsonPath = validateFilePath(renameJsonPath, {
    requiredExtensions: ['.json'],
    mustExist: true
  });
  /** @type {unknown} */
  const parsed = readJSONFileSafe(safeJsonPath);

  /** @type {Array<{from: string, to: string}>} */
  let mappings = [];
  if (Array.isArray(parsed)) {
    mappings = parsed;
  } else if (
    parsed &&
    typeof parsed === 'object' &&
    'mappings' in parsed &&
    Array.isArray(/** @type {{ mappings?: unknown }} */ (parsed).mappings)
  ) {
    mappings = /** @type {{ mappings: Array<{from: string, to: string}> }} */ (parsed).mappings;
  } else if (parsed && typeof parsed === 'object') {
    mappings = Object.entries(/** @type {Record<string, string>} */ (parsed)).map(([from, to]) => ({
      from,
      to
    }));
  }

  // SECURITY: Validate mapping structure
  mappings = mappings
    .filter(
      (/** @type {{from?: unknown, to?: unknown}} */ m) =>
        m && typeof m.from === 'string' && typeof m.to === 'string'
    )
    .map((/** @type {{from: string, to: string}} */ m) => ({
      from: m.from.trim(),
      to: m.to.trim()
    }))
    .filter((/** @type {{from: string, to: string}} */ m) => m.from && m.to);

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

        /**
         * Check if ID name is valid according to XML ID naming rules
         * @param {string} id - ID to validate
         * @returns {boolean} True if valid
         */
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
  } else if (quiet) {
    // WHY: Quiet mode - only output the output file path for scripting
    console.log(renameOutPath);
  } else {
    console.log(`✓ Renamed IDs using ${renameJsonPath} -> ${renameOutPath}`);
    console.log(`  Applied mappings: ${result.applied.length}`);
    if (result.skipped.length) {
      console.log(`  Skipped mappings: ${result.skipped.length}`);
      // WHY: Verbose mode shows all skipped, normal mode shows first 10
      const showCount = verbose ? result.skipped.length : Math.min(10, result.skipped.length);
      result.skipped.slice(0, showCount).forEach((s) => {
        console.log('   -', s.mapping.from, '→', s.mapping.to, '(', s.reason, ')');
      });
      if (!verbose && result.skipped.length > 10) {
        console.log('    ... (more skipped mappings not shown)');
      }
    }
    // WHY: Verbose mode - show additional details
    if (verbose) {
      console.log('');
      console.log('📋 Detailed info:');
      console.log(`   Input: ${path.resolve(inputPath)}`);
      console.log(`   Mapping file: ${path.resolve(renameJsonPath)}`);
      console.log(`   Output: ${path.resolve(renameOutPath)}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Main entry point for the sbb-extract CLI tool.
 * Parses command-line arguments and executes the requested operation mode.
 * @returns {Promise<void>}
 */
async function main() {
  const opts = parseArgs(process.argv);

  // WHY: Display banner unless in quiet or json mode
  printBanner('sbb-extract', { quiet: opts.quiet, json: opts.json });

  try {
    if (opts.mode === 'list') {
      // Validate required arguments for list mode
      if (!opts.input) {
        throw new ValidationError('Input SVG file is required for list mode');
      }
      await listAndAssignIds(
        opts.input,
        opts.assignIds,
        opts.outFixed,
        opts.outHtml,
        opts.json,
        opts.autoOpen,
        opts.ignoreResolution,
        opts.quiet,
        opts.verbose
      );
    } else if (opts.mode === 'extract') {
      if (opts.batchIds) {
        // Batch extraction mode - extract multiple elements by ID from a single SVG
        if (!opts.input) {
          throw new ValidationError('Input SVG file is required for batch extraction mode');
        }

        const entries = readBatchIdsFile(opts.batchIds);
        // WHY: Default output directory to input file's directory if not specified
        const outDir = opts.batchOutDir || path.dirname(opts.input);

        // SECURITY: Validate output directory
        validateOutputPath(outDir, { createDirectory: true });

        if (!opts.json) {
          printInfo(`Batch extracting ${entries.length} elements from ${opts.input}...\n`);
        }

        const results = [];
        for (const entry of entries) {
          // WHY: Generate output path using custom name or default to id.svg
          const outputFilename = entry.output || `${entry.id}.svg`;
          const outputPath = path.join(outDir, outputFilename);

          // WHY: Ensure parent directory exists for nested outputs like "controls/volume.svg"
          const outputDir = path.dirname(outputPath);
          if (outputDir !== outDir) {
            validateOutputPath(outputDir, { createDirectory: true });
          }

          try {
            await extractSingleObject(
              opts.input,
              entry.id,
              outputPath,
              opts.margin,
              opts.includeContext,
              false, // WHY: Don't output JSON per-item, will output summary at end
              opts.ignoreResolution,
              opts.quiet,
              opts.verbose
            );

            if (!opts.json) {
              printInfo(`  Extracted ${entry.id} -> ${outputPath}`);
            }

            results.push({ id: entry.id, output: outputPath, success: true });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!opts.json) {
              printError(`  Failed to extract ${entry.id}: ${message}`);
            }
            results.push({ id: entry.id, error: message, success: false });
          }
        }

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                mode: 'batchExtract',
                input: path.resolve(opts.input),
                batchIdsFile: path.resolve(opts.batchIds),
                outDir: path.resolve(outDir),
                margin: opts.margin,
                includeContext: opts.includeContext,
                results
              },
              null,
              2
            )
          );
        } else {
          const succeeded = results.filter((r) => r.success).length;
          const failed = results.filter((r) => !r.success).length;
          printInfo(`\nBatch extraction complete: ${succeeded} succeeded, ${failed} failed`);
        }
      } else {
        // Single extraction mode (existing behavior)
        // Validate required arguments for extract mode
        if (!opts.input) {
          throw new ValidationError('Input SVG file is required for extract mode');
        }
        if (!opts.extractId) {
          throw new ValidationError('Element ID is required for extract mode');
        }
        if (!opts.outSvg) {
          throw new ValidationError('Output SVG path is required for extract mode');
        }
        await extractSingleObject(
          opts.input,
          opts.extractId,
          opts.outSvg,
          opts.margin,
          opts.includeContext,
          opts.json,
          opts.ignoreResolution,
          opts.quiet,
          opts.verbose
        );
      }
    } else if (opts.mode === 'exportAll') {
      // Check if batch mode
      if (opts.batch) {
        // Batch mode: process multiple SVG files
        if (!opts.json) {
          printInfo('Batch mode: processing multiple SVG files...\n');
        }

        // Ensure --export-all is specified (batch requires it)
        if (!opts.outDir) {
          throw new ValidationError('Batch mode requires --export-all with output directory');
        }

        const svgFiles = readBatchFile(opts.batch);
        const results = [];

        // We've already validated opts.outDir is not null above
        const batchOutDir = /** @type {string} */ (opts.outDir);

        for (let i = 0; i < svgFiles.length; i++) {
          const svgFile = svgFiles[i];
          // Guard against undefined (shouldn't happen, but TypeScript wants to be sure)
          if (!svgFile) {
            continue;
          }

          try {
            // Generate timestamp for this SVG's output folder
            const now = new Date();
            const timestamp = [
              now.getFullYear(),
              String(now.getMonth() + 1).padStart(2, '0'),
              String(now.getDate()).padStart(2, '0'),
              '_',
              String(now.getHours()).padStart(2, '0'),
              String(now.getMinutes()).padStart(2, '0'),
              String(now.getSeconds()).padStart(2, '0')
            ].join('');

            // Get base name without extension
            const baseName = path.basename(svgFile, path.extname(svgFile));

            // Create output directory: <basename>_<timestamp>/
            const outputDir = path.join(batchOutDir, `${baseName}_${timestamp}`);

            if (!opts.json) {
              printInfo(`[${i + 1}/${svgFiles.length}] Processing: ${svgFile}`);
              printInfo(`    Output: ${outputDir}`);
            }

            // Export all objects for this SVG
            await exportAllObjects(
              svgFile,
              outputDir,
              opts.margin,
              opts.exportGroups,
              false, // Don't output JSON for individual files in batch mode
              opts.ignoreResolution,
              opts.quiet,
              opts.verbose
            );

            results.push({
              input: path.resolve(svgFile),
              outputDir: path.resolve(outputDir),
              success: true
            });

            if (!opts.json) {
              printInfo(`    ✓ Completed\n`);
            }
          } catch (err) {
            // Type guard: err is unknown
            const errMessage = err instanceof Error ? err.message : String(err);
            results.push({
              input: path.resolve(svgFile),
              error: errMessage,
              success: false
            });

            if (!opts.json) {
              printError(`    ✗ Failed: ${errMessage}\n`);
            }
          }
        }

        // Output batch summary
        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                mode: 'exportAll',
                batchMode: true,
                totalFiles: svgFiles.length,
                successful: results.filter((r) => r.success).length,
                failed: results.filter((r) => !r.success).length,
                results: results
              },
              null,
              2
            )
          );
        } else {
          const successful = results.filter((r) => r.success).length;
          const failed = results.filter((r) => !r.success).length;

          console.log('');
          if (failed === 0) {
            printInfo(
              `Batch complete! ${successful}/${svgFiles.length} files processed successfully.`
            );
          } else {
            printWarning(`Batch complete with errors: ${successful} succeeded, ${failed} failed.`);
          }
        }
      } else {
        // Single file mode
        // Validate required arguments for exportAll mode
        if (!opts.input) {
          throw new ValidationError('Input SVG file is required for export-all mode');
        }
        if (!opts.outDir) {
          throw new ValidationError('Output directory is required for export-all mode');
        }
        await exportAllObjects(
          opts.input,
          opts.outDir,
          opts.margin,
          opts.exportGroups,
          opts.json,
          opts.ignoreResolution,
          opts.quiet,
          opts.verbose
        );
      }
    } else if (opts.mode === 'rename') {
      // Validate required arguments for rename mode
      if (!opts.input) {
        throw new ValidationError('Input SVG file is required for rename mode');
      }
      if (!opts.renameJson) {
        throw new ValidationError('JSON mapping file is required for rename mode');
      }
      if (!opts.renameOut) {
        throw new ValidationError('Output SVG path is required for rename mode');
      }
      await renameIds(
        opts.input,
        opts.renameJson,
        opts.renameOut,
        opts.json,
        opts.ignoreResolution,
        opts.quiet,
        opts.verbose
      );
    } else {
      throw new SVGBBoxError(`Unknown mode: ${opts.mode}`);
    }
  } catch (error) {
    // Type guard: error is unknown
    const errorMessage = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? error.message : undefined;
    throw new SVGBBoxError(`Operation failed: ${errorMessage}`, cause);
  }
}

// SECURITY: Run with CLI error handling
runCLI(main);

module.exports = { main };
