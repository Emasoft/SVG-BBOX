#!/usr/bin/env node
/**
 * Post-install script for svg-bbox
 * Displays a welcome message with available CLI tools and examples
 */

'use strict';

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  white: '\x1b[37m'
};

const c = colors;

// Get version from package.json
let version = '1.0.14';
try {
  const pkg = require('../package.json');
  version = pkg.version;
} catch {
  // Ignore - use default version
}

// Box drawing characters
const box = {
  tl: '\u2554', // ╔
  tr: '\u2557', // ╗
  bl: '\u255a', // ╚
  br: '\u255d', // ╝
  h: '\u2550', // ═
  v: '\u2551' // ║
};

const width = 72;
const innerWidth = width - 4;

function line(char = box.h) {
  return char.repeat(width - 2);
}

/**
 * Format a row with box borders and content
 * @param {string} content - The content to display in the row
 * @returns {string} Formatted row with box borders
 */
function row(content) {
  // eslint-disable-next-line no-control-regex
  const stripped = content.replace(/\x1b\[[0-9;]*m/g, '');
  const padding = innerWidth - stripped.length;
  return `${box.v} ${content}${' '.repeat(Math.max(0, padding))} ${box.v}`;
}

// CLI tools data
const tools = [
  {
    name: 'svg-bbox',
    desc: 'Main entry point - shows all available commands',
    example: 'svg-bbox --help'
  },
  {
    name: 'sbb-getbbox',
    desc: 'Get pixel-accurate bounding box of SVG elements',
    example: 'sbb-getbbox icon.svg'
  },
  {
    name: 'sbb-extract',
    desc: 'List, rename, or extract individual objects from SVG',
    example: 'sbb-extract drawing.svg --list'
  },
  {
    name: 'sbb-svg2png',
    desc: 'Convert SVG to PNG with accurate bounding box',
    example: 'sbb-svg2png icon.svg output.png'
  },
  {
    name: 'sbb-fix-viewbox',
    desc: 'Fix or regenerate SVG viewBox attribute',
    example: 'sbb-fix-viewbox broken.svg fixed.svg'
  },
  {
    name: 'sbb-compare',
    desc: 'Compare two SVGs visually and generate diff report',
    example: 'sbb-compare original.svg modified.svg'
  },
  {
    name: 'sbb-test',
    desc: 'Run visual regression tests on SVG files',
    example: 'sbb-test ./svg-folder/'
  },
  {
    name: 'sbb-chrome-getbbox',
    desc: 'Get bbox using Chrome/Puppeteer (default engine)',
    example: 'sbb-chrome-getbbox icon.svg --json'
  },
  {
    name: 'sbb-chrome-extract',
    desc: 'Extract objects using Chrome/Puppeteer',
    example: 'sbb-chrome-extract drawing.svg --output ./out/'
  },
  {
    name: 'sbb-inkscape-getbbox',
    desc: 'Get bbox using Inkscape (requires Inkscape installed)',
    example: 'sbb-inkscape-getbbox icon.svg'
  },
  {
    name: 'sbb-inkscape-extract',
    desc: 'Extract objects using Inkscape',
    example: 'sbb-inkscape-extract drawing.svg --output ./out/'
  },
  {
    name: 'sbb-inkscape-text2path',
    desc: 'Convert text to paths using Inkscape',
    example: 'sbb-inkscape-text2path text.svg output.svg'
  },
  {
    name: 'sbb-inkscape-svg2png',
    desc: 'Convert SVG to PNG using Inkscape',
    example: 'sbb-inkscape-svg2png icon.svg output.png'
  }
];

// Print the welcome message
function printWelcome() {
  console.log('');
  console.log(`${c.cyan}${box.tl}${line()}${box.tr}${c.reset}`);
  console.log(row(''));
  console.log(
    row(
      `${c.cyan}${c.bold}  svg-bbox${c.reset} ${c.dim}v${version}${c.reset}  ${c.green}installed successfully!${c.reset}`
    )
  );
  console.log(row(`${c.dim}  A toolkit for computing SVG bounding boxes you can trust${c.reset}`));
  console.log(row(''));
  console.log(`${c.cyan}${box.v}${line()}${box.v}${c.reset}`);
  console.log(row(''));
  console.log(row(`${c.yellow}${c.bold}AVAILABLE CLI COMMANDS:${c.reset}`));
  console.log(row(''));

  // Core tools section
  console.log(row(`${c.magenta}${c.bold}Core Tools (Our Visual BBox Algorithm):${c.reset}`));
  console.log(row(''));

  const coreTools = tools.slice(0, 7);
  coreTools.forEach((tool, i) => {
    console.log(row(`  ${c.yellow}${i + 1}.${c.reset} ${c.cyan}${c.bold}${tool.name}${c.reset}`));
    console.log(row(`     ${c.white}${tool.desc}${c.reset}`));
    console.log(row(`     ${c.dim}$ ${tool.example}${c.reset}`));
    console.log(row(''));
  });

  // Alternative engines section
  console.log(row(`${c.magenta}${c.bold}Alternative Engines:${c.reset}`));
  console.log(row(''));

  const altTools = tools.slice(7);
  altTools.forEach((tool, i) => {
    console.log(row(`  ${c.yellow}${i + 8}.${c.reset} ${c.cyan}${c.bold}${tool.name}${c.reset}`));
    console.log(row(`     ${c.white}${tool.desc}${c.reset}`));
    console.log(row(`     ${c.dim}$ ${tool.example}${c.reset}`));
    console.log(row(''));
  });

  console.log(row(`${c.green}${c.bold}Quick Start:${c.reset}`));
  console.log(
    row(
      `  ${c.dim}$${c.reset} ${c.cyan}svg-bbox --help${c.reset}          ${c.dim}# Show all commands${c.reset}`
    )
  );
  console.log(
    row(
      `  ${c.dim}$${c.reset} ${c.cyan}sbb-getbbox icon.svg${c.reset}     ${c.dim}# Get bounding box${c.reset}`
    )
  );
  console.log(
    row(
      `  ${c.dim}$${c.reset} ${c.cyan}sbb-extract file.svg -l${c.reset}  ${c.dim}# List all objects${c.reset}`
    )
  );
  console.log(row(''));
  console.log(row(`${c.dim}Documentation: https://github.com/Emasoft/SVG-BBOX${c.reset}`));
  console.log(row(''));
  console.log(`${c.cyan}${box.bl}${line()}${box.br}${c.reset}`);
  console.log('');
}

// Only run if this script is executed directly (not required)
// and not in CI/silent mode
if (require.main === module) {
  // Skip in CI environments or when npm is run with --silent/--quiet
  const isCI = process.env.CI === 'true' || process.env.CI === '1';
  const isSilent =
    process.env.npm_config_loglevel === 'silent' ||
    process.env.npm_config_loglevel === 'error' ||
    process.env.npm_config_loglevel === 'warn';

  if (!isCI && !isSilent) {
    printWelcome();
  }
}

module.exports = { printWelcome };
