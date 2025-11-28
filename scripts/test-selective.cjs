#!/usr/bin/env node
/**
 * Selective Test Runner
 *
 * Implements intelligent test selection based on changed files.
 * Directly implements the user's testing rules:
 *
 * TESTING RULE 1: If SvgVisualBBox library changed → run library tests + dependent tool tests
 * TESTING RULE 2: If a tool changed → run only that tool's tests
 *
 * Usage:
 *   node scripts/test-selective.cjs [base-ref] [options]
 *
 * Options:
 *   --dry-run, -d    Show what tests would run without executing them
 *   --debug          Enable detailed debug logging
 *
 * Examples:
 *   node scripts/test-selective.cjs           # Compare against HEAD (uncommitted changes)
 *   node scripts/test-selective.cjs HEAD~1    # Compare against previous commit
 *   node scripts/test-selective.cjs main      # Compare against main branch
 *   node scripts/test-selective.cjs --debug   # Run with debug logging
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const { GIT_DIFF_TIMEOUT_MS, VITEST_RUN_TIMEOUT_MS } = require('../config/timeouts.cjs');

const execFileAsync = promisify(execFile);

// Timestamp tracking for filesystem-based change detection
const TIMESTAMP_FILE = path.join(__dirname, '..', '.last-test-run');
const PYTHON_SCRIPT = path.join(__dirname, '..', 'scripts_dev', 'util_changed_tracked_files.py');

// ============================================================================
// Configuration Constants - Single Source of Truth
// ============================================================================

// Git configuration
const DEFAULT_GIT_BASE_REF = 'HEAD'; // Default comparison point for git diff

// Test execution configuration
// Timeout constants now imported from centralized config/timeouts.cjs
const MAX_EXEC_BUFFER_BYTES = 10 * 1024 * 1024; // 10MB buffer for vitest output
const RUN_ALL_TESTS_PATTERN = 'tests/**/*.test.js'; // Glob pattern to run all tests

// Logging configuration
const ENABLE_DEBUG = process.argv.includes('--debug');
const ENABLE_EMOJI = true; // Set to false if terminal doesn't support emoji

// UI symbols (configurable for non-emoji terminals)
const SYMBOLS = ENABLE_EMOJI
  ? {
      WARNING: '⚠️',
      TESTING: '🧪',
      SEARCH: '🔍',
      SUCCESS: '✅',
      INFO: 'ℹ️'
    }
  : {
      WARNING: '[!]',
      TESTING: '[TEST]',
      SEARCH: '[...]',
      SUCCESS: '[OK]',
      INFO: '[i]'
    };

// ============================================================================
// Logging Utilities
// ============================================================================

/**
 * Debug logging helper - only logs when --debug flag is enabled
 * @param {string} message - The debug message to log
 * @param {any} data - Optional data to log (will be JSON-stringified)
 */
function debug(message, data) {
  if (ENABLE_DEBUG) {
    const timestamp = new Date().toISOString();
    console.debug(`[DEBUG ${timestamp}] ${message}`);
    if (data !== undefined) {
      console.debug('  Data:', JSON.stringify(data, null, 2));
    }
  }
}

// ============================================================================
// Timestamp and Python Integration
// ============================================================================

/**
 * Read the last test run timestamp from .last-test-run file
 * @returns {Date|null} Last test run timestamp or null if file doesn't exist
 */
function getLastTestRunTimestamp() {
  try {
    const isoString = fs.readFileSync(TIMESTAMP_FILE, 'utf8').trim();
    return new Date(isoString);
  } catch (err) {
    if (err.code === 'ENOENT') {
      debug('No .last-test-run file found, will use all changed files');
      return null;
    }
    throw err;
  }
}

/**
 * Update the last test run timestamp to now
 */
function updateLastTestRunTimestamp() {
  const now = new Date().toISOString();
  fs.writeFileSync(TIMESTAMP_FILE, now, 'utf8');
  debug(`Updated .last-test-run timestamp to: ${now}`);
}

