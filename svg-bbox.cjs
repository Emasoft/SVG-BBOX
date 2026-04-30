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

const path = require('path');
const { getVersion } = require('./version.cjs');
const { printError, printBanner } = require('./lib/cli-utils.cjs');
const helpFormatter = require('./lib/help-formatter.cjs');
const readline = require('readline');
const { spawn } = require('child_process');

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

// Shorthand alias for COLORS to reduce verbosity in template strings
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
    name: 'sbb-svg2png',
    description: 'Render SVG to PNG with accurate bbox',
    example: 'sbb-svg2png input.svg output.png --scale 2',
    category: 'Core'
  },
  {
    name: 'sbb-fix-viewbox',
    description: 'Repair missing/broken viewBox using visual bbox',
    example: 'sbb-fix-viewbox broken.svg fixed.svg',
    category: 'Core'
  },
  {
    name: 'sbb-compare',
    description: 'Visual diff between SVGs (pixel comparison)',
    example: 'sbb-compare a.svg b.svg diff.png',
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
 * Render the multi-line "suite menu" — every sub-tool grouped by category
 * with a numeric prefix matching the interactive prompt index. Returned as
 * a complete formatted section (header rule + body) so it can be printed
 * verbatim after the unified help screen without losing line breaks to the
 * notes-section word wrapper.
 * @returns {string}
 */
function buildSuiteMenu() {
  /** @type {Record<string, string>} */
  const categories = {
    Core: 'Core tools (our visual bbox algorithm)',
    Chrome: "Chrome comparison tools (Chrome's .getBBox())",
    Inkscape: 'Inkscape comparison tools (Inkscape CLI)'
  };

  const lines = [];
  let toolNumber = 1;
  for (const [catKey, catLabel] of Object.entries(categories)) {
    lines.push('');
    lines.push(`  ${c.magenta}${c.bold}${catLabel}:${c.reset}`);
    const toolsInCategory = TOOLS.filter((t) => t.category === catKey);
    for (const tool of toolsInCategory) {
      const idx = String(toolNumber).padStart(2, ' ');
      lines.push(`    ${c.yellow}${idx}.${c.reset} ${c.cyan}${c.bold}${tool.name}${c.reset}`);
      lines.push(`        ${tool.description}`);
      lines.push(`        ${c.dim}Example: ${tool.example}${c.reset}`);
      toolNumber++;
    }
  }

  lines.push('');
  lines.push('  Naming convention:');
  lines.push(`    ${c.dim}sbb-<function>${c.reset}           Our reliable visual bbox algorithm`);
  lines.push(
    `    ${c.dim}sbb-chrome-<function>${c.reset}    Chrome's .getBBox() method (for comparison)`
  );
  lines.push(`    ${c.dim}sbb-inkscape-<function>${c.reset}  Inkscape tools (for comparison)`);
  lines.push('');
  lines.push(
    `  Run any command with ${c.green}--help${c.reset} for detailed usage ` +
      `(e.g. "npx sbb-getbbox --help").`
  );
  lines.push(
    `  Or run "${c.green}npx svg-bbox${c.reset}" with no arguments for an interactive picker.`
  );

  // Section title + rule, body follows. Mirrors helpFormatter's renderSection
  // shape so the menu reads as a first-class section, not a tacked-on dump.
  const title = 'AVAILABLE COMMANDS';
  const rule = '─'.repeat(title.length);
  return `${title}\n${rule}${lines.join('\n')}`;
}

/**
 * Print the main help message with available commands and usage examples.
 * Renders the unified branded help screen, then prints the colored suite
 * menu (kept outside `renderHelp` because the formatter's notes-section
 * word-wrap would flatten the tabular layout). When invoked with no args,
 * the caller drops into promptToolSelection() for an interactive picker.
 * @returns {void}
 */
function printHelp() {
  console.log(
    helpFormatter.renderHelp({
      toolName: 'svg-bbox',
      tagline:
        'A toolkit for computing and using SVG bounding boxes you can trust — ' +
        'launcher for the full sbb-* command suite.',
      description:
        'svg-bbox is the umbrella entry point for a suite of CLI tools that compute, ' +
        'extract, render, repair, and compare SVG content using a pixel-accurate visual ' +
        "bbox algorithm (and, for cross-checking, Chrome's native .getBBox() and " +
        "Inkscape's CLI). Run with --help to see the suite menu below; run with no " +
        'arguments for an interactive picker that forwards --help to your chosen tool.',
      usage: [
        'svg-bbox                          # interactive tool picker',
        'svg-bbox --help                   # show this suite menu',
        'svg-bbox --version                # print version',
        'npx <sbb-tool> [args] [options]   # run a specific tool directly'
      ],
      examples: [
        {
          title: 'Show this menu and pick a tool interactively:',
          command: 'npx svg-bbox'
        },
        {
          title: 'Get bounding-box info for an SVG (JSON output):',
          command: 'npx sbb-getbbox myfile.svg --json'
        },
        {
          title: 'List every drawable object in an SVG with a visual catalog:',
          command: 'npx sbb-extract myfile.svg --list'
        },
        {
          title: 'Render an SVG to PNG at 2x scale:',
          command: 'npx sbb-svg2png myfile.svg myfile.png --scale 2'
        },
        {
          title: 'Repair an SVG that is missing viewBox/width/height:',
          command: 'npx sbb-fix-viewbox broken.svg fixed.svg'
        },
        {
          title: 'Read the help screen of any sub-tool:',
          command: 'npx sbb-compare --help'
        }
      ],
      commonOptions: helpFormatter.DEFAULT_COMMON_OPTIONS,
      environment: { inkscape: true },
      exitCodes: [
        [0, 'Success — help shown or interactive picker exited cleanly'],
        [1, 'Unknown argument or invalid interactive selection']
      ]
    })
  );

  // Suite menu (outside renderHelp because the notes-section word wrapper
  // would flatten the tabular layout into one long paragraph).
  console.log(buildSuiteMenu());
  console.log();
}

/**
 * Print version information from package.json.
 * @returns {void}
 */
function printVersionInfo() {
  const version = getVersion();
  console.log(`svg-bbox v${version}`);
}

/**
 * Interactive tool selection prompt.
 * Asks user to enter a tool number (1-12, matching TOOLS.length) and displays help for that tool.
 * Only works in TTY (terminal) mode; exits silently if not a TTY.
 * @returns {void}
 */
function promptToolSelection() {
  // VALIDATION: Check if running in interactive TTY mode
  // WHY: readline.question hangs indefinitely when stdin is not a TTY (e.g., piped input)
  if (!process.stdin.isTTY) {
    process.exit(0);
  }

  // WHY: Print the picker prompt here (not inside printHelp) so the prompt
  // only appears when we are actually about to read input. Keeps --help and
  // the interactive launcher visually distinct.
  console.log(
    `${c.cyan}Enter a number (1-${TOOLS.length}) to see detailed help for that tool, ` +
      `or press Ctrl+C to exit:${c.reset}`
  );

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
    // Guard clause for defensive programming - bounds already checked above but array access could theoretically fail
    if (!selectedTool) {
      printError('Tool not found. This should never happen.');
      process.exit(1);
    }
    console.log(`\n${c.green}Showing help for: ${c.bold}${selectedTool.name}${c.reset}\n`);

    // Execute the tool with --help flag
    // Use path.join(__dirname, ...) to resolve path correctly when installed via npm
    const toolPath = path.join(__dirname, `${selectedTool.name}.cjs`);
    const toolProcess = spawn('node', [toolPath, '--help'], {
      stdio: 'inherit'
    });

    toolProcess.on('close', (code) => {
      process.exit(code);
    });
  });
}

/**
 * Main entry point for the svg-bbox CLI wrapper.
 * Handles --version, --help flags and starts interactive tool selection.
 * @returns {void}
 */
function main() {
  printBanner('svg-bbox', { quiet: false, json: false });
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
  console.log(`  ${c.green}npx sbb-svg2png${c.reset} ${args.join(' ')}`);
  process.exit(1);
}

main();
