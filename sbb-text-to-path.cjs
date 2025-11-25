#!/usr/bin/env node
/**
 * sbb-text-to-path.cjs
 *
 * Convert text elements to paths in SVG files using Inkscape.
 * Requires Inkscape to be installed on your system.
 *
 * Part of the svg-bbox toolkit.
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
  ValidationError,
  FileSystemError
} = require('./lib/security-utils.cjs');

const {
  runCLI,
  printSuccess,
  printError,
  printInfo,
  printWarning
} = require('./lib/cli-utils.cjs');

// ═══════════════════════════════════════════════════════════════════════════
// HELP TEXT
// ═══════════════════════════════════════════════════════════════════════════

function printHelp() {
  console.log(`
╔════════════════════════════════════════════════════════════════════════════╗
║ sbb-text-to-path.cjs - SVG Text to Path Converter                         ║
╚════════════════════════════════════════════════════════════════════════════╝

DESCRIPTION:
  Converts all text elements in an SVG file to paths using Inkscape.
  This makes text rendering consistent across all platforms and browsers,
  independent of font availability.

REQUIREMENTS:
  • Inkscape must be installed on your system
  • Supported platforms: Windows, macOS, Linux

USAGE:
  node sbb-text-to-path.cjs input.svg [output.svg] [options]

ARGUMENTS:
  input.svg             Input SVG file with text elements
  output.svg            Output SVG file with text converted to paths
                        Default: <input>-paths.svg

OPTIONS:
  --overwrite           Overwrite output file if it exists
  --preserve-baseline   Preserve text baseline spacing (Inkscape default)
                        Default: disabled (--no-convert-text-baseline-spacing)
  --convert-dpi         Allow DPI conversion (90 to 96)
                        Default: disabled (--convert-dpi-method=none)
  --json                Output results as JSON
  --help                Show this help
  --version             Show version

EXAMPLES:

  # Basic conversion (creates input-paths.svg)
  node sbb-text-to-path.cjs drawing.svg

  # Specify output file
  node sbb-text-to-path.cjs input.svg output.svg

  # Overwrite existing file
  node sbb-text-to-path.cjs input.svg output.svg --overwrite

  # Preserve baseline spacing
  node sbb-text-to-path.cjs input.svg output.svg --preserve-baseline

  # JSON output for automation
  node sbb-text-to-path.cjs input.svg output.svg --json

NOTES:
  • Original file is never modified
  • Text elements are converted to <path> elements
  • Font information is lost (paths only)
  • File size typically increases (paths are more verbose than text)
  • Conversion preserves visual appearance exactly

EXIT CODES:
  • 0: Conversion successful
  • 1: Error occurred
  • 2: Invalid arguments or Inkscape not found
`);
}

function printVersion(toolName) {
  const version = getVersion();
  console.log(`${toolName} v${version} | svg-bbox toolkit`);
}

// ═══════════════════════════════════════════════════════════════════════════
// INKSCAPE DETECTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Detect Inkscape installation on the current platform.
 * Returns the path to the Inkscape executable or null if not found.
 */
