#!/usr/bin/env node
/**
 * Centralized Timeout Configuration
 *
 * Single source of truth for ALL timeout values across the codebase.
 * Fixes DRY violation - timeout constants were duplicated across 10+ files.
 *
 * WHY centralize timeouts:
 * - Consistency: All tools use the same timeout values for the same operations
 * - Maintainability: Change timeout once, updates everywhere
 * - Discoverability: All timeout decisions documented in one place
 * - Testing: Easy to override timeouts in test environments
 *
 * WHAT NOT TO DO:
 * - Don't add timeouts to individual files (always import from here)
 * - Don't use magic numbers (30000, 60000, etc.) in code
 * - Don't create file-specific timeout constants (use semantic names)
 * - Don't skip documenting WHY each timeout has its specific value
 *
 * Usage (CommonJS):
 *   const { BROWSER_TIMEOUT_MS, FONT_TIMEOUT_MS } = require('./config/timeouts.cjs');
 *
 * Usage (ES Modules):
 *   import { BROWSER_TIMEOUT_MS, FONT_TIMEOUT_MS } from './config/timeouts.js';
 */

// ============================================================================
// Browser Operation Timeouts
// ============================================================================

/**
 * BROWSER_TIMEOUT_MS: 30 seconds
 *
 * WHY 30 seconds:
 * - Browser launch: 2-5 seconds (Chrome/Puppeteer startup)
 * - Page navigation: 1-3 seconds (loading HTML)
 * - DOM ready: <1 second (simple SVG pages)
 * - Safety margin: 20+ seconds for slow systems/CI
 *
 * Used for:
 * - page.setDefaultTimeout()
 * - page.setDefaultNavigationTimeout()
 * - page.goto({ timeout })
 * - page.waitForSelector({ timeout })
 *
 * WHAT NOT TO DO:
 * - Don't reduce below 20s (CI environments are slower than local dev)
 * - Don't increase arbitrarily (indicates real performance problems)
 * - Don't use different values per tool (browser behavior is consistent)
 */
const BROWSER_TIMEOUT_MS = 30000;

/**
 * FONT_TIMEOUT_MS: 8 seconds
 *
 * WHY 8 seconds:
 * - Font loading: 100-500ms per font (system fonts)
 * - Web fonts: 1-2 seconds per font (if network involved)
 * - Font discovery: 1-3 seconds (listing all system fonts)
 * - Safety margin: 4+ seconds for slow disks/networks
 *
 * Used for:
 * - Waiting for document.fonts.ready
 * - Font rendering completion delays
 * - FontFaceSet load events
 *
 * WHAT NOT TO DO:
 * - Don't reduce below 5s (font loading is network/disk dependent)
 * - Don't use BROWSER_TIMEOUT_MS (font ops are shorter than page ops)
 * - Don't skip waiting for fonts (causes incorrect bbox calculations)
 */
const FONT_TIMEOUT_MS = 8000;

// ============================================================================
// CLI Operation Timeouts
// ============================================================================

/**
 * CLI_TIMEOUT_MS: 30 seconds
 *
 * WHY 30 seconds:
 * - Same rationale as BROWSER_TIMEOUT_MS
 * - CLI tools internally launch browsers with same constraints
 * - Tests need to wait for tool completion (browser launch + operation)
 *
 * Used for:
 * - execFile timeout when running CLI tools
 * - Test timeout for CLI integration tests
 *
 * WHAT NOT TO DO:
 * - Don't use different values for CLI vs browser (they're the same operation)
 * - Don't reduce timeout for "fast" CLI operations (startup overhead is constant)
 */
const CLI_TIMEOUT_MS = 30000;

// ============================================================================
// Git Operation Timeouts
// ============================================================================

