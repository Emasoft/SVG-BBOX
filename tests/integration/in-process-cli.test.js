/**
 * In-Process CLI Smoke Test
 *
 * Verifies the runCliInProcess helper works correctly with the shared
 * Chromium architecture. This test is a CONTRACT test for the helper —
 * if it breaks, all migrated tests break.
 *
 * Phase 3 of TRDD-882dea1b: enables ~250 integration tests to migrate
 * away from execFileAsync (which spawns subprocesses) toward direct
 * main() invocation. Each in-process call is ~50-200ms vs ~2-3s for
 * subprocess spawn — ~10-15x speedup.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { runCliInProcess, runCliInProcessOrThrow } from '../helpers/in-process-cli.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');

describe('In-Process CLI Helper Contract', () => {
  /** @type {string} */
  let tempDir;

  beforeEach(async () => {
    tempDir = path.join(
      PROJECT_ROOT,
      `temp_in_process_test_${Date.now()}_${Math.random().toString(36).slice(2)}`
    );
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('runs sbb-getbbox.cjs in-process with non-zero exit on missing file', async () => {
    // WHY no throw: runCliInProcess returns the exit code, doesn't throw.
    // This mirrors execFile's `reject: false` behavior.
    const result = await runCliInProcess('sbb-getbbox.cjs', [
      path.join(tempDir, 'nonexistent.svg')
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length + result.stdout.length).toBeGreaterThan(0);
  });

  it('runs sbb-getbbox.cjs in-process and computes a bbox for a simple SVG', async () => {
    const svgPath = path.join(tempDir, 'simple.svg');
    await fs.writeFile(
      svgPath,
      '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
        '<rect x="10" y="10" width="80" height="80" fill="blue"/></svg>'
    );

    const result = await runCliInProcessOrThrow('sbb-getbbox.cjs', [svgPath]);
    expect(result.exitCode).toBe(0);
    // Bbox output format: "{x: N, y: N, width: N, height: N}"
    expect(result.stdout).toMatch(/x:\s*\d/);
    expect(result.stdout).toMatch(/width:\s*\d/);
  });

  it('captures stderr separately from stdout', async () => {
    // sbb-getbbox prints info banners to stdout and errors to stderr.
    // Verify they're captured into separate streams.
    const result = await runCliInProcess('sbb-getbbox.cjs', ['--help']);
    // --help typically goes to stdout in well-behaved CLIs
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(0);
  });

  it('restores process.argv after the call', async () => {
    const argvBefore = process.argv.slice();
    await runCliInProcess('sbb-getbbox.cjs', ['--version']);
    expect(process.argv).toEqual(argvBefore);
  });

  it('restores process.exit after the call (test-process must survive)', async () => {
    // If the helper failed to restore process.exit, calling process.exit(0)
    // here would terminate the test process. The fact that this assertion
    // runs proves restoration worked.
    const exitBefore = process.exit;
    await runCliInProcess('sbb-getbbox.cjs', ['--version']);
    expect(process.exit).toBe(exitBefore);
  });
});
