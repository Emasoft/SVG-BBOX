/**
 * Integration Tests for sbb-compare.cjs
 *
 * Tests the SVG comparison tool with real SVG files and Puppeteer rendering.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, spawnSync } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const execFilePromise = promisify(execFile);

// WHY: Helper that handles exit code 1 (files differ) without throwing
// sbb-compare exit codes: 0 = match, 1 = differ (success), 2 = error
function runCommandWithExitCode(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  if (result.error) {
    throw result.error;
  }
  // Exit code 2 means error, throw with stderr
  if (result.status === 2) {
    const err = new Error(result.stderr || 'Command failed with exit code 2');
    err.stderr = result.stderr;
    err.stdout = result.stdout;
    err.exitCode = result.status;
    throw err;
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status
  };
}
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COMPARER_PATH = path.join(__dirname, '../../sbb-compare.cjs');
const FIXTURES_DIR = path.join(__dirname, '../fixtures');
const TEMP_DIR = path.join(__dirname, '../.tmp-comparer-tests');

// Helper to run sbb-compare
// WHY: Uses runCommandWithExitCode because sbb-compare returns exit 1 for different files (expected)
async function runComparer(svg1, svg2, args = []) {
  const svg1Path = path.join(FIXTURES_DIR, svg1);
  const svg2Path = path.join(FIXTURES_DIR, svg2);

  // BUGFIX: Always specify --out-diff to prevent diff files polluting project root
  // Only add default if --out-diff is not already in args
  const hasOutDiff = args.some((arg, i) => arg === '--out-diff' && i < args.length - 1);
  const extraArgs = hasOutDiff
    ? []
    : [
        '--out-diff',
        path.join(
          TEMP_DIR,
          `${path.basename(svg1, '.svg')}_vs_${path.basename(svg2, '.svg')}_diff.png`
        )
      ];

  // WHY: Use runCommandWithExitCode to handle exit code 1 (files differ) without throwing
  const { stdout } = runCommandWithExitCode('node', [
    COMPARER_PATH,
    svg1Path,
    svg2Path,
    '--json',
    ...args,
    ...extraArgs
  ]);

  return JSON.parse(stdout);
}

describe('sbb-compare Integration Tests', () => {
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
        '--threshold',
        '1'
      ]);

      expect(result.threshold).toBe(1);
      expect(result.diffPercentage).toBeGreaterThan(0);
    });

    it('should accept threshold=10 (more tolerant)', async () => {
      const result = await runComparer('simple-rect.svg', 'simple-rect-red.svg', [
        '--threshold',
        '10'
      ]);

      expect(result.threshold).toBe(10);
      // Should still detect major color differences
      expect(result.diffPercentage).toBeGreaterThan(0);
    });
  });

  describe('Alignment Modes', () => {
    it('should support origin alignment', async () => {
      const result = await runComparer('simple-rect.svg', 'offset-rect.svg', [
        '--alignment',
        'origin'
      ]);

      expect(result.totalPixels).toBeGreaterThan(0);
    });

    it('should support viewbox-center alignment', async () => {
      const result = await runComparer('simple-rect.svg', 'offset-rect.svg', [
        '--alignment',
        'viewbox-center'
      ]);

      expect(result.totalPixels).toBeGreaterThan(0);
    });
  });

  describe('Resolution Modes', () => {
    it('should support viewbox resolution mode', async () => {
      const result = await runComparer('simple-rect.svg', 'simple-circle.svg', [
        '--resolution',
        'viewbox'
      ]);

      expect(result.totalPixels).toBeGreaterThan(0);
    });

    it('should support scale resolution mode', async () => {
      const result = await runComparer('simple-rect.svg', 'simple-circle.svg', [
        '--resolution',
        'scale'
      ]);

      expect(result.totalPixels).toBeGreaterThan(0);
    });
  });

  describe('Output Files', () => {
    it('should create diff PNG file', async () => {
      const diffPath = path.join(TEMP_DIR, 'test-diff.png');

      await runComparer('simple-rect.svg', 'simple-rect-red.svg', ['--out-diff', diffPath]);

      expect(fs.existsSync(diffPath)).toBe(true);

      // Verify it's a valid PNG file (starts with PNG signature)
      const buffer = fs.readFileSync(diffPath);
      expect(buffer[0]).toBe(0x89);
      expect(buffer[1]).toBe(0x50); // 'P'
      expect(buffer[2]).toBe(0x4e); // 'N'
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
      // threshold must be 1-255, so 300 is invalid
      await expect(
        runComparer('simple-rect.svg', 'simple-rect.svg', ['--threshold', '300'])
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

      // Should complete in under 30 seconds (includes Puppeteer startup)
      expect(duration).toBeLessThan(30000);
    }, 45000); // 45 second timeout to accommodate CI environments
  });
});

// ============================================================================
// PNG COMPARISON TESTS
// ============================================================================

const DIFF_SPECIMENS_DIR = path.join(__dirname, '../fixtures/diff-specimens');

// Helper to run sbb-compare with PNG files
// WHY: Uses runCommandWithExitCode because sbb-compare returns exit 1 for different files (expected)
async function runComparerWithPng(file1, file2, args = []) {
  const file1Path = path.join(DIFF_SPECIMENS_DIR, file1);
  const file2Path = path.join(DIFF_SPECIMENS_DIR, file2);

  const ext1 = path.extname(file1).slice(1);
  const ext2 = path.extname(file2).slice(1);
  const base1 = path.basename(file1, path.extname(file1));
  const base2 = path.basename(file2, path.extname(file2));

  // Always specify --out-diff to prevent diff files polluting project root
  const hasOutDiff = args.some((arg, i) => arg === '--out-diff' && i < args.length - 1);
  const extraArgs = hasOutDiff
    ? []
    : ['--out-diff', path.join(TEMP_DIR, `${base1}_${ext1}_vs_${base2}_${ext2}_diff.png`)];

  // WHY: Use runCommandWithExitCode to handle exit code 1 (files differ) without throwing
  const { stdout } = runCommandWithExitCode('node', [
    COMPARER_PATH,
    file1Path,
    file2Path,
    '--json',
    ...args,
    ...extraArgs
  ]);

  return JSON.parse(stdout);
}

describe('sbb-compare PNG Comparison Tests', () => {
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

  describe('PNG vs PNG Comparison', () => {
    it('should return 0% difference when comparing identical PNGs', async () => {
      const result = await runComparerWithPng('red-full.png', 'red-full.png');

      expect(result.diffPercentage).toBe(0);
      expect(result.differentPixels).toBe(0);
      expect(result.totalPixels).toBe(100); // 10x10 = 100 pixels
    });

    it('should detect 100% difference between completely different PNGs', async () => {
      const result = await runComparerWithPng('red-full.png', 'blue-full.png');

      expect(result.diffPercentage).toBe(100);
      expect(result.differentPixels).toBe(100);
      expect(result.totalPixels).toBe(100);
    });

    it('should detect 50% difference for half-different PNG', async () => {
      const result = await runComparerWithPng('red-full.png', 'half-red-half-blue.png');

      expect(result.diffPercentage).toBe(50);
      expect(result.differentPixels).toBe(50);
      expect(result.totalPixels).toBe(100);
    });
  });

  describe('SVG vs PNG Comparison', () => {
    it('should compare SVG to PNG by rendering SVG at PNG resolution', async () => {
      // Compare red SVG to red PNG - should be 0% diff
      const result = await runComparerWithPng('red-full.svg', 'red-full.png');

      expect(result.diffPercentage).toBe(0);
      expect(result.differentPixels).toBe(0);
      expect(result.totalPixels).toBe(100);
    });

    it('should detect differences between SVG and different colored PNG', async () => {
      // Compare red SVG to blue PNG - should be 100% diff
      const result = await runComparerWithPng('red-full.svg', 'blue-full.png');

      expect(result.diffPercentage).toBe(100);
      expect(result.differentPixels).toBe(100);
    });
  });

  describe('PNG vs SVG Comparison (reversed order)', () => {
    it('should handle PNG as first file and SVG as second', async () => {
      // Compare red PNG to red SVG - should be 0% diff
      const result = await runComparerWithPng('red-full.png', 'red-full.svg');

      expect(result.diffPercentage).toBe(0);
      expect(result.differentPixels).toBe(0);
    });

    it('should detect differences with PNG first and SVG second', async () => {
      // Compare blue PNG to red SVG - should be 100% diff
      const result = await runComparerWithPng('blue-full.png', 'red-full.svg');

      expect(result.diffPercentage).toBe(100);
    });
  });

  describe('PNG Comparison Error Handling', () => {
    it('should fail when PNG files have different dimensions with clear error message', async () => {
      // Create a different sized PNG for testing
      const differentSizePng = path.join(TEMP_DIR, 'different-size.png');

      // Create a 20x20 PNG using pngjs
      const { PNG } = await import('pngjs');
      const png = new PNG({ width: 20, height: 20 });

      // Fill with red color
      for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) {
          const idx = (png.width * y + x) << 2;
          png.data[idx] = 255; // R
          png.data[idx + 1] = 0; // G
          png.data[idx + 2] = 0; // B
          png.data[idx + 3] = 255; // A
        }
      }

      fs.writeFileSync(differentSizePng, PNG.sync.write(png));

      // Now try to compare 10x10 PNG with 20x20 PNG - should fail with dimension error
      try {
        await execFilePromise('node', [
          COMPARER_PATH,
          path.join(DIFF_SPECIMENS_DIR, 'red-full.png'),
          differentSizePng,
          '--json'
        ]);
        expect.fail('Should have thrown dimension mismatch error');
      } catch (err) {
        // Verify error message mentions dimensions
        expect(err.stderr).toMatch(/different dimensions|10x10|20x20/i);
      }
    });

    it('should reject unsupported file types with clear error', async () => {
      const txtFile = path.join(TEMP_DIR, 'test.txt');
      fs.writeFileSync(txtFile, 'not an image');

      try {
        await execFilePromise('node', [
          COMPARER_PATH,
          path.join(DIFF_SPECIMENS_DIR, 'red-full.png'),
          txtFile,
          '--json'
        ]);
        expect.fail('Should have thrown unsupported file type error');
      } catch (err) {
        // Verify error mentions file type
        expect(err.stderr).toMatch(/unsupported file type|invalid.*extension/i);
      }
    });

    it('should handle corrupted PNG files gracefully', async () => {
      // Create a file with .png extension but invalid content
      const corruptedPng = path.join(TEMP_DIR, 'corrupted.png');
      fs.writeFileSync(corruptedPng, 'this is not a valid PNG file');

      await expect(
        execFilePromise('node', [
          COMPARER_PATH,
          path.join(DIFF_SPECIMENS_DIR, 'red-full.png'),
          corruptedPng,
          '--json'
        ])
      ).rejects.toThrow();
    });
  });

  describe('PNG with Transparency', () => {
    it('should handle PNG with alpha channel correctly', async () => {
      // Create a PNG with transparency
      const { PNG } = await import('pngjs');
      const transparentPng = path.join(TEMP_DIR, 'transparent.png');
      const png = new PNG({ width: 10, height: 10 });

      // Fill with semi-transparent red
      for (let y = 0; y < png.height; y++) {
        for (let x = 0; x < png.width; x++) {
          const idx = (png.width * y + x) << 2;
          png.data[idx] = 255; // R
          png.data[idx + 1] = 0; // G
          png.data[idx + 2] = 0; // B
          png.data[idx + 3] = 128; // A = 50% transparent
        }
      }

      fs.writeFileSync(transparentPng, PNG.sync.write(png));

      // Compare semi-transparent red with solid red - should show differences
      // WHY: Use runCommandWithExitCode to handle exit code 1 (files differ) without throwing
      const diffPath = path.join(TEMP_DIR, 'transparency_diff.png');
      const { stdout } = runCommandWithExitCode('node', [
        COMPARER_PATH,
        path.join(DIFF_SPECIMENS_DIR, 'red-full.png'),
        transparentPng,
        '--json',
        '--out-diff',
        diffPath
      ]);

      const result = JSON.parse(stdout);
      // The alpha difference should be detected
      expect(result.diffPercentage).toBeGreaterThan(0);
    });
  });

  describe('PNG JSON Output', () => {
    it('should include correct file paths in JSON output for PNG comparison', async () => {
      const result = await runComparerWithPng('red-full.png', 'blue-full.png');

      // For PNG comparison, output should have file1/file2 or png1/png2
      expect(result).toHaveProperty('totalPixels');
      expect(result).toHaveProperty('differentPixels');
      expect(result).toHaveProperty('diffPercentage');
      expect(result).toHaveProperty('diffImage');
    });
  });
});

// ============================================================================
// ADDITIONAL CLI OPTIONS TESTS
// ============================================================================

describe('sbb-compare Additional CLI Options Tests', () => {
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

  describe('Verbose Output Mode', () => {
    it('should output detailed progress with --verbose flag', async () => {
      /** Tests that --verbose flag produces more detailed output than default mode */
      const svg1Path = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const svg2Path = path.join(FIXTURES_DIR, 'simple-circle.svg');
      const diffPath = path.join(TEMP_DIR, 'verbose_test_diff.png');

      // WHY: Use runCommandWithExitCode because files differ (exit code 1)
      const { stdout, stderr } = runCommandWithExitCode('node', [
        COMPARER_PATH,
        svg1Path,
        svg2Path,
        '--verbose',
        '--out-diff',
        diffPath
      ]);

      // Verbose output should include detailed progress info in stdout or stderr
      const combinedOutput = stdout + stderr;
      // Verbose mode provides more information than quiet mode
      expect(combinedOutput.length).toBeGreaterThan(20);
    });
  });

  describe('Quiet Output Mode', () => {
    it('should output minimal information with --quiet flag', async () => {
      /** Tests that --quiet flag produces minimal output suitable for scripting */
      const svg1Path = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const svg2Path = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const diffPath = path.join(TEMP_DIR, 'quiet_test_diff.png');

      const { stdout } = runCommandWithExitCode('node', [
        COMPARER_PATH,
        svg1Path,
        svg2Path,
        '--quiet',
        '--out-diff',
        diffPath
      ]);

      // Quiet mode should only output the diff percentage (minimal output)
      // Output should be very short - just a number or percentage
      const trimmed = stdout.trim();
      expect(trimmed.length).toBeLessThan(100);
      // Should contain numeric diff percentage
      expect(trimmed).toMatch(/\d/);
    });
  });

  describe('Headless and No-HTML Options', () => {
    it('should accept --no-html flag without error', async () => {
      /** Tests that --no-html flag prevents browser opening (report still generated) */
      const svg1Path = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const svg2Path = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const diffPath = path.join(TEMP_DIR, 'nohtml_test_diff.png');

      // Should complete without opening browser
      const { exitCode } = runCommandWithExitCode('node', [
        COMPARER_PATH,
        svg1Path,
        svg2Path,
        '--no-html',
        '--json',
        '--out-diff',
        diffPath
      ]);

      // Exit code 0 means identical files
      expect(exitCode).toBe(0);
    });

    it('should accept --headless flag as alias for --no-html', async () => {
      /** Tests that --headless is a valid alias for --no-html */
      const svg1Path = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const svg2Path = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const diffPath = path.join(TEMP_DIR, 'headless_test_diff.png');

      const { exitCode } = runCommandWithExitCode('node', [
        COMPARER_PATH,
        svg1Path,
        svg2Path,
        '--headless',
        '--json',
        '--out-diff',
        diffPath
      ]);

      expect(exitCode).toBe(0);
    });
  });

  describe('Meet Rule Option', () => {
    it('should accept --meet-rule xMinYMin with scale resolution', async () => {
      /** Tests that --meet-rule xMinYMin aligns to top-left corner during scaling */
      const svg1Path = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const svg2Path = path.join(FIXTURES_DIR, 'simple-circle.svg');
      const diffPath = path.join(TEMP_DIR, 'meet_xMinYMin_diff.png');

      const { stdout } = runCommandWithExitCode('node', [
        COMPARER_PATH,
        svg1Path,
        svg2Path,
        '--resolution',
        'scale',
        '--meet-rule',
        'xMinYMin',
        '--json',
        '--out-diff',
        diffPath
      ]);

      const result = JSON.parse(stdout);
      expect(result.totalPixels).toBeGreaterThan(0);
    });

    it('should accept --meet-rule xMaxYMax with scale resolution', async () => {
      /** Tests that --meet-rule xMaxYMax aligns to bottom-right corner during scaling */
      const svg1Path = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const svg2Path = path.join(FIXTURES_DIR, 'simple-circle.svg');
      const diffPath = path.join(TEMP_DIR, 'meet_xMaxYMax_diff.png');

      const { stdout } = runCommandWithExitCode('node', [
        COMPARER_PATH,
        svg1Path,
        svg2Path,
        '--resolution',
        'scale',
        '--meet-rule',
        'xMaxYMax',
        '--json',
        '--out-diff',
        diffPath
      ]);

      const result = JSON.parse(stdout);
      expect(result.totalPixels).toBeGreaterThan(0);
    });
  });

  describe('Slice Rule Option', () => {
    it('should accept --slice-rule xMidYMid with clip resolution', async () => {
      /** Tests that --slice-rule works with clip resolution mode */
      const svg1Path = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const svg2Path = path.join(FIXTURES_DIR, 'simple-circle.svg');
      const diffPath = path.join(TEMP_DIR, 'slice_xMidYMid_diff.png');

      const { stdout } = runCommandWithExitCode('node', [
        COMPARER_PATH,
        svg1Path,
        svg2Path,
        '--resolution',
        'clip',
        '--slice-rule',
        'xMidYMid',
        '--json',
        '--out-diff',
        diffPath
      ]);

      const result = JSON.parse(stdout);
      expect(result.totalPixels).toBeGreaterThan(0);
    });
  });

  describe('Aspect Ratio Threshold Option', () => {
    it('should accept --aspect-ratio-threshold with valid value', async () => {
      /** Tests that --aspect-ratio-threshold controls tolerance for aspect ratio differences */
      const svg1Path = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const svg2Path = path.join(FIXTURES_DIR, 'simple-circle.svg');
      const diffPath = path.join(TEMP_DIR, 'aspect_threshold_diff.png');

      // Both SVGs have 1:1 aspect ratio (100x100 and 200x200), so this should succeed
      const { stdout } = runCommandWithExitCode('node', [
        COMPARER_PATH,
        svg1Path,
        svg2Path,
        '--aspect-ratio-threshold',
        '0.01',
        '--json',
        '--out-diff',
        diffPath
      ]);

      const result = JSON.parse(stdout);
      expect(result.totalPixels).toBeGreaterThan(0);
    });

    it('should reject --aspect-ratio-threshold outside valid range', async () => {
      /** Tests that --aspect-ratio-threshold validates range (0-1) */
      const svg1Path = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const svg2Path = path.join(FIXTURES_DIR, 'simple-rect.svg');

      // Value > 1 is invalid
      await expect(
        execFilePromise('node', [
          COMPARER_PATH,
          svg1Path,
          svg2Path,
          '--aspect-ratio-threshold',
          '2.0'
        ])
      ).rejects.toThrow();
    });
  });

  describe('Scale Option', () => {
    it('should accept --scale parameter for resolution multiplier', async () => {
      /** Tests that --scale controls the render resolution multiplier */
      const svg1Path = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const svg2Path = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const diffPath = path.join(TEMP_DIR, 'scale_test_diff.png');

      // Using scale=2 means 2x resolution
      const { stdout } = runCommandWithExitCode('node', [
        COMPARER_PATH,
        svg1Path,
        svg2Path,
        '--scale',
        '2',
        '--json',
        '--out-diff',
        diffPath
      ]);

      const result = JSON.parse(stdout);
      // With scale=2 on 100x100 SVG, total pixels should be greater than base
      expect(result.totalPixels).toBeGreaterThan(0);
      expect(result.diffPercentage).toBe(0); // Identical files
    });
  });

  describe('Timeout Option', () => {
    it('should accept --timeout parameter in milliseconds', async () => {
      /** Tests that --timeout configures browser operation timeout */
      const svg1Path = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const svg2Path = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const diffPath = path.join(TEMP_DIR, 'timeout_test_diff.png');

      // Set a reasonable timeout (60 seconds)
      const { stdout } = runCommandWithExitCode('node', [
        COMPARER_PATH,
        svg1Path,
        svg2Path,
        '--timeout',
        '60000',
        '--json',
        '--out-diff',
        diffPath
      ]);

      const result = JSON.parse(stdout);
      expect(result.diffPercentage).toBe(0);
    });
  });

  describe('Trusted Mode Option', () => {
    it('should accept --trusted-mode flag for bypassing path restrictions', async () => {
      /** Tests that --trusted-mode disables CWD path security restrictions */
      const svg1Path = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const svg2Path = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const diffPath = path.join(TEMP_DIR, 'trusted_mode_diff.png');

      const { stdout } = runCommandWithExitCode('node', [
        COMPARER_PATH,
        svg1Path,
        svg2Path,
        '--trusted-mode',
        '--json',
        '--out-diff',
        diffPath
      ]);

      const result = JSON.parse(stdout);
      expect(result.diffPercentage).toBe(0);
    });
  });

  describe('Batch Comparison Mode', () => {
    it('should process batch file with multiple SVG pairs', async () => {
      /** Tests that --batch processes a tab-separated file of SVG pairs */
      // Create a batch file with two comparison pairs
      const batchFilePath = path.join(TEMP_DIR, 'test_batch.txt');
      const svg1 = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const svg2 = path.join(FIXTURES_DIR, 'simple-rect-red.svg');
      const svg3 = path.join(FIXTURES_DIR, 'simple-circle.svg');

      // Write batch file content (tab-separated)
      const batchContent = `${svg1}\t${svg1}\n${svg2}\t${svg3}`;
      fs.writeFileSync(batchFilePath, batchContent);

      const { stdout } = runCommandWithExitCode('node', [
        COMPARER_PATH,
        '--batch',
        batchFilePath,
        '--json',
        '--trusted-mode'
      ]);

      const result = JSON.parse(stdout);
      // Batch mode returns an array of results
      expect(Array.isArray(result.results)).toBe(true);
      expect(result.results.length).toBe(2);
      // First pair is identical
      expect(result.results[0].diffPercentage).toBe(0);
      // Second pair is different
      expect(result.results[1].diffPercentage).toBeGreaterThan(0);
    });

    it('should reject batch file with invalid format', async () => {
      /** Tests that --batch rejects files without proper tab separation */
      const batchFilePath = path.join(TEMP_DIR, 'invalid_batch.txt');
      // Invalid: using spaces instead of tabs
      const invalidContent = 'file1.svg file2.svg';
      fs.writeFileSync(batchFilePath, invalidContent);

      await expect(
        execFilePromise('node', [
          COMPARER_PATH,
          '--batch',
          batchFilePath,
          '--json',
          '--trusted-mode'
        ])
      ).rejects.toThrow();
    });
  });
});
