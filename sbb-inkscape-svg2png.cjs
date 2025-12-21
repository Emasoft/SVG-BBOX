#!/usr/bin/env node
/**
 * sbb-inkscape-svg2png.cjs
 *
 * Export SVG files to PNG format using Inkscape with comprehensive control
 * over all export parameters including color modes, compression, antialiasing,
 * background, and area settings.
 *
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
  SVGBBoxError,
  ValidationError
} = require('./lib/security-utils.cjs');

const { runCLI, printSuccess, printError, printInfo } = require('./lib/cli-utils.cjs');

// ═══════════════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} ParsedArgs
 * @property {string | null} input - Input SVG file path
 * @property {string | null} output - Output PNG file path
 * @property {number | null} width - Export width in pixels
 * @property {number | null} height - Export height in pixels
 * @property {number | null} dpi - Export DPI
 * @property {number | null} margin - Margin around export area
 * @property {boolean} areaDrawing - Export bounding box of all objects
 * @property {boolean} areaPage - Export full SVG page/viewBox area
 * @property {boolean} areaSnap - Snap export area to nearest integer px
 * @property {string | null} objectId - Export specific object by ID
 * @property {string | null} colorMode - Bit depth and color type
 * @property {number | null} compression - PNG compression level (0-9)
 * @property {number | null} antialias - Antialiasing level (0-3)
 * @property {string | null} background - Background color
 * @property {number | null} backgroundOpacity - Background opacity (0-255)
 * @property {string} convertDpiMethod - Method for legacy files
 * @property {string | null} batch - Batch file path
 */

/**
 * @typedef {Object} ExportOptions
 * @property {number | null} [width] - Export width in pixels
 * @property {number | null} [height] - Export height in pixels
 * @property {number | null} [dpi] - Export DPI
 * @property {number | null} [margin] - Margin around export area
 * @property {boolean} [areaDrawing] - Export bounding box of all objects
 * @property {boolean} [areaPage] - Export full SVG page/viewBox area
 * @property {boolean} [areaSnap] - Snap export area to nearest integer px
 * @property {string | null} [objectId] - Export specific object by ID
 * @property {string | null} [colorMode] - Bit depth and color type
 * @property {number | null} [compression] - PNG compression level (0-9)
 * @property {number | null} [antialias] - Antialiasing level (0-3)
 * @property {string | null} [background] - Background color
 * @property {number | null} [backgroundOpacity] - Background opacity (0-255)
 * @property {string} [convertDpiMethod] - Method for legacy files
 */

/**
 * @typedef {Object} ExportResult
 * @property {string} inputPath - Input file path
 * @property {string} outputPath - Output file path
 * @property {number} fileSize - Output file size in bytes
 * @property {number | null} width - Export width
 * @property {number | null} height - Export height
 * @property {number | null} dpi - Export DPI
 * @property {number | null} margin - Margin
 * @property {boolean} areaDrawing - Area drawing mode
 * @property {boolean} areaPage - Area page mode
 * @property {boolean} areaSnap - Area snap mode
 * @property {string | null} objectId - Object ID
 * @property {string | null} colorMode - Color mode
 * @property {number | null} compression - Compression level
 * @property {number | null} antialias - Antialias level
 * @property {string | null} background - Background color
 * @property {number | null} backgroundOpacity - Background opacity
 * @property {string} convertDpiMethod - DPI conversion method
 * @property {string} stdout - Inkscape stdout
 * @property {string} stderr - Inkscape stderr
 */

/**
 * @typedef {Object} BatchFilePair
 * @property {string} input - Input SVG file path
 * @property {string} output - Output PNG file path
 */

/**
 * @typedef {Object} BatchResult
 * @property {boolean} success - Whether export succeeded
 * @property {string} input - Input file path
 * @property {string} [output] - Output file path (on success)
 * @property {number} [fileSize] - File size in bytes (on success)
 * @property {string} [error] - Error message (on failure)
 */

