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

const execFileAsync = promisify(execFile);

// ============================================================================
// Configuration Constants - Single Source of Truth
// ============================================================================

// Git configuration
const DEFAULT_GIT_BASE_REF = 'HEAD'; // Default comparison point for git diff

// Timeout configuration (milliseconds)
// WHY: Without timeouts, git or vitest processes can hang forever, causing:
// - Pre-commit hooks that never complete
// - CI jobs that hit workflow timeout limits
// - Non-deterministic failures that require manual intervention
// WHAT NOT TO DO: Don't skip adding timeouts to "fast" commands like git diff.
// Even git can hang on network-mounted repos, corrupted .git directories, or large diffs.
const GIT_DIFF_TIMEOUT_MS = 30000; // 30 seconds for git diff operations
const VITEST_RUN_TIMEOUT_MS = 600000; // 10 minutes for vitest execution

// Test execution configuration
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

// Core library tests - all browser-dependent functionality
const LIBRARY_DEPENDENT_TESTS = [
  'tests/unit/**/*.test.js',
  'tests/integration/sbb-comparer.test.js',
  'tests/integration/html-preview-structure.test.js',
  'tests/integration/html-preview-rendering.test.js',
  'tests/integration/cli-security.test.js'
];

const TEST_DEPENDENCIES = {
  // TESTING RULE 1: Core library affects all browser-dependent tests
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

  'sbb-render.cjs': ['tests/integration/cli-security.test.js'],

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
  'scripts/bump-version.cjs': [], // Version bumping - doesn't affect tests
  'scripts/test-selective.cjs': [] // Test selection logic - doesn't affect test outcomes
};

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
 * @param {string[]} changedFiles - List of changed file paths
 * @returns {{ testsToRun: Set<string>, runAll: boolean }} Test scope determination
 */
function determineRequiredTests(changedFiles) {
  const testsToRun = new Set();
  let hasUnknownDependencies = false;

  debug('Determining required tests for changed files', { count: changedFiles.length });

  // If no changes detected, run all tests
  if (changedFiles.length === 0) {
    debug('No changed files detected - will run all tests');
    return { testsToRun, runAll: true };
  }

  for (const file of changedFiles) {
    // Normalize path separators (Windows backslashes → forward slashes)
    // Note: This assumes all paths use forward slashes in TEST_DEPENDENCIES mapping
    const normalizedPath = file.replace(/\\/g, '/');
    debug(`Processing file: ${normalizedPath}`);

    // If the changed file is a test file itself, run it directly
    if (normalizedPath.startsWith('tests/') && normalizedPath.endsWith('.test.js')) {
      debug(`  → Test file itself, adding: ${normalizedPath}`);
      testsToRun.add(normalizedPath);
      continue;
    }

    // Check dependency mapping
    if (normalizedPath in TEST_DEPENDENCIES) {
      const tests = TEST_DEPENDENCIES[normalizedPath];
      debug(`  → Found in dependency map, adding ${tests.length} test(s)`);
      tests.forEach((pattern) => {
        if (pattern) {
          debug(`     Adding test pattern: ${pattern}`);
          testsToRun.add(pattern);
        }
      });
    } else if (isUnknownSourceFile(normalizedPath)) {
      // Unknown source file changed - run all tests to be safe
      console.warn(`${SYMBOLS.WARNING}  Unknown dependency for: ${normalizedPath}`);
      console.warn('   Running all tests to be safe...');
      debug(`  → Unknown source file, triggering full test suite`);
      hasUnknownDependencies = true;
    } else {
      debug(`  → Non-source file, skipping (no tests needed)`);
    }
  }

  // If unknown dependencies found, run all tests
  if (hasUnknownDependencies) {
    debug('Unknown dependencies found - returning runAll=true');
    return { testsToRun: new Set(), runAll: true };
  }

  debug(`Determined ${testsToRun.size} unique test pattern(s)`);
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
    console.log(`${SYMBOLS.SUCCESS} No changes detected - running all tests`);
    if (!dryRun) {
      await runTests(new Set([RUN_ALL_TESTS_PATTERN]));
    }
    return;
  }

  console.log(`${SYMBOLS.INFO} Changed files (${changedFiles.length}):`);
  changedFiles.forEach((f) => console.log(`   - ${f}`));
  console.log('');

  const { testsToRun, runAll } = determineRequiredTests(changedFiles);

  if (runAll || testsToRun.size === 0) {
    console.log(`${SYMBOLS.SUCCESS} Running all tests`);
    if (!dryRun) {
      await runTests(new Set([RUN_ALL_TESTS_PATTERN]));
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
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
