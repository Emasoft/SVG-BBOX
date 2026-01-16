/**
 * @file Critical Regression Tests for sbb-svg2png and sbb-compare
 * @description These tests guard against two critical bugs that caused 3 days of debugging:
 *
 * BUG 1 (Fixed in commit 59d0a0c): sbb-svg2png.cjs was modifying the viewBox
 * even in "visible" mode (default), corrupting PNG output by showing expanded
 * content instead of only what's inside the original viewBox.
 *
 * BUG 2 (Fixed in commit 59d0a0c): sbb-compare.cjs was generating diff images
 * at 1/4 resolution (using viewBox dimensions directly as pixels instead of
 * applying the 4x default scale factor).
 *
 * THESE TESTS MUST NEVER BE MODIFIED OR DISABLED WITHOUT UNDERSTANDING THE BUGS THEY PREVENT.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile, spawnSync } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';
import { CLI_TIMEOUT_MS } from '../../config/timeouts.js';

const execFileAsync = promisify(execFile);

// WHY: Helper that handles exit code 1 (files differ) without throwing
// sbb-compare exit codes: 0 = match, 1 = differ (success), 2 = error
function runCompareCommand(args, cwd, timeout) {
  const result = spawnSync('node', args, {
    encoding: 'utf8',
    cwd,
    timeout
  });
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
const projectRoot = path.resolve(__dirname, '../..');

// CLI_EXEC_TIMEOUT: Timeout for CLI tool execution in integration tests
const CLI_EXEC_TIMEOUT = CLI_TIMEOUT_MS * 2;

/**
 * Parse PNG file and return dimensions and pixel data
 */
