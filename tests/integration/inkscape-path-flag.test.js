/**
 * Integration Tests for sbb-inkscape-getbbox.cjs --inkscape-path flag
 *
 * Tests the custom Inkscape path functionality.
 * Tests that require Inkscape are skipped if not installed.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { CLI_TIMEOUT_MS } from '../../config/timeouts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GETBBOX_PATH = path.join(__dirname, '../../sbb-inkscape-getbbox.cjs');
const FIXTURES_DIR = path.join(__dirname, '../fixtures');

// WHY CLI_TIMEOUT_MS * 3: Inkscape can take 10+ seconds to start on first run
// as it needs to build/load the font cache. Extra buffer for CI environments.
const INKSCAPE_TIMEOUT_MS = CLI_TIMEOUT_MS * 3;

/**
 * Check if Inkscape is available on the system.
 * WHY: Use a short 10s timeout to avoid hanging tests if Inkscape is not installed
 * or if it hangs during startup (common on CI servers without display).
 * @returns {boolean} True if Inkscape is installed and accessible
 */
function checkInkscapeAvailable() {
  try {
    const result = spawnSync('inkscape', ['--version'], {
      timeout: 10000, // WHY: 10s is enough to detect if Inkscape is installed
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'] // WHY: Prevent stdin blocking
    });
    return result.status === 0 && !result.error;
  } catch {
    return false;
  }
}

describe('sbb-inkscape-getbbox --inkscape-path flag', () => {
  let inkscapeAvailable = false;

  beforeAll(() => {
    inkscapeAvailable = checkInkscapeAvailable();
  }, 15000); // WHY: 15s timeout for beforeAll to prevent hanging

  describe('Help Message', () => {
    it('should include --inkscape-path option in help text', () => {
      const result = spawnSync('node', [GETBBOX_PATH, '--help'], {
        encoding: 'utf-8',
        timeout: 10000
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('--inkscape-path');
      expect(result.stdout).toContain('Specify custom Inkscape executable path');
    });

    it('should show example usage for --inkscape-path', () => {
      const result = spawnSync('node', [GETBBOX_PATH, '--help'], {
        encoding: 'utf-8',
        timeout: 10000
      });

      expect(result.status).toBe(0);
      // Check that examples include the flag
      expect(result.stdout).toContain('--inkscape-path /opt/homebrew/bin/inkscape');
    });
  });

  describe('Custom Inkscape Path Acceptance', () => {
    it('should accept --inkscape-path flag without error (valid path)', () => {
      // Skip if Inkscape not available - this test validates flag parsing
      if (!inkscapeAvailable) {
        console.warn('Skipping: Inkscape not installed');
        return;
      }

      const inputPath = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const result = spawnSync('node', [GETBBOX_PATH, inputPath, '--inkscape-path', 'inkscape'], {
        encoding: 'utf-8',
        timeout: INKSCAPE_TIMEOUT_MS
      });

      // Should succeed when Inkscape is available and path is valid
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('WHOLE CONTENT');
    });

    it('should accept --inkscape-path=value syntax', () => {
      // Skip if Inkscape not available
      if (!inkscapeAvailable) {
        console.warn('Skipping: Inkscape not installed');
        return;
      }

      const inputPath = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const result = spawnSync('node', [GETBBOX_PATH, inputPath, '--inkscape-path=inkscape'], {
        encoding: 'utf-8',
        timeout: INKSCAPE_TIMEOUT_MS
      });

      expect(result.status).toBe(0);
    });
  });

  describe('Invalid Inkscape Path Error Handling', () => {
    it('should produce helpful error for non-existent path', () => {
      const inputPath = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const invalidPath = '/nonexistent/path/to/inkscape';

      const result = spawnSync('node', [GETBBOX_PATH, inputPath, '--inkscape-path', invalidPath], {
        encoding: 'utf-8',
        timeout: 15000
      });

      // Should fail with non-zero exit code
      expect(result.status).not.toBe(0);

      // Combined output (stderr or stdout) should contain helpful message
      const output = result.stderr + result.stdout;
      expect(output).toContain('Inkscape not found');
      expect(output).toContain(invalidPath);
      expect(output).toContain('not found');
    });

    it('should suggest using --inkscape-path when Inkscape not found', () => {
      const inputPath = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const invalidPath = '/totally/fake/inkscape/binary';

      const result = spawnSync('node', [GETBBOX_PATH, inputPath, '--inkscape-path', invalidPath], {
        encoding: 'utf-8',
        timeout: 15000
      });

      const output = result.stderr + result.stdout;
      // Should suggest the flag in error message
      expect(output).toContain('--inkscape-path');
    });

    it('should show checked path in error output', () => {
      const inputPath = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const invalidPath = '/custom/invalid/inkscape';

      const result = spawnSync('node', [GETBBOX_PATH, inputPath, '--inkscape-path', invalidPath], {
        encoding: 'utf-8',
        timeout: 15000
      });

      const output = result.stderr + result.stdout;
      // Should list the path that was checked
      expect(output).toContain(invalidPath);
      expect(output).toContain('Checked');
    });
  });
});