/**
 * GIT_DIFF_TIMEOUT_MS: 30 seconds
 *
 * WHY 30 seconds:
 * - Normal git diff: <1 second (typical changesets)
 * - Large repos: 2-5 seconds (thousands of files)
 * - Network-mounted repos: 5-10 seconds (NFS/SMB latency)
 * - Corrupted .git: Can hang forever (timeout essential)
 * - Safety margin: 15+ seconds for edge cases
 *
 * Used for:
 * - git diff --name-only (working directory changes)
 * - git diff --cached --name-only (staged changes)
 *
 * WHAT NOT TO DO:
 * - Don't assume git is always fast (can hang on network issues)
 * - Don't skip timeouts for "fast" git commands (corruption can hang any command)
 * - Don't increase timeout to "fix" slow repos (fix the underlying issue)
 */
const GIT_DIFF_TIMEOUT_MS = 30000;

// ============================================================================
// Test Execution Timeouts
// ============================================================================

/**
 * TEST_TIMEOUT_MS: 60 seconds
 *
 * WHY 60 seconds:
 * - I/O-bound Puppeteer tests (not CPU-bound)
 * - Browser launch: 2-5 seconds
 * - Page operations: 1-3 seconds per operation
 * - Multiple operations per test: 5-15 seconds total
 * - Safety margin: 40+ seconds for slow CI
 *
 * Reduced from 30 minutes (1800000ms) - original was far too conservative.
 * If a test takes >60s, it indicates a real problem (hanging browser, infinite loop).
 *
 * Used for:
 * - vitest testTimeout configuration
 *
 * WHAT NOT TO DO:
 * - Don't increase to hide slow tests (fix the test instead)
 * - Don't reduce below 30s (CI environments need buffer)
 * - Don't use same timeout for unit vs integration tests (different characteristics)
 */
const TEST_TIMEOUT_MS = 60000;

/**
 * HOOK_TIMEOUT_MS: 60 seconds
 *
 * WHY 60 seconds:
 * - Test setup/teardown includes:
 *   * Browser launch: 2-5 seconds
 *   * Font discovery: 1-3 seconds
 *   * Shared browser initialization: 1-2 seconds
 * - Critical path operations that MUST complete before tests run
 * - Same timing constraints as individual tests
 *
 * Used for:
 * - vitest hookTimeout configuration (beforeAll, afterAll, beforeEach, afterEach)
 *
 * WHAT NOT TO DO:
 * - Don't reduce below TEST_TIMEOUT_MS (hooks can be as complex as tests)
 * - Don't do heavy work in hooks (keep them fast, use lazy initialization)
 */
const HOOK_TIMEOUT_MS = 60000;

/**
 * VITEST_RUN_TIMEOUT_MS: 10 minutes (600 seconds)
 *
 * WHY 10 minutes:
 * - Entire vitest process timeout (not individual tests)
 * - Covers:
 *   * Vitest startup: 1-2 seconds
 *   * Test file discovery: 1-2 seconds
 *   * All tests execution: 2-8 minutes (depending on selection)
 *   * Coverage generation: 10-30 seconds (if enabled)
 * - Prevents infinite hangs when vitest itself deadlocks
 *
 * Used for:
 * - execFile timeout when running `npx vitest` in test-selective.cjs
 *
 * WHAT NOT TO DO:
 * - Don't use for individual test timeouts (use TEST_TIMEOUT_MS)
 * - Don't reduce if full test suite takes longer (indicates test suite bloat)
 * - Don't increase to "fix" slow test suites (parallelize or optimize instead)
 */
const VITEST_RUN_TIMEOUT_MS = 600000;

// ============================================================================
// File Locking Timeouts
// ============================================================================

/**
 * LOCK_TIMEOUT_SECONDS: 300 seconds (5 minutes)
 *
 * WHY 5 minutes:
 * - Pre-commit hook typical runtime: 30-60 seconds (with selective testing)
 * - Pre-commit hook worst case: 2-3 minutes (full test suite)
 * - Safety margin: 2+ minutes for slow systems
 * - Prevents infinite waits if first commit gets stuck
 *
 * Used for:
 * - flock -w timeout in pre-commit hook
 * - Prevents race conditions when multiple commits run simultaneously
 *
 * WHAT NOT TO DO:
 * - Don't reduce below 2 minutes (full test suite needs time)
 * - Don't increase above 10 minutes (indicates stuck process, should fail fast)
 * - Don't skip file locking (race conditions will occur)
 */
