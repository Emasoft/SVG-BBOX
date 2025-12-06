#!/usr/bin/env node
/**
 * sbb-inkscape-text2path.cjs
 *
 * Convert text elements to paths in SVG files using Inkscape.
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
║ sbb-inkscape-text2path.cjs - SVG Text to Path Converter                   ║
╚════════════════════════════════════════════════════════════════════════════╝

DESCRIPTION:
  Converts all text elements in an SVG file to paths using Inkscape.
  This makes text rendering consistent across all platforms and browsers,
  independent of font availability.

REQUIREMENTS:
  • Inkscape must be installed on your system
  • Supported platforms: Windows, macOS, Linux

USAGE:
  node sbb-inkscape-text2path.cjs input.svg [output.svg] [options]
  node sbb-inkscape-text2path.cjs --batch files.txt [options]

ARGUMENTS:
  input.svg             Input SVG file with text elements
  output.svg            Output SVG file with text converted to paths
                        Default: <input>-paths.svg

OPTIONS:
  --batch <file.txt>    Process multiple SVG files listed in text file
                        Supports two formats per line:
                        - Input only: input.svg (output auto-generated)
                        - Input/output pair: input.svg<TAB>output.svg
                        Lines starting with # are comments
  --overwrite           Overwrite output file if it exists
  --skip-comparison     Skip automatic similarity check with sbb-compare
                        (only applies to single file mode)
  --json                Output results as JSON
  --help                Show this help
  --version             Show version

BATCH FILE FORMAT:
  Each line can be:
  - Input file only:     input.svg
    (Output: input-paths.svg in same directory)
  - Input/output pair:   input.svg<TAB>output.svg
    (Tab-separated or space-separated if both end in .svg)

  Example batch file (files.txt):
    # Comment line - ignored
    simple.svg
    drawing.svg    drawing_converted.svg
    /path/to/input.svg    /other/path/output_inkscape.svg

EXAMPLES:

  # Basic conversion (creates input-paths.svg, then compares with sbb-compare)
  node sbb-inkscape-text2path.cjs drawing.svg

  # Specify output file
  node sbb-inkscape-text2path.cjs input.svg output.svg

  # Skip automatic comparison
  node sbb-inkscape-text2path.cjs input.svg output.svg --skip-comparison

  # Batch conversion with explicit output paths
  node sbb-inkscape-text2path.cjs --batch files.txt

  # Batch conversion without comparison (faster)
  node sbb-inkscape-text2path.cjs --batch files.txt --skip-comparison

  # Overwrite existing files
  node sbb-inkscape-text2path.cjs input.svg output.svg --overwrite

  # JSON output for automation
  node sbb-inkscape-text2path.cjs input.svg output.svg --json

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
      '/opt/local/bin/inkscape' // MacPorts
    );
  } else {
    // Linux and other Unix-like systems
    candidatePaths.push(
      '/usr/bin/inkscape',
      '/usr/local/bin/inkscape',
      '/snap/bin/inkscape', // Snap package
      '/usr/bin/flatpak' // Flatpak (special handling needed)
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
    } catch {
      // Path exists but not executable or version check failed - continue
      continue;
    }
  }

  // Try 'inkscape' in PATH (works on all platforms)
  try {
    const { stdout } = await execFilePromise('inkscape', ['--version'], { timeout: 5000 });
    if (stdout.toLowerCase().includes('inkscape')) {
      return 'inkscape'; // Found in PATH
    }
  } catch {
    // Not in PATH
  }

  // Special handling for Flatpak on Linux
  if (platform === 'linux') {
    try {
      const { stdout } = await execFilePromise(
        'flatpak',
        ['run', 'org.inkscape.Inkscape', '--version'],
        { timeout: 5000 }
      );
      if (stdout.toLowerCase().includes('inkscape')) {
        return 'flatpak run org.inkscape.Inkscape';
      }
    } catch {
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
    batch: null,
    overwrite: false,
    skipComparison: false,
    json: false
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--version' || arg === '-v') {
      printVersion('sbb-inkscape-text2path');
      process.exit(0);
    } else if (arg === '--batch' && i + 1 < argv.length) {
      args.batch = argv[++i];
    } else if (arg === '--overwrite') {
      args.overwrite = true;
    } else if (arg === '--skip-comparison') {
      args.skipComparison = true;
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

  // Validate batch vs single mode
  if (args.batch && args.input) {
    throw new ValidationError('Cannot use both --batch and input file argument');
  }

  // Validate required arguments
  if (!args.batch && !args.input) {
    throw new ValidationError('Input SVG file or --batch option required');
  }

  // Set default output file (only for single mode)
  if (args.input && !args.output) {
    const baseName = path.basename(args.input, path.extname(args.input));
    const dirName = path.dirname(args.input);
    args.output = path.join(dirName, `${baseName}-paths.svg`);
  }

  return args;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPARISON
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run sbb-compare to check similarity between original and converted SVG.
 * Returns comparison result or null if comparer fails.
 */
