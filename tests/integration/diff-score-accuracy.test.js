/**
 * @file Diff Score Accuracy Tests
 * @description Tests to verify that sbb-compare calculates diff scores correctly
 * using controlled specimens with known, predictable pixel values.
 *
 * These tests use pixel-aligned SVGs rendered at exact dimensions to avoid
 * any antialiasing artifacts that could affect the diff calculation.
 *
 * IMPORTANT: These tests prevent regressions in diff score calculation.
 * If they fail, it indicates a change in the comparison algorithm or
 * the rendering pipeline that affects accuracy.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execFilePromise = promisify(execFile);

const FIXTURES_DIR = path.join(process.cwd(), 'tests/fixtures/diff-specimens');
const TEMP_DIR = path.join(process.cwd(), 'tests/.tmp-diff-accuracy');

describe('Diff Score Accuracy Tests', () => {
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

  describe('Exact Diff Score Calculation', () => {
    it('should return 0% diff for identical SVGs (red vs red)', async () => {
      // Compare red-full.svg with itself
      // Expected: 0 different pixels / 100 total = 0%
      const svg1 = path.join(FIXTURES_DIR, 'red-full.svg');
      const diffOutput = path.join(TEMP_DIR, 'identical-diff.png');

      const { stdout } = await execFilePromise('node', [
        'sbb-compare.cjs',
        svg1,
        svg1, // Same file = identical
        '--out-diff',
        diffOutput,
        '--json',
        '--no-html',
        '--scale',
        '1', // Use scale 1 to get 10x10 output
      ]);

      const result = JSON.parse(stdout);

      expect(result.diffPercentage).toBe(0);
      expect(result.differentPixels).toBe(0);
      expect(result.totalPixels).toBe(100); // 10x10
    }, 60000);

    it('should return 100% diff for completely different SVGs (red vs blue)', async () => {
      // Compare red-full.svg with blue-full.svg
      // Expected: 100 different pixels / 100 total = 100%
      // All pixels differ in R and B channels
      const svg1 = path.join(FIXTURES_DIR, 'red-full.svg');
      const svg2 = path.join(FIXTURES_DIR, 'blue-full.svg');
      const diffOutput = path.join(TEMP_DIR, 'red-vs-blue-diff.png');

      const { stdout } = await execFilePromise('node', [
        'sbb-compare.cjs',
        svg1,
        svg2,
        '--out-diff',
        diffOutput,
        '--json',
        '--no-html',
        '--scale',
        '1',
      ]);

      const result = JSON.parse(stdout);

      expect(result.diffPercentage).toBe(100);
      expect(result.differentPixels).toBe(100);
      expect(result.totalPixels).toBe(100);
    }, 60000);

    it('should return 50% diff for half-different SVGs (red vs half-red-half-blue)', async () => {
      // Compare red-full.svg with half-red-half-blue.svg
      // Left 5 columns (50 pixels) are identical (red vs red)
      // Right 5 columns (50 pixels) are different (red vs blue)
      // Expected: 50 different pixels / 100 total = 50%
      const svg1 = path.join(FIXTURES_DIR, 'red-full.svg');
      const svg2 = path.join(FIXTURES_DIR, 'half-red-half-blue.svg');
      const diffOutput = path.join(TEMP_DIR, 'red-vs-half-diff.png');

      const { stdout } = await execFilePromise('node', [
        'sbb-compare.cjs',
        svg1,
        svg2,
        '--out-diff',
        diffOutput,
        '--json',
        '--no-html',
        '--scale',
        '1',
      ]);

      const result = JSON.parse(stdout);

      expect(result.diffPercentage).toBe(50);
      expect(result.differentPixels).toBe(50);
      expect(result.totalPixels).toBe(100);
    }, 60000);

    it('should return 50% diff for complementary halves (blue vs half-red-half-blue)', async () => {
      // Compare blue-full.svg with half-red-half-blue.svg
      // Left 5 columns (50 pixels) are different (blue vs red)
      // Right 5 columns (50 pixels) are identical (blue vs blue)
      // Expected: 50 different pixels / 100 total = 50%
      const svg1 = path.join(FIXTURES_DIR, 'blue-full.svg');
      const svg2 = path.join(FIXTURES_DIR, 'half-red-half-blue.svg');
      const diffOutput = path.join(TEMP_DIR, 'blue-vs-half-diff.png');

      const { stdout } = await execFilePromise('node', [
        'sbb-compare.cjs',
        svg1,
        svg2,
        '--out-diff',
        diffOutput,
        '--json',
        '--no-html',
        '--scale',
        '1',
      ]);

      const result = JSON.parse(stdout);

      expect(result.diffPercentage).toBe(50);
      expect(result.differentPixels).toBe(50);
      expect(result.totalPixels).toBe(100);
    }, 60000);
  });

  describe('Diff Score Formula Verification', () => {
    it('should calculate diff as (differentPixels / totalPixels) * 100', async () => {
      // This test verifies the exact formula by checking the relationship
      // between differentPixels, totalPixels, and diffPercentage
      const svg1 = path.join(FIXTURES_DIR, 'red-full.svg');
      const svg2 = path.join(FIXTURES_DIR, 'half-red-half-blue.svg');
      const diffOutput = path.join(TEMP_DIR, 'formula-test-diff.png');

      const { stdout } = await execFilePromise('node', [
        'sbb-compare.cjs',
        svg1,
        svg2,
        '--out-diff',
        diffOutput,
        '--json',
        '--no-html',
        '--scale',
        '1',
      ]);

      const result = JSON.parse(stdout);

      // Calculate expected percentage from pixels
      const calculatedPercentage =
        (result.differentPixels / result.totalPixels) * 100;

      // The stored diffPercentage should match the calculated value
      expect(result.diffPercentage).toBeCloseTo(calculatedPercentage, 2);
    }, 60000);

    it('should handle threshold correctly (pixels within threshold are identical)', async () => {
      // With threshold=1, pixels must differ by MORE than 1 to be counted as different
      // Since our specimens use pure colors (0 or 255), threshold=1 should not affect results
      const svg1 = path.join(FIXTURES_DIR, 'red-full.svg');
      const svg2 = path.join(FIXTURES_DIR, 'blue-full.svg');
      const diffOutput = path.join(TEMP_DIR, 'threshold-test-diff.png');

      // Test with default threshold (1)
      const { stdout: stdout1 } = await execFilePromise('node', [
        'sbb-compare.cjs',
        svg1,
        svg2,
        '--out-diff',
        diffOutput,
        '--json',
        '--no-html',
        '--scale',
        '1',
        '--threshold',
        '1',
      ]);

      const result1 = JSON.parse(stdout1);
      expect(result1.diffPercentage).toBe(100);

      // Test with very high threshold (254)
      // Red (255,0,0) vs Blue (0,0,255): R differs by 255, B differs by 255
      // With threshold=254, differences of 255 still exceed threshold, so still 100%
      const { stdout: stdout2 } = await execFilePromise('node', [
        'sbb-compare.cjs',
        svg1,
        svg2,
        '--out-diff',
        diffOutput,
        '--json',
        '--no-html',
        '--scale',
        '1',
        '--threshold',
        '254',
      ]);

      const result2 = JSON.parse(stdout2);
      expect(result2.diffPercentage).toBe(100);

      // Test with threshold=255 (maximum)
      // No difference can exceed 255, so all pixels should be "identical"
      const { stdout: stdout3 } = await execFilePromise('node', [
        'sbb-compare.cjs',
        svg1,
        svg2,
        '--out-diff',
        diffOutput,
        '--json',
        '--no-html',
        '--scale',
        '1',
        '--threshold',
        '255',
      ]);

      const result3 = JSON.parse(stdout3);
      expect(result3.diffPercentage).toBe(0);
    }, 120000);
  });
});