const LOCK_TIMEOUT_SECONDS = 300;

// ============================================================================
// Chrome Pool Configuration
// ============================================================================

/**
 * MAX_CONCURRENT_BROWSERS: Maximum simultaneous Chrome instances
 *
 * WHY 3 for local, 2 for CI:
 * - Each Chrome instance: 100-300MB RAM
 * - Local dev machines: 8-16GB RAM typical, can handle 3 instances
 * - CI runners: 4-8GB RAM typical, more constrained
 * - Diminishing returns above 3 (disk I/O becomes bottleneck)
 *
 * Override with: SVG_BBOX_MAX_BROWSERS environment variable
 *
 * Used for:
 * - Chrome pool manager concurrent limit
 * - Test parallelism throttling
 *
 * WHAT NOT TO DO:
 * - Don't set >5 (memory exhaustion likely)
 * - Don't set to 1 (tests become very slow)
 * - Don't ignore CI constraints (will cause OOM kills)
 */
const MAX_CONCURRENT_BROWSERS = parseInt(process.env.SVG_BBOX_MAX_BROWSERS || '3', 10);

/**
 * MAX_CONCURRENT_BROWSERS_CI: Maximum for CI environments
 *
 * WHY 2:
 * - GitHub Actions runners: 7GB RAM, shared with other processes
 * - More conservative to prevent resource exhaustion
 * - CI jobs run in isolation, can't recover from OOM
 */
const MAX_CONCURRENT_BROWSERS_CI = 2;

/**
 * BROWSER_IDLE_TIMEOUT_MS: How long idle browsers live before cleanup
 *
 * WHY 30 seconds:
 * - Long enough to reuse between related tests
 * - Short enough to free resources when not needed
 * - Balance between startup cost and memory usage
 *
 * Override with: SVG_BBOX_BROWSER_IDLE_TIMEOUT environment variable
 */
const BROWSER_IDLE_TIMEOUT_MS = parseInt(process.env.SVG_BBOX_BROWSER_IDLE_TIMEOUT || '30000', 10);

/**
 * BROWSER_MAX_USE_TIME_MS: Maximum time a browser can be held
 *
 * WHY 5 minutes:
 * - No single test should take >5 minutes
 * - Prevents runaway tests from hogging browsers
 * - Safety valve for stuck operations
 *
 * Override with: SVG_BBOX_BROWSER_MAX_USE_TIME environment variable
 */
const BROWSER_MAX_USE_TIME_MS = parseInt(process.env.SVG_BBOX_BROWSER_MAX_USE_TIME || '300000', 10);

/**
 * GUARDIAN_INTERVAL_MS: How often pool guardian runs
 *
 * WHY 5 seconds:
 * - Frequent enough to catch stuck browsers quickly
 * - Rare enough to not waste CPU cycles
 *
 * Override with: SVG_BBOX_GUARDIAN_INTERVAL environment variable
 */
const GUARDIAN_INTERVAL_MS = parseInt(process.env.SVG_BBOX_GUARDIAN_INTERVAL || '5000', 10);

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  // Browser operations
  BROWSER_TIMEOUT_MS,
  FONT_TIMEOUT_MS,

  // CLI operations
  CLI_TIMEOUT_MS,

  // Git operations
  GIT_DIFF_TIMEOUT_MS,

  // Test execution
  TEST_TIMEOUT_MS,
  HOOK_TIMEOUT_MS,
  VITEST_RUN_TIMEOUT_MS,

  // File locking
  LOCK_TIMEOUT_SECONDS,

  // Chrome pool
  MAX_CONCURRENT_BROWSERS,
  MAX_CONCURRENT_BROWSERS_CI,
  BROWSER_IDLE_TIMEOUT_MS,
  BROWSER_MAX_USE_TIME_MS,
  GUARDIAN_INTERVAL_MS
};