/**
 * Get changed files using Python script with filesystem timestamps
 * @param {boolean} stagedOnly - If true, only get staged files
 * @returns {Promise<string[]>} Array of changed file paths
 */
async function getChangedFilesViaPython(stagedOnly = true) {
  const lastRun = getLastTestRunTimestamp();

  if (!lastRun) {
    debug('No timestamp baseline, falling back to git-based detection');
    return null; // Fall back to git-based detection
  }

  const sinceISO = lastRun.toISOString();
  debug(`Checking for files changed since: ${sinceISO}`);

  try {
    const { stdout } = await execFileAsync(
      'python3',
      [
        '-c',
        `
import sys
sys.path.insert(0, '${path.dirname(PYTHON_SCRIPT)}')
from datetime import datetime
from util_changed_tracked_files import list_changed_staged_files

since = datetime.fromisoformat('${sinceISO}'.replace('Z', '+00:00'))
files = list_changed_staged_files('.', since, include_unstaged=${!stagedOnly ? 'True' : 'False'})
for f in files:
    print(f)
`
      ],
      {
        cwd: path.join(__dirname, '..'),
        timeout: GIT_DIFF_TIMEOUT_MS
      }
    );

    const files = stdout
      .trim()
      .split('\n')
      .filter((f) => f.length > 0);

    debug(`Python script found ${files.length} changed files`);
    return files;
  } catch (err) {
    console.warn(`${SYMBOLS.WARNING} Python script failed, falling back to git: ${err.message}`);
    return null; // Fall back to git-based detection
  }
}

// ============================================================================
// Dependency Mapping
// ============================================================================

/**
 * Dependency Mapping: File → Test Files
 *
 * This mapping implements the two testing rules:
 * - Core library (SvgVisualBBox.js) → all dependent tests
 * - Individual tools → only their specific tests
 *
 * DRY Principle: Shared test patterns defined as constants to avoid duplication
 */

// Core library tests - ONLY for tools that actually load SvgVisualBBox.js
// Tools that load SvgVisualBBox.js (via page.addScriptTag):
// - sbb-extract.cjs → html-preview-structure, html-preview-rendering
// - sbb-test.cjs → cli-security
// - sbb-fix-viewbox.cjs → cli-security
// - sbb-svg2png.cjs → cli-security
// - sbb-getbbox.cjs → cli-security
//
// Tools that DON'T use SvgVisualBBox.js:
// - sbb-comparer.cjs (uses own comparison logic, no browser)
// - sbb-inkscape-*.cjs (uses Inkscape CLI, not SvgVisualBBox.js)
// - sbb-chrome-*.cjs (uses Chrome DevTools Protocol, not SvgVisualBBox.js)
const LIBRARY_DEPENDENT_TESTS = [
  'tests/unit/**/*.test.js', // Unit tests that directly test the library
  'tests/integration/html-preview-structure.test.js', // Tests sbb-extract.cjs
  'tests/integration/html-preview-rendering.test.js', // Tests sbb-extract.cjs
  'tests/integration/cli-security.test.js' // Tests sbb-test/fix-viewbox/render/getbbox
  // NOTE: sbb-comparer.test.js is NOT included - sbb-comparer doesn't use SvgVisualBBox.js
];