async function findInkscape() {
  const platform = process.platform;

  // Common Inkscape executable paths by platform
  const candidatePaths = [];

  if (platform === 'win32') {
    // Windows - check Program Files and common install locations
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

    candidatePaths.push(
      path.join(programFiles, 'Inkscape', 'bin', 'inkscape.exe'),
      path.join(programFiles, 'Inkscape', 'inkscape.exe'),
      path.join(programFilesX86, 'Inkscape', 'bin', 'inkscape.exe'),
      path.join(programFilesX86, 'Inkscape', 'inkscape.exe'),
      'C:\\Program Files\\Inkscape\\bin\\inkscape.exe',
      'C:\\Program Files (x86)\\Inkscape\\bin\\inkscape.exe'
    );
  } else if (platform === 'darwin') {
    // macOS - check Applications and common paths
    candidatePaths.push(
      '/Applications/Inkscape.app/Contents/MacOS/inkscape',
      '/Applications/Inkscape.app/Contents/Resources/bin/inkscape',
      '/usr/local/bin/inkscape',
      '/opt/homebrew/bin/inkscape',
      '/opt/local/bin/inkscape'  // MacPorts
    );
  } else {
    // Linux and other Unix-like systems
    candidatePaths.push(
      '/usr/bin/inkscape',
      '/usr/local/bin/inkscape',
      '/snap/bin/inkscape',  // Snap package
      '/usr/bin/flatpak'      // Flatpak (special handling needed)
    );
  }

  // Check each candidate path
  for (const candidate of candidatePaths) {
    try {
      if (fs.existsSync(candidate)) {
        // Verify it's executable by trying --version
        const { stdout } = await execFilePromise(candidate, ['--version'], { timeout: 5000 });
        if (stdout.toLowerCase().includes('inkscape')) {
          return candidate;
        }
      }
    } catch (err) {
      // Path exists but not executable or version check failed - continue
      continue;
    }
  }

  // Try 'inkscape' in PATH (works on all platforms)
  try {
    const { stdout } = await execFilePromise('inkscape', ['--version'], { timeout: 5000 });
    if (stdout.toLowerCase().includes('inkscape')) {
      return 'inkscape';  // Found in PATH
    }
  } catch (err) {
    // Not in PATH
  }

  // Special handling for Flatpak on Linux
  if (platform === 'linux') {
    try {
      const { stdout } = await execFilePromise('flatpak', ['run', 'org.inkscape.Inkscape', '--version'], { timeout: 5000 });
      if (stdout.toLowerCase().includes('inkscape')) {
        return 'flatpak run org.inkscape.Inkscape';
      }
    } catch (err) {
      // Flatpak not available or Inkscape not installed via Flatpak
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// ARGUMENT PARSING
// ═══════════════════════════════════════════════════════════════════════════

function parseArgs(argv) {
  const args = {
    input: null,
    output: null,
    overwrite: false,
    preserveBaseline: false,
    convertDpi: false,
    json: false
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--version' || arg === '-v') {
      printVersion('sbb-text-to-path');
      process.exit(0);
    } else if (arg === '--overwrite') {
      args.overwrite = true;
    } else if (arg === '--preserve-baseline') {
      args.preserveBaseline = true;
    } else if (arg === '--convert-dpi') {
      args.convertDpi = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (!arg.startsWith('-')) {
      if (!args.input) {
        args.input = arg;
      } else if (!args.output) {
        args.output = arg;
      } else {
        throw new ValidationError(`Unexpected argument: ${arg}`);
      }
    } else {
      throw new ValidationError(`Unknown option: ${arg}`);
    }
  }

  // Validate required arguments
  if (!args.input) {
    throw new ValidationError('Input SVG file required');
  }

  // Set default output file
  if (!args.output) {
    const baseName = path.basename(args.input, path.extname(args.input));
    const dirName = path.dirname(args.input);
    args.output = path.join(dirName, `${baseName}-paths.svg`);
  }

  return args;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONVERSION
// ═══════════════════════════════════════════════════════════════════════════

async function convertTextToPaths(inkscapePath, inputPath, outputPath, options) {
  // Build Inkscape command arguments
  const inkscapeArgs = [
    '--export-type=svg',
    '--export-plain-svg',
    '--export-text-to-path',
  ];

  // Add optional flags
  if (options.overwrite) {
    inkscapeArgs.push('--export-overwrite');
  }

  if (!options.preserveBaseline) {
    inkscapeArgs.push('--no-convert-text-baseline-spacing');
  }

  if (!options.convertDpi) {
    inkscapeArgs.push('--convert-dpi-method=none');
  }

  // Add output and input files
  inkscapeArgs.push(`--export-filename=${outputPath}`);
  inkscapeArgs.push(inputPath);

  // Execute Inkscape
  try {
    // Handle Flatpak case (inkscapePath is a command string)
    if (inkscapePath.includes('flatpak')) {
      const flatpakArgs = ['run', 'org.inkscape.Inkscape'].concat(inkscapeArgs);
      const { stdout, stderr } = await execFilePromise('flatpak', flatpakArgs, {
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024  // 10MB buffer for output
      });
      return { stdout, stderr };
    } else {
      const { stdout, stderr } = await execFilePromise(inkscapePath, inkscapeArgs, {
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024  // 10MB buffer for output
      });
      return { stdout, stderr };
    }
  } catch (err) {
    throw new SVGBBoxError(`Inkscape conversion failed: ${err.message}`, err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const args = parseArgs(process.argv);

  // Display version (but not in JSON mode)
  if (!args.json) {
    printInfo(`sbb-text-to-path v${getVersion()} | svg-bbox toolkit\n`);
  }

  // SECURITY: Validate input SVG file
  const safeInputPath = validateFilePath(args.input, {
    requiredExtensions: ['.svg'],
    mustExist: true
  });

  // SECURITY: Validate output path
  const safeOutputPath = validateOutputPath(args.output, {
    requiredExtensions: ['.svg']
  });

  // Check if output exists and --overwrite not specified
  if (fs.existsSync(safeOutputPath) && !args.overwrite) {
    throw new ValidationError(`Output file already exists: ${safeOutputPath}\nUse --overwrite to replace it.`);
  }

  // Find Inkscape installation
  if (!args.json) {
    printInfo('Detecting Inkscape installation...');
  }

  const inkscapePath = await findInkscape();

  if (!inkscapePath) {
    throw new SVGBBoxError(
      'Inkscape not found.\n' +
      'Please install Inkscape:\n' +
      '  • Windows: https://inkscape.org/release/\n' +
      '  • macOS: brew install --cask inkscape\n' +
      '  • Linux: sudo apt install inkscape (or your package manager)'
    );
  }

  if (!args.json) {
    printInfo(`Found Inkscape: ${inkscapePath}`);
    printInfo('Converting text to paths...');
  }

  // Convert text to paths
  const result = await convertTextToPaths(inkscapePath, safeInputPath, safeOutputPath, {
    overwrite: args.overwrite,
    preserveBaseline: args.preserveBaseline,
    convertDpi: args.convertDpi
  });

  // Verify output file was created
  if (!fs.existsSync(safeOutputPath)) {
    throw new FileSystemError('Conversion failed: output file not created');
  }

  const inputStats = fs.statSync(safeInputPath);
  const outputStats = fs.statSync(safeOutputPath);

  // Output results
  if (args.json) {
    console.log(JSON.stringify({
      input: safeInputPath,
      output: safeOutputPath,
      inputSize: inputStats.size,
      outputSize: outputStats.size,
      sizeIncrease: ((outputStats.size / inputStats.size - 1) * 100).toFixed(2) + '%',
      inkscapePath: inkscapePath
    }, null, 2));
  } else {
    printSuccess('Conversion complete!');
    console.log(`  Input:        ${safeInputPath} (${(inputStats.size / 1024).toFixed(1)} KB)`);
    console.log(`  Output:       ${safeOutputPath} (${(outputStats.size / 1024).toFixed(1)} KB)`);
    console.log(`  Size change:  ${outputStats.size > inputStats.size ? '+' : ''}${((outputStats.size / inputStats.size - 1) * 100).toFixed(1)}%`);
    console.log('');
    printInfo('All text elements have been converted to paths.');
    printWarning('Font information has been lost - text is now vector outlines.');
  }
}

// SECURITY: Run with CLI error handling
runCLI(main);

module.exports = { findInkscape, convertTextToPaths, main };
