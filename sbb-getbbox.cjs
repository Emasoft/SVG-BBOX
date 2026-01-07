#!/usr/bin/env node

/**
 * sbb-getbbox.cjs - SECURE VERSION
 *
 * CLI utility to compute visual bounding boxes for SVG files and elements
 * using canvas-based rasterization technique (not getBBox()).
 *
 * SECURITY FIXES:
 * - Path traversal prevention
 * - Command injection protection
 * - Input validation and sanitization
 * - File size limits
 * - Proper error handling
 * - Timeout handling
 * - Resource cleanup
 */

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Visual bounding box with x, y, width, height coordinates.
 * @typedef {Object} BBox
 * @property {number} x - X coordinate of the bounding box origin
 * @property {number} y - Y coordinate of the bounding box origin
 * @property {number} width - Width of the bounding box
 * @property {number} height - Height of the bounding box
 */

/**
 * Bounding box result that may contain an error message.
 * @typedef {Object} BBoxResult
 * @property {number} [x] - X coordinate of the bounding box origin
 * @property {number} [y] - Y coordinate of the bounding box origin
 * @property {number} [width] - Width of the bounding box
 * @property {number} [height] - Height of the bounding box
 * @property {string} [error] - Error message if bbox computation failed
 */

/**
 * Grid information for sprite sheet layout.
 * @typedef {Object} SpriteGrid
 * @property {number} rows - Number of rows in the grid
 * @property {number} cols - Number of columns in the grid
 * @property {number[]} xPositions - X positions of columns
 * @property {number[]} yPositions - Y positions of rows
 */

/**
 * Size statistics with uniformity metrics.
 * @typedef {Object} SpriteStats
 * @property {number} count - Total number of sprites detected
 * @property {{width: number, height: number}} avgSize - Average sprite size
 * @property {{widthCV: string, heightCV: string, areaCV: string}} uniformity - Coefficient of variation metrics
 * @property {boolean} hasCommonPattern - Whether sprites follow common naming patterns
 * @property {boolean} isGridArranged - Whether sprites are arranged in a grid
 */

/**
 * Individual sprite information.
 * @typedef {Object} SpriteEntry
 * @property {string} id - Sprite element ID
 * @property {string} tag - SVG tag name of the sprite element
 */

/**
 * Sprite sheet detection result.
 * @typedef {Object} SpriteInfo
 * @property {boolean} isSprite - Whether the SVG is detected as a sprite sheet
 * @property {SpriteEntry[]} sprites - Array of detected sprites
 * @property {SpriteGrid|null} grid - Grid layout information if detected
 * @property {SpriteStats} [stats] - Statistics about detected sprites
 */

/**
 * Result of bbox computation for a file.
 * @typedef {Object} BBoxFileResult
 * @property {string} filename - Base name of the processed file
 * @property {string} path - Full path to the processed file
 * @property {Object<string, BBoxResult>} results - Map of element IDs to their bboxes
 * @property {SpriteInfo} [spriteInfo] - Sprite sheet info if detected
 */

/**
 * Entry from a list file specifying an SVG to process.
 * @typedef {Object} ListEntry
 * @property {string} path - Path to the SVG file
 * @property {string[]} ids - Element IDs to compute bboxes for
 * @property {boolean} ignoreViewBox - Whether to ignore viewBox clipping
 */

/**
 * Progress indicator interface.
 * @typedef {Object} ProgressIndicator
 * @property {function(string): void} update - Update progress message
 * @property {function(string): void} done - Complete progress with final message
 */

/**
 * Parsed CLI arguments.
 * @typedef {Object} ParsedArgs
 * @property {string[]} positional - Positional arguments
 * @property {Object<string, string|boolean|null>} flags - Flag values
 */

