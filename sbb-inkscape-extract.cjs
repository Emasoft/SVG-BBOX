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
  SVGBBoxError,
  ValidationError
} = require('./lib/security-utils.cjs');

const {
  runCLI,
  printSuccess,
  printError,
  printInfo
} = require('./lib/cli-utils.cjs');

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

OPTIONS:
  --id <id>                 ID of the object to extract (required)
  --output <file>           Output SVG file (default: <input>_<id>.svg)
  --margin <pixels>         Margin around extracted object in pixels
  --help                    Show this help
  --version                 Show version

EXAMPLES:

  # Extract object with ID "icon_home"
  node sbb-inkscape-extract.cjs sprite.svg --id icon_home

  # Extract with custom output name
  node sbb-inkscape-extract.cjs sprite.svg --id icon_home --output home.svg

  # Extract with 10px margin
  node sbb-inkscape-extract.cjs sprite.svg --id icon_home --margin 10

OUTPUT:
  Creates a new SVG file containing only the specified object.

  Exit codes:
  • 0: Extraction successful
  • 1: Error occurred
  • 2: Invalid arguments
`);
}

function printVersion(toolName) {
  const version = getVersion();
  console.log(`${toolName} v${version} | svg-bbox toolkit`);
}

// ═══════════════════════════════════════════════════════════════════════════
// ARGUMENT PARSING
// ═══════════════════════════════════════════════════════════════════════════

function parseArgs(argv) {
  const args = {
    input: null,
    objectId: null,
    output: null,
    margin: null
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--version' || arg === '-v') {
      printVersion('sbb-inkscape-extract');
      process.exit(0);
    } else if (arg === '--id' && i + 1 < argv.length) {
      args.objectId = argv[++i];
    } else if (arg === '--output' && i + 1 < argv.length) {
      args.output = argv[++i];
    } else if (arg === '--margin' && i + 1 < argv.length) {
      args.margin = parseInt(argv[++i], 10);
      if (isNaN(args.margin) || args.margin < 0) {
        console.error('Error: --margin must be a non-negative number');
        process.exit(2);
      }
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

  // Validate required arguments
  if (!args.input) {
    console.error('Error: Input SVG file required');
    console.error('Usage: node sbb-inkscape-extract.cjs input.svg --id <object-id> [options]');
    process.exit(2);
  }

  if (!args.objectId) {
    console.error('Error: --id <object-id> is required');
    console.error('Usage: node sbb-inkscape-extract.cjs input.svg --id <object-id> [options]');
    process.exit(2);
  }

  // Set default output file
  if (!args.output) {
    const inputBase = path.basename(args.input, path.extname(args.input));
    args.output = `${inputBase}_${args.objectId}.svg`;
  }

  return args;
}

// ═══════════════════════════════════════════════════════════════════════════
// INKSCAPE EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════

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

    // ## Margin parameter - uncomment when needed
    // `--export-margin=${MARGIN}`,

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
    // Insert margin after export-id and before export-filename
    inkscapeArgs.splice(6, 0, `--export-margin=${margin}`);
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
    if (error.code === 'ENOENT') {
      throw new SVGBBoxError(
        'Inkscape not found. Please install Inkscape and ensure it is in your PATH.\n' +
        'Download from: https://inkscape.org/release/'
      );
    } else if (error.killed) {
      throw new SVGBBoxError('Inkscape process timed out (30s limit)');
    } else {
      throw new SVGBBoxError(`Inkscape extraction failed: ${error.message}`, error);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const args = parseArgs(process.argv);

  printInfo(`sbb-inkscape-extract v${getVersion()} | svg-bbox toolkit\n`);

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
