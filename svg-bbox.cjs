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
const readline = require('readline');

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
 * Organized by bbox algorithm used
 */
const TOOLS = [
  // Core Tools (Our Visual BBox Algorithm)
  {
    name: 'sbb-getbbox',
    description: 'Get bbox info using our pixel-accurate visual algorithm',
    example: 'sbb-getbbox input.svg --json',
    category: 'Core'
  },
  {
    name: 'sbb-extract',
    description: 'List/rename/extract/export SVG objects with visual catalog',
    example: 'sbb-extract input.svg --list',
    category: 'Core'
  },
  {
    name: 'sbb-render',
    description: 'Render SVG to PNG with accurate bbox',
    example: 'sbb-render input.svg output.png --scale 2',
    category: 'Core'
  },
  {
    name: 'sbb-fix-viewbox',
    description: 'Repair missing/broken viewBox using visual bbox',
    example: 'sbb-fix-viewbox broken.svg fixed.svg',
    category: 'Core'
  },
  {
    name: 'sbb-comparer',
    description: 'Visual diff between SVGs (pixel comparison)',
    example: 'sbb-comparer a.svg b.svg diff.png',
    category: 'Core'
  },
  {
    name: 'sbb-test',
    description: 'Test bbox accuracy across methods',
    example: 'sbb-test input.svg --verbose',
    category: 'Core'
  },
  // Chrome Comparison Tools
  {
    name: 'sbb-chrome-getbbox',
    description: "Get bbox info using Chrome's .getBBox() (for comparison)",
    example: 'sbb-chrome-getbbox input.svg --json',
    category: 'Chrome'
  },
  {
    name: 'sbb-chrome-extract',
    description: "Extract using Chrome's .getBBox() (for comparison)",
    example: 'sbb-chrome-extract input.svg --id text39 --output out.svg',
    category: 'Chrome'
  },
  // Inkscape Comparison Tools
  {
    name: 'sbb-inkscape-getbbox',
    description: "Get bbox info using Inkscape's query commands (for comparison)",
    example: 'sbb-inkscape-getbbox input.svg --json',
    category: 'Inkscape'
  },
  {
    name: 'sbb-inkscape-extract',
    description: 'Extract by ID using Inkscape (requires Inkscape)',
    example: 'sbb-inkscape-extract input.svg --id element-id',
    category: 'Inkscape'
  },
  {
    name: 'sbb-inkscape-text2path',
    description: 'Convert text to paths using Inkscape (requires Inkscape)',
    example: 'sbb-inkscape-text2path input.svg output.svg',
    category: 'Inkscape'
  },
  {
    name: 'sbb-inkscape-svg2png',
    description: 'SVG to PNG export using Inkscape (requires Inkscape)',
    example: 'sbb-inkscape-svg2png input.svg output.png --dpi 300',
    category: 'Inkscape'
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

  // Group tools by category
  const categories = {
    Core: 'Core Tools (Our Visual BBox Algorithm)',
    Chrome: "Chrome Comparison Tools (Chrome's .getBBox())",
    Inkscape: 'Inkscape Comparison Tools (Inkscape CLI)'
  };

  let toolNumber = 1;
  for (const [catKey, catLabel] of Object.entries(categories)) {
    console.log(`${c.magenta}${c.bold}${catLabel}:${c.reset}`);
    const toolsInCategory = TOOLS.filter((t) => t.category === catKey);
    for (const tool of toolsInCategory) {
      console.log(`  ${c.yellow}${toolNumber}.${c.reset} ${c.cyan}${c.bold}${tool.name}${c.reset}`);
      console.log(`     ${tool.description}`);
      console.log(`     ${c.dim}Example: ${tool.example}${c.reset}`);
      console.log();
      toolNumber++;
    }
  }

  console.log(`${c.yellow}${c.bold}QUICK START:${c.reset}
  ${c.dim}# Get bounding box info for an SVG${c.reset}
  ${c.green}npx sbb-getbbox${c.reset} myfile.svg --json

  ${c.dim}# Extract all objects as separate SVG files${c.reset}
  ${c.green}npx sbb-extract${c.reset} myfile.svg --list

  ${c.dim}# Render SVG to PNG at 2x scale${c.reset}
  ${c.green}npx sbb-render${c.reset} myfile.svg myfile.png --scale 2

${c.yellow}${c.bold}NAMING CONVENTION:${c.reset}
  ${c.dim}sbb-[function]${c.reset}           - Our reliable visual bbox algorithm
  ${c.dim}sbb-chrome-[function]${c.reset}    - Chrome's .getBBox() method (for comparison)
  ${c.dim}sbb-inkscape-[function]${c.reset}  - Inkscape tools (for comparison)

${c.yellow}${c.bold}MORE INFO:${c.reset}
  Run any command with ${c.green}--help${c.reset} for detailed usage information.
  ${c.dim}Example: npx sbb-getbbox --help${c.reset}

${c.yellow}${c.bold}DOCUMENTATION:${c.reset}
  ${c.blue}https://github.com/Emasoft/SVG-BBOX${c.reset}

${c.yellow}${c.bold}═══════════════════════════════════════════════════════════════════════════════${c.reset}
`);
  console.log(
    `${c.cyan}Enter a number (1-${TOOLS.length}) to see detailed help for that tool, or press Ctrl+C to exit:${c.reset}`
  );
}

/**
 * Print version information
 */
function printVersionInfo() {
  const version = getVersion();
  console.log(`svg-bbox v${version}`);
}

/**
 * Interactive tool selection
 */
function promptToolSelection() {
  const { spawn } = require('child_process');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question('> ', (answer) => {
    rl.close();

    const selection = parseInt(answer, 10);
    if (isNaN(selection) || selection < 1 || selection > TOOLS.length) {
      printError(
        `Invalid selection: ${answer}. Please enter a number between 1 and ${TOOLS.length}.`
      );
      process.exit(1);
    }

    const selectedTool = TOOLS[selection - 1];
    console.log(`\n${c.green}Showing help for: ${c.bold}${selectedTool.name}${c.reset}\n`);

    // Execute the tool with --help flag
    const toolProcess = spawn('node', [`./${selectedTool.name}.cjs`, '--help'], {
      stdio: 'inherit'
    });

    toolProcess.on('close', (code) => {
      process.exit(code);
    });
  });
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
    // If no arguments, start interactive mode
    if (args.length === 0) {
      promptToolSelection();
      return;
    }
    process.exit(0);
  }

  // If user passes unknown arguments, show help with error
  printError(`Unknown argument: ${args[0]}`);
  console.log();
  console.log('Run with --help to see available commands.');
  console.log();
  console.log('Did you mean to run one of these?');
  console.log(`  ${c.green}npx sbb-getbbox${c.reset} ${args.join(' ')}`);
  console.log(`  ${c.green}npx sbb-extract${c.reset} ${args.join(' ')}`);
  console.log(`  ${c.green}npx sbb-render${c.reset} ${args.join(' ')}`);
  process.exit(1);
}

main();
