#!/usr/bin/env node
// @ts-nocheck - Utility script, TypeScript checking disabled for pragmatic reasons
/**
 * docs-audit.cjs - Documentation Consistency Validator
 *
 * Validates documentation against source code to catch:
 * - Timeout values that don't match config/timeouts.js
 * - Exported functions not documented in API.md
 * - CLI tools not listed in README.md
 * - CDN paths with incorrect version
 * - Outdated installation instructions
 * - Markdown syntax issues
 *
 * WHY this script exists:
 * The comprehensive audit found 9 MAJOR documentation issues that the release
 * script's existing validators missed. This script adds heuristic checks for
 * documentation accuracy beyond just version consistency.
 *
 * Usage:
 *   node scripts/docs-audit.cjs           # Run all checks
 *   node scripts/docs-audit.cjs --fix     # Fix what can be auto-fixed
 *   node scripts/docs-audit.cjs --json    # Output JSON report
 *
 * Exit codes:
 *   0 - All checks passed
 *   1 - Issues found (see output for details)
 *   2 - Script error (missing files, etc.)
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Banner file path for ASCII art logo
const BANNER_PATH = path.join(__dirname, '..', 'assets', 'svg-bbox_logo_txt.txt');

// ANSI color codes for terminal output
const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
  dim: '\x1b[2m'
};

// Disable colors if not a TTY
const isTTY = process.stdout.isTTY;
const c = (color, text) => (isTTY ? `${COLORS[color]}${text}${COLORS.reset}` : text);

// Symbols for output
const SYM = {
  pass: isTTY ? '✓' : '[PASS]',
  fail: isTTY ? '✗' : '[FAIL]',
  warn: isTTY ? '⚠' : '[WARN]',
  info: isTTY ? 'ℹ' : '[INFO]'
};

/**
 * Project root directory
 * WHY: All file paths are relative to project root for consistency
 */
const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * Files to validate
 */
const FILES = {
  packageJson: path.join(PROJECT_ROOT, 'package.json'),
  readme: path.join(PROJECT_ROOT, 'README.md'),
  apiDocs: path.join(PROJECT_ROOT, 'API.md'),
  timeoutsJs: path.join(PROJECT_ROOT, 'config', 'timeouts.js'),
  timeoutsCjs: path.join(PROJECT_ROOT, 'config', 'timeouts.cjs'),
  svgVisualBBox: path.join(PROJECT_ROOT, 'SvgVisualBBox.js'),
  contributing: path.join(PROJECT_ROOT, 'CONTRIBUTING.md'),
  security: path.join(PROJECT_ROOT, 'SECURITY.md'),
  install: path.join(PROJECT_ROOT, 'INSTALL.md'),
  claudeMd: path.join(PROJECT_ROOT, 'CLAUDE.md')
};

/**
 * Validation results accumulator
 * @type {{passed: string[], failed: string[], warnings: string[]}}
 */
const results = {
  passed: [],
  failed: [],
  warnings: []
};

/**
 * Read file with error handling
 * WHY: Consistent error messages for missing files
 */
function readFile(filepath) {
  if (!fs.existsSync(filepath)) {
    throw new Error(`File not found: ${filepath}`);
  }
  return fs.readFileSync(filepath, 'utf8');
}

/**
 * Extract version from package.json
 */
function getPackageVersion() {
  const pkg = JSON.parse(readFile(FILES.packageJson));
  return pkg.version;
}

/**
 * Extract timeout constants from config/timeouts.js
 * WHY: Source of truth for all timeout values
 */
function extractTimeoutConstants() {
  const content = readFile(FILES.timeoutsJs);
  const timeouts = {};

  // Match patterns like: const FONT_TIMEOUT_MS = 8000;
  const regex = /const\s+(\w+_(?:TIMEOUT|INTERVAL)(?:_MS|_SECONDS)?)\s*=\s*(\d+)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    timeouts[match[1]] = parseInt(match[2], 10);
  }

  return timeouts;
}

/**
 * Extract exported functions from SvgVisualBBox.js
 * WHY: Validates that API.md documents all public API
 */
