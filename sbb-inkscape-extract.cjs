#!/usr/bin/env node
/**
 * sbb-inkscape-extract.cjs
 *
 * Extract a single object from an SVG file using Inkscape.
 * Requires Inkscape to be installed on your system.
 *
 * Part of the svg-bbox toolkit - Inkscape Tools Collection.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { getVersion } = require('./version.cjs');

const execFilePromise = promisify(execFile);

// SECURITY: Import security utilities
const {
  validateFilePath,
  validateOutputPath,
  SHELL_METACHARACTERS,
  VALID_ID_PATTERN,
  SVGBBoxError
} = require('./lib/security-utils.cjs');

const { runCLI, printSuccess, printInfo, printBanner } = require('./lib/cli-utils.cjs');

// ═══════════════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parsed command line arguments for sbb-inkscape-extract
 * @typedef {Object} ExtractArgs
 * @property {string|null} input - Input SVG file path
 * @property {string|null} objectId - ID of the object to extract
 * @property {string|null} output - Output SVG file path
 * @property {number|null} margin - Margin around extracted object in pixels
 * @property {string|null} batch - Batch file path for batch processing
 */

/**
 * Result of a successful extraction operation
 * @typedef {Object} ExtractionResult
 * @property {string} inputPath - Path to the input SVG file
 * @property {string} outputPath - Path to the output SVG file
 * @property {string} objectId - ID of the extracted object
 * @property {number} margin - Margin applied in pixels
 * @property {string} stdout - Inkscape stdout output
 * @property {string} stderr - Inkscape stderr output
 * @property {string} [error] - Error message if extraction failed
 */

/**
 * Entry from a batch file
 * @typedef {Object} BatchEntry
 * @property {string} input - Input SVG file path
 * @property {string} objectId - ID of the object to extract
 * @property {string} output - Output SVG file path
 */

// ═══════════════════════════════════════════════════════════════════════════
// HELP TEXT
// ═══════════════════════════════════════════════════════════════════════════

function printHelp() {
  console.log(`
╔════════════════════════════════════════════════════════════════════════════╗
║ sbb-inkscape-extract.cjs - SVG Object Extraction Tool               ║
╚════════════════════════════════════════════════════════════════════════════╝

DESCRIPTION:
  Extract a single object (by ID) from an SVG file using Inkscape.
  Exports only the specified object, optionally with a margin.

USAGE:
  node sbb-inkscape-extract.cjs input.svg --id <object-id> [options]
  node sbb-inkscape-extract.cjs --batch <file> [options]

OPTIONS:
  --id <id>                 ID of the object to extract (required in single mode)
  --output <file>           Output SVG file (default: <input>_<id>.svg)
  --margin <pixels>         Margin around extracted object in pixels
  --batch <file>            Process multiple extractions from batch file
  --help                    Show this help
  --version                 Show version

BATCH PROCESSING:
  --batch <file>            Process multiple extractions from file list
                            Format per line: input.svg object_id output.svg
                            (tab or space separated)
                            Lines starting with # are comments

BATCH FILE FORMAT:
  Each line contains: input.svg object_id output.svg
  - Tab-separated or space-separated
  - Lines starting with # are comments

  Example batch file (extractions.txt):
    # Extract icons from sprite sheet
    sprite.svg icon_home home.svg
    sprite.svg icon_settings settings.svg
    sprite.svg icon_user user.svg

EXAMPLES:

  # Extract object with ID "icon_home"
  node sbb-inkscape-extract.cjs sprite.svg --id icon_home

  # Extract with custom output name
  node sbb-inkscape-extract.cjs sprite.svg --id icon_home --output home.svg

  # Extract with 10px margin
  node sbb-inkscape-extract.cjs sprite.svg --id icon_home --margin 10

  # Batch extraction from file list
  node sbb-inkscape-extract.cjs --batch extractions.txt

  # Batch extraction with margin
  node sbb-inkscape-extract.cjs --batch extractions.txt --margin 10

OUTPUT:
  Creates a new SVG file containing only the specified object.

  Exit codes:
  • 0: Extraction successful
  • 1: Error occurred
  • 2: Invalid arguments
`);
}

/**
 * Print version information for the tool
 * @param {string} toolName - Name of the tool to display
 * @returns {void}
 */
function printVersion(toolName) {
  const version = getVersion();
  console.log(`${toolName} v${version} | svg-bbox toolkit`);
}

// ═══════════════════════════════════════════════════════════════════════════
// ARGUMENT PARSING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse command line arguments
 * @param {string[]} argv - Process argv array
 * @returns {ExtractArgs} Parsed arguments object
 */
