#!/usr/bin/env node

/**
 * svg-bbox.cjs - Main CLI entry point for svg-bbox toolkit
 *
 * This is the main command that users run when they install the svg-bbox package.
 * It displays help and lists all available subcommands.
 *
 * Usage:
 *   npx svg-bbox              # Show help and available commands
 *   npx svg-bbox --help       # Same as above
 *   npx svg-bbox --version    # Show version
 *   npx sbb-getbbox ...       # Use specific tool directly
 */

const { getVersion } = require('./version.cjs');
const { printError } = require('./lib/cli-utils.cjs');

// ANSI color codes for consistent styling
const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m'
};

const c = COLORS;

/**
 * Available CLI tools in the svg-bbox toolkit
 */
const TOOLS = [
  {
    name: 'sbb-getbbox',
    description: 'Compute visual bounding boxes for SVG files and elements',
    example: 'sbb-getbbox input.svg --json'
  },
  {
    name: 'sbb-getbbox-extract',
    description: 'Extract elements using Chrome .getBBox() (for comparison)',
    example: 'sbb-getbbox-extract input.svg --id text39 --output out.svg'
  },
  {
    name: 'sbb-extractor',
    description: 'Extract individual objects from SVG files with their bounding boxes',
    example: 'sbb-extractor input.svg --out-dir ./extracted'
  },
  {
    name: 'sbb-render',
    description: 'Render SVG files or elements to PNG images',
    example: 'sbb-render input.svg --output output.png --scale 2'
  },
  {
    name: 'sbb-comparer',
    description: 'Compare SVG rendering across different browsers/methods',
    example: 'sbb-comparer input.svg --output comparison.html'
  },
  {
    name: 'sbb-fix-viewbox',
    description: 'Fix or add viewBox attribute to SVG files',
    example: 'sbb-fix-viewbox input.svg --output fixed.svg'
  },
  {
    name: 'sbb-test',
    description: 'Test SVG visual bounding box computation accuracy',
    example: 'sbb-test input.svg --verbose'
  },
  {
    name: 'sbb-inkscape-text2path',
    description: 'Convert text to paths using Inkscape (requires Inkscape)',
    example: 'sbb-inkscape-text2path input.svg output.svg'
  },
  {
    name: 'sbb-inkscape-extract',
    description: 'Extract objects using Inkscape (requires Inkscape)',
    example: 'sbb-inkscape-extract input.svg --id element-id'
  },
  {
    name: 'sbb-inkscape-svg2png',
    description: 'Convert SVG to PNG using Inkscape (requires Inkscape)',
    example: 'sbb-inkscape-svg2png input.svg output.png --dpi 300'
  }
];

/**
 * Print the main help message
 */
function printHelp() {
  const version = getVersion();

  console.log(`
${c.cyan}${c.bold}svg-bbox${c.reset} ${c.dim}v${version}${c.reset}
${c.dim}A toolkit for computing and using SVG bounding boxes you can trust${c.reset}

${c.yellow}${c.bold}USAGE:${c.reset}
  ${c.green}npx <command>${c.reset} [options]

${c.yellow}${c.bold}AVAILABLE COMMANDS:${c.reset}
`);

  // Print each tool with description
  for (const tool of TOOLS) {
    console.log(`  ${c.cyan}${c.bold}${tool.name}${c.reset}`);
    console.log(`    ${tool.description}`);
    console.log(`    ${c.dim}Example: ${tool.example}${c.reset}`);
    console.log();
  }

  console.log(`${c.yellow}${c.bold}QUICK START:${c.reset}
  ${c.dim}# Get bounding box of all elements in an SVG${c.reset}
  ${c.green}npx sbb-getbbox${c.reset} myfile.svg --json

  ${c.dim}# Extract all objects as separate SVG files${c.reset}
  ${c.green}npx sbb-extractor${c.reset} myfile.svg --out-dir ./objects

  ${c.dim}# Render SVG to PNG at 2x scale${c.reset}
  ${c.green}npx sbb-render${c.reset} myfile.svg --output myfile.png --scale 2

${c.yellow}${c.bold}MORE INFO:${c.reset}
  Run any command with ${c.green}--help${c.reset} for detailed usage information.
  ${c.dim}Example: npx sbb-getbbox --help${c.reset}

${c.yellow}${c.bold}DOCUMENTATION:${c.reset}
  ${c.blue}https://github.com/Emasoft/SVG-BBOX${c.reset}
`);
}

/**
 * Print version information
 */
function printVersionInfo() {
  const version = getVersion();
  console.log(`svg-bbox v${version}`);
}

/**
 * Main entry point
 */
function main() {
  const args = process.argv.slice(2);

  // Handle --version flag
  if (args.includes('--version') || args.includes('-v')) {
    printVersionInfo();
    process.exit(0);
  }

  // Handle --help flag or no arguments (default to help)
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  // If user passes unknown arguments, show help with error
  printError(`Unknown argument: ${args[0]}`);
  console.log();
  console.log('Run with --help to see available commands.');
  console.log();
  console.log('Did you mean to run one of these?');
  console.log(`  ${c.green}npx sbb-getbbox${c.reset} ${args.join(' ')}`);
  console.log(`  ${c.green}npx sbb-extractor${c.reset} ${args.join(' ')}`);
  console.log(`  ${c.green}npx sbb-render${c.reset} ${args.join(' ')}`);
  process.exit(1);
}

main();