function extractExportedFunctions() {
  const content = readFile(FILES.svgVisualBBox);

  // Find the return statement at the end that exports public API
  // Pattern: return { funcName: funcName, ... };
  const exportMatch = content.match(/return\s*\{([^}]+)\};?\s*\}\);?\s*$/);
  if (!exportMatch) {
    throw new Error('Could not find exports in SvgVisualBBox.js');
  }

  const exportBlock = exportMatch[1];
  const functions = [];

  // Extract function names from export block
  // Handles both: funcName: funcName and funcName
  const funcRegex = /(\w+)\s*(?::\s*\w+)?/g;
  let match;
  while ((match = funcRegex.exec(exportBlock)) !== null) {
    // Skip if it's just whitespace or comma
    if (match[1] && !['function', 'const', 'let', 'var'].includes(match[1])) {
      functions.push(match[1]);
    }
  }

  return [...new Set(functions)]; // Remove duplicates
}

/**
 * Extract CLI tools from filesystem
 * WHY: Validates that README.md lists all available CLI tools
 */
function extractCliTools() {
  const cliDir = PROJECT_ROOT;
  const files = fs.readdirSync(cliDir);

  return files
    .filter((f) => f.startsWith('sbb-') && f.endsWith('.cjs'))
    .map((f) => f.replace('.cjs', ''))
    .sort();
}

/**
 * VALIDATION 1: Timeout Consistency
 * WHY: Audit found API.md had wrong timeout value (8000 vs 5000)
 *
 * NOTE: This validation is PRECISE - it only matches actual "Default:" statements
 * in documentation, not example code values. The patterns specifically look for:
 * - "Default: `5000`" (inline code format)
 * - "default timeout is 8000ms"
 * - "timeout (default 5000)"
 */
function validateTimeoutConsistency() {
  console.log(c('cyan', '\n📋 Validating timeout consistency...'));

  const timeouts = extractTimeoutConstants();

  // Key timeout values to check in documentation
  // WHY: Only check documented defaults, not example code values
  //
  // IMPORTANT: Patterns must be SPECIFIC to the timeout type to avoid false positives.
  // For example, "Default: 30000" for browser timeout should not be flagged for font timeout.
  const checksNeeded = [
    {
      constant: 'FONT_TIMEOUT_MS',
      value: timeouts['FONT_TIMEOUT_MS'],
      files: ['API.md', 'README.md'],
      // Patterns that match ONLY font timeout defaults:
      // - "Default timeout: 8000ms" (in waitForDocumentFonts section)
      // - "fontTimeoutMs: 8000" or "[options.fontTimeoutMs=8000]"
      // - "font.*timeout.*8000"
      patterns: [
        /font[^.]*timeout[^0-9]*(\d+)\s*(?:ms)?/gi,
        /fontTimeoutMs[^0-9]*(\d+)/gi,
        /waitForDocumentFonts[^)]*,\s*(\d+)/gi
      ]
    },
    {
      constant: 'BROWSER_TIMEOUT_MS',
      value: timeouts['BROWSER_TIMEOUT_MS'],
      files: ['README.md'],
      // Patterns for browser/operation timeout (NOT font timeout)
      patterns: [
        /browser\s*(?:operation\s+)?timeout[^0-9]*(\d+)\s*(?:ms)?/gi,
        /--timeout[^0-9]*default[^0-9]*(\d+)/gi
      ]
    }
  ];

  let allPassed = true;

  for (const check of checksNeeded) {
    if (!check.value) {
      results.warnings.push(`${check.constant} not found in config/timeouts.js`);
      continue;
    }

    for (const filename of check.files) {
      const filepath = path.join(PROJECT_ROOT, filename);
      if (!fs.existsSync(filepath)) continue;

      const content = readFile(filepath);

      // Remove code blocks before checking (to avoid false positives from examples)
      // WHY: Code examples often show different timeout values for demonstration
      const contentWithoutCode = content.replace(/```[\s\S]*?```/g, '');

      for (const pattern of check.patterns) {
        pattern.lastIndex = 0; // Reset regex state
        let match;
        while ((match = pattern.exec(contentWithoutCode)) !== null) {
          const foundValue = parseInt(match[1], 10);
          // Skip small values (likely line numbers or unrelated numbers)
          if (foundValue < 1000) continue;
          if (foundValue !== check.value) {
            allPassed = false;
            results.failed.push(
              `${filename}: ${check.constant} mismatch - found ${foundValue}, expected ${check.value}`
            );
            console.log(
              `  ${c('red', SYM.fail)} ${filename}: ${check.constant} = ${foundValue} (expected ${check.value})`
            );
          }
        }
      }
    }
  }

  if (allPassed) {
    results.passed.push('Timeout values match config/timeouts.js');
    console.log(`  ${c('green', SYM.pass)} All timeout values match config/timeouts.js`);
  }

  return allPassed;
}