async function parsePng(pngPath) {
  const buffer = await fs.readFile(pngPath);
  return new Promise((resolve, reject) => {
    const png = new PNG();
    png.parse(buffer, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

/**
 * Check if PNG contains any pixels of a specific color (with tolerance)
 * @param {PNG} png - Parsed PNG object
 * @param {number} r - Red component (0-255)
 * @param {number} g - Green component (0-255)
 * @param {number} b - Blue component (0-255)
 * @param {number} tolerance - Color matching tolerance (default 10)
 * @returns {boolean} True if color is found
 */
function pngContainsColor(png, r, g, b, tolerance = 10) {
  for (let i = 0; i < png.data.length; i += 4) {
    const pr = png.data[i];
    const pg = png.data[i + 1];
    const pb = png.data[i + 2];
    if (
      Math.abs(pr - r) <= tolerance &&
      Math.abs(pg - g) <= tolerance &&
      Math.abs(pb - b) <= tolerance
    ) {
      return true;
    }
  }
  return false;
}

describe('CRITICAL REGRESSION: ViewBox Preservation in sbb-svg2png', () => {
  /**
   * CRITICAL REGRESSION TEST FOR BUG 1
   *
   * This test ensures sbb-svg2png does NOT modify the viewBox in "visible" mode.
   *
   * The bug was: viewBox was unconditionally modified at the end of the measure
   * function, causing the PNG to include content OUTSIDE the original viewBox.
   *
   * The fix: Only modify viewBox in "full" or "element" mode, NOT in "visible" mode.
   *
   * Detection strategy:
   * 1. Create SVG with content OUTSIDE the viewBox (a red rect beyond viewBox boundaries)
   * 2. Run sbb-svg2png in "visible" mode (default)
   * 3. If viewBox is correctly PRESERVED: PNG shows ONLY content INSIDE viewBox (blue rect)
   * 4. If viewBox is INCORRECTLY modified (bug): PNG would expand to include red rect
   *
   * We verify by checking:
   * - PNG does NOT contain the red color (which is outside viewBox)
   * - PNG dimensions correspond to content INSIDE viewBox only
   */

  let tempDir;

  beforeEach(async () => {
    tempDir = path.join(projectRoot, `temp_viewbox_regression_${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should NOT modify viewBox in visible mode - content outside viewBox must be excluded', async () => {
    /**
     * Test: ViewBox preservation in visible mode
     *
     * SVG structure:
     * - viewBox="0 0 100 100" (window shows only 0-100 range)
     * - Blue rect at (10,10,80,80) - INSIDE viewBox, should be visible
     * - Red rect at (150,150,50,50) - OUTSIDE viewBox, must NOT be visible
     *
     * If the bug exists (viewBox modified):
     * - viewBox would expand to include red rect
     * - PNG would contain red pixels
     * - PNG would be MUCH larger (to accommodate content at 150-200 range)
     *
     * If bug is fixed (viewBox preserved):
     * - viewBox stays at 0 0 100 100
     * - PNG shows ONLY blue rect
     * - PNG does NOT contain any red pixels
     * - PNG dimensions are reasonable (close to visible content, not expanded to 200+)
     *
     * NOTE: SvgVisualBBox uses pixel-based visual detection with tolerance,
     * so bbox dimensions may vary slightly from exact geometric bounds.
     * The critical check is that content OUTSIDE viewBox is NOT included.
     */
    const svgPath = path.join(tempDir, 'viewbox-test.svg');
    const pngPath = path.join(tempDir, 'viewbox-test.png');

    const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <!-- Content INSIDE viewBox (0-100 range) - should be visible -->
  <rect id="inside" x="10" y="10" width="80" height="80" fill="blue"/>

  <!-- Content OUTSIDE viewBox (beyond 100) - must NOT be visible in visible mode -->
  <!-- This red rect is completely outside the viewBox boundaries -->
  <rect id="outside" x="150" y="150" width="50" height="50" fill="red"/>
</svg>`;
    await fs.writeFile(svgPath, svgContent, 'utf8');

    // Run sbb-svg2png in visible mode (default) with scale 1 for easier dimension checking
    await execFileAsync(
      'node',
      ['sbb-svg2png.cjs', svgPath, pngPath, '--mode', 'visible', '--scale', '1'],
      {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      }
    );

    // Parse the PNG
    const png = await parsePng(pngPath);

    // CRITICAL CHECK 1: PNG must NOT contain red color
    // Red rect is at (150,150) which is OUTSIDE viewBox (0,0,100,100)
    // If viewBox was incorrectly modified, red would appear in the PNG
    const containsRed = pngContainsColor(png, 255, 0, 0);
    expect(containsRed).toBe(false);

    // CRITICAL CHECK 2: PNG should contain blue color (content inside viewBox)
    const containsBlue = pngContainsColor(png, 0, 0, 255);
    expect(containsBlue).toBe(true);

    // CRITICAL CHECK 3: PNG dimensions should be reasonable for content INSIDE viewBox
    // Blue rect is 80x80, but pixel-based detection may have small tolerance.
    // The bug would cause dimensions to be 190+ (to include red rect at 150-200)
    // We allow tolerance of 15 pixels for pixel-sampling detection accuracy
    // But dimensions must NOT exceed viewBox size (100x100)
    expect(png.width).toBeGreaterThanOrEqual(75);
    expect(png.width).toBeLessThanOrEqual(100);
    expect(png.height).toBeGreaterThanOrEqual(75);
    expect(png.height).toBeLessThanOrEqual(100);

    // CRITICAL CHECK 4: If the bug existed, PNG would be much larger (190+ pixels)
    // to accommodate the red rect at position 150-200
    expect(png.width).toBeLessThan(150);
    expect(png.height).toBeLessThan(150);
  });

  it('should correctly expand viewBox in full mode - content outside viewBox must be included', async () => {
    /**
     * Countertest: Verify that "full" mode DOES expand viewBox to include all content.
     * This confirms the conditional logic is working correctly.
     */
    const svgPath = path.join(tempDir, 'viewbox-full-test.svg');
    const pngPath = path.join(tempDir, 'viewbox-full-test.png');

    const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <!-- Content INSIDE viewBox -->
  <rect id="inside" x="10" y="10" width="80" height="80" fill="blue"/>

  <!-- Content OUTSIDE viewBox - should be visible in full mode -->
  <rect id="outside" x="150" y="150" width="50" height="50" fill="red"/>
</svg>`;
    await fs.writeFile(svgPath, svgContent, 'utf8');

    // Run sbb-svg2png in FULL mode (should expand viewBox)
    await execFileAsync(
      'node',
      ['sbb-svg2png.cjs', svgPath, pngPath, '--mode', 'full', '--scale', '1'],
      {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      }
    );

    const png = await parsePng(pngPath);

    // In full mode, viewBox IS expanded, so red rect SHOULD be visible
    const containsRed = pngContainsColor(png, 255, 0, 0);
    expect(containsRed).toBe(true);

    // Blue rect should also be visible
    const containsBlue = pngContainsColor(png, 0, 0, 255);
    expect(containsBlue).toBe(true);

    // PNG should be larger to accommodate both rects
    // Full bbox: from (10,10) to (200,200) = 190x190 at scale 1
    expect(png.width).toBeGreaterThan(150);
    expect(png.height).toBeGreaterThan(150);
  });

  it('should preserve viewBox when using default mode (no --mode flag)', async () => {
    /**
     * Test: Verify default behavior (no --mode flag) preserves viewBox.
     * Default mode should be "visible", which means viewBox is preserved.
     *
     * NOTE: SvgVisualBBox uses pixel-based visual detection with tolerance,
     * so bbox dimensions may vary slightly from exact geometric bounds.
     */
    const svgPath = path.join(tempDir, 'viewbox-default-test.svg');
    const pngPath = path.join(tempDir, 'viewbox-default-test.png');

    const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect x="10" y="10" width="80" height="80" fill="green"/>
  <rect x="200" y="200" width="100" height="100" fill="yellow"/>
</svg>`;
    await fs.writeFile(svgPath, svgContent, 'utf8');

    // Run WITHOUT --mode flag (should default to visible)
    await execFileAsync('node', ['sbb-svg2png.cjs', svgPath, pngPath, '--scale', '1'], {
      cwd: projectRoot,
      timeout: CLI_EXEC_TIMEOUT
    });

    const png = await parsePng(pngPath);

    // CRITICAL: Should NOT contain yellow (outside viewBox at 200,200)
    const containsYellow = pngContainsColor(png, 255, 255, 0);
    expect(containsYellow).toBe(false);

    // Should contain green (inside viewBox)
    const containsGreen = pngContainsColor(png, 0, 128, 0);
    expect(containsGreen).toBe(true);

    // Dimensions should be reasonable for content INSIDE viewBox
    // Green rect is 80x80, allow tolerance for pixel-based detection
    // The bug would cause dimensions to be 290+ (to include yellow rect at 200-300)
    expect(png.width).toBeGreaterThanOrEqual(75);
    expect(png.width).toBeLessThanOrEqual(100);
    expect(png.height).toBeGreaterThanOrEqual(75);
    expect(png.height).toBeLessThanOrEqual(100);

    // CRITICAL: If the bug existed, PNG would be much larger (290+ pixels)
    expect(png.width).toBeLessThan(150);
    expect(png.height).toBeLessThan(150);
  });
});

describe('CRITICAL REGRESSION: Resolution Scaling in sbb-compare', () => {
  /**
   * CRITICAL REGRESSION TEST FOR BUG 2
   *
   * This test ensures sbb-compare applies the 4x default scale factor correctly.
   *
   * The bug was: In all resolution modes, viewBox dimensions were used directly
   * as pixel dimensions WITHOUT applying the scale factor. A viewBox of 100x100
   * resulted in a 100x100 diff PNG instead of 400x400 (4x scale).
   *
   * The fix: Apply scale factor to all resolution calculations.
   *
   * Detection strategy:
   * 1. Create two SVGs with known viewBox dimensions (100x100)
   * 2. Run comparer with default settings (4x scale)
   * 3. If scale is correctly applied: diff PNG is 400x400
   * 4. If scale is NOT applied (bug): diff PNG would be 100x100
   */

  let tempDir;

  beforeEach(async () => {
    tempDir = path.join(projectRoot, `temp_resolution_regression_${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should generate diff PNG at 4x scale by default (400x400 for 100x100 viewBox)', async () => {
    /**
     * Test: Default 4x scale factor is applied to diff PNG
     *
     * SVG structure:
     * - Both SVGs have viewBox="0 0 100 100"
     * - Default scale is 4x
     * - Expected diff PNG size: 100 * 4 = 400 pixels per dimension
     *
     * If bug exists (no scale applied):
     * - Diff PNG would be 100x100 (viewBox dimensions directly)
     *
     * If bug is fixed (scale applied):
     * - Diff PNG is 400x400 (viewBox * 4x scale)
     */
    const svg1Path = path.join(tempDir, 'svg1.svg');
    const svg2Path = path.join(tempDir, 'svg2.svg');
    const diffPath = path.join(tempDir, 'diff.png');

    // Create two SVGs with 100x100 viewBox
    const svg1Content = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect x="10" y="10" width="80" height="80" fill="blue"/>
</svg>`;

    const svg2Content = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect x="10" y="10" width="80" height="80" fill="red"/>
</svg>`;

    await fs.writeFile(svg1Path, svg1Content, 'utf8');
    await fs.writeFile(svg2Path, svg2Content, 'utf8');

    // Run comparer with default settings (4x scale)
    // WHY: Use runCompareCommand because sbb-compare returns exit code 1 for different files
    runCompareCommand(
      ['sbb-compare.cjs', svg1Path, svg2Path, '--json', '--out-diff', diffPath],
      projectRoot,
      CLI_EXEC_TIMEOUT
    );

    // Parse the diff PNG
    const png = await parsePng(diffPath);

    // CRITICAL CHECK: Diff PNG must be 400x400 (100 viewBox * 4x scale)
    // If the bug existed, it would be 100x100
    expect(png.width).toBe(400);
    expect(png.height).toBe(400);
  });

  it('should generate diff PNG at specified scale (2x = 200x200 for 100x100 viewBox)', async () => {
    /**
     * Test: Custom scale factor is respected
     */
    const svg1Path = path.join(tempDir, 'svg1-2x.svg');
    const svg2Path = path.join(tempDir, 'svg2-2x.svg');
    const diffPath = path.join(tempDir, 'diff-2x.png');

    const svg1Content = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <circle cx="50" cy="50" r="40" fill="green"/>
</svg>`;

    const svg2Content = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <circle cx="50" cy="50" r="40" fill="purple"/>
</svg>`;

    await fs.writeFile(svg1Path, svg1Content, 'utf8');
    await fs.writeFile(svg2Path, svg2Content, 'utf8');

    // Run with explicit 2x scale
    // WHY: Use runCompareCommand because sbb-compare returns exit code 1 for different files
    runCompareCommand(
      ['sbb-compare.cjs', svg1Path, svg2Path, '--json', '--scale', '2', '--out-diff', diffPath],
      projectRoot,
      CLI_EXEC_TIMEOUT
    );

    const png = await parsePng(diffPath);

    // Diff PNG must be 200x200 (100 viewBox * 2x scale)
    expect(png.width).toBe(200);
    expect(png.height).toBe(200);
  });

  it('should generate diff PNG at 8x scale (800x800 for 100x100 viewBox)', async () => {
    /**
     * Test: High-resolution scale factor for detailed comparison
     * This is important because SVGs contain fine details that may only
     * be visible at high resolution (e.g., a flower vs a planet).
     */
    const svg1Path = path.join(tempDir, 'svg1-8x.svg');
    const svg2Path = path.join(tempDir, 'svg2-8x.svg');
    const diffPath = path.join(tempDir, 'diff-8x.png');

    const svg1Content = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect x="20" y="20" width="60" height="60" fill="orange"/>
</svg>`;

    const svg2Content = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect x="20" y="20" width="60" height="60" fill="cyan"/>
</svg>`;

    await fs.writeFile(svg1Path, svg1Content, 'utf8');
    await fs.writeFile(svg2Path, svg2Content, 'utf8');

    // Run with 8x scale for high-resolution comparison
    // WHY: Use runCompareCommand because sbb-compare returns exit code 1 for different files
    runCompareCommand(
      ['sbb-compare.cjs', svg1Path, svg2Path, '--json', '--scale', '8', '--out-diff', diffPath],
      projectRoot,
      CLI_EXEC_TIMEOUT
    );

    const png = await parsePng(diffPath);

    // Diff PNG must be 800x800 (100 viewBox * 8x scale)
    expect(png.width).toBe(800);
    expect(png.height).toBe(800);
  });

  it('should apply scale to non-square viewBox correctly', async () => {
    /**
     * Test: Scale factor works correctly with non-square aspect ratios
     * ViewBox 200x100 at 4x scale = 800x400
     */
    const svg1Path = path.join(tempDir, 'svg1-wide.svg');
    const svg2Path = path.join(tempDir, 'svg2-wide.svg');
    const diffPath = path.join(tempDir, 'diff-wide.png');

    // Wide SVG: 200x100 viewBox
    const svg1Content = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100">
  <rect x="10" y="10" width="180" height="80" fill="blue"/>
</svg>`;

    const svg2Content = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100">
  <rect x="10" y="10" width="180" height="80" fill="red"/>
</svg>`;

    await fs.writeFile(svg1Path, svg1Content, 'utf8');
    await fs.writeFile(svg2Path, svg2Content, 'utf8');

    // Default 4x scale
    // WHY: Use runCompareCommand because sbb-compare returns exit code 1 for different files
    runCompareCommand(
      ['sbb-compare.cjs', svg1Path, svg2Path, '--json', '--out-diff', diffPath],
      projectRoot,
      CLI_EXEC_TIMEOUT
    );

    const png = await parsePng(diffPath);

    // Diff PNG must be 800x400 (200*4 x 100*4)
    expect(png.width).toBe(800);
    expect(png.height).toBe(400);
  });

  it('should apply scale in viewbox resolution mode', async () => {
    /**
     * Test: Scale is applied even with --resolution viewbox
     * This was one of the broken code paths in the bug.
     */
    const svg1Path = path.join(tempDir, 'svg1-vb.svg');
    const svg2Path = path.join(tempDir, 'svg2-vb.svg');
    const diffPath = path.join(tempDir, 'diff-vb.png');

    const svg1Content = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50" width="50" height="50">
  <circle cx="25" cy="25" r="20" fill="teal"/>
</svg>`;

    const svg2Content = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50" width="50" height="50">
  <circle cx="25" cy="25" r="20" fill="maroon"/>
</svg>`;

    await fs.writeFile(svg1Path, svg1Content, 'utf8');
    await fs.writeFile(svg2Path, svg2Content, 'utf8');

    // Use viewbox resolution mode with default 4x scale
    // WHY: Use runCompareCommand because sbb-compare returns exit code 1 for different files
    runCompareCommand(
      [
        'sbb-compare.cjs',
        svg1Path,
        svg2Path,
        '--json',
        '--resolution',
        'viewbox',
        '--out-diff',
        diffPath
      ],
      projectRoot,
      CLI_EXEC_TIMEOUT
    );

    const png = await parsePng(diffPath);

    // Diff PNG must be 200x200 (50 viewBox * 4x scale)
    expect(png.width).toBe(200);
    expect(png.height).toBe(200);
  });
});