const TEST_DEPENDENCIES = {
  // TESTING RULE 1: Core library affects ONLY tests for tools that import it
  'SvgVisualBBox.js': LIBRARY_DEPENDENT_TESTS,
  'SvgVisualBBox.min.js': LIBRARY_DEPENDENT_TESTS,

  // TESTING RULE 2: Tool-specific tests
  'sbb-comparer.cjs': ['tests/integration/sbb-comparer.test.js'],

  'sbb-extract.cjs': [
    'tests/integration/html-preview-structure.test.js',
    'tests/integration/html-preview-rendering.test.js'
  ],

  'sbb-getbbox.cjs': ['tests/integration/cli-security.test.js'],

  'sbb-fix-viewbox.cjs': ['tests/integration/cli-security.test.js'],

  'sbb-svg2png.cjs': ['tests/integration/cli-security.test.js'],

  'sbb-test.cjs': ['tests/integration/cli-security.test.js'],

  // Inkscape tools (don't depend on SvgVisualBBox.js)
  'sbb-inkscape-extract.cjs': ['tests/integration/sbb-inkscape-extract.test.js'],

  'sbb-inkscape-svg2png.cjs': ['tests/integration/cli-security.test.js'],

  'sbb-inkscape-text2path.cjs': ['tests/integration/cli-security.test.js'],

  'sbb-inkscape-getbbox.cjs': ['tests/integration/cli-security.test.js'],

  // Chrome/Inkscape wrappers
  'sbb-chrome-extract.cjs': ['tests/integration/cli-security.test.js'],

  'sbb-chrome-getbbox.cjs': ['tests/integration/cli-security.test.js'],

  'sbb-chrome-svg2png.cjs': ['tests/integration/cli-security.test.js'],

  // Shared libraries
  'lib/security-utils.cjs': ['tests/unit/security-utils.test.js'],

  'lib/cli-utils.cjs': [
    // CLI utility functions used by integration tests
    'tests/integration/sbb-comparer.test.js',
    'tests/integration/cli-security.test.js'
  ],

  // Test infrastructure changes → run all tests
  'tests/helpers/browser-test.js': [
    'tests/unit/**/*.test.js',
    'tests/integration/html-preview-rendering.test.js'
  ],

  'vitest.config.js': [RUN_ALL_TESTS_PATTERN],

  'package.json': [RUN_ALL_TESTS_PATTERN],

  'package-lock.json': [RUN_ALL_TESTS_PATTERN],

  // Build and utility scripts
  // Empty arrays = these files don't require any specific tests to run
  // Changes to these files don't affect runtime behavior, only build/version/test-selection
  'scripts/build-min.cjs': [], // Build script - doesn't affect tests
  'scripts/validate-build.cjs': [], // Build validation - doesn't affect tests
  'scripts/bump-version.cjs': [], // Version bumping - doesn't affect tests
  'scripts/test-selective.cjs': [], // Test selection logic - doesn't affect test outcomes
  'scripts/release.sh': [], // Release automation - doesn't affect tests
  'scripts/README.md': [], // Documentation - doesn't affect tests

  // Project documentation and configuration (private)
  'CLAUDE.md': [], // Project instructions (private, gitignored) - doesn't affect tests
  'README.md': [], // Documentation - doesn't affect tests
  '.gitignore': [], // Git configuration - doesn't affect tests

  // Centralized configuration
  'config/timeouts.cjs': [RUN_ALL_TESTS_PATTERN], // Timeout config affects all tools
  'config/timeouts.js': [RUN_ALL_TESTS_PATTERN] // Timeout config affects all tools
};

// ============================================================================
// Runtime Dependency Detection
// ============================================================================

/**
 * Find all source files (.cjs) that import/reference a given file
 * @param {string} changedFile - The file that changed (e.g., 'SvgVisualBBox.js')
 * @returns {string[]} List of files that import the changed file
 */