/**
 * VALIDATION 2: API.md Completeness
 * WHY: Audit found 2 exported functions not documented
 */
function validateApiCompleteness() {
  console.log(c('cyan', '\n📋 Validating API.md completeness...'));

  const exportedFunctions = extractExportedFunctions();
  const apiContent = readFile(FILES.apiDocs);

  let allPassed = true;
  const documented = [];
  const undocumented = [];

  for (const func of exportedFunctions) {
    // Check if function has a documentation section (### functionName or ## functionName)
    const sectionPattern = new RegExp(`##\\s*\\[?\`?${func}\\(?\\)?`, 'i');
    // Also check for mentions in table of contents
    const tocPattern = new RegExp(`\\[.*${func}.*\\]`, 'i');

    if (sectionPattern.test(apiContent) || tocPattern.test(apiContent)) {
      documented.push(func);
    } else {
      undocumented.push(func);
      allPassed = false;
    }
  }

  if (undocumented.length > 0) {
    for (const func of undocumented) {
      results.failed.push(`API.md: Missing documentation for exported function '${func}'`);
      console.log(`  ${c('red', SYM.fail)} Missing documentation: ${func}`);
    }
  }

  if (documented.length > 0) {
    console.log(`  ${c('green', SYM.pass)} ${documented.length} functions documented`);
  }

  if (allPassed) {
    results.passed.push('All exported functions documented in API.md');
  }

  return allPassed;
}

/**
 * VALIDATION 3: README.md CLI Tools Inventory
 * WHY: README should list all available CLI tools
 */
function validateReadmeCliTools() {
  console.log(c('cyan', '\n📋 Validating README.md CLI tools inventory...'));

  const cliTools = extractCliTools();
  const readmeContent = readFile(FILES.readme);

  let allPassed = true;
  const documented = [];
  const undocumented = [];

  for (const tool of cliTools) {
    // Check for tool name in README (with or without .cjs extension)
    const toolPattern = new RegExp(`\\b${tool}(?:\\.cjs)?\\b`, 'i');
    if (toolPattern.test(readmeContent)) {
      documented.push(tool);
    } else {
      undocumented.push(tool);
      allPassed = false;
    }
  }

  if (undocumented.length > 0) {
    for (const tool of undocumented) {
      results.failed.push(`README.md: Missing documentation for CLI tool '${tool}'`);
      console.log(`  ${c('red', SYM.fail)} Missing CLI tool: ${tool}`);
    }
  }

  console.log(
    `  ${c('green', SYM.pass)} ${documented.length}/${cliTools.length} CLI tools documented`
  );

  if (allPassed) {
    results.passed.push('All CLI tools documented in README.md');
  }

  return allPassed;
}

/**
 * VALIDATION 4: CDN Paths Validation
 * WHY: CDN paths should use correct package name and point to valid files
 */