async function runComparison(originalPath, convertedPath, jsonMode) {
  const comparerPath = path.join(__dirname, 'sbb-compare.cjs');

  if (!fs.existsSync(comparerPath)) {
    if (!jsonMode) {
      printWarning('sbb-compare.cjs not found - skipping comparison');
    }
    return null;
  }

  try {
    const { stdout } = await execFilePromise(
      'node',
      [comparerPath, originalPath, convertedPath, '--json'],
      {
        timeout: 120000, // 2 minutes for comparison
        maxBuffer: 10 * 1024 * 1024
      }
    );

    const result = JSON.parse(stdout);
    return result;
  } catch (err) {
    if (!jsonMode) {
      printWarning(`Comparison failed: ${err.message}`);
    }
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CONVERSION
// ═══════════════════════════════════════════════════════════════════════════

async function convertTextToPaths(inkscapePath, inputPath, outputPath) {
  // Build Inkscape command arguments
  // Based on Inkscape CLI documentation and Python reference implementation
  // Non-commented parameters are the defaults that are ALWAYS used
  const inkscapeArgs = [
    // Export as SVG format
    '--export-type=svg',

    // Export as plain SVG (no Inkscape-specific extensions)
    '--export-plain-svg',

    // Convert all text elements to path outlines
    '--export-text-to-path',

    // Overwrite existing output file without prompting
    '--export-overwrite',

    // Use 'no-convert-text-baseline-spacing' to do not automatically fix text baselines in legacy
    // (pre-0.92) files on opening. Inkscape 0.92 adopts the CSS standard definition for the
    // 'line-height' property, which differs from past versions. By default, the line height values
    // in files created prior to Inkscape 0.92 will be adjusted on loading to preserve the intended
    // text layout. This command line option will skip that adjustment.
    '--no-convert-text-baseline-spacing',

    // Output filename
    `--export-filename=${outputPath}`,

    // Choose 'convert-dpi-method' method to rescale legacy (pre-0.92) files which render slightly
    // smaller due to the switch from 90 DPI to 96 DPI when interpreting lengths expressed in units
    // of pixels. Possible values are "none" (no change, document will render at 94% of its original
    // size), "scale-viewbox" (document will be rescaled globally, individual lengths will stay
    // untouched) and "scale-document" (each length will be re-scaled individually).
    '--convert-dpi-method=none',

    // Input SVG file
    inputPath
  ];

  // Execute Inkscape
  try {
    // Handle Flatpak case (inkscapePath is a command string)
    if (inkscapePath.includes('flatpak')) {
      const flatpakArgs = ['run', 'org.inkscape.Inkscape'].concat(inkscapeArgs);
      const { stdout, stderr } = await execFilePromise('flatpak', flatpakArgs, {
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024 // 10MB buffer for output
      });
      return { stdout, stderr };
    } else {
      const { stdout, stderr } = await execFilePromise(inkscapePath, inkscapeArgs, {
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024 // 10MB buffer for output
      });
      return { stdout, stderr };
    }
  } catch (err) {
    throw new SVGBBoxError(`Inkscape conversion failed: ${err.message}`, err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BATCH PROCESSING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Read and parse batch file list.
 * Returns array of { input, output } objects.
 *
 * Batch file format supports two formats:
 * 1. Input only (output auto-generated): input.svg
 * 2. Input/output pair (tab or space separated): input.svg output.svg
 *
 * Lines starting with # are comments and are ignored.
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

  // Parse each line into { input, output } pairs
  const filePairs = lines.map((line, index) => {
    // Split by tab first (more reliable for paths with spaces), then by space
    // Try tab-separated first
    let parts = line
      .split('\t')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    // If only one part after tab split, try space-separated
    // But be careful: paths might contain spaces, so only split on multiple spaces
    // or when it's clear there are two .svg files
    if (parts.length === 1) {
      // Look for pattern: something.svg something.svg (two SVG files)
      const svgMatch = line.match(/^(.+\.svg)\s+(.+\.svg)$/i);
      if (svgMatch) {
        parts = [svgMatch[1].trim(), svgMatch[2].trim()];
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

    const inputFile = parts[0];

    // If output is specified, use it; otherwise auto-generate
    let outputFile;
    if (parts.length >= 2) {
      // Explicit output path provided
      outputFile = parts[1];
    } else {
      // Auto-generate output: <input>-paths.svg in same directory
      const baseName = path.basename(inputFile, path.extname(inputFile));
      const dirName = path.dirname(inputFile);
      outputFile = path.join(dirName, `${baseName}-paths.svg`);
    }

    return { input: inputFile, output: outputFile };
  });

  return filePairs;
}

/**
 * Process a single file conversion.
 * Returns conversion result with optional comparison.
 */
async function processSingleFile(inkscapePath, inputPath, outputPath, options, args) {
  // SECURITY: Validate input SVG file
  const safeInputPath = validateFilePath(inputPath, {
    requiredExtensions: ['.svg'],
    mustExist: true
  });

  // SECURITY: Validate output path
  const safeOutputPath = validateOutputPath(outputPath, {
    requiredExtensions: ['.svg']
  });

  // Check if output exists and --overwrite not specified
  if (fs.existsSync(safeOutputPath) && !options.overwrite) {
    throw new ValidationError(
      `Output file already exists: ${safeOutputPath}\nUse --overwrite to replace it.`
    );
  }

  // Convert text to paths
  await convertTextToPaths(inkscapePath, safeInputPath, safeOutputPath);

  // Verify output file was created
  if (!fs.existsSync(safeOutputPath)) {
    throw new FileSystemError('Conversion failed: output file not created');
  }

  const inputStats = fs.statSync(safeInputPath);
  const outputStats = fs.statSync(safeOutputPath);

  const result = {
    input: safeInputPath,
    output: safeOutputPath,
    inputSize: inputStats.size,
    outputSize: outputStats.size,
    sizeIncrease: ((outputStats.size / inputStats.size - 1) * 100).toFixed(2) + '%',
    comparison: null
  };

  // Run comparison (unless skipped)
  if (!options.skipComparison) {
    const comparisonResult = await runComparison(safeInputPath, safeOutputPath, args.json);
    if (comparisonResult) {
      result.comparison = {
        diffPercentage: parseFloat(comparisonResult.diffPercentage),
        differentPixels: comparisonResult.differentPixels,
        totalPixels: comparisonResult.totalPixels
      };
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const args = parseArgs(process.argv);

  // Display version (but not in JSON mode)
  if (!args.json) {
    printInfo(`sbb-inkscape-text2path v${getVersion()} | svg-bbox toolkit\n`);
  }

  // SECURITY: Validate input paths BEFORE checking for Inkscape
  // This ensures security errors are caught early, even if Inkscape isn't installed
  // (important for CI environments where Inkscape may not be available)
  if (args.batch) {
    // Validate batch file path early
    validateFilePath(args.batch, { mustExist: true });
  } else if (args.input) {
    // Validate single input file path early (validates before Inkscape check)
    validateFilePath(args.input, {
      requiredExtensions: ['.svg'],
      mustExist: false // File existence checked later, but security validation happens now
    });
  }

  // Find Inkscape installation (once for all conversions)
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
    printInfo(`Found Inkscape: ${inkscapePath}\n`);
  }

  // BATCH MODE
  if (args.batch) {
    // readBatchFile now returns array of { input, output } pairs
    const filePairs = readBatchFile(args.batch);
    const results = [];

    if (!args.json) {
      printInfo(`Processing ${filePairs.length} file(s) in batch mode...\n`);
    }

    for (let i = 0; i < filePairs.length; i++) {
      const { input: inputFile, output: outputFile } = filePairs[i];

      try {
        if (!args.json) {
          printInfo(`[${i + 1}/${filePairs.length}] Converting: ${inputFile}`);
          printInfo(`    Target: ${outputFile}`);
        }

        const result = await processSingleFile(
          inkscapePath,
          inputFile,
          outputFile,
          {
            overwrite: args.overwrite,
            skipComparison: args.skipComparison
          },
          args
        );

        results.push(result);

        // Print result for batch mode (non-JSON)
        if (!args.json) {
          const similarity = result.comparison
            ? (100 - result.comparison.diffPercentage).toFixed(2)
            : 'N/A';

          console.log(`  ✓ ${path.basename(result.output)}`);
          if (!args.skipComparison && result.comparison) {
            console.log(
              `    Similarity: ${similarity}% (${result.comparison.diffPercentage}% different)`
            );
          }
        }
      } catch (err) {
        const errorResult = {
          input: inputFile,
          output: outputFile,
          error: err.message
        };
        results.push(errorResult);

        if (!args.json) {
          printError(`  ✗ Failed: ${inputFile}`);
          printError(`    ${err.message}`);
        }
      }
    }

    // Output batch results
    if (args.json) {
      console.log(
        JSON.stringify(
          {
            mode: 'batch',
            totalFiles: filePairs.length,
            successful: results.filter((r) => !r.error).length,
            failed: results.filter((r) => r.error).length,
            results: results
          },
          null,
          2
        )
      );
    } else {
      console.log('');
      const successful = results.filter((r) => !r.error).length;
      const failed = results.filter((r) => r.error).length;

      if (failed === 0) {
        printSuccess(
          `Batch complete! ${successful}/${filePairs.length} files converted successfully.`
        );
      } else {
        printWarning(`Batch complete with errors: ${successful} succeeded, ${failed} failed.`);
      }
    }

    return;
  }

  // SINGLE FILE MODE
  if (!args.json) {
    printInfo('Converting text to paths...');
  }

  const result = await processSingleFile(
    inkscapePath,
    args.input,
    args.output,
    {
      overwrite: args.overwrite,
      skipComparison: args.skipComparison
    },
    args
  );

  // Output results
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printSuccess('Conversion complete!');
    console.log(`  Input:        ${result.input} (${(result.inputSize / 1024).toFixed(1)} KB)`);
    console.log(`  Output:       ${result.output} (${(result.outputSize / 1024).toFixed(1)} KB)`);
    console.log(
      `  Size change:  ${result.outputSize > result.inputSize ? '+' : ''}${((result.outputSize / result.inputSize - 1) * 100).toFixed(1)}%`
    );

    if (result.comparison) {
      console.log('');
      printInfo('Comparison with original:');
      const similarity = (100 - result.comparison.diffPercentage).toFixed(2);
      console.log(`  Similarity:   ${similarity}%`);
      console.log(`  Difference:   ${result.comparison.diffPercentage}%`);
      console.log(`  Total pixels: ${result.comparison.totalPixels.toLocaleString()}`);
      console.log(`  Diff pixels:  ${result.comparison.differentPixels.toLocaleString()}`);
    }

    console.log('');
    printInfo('All text elements have been converted to paths.');
    printWarning('Font information has been lost - text is now vector outlines.');
  }
}

// SECURITY: Run with CLI error handling
runCLI(main);

module.exports = { findInkscape, convertTextToPaths, main };
