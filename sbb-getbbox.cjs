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

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { getVersion, printVersion: _printVersion } = require('./version.cjs');

// Import security utilities
const {
  validateFilePath,
  validateOutputPath,
  readSVGFileSafe,
  readJSONFileSafe: _readJSONFileSafe,
  sanitizeSVGContent,
  ensureDirectoryExists: _ensureDirectoryExists,
  writeFileSafe,
  ValidationError,
  FileSystemError
} = require('./lib/security-utils.cjs');

const {
  runCLI,
  createArgParser,
  printSuccess,
  printError,
  printInfo,
  createProgress
} = require('./lib/cli-utils.cjs');

// ============================================================================
// CONSTANTS
// ============================================================================

/** Maximum time to wait for browser operations (30 seconds) */
const BROWSER_TIMEOUT_MS = 30000;

/** Maximum time to wait for fonts to load (8 seconds) */
const FONT_TIMEOUT_MS = 8000;

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
      description: 'Save results as JSON to specified file',
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
 * @param {Object} bbox - Visual bbox {x, y, width, height}
 * @returns {string} Repaired SVG markup
 */
function repairSvgAttributes(svgMarkup, bbox) {
  // Parse SVG to extract root element
  const svgMatch = svgMarkup.match(/<svg([^>]*)>/);
  if (!svgMatch) {
    return svgMarkup;
  }

  const attrs = svgMatch[1];
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
 * @param {Object} page - Puppeteer page with loaded SVG
 * @returns {Promise<Object>} {isSprite: boolean, sprites: Array, grid: Object}
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
 * @returns {Promise<Object>} {filename: string, results: {id: bbox}, spriteInfo: Object}
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
  <style>
    body { margin: 0; padding: 20px; }
    svg { display: block; }
  </style>
</head>
<body>
  ${sanitizedSvg}
</body>
</html>
    `;

    await page.setContent(html, {
      waitUntil: 'load',
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
    let spriteInfo = null;
    if (spriteMode && objectIds.length === 0) {
      spriteInfo = await detectSpriteSheet(page);

      if (spriteInfo.isSprite) {
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

        const output = {};
        const options = { mode, coarseFactor: 3, fineFactor: 24, useLayoutScale: true };

        // If no object IDs specified, compute whole content bbox
        if (objectIds.length === 0) {
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

          if (children.length === 0) {
            output['WHOLE CONTENT'] = { error: 'No renderable content found' };
          } else if (children.length === 1) {
            const bbox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(
              children[0],
              options
            );
            output['WHOLE CONTENT'] = bbox || { error: 'No visible pixels' };
          } else {
            const union = await SvgVisualBBox.getSvgElementsUnionVisualBBox(children, options);
            output['WHOLE CONTENT'] = union || { error: 'No visible pixels' };
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
            output[id] = bbox || { error: 'No visible pixels' };
          }
        }

        /* eslint-enable no-undef */
        return output;
      },
      objectIds,
      mode
    );

    const result = {
      filename: path.basename(safePath),
      path: safePath,
      results
    };

    if (spriteInfo) {
      result.spriteInfo = spriteInfo;
    }

    return result;
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
 * @returns {Promise<Object[]>} Array of {filename, path, results}
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
      throw new ValidationError(`Invalid regex pattern: ${err.message}`, { pattern: filterRegex });
    }
  }

  const results = [];
  const progress = createProgress(`Processing ${filtered.length} files`);

  for (let i = 0; i < filtered.length; i++) {
    const file = filtered[i];
    const filePath = path.join(safeDir, file);

    progress.update(`${i + 1}/${filtered.length} - ${file}`);

    try {
      const result = await computeBBox(filePath, [], ignoreViewBox);
      results.push(result);
    } catch (err) {
      printError(`Failed to process ${file}: ${err.message}`);
      results.push({
        filename: file,
        path: filePath,
        results: { error: err.message }
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
 * @returns {Array<{path: string, ids: string[], ignoreViewBox: boolean}>}
 */
function parseListFile(listPath) {
  // SECURITY: Validate list file path
  const safePath = validateFilePath(listPath, {
    mustExist: true
  });

  const content = fs.readFileSync(safePath, 'utf8');
  const lines = content.split('\n');
  const entries = [];

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
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

    // SECURITY: Basic validation of path (full validation happens during processing)
    if (svgPath.includes('\0')) {
      printError(`Line ${lineNum + 1}: Invalid path (null byte detected)`);
      continue;
    }

    const rest = tokens.slice(1);
    const entry = {
      path: svgPath,
      ids: [],
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

  return entries;
}

/**
 * Process list file.
 * SECURE: Handles errors for each entry independently.
 *
 * @param {string} listPath - Path to list file
 * @returns {Promise<Object[]>} Array of {filename, path, results}
 */
async function processList(listPath) {
  const entries = parseListFile(listPath);
  const results = [];
  const progress = createProgress(`Processing ${entries.length} entries`);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    progress.update(`${i + 1}/${entries.length} - ${path.basename(entry.path)}`);

    try {
      const result = await computeBBox(entry.path, entry.ids, entry.ignoreViewBox);
      results.push(result);
    } catch (err) {
      printError(`Failed to process ${entry.path}: ${err.message}`);
      results.push({
        filename: path.basename(entry.path),
        path: entry.path,
        results: { error: err.message }
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
 * @param {Object} bbox - {x, y, width, height}
 * @returns {string}
 */
function formatBBox(bbox) {
  if (!bbox) {
    return 'null';
  }
  if (bbox.error) {
    return `ERROR: ${bbox.error}`;
  }
  return `{x: ${bbox.x.toFixed(2)}, y: ${bbox.y.toFixed(2)}, width: ${bbox.width.toFixed(2)}, height: ${bbox.height.toFixed(2)}}`;
}

/**
 * Print results to console.
 *
 * @param {Object[]} allResults - Array of {filename, path, results}
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
 * SECURE: Validates output path, ensures directory exists.
 *
 * @param {Object[]} allResults - Array of {filename, path, results}
 * @param {string} outputPath - Output JSON file path
 */
function saveJSON(allResults, outputPath) {
  // SECURITY: Validate output path
  const safePath = validateOutputPath(outputPath, {
    requiredExtensions: ['.json']
  });

  const json = {};
  for (const item of allResults) {
    json[item.path] = item.results;
  }

  // SECURITY: Use writeFileSafe (creates directory if needed)
  writeFileSafe(safePath, JSON.stringify(json, null, 2), 'utf8');
  printSuccess(`JSON saved to: ${safePath}`);
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

  let allResults = [];

  // Process based on mode
  if (mode === 'file') {
    const svgPath = args.positional[0];
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