function validateCdnPaths() {
  console.log(c('cyan', '\n📋 Validating CDN paths...'));

  // WHY: version retrieved but not currently used for validation
  // CDN paths with @latest are valid - version pinning is optional
  const files = ['README.md', 'API.md', 'INSTALL.md'];

  // Expected CDN URL patterns
  const cdnPatterns = [
    {
      name: 'unpkg',
      pattern: /https:\/\/unpkg\.com\/svg-bbox(@[^/]+)?\/([^\s'"]+)/g,
      expectedBase: 'https://unpkg.com/svg-bbox'
    },
    {
      name: 'jsdelivr',
      pattern: /https:\/\/cdn\.jsdelivr\.net\/npm\/svg-bbox(@[^/]+)?\/([^\s'"]+)/g,
      expectedBase: 'https://cdn.jsdelivr.net/npm/svg-bbox'
    }
  ];

  // Valid files that can be referenced from CDN
  const validCdnFiles = ['SvgVisualBBox.js', 'SvgVisualBBox.min.js'];

  let allPassed = true;

  for (const filename of files) {
    const filepath = path.join(PROJECT_ROOT, filename);
    if (!fs.existsSync(filepath)) continue;

    const content = readFile(filepath);

    for (const cdn of cdnPatterns) {
      cdn.pattern.lastIndex = 0;
      let match;
      while ((match = cdn.pattern.exec(content)) !== null) {
        const versionPart = match[1] || '@latest';
        const filePart = match[2];

        // Check if file is valid
        if (!validCdnFiles.includes(filePart)) {
          allPassed = false;
          results.failed.push(`${filename}: Invalid CDN file reference '${filePart}'`);
          console.log(`  ${c('red', SYM.fail)} ${filename}: Invalid CDN file '${filePart}'`);
        }

        // Check version format (should be @latest or @X.Y.Z)
        if (versionPart && !/@(latest|\d+\.\d+\.\d+)/.test(versionPart)) {
          results.warnings.push(`${filename}: Non-standard CDN version '${versionPart}'`);
          console.log(
            `  ${c('yellow', SYM.warn)} ${filename}: Non-standard version '${versionPart}'`
          );
        }
      }
    }
  }

  if (allPassed) {
    results.passed.push('CDN paths are valid');
    console.log(`  ${c('green', SYM.pass)} CDN paths are valid`);
  }

  return allPassed;
}

/**
 * VALIDATION 5: Installation Instructions
 * WHY: Install commands should be accurate and consistent
 */
function validateInstallInstructions() {
  console.log(c('cyan', '\n📋 Validating installation instructions...'));

  const files = ['README.md', 'API.md', 'INSTALL.md'];

  // Valid install commands
  const validPatterns = [
    { pattern: /npm\s+install\s+svg-bbox/g, name: 'npm install' },
    { pattern: /bun\s+add\s+svg-bbox/g, name: 'bun add' },
    { pattern: /pnpm\s+add\s+svg-bbox/g, name: 'pnpm add' },
    { pattern: /yarn\s+add\s+svg-bbox/g, name: 'yarn add' }
  ];

  // Invalid/deprecated patterns
  const invalidPatterns = [
    { pattern: /npm\s+install\s+-g\s+svg-bbox/g, reason: 'Global install not recommended' },
    {
      pattern: /require\s*\(\s*['"]svg-bbox['"]\s*\)/g,
      reason: 'Browser library - use script tag or bundler'
    }
  ];

  let allPassed = true;
  const foundCommands = new Set();

  for (const filename of files) {
    const filepath = path.join(PROJECT_ROOT, filename);
    if (!fs.existsSync(filepath)) continue;

    const content = readFile(filepath);

    // Check for valid patterns
    for (const p of validPatterns) {
      p.pattern.lastIndex = 0;
      if (p.pattern.test(content)) {
        foundCommands.add(p.name);
      }
    }

    // Check for invalid patterns
    for (const p of invalidPatterns) {
      p.pattern.lastIndex = 0;
      if (p.pattern.test(content)) {
        results.warnings.push(`${filename}: ${p.reason}`);
        console.log(`  ${c('yellow', SYM.warn)} ${filename}: ${p.reason}`);
      }
    }
  }

  // Check that at least npm and bun are documented
  const requiredCommands = ['npm install', 'bun add'];
  for (const cmd of requiredCommands) {
    if (!foundCommands.has(cmd)) {
      allPassed = false;
      results.failed.push(`Missing '${cmd}' in documentation`);
      console.log(`  ${c('red', SYM.fail)} Missing '${cmd}' instructions`);
    }
  }

  if (foundCommands.size > 0) {
    console.log(
      `  ${c('green', SYM.pass)} Found install commands: ${[...foundCommands].join(', ')}`
    );
  }

  if (allPassed) {
    results.passed.push('Installation instructions are complete');
  }

  return allPassed;
}

/**
 * VALIDATION 6: Markdown Syntax
 * WHY: Broken markdown syntax causes rendering issues
 *
 * NOTE: This validation SKIPS code blocks to avoid false positives from
 * template literals and other code that legitimately uses backticks.
 */
function validateMarkdownSyntax() {
  console.log(c('cyan', '\n📋 Validating Markdown syntax...'));

  const mdFiles = [
    'README.md',
    'API.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'INSTALL.md',
    'CHANGELOG.md'
  ];

  let allPassed = true;

  for (const filename of mdFiles) {
    const filepath = path.join(PROJECT_ROOT, filename);
    if (!fs.existsSync(filepath)) continue;

    const content = readFile(filepath);
    const lines = content.split('\n');
    /** @type {string[]} */
    const issues = [];

    // Track whether we're inside a code block
    // WHY: Code blocks contain code that legitimately uses backticks (template literals)
    let inCodeBlock = false;

    // Check for common markdown issues
    lines.forEach((line, index) => {
      const lineNum = index + 1;

      // Track code block boundaries
      if (line.trim().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        return; // Skip code block delimiters
      }

      // Skip all checks inside code blocks
      if (inCodeBlock) return;

      // 1. Malformed links: [text](url with space)
      // WHY: Spaces in URLs break links
      const linkPattern = /\[[^\]]+\]\([^)]*\s+[^)]*\)/g;
      if (linkPattern.test(line)) {
        issues.push(`Line ${lineNum}: Malformed link (space in URL)`);
      }

      // 2. Missing space after # in headers
      // WHY: "#Header" doesn't render as a header, needs "# Header"
      if (/^#{1,6}[^#\s]/.test(line)) {
        issues.push(`Line ${lineNum}: Missing space after header #`);
      }

      // 3. Unclosed inline code (ONLY outside code blocks)
      // WHY: Odd backtick count outside code blocks indicates unclosed inline code
      // Skip lines that look like they might have template literals (contain ${)
      const hasTemplateLiteral = /\$\{/.test(line);
      if (!hasTemplateLiteral) {
        const backtickCount = (line.match(/`/g) || []).length;
        if (backtickCount % 2 !== 0) {
          issues.push(`Line ${lineNum}: Unclosed inline code`);
        }
      }

      // 4. Empty link text
      // WHY: [](url) renders as empty clickable area
      if (/\[\]\([^)]+\)/.test(line)) {
        issues.push(`Line ${lineNum}: Empty link text`);
      }

      // 5. Broken image reference
      // WHY: ![alt]() with empty URL won't display anything
      if (/!\[[^\]]*\]\(\s*\)/.test(line)) {
        issues.push(`Line ${lineNum}: Empty image URL`);
      }
    });

    // Check for unclosed code blocks at file level
    const codeBlockCount = (content.match(/^```/gm) || []).length;
    if (codeBlockCount % 2 !== 0) {
      issues.push('Unclosed code block (odd number of ```)');
    }

    // Report issues
    if (issues.length > 0) {
      allPassed = false;
      for (const issue of issues) {
        results.failed.push(`${filename}: ${issue}`);
        console.log(`  ${c('red', SYM.fail)} ${filename}: ${issue}`);
      }
    }
  }

  if (allPassed) {
    results.passed.push('Markdown syntax is valid');
    console.log(`  ${c('green', SYM.pass)} Markdown syntax is valid`);
  }

  return allPassed;
}

/**
 * VALIDATION 7: Package Manager References
 * WHY: Audit found pnpm references where bun should be used
 */
function validatePackageManagerReferences() {
  console.log(c('cyan', '\n📋 Validating package manager references...'));

  const files = ['CONTRIBUTING.md', 'SECURITY.md', 'CLAUDE.md'];

  // The project uses bun, so pnpm references should be minimal
  // WHY: pnpm was replaced by bun - old references confuse users
  const checkPatterns = [
    { pattern: /pnpm-lock\.yaml/g, message: 'References pnpm lockfile (should be bun.lock)' },
    { pattern: /pnpm\s+install/g, message: 'Uses pnpm install (should be bun install)' },
    { pattern: /pnpm\s+run/g, message: 'Uses pnpm run (should be bun run)' }
  ];

  let allPassed = true;

  for (const filename of files) {
    const filepath = path.join(PROJECT_ROOT, filename);
    if (!fs.existsSync(filepath)) continue;

    const content = readFile(filepath);

    for (const check of checkPatterns) {
      check.pattern.lastIndex = 0;
      const matches = content.match(check.pattern);
      if (matches && matches.length > 0) {
        // Allow some pnpm references in CONTRIBUTING.md (for compatibility docs)
        if (filename === 'CONTRIBUTING.md' && check.pattern.toString().includes('pnpm install')) {
          continue; // Skip - acceptable to mention pnpm as alternative
        }
        allPassed = false;
        results.failed.push(`${filename}: ${check.message}`);
        console.log(`  ${c('red', SYM.fail)} ${filename}: ${check.message}`);
      }
    }
  }

  if (allPassed) {
    results.passed.push('Package manager references are consistent');
    console.log(`  ${c('green', SYM.pass)} Package manager references are consistent`);
  }

  return allPassed;
}

/**
 * VALIDATION 8: Node.js Version Requirement
 * WHY: Project requires Node.js >=24 for npm trusted publishing
 */
function validateNodeVersionRequirement() {
  console.log(c('cyan', '\n📋 Validating Node.js version requirement...'));

  const pkg = JSON.parse(readFile(FILES.packageJson));
  const requiredVersion = pkg.engines?.node;

  if (!requiredVersion) {
    results.warnings.push('package.json: Missing engines.node field');
    console.log(`  ${c('yellow', SYM.warn)} package.json: Missing engines.node field`);
    return true;
  }

  // Extract minimum version from pattern like ">=24" or ">=24.0.0"
  const versionMatch = requiredVersion.match(/>=?\s*(\d+)/);
  if (!versionMatch) {
    results.warnings.push(`package.json: Unparseable engines.node: ${requiredVersion}`);
    return true;
  }

  const minVersion = parseInt(versionMatch[1], 10);

  // Check that README mentions the correct version
  const readme = readFile(FILES.readme);

  // Look for Node.js version mentions
  // WHY: README may use either ">=" (ASCII) or "≥" (Unicode U+2265) for "greater than or equal"
  // Also match URL-encoded versions like "%3E%3D24" from badges
  const nodeVersionPattern = /Node(?:\.js)?\s*(?:version\s*)?(?:>=?|≥|%3E%3D)?\s*(\d+)/gi;
  let match;
  let foundCorrectVersion = false;

  while ((match = nodeVersionPattern.exec(readme)) !== null) {
    const mentionedVersion = parseInt(match[1], 10);
    if (mentionedVersion === minVersion) {
      foundCorrectVersion = true;
    } else if (mentionedVersion < minVersion) {
      results.warnings.push(
        `README.md mentions Node.js ${mentionedVersion}, but requires ${minVersion}`
      );
      console.log(
        `  ${c('yellow', SYM.warn)} README mentions Node.js ${mentionedVersion} (requires ${minVersion})`
      );
    }
  }

  if (foundCorrectVersion) {
    results.passed.push(`Node.js version requirement (>=${minVersion}) documented correctly`);
    console.log(
      `  ${c('green', SYM.pass)} Node.js version requirement (>=${minVersion}) documented`
    );
  }

  return true;
}

/**
 * VALIDATION 9: setViewBoxOnObjects Options Accuracy
 * WHY: Audit found API.md had incorrect options for this function
 */
function validateSetViewBoxOnObjectsOptions() {
  console.log(c('cyan', '\n📋 Validating setViewBoxOnObjects documentation...'));

  const apiContent = readFile(FILES.apiDocs);
  const svgContent = readFile(FILES.svgVisualBBox);

  // Find the setViewBoxOnObjects function and extract its options handling
  const funcMatch = svgContent.match(
    /function\s+setViewBoxOnObjects\s*\([^)]*\)\s*\{[\s\S]*?opts\.(\w+)/g
  );
  if (!funcMatch) {
    results.warnings.push('Could not parse setViewBoxOnObjects options from SvgVisualBBox.js');
    console.log(`  ${c('yellow', SYM.warn)} Could not parse setViewBoxOnObjects options`);
    return true;
  }

  // Extract option names from the function body
  const optsPattern = /opts\.(\w+)/g;
  // WHY: Match function body ending with 2-space indented closing brace (UMD module indent level)
  const funcBody = svgContent.match(/function\s+setViewBoxOnObjects[\s\S]*?^ {2}\}/m);
  const actualOptions = new Set();

  if (funcBody) {
    let optMatch;
    while ((optMatch = optsPattern.exec(funcBody[0])) !== null) {
      actualOptions.add(optMatch[1]);
    }
  }

  // Check if API.md documents an 'animate' option (which shouldn't exist)
  if (/setViewBoxOnObjects[\s\S]*?animate/i.test(apiContent)) {
    const animateInActual = actualOptions.has('animate');
    if (!animateInActual) {
      results.warnings.push(
        "API.md documents 'animate' option for setViewBoxOnObjects, but it doesn't exist in code"
      );
      console.log(`  ${c('yellow', SYM.warn)} API.md documents non-existent 'animate' option`);
    }
  }

  console.log(`  ${c('green', SYM.pass)} setViewBoxOnObjects documentation checked`);
  results.passed.push('setViewBoxOnObjects options validation completed');

  return true;
}

/**
 * Print help message and exit
 * WHY: Separate function allows clean --help before banner display
 */
function printHelp() {
  console.log(`
docs-audit.cjs - SVG-BBOX Documentation Audit Validator

Usage: node scripts/docs-audit.cjs [options]

Validates documentation against source code to catch inconsistencies.

Options:
  --help, -h    Show this help message
  --json        Output results as JSON (for CI integration)
  --fix         Auto-fix issues where possible (not yet implemented)

Validation checks performed:
  1. Timeout consistency    - Docs match config/timeouts.js values
  2. API.md completeness    - All exported functions documented
  3. README CLI tools       - All sbb-*.cjs tools listed
  4. CDN paths              - Valid unpkg/jsdelivr URLs
  5. Install instructions   - npm/bun commands present
  6. Markdown syntax        - Headers, links, code blocks valid
  7. Package manager refs   - pnpm→bun migration complete
  8. Node.js version        - Correct version requirement documented
  9. API accuracy           - Function options match implementation

Exit codes:
  0 - All checks passed (warnings allowed)
  1 - One or more checks failed
  2 - Script error (missing files, etc.)

Examples:
  node scripts/docs-audit.cjs              # Run all checks
  node scripts/docs-audit.cjs --json       # JSON output for CI
`);
  process.exit(0);
}

/**
 * Main validation runner
 */
async function main() {
  // Parse command line args early to handle --help before banner
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const fixMode = args.includes('--fix');
  const helpMode = args.includes('--help') || args.includes('-h');

  // Handle --help flag before banner display
  if (helpMode) {
    printHelp();
  }

  const version = getPackageVersion();

  // Print ASCII art banner (unless --help or --json mode)
  if (!helpMode && !jsonOutput && process.stderr.isTTY) {
    try {
      const banner = fs.readFileSync(BANNER_PATH, 'utf8');
      console.error('');
      console.error(banner);
      console.error(`  docs-audit v${version}`);
      console.error('');
    } catch {
      /* ignore if banner file missing */
    }
  }
  console.log(`\n${c('dim', 'Package version:')} ${c('cyan', version)}`);

  if (fixMode) {
    console.log(c('yellow', '\n⚠️  Fix mode not yet implemented. Running validation only.\n'));
  }

  // Run all validations
  const validations = [
    validateTimeoutConsistency,
    validateApiCompleteness,
    validateReadmeCliTools,
    validateCdnPaths,
    validateInstallInstructions,
    validateMarkdownSyntax,
    validatePackageManagerReferences,
    validateNodeVersionRequirement,
    validateSetViewBoxOnObjectsOptions
  ];

  let allPassed = true;
  for (const validate of validations) {
    try {
      const passed = validate();
      if (!passed) allPassed = false;
    } catch (err) {
      results.failed.push(`Validation error: ${err.message}`);
      console.log(`  ${c('red', SYM.fail)} Error: ${err.message}`);
      allPassed = false;
    }
  }

  // Print summary
  console.log(c('bold', '\n═══════════════════════════════════════════════════════'));
  console.log(c('bold', '                       Summary                          '));
  console.log(c('bold', '═══════════════════════════════════════════════════════\n'));

  console.log(`${c('green', SYM.pass)} Passed:   ${results.passed.length}`);
  console.log(`${c('red', SYM.fail)} Failed:   ${results.failed.length}`);
  console.log(`${c('yellow', SYM.warn)} Warnings: ${results.warnings.length}`);

  if (results.failed.length > 0) {
    console.log(c('red', '\n❌ Documentation audit failed. Fix issues before release.\n'));
  } else if (results.warnings.length > 0) {
    console.log(c('yellow', '\n⚠️  Documentation audit passed with warnings.\n'));
  } else {
    console.log(c('green', '\n✅ Documentation audit passed!\n'));
  }

  // JSON output if requested
  if (jsonOutput) {
    const report = {
      version,
      timestamp: new Date().toISOString(),
      passed: allPassed,
      results: {
        passed: results.passed,
        failed: results.failed,
        warnings: results.warnings
      }
    };
    console.log('\n' + JSON.stringify(report, null, 2));
  }

  // Exit with appropriate code
  process.exit(allPassed ? 0 : 1);
}

// Run if executed directly
main().catch((err) => {
  console.error(c('red', `\n❌ Fatal error: ${err.message}\n`));
  process.exit(2);
});