function findFilesImporting(changedFile) {
  debug(`Finding files that import: ${changedFile}`);

  const importers = [];
  const fileName = path.basename(changedFile, path.extname(changedFile)); // 'SvgVisualBBox'

  // Scan all .cjs files in the project root
  const sourceFiles = fs.readdirSync('.').filter((f) => f.endsWith('.cjs'));

  for (const sourceFile of sourceFiles) {
    try {
      const content = fs.readFileSync(sourceFile, 'utf8');

      // Remove single-line comments
      const noSingleComments = content.replace(/\/\/.*$/gm, '');

      // Remove multi-line comments
      const noComments = noSingleComments.replace(/\/\*[\s\S]*?\*\//g, '');

      // Check if the file is referenced in non-comment code
      // Matches: require('SvgVisualBBox'), addScriptTag({path: 'SvgVisualBBox.js'}), etc.
      if (noComments.includes(fileName) || noComments.includes(changedFile)) {
        importers.push(sourceFile);
        debug(`  → ${sourceFile} imports ${changedFile}`);
      }
    } catch (err) {
      // Skip files that can't be read
      debug(`  → Skipping ${sourceFile}: ${err.message}`);
    }
  }

  return importers;
}

/**
 * Validate git reference to prevent command injection attacks
 * @param {string} ref - Git reference to validate (e.g., "HEAD", "main", "origin/develop")
 * @throws {Error} If ref contains dangerous characters
 *
 * WHY: Command injection vulnerability - malicious git refs can execute arbitrary code
 * Even though execFileAsync doesn't spawn a shell, git itself can interpret certain
 * characters dangerously. For example: "HEAD; rm -rf /" or "HEAD|malicious-command"
 *
 * WHAT NOT TO DO:
 * - Don't use blacklists (always incomplete - can't predict all attack vectors)
 * - Don't sanitize by escaping (brittle, error-prone, easy to bypass)
 * - Don't trust git to validate (git accepts many dangerous patterns)
 *
 * SECURITY PRINCIPLE: Use whitelist validation - only allow known-safe characters
 */
function validateGitRef(ref) {
  // Whitelist pattern: alphanumeric, forward slash, underscore, hyphen, dot, caret, tilde
  // Covers standard git refs: HEAD, main, feature/foo, origin/main, HEAD~1, HEAD^, v1.0.0
  const SAFE_GIT_REF_PATTERN = /^[a-zA-Z0-9/_.\-^~]+$/;

  // Shell metacharacters that enable command injection attacks
  const DANGEROUS_CHARS = [';', '|', '&', '`', '$', '(', ')', '<', '>', '\n', '\r'];

  if (!ref || typeof ref !== 'string') {
    throw new Error(
      `Invalid git ref: must be a non-empty string (got ${typeof ref}: ${JSON.stringify(ref)})`
    );
  }

  // Check for shell metacharacters first (most dangerous)
  const foundDangerous = DANGEROUS_CHARS.filter((char) => ref.includes(char));
  if (foundDangerous.length > 0) {
    throw new Error(
      `Invalid git ref: contains shell metacharacters (${foundDangerous.join(', ')}) ` +
        `that could enable command injection attacks. Ref: "${ref}"`
    );
  }

  // Whitelist validation: reject refs with any characters outside the safe pattern
  if (!SAFE_GIT_REF_PATTERN.test(ref)) {
    throw new Error(
      `Invalid git ref: contains unsafe characters. ` +
        `Only alphanumeric, /, _, -, ., ^, ~ are allowed. Ref: "${ref}"`
    );
  }

  debug(`Git ref validated successfully: ${ref}`);
}

/**
 * Get list of changed files from git
 * @param {string} baseRef - Git reference to compare against
 * @returns {Promise<string[]>} List of changed file paths
 * @throws {Error} If git commands fail (FAIL-FAST: don't hide git configuration errors)
 */
async function getChangedFiles(baseRef) {
  // SECURITY: Validate git ref before using it in commands (Issue #10)
  validateGitRef(baseRef);

  debug(`Getting changed files against base ref: ${baseRef}`);

  // Try Python-based detection first (uses filesystem timestamps + git staging)
  // Falls back to pure git if:
  // - No .last-test-run timestamp file exists
  // - Python script fails
  // - Python not available
  const pythonFiles = await getChangedFilesViaPython(false); // include unstaged (matches git fallback behavior)
  if (pythonFiles !== null) {
    debug(`Using Python-based detection: ${pythonFiles.length} files`);
    return pythonFiles;
  }

  // Fallback: Pure git-based detection
  debug('Using git-based detection (fallback)');

  // FAIL-FAST: Let git errors propagate - don't hide configuration problems
  const { stdout } = await execFileAsync('git', ['diff', '--name-only', baseRef], {
    timeout: GIT_DIFF_TIMEOUT_MS
  });
  const files = stdout
    .trim()
    .split('\n')
    .filter((f) => f.length > 0);

  debug(`Found ${files.length} changed files from working directory diff`);

  if (files.length === 0) {
    // No working directory changes - check staged files
    debug('No working directory changes, checking staged files...');
    const { stdout: stagedStdout } = await execFileAsync(
      'git',
      ['diff', '--cached', '--name-only'],
      { timeout: GIT_DIFF_TIMEOUT_MS }
    );
    const stagedFiles = stagedStdout
      .trim()
      .split('\n')
      .filter((f) => f.length > 0);

    debug(`Found ${stagedFiles.length} staged files`);
    return stagedFiles;
  }

  return files;
}

/**
 * Check if a file is an unknown source file that requires running all tests
 * @param {string} normalizedPath - Normalized file path (with / separators)
 * @returns {boolean} True if file is unknown source code
 */
function isUnknownSourceFile(normalizedPath) {
  return (
    normalizedPath.startsWith('lib/') ||
    (normalizedPath.startsWith('scripts/') && normalizedPath.endsWith('.cjs')) ||
    (normalizedPath.endsWith('.cjs') && !normalizedPath.startsWith('tests/'))
  );
}

/**
 * Determine which tests are required based on changed files
 * Uses RUNTIME DEPENDENCY DETECTION:
 * 1. For each changed file, find all files that import it
 * 2. For each importing file, add its tests to the list
 * 3. Deduplicate the final test list
 *
 * @param {string[]} changedFiles - List of changed file paths
 * @returns {{ testsToRun: Set<string>, runAll: boolean }} Test scope determination
 */
function determineRequiredTests(changedFiles) {
  const testsToRun = new Set();
  let hasUnknownDependencies = false;

  debug('Determining required tests for changed files', { count: changedFiles.length });

  // STEP 1: Process each changed file
  for (const file of changedFiles) {
    const normalizedPath = file.replace(/\\/g, '/');
    debug(`\nProcessing changed file: ${normalizedPath}`);

    // If the changed file is a test file itself, run it directly
    if (normalizedPath.startsWith('tests/') && normalizedPath.endsWith('.test.js')) {
      debug(`  → Test file itself, adding: ${normalizedPath}`);
      testsToRun.add(normalizedPath);
      continue;
    }

    // STEP 2: Check if this file has explicit test mapping
    if (normalizedPath in TEST_DEPENDENCIES) {
      const tests = TEST_DEPENDENCIES[normalizedPath];
      debug(`  → Found in TEST_DEPENDENCIES map, has ${tests.length} test(s)`);

      // If empty array [], it means no tests needed (doc/config file)
      if (tests.length === 0) {
        debug(`  → Empty test array - no tests needed for this file`);
        continue;
      }

      // Add the tests for this file
      tests.forEach((pattern) => {
        if (pattern) {
          debug(`     Adding test pattern: ${pattern}`);
          testsToRun.add(pattern);
        }
      });
    } else {
      // STEP 3: File NOT in TEST_DEPENDENCIES - use runtime dependency detection
      debug(`  → NOT in TEST_DEPENDENCIES - checking if it's a source file`);

      if (isUnknownSourceFile(normalizedPath)) {
        // This is a source file without explicit mapping
        console.warn(`${SYMBOLS.WARNING}  Source file not in dependency map: ${normalizedPath}`);
        console.warn('   Running all tests to be safe...');
        hasUnknownDependencies = true;
        continue;
      }

      // Not a source file (probably documentation) - skip
      debug(`  → Non-source file (documentation/config), skipping`);
      continue;
    }

    // STEP 4: Find files that IMPORT this changed file
    debug(`  → Scanning for files that import: ${normalizedPath}`);
    const importers = findFilesImporting(normalizedPath);

    if (importers.length > 0) {
      debug(`  → Found ${importers.length} file(s) that import this file`);

      // For each importer, add ITS tests
      for (const importer of importers) {
        if (importer in TEST_DEPENDENCIES) {
          const importerTests = TEST_DEPENDENCIES[importer];
          debug(`     ${importer} has ${importerTests.length} test(s)`);

          importerTests.forEach((pattern) => {
            if (pattern) {
              debug(`       Adding test: ${pattern}`);
              testsToRun.add(pattern);
            }
          });
        }
      }
    }
  }

  // If unknown dependencies found, run all tests
  if (hasUnknownDependencies) {
    debug('Unknown dependencies found - returning runAll=true');
    return { testsToRun: new Set(), runAll: true };
  }

  // STEP 5: Deduplication happens automatically via Set
  debug(`\nFinal deduplicated test count: ${testsToRun.size} unique test pattern(s)`);
  return { testsToRun, runAll: false };
}

/**
 * Run vitest with specified test patterns
 * @param {Set<string>} patterns - Test file patterns to run
 * @returns {Promise<void>}
 */
async function runTests(patterns) {
  // Validate input
  if (!(patterns instanceof Set) || patterns.size === 0) {
    throw new Error('runTests requires a non-empty Set of test patterns');
  }

  // Check if we're running all tests (glob pattern or no specific tests)
  const patternsArray = Array.from(patterns);
  const isRunningAllTests = patternsArray.some((p) => p.includes('**'));

  debug(`Running tests with ${patterns.size} pattern(s)`, {
    patterns: patternsArray,
    isRunningAllTests
  });

  const args = isRunningAllTests ? ['run'] : ['run', ...patternsArray];

  console.log(
    `\n${SYMBOLS.TESTING} Running vitest: vitest ${args.join(' ')}${isRunningAllTests ? ' (all tests)' : ''}\n`
  );

  try {
    const { stdout, stderr } = await execFileAsync('npx', ['vitest', ...args], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, FORCE_COLOR: '1' },
      maxBuffer: MAX_EXEC_BUFFER_BYTES,
      timeout: VITEST_RUN_TIMEOUT_MS
    });

    // Print test output
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  } catch (error) {
    // Vitest failed (tests failed or error occurred)
    debug('Vitest execution failed', { code: error.code, signal: error.signal });
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
  }
}