function parseArgs(argv) {
  /** @type {ExtractArgs} */
  const args = {
    input: null,
    objectId: null,
    output: null,
    margin: null,
    batch: null
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    // WHY: TypeScript guard - argv[i] is guaranteed by loop bounds but TS can't infer this
    if (arg === undefined) continue;

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--version' || arg === '-v') {
      printVersion('sbb-inkscape-extract');
      process.exit(0);
    } else if (arg === '--batch' && i + 1 < argv.length) {
      args.batch = argv[++i] ?? null;
    } else if (arg === '--id' && i + 1 < argv.length) {
      args.objectId = argv[++i] ?? null;
    } else if (arg === '--output' && i + 1 < argv.length) {
      args.output = argv[++i] ?? null;
    } else if (arg === '--margin' && i + 1 < argv.length) {
      const marginArg = argv[++i] ?? '';
      const parsedMargin = parseInt(marginArg, 10);
      if (isNaN(parsedMargin) || parsedMargin < 0) {
        console.error('Error: --margin must be a non-negative number');
        process.exit(2);
      }
      args.margin = parsedMargin;
    } else if (!arg.startsWith('-')) {
      if (!args.input) {
        args.input = arg;
      } else {
        console.error(`Error: Unexpected argument: ${arg}`);
        process.exit(2);
      }
    } else {
      console.error(`Error: Unknown option: ${arg}`);
      process.exit(2);
    }
  }

  // Validate batch vs single mode
  if (args.batch && args.input) {
    console.error('Error: Cannot use both --batch and input file argument');
    process.exit(2);
  }

  // Validate required arguments
  if (!args.batch && !args.input) {
    console.error('Error: Input SVG file or --batch option required');
    console.error('Usage: node sbb-inkscape-extract.cjs input.svg --id <object-id> [options]');
    console.error('   or: node sbb-inkscape-extract.cjs --batch <file> [options]');
    process.exit(2);
  }

  // In single mode, --id is required
  // In batch mode, --id is NOT required (IDs come from batch file)
  if (!args.batch && !args.objectId) {
    console.error('Error: --id <object-id> is required in single file mode');
    console.error('Usage: node sbb-inkscape-extract.cjs input.svg --id <object-id> [options]');
    process.exit(2);
  }

  // Set default output file (only for single mode)
  if (args.input && !args.output) {
    const inputBase = path.basename(args.input, path.extname(args.input));
    args.output = `${inputBase}_${args.objectId}.svg`;
  }

  return args;
}

// ═══════════════════════════════════════════════════════════════════════════
// INKSCAPE EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract a single object from an SVG file using Inkscape
 * @param {string} inputPath - Path to the input SVG file
 * @param {string} objectId - ID of the object to extract
 * @param {string} outputPath - Path for the output SVG file
 * @param {number|null} margin - Margin around extracted object in pixels (optional)
 * @returns {Promise<ExtractionResult>} Result of the extraction operation
 * @throws {SVGBBoxError} If Inkscape is not installed or extraction fails
 */