/**
 * CLI options for bbox computation.
 * @typedef {Object} CLIOptions
 * @property {boolean} ignoreViewBox - Whether to ignore viewBox clipping
 * @property {boolean} spriteMode - Whether to auto-detect sprite sheets
 * @property {string|null} jsonOutput - Path to save JSON output, or null for console
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { getVersion } = require('./version.cjs');
const { BROWSER_TIMEOUT_MS, FONT_TIMEOUT_MS } = require('./config/timeouts.cjs');

// Import security utilities
const {
  validateFilePath,
  readSVGFileSafe,
  sanitizeSVGContent,
  ValidationError,
  FileSystemError
} = require('./lib/security-utils.cjs');

// Import CLI utilities including shared JSON output function
// WHY: writeJSONOutput centralizes JSON output handling (DRY principle)
// DO NOT: Implement custom saveJSON - use writeJSONOutput instead
// NOTE: printSuccess removed - writeJSONOutput handles success feedback internally
const {
  runCLI,
  createArgParser,
  printError,
  printInfo,
  createProgress,
  writeJSONOutput
} = require('./lib/cli-utils.cjs');

// ============================================================================
// CONSTANTS
// ============================================================================

/** Puppeteer launch options */
const PUPPETEER_OPTIONS = {
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
  timeout: BROWSER_TIMEOUT_MS
};

// ============================================================================
// ARGUMENT PARSING (using new CLI utilities)
// ============================================================================

const argParser = createArgParser({
  name: 'sbb-getbbox',
  description: 'Compute visual bounding boxes for SVG files and elements',
  usage:
    'sbb-getbbox <svg-file> [object-ids...] [options]\n' +
    '       sbb-getbbox --dir <directory> [options]\n' +
    '       sbb-getbbox --list <txt-file> [options]',
  flags: [
    {
      name: 'ignore-vbox',
      description: 'Compute full drawing bbox, ignoring viewBox clipping',
      type: 'boolean'
    },
    {
      name: 'sprite',
      alias: 's',
      description: 'Auto-detect sprite sheets and process all sprites',
      type: 'boolean'
    },
    {
      name: 'dir',
      alias: 'd',
      description: 'Batch process all SVG files in directory',
      type: 'string'
    },
    {
      name: 'filter',
      alias: 'f',
      description: 'Filter directory files by regex pattern',
      type: 'string'
    },
    {
      name: 'list',
      alias: 'l',
      description: 'Process SVGs from list file',
      type: 'string'
    },
    {
      name: 'json',
      alias: 'j',
      description: 'Save results as JSON to specified file (use - for stdout)',
      type: 'string'
    }
  ],
  minPositional: 0,
  maxPositional: Infinity
});

// ============================================================================
// SVG ATTRIBUTE REPAIR
// ============================================================================

/**
 * Repair missing SVG attributes using visual bbox.
 * Uses safer string manipulation with proper escaping.
 *
 * @param {string} svgMarkup - SVG markup string
 * @param {BBox|null} bbox - Visual bbox {x, y, width, height}
 * @returns {string} Repaired SVG markup
 */
function repairSvgAttributes(svgMarkup, bbox) {
  // Parse SVG to extract root element
  const svgMatch = svgMarkup.match(/<svg([^>]*)>/);
  if (!svgMatch) {
    return svgMarkup;
  }

  // WHY: svgMatch[1] may be undefined if the regex didn't capture anything
  const attrs = svgMatch[1] || '';
  const hasViewBox = /viewBox\s*=/.test(attrs);
  const hasWidth = /\swidth\s*=/.test(attrs);
  const hasHeight = /\sheight\s*=/.test(attrs);
  const hasPreserveAspectRatio = /preserveAspectRatio\s*=/.test(attrs);

  if (hasViewBox && hasWidth && hasHeight && hasPreserveAspectRatio) {
    return svgMarkup; // All attributes present
  }

  // Build repaired attributes (properly escaped)
  let newAttrs = attrs;

  if (!hasViewBox && bbox) {
    // Ensure numeric values (prevent injection)
    const x = Number(bbox.x) || 0;
    const y = Number(bbox.y) || 0;
    const w = Number(bbox.width) || 0;
    const h = Number(bbox.height) || 0;
    newAttrs += ` viewBox="${x} ${y} ${w} ${h}"`;
  }

  if (!hasWidth && bbox) {
    const w = Number(bbox.width) || 0;
    newAttrs += ` width="${w}"`;
  }

  if (!hasHeight && bbox) {
    const h = Number(bbox.height) || 0;
    newAttrs += ` height="${h}"`;
  }

  if (!hasPreserveAspectRatio) {
    newAttrs += ' preserveAspectRatio="xMidYMid meet"';
  }

  return svgMarkup.replace(/<svg([^>]*)>/, `<svg${newAttrs}>`);
}

