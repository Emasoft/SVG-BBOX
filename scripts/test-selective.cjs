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
 *   node scripts/test-selective.cjs [base-ref]
 *
 * Examples:
 *   node scripts/test-selective.cjs           # Compare against HEAD (uncommitted changes)
 *   node scripts/test-selective.cjs HEAD~1    # Compare against previous commit
 *   node scripts/test-selective.cjs main      # Compare against main branch
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execFileAsync = promisify(execFile);

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

  'vitest.config.js': ['tests/**/*.test.js'],

  'package.json': ['tests/**/*.test.js'],

  'package-lock.json': ['tests/**/*.test.js'],

  // Build and utility scripts
  // Empty arrays = these files don't require any specific tests to run
  // Changes to these files don't affect runtime behavior, only build/version/test-selection
  'scripts/build-min.cjs': [], // Build script - doesn't affect tests
  'scripts/bump-version.cjs': [], // Version bumping - doesn't affect tests
  'scripts/test-selective.cjs': [] // Test selection logic - doesn't affect test outcomes
};

/**
 * Get list of changed files
 * @param {string} baseRef - Git reference to compare against (default: HEAD)
 * @returns {Promise<string[]>} List of changed file paths
 * @throws {Error} If git commands fail (FAIL-FAST: don't hide git configuration errors)
 */
async function getChangedFiles(baseRef = 'HEAD') {
  // FAIL-FAST: Let git errors propagate - don't hide configuration problems
  // Try to get diff against base ref
  const { stdout } = await execFileAsync('git', ['diff', '--name-only', baseRef]);
  const files = stdout
    .trim()
    .split('\n')
    .filter((f) => f.length > 0);

  if (files.length === 0) {
    // No changes - check staged files
    const { stdout: stagedStdout } = await execFileAsync('git', [
      'diff',
      '--cached',
      '--name-only'
    ]);
    return stagedStdout
      .trim()
      .split('\n')
      .filter((f) => f.length > 0);
  }

  return files;
}

/**
 * Map changed files to required test files
 * @param {string[]} changedFiles - List of changed file paths
 * @returns {{ testsToRun: Set<string>, runAll: boolean }} Object with test patterns and runAll flag
 */
function mapFilesToTests(changedFiles) {
  const testsToRun = new Set();
  let hasUnknownDependencies = false;

  // If no changes detected, run all tests
  if (changedFiles.length === 0) {
    return { testsToRun, runAll: true };
  }

  for (const file of changedFiles) {
    const normalizedPath = file.replace(/\\/g, '/');

    // If the changed file is a test file itself, run it
    if (normalizedPath.startsWith('tests/') && normalizedPath.endsWith('.test.js')) {
      testsToRun.add(normalizedPath);
      continue;
    }

    // Check dependency mapping
    if (normalizedPath in TEST_DEPENDENCIES) {
      const tests = TEST_DEPENDENCIES[normalizedPath];
      tests.forEach((pattern) => {
        if (pattern) testsToRun.add(pattern);
      });
    } else if (
      normalizedPath.startsWith('lib/') ||
      (normalizedPath.startsWith('scripts/') && normalizedPath.endsWith('.cjs')) ||
      (normalizedPath.endsWith('.cjs') && !normalizedPath.startsWith('tests/'))
    ) {
      // Unknown source file changed - run all tests to be safe
      console.log(`⚠️  Unknown dependency for: ${normalizedPath}`);
      console.log('   Running all tests to be safe...');
      hasUnknownDependencies = true;
    }
  }

  // If unknown dependencies found, run all tests
  if (hasUnknownDependencies) {
    return { testsToRun: new Set(), runAll: true };
  }

  return { testsToRun, runAll: false };
}

/**
 * Run vitest with specified test patterns
 * @param {Set<string>} patterns - Test file patterns to run
 * @returns {Promise<void>}
 */
async function runTests(patterns) {
  // Check if we're running all tests (glob pattern or no specific tests)
  const patternsArray = Array.from(patterns);
  const isRunningAllTests = patternsArray.some((p) => p.includes('**'));

  const args = isRunningAllTests ? ['run'] : ['run', ...patternsArray];

  console.log(
    `\n🧪 Running vitest: vitest ${args.join(' ')}${isRunningAllTests ? ' (all tests)' : ''}\n`
  );

  try {
    const { stdout, stderr } = await execFileAsync('npx', ['vitest', ...args], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, FORCE_COLOR: '1' },
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer for test output
    });

    // Print test output
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  } catch (error) {
    // Vitest failed (tests failed or error occurred)
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
  }
}

/**
 * Main execution
 */
async function main() {
  const baseRef = process.argv[2] || 'HEAD';
  const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-d');

  console.log('🔍 Detecting changed files...');
  const changedFiles = await getChangedFiles(baseRef);

  if (changedFiles.length === 0) {
    console.log('✅ No changes detected - running all tests');
    if (!dryRun) {
      await runTests(new Set(['tests/**/*.test.js']));
    }
    return;
  }

  console.log(`📝 Changed files (${changedFiles.length}):`);
  changedFiles.forEach((f) => console.log(`   - ${f}`));
  console.log('');

  const { testsToRun, runAll } = mapFilesToTests(changedFiles);

  if (runAll || testsToRun.size === 0) {
    console.log('✅ Running all tests');
    if (!dryRun) {
      await runTests(new Set(['tests/**/*.test.js']));
    }
    return;
  }

  console.log(`✓ Selective tests required (${testsToRun.size} patterns):`);
  testsToRun.forEach((pattern) => console.log(`   - ${pattern}`));
  console.log('');

  if (dryRun) {
    console.log('ℹ️  Dry run mode - not executing tests');
    return;
  }

  // Run the selected tests
  await runTests(testsToRun);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