async function extractObjectWithInkscape(inputPath, objectId, outputPath, margin) {
  // SECURITY: Validate input file path
  const safeInputPath = validateFilePath(inputPath, {
    requiredExtensions: ['.svg'],
    mustExist: true
  });

  // SECURITY: Validate output file path
  const safeOutputPath = validateOutputPath(outputPath, {
    requiredExtensions: ['.svg']
  });

  // SECURITY: Validate objectId format before passing to Inkscape to prevent command injection
  // IDs are passed via --export-id flag and could contain shell metacharacters
  // VALID_ID_PATTERN ensures IDs match XML spec: start with letter/underscore, followed by word chars, periods, hyphens
  if (!VALID_ID_PATTERN.test(objectId)) {
    throw new SVGBBoxError(
      `Invalid ID format: "${objectId}". IDs must start with a letter or underscore, followed by letters, digits, underscores, periods, or hyphens.`
    );
  }

  // Build Inkscape command arguments
  // Based on Inkscape CLI documentation and Python reference implementation
  // Non-commented parameters are the defaults that are ALWAYS used
  const inkscapeArgs = [
    // Export as SVG format
    '--export-type=svg',

    // Export as plain SVG (no Inkscape-specific extensions)
    '--export-plain-svg',

    // Export only the object with the specified ID (no other objects)
    '--export-id-only',

    // Overwrite existing output file without prompting
    '--export-overwrite',

    // Use 'no-convert-text-baseline-spacing' to do not automatically fix text baselines in legacy
    // (pre-0.92) files on opening. Inkscape 0.92 adopts the CSS standard definition for the
    // 'line-height' property, which differs from past versions. By default, the line height values
    // in files created prior to Inkscape 0.92 will be adjusted on loading to preserve the intended
    // text layout. This command line option will skip that adjustment.
    '--no-convert-text-baseline-spacing',

    // Specify the ID of the object to extract
    `--export-id=${objectId}`,

    // NOTE: --export-margin is added dynamically below when margin is specified

    // Output filename
    `--export-filename=${safeOutputPath}`,

    // Choose 'convert-dpi-method' method to rescale legacy (pre-0.92) files which render slightly
    // smaller due to the switch from 90 DPI to 96 DPI when interpreting lengths expressed in units
    // of pixels. Possible values are "none" (no change, document will render at 94% of its original
    // size), "scale-viewbox" (document will be rescaled globally, individual lengths will stay
    // untouched) and "scale-document" (each length will be re-scaled individually).
    '--convert-dpi-method=none',

    // Input SVG file
    safeInputPath
  ];

  // Add margin if specified (optional parameter)
  if (margin !== null && margin !== undefined) {
    // Find the index of --export-filename to insert margin before it
    // This is more robust than using a hardcoded index in case args are reordered
    const exportFilenameIndex = inkscapeArgs.findIndex((arg) =>
      arg.startsWith('--export-filename=')
    );
    if (exportFilenameIndex !== -1) {
      // Insert margin after export-id and before export-filename
      inkscapeArgs.splice(exportFilenameIndex, 0, `--export-margin=${margin}`);
    }
  }

  try {
    // Execute Inkscape with timeout
    const { stdout, stderr } = await execFilePromise('inkscape', inkscapeArgs, {
      timeout: 30000, // 30 second timeout
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer
    });

    // Check if output file was created
    if (!fs.existsSync(safeOutputPath)) {
      throw new SVGBBoxError(
        `Inkscape did not create output file. Object ID "${objectId}" may not exist in the SVG.`
      );
    }

    return {
      inputPath: safeInputPath,
      outputPath: safeOutputPath,
      objectId,
      margin: margin || 0,
      stdout: stdout.trim(),
      stderr: stderr.trim()
    };
  } catch (error) {
    // Type guard for ExecFileException from child_process
    const execError = /** @type {{ code?: string; killed?: boolean; message?: string }} */ (error);
    if (execError.code === 'ENOENT') {
      throw new SVGBBoxError(
        'Inkscape not found. Please install Inkscape and ensure it is in your PATH.\n' +
          'Download from: https://inkscape.org/release/'
      );
    } else if (execError.killed) {
      throw new SVGBBoxError('Inkscape process timed out (30s limit)');
    } else {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new SVGBBoxError(`Inkscape extraction failed: ${errorMessage}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BATCH PROCESSING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Read and parse batch file list.
 * Returns array of { input, objectId, output } objects.
 *
 * Batch file format:
 * - Each line: input.svg object_id output.svg
 * - Tab or space separated
 * - Lines starting with # are comments
 *
 * @param {string} batchFilePath - Path to the batch file
 * @returns {BatchEntry[]} Array of batch entries to process
 * @throws {SVGBBoxError} If batch file is invalid or empty
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
    throw new SVGBBoxError(`Batch file is empty: ${safeBatchPath}`);
  }

  // Parse each line into { input, objectId, output } objects
  const entries = lines.map((line, index) => {
    // Split by tab first (more reliable for paths with spaces), then by space
    let parts = line
      .split('\t')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    // If only one part after tab split, try space-separated
    // WHY: Handle space-separated format, but be careful with paths containing spaces
    // REGEX FIX: Match .svg file, then non-whitespace object ID, then .svg file
    // This works for paths with spaces if they're quoted or separated clearly
    if (parts.length === 1) {
      // Look for pattern: input.svg object_id output.svg (three parts)
      // Match: (anything ending in .svg) + (whitespace) + (non-whitespace ID) + (whitespace) + (anything ending in .svg)
      const svgMatch = line.match(/^(.+\.svg)\s+(\S+)\s+(.+\.svg)$/i);
      if (svgMatch && svgMatch[1] && svgMatch[2] && svgMatch[3]) {
        parts = [svgMatch[1].trim(), svgMatch[2].trim(), svgMatch[3].trim()];
      }
    }

    // SECURITY: Validate each path for shell metacharacters
    parts.forEach((part) => {
      if (SHELL_METACHARACTERS.test(part)) {
        throw new SVGBBoxError(
          `Invalid file path at line ${index + 1} in batch file: contains shell metacharacters`
        );
      }
    });

    if (parts.length < 3) {
      throw new SVGBBoxError(
        `Invalid format at line ${index + 1} in batch file.\n` +
          `Expected: input.svg object_id output.svg\n` +
          `Got: ${line}`
      );
    }

    // WHY: Type guard ensures parts[0], parts[1], parts[2] are defined strings (length check above guarantees this)
    const inputFile = parts[0];
    const objectId = parts[1];
    const outputFile = parts[2];

    // WHY: TypeScript requires explicit validation that array elements are defined strings
    if (!inputFile || !objectId || !outputFile) {
      throw new SVGBBoxError(
        `Invalid format at line ${index + 1} in batch file: missing required fields`
      );
    }

    return { input: inputFile, objectId, output: outputFile };
  });

  // WHY: Handle empty batch file entries after filtering
  // Empty files should fail early with a clear message
  if (entries.length === 0) {
    throw new SVGBBoxError(`No valid entries found in batch file: ${safeBatchPath}`);
  }

  return entries;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Main entry point for the extraction tool
 * @returns {Promise<void>}
 */
async function main() {
  const args = parseArgs(process.argv);

  // WHY: Display banner with tool name - this tool doesn't have quiet/json flags
  printBanner('sbb-inkscape-extract', { quiet: false, json: false });

  // BATCH MODE
  if (args.batch) {
    const entries = readBatchFile(args.batch);
    /** @type {ExtractionResult[]} */
    const results = [];

    printInfo(`Processing ${entries.length} extraction(s) in batch mode...\n`);

    for (let i = 0; i < entries.length; i++) {
      // WHY: TypeScript requires null guard for array element access
      const entry = entries[i];
      if (!entry) continue;
      const { input: inputFile, objectId, output: outputFile } = entry;

      try {
        // WHY: Validate input file exists before attempting extraction
        // Prevents cryptic Inkscape errors when file is missing
        if (!fs.existsSync(inputFile)) {
          throw new SVGBBoxError(`Input file not found: ${inputFile}`);
        }

        printInfo(`[${i + 1}/${entries.length}] Extracting "${objectId}" from ${inputFile}...`);

        const result = await extractObjectWithInkscape(
          inputFile,
          objectId,
          outputFile,
          args.margin
        );

        results.push(result);

        console.log(`  ✓ ${path.basename(result.outputPath)}`);
      } catch (err) {
        // Type guard for error handling
        const errorMessage = err instanceof Error ? err.message : String(err);
        /** @type {ExtractionResult} */
        const errorResult = {
          inputPath: inputFile,
          objectId,
          outputPath: outputFile,
          margin: 0,
          stdout: '',
          stderr: '',
          error: errorMessage
        };
        results.push(errorResult);

        console.error(`  ✗ Failed: ${inputFile}`);
        console.error(`    ${errorMessage}`);
      }
    }

    // Output batch summary
    console.log('');
    const successful = results.filter((r) => !r.error).length;
    const failed = results.filter((r) => r.error).length;

    if (failed === 0) {
      printSuccess(`Batch complete! ${successful}/${entries.length} extraction(s) successful.`);
    } else {
      printInfo(`Batch complete with errors: ${successful} succeeded, ${failed} failed.`);
    }

    return;
  }

  // SINGLE FILE MODE
  // WHY: TypeScript requires explicit null checks despite validation above
  // The parseArgs function validates these are non-null in single file mode
  if (!args.input || !args.objectId || !args.output) {
    throw new SVGBBoxError(
      'Input file, object ID, and output path are required in single file mode'
    );
  }

  console.log(`Extracting object "${args.objectId}" from ${args.input}...`);

  const result = await extractObjectWithInkscape(
    args.input,
    args.objectId,
    args.output,
    args.margin
  );

  printSuccess('✓ Object extracted successfully');
  console.log(`  Input:     ${result.inputPath}`);
  console.log(`  Object ID: ${result.objectId}`);
  console.log(`  Output:    ${result.outputPath}`);
  if (result.margin) {
    console.log(`  Margin:    ${result.margin}px`);
  }

  // Show Inkscape warnings if any
  if (result.stderr) {
    printInfo(`\nInkscape warnings:\n${result.stderr}`);
  }
}

// SECURITY: Run with CLI error handling
runCLI(main);

module.exports = { main, extractObjectWithInkscape };