// ============================================================================
// SPRITE SHEET DETECTION & ANALYSIS
// ============================================================================

/**
 * Detect if SVG is likely a sprite sheet and extract sprite information.
 *
 * @param {import('puppeteer').Page} page - Puppeteer page with loaded SVG
 * @returns {Promise<SpriteInfo>} Sprite sheet detection result
 */
async function detectSpriteSheet(page) {
  const result = await page.evaluate(() => {
    /* eslint-disable no-undef */
    const rootSvg = document.querySelector('svg');
    if (!rootSvg) {
      return { isSprite: false, sprites: [], grid: null };
    }

    // Get all potential sprite elements (excluding defs, style, script, etc.)
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
      return { isSprite: false, sprites: [], grid: null };
    }

    // Collect sprite candidates with their visual properties
    const sprites = [];
    for (const child of children) {
      /** @type {string} */
      const id = child.id || `auto_${child.tagName}_${sprites.length}`;
      // Type guard: getBBox exists on SVGGraphicsElement
      /** @type {DOMRect | null} */
      let bbox = null;
      try {
        // Cast to any to access getBBox which exists on SVG elements
        bbox = /** @type {any} */ (child).getBBox ? /** @type {any} */ (child).getBBox() : null;
      } catch {
        bbox = null;
      }

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
      return { isSprite: false, sprites: [], grid: null };
    }

    // Analyze sprite characteristics
    const widths = sprites.map((s) => s.width);
    const heights = sprites.map((s) => s.height);
    const areas = sprites.map((s) => s.width * s.height);

    const avgWidth = widths.reduce((a, b) => a + b, 0) / widths.length;
    const avgHeight = heights.reduce((a, b) => a + b, 0) / heights.length;
    const avgArea = areas.reduce((a, b) => a + b, 0) / areas.length;

    // Calculate standard deviations
    const widthStdDev = Math.sqrt(
      widths.reduce((sum, w) => sum + Math.pow(w - avgWidth, 2), 0) / widths.length
    );
    const heightStdDev = Math.sqrt(
      heights.reduce((sum, h) => sum + Math.pow(h - avgHeight, 2), 0) / heights.length
    );
    const areaStdDev = Math.sqrt(
      areas.reduce((sum, a) => sum + Math.pow(a - avgArea, 2), 0) / areas.length
    );

    // Coefficient of variation (lower = more uniform)
    const widthCV = widthStdDev / avgWidth;
    const heightCV = heightStdDev / avgHeight;
    const areaCV = areaStdDev / avgArea;

    // Check for common ID patterns in sprite sheets
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

    // Detect grid arrangement
    const xPositions = [...new Set(sprites.map((s) => Math.round(s.x)))].sort((a, b) => a - b);
    const yPositions = [...new Set(sprites.map((s) => Math.round(s.y)))].sort((a, b) => a - b);

    const isGridArranged = xPositions.length >= 2 && yPositions.length >= 2;

    // Decision criteria for sprite sheet detection
    const isSpriteSheet =
      // Uniform sizes (CV < 0.3 means sizes are quite similar)
      (widthCV < 0.3 && heightCV < 0.3) ||
      areaCV < 0.3 ||
      // Common naming pattern
      hasCommonPattern ||
      // Grid arrangement
      isGridArranged;

    return {
      isSprite: isSpriteSheet,
      sprites: sprites.map((s) => ({ id: s.id, tag: s.tag })),
      grid: isGridArranged
        ? {
            rows: yPositions.length,
            cols: xPositions.length,
            xPositions,
            yPositions
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
    /* eslint-enable no-undef */
  });
  return result;
}

// ============================================================================
// BBOX COMPUTATION (with security enhancements)
// ============================================================================

/**
 * Compute bbox for SVG file and optional object IDs.
 * SECURE: Uses file validation, size limits, timeouts, and sanitization.
 *
 * @param {string} svgPath - Path to SVG file
 * @param {string[]} objectIds - Array of object IDs (empty = whole content)
 * @param {boolean} ignoreViewBox - Compute full drawing bbox
 * @param {boolean} spriteMode - Auto-detect and process as sprite sheet
 * @returns {Promise<BBoxFileResult>} Computation result with bboxes
 */
async function computeBBox(svgPath, objectIds = [], ignoreViewBox = false, spriteMode = false) {
  // SECURITY: Validate file path (prevents path traversal)
  const safePath = validateFilePath(svgPath, {
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
    // NOTE: CSP removed - it was blocking SvgVisualBBox.js functionality
    // For security in production, consider using a more permissive CSP or
    // injecting the library code inline instead of via addScriptTag()
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <!-- CONSISTENCY FIX 2026-01-06: No CSS styling - match sbb-fix-viewbox.cjs exactly -->
  <!-- Previously had padding and display:block which affected bbox calculations -->
</head>
<body>
${sanitizedSvg}
</body>
</html>
    `;

    // CONSISTENCY FIX 2026-01-06: Use 'networkidle0' like sbb-fix-viewbox.cjs
    // for consistent font/resource loading behavior
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

    // Detect sprite sheet if in sprite mode
    /** @type {SpriteInfo|null} */
    let spriteInfo = null;
    if (spriteMode && objectIds.length === 0) {
      spriteInfo = await detectSpriteSheet(page);

      if (spriteInfo.isSprite && spriteInfo.stats) {
        // Automatically use all detected sprites as object IDs
        objectIds = spriteInfo.sprites
          .map((s) => s.id)
          .filter((id) => id && !id.startsWith('auto_'));

        // If no named sprites, use auto-generated IDs
        if (objectIds.length === 0) {
          objectIds = spriteInfo.sprites.map((s) => s.id);
        }

        printInfo('Sprite sheet detected!');
        printInfo(`  Sprites: ${spriteInfo.stats.count}`);
        if (spriteInfo.grid) {
          printInfo(`  Grid: ${spriteInfo.grid.rows} rows × ${spriteInfo.grid.cols} cols`);
        }
        printInfo(
          `  Avg size: ${spriteInfo.stats.avgSize.width.toFixed(1)} × ${spriteInfo.stats.avgSize.height.toFixed(1)}`
        );
        printInfo(`  Computing bbox for ${objectIds.length} sprites...\n`);
      }
    }

    const mode = ignoreViewBox ? 'unclipped' : 'clipped';

    // Compute bboxes
    /** @type {Record<string, BBoxResult>} */
    const results = await page.evaluate(
      async (objectIds, mode) => {
        /* eslint-disable no-undef */
        const SvgVisualBBox = window.SvgVisualBBox;
        if (!SvgVisualBBox) {
          throw new Error('SvgVisualBBox library not loaded');
        }

        const rootSvg = document.querySelector('svg');
        if (!rootSvg) {
          throw new Error('No <svg> element found');
        }

        /** @type {Record<string, {x?: number, y?: number, width?: number, height?: number, error?: string}>} */
        const output = {};
        const options = { mode, coarseFactor: 3, fineFactor: 24, useLayoutScale: true };

        // IDEMPOTENCY FIX 2026-01-06: Conservative rounding for stable bbox values
        // WHY: Absorbs sub-pixel variations from text rendering differences
        // MATCHES: sbb-fix-viewbox.cjs rounding for consistent results
        // x,y: floor to 0.5 (expand left/top), width/height: ceil to 0.5 (expand right/bottom)
        // WHY 0.5: Rounding to 0.1 oscillated at boundaries; 0.5 buffer absorbs variations
        const floorHalf = (/** @type {number} */ v) => Math.floor(v * 2) / 2;
        const ceilHalf = (/** @type {number} */ v) => Math.ceil(v * 2) / 2;

        // If no object IDs specified, compute whole content bbox
        // CONSISTENCY FIX 2026-01-06: Use getSvgElementVisibleAndFullBBoxes().full
        // to match sbb-fix-viewbox algorithm. Previously used getSvgElementsUnionVisualBBox
        // which produced different results, causing 1-2% visual differences between tools.
        if (objectIds.length === 0) {
          const both = await SvgVisualBBox.getSvgElementVisibleAndFullBBoxes(rootSvg, options);
          if (!both.full) {
            output['WHOLE CONTENT'] = { error: 'No visible pixels' };
          } else {
            const bbox = both.full;
            output['WHOLE CONTENT'] = {
              x: floorHalf(bbox.x),
              y: floorHalf(bbox.y),
              width: ceilHalf(bbox.width),
              height: ceilHalf(bbox.height)
            };
          }
        } else {
          // Compute bbox for each object ID
          for (const id of objectIds) {
            const element = rootSvg.ownerDocument.getElementById(id);
            if (!element) {
              output[id] = { error: 'Element not found' };
              continue;
            }

            const bbox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(
              element,
              options
            );
            if (bbox) {
              output[id] = {
                x: floorHalf(bbox.x),
                y: floorHalf(bbox.y),
                width: ceilHalf(bbox.width),
                height: ceilHalf(bbox.height)
              };
            } else {
              output[id] = { error: 'No visible pixels' };
            }
          }
        }

        /* eslint-enable no-undef */
        return output;
      },
      objectIds,
      mode
    );

    /** @type {BBoxFileResult} */
    const result = {
      filename: path.basename(safePath),
      path: safePath,
      results,
      // WHY: spriteInfo is only included when sprite detection was performed
      ...(spriteInfo ? { spriteInfo } : {})
    };

    return result;
  } finally {
    // SECURITY: Ensure browser is always closed
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Force kill if close fails
        // WHY: Store process reference to avoid calling browser.process() twice
        const browserProcess = browser.process();
        if (browserProcess) {
          browserProcess.kill('SIGKILL');
        }
      }
    }
  }
}

// ============================================================================
// DIRECTORY PROCESSING (with security enhancements)
// ============================================================================

/**
 * Process all SVG files in a directory.
 * SECURE: Validates directory path and regex pattern.
 *
 * @param {string} dirPath - Directory path
 * @param {string|null} filterRegex - Regex pattern to filter filenames
 * @param {boolean} ignoreViewBox - Compute full drawing bbox
 * @returns {Promise<BBoxFileResult[]>} Array of file results with bboxes
 */
async function processDirectory(dirPath, filterRegex = null, ignoreViewBox = false) {
  // SECURITY: Validate directory path
  const safeDir = validateFilePath(dirPath, {
    mustExist: true
  });

  // Verify it's actually a directory
  if (!fs.statSync(safeDir).isDirectory()) {
    throw new ValidationError('Path is not a directory', { path: safeDir });
  }

  const files = fs.readdirSync(safeDir);
  const svgFiles = files.filter((f) => f.endsWith('.svg'));

  let filtered = svgFiles;
  if (filterRegex) {
    try {
      const regex = new RegExp(filterRegex);
      filtered = svgFiles.filter((f) => regex.test(f));
    } catch (err) {
      // WHY: err is of type unknown in catch blocks, use type guard
      const message = err instanceof Error ? err.message : String(err);
      throw new ValidationError(`Invalid regex pattern: ${message}`, { pattern: filterRegex });
    }
  }

  /** @type {BBoxFileResult[]} */
  const results = [];
  // WHY: Cast to ProgressIndicator since createProgress returns Object type
  const progress = /** @type {ProgressIndicator} */ (
    createProgress(`Processing ${filtered.length} files`)
  );

  for (let i = 0; i < filtered.length; i++) {
    const file = /** @type {string} */ (filtered[i]);
    const filePath = path.join(safeDir, file);

    progress.update(`${i + 1}/${filtered.length} - ${file}`);

    try {
      // WHY: Validate input file exists before attempting bbox computation
      // Directory listing might be stale or file could have been deleted
      if (!fs.existsSync(filePath)) {
        throw new ValidationError(`Input file not found: ${filePath}`);
      }

      const result = await computeBBox(filePath, [], ignoreViewBox);
      results.push(result);
    } catch (err) {
      // WHY: err is of type unknown in catch blocks, use type guard
      const message = err instanceof Error ? err.message : String(err);
      printError(`Failed to process ${file}: ${message}`);
      // WHY: results must be a Record<string, BBoxResult>, so wrap error in a special key
      results.push({
        filename: file,
        path: filePath,
        results: { 'WHOLE CONTENT': { error: message } }
      });
    }
  }

  progress.done(`Processed ${filtered.length} files`);
  return results;
}

// ============================================================================
// LIST FILE PROCESSING (with security enhancements)
// ============================================================================

/**
 * Parse list file and extract entries.
 * SECURE: Validates file path, handles errors gracefully.
 *
 * @param {string} listPath - Path to list file
 * @returns {ListEntry[]} Array of parsed entries
 */
function parseListFile(listPath) {
  // SECURITY: Validate list file path
  const safePath = validateFilePath(listPath, {
    mustExist: true
  });

  const content = fs.readFileSync(safePath, 'utf8');
  const lines = content.split('\n');
  /** @type {ListEntry[]} */
  const entries = [];

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    // WHY: line could be undefined if lineNum exceeds array bounds
    if (line === undefined) {
      continue;
    }
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const tokens = trimmed.split(/\s+/);
    if (tokens.length === 0) {
      continue;
    }

    const svgPath = tokens[0];
    // WHY: tokens[0] could be undefined if array is empty
    if (!svgPath) {
      continue;
    }

    // SECURITY: Basic validation of path (full validation happens during processing)
    if (svgPath.includes('\0')) {
      printError(`Line ${lineNum + 1}: Invalid path (null byte detected)`);
      continue;
    }

    const rest = tokens.slice(1);
    /** @type {ListEntry} */
    const entry = {
      path: svgPath,
      ids: /** @type {string[]} */ ([]),
      ignoreViewBox: false
    };

    // Parse remaining tokens
    for (const token of rest) {
      if (token === '--ignore-vbox' || token === '--ignore-viewbox') {
        entry.ignoreViewBox = true;
      } else if (!token.startsWith('-')) {
        entry.ids.push(token);
      }
    }

    entries.push(entry);
  }

  // WHY: Handle empty list files after filtering
  // Empty files should fail early with a clear message
  if (entries.length === 0) {
    throw new ValidationError(`No valid entries found in list file: ${listPath}`);
  }

  return entries;
}

/**
 * Process list file.
 * SECURE: Handles errors for each entry independently.
 *
 * @param {string} listPath - Path to list file
 * @returns {Promise<BBoxFileResult[]>} Array of file results with bboxes
 */
async function processList(listPath) {
  const entries = parseListFile(listPath);
  /** @type {BBoxFileResult[]} */
  const results = [];
  // WHY: Cast to ProgressIndicator since createProgress returns Object type
  const progress = /** @type {ProgressIndicator} */ (
    createProgress(`Processing ${entries.length} entries`)
  );

  for (let i = 0; i < entries.length; i++) {
    const entry = /** @type {ListEntry} */ (entries[i]);
    // WHY: entry could be undefined if index exceeds array bounds
    if (!entry) {
      continue;
    }
    progress.update(`${i + 1}/${entries.length} - ${path.basename(entry.path)}`);

    try {
      // WHY: Validate input file exists before attempting bbox computation
      // List file might reference non-existent or moved files
      if (!fs.existsSync(entry.path)) {
        throw new ValidationError(`Input file not found: ${entry.path}`);
      }

      const result = await computeBBox(entry.path, entry.ids, entry.ignoreViewBox);
      results.push(result);
    } catch (err) {
      // WHY: err is of type unknown in catch blocks, use type guard
      const message = err instanceof Error ? err.message : String(err);
      printError(`Failed to process ${entry.path}: ${message}`);
      // WHY: results must be a Record<string, BBoxResult>, so wrap error in a special key
      results.push({
        filename: path.basename(entry.path),
        path: entry.path,
        results: { 'WHOLE CONTENT': { error: message } }
      });
    }
  }

  progress.done(`Processed ${entries.length} entries`);
  return results;
}

// ============================================================================
// OUTPUT FORMATTING
// ============================================================================

/**
 * Format bbox for console output.
 *
 * @param {BBoxResult|null|undefined} bbox - Bbox result object with x, y, width, height or error
 * @returns {string}
 */
function formatBBox(bbox) {
  if (!bbox) {
    return 'null';
  }
  if (bbox.error) {
    return `ERROR: ${bbox.error}`;
  }
  // WHY: x, y, width, height are optional in BBoxResult, use nullish coalescing
  const x = bbox.x ?? 0;
  const y = bbox.y ?? 0;
  const width = bbox.width ?? 0;
  const height = bbox.height ?? 0;
  return `{x: ${x.toFixed(2)}, y: ${y.toFixed(2)}, width: ${width.toFixed(2)}, height: ${height.toFixed(2)}}`;
}

/**
 * Print results to console.
 *
 * @param {BBoxFileResult[]} allResults - Array of file results with bboxes
 */
function printResults(allResults) {
  for (const item of allResults) {
    console.log(`\nSVG: ${item.path}`);

    const keys = Object.keys(item.results);
    keys.forEach((key, idx) => {
      const isLast = idx === keys.length - 1;
      const prefix = isLast ? '└─' : '├─';
      console.log(`${prefix} ${key}: ${formatBBox(item.results[key])}`);
    });
  }
}

/**
 * Save results as JSON.
 *
 * DELEGATES TO: writeJSONOutput (lib/cli-utils.cjs)
 * WHY: Centralized JSON output handling ensures consistent behavior across all CLI tools
 * DO NOT: Implement custom JSON output logic here - use writeJSONOutput
 *
 * FEATURES (via writeJSONOutput):
 * - Supports `-` for stdout output (Unix convention)
 * - Validates output path (security)
 * - Handles EPIPE gracefully (broken pipe when piping to `head` etc.)
 * - Allows writing to cwd and tmpdir
 *
 * @param {BBoxFileResult[]} allResults - Array of file results with bboxes
 * @param {string} outputPath - Output JSON file path, or `-` for stdout
 */
function saveJSON(allResults, outputPath) {
  // Transform results array into path-keyed object
  // WHY: This format is more useful for programmatic consumption
  // Keys are file paths, values are bbox results
  /** @type {Record<string, Record<string, BBoxResult>>} */
  const json = {};
  for (const item of allResults) {
    json[item.path] = item.results;
  }

  // DELEGATE: Use shared writeJSONOutput for all JSON output handling
  // WHY: DRY principle - centralized logic for stdout, file validation, EPIPE handling
  // DO NOT: Add custom output logic here - all enhancements go in writeJSONOutput
  writeJSONOutput(json, outputPath);
}

// ============================================================================
// MAIN (with comprehensive error handling)
// ============================================================================

async function main() {
  // Display version
  printInfo(`sbb-getbbox v${getVersion()} | svg-bbox toolkit\n`);

  // Parse arguments
  const args = argParser(process.argv);

  // Determine mode based on flags and positional args
  let mode = null;
  if (args.flags.dir) {
    mode = 'dir';
  } else if (args.flags.list) {
    mode = 'list';
  } else if (args.positional.length > 0) {
    mode = 'file';
  } else {
    throw new ValidationError('No input specified. Use --help for usage information.');
  }

  const options = {
    ignoreViewBox: args.flags['ignore-vbox'] || false,
    spriteMode: args.flags.sprite || false,
    jsonOutput: args.flags.json || null
  };

  /** @type {BBoxFileResult[]} */
  let allResults = [];

  // Process based on mode
  if (mode === 'file') {
    const svgPath = args.positional[0];
    // WHY: Type guard - we know svgPath exists since mode === 'file' implies positional.length > 0
    if (!svgPath) {
      throw new ValidationError('No SVG file specified');
    }
    const objectIds = args.positional.slice(1);

    const result = await computeBBox(svgPath, objectIds, options.ignoreViewBox, options.spriteMode);
    allResults.push(result);
  } else if (mode === 'dir') {
    const filter = args.flags.filter || null;
    allResults = await processDirectory(args.flags.dir, filter, options.ignoreViewBox);
  } else if (mode === 'list') {
    allResults = await processList(args.flags.list);
  }

  // Output results
  if (options.jsonOutput) {
    saveJSON(allResults, options.jsonOutput);
  } else {
    printResults(allResults);
  }
}

// ============================================================================
// ENTRY POINT
// ============================================================================

if (require.main === module) {
  runCLI(main);
}

module.exports = { computeBBox, processDirectory, processList, repairSvgAttributes };
