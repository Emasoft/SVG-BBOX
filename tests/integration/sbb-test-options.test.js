/**
 * @file Integration tests for sbb-test CLI output options
 * @description Tests for --quiet and --verbose output flags to verify:
 *   - --quiet produces minimal output (only PASS/FAIL)
 *   - --verbose produces detailed progress information
 *   - Default mode produces normal output (file paths, results)
 *   - Flag precedence when both are specified
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { CLI_TIMEOUT_MS } from '../../config/timeouts.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

// CLI_EXEC_TIMEOUT: Timeout for CLI tool execution in integration tests
// sbb-test launches a browser, so needs extra time
const CLI_EXEC_TIMEOUT = CLI_TIMEOUT_MS * 2;

describe('sbb-test CLI Output Options', () => {
  let tempDir;

  beforeEach(async () => {
    // Create temporary directory for test files
    tempDir = path.join(projectRoot, `temp_sbb_test_options_${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup temporary directory and output files
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    // Clean up any output files created in project root
    const files = await fs.readdir(projectRoot);
    for (const file of files) {
      if (file.endsWith('-bbox-results.json') || file.endsWith('-bbox-errors.log')) {
        await fs.unlink(path.join(projectRoot, file)).catch(() => {});
      }
    }
  });

  it('should produce minimal output with --quiet flag (only PASS/FAIL)', async () => {
    /**
     * Test that --quiet suppresses all progress messages and version headers,
     * outputting only "PASS" or "FAIL (X errors)" on success/failure.
     */
    const svgPath = path.join(tempDir, 'quiet-test.svg');
    const svgContent = `<svg viewBox="0 0 100 100" width="100" height="100" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="80" height="80" fill="blue"/>
</svg>`;
    await fs.writeFile(svgPath, svgContent, 'utf8');

    const { stdout } = await execFileAsync('node', ['sbb-test.cjs', svgPath, '--quiet'], {
      cwd: projectRoot,
      timeout: CLI_EXEC_TIMEOUT
    });

    // Quiet mode should output only PASS or FAIL
    expect(stdout.trim()).toMatch(/^(PASS|FAIL \(\d+ errors\))$/);
    // Should NOT contain version header
    expect(stdout).not.toContain('sbb-test v');
    // Should NOT contain progress messages
    expect(stdout).not.toContain('Results written to:');
    expect(stdout).not.toContain('Errors written to:');
    expect(stdout).not.toContain('Launching browser');
  });

  it('should produce detailed output with --verbose flag', async () => {
    /**
     * Test that --verbose shows step-by-step progress information including
     * browser launch status, library injection, and test completion details.
     */
    const svgPath = path.join(tempDir, 'verbose-test.svg');
    const svgContent = `<svg viewBox="0 0 100 100" width="100" height="100" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="80" height="80" fill="green"/>
  <circle cx="50" cy="50" r="20" fill="red"/>
</svg>`;
    await fs.writeFile(svgPath, svgContent, 'utf8');

    const { stdout } = await execFileAsync('node', ['sbb-test.cjs', svgPath, '--verbose'], {
      cwd: projectRoot,
      timeout: CLI_EXEC_TIMEOUT
    });

    // Verbose mode should contain progress messages
    expect(stdout).toContain('Launching browser');
    expect(stdout).toContain('Browser launched successfully');
    expect(stdout).toContain('SvgVisualBBox library injected');
    expect(stdout).toContain('Running tests in browser context');
    expect(stdout).toContain('Tests completed');
    // Should also contain normal output (version header, results)
    expect(stdout).toContain('sbb-test v');
    expect(stdout).toContain('Results written to:');
  });

  it('should produce normal output without any flag (default mode)', async () => {
    /**
     * Test that default mode (no flags) shows version header and result file paths
     * but does NOT show detailed progress messages like --verbose does.
     */
    const svgPath = path.join(tempDir, 'default-test.svg');
    const svgContent = `<svg viewBox="0 0 100 100" width="100" height="100" xmlns="http://www.w3.org/2000/svg">
  <rect x="20" y="20" width="60" height="60" fill="purple"/>
</svg>`;
    await fs.writeFile(svgPath, svgContent, 'utf8');

    const { stdout } = await execFileAsync('node', ['sbb-test.cjs', svgPath], {
      cwd: projectRoot,
      timeout: CLI_EXEC_TIMEOUT
    });

    // Default mode should show version header
    expect(stdout).toContain('sbb-test v');
    // Should show result file paths
    expect(stdout).toContain('Results written to:');
    expect(stdout).toContain('Errors written to:');
    // Should NOT show verbose progress messages
    expect(stdout).not.toContain('Launching browser');
    expect(stdout).not.toContain('Browser launched successfully');
    expect(stdout).not.toContain('Running tests in browser context');
  });

  it('should have --quiet take precedence when both flags are specified', async () => {
    /**
     * Test that when both --quiet and --verbose are specified, --quiet takes
     * precedence and suppresses all output except PASS/FAIL.
     */
    const svgPath = path.join(tempDir, 'precedence-test.svg');
    const svgContent = `<svg viewBox="0 0 100 100" width="100" height="100" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="50" cy="50" rx="40" ry="30" fill="orange"/>
</svg>`;
    await fs.writeFile(svgPath, svgContent, 'utf8');

    // Test with both flags in different orders
    const { stdout: stdout1 } = await execFileAsync(
      'node',
      ['sbb-test.cjs', svgPath, '--quiet', '--verbose'],
      {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      }
    );

    const { stdout: stdout2 } = await execFileAsync(
      'node',
      ['sbb-test.cjs', svgPath, '--verbose', '--quiet'],
      {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      }
    );

    // Quiet should take precedence regardless of order
    // Output should be minimal (PASS/FAIL only)
    expect(stdout1.trim()).toMatch(/^(PASS|FAIL \(\d+ errors\))$/);
    expect(stdout2.trim()).toMatch(/^(PASS|FAIL \(\d+ errors\))$/);

    // Should NOT contain verbose messages
    expect(stdout1).not.toContain('Launching browser');
    expect(stdout2).not.toContain('Launching browser');

    // Should NOT contain version header
    expect(stdout1).not.toContain('sbb-test v');
    expect(stdout2).not.toContain('sbb-test v');
  });
});
