/**
 * Integration Tests for sbb-comparer.cjs
 *
 * Tests the SVG comparison tool with real SVG files and Puppeteer rendering.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const execFilePromise = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COMPARER_PATH = path.join(__dirname, '../../sbb-comparer.cjs');
const FIXTURES_DIR = path.join(__dirname, '../fixtures');
const TEMP_DIR = path.join(__dirname, '../.tmp-comparer-tests');

// Helper to run sbb-comparer
async function runComparer(svg1, svg2, args = []) {
  const svg1Path = path.join(FIXTURES_DIR, svg1);
  const svg2Path = path.join(FIXTURES_DIR, svg2);

  const { stdout, stderr: _stderr } = await execFilePromise('node', [
    COMPARER_PATH,
    svg1Path,
    svg2Path,
    '--json',
    ...args
  ]);

  return JSON.parse(stdout);
}

describe('sbb-comparer Integration Tests', () => {

  beforeAll(() => {
    // Create temp directory for test outputs
    if (!fs.existsSync(TEMP_DIR)) {
      fs.mkdirSync(TEMP_DIR, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up temp directory
    if (fs.existsSync(TEMP_DIR)) {
      fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });

  describe('Identical SVGs', () => {
    it('should return 0% difference when comparing same file', async () => {
      const result = await runComparer('simple-rect.svg', 'simple-rect.svg');

      expect(result.diffPercentage).toBe(0);
      expect(result.differentPixels).toBe(0);
      expect(result.totalPixels).toBeGreaterThan(0);
    });
  });

  describe('Different Colors', () => {
    it('should detect color differences (blue vs red rect)', async () => {
      const result = await runComparer('simple-rect.svg', 'simple-rect-red.svg');

      expect(result.diffPercentage).toBeGreaterThan(0);
      expect(result.differentPixels).toBeGreaterThan(0);
      // Most pixels should be different due to color change
      expect(result.diffPercentage).toBeGreaterThan(50);
    });
  });

  describe('Different Sizes', () => {
    it('should handle SVGs with different viewBox sizes', async () => {
      const result = await runComparer('simple-rect.svg', 'simple-circle.svg');

      expect(result.diffPercentage).toBeGreaterThan(0);
      expect(result.totalPixels).toBeGreaterThan(0);
    });
  });

  describe('Threshold Configuration', () => {
    it('should respect threshold=1 (strict)', async () => {
      const result = await runComparer('simple-rect.svg', 'simple-rect-red.svg', [
        '--threshold', '1'
      ]);

      expect(result.threshold).toBe(1);
      expect(result.diffPercentage).toBeGreaterThan(0);
    });

    it('should accept threshold=10 (more tolerant)', async () => {
      const result = await runComparer('simple-rect.svg', 'simple-rect-red.svg', [
        '--threshold', '10'
      ]);

      expect(result.threshold).toBe(10);
      // Should still detect major color differences
      expect(result.diffPercentage).toBeGreaterThan(0);
    });
  });

  describe('Alignment Modes', () => {
    it('should support origin alignment', async () => {
      const result = await runComparer('simple-rect.svg', 'offset-rect.svg', [
        '--alignment', 'origin'
      ]);

      expect(result.totalPixels).toBeGreaterThan(0);
    });

    it('should support viewbox-center alignment', async () => {
      const result = await runComparer('simple-rect.svg', 'offset-rect.svg', [
        '--alignment', 'viewbox-center'
      ]);

      expect(result.totalPixels).toBeGreaterThan(0);
    });
  });

  describe('Resolution Modes', () => {
    it('should support viewbox resolution mode', async () => {
      const result = await runComparer('simple-rect.svg', 'simple-circle.svg', [
        '--resolution', 'viewbox'
      ]);

      expect(result.totalPixels).toBeGreaterThan(0);
    });

    it('should support scale resolution mode', async () => {
      const result = await runComparer('simple-rect.svg', 'simple-circle.svg', [
        '--resolution', 'scale'
      ]);

      expect(result.totalPixels).toBeGreaterThan(0);
    });
  });

  describe('Output Files', () => {
    it('should create diff PNG file', async () => {
      const diffPath = path.join(TEMP_DIR, 'test-diff.png');

      await runComparer('simple-rect.svg', 'simple-rect-red.svg', [
        '--out-diff', diffPath
      ]);

      expect(fs.existsSync(diffPath)).toBe(true);

      // Verify it's a valid PNG file (starts with PNG signature)
      const buffer = fs.readFileSync(diffPath);
      expect(buffer[0]).toBe(0x89);
      expect(buffer[1]).toBe(0x50); // 'P'
      expect(buffer[2]).toBe(0x4E); // 'N'
      expect(buffer[3]).toBe(0x47); // 'G'
    });
  });

  describe('JSON Output', () => {
    it('should include all required fields in JSON output', async () => {
      const result = await runComparer('simple-rect.svg', 'simple-rect.svg');

      expect(result).toHaveProperty('svg1');
      expect(result).toHaveProperty('svg2');
      expect(result).toHaveProperty('totalPixels');
      expect(result).toHaveProperty('differentPixels');
      expect(result).toHaveProperty('diffPercentage');
      expect(result).toHaveProperty('threshold');
      expect(result).toHaveProperty('diffImage');
    });

    it('should have correct data types', async () => {
      const result = await runComparer('simple-rect.svg', 'simple-rect.svg');

      expect(typeof result.svg1).toBe('string');
      expect(typeof result.svg2).toBe('string');
      expect(typeof result.totalPixels).toBe('number');
      expect(typeof result.differentPixels).toBe('number');
      expect(typeof result.diffPercentage).toBe('number');
      expect(typeof result.threshold).toBe('number');
      expect(typeof result.diffImage).toBe('string');
    });
  });

  describe('Edge Cases', () => {
    it('should handle identical files with 100% match', async () => {
      const result = await runComparer('simple-rect.svg', 'simple-rect.svg');

      expect(result.diffPercentage).toBe(0);
      expect(result.differentPixels).toBe(0);
    });

    it('should handle completely different SVGs', async () => {
      const result = await runComparer('simple-rect.svg', 'simple-circle.svg');

      // Should have significant differences
      expect(result.diffPercentage).toBeGreaterThan(10);
      expect(result.differentPixels).toBeGreaterThan(0);
    });
  });

  describe('Error Handling', () => {
    it('should fail gracefully with invalid threshold', async () => {
      await expect(
        runComparer('simple-rect.svg', 'simple-rect.svg', ['--threshold', '25'])
      ).rejects.toThrow();
    });

    it('should fail gracefully with non-existent file', async () => {
      const svg1Path = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const svg2Path = path.join(FIXTURES_DIR, 'nonexistent.svg');

      await expect(
        execFilePromise('node', [COMPARER_PATH, svg1Path, svg2Path, '--json'])
      ).rejects.toThrow();
    });
  });

  describe('Performance', () => {
    it('should complete comparison in reasonable time', async () => {
      const start = Date.now();
      await runComparer('simple-rect.svg', 'simple-rect.svg');
      const duration = Date.now() - start;

      // Should complete in under 10 seconds
      expect(duration).toBeLessThan(10000);
    }, 15000);
  });
});