// ═══════════════════════════════════════════════════════════════════════════
// HELP TEXT
// ═══════════════════════════════════════════════════════════════════════════

function printHelp() {
  console.log(`
╔════════════════════════════════════════════════════════════════════════════╗
║ sbb-inkscape-svg2png.cjs - Advanced SVG to PNG Export Tool          ║
╚════════════════════════════════════════════════════════════════════════════╝

DESCRIPTION:
  Export SVG files to PNG format using Inkscape with comprehensive control
  over all export parameters including dimensions, DPI, color modes,
  compression, antialiasing, background, and export areas.

USAGE:
  node sbb-inkscape-svg2png.cjs input.svg [options]
  node sbb-inkscape-svg2png.cjs --batch <file> [options]

DIMENSION & RESOLUTION OPTIONS:
  --output <file>           Output PNG file (default: <input>.png)
  --width <pixels>          Export width in pixels
  --height <pixels>         Export height in pixels
  --dpi <dpi>               Export DPI (default: 96)
                            96 DPI = 1 SVG user unit (px) = 1 bitmap pixel
  --margin <pixels>         Margin around export area in pixels

EXPORT AREA OPTIONS:
  --area-drawing            Export bounding box of all objects (default)
  --area-page               Export full SVG page/viewBox area
  --area-snap               Snap export area outwards to nearest integer px
                            (preserves pixel alignment for pixel-snapped graphics)
  --id <object-id>          Export specific object by ID (with --area-drawing)

COLOR & QUALITY OPTIONS:
  --color-mode <mode>       Bit depth and color type:
                            Gray_1, Gray_2, Gray_4, Gray_8, Gray_16
                            RGB_8, RGB_16
                            GrayAlpha_8, GrayAlpha_16
                            RGBA_8, RGBA_16 (default)
  --compression <0-9>       PNG compression level (default: 6)
                            0=no compression, 9=maximum compression
  --antialias <0-3>         Antialiasing level (default: 2)
                            0=none, 3=maximum

BACKGROUND OPTIONS:
  --background <color>      Background color (SVG color string)
                            Examples: "#ff007f", "rgb(255,0,128)", "white"
  --background-opacity <n>  Background opacity: 0.0-1.0 or 1-255
                            (default: 255 = fully opaque if --background set)

LEGACY FILE HANDLING:
  --convert-dpi <method>    Method for legacy (pre-0.92) files (default: none)
                            none          - No change (renders at 94% size)
                            scale-viewbox - Rescale globally
                            scale-document - Rescale each length individually

BATCH PROCESSING:
  --batch <file>            Batch export mode using file list
                            Supports two formats per line:
                            - Input only: input.svg (output auto-generated)
                            - Input/output pair: input.svg<TAB>output.png
                            Lines starting with # are comments
                            All export options apply to each file

OTHER OPTIONS:
  --help                    Show this help
  --version                 Show version

EXAMPLES:

  # Basic PNG export (default: area-drawing, 96 DPI)
  node sbb-inkscape-svg2png.cjs icon.svg

  # Export with specific dimensions
  node sbb-inkscape-svg2png.cjs icon.svg --width 512 --height 512

  # Export at high DPI with margin
  node sbb-inkscape-svg2png.cjs icon.svg --dpi 300 --margin 10

  # Export specific object by ID
  node sbb-inkscape-svg2png.cjs sprite.svg --id icon_home --output home.png

  # Export full page area with white background
  node sbb-inkscape-svg2png.cjs document.svg --area-page \\
    --background white --background-opacity 1.0

  # High-quality export with maximum compression
  node sbb-inkscape-svg2png.cjs logo.svg --width 1024 --height 1024 \\
    --antialias 3 --compression 9

  # Export to grayscale 8-bit PNG
  node sbb-inkscape-svg2png.cjs drawing.svg --color-mode Gray_8

  # Pixel-perfect export with snap
  node sbb-inkscape-svg2png.cjs pixel-art.svg --area-snap --dpi 96

  # Batch export with shared settings
  node sbb-inkscape-svg2png.cjs --batch icons.txt \\
    --width 256 --height 256 --compression 9

OUTPUT:
  Creates PNG file(s) from SVG input with specified parameters.

  Exit codes:
  • 0: Export successful
  • 1: Error occurred
  • 2: Invalid arguments

NOTES:
  - By default, exported area is the bounding box of all objects (--area-drawing)
  - Default DPI of 96 means 1 SVG user unit = 1 bitmap pixel
  - --area-snap is useful for preserving pixel alignment in pixel art
  - Legacy file handling only affects pre-Inkscape 0.92 files
  - Text baseline spacing is never converted (--no-convert-text-baseline-spacing)
`);
}

