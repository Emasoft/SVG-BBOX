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
 *
 * OUTPUT FORMAT CONTRACT - DO NOT CHANGE:
 *   This tool's output format is a design requirement. Other tools in the svg-bbox
 *   toolkit depend on this tool as a subprocess and rely on the output being a valid
 *   SVG file with properly set viewBox, width, and height attributes.
 *
 *   Dependencies:
 *   - sbb-compare.cjs calls this tool via subprocess to regenerate missing viewBox
 *     before performing aspect ratio comparisons. It expects the output file to be
 *     a valid SVG with viewBox/width/height attributes.
 *
 *   Any changes to the output format would require updating dependent tools.
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
  SHELL_METACHARACTERS,
  SVGBBoxError: _SVGBBoxError,
  ValidationError: _ValidationError,
  FileSystemError
} = require('./lib/security-utils.cjs');

const {
  runCLI,
  printSuccess,
  printError,
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
  node sbb-fix-viewbox.cjs input.svg [output.svg] [options]
  node sbb-fix-viewbox.cjs --batch files.txt [options]

ARGUMENTS:
  input.svg           Input SVG file to fix
  output.svg          Output file path (default: input_fixed.svg)

OPTIONS:
  --batch <file.txt>  Process multiple SVG files listed in text file
                      Supports two formats per line:
                      - Input only: input.svg (output auto-generated)
                      - Input/output pair: input.svg<TAB>output.svg
                      Lines starting with # are comments
  --force             Force regeneration of viewBox and dimensions (ignore existing)
  --overwrite         Overwrite input file (USE WITH CAUTION - loses original viewBox!)
  --auto-open         Automatically open fixed SVG in Chrome/Chromium
                      (only applies to single file mode)
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

BATCH FILE FORMAT:
  Each line can be:
  - Input file only:     input.svg
    (Output: input_fixed.svg in same directory)
  - Input/output pair:   input.svg<TAB>output.svg
    (Tab-separated or space-separated if both end in .svg)

  Example batch file (files.txt):
    # Comment line - ignored
    simple.svg
    drawing.svg    drawing_repaired.svg
    /path/to/input.svg    /other/path/output_fixed.svg

EXAMPLES:
  # Fix SVG with default output name
  node sbb-fix-viewbox.cjs broken.svg
  → Creates: broken_fixed.svg

  # Fix with custom output path
  node sbb-fix-viewbox.cjs broken.svg repaired.svg

  # Fix and automatically open in browser
  node sbb-fix-viewbox.cjs broken.svg --auto-open

  # Batch processing with explicit output paths
  node sbb-fix-viewbox.cjs --batch files.txt

  # Batch processing with force regeneration
  node sbb-fix-viewbox.cjs --batch files.txt --force

USE CASES:
  • SVG exports from design tools missing viewBox
  • Dynamically generated SVGs without proper dimensions
  • SVGs that appear blank due to missing/incorrect viewBox
  • Preparing SVGs for responsive web use

`);
}

/**
 * Parse command-line arguments.
 * @param {string[]} argv - The process.argv array
 * @returns {{ input: string | null, output: string | null, autoOpen: boolean, force: boolean, overwrite: boolean, batch: string | null }}
 */
function parseArgs(argv) {
  const args = argv.slice(2);

  // Check for --help
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  const positional = [];
  let autoOpen = false;
  let force = false;
  let overwrite = false;
  let batch = null;

  for (let i = 0; i < args.length; i++) {
    // WHY: TypeScript doesn't know args[i] is safe within bounds of for loop
    const arg = args[i];
    if (!arg) continue; // Type guard for TypeScript

    if (arg === '--auto-open') {
      autoOpen = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--overwrite') {
      overwrite = true;
    } else if (arg === '--batch' && i + 1 < args.length) {
      // WHY: args[++i] is string | undefined, convert to string | null for return type consistency
      batch = args[++i] ?? null;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--version' || arg === '-v') {
      printVersion('sbb-fix-viewbox');
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    } else {
      throw new _ValidationError(`Unknown option: ${arg}`);
    }
  }

  // Validate batch vs single mode
  if (batch && positional.length > 0) {
    throw new _ValidationError('Cannot use both --batch and input file argument');
  }

  // Validate required arguments
  if (!batch && positional.length < 1) {
    printHelp();
    process.exit(1);
  }

  const input = positional[0] || null;
  // SECURITY: Default to _fixed.svg suffix to preserve original
  // Only overwrite if explicitly requested with --overwrite flag
  let output = null;
  if (input) {
    if (overwrite) {
      output = input;
    } else if (positional[1] !== undefined) {
      // WHY: positional[1] is string | undefined, convert to string | null for consistency
      output = positional[1];
    } else {
      output = input.replace(/\.svg$/i, '') + '_fixed.svg';
    }
  }

  return { input, output, autoOpen, force, overwrite, batch };
}

/**
 * Read and parse batch file list.
 * Returns array of { input, output } objects.
 *
 * Batch file format supports two formats:
 * 1. Input only (output auto-generated): input.svg
 * 2. Input/output pair (tab or space separated): input.svg output.svg
 *
 * Lines starting with # are comments and are ignored.
 * @param {string} batchFilePath - Path to the batch file
 * @returns {Array<{ input: string, output: string }>}
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
    throw new _ValidationError(`Batch file is empty: ${safeBatchPath}`);
  }

  // Parse each line into { input, output } pairs
  const filePairs = lines.map((line, index) => {
    // Split by tab first (more reliable for paths with spaces), then by space
    // Try tab-separated first
    let parts = line
      .split('\t')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    // If only one part after tab split, try space-separated
    // WHY: Handle space-separated format for input.svg output.svg pairs
    // REGEX FIX: Improved to handle paths with spaces better
    // Be careful: paths might contain spaces, so only split on multiple spaces
    // or when it's clear there are two .svg files
    if (parts.length === 1) {
      // Look for pattern: something.svg something.svg (two SVG files)
      // Match: (anything ending in .svg) + (whitespace) + (anything ending in .svg)
      const svgMatch = line.match(/^(.+\.svg)\s+(.+\.svg)$/i);
      // WHY: svgMatch[1] and svgMatch[2] are guaranteed to exist when svgMatch is non-null
      // because the regex has exactly 2 capturing groups, but TypeScript doesn't know that
      if (svgMatch && svgMatch[1] && svgMatch[2]) {
        parts = [svgMatch[1].trim(), svgMatch[2].trim()];
      }
    }

    // SECURITY: Validate each path for shell metacharacters
    parts.forEach((part) => {
      if (SHELL_METACHARACTERS.test(part)) {
        throw new _ValidationError(
          `Invalid file path at line ${index + 1} in batch file: contains shell metacharacters`
        );
      }
    });

    if (parts.length === 0) {
      throw new _ValidationError(`Empty line at line ${index + 1} in batch file`);
    }

    // WHY: After parts.length check, parts[0] is guaranteed to exist, but TypeScript
    // doesn't infer this from the length check. Cast to string for type safety.
    const inputFile = /** @type {string} */ (parts[0]);

    // If output is specified, use it; otherwise auto-generate
    /** @type {string} */
    let outputFile;
    if (parts.length >= 2) {
      // WHY: After parts.length >= 2 check, parts[1] is guaranteed to exist, but TypeScript
      // doesn't infer this from the length check. Cast to string for type safety.
      outputFile = /** @type {string} */ (parts[1]);
    } else {
      // Auto-generate output: <input>_fixed.svg in same directory
      // WHY: Check for collisions when auto-generating output filenames
      // Prevents accidental overwrites in batch processing
      const baseName = path.basename(inputFile, path.extname(inputFile));
      const dirName = path.dirname(inputFile);
      let candidate = path.join(dirName, `${baseName}_fixed.svg`);

      // Check for naming conflicts and add numeric suffix if needed
      let counter = 1;
      while (fs.existsSync(candidate)) {
        candidate = path.join(dirName, `${baseName}_fixed_${counter}.svg`);
        counter++;
      }
      outputFile = candidate;
    }

    return { input: inputFile, output: outputFile };
  });

  // WHY: Handle empty batch file entries after filtering
  // Empty files should fail early with a clear message
  if (filePairs.length === 0) {
    throw new _ValidationError(`No valid entries found in batch file: ${safeBatchPath}`);
  }

  return filePairs;
}

// SECURITY: Secure Puppeteer options
const PUPPETEER_OPTIONS = {
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
};

/**
 * Fix an SVG file by computing and setting viewBox, width, and height attributes.
 * @param {string} inputPath - Path to the input SVG file
 * @param {string} outputPath - Path where the fixed SVG will be saved
 * @param {boolean} [autoOpen=false] - Whether to auto-open the fixed SVG in Chrome
 * @param {boolean} [force=false] - Whether to force regeneration of all attributes
 * @returns {Promise<void>}
 */
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
            // WHY: result.error is string | null, provide fallback for null case
            printWarning(result.error ?? 'Failed to open in Chrome');
            printInfo(`Please open manually in Chrome/Chromium: ${absolutePath}`);
          }
        })
        .catch((err) => {
          // WHY: err is of type 'unknown' in catch blocks - must use type guard
          const errorMessage = err instanceof Error ? err.message : String(err);
          printWarning(`Failed to auto-open: ${errorMessage}`);
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
        // WHY: browser.process() can return null if the browser has already exited
        const browserProcess = browser.process();
        if (browserProcess) {
          browserProcess.kill('SIGKILL');
        }
      }
    }
  }
}

// -------- entry point --------

async function main() {
  // Display version
  printInfo(`sbb-fix-viewbox v${getVersion()} | svg-bbox toolkit\n`);

  const { input, output, autoOpen, force, overwrite, batch } = parseArgs(process.argv);

  // SECURITY: Warn when overwriting original file
  if (overwrite && !batch) {
    printWarning('⚠️  --overwrite flag detected: Original viewBox information will be lost!');
    printWarning('   Original file will be overwritten. Press Ctrl+C to cancel...');
    // Give user 2 seconds to cancel
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  // BATCH MODE
  if (batch) {
    const filePairs = readBatchFile(batch);
    const results = [];

    printInfo(`Processing ${filePairs.length} file(s) in batch mode...\n`);

    for (let i = 0; i < filePairs.length; i++) {
      // WHY: TypeScript doesn't know filePairs[i] is safe within bounds of for loop
      const filePair = filePairs[i];
      if (!filePair) continue; // Type guard for TypeScript
      const { input: inputFile, output: outputFile } = filePair;

      try {
        // WHY: Validate input file exists before attempting fix
        // Prevents cryptic Puppeteer errors when file is missing
        if (!fs.existsSync(inputFile)) {
          throw new _ValidationError(`Input file not found: ${inputFile}`);
        }

        printInfo(`[${i + 1}/${filePairs.length}] Fixing: ${inputFile}`);
        printInfo(`    Target: ${outputFile}`);

        await fixSvgFile(inputFile, outputFile, false, force);

        results.push({
          input: inputFile,
          output: outputFile,
          success: true
        });

        console.log(`  ✓ ${path.basename(outputFile)}`);
      } catch (err) {
        // WHY: err is of type 'unknown' in catch blocks - must use type guard
        const errorMessage = err instanceof Error ? err.message : String(err);
        results.push({
          input: inputFile,
          output: outputFile,
          success: false,
          error: errorMessage
        });

        printError(`  ✗ Failed: ${inputFile}`);
        printError(`    ${errorMessage}`);
      }
    }

    // Print summary
    console.log('');
    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    if (failed === 0) {
      printSuccess(`Batch complete! ${successful}/${filePairs.length} files fixed successfully.`);
    } else {
      printWarning(`Batch complete with errors: ${successful} succeeded, ${failed} failed.`);
    }

    return;
  }

  // SINGLE FILE MODE
  // WHY: TypeScript doesn't know input/output are guaranteed non-null in single file mode
  // (parseArgs validates that either batch is set OR positional[0] exists)
  if (!input || !output) {
    throw new Error('Internal error: input and output should be set in single file mode');
  }
  await fixSvgFile(input, output, autoOpen, force);
}

runCLI(main);