/**
 * Main execution
 */
async function main() {
  // Parse arguments - filter out flags to get positional args
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--') && !arg.startsWith('-'));
  const baseRef = args[0] || DEFAULT_GIT_BASE_REF;
  const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-d');

  debug(`Main execution started`, { baseRef, dryRun, enableDebug: ENABLE_DEBUG });

  console.log(`${SYMBOLS.SEARCH} Detecting changed files...`);
  const changedFiles = await getChangedFiles(baseRef);

  if (changedFiles.length === 0) {
    console.log(`${SYMBOLS.SUCCESS} No changes detected - skipping tests`);
    return;
  }

  console.log(`${SYMBOLS.INFO} Changed files (${changedFiles.length}):`);
  changedFiles.forEach((f) => console.log(`   - ${f}`));
  console.log('');

  const { testsToRun, runAll } = determineRequiredTests(changedFiles);

  // If no tests needed (documentation-only changes), skip testing
  if (testsToRun.size === 0 && !runAll) {
    console.log(`${SYMBOLS.SUCCESS} No tests required (documentation/config only changes)`);
    return;
  }

  // If unknown dependencies or runAll flag, run all tests
  if (runAll) {
    console.log(`${SYMBOLS.SUCCESS} Running all tests`);
    if (!dryRun) {
      await runTests(new Set([RUN_ALL_TESTS_PATTERN]));
      updateLastTestRunTimestamp(); // Update timestamp after successful run
    }
    return;
  }

  console.log(`✓ Selective tests required (${testsToRun.size} patterns):`);
  testsToRun.forEach((pattern) => console.log(`   - ${pattern}`));
  console.log('');

  if (dryRun) {
    console.log(`${SYMBOLS.INFO} Dry run mode - not executing tests`);
    return;
  }

  // Run the selected tests
  await runTests(testsToRun);
  updateLastTestRunTimestamp(); // Update timestamp after successful run
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