/**
 * Print version information.
 * @param {string} toolName - The name of the tool
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
 * Parse command line arguments.
 * @param {string[]} argv - Command line arguments array
 * @returns {ParsedArgs} Parsed arguments object
 */
function parseArgs(argv) {
  /** @type {ParsedArgs} */
  const args = {
    input: null,
    output: null,
    // Dimensions
    width: null,
    height: null,
    dpi: null,
    margin: null,
    // Export area
    areaDrawing: true, // Default
    areaPage: false,
    areaSnap: false,
    objectId: null,
    // Color & Quality
    colorMode: null,
    compression: null,
    antialias: null,
    // Background
    background: null,
    backgroundOpacity: null,
    // Legacy handling
    convertDpiMethod: 'none',
    // Batch
    batch: null
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    // WHY: Helper to safely get next argument value with type assertion
    // After bounds check, the value is guaranteed to exist
    const getNextArg = () => /** @type {string} */ (argv[++i]);

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--version' || arg === '-v') {
      printVersion('sbb-inkscape-svg2png');
      process.exit(0);
    } else if (arg === '--output' && i + 1 < argv.length) {
      args.output = getNextArg();
    } else if (arg === '--width' && i + 1 < argv.length) {
      args.width = parseInt(getNextArg(), 10);
      if (isNaN(args.width) || args.width <= 0) {
        console.error('Error: --width must be a positive number');
        process.exit(2);
      }
    } else if (arg === '--height' && i + 1 < argv.length) {
      args.height = parseInt(getNextArg(), 10);
      if (isNaN(args.height) || args.height <= 0) {
        console.error('Error: --height must be a positive number');
        process.exit(2);
      }
    } else if (arg === '--dpi' && i + 1 < argv.length) {
      args.dpi = parseInt(getNextArg(), 10);
      if (isNaN(args.dpi) || args.dpi <= 0) {
        console.error('Error: --dpi must be a positive number');
        process.exit(2);
      }
    } else if (arg === '--margin' && i + 1 < argv.length) {
      args.margin = parseFloat(getNextArg());
      if (isNaN(args.margin) || args.margin < 0) {
        console.error('Error: --margin must be a non-negative number');
        process.exit(2);
      }
    } else if (arg === '--area-drawing') {
      args.areaDrawing = true;
      args.areaPage = false;
    } else if (arg === '--area-page') {
      args.areaPage = true;
      args.areaDrawing = false;
    } else if (arg === '--area-snap') {
      args.areaSnap = true;
    } else if (arg === '--id' && i + 1 < argv.length) {
      args.objectId = getNextArg();
    } else if (arg === '--color-mode' && i + 1 < argv.length) {
      args.colorMode = getNextArg();
      const validModes = [
        'Gray_1',
        'Gray_2',
        'Gray_4',
        'Gray_8',
        'Gray_16',
        'RGB_8',
        'RGB_16',
        'GrayAlpha_8',
        'GrayAlpha_16',
        'RGBA_8',
        'RGBA_16'
      ];
      if (!args.colorMode || !validModes.includes(args.colorMode)) {
        console.error(`Error: --color-mode must be one of: ${validModes.join(', ')}`);
        process.exit(2);
      }
    } else if (arg === '--compression' && i + 1 < argv.length) {
      args.compression = parseInt(getNextArg(), 10);
      if (isNaN(args.compression) || args.compression < 0 || args.compression > 9) {
        console.error('Error: --compression must be between 0 and 9');
        process.exit(2);
      }
    } else if (arg === '--antialias' && i + 1 < argv.length) {
      args.antialias = parseInt(getNextArg(), 10);
      if (isNaN(args.antialias) || args.antialias < 0 || args.antialias > 3) {
        console.error('Error: --antialias must be between 0 and 3');
        process.exit(2);
      }
    } else if (arg === '--background' && i + 1 < argv.length) {
      args.background = getNextArg();
    } else if (arg === '--background-opacity' && i + 1 < argv.length) {
      args.backgroundOpacity = parseFloat(getNextArg());
      if (isNaN(args.backgroundOpacity) || args.backgroundOpacity < 0) {
        console.error('Error: --background-opacity must be >= 0');
        process.exit(2);
      }
      // Convert 0.0-1.0 range to 0-255 range if needed
      if (args.backgroundOpacity <= 1.0) {
        args.backgroundOpacity = Math.round(args.backgroundOpacity * 255);
      } else if (args.backgroundOpacity > 255) {
        console.error('Error: --background-opacity must be 0.0-1.0 or 1-255');
        process.exit(2);
      }
    } else if (arg === '--convert-dpi' && i + 1 < argv.length) {
      const dpiMethod = getNextArg();
      if (!['none', 'scale-viewbox', 'scale-document'].includes(dpiMethod)) {
        console.error('Error: --convert-dpi must be "none", "scale-viewbox", or "scale-document"');
        process.exit(2);
      }
      args.convertDpiMethod = dpiMethod;
    } else if (arg === '--batch' && i + 1 < argv.length) {
      args.batch = getNextArg();
    } else if (arg && !arg.startsWith('-')) {
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
  if (!args.batch && !args.input) {
    console.error('Error: Input SVG file required (or use --batch <file>)');
    console.error('Usage: node sbb-inkscape-svg2png.cjs input.svg [options]');
    console.error('   or: node sbb-inkscape-svg2png.cjs --batch <file> [options]');
    process.exit(2);
  }

  // Batch mode cannot have individual input file
  if (args.batch && args.input) {
    console.error('Error: --batch mode cannot be combined with individual SVG file argument');
    process.exit(2);
  }

  // Set default output file (only for non-batch mode)
  // WHY: TypeScript requires explicit null check despite validation above guaranteeing args.input is non-null here
  if (!args.batch && !args.output && args.input) {
    const inputBase = path.basename(args.input, path.extname(args.input));
    args.output = `${inputBase}.png`;
  }

  return args;
}

// ═══════════════════════════════════════════════════════════════════════════
// BATCH FILE PROCESSING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Read and parse batch export file.
 * Returns array of { input, output } objects.
 *
 * Batch file format supports two formats:
 * 1. Input only (output auto-generated): input.svg
 * 2. Input/output pair (tab or space separated): input.svg output.png
 *
 * Lines starting with # are comments and are ignored.
 *
 * @param {string} batchFilePath - Path to the batch file
 * @returns {BatchFilePair[]} Array of input/output file pairs
 */
function readBatchFile(batchFilePath) {
  // SECURITY: Validate batch file path
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

  // Parse each line into { input, output } pairs
  const filePairs = lines.map((line, index) => {
    // Split by tab first (more reliable for paths with spaces), then by space
    // Try tab-separated first
    let parts = line
      .split('\t')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    // If only one part after tab split, try space-separated
    // WHY: Handle space-separated format for input.svg output.png pairs
    // REGEX FIX: Improved to handle paths with spaces better
    // Look for pattern: something.svg something.png (SVG + PNG files)
    if (parts.length === 1) {
      // Match: (anything ending in .svg) + (whitespace) + (anything ending in .png)
      const fileMatch = line.match(/^(.+\.svg)\s+(.+\.png)$/i);
      // WHY: Guard ensures capture groups are defined before accessing
      if (fileMatch && fileMatch[1] && fileMatch[2]) {
        parts = [fileMatch[1].trim(), fileMatch[2].trim()];
      }
    }

    // SECURITY: Validate each path for shell metacharacters
    parts.forEach((part) => {
      if (SHELL_METACHARACTERS.test(part)) {
        throw new ValidationError(
          `Invalid file path at line ${index + 1} in batch file: contains shell metacharacters`
        );
      }
    });

    if (parts.length === 0) {
      throw new ValidationError(`Empty line at line ${index + 1} in batch file`);
    }

    // WHY: After length check, first element is guaranteed to exist
    const inputFile = /** @type {string} */ (parts[0]);

    // If output is specified, use it; otherwise auto-generate
    /** @type {string} */
    let outputFile;
    if (parts.length >= 2 && parts[1]) {
      // Explicit output path provided
      outputFile = parts[1];
    } else {
      // Auto-generate output: <input>.png in same directory
      // WHY: Check for collisions when auto-generating output filenames
      // Prevents accidental overwrites in batch processing
      const baseName = path.basename(inputFile, path.extname(inputFile));
      const dirName = path.dirname(inputFile);
      let candidate = path.join(dirName, `${baseName}.png`);

      // Check for naming conflicts and add numeric suffix if needed
      let counter = 1;
      while (fs.existsSync(candidate)) {
        candidate = path.join(dirName, `${baseName}_${counter}.png`);
        counter++;
      }
      outputFile = candidate;
    }

    return { input: inputFile, output: outputFile };
  });

  // WHY: Handle empty batch file entries after filtering
  // Empty files should fail early with a clear message
  if (filePairs.length === 0) {
    throw new ValidationError(`No valid entries found in batch file: ${safeBatchPath}`);
  }

  return filePairs;
}

// ═══════════════════════════════════════════════════════════════════════════
// INKSCAPE PNG EXPORT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Export an SVG file to PNG using Inkscape.
 * @param {string} inputPath - Input SVG file path
 * @param {string} outputPath - Output PNG file path
 * @param {ExportOptions} [options] - Export options
 * @returns {Promise<ExportResult>} Export result with file info
 */
async function exportPngWithInkscape(inputPath, outputPath, options = {}) {
  // SECURITY: Validate input file path
  const safeInputPath = validateFilePath(inputPath, {
    requiredExtensions: ['.svg'],
    mustExist: true
  });

  // SECURITY: Validate output file path
  const safeOutputPath = validateOutputPath(outputPath, {
    requiredExtensions: ['.png']
  });

  const {
    width = null,
    height = null,
    dpi = null,
    margin = null,
    areaDrawing = true,
    areaPage = false,
    areaSnap = false,
    objectId = null,
    colorMode = null,
    compression = null,
    antialias = null,
    background = null,
    backgroundOpacity = null,
    convertDpiMethod = 'none'
  } = options;

  // Build Inkscape command arguments
  // Based on Inkscape CLI documentation and Python reference implementation
  // Uncomment the optional parameters when you need them. Do not remove the comments.
  const inkscapeArgs = [
    // Export as PNG format
    '--export-type=png',

    // Overwrite existing output file without prompting
    '--export-overwrite',

    // Use 'no-convert-text-baseline-spacing' to do not automatically fix text baselines in legacy
    // (pre-0.92) files on opening. Inkscape 0.92 adopts the CSS standard definition for the
    // 'line-height' property, which differs from past versions. By default, the line height values
    // in files created prior to Inkscape 0.92 will be adjusted on loading to preserve the intended
    // text layout. This command line option will skip that adjustment.
    '--no-convert-text-baseline-spacing',

    // Choose 'convert-dpi-method' method to rescale legacy (pre-0.92) files which render slightly
    // smaller due to the switch from 90 DPI to 96 DPI when interpreting lengths expressed in units
    // of pixels. Possible values are "none" (no change, document will render at 94% of its original
    // size), "scale-viewbox" (document will be rescaled globally, individual lengths will stay
    // untouched) and "scale-document" (each length will be re-scaled individually).
    `--convert-dpi-method=${convertDpiMethod}`,

    // Output filename
    `--export-filename=${safeOutputPath}`
  ];

  // Export area mode (optional)
  if (areaPage) {
    // Export the full SVG page/viewBox area
    inkscapeArgs.push('--export-area-page');
  } else if (areaDrawing) {
    // By default the exported area is the viewbox, but if 'export-area-drawing' option is used
    // the exported area will be the whole drawing, i.e. the bounding box of all objects of the
    // document (or of the exported object if --export-id is used). With this option, the exported
    // image will display all the visible objects of the document without margins or cropping.
    inkscapeArgs.push('--export-area-drawing');
  }

  // Area snap (optional)
  if (areaSnap) {
    // The option 'export-area-snap' will snap the export area outwards to the nearest integer px
    // values. If you are using the default export resolution of 96 dpi and your graphics are
    // pixel-snapped to minimize antialiasing, this switch allows you to preserve this alignment
    // even if you are exporting some object's bounding box (with --export-area-drawing) which is
    // itself not pixel-aligned.
    inkscapeArgs.push('--export-area-snap');
  }

  // Export specific object by ID (optional)
  if (objectId) {
    // Specify the ID of the object to export
    inkscapeArgs.push(`--export-id=${objectId}`);
    // Export only the specified object (no other objects)
    inkscapeArgs.push('--export-id-only');
  }

  // Dimensions and DPI (optional)
  if (dpi !== null) {
    // The resolution used for PNG export. It is also used for fallback rasterization of filtered
    // objects when exporting to PS, EPS, or PDF (unless you specify --export-ignore-filters to
    // suppress rasterization). The default is 96 dpi, which corresponds to 1 SVG user unit (px,
    // also called "user unit") exporting to 1 bitmap pixel. This value overrides the DPI hint if
    // used with --export-use-hints.
    inkscapeArgs.push(`--export-dpi=${dpi}`);
  }
  if (width !== null) {
    // Export width in pixels
    inkscapeArgs.push(`--export-width=${width}`);
  }
  if (height !== null) {
    // Export height in pixels
    inkscapeArgs.push(`--export-height=${height}`);
  }
  if (margin !== null) {
    // Margin around export area in pixels
    inkscapeArgs.push(`--export-margin=${margin}`);
  }

  // Color mode, compression, antialiasing (optional)
  if (colorMode !== null) {
    // Set the color mode (bit depth and color type) for exported bitmaps
    // (Gray_1/Gray_2/Gray_4/Gray_8/Gray_16/RGB_8/RGB_16/GrayAlpha_8/GrayAlpha_16/RGBA_8/RGBA_16)
    inkscapeArgs.push(`--export-png-color-mode=${colorMode}`);
  }
  if (compression !== null) {
    // Compression LEVEL: (0 to 9); default is 6.
    inkscapeArgs.push(`--export-png-compression=${compression}`);
  }
  if (antialias !== null) {
    // Antialiasing LEVEL: (0 to 3); default is 2.
    inkscapeArgs.push(`--export-png-antialias=${antialias}`);
  }

  // Background color and opacity (optional)
  if (background !== null) {
    // Background color of exported PNG. This may be any SVG supported color string,
    // for example "#ff007f" or "rgb(255, 0, 128)".
    inkscapeArgs.push(`--export-background=${background}`);
  }
  if (backgroundOpacity !== null) {
    // Opacity of the background of exported PNG. This may be a value either between 0.0 and 1.0
    // (0.0 meaning full transparency, 1.0 full opacity) or greater than 1 up to 255 (255 meaning
    // full opacity). If not set but the --export-background option is used, then the value of 255
    // (full opacity) will be used.
    inkscapeArgs.push(`--export-background-opacity=${backgroundOpacity}`);
  } else if (background !== null) {
    // Default to fully opaque if background set but opacity not specified
    inkscapeArgs.push('--export-background-opacity=255');
  }

  // Add input file as last argument
  inkscapeArgs.push(safeInputPath);

  try {
    // Execute Inkscape with timeout
    const { stdout, stderr } = await execFilePromise('inkscape', inkscapeArgs, {
      timeout: 30000, // 30 second timeout
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer
    });

    // Check if output file was created
    if (!fs.existsSync(safeOutputPath)) {
      throw new SVGBBoxError('Inkscape did not create output PNG file');
    }

    // Get output file size
    const stats = fs.statSync(safeOutputPath);

    return {
      inputPath: safeInputPath,
      outputPath: safeOutputPath,
      fileSize: stats.size,
      width,
      height,
      dpi,
      margin,
      areaDrawing,
      areaPage,
      areaSnap,
      objectId,
      colorMode,
      compression,
      antialias,
      background,
      backgroundOpacity,
      convertDpiMethod,
      stdout: stdout.trim(),
      stderr: stderr.trim()
    };
  } catch (error) {
    // WHY: TypeScript requires type guards for unknown error type
    /** @type {{ code?: string; killed?: boolean; message?: string }} */
    const execError =
      error && typeof error === 'object'
        ? /** @type {{ code?: string; killed?: boolean; message?: string }} */ (error)
        : { message: String(error) };

    if (execError.code === 'ENOENT') {
      throw new SVGBBoxError(
        'Inkscape not found. Please install Inkscape and ensure it is in your PATH.\n' +
          'Download from: https://inkscape.org/release/'
      );
    } else if (execError.killed) {
      throw new SVGBBoxError('Inkscape process timed out (30s limit)');
    } else {
      const errorMessage = execError.message || 'Unknown error';
      // WHY: SVGBBoxError expects (message, code, details) - pass error code and original error in details
      throw new SVGBBoxError(`Inkscape PNG export failed: ${errorMessage}`, 'INKSCAPE_ERROR', {
        originalError: error
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Main CLI entry point.
 * @returns {Promise<void>}
 */
async function main() {
  const args = parseArgs(process.argv);

  printInfo(`sbb-inkscape-svg2png v${getVersion()} | svg-bbox toolkit\n`);

  // BATCH MODE: Export multiple SVG files
  if (args.batch) {
    const filePairs = readBatchFile(args.batch);

    console.log(`Processing ${filePairs.length} SVG files from ${args.batch}...\n`);

    /** @type {BatchResult[]} */
    const results = [];
    for (let i = 0; i < filePairs.length; i++) {
      // WHY: Bounds check above guarantees element exists
      const pair = /** @type {BatchFilePair} */ (filePairs[i]);
      const { input: svgPath, output: pngPath } = pair;

      console.log(`[${i + 1}/${filePairs.length}] Exporting ${svgPath}...`);
      console.log(`    Target: ${pngPath}`);

      try {
        // WHY: Validate input file exists before attempting export
        // Prevents cryptic Inkscape errors when file is missing
        if (!fs.existsSync(svgPath)) {
          throw new SVGBBoxError(`Input file not found: ${svgPath}`);
        }

        const result = await exportPngWithInkscape(svgPath, pngPath, {
          width: args.width,
          height: args.height,
          dpi: args.dpi,
          margin: args.margin,
          areaDrawing: args.areaDrawing,
          areaPage: args.areaPage,
          areaSnap: args.areaSnap,
          objectId: args.objectId,
          colorMode: args.colorMode,
          compression: args.compression,
          antialias: args.antialias,
          background: args.background,
          backgroundOpacity: args.backgroundOpacity,
          convertDpiMethod: args.convertDpiMethod
        });

        results.push({
          success: true,
          input: result.inputPath,
          output: result.outputPath,
          fileSize: result.fileSize
        });

        printSuccess(
          `  ✓ Created ${result.outputPath} (${(result.fileSize / 1024).toFixed(1)} KB)`
        );
      } catch (error) {
        // WHY: TypeScript requires type guards for unknown error type
        const errorMessage = error instanceof Error ? error.message : String(error);

        results.push({
          success: false,
          input: svgPath,
          error: errorMessage
        });

        printError(`  ✗ Failed: ${errorMessage}`);
      }
    }

    // Summary
    const successful = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success).length;

    console.log(`\n${'═'.repeat(78)}`);
    console.log(`Summary: ${successful} successful, ${failed} failed`);
    console.log('═'.repeat(78));

    return;
  }

  // SINGLE FILE MODE
  // WHY: TypeScript requires explicit null checks despite validation in parseArgs
  // Single file mode validation ensures args.input and args.output are non-null
  if (!args.input || !args.output) {
    throw new SVGBBoxError('Input and output paths are required in single file mode');
  }

  console.log(`Exporting ${args.input} to PNG...`);

  const result = await exportPngWithInkscape(args.input, args.output, {
    width: args.width,
    height: args.height,
    dpi: args.dpi,
    margin: args.margin,
    areaDrawing: args.areaDrawing,
    areaPage: args.areaPage,
    areaSnap: args.areaSnap,
    objectId: args.objectId,
    colorMode: args.colorMode,
    compression: args.compression,
    antialias: args.antialias,
    background: args.background,
    backgroundOpacity: args.backgroundOpacity,
    convertDpiMethod: args.convertDpiMethod
  });

  printSuccess('✓ PNG export successful');
  console.log(`  Input:       ${result.inputPath}`);
  console.log(`  Output:      ${result.outputPath}`);
  console.log(`  Size:        ${(result.fileSize / 1024).toFixed(1)} KB`);

  // Export settings
  if (result.width || result.height) {
    const dims = [];
    if (result.width) {
      dims.push(`${result.width}px`);
    }
    if (result.height) {
      dims.push(`${result.height}px`);
    }
    console.log(`  Dimensions:  ${dims.join(' × ')}`);
  }
  if (result.dpi) {
    console.log(`  DPI:         ${result.dpi}`);
  }
  if (result.margin) {
    console.log(`  Margin:      ${result.margin}px`);
  }

  // Area mode
  const areaMode = result.areaPage ? 'page' : 'drawing';
  const areaExtra = result.areaSnap ? ' (snap)' : '';
  console.log(`  Export area: ${areaMode}${areaExtra}`);

  if (result.objectId) {
    console.log(`  Object ID:   ${result.objectId}`);
  }

  // Color & quality
  if (result.colorMode) {
    console.log(`  Color mode:  ${result.colorMode}`);
  }
  if (result.compression !== null) {
    console.log(`  Compression: ${result.compression}/9`);
  }
  if (result.antialias !== null) {
    console.log(`  Antialias:   ${result.antialias}/3`);
  }

  // Background
  if (result.background) {
    const opacity =
      result.backgroundOpacity !== null ? ` (opacity: ${result.backgroundOpacity}/255)` : '';
    console.log(`  Background:  ${result.background}${opacity}`);
  }

  if (result.convertDpiMethod !== 'none') {
    console.log(`  DPI method:  ${result.convertDpiMethod}`);
  }

  // Show Inkscape warnings if any
  if (result.stderr) {
    printInfo(`\nInkscape warnings:\n${result.stderr}`);
  }
}

// SECURITY: Run with CLI error handling
runCLI(main);

module.exports = { main, exportPngWithInkscape };
