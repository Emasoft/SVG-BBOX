/**
 * @file Rasterization Pipeline Tests
 * @description Tests to verify that Chrome's SVG rendering pipeline produces
 * correct RGBA values, including proper alpha channel handling.
 *
 * These tests use controlled SVG specimens with known pixel values to detect
 * any changes in the rendering pipeline that could affect:
 * - Transparent backgrounds (alpha=0)
 * - Opaque content (alpha=255)
 * - Semi-transparent content (alpha between 0 and 255)
 * - Color accuracy (RGB values)
 *
 * IMPORTANT: If these tests fail, it indicates a change in Chrome's rendering
 * or our PNG conversion that affects pixel accuracy. This could break diff
 * score calculations and visual comparisons.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, spawnSync } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

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

const PROJECT_ROOT = process.cwd();
const FIXTURES_DIR = path.join(PROJECT_ROOT, 'tests/fixtures/raster-specimens');
const DIFF_FIXTURES_DIR = path.join(PROJECT_ROOT, 'tests/fixtures/diff-specimens');
const TEMP_DIR = path.join(PROJECT_ROOT, 'tests/.tmp-raster-pipeline');
const SBB_SVG2PNG = path.join(PROJECT_ROOT, 'sbb-svg2png.cjs');
const SBB_COMPARE = path.join(PROJECT_ROOT, 'sbb-compare.cjs');

/**
 * Analyze PNG pixel data and return counts by type
 * @param {string} pngPath - Path to PNG file
 * @returns {{transparent: number, red: number, blue: number, green: number, black: number, white: number, semiTransparent: number, other: number, pixels: Array}}
 */
function analyzePixels(pngPath) {
  const data = fs.readFileSync(pngPath);
  const png = PNG.sync.read(data);

  const result = {
    width: png.width,
    height: png.height,
    totalPixels: png.width * png.height,
    transparent: 0, // alpha = 0
    opaque: 0, // alpha = 255
    semiTransparent: 0, // 0 < alpha < 255
    red: 0, // rgba(255,0,0,255)
    blue: 0, // rgba(0,0,255,255)
    green: 0, // rgba(0,255,0,255)
    black: 0, // rgba(0,0,0,255)
    white: 0, // rgba(255,255,255,255)
    other: 0,
    pixels: [], // Store first few pixels for debugging
    rawPng: png // Store png object for direct pixel inspection
  };

  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const idx = (png.width * y + x) * 4;
      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      const a = png.data[idx + 3];

      // Track alpha categories
      if (a === 0) {
        result.transparent++;
      } else if (a === 255) {
        result.opaque++;
      } else {
        result.semiTransparent++;
      }

      // Track color categories (only for opaque pixels)
      if (r === 255 && g === 0 && b === 0 && a === 255) {
        result.red++;
      } else if (r === 0 && g === 0 && b === 255 && a === 255) {
        result.blue++;
      } else if (r === 0 && g === 255 && b === 0 && a === 255) {
        result.green++;
      } else if (r === 0 && g === 0 && b === 0 && a === 255) {
        result.black++;
      } else if (r === 255 && g === 255 && b === 255 && a === 255) {
        result.white++;
      } else if (a !== 0) {
        // Not transparent and not a primary color
        result.other++;
        // Store first few non-standard pixels for debugging
        if (result.pixels.length < 10) {
          result.pixels.push({ x, y, r, g, b, a });
        }
      }
    }
  }

  return result;
}

describe('Rasterization Pipeline Tests', () => {
  beforeAll(() => {
    // Create temp directory
    if (!fs.existsSync(TEMP_DIR)) {
      fs.mkdirSync(TEMP_DIR, { recursive: true });
    }

    // Validate fixture directories exist
    if (!fs.existsSync(FIXTURES_DIR)) {
      throw new Error(`Raster fixtures directory not found: ${FIXTURES_DIR}`);
    }
    if (!fs.existsSync(DIFF_FIXTURES_DIR)) {
      throw new Error(`Diff fixtures directory not found: ${DIFF_FIXTURES_DIR}`);
    }

    // Validate CLI tools exist
    if (!fs.existsSync(SBB_SVG2PNG)) {
      throw new Error(`sbb-svg2png.cjs not found: ${SBB_SVG2PNG}`);
    }
    if (!fs.existsSync(SBB_COMPARE)) {
      throw new Error(`sbb-compare.cjs not found: ${SBB_COMPARE}`);
    }
  });

  afterAll(() => {
    if (fs.existsSync(TEMP_DIR)) {
      fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });

  describe('Transparent Background Rendering', () => {
    it('should render SVG with transparent background (no opaque background injected)', async () => {
      // This test catches if Chrome starts adding opaque backgrounds
      const svgPath = path.join(FIXTURES_DIR, 'red-center-transparent-bg.svg');
      const pngPath = path.join(TEMP_DIR, 'transparent-bg-test.png');

      await execFilePromise('node', [
        SBB_SVG2PNG,
        svgPath,
        pngPath,
        '--width',
        '10',
        '--height',
        '10',
        '--background',
        'transparent'
      ]);

      const analysis = analyzePixels(pngPath);

      // Expected: 84 transparent pixels, 16 red pixels
      expect(analysis.totalPixels).toBe(100);
      expect(analysis.transparent).toBe(84);
      expect(analysis.red).toBe(16);
      expect(analysis.other).toBe(0);

      // Critical: No opaque white background should be added
      // If this fails, Chrome is injecting an opaque background
      expect(analysis.opaque).toBe(16); // Only the red square should be opaque
    }, 30000);

    it('should reject fully transparent SVG (no visible content to render)', async () => {
      // Edge case: SVG with only transparent content has no visible bbox
      // The tool correctly rejects this as there's nothing to render
      const svgPath = path.join(FIXTURES_DIR, 'fully-transparent.svg');
      const pngPath = path.join(TEMP_DIR, 'fully-transparent-test.png');

      // This should fail with "Visible bbox is empty" error
      await expect(
        execFilePromise('node', [
          SBB_SVG2PNG,
          svgPath,
          pngPath,
          '--width',
          '10',
          '--height',
          '10',
          '--background',
          'transparent'
        ])
      ).rejects.toThrow(/Visible bbox is empty/);
    }, 30000);
  });

  describe('Alpha Channel Accuracy', () => {
    it('should render opaque colors with alpha=255 exactly', async () => {
      // Solid red should have alpha=255 for all pixels
      const svgPath = path.join(DIFF_FIXTURES_DIR, 'red-full.svg');
      const pngPath = path.join(TEMP_DIR, 'opaque-alpha-test.png');

      await execFilePromise('node', [
        SBB_SVG2PNG,
        svgPath,
        pngPath,
        '--width',
        '10',
        '--height',
        '10',
        '--background',
        'transparent'
      ]);

      const analysis = analyzePixels(pngPath);

      // All 100 pixels should be opaque (alpha=255)
      expect(analysis.opaque).toBe(100);
      expect(analysis.transparent).toBe(0);
      expect(analysis.semiTransparent).toBe(0);

      // All should be pure red
      expect(analysis.red).toBe(100);
    }, 30000);

    it('should render semi-transparent colors with correct alpha', async () => {
      // 50% opacity blue should have alpha around 128
      const svgPath = path.join(FIXTURES_DIR, 'semi-transparent-blue.svg');
      const pngPath = path.join(TEMP_DIR, 'semi-transparent-test.png');

      await execFilePromise('node', [
        SBB_SVG2PNG,
        svgPath,
        pngPath,
        '--width',
        '10',
        '--height',
        '10',
        '--background',
        'transparent'
      ]);

      const analysis = analyzePixels(pngPath);

      // All pixels should be semi-transparent (not fully opaque or transparent)
      expect(analysis.semiTransparent).toBe(100);
      expect(analysis.transparent).toBe(0);
      expect(analysis.opaque).toBe(0);

      // Verify the alpha value is approximately 128 (50% of 255)
      // Read actual pixel values
      const data = fs.readFileSync(pngPath);
      const png = PNG.sync.read(data);
      const alpha = png.data[3]; // First pixel's alpha

      // Allow small tolerance for rounding differences
      expect(alpha).toBeGreaterThanOrEqual(126);
      expect(alpha).toBeLessThanOrEqual(129);
    }, 30000);

    it('should handle alpha=0 edge case (transparent background pixels)', async () => {
      // Test alpha=0 using a specimen that HAS visible content but ALSO has
      // transparent background pixels. The red-center-transparent-bg specimen
      // has 84 transparent pixels (alpha=0) around the red center.
      const svgPath = path.join(FIXTURES_DIR, 'red-center-transparent-bg.svg');
      const pngPath = path.join(TEMP_DIR, 'alpha-zero-test.png');

      await execFilePromise('node', [
        SBB_SVG2PNG,
        svgPath,
        pngPath,
        '--width',
        '10',
        '--height',
        '10',
        '--background',
        'transparent'
      ]);

      const data = fs.readFileSync(pngPath);
      const png = PNG.sync.read(data);

      // Count pixels with alpha=0 (should be 84 - the transparent background)
      let transparentCount = 0;
      for (let i = 3; i < png.data.length; i += 4) {
        if (png.data[i] === 0) {
          transparentCount++;
        }
      }
      expect(transparentCount).toBe(84);
    }, 30000);

    it('should handle alpha=255 edge case (fully opaque)', async () => {
      const svgPath = path.join(DIFF_FIXTURES_DIR, 'blue-full.svg');
      const pngPath = path.join(TEMP_DIR, 'alpha-255-test.png');

      await execFilePromise('node', [
        SBB_SVG2PNG,
        svgPath,
        pngPath,
        '--width',
        '10',
        '--height',
        '10',
        '--background',
        'transparent'
      ]);

      const data = fs.readFileSync(pngPath);
      const png = PNG.sync.read(data);

      // Check all pixels have alpha=255
      for (let i = 3; i < png.data.length; i += 4) {
        expect(png.data[i]).toBe(255);
      }
    }, 30000);
  });

  describe('Color Accuracy', () => {
    it('should render pure red as rgba(255,0,0,255)', async () => {
      const svgPath = path.join(DIFF_FIXTURES_DIR, 'red-full.svg');
      const pngPath = path.join(TEMP_DIR, 'pure-red-test.png');

      await execFilePromise('node', [
        SBB_SVG2PNG,
        svgPath,
        pngPath,
        '--width',
        '10',
        '--height',
        '10',
        '--background',
        'transparent'
      ]);

      const data = fs.readFileSync(pngPath);
      const png = PNG.sync.read(data);

      // Check first pixel (all should be identical)
      expect(png.data[0]).toBe(255); // R
      expect(png.data[1]).toBe(0); // G
      expect(png.data[2]).toBe(0); // B
      expect(png.data[3]).toBe(255); // A
    }, 30000);

    it('should render pure blue as rgba(0,0,255,255)', async () => {
      const svgPath = path.join(DIFF_FIXTURES_DIR, 'blue-full.svg');
      const pngPath = path.join(TEMP_DIR, 'pure-blue-test.png');

      await execFilePromise('node', [
        SBB_SVG2PNG,
        svgPath,
        pngPath,
        '--width',
        '10',
        '--height',
        '10',
        '--background',
        'transparent'
      ]);

      const data = fs.readFileSync(pngPath);
      const png = PNG.sync.read(data);

      // Check first pixel
      expect(png.data[0]).toBe(0); // R
      expect(png.data[1]).toBe(0); // G
      expect(png.data[2]).toBe(255); // B
      expect(png.data[3]).toBe(255); // A
    }, 30000);

    it('should maintain pixel alignment without antialiasing artifacts', async () => {
      // Half-and-half should have clean edges (no antialiasing at boundary)
      const svgPath = path.join(DIFF_FIXTURES_DIR, 'half-red-half-blue.svg');
      const pngPath = path.join(TEMP_DIR, 'pixel-alignment-test.png');

      await execFilePromise('node', [
        SBB_SVG2PNG,
        svgPath,
        pngPath,
        '--width',
        '10',
        '--height',
        '10',
        '--background',
        'transparent'
      ]);

      const analysis = analyzePixels(pngPath);

      // Should have exactly 50 red + 50 blue with NO other pixels
      // If there are "other" pixels, antialiasing is happening at the boundary
      expect(analysis.red).toBe(50);
      expect(analysis.blue).toBe(50);
      expect(analysis.other).toBe(0);
      expect(analysis.semiTransparent).toBe(0);
    }, 30000);
  });

  describe('Diff Calculation with Alpha', () => {
    it('should detect difference when one image has transparent pixels and other has opaque', async () => {
      // Compare red-center (has transparent pixels) vs red-full (all opaque)
      // The transparent areas should count as different
      const svg1 = path.join(FIXTURES_DIR, 'red-center-transparent-bg.svg');
      const svg2 = path.join(DIFF_FIXTURES_DIR, 'red-full.svg');
      const diffOutput = path.join(TEMP_DIR, 'alpha-diff.png');

      const { stdout } = runCommandWithExitCode('node', [
        SBB_COMPARE,
        svg1,
        svg2,
        '--out-diff',
        diffOutput,
        '--json',
        '--no-html',
        '--scale',
        '1'
      ]);

      const result = JSON.parse(stdout);

      // 84 pixels differ (transparent vs red)
      // 16 pixels are same (red vs red)
      // Diff = 84/100 = 84%
      expect(result.totalPixels).toBe(100);
      expect(result.differentPixels).toBe(84);
      expect(result.diffPercentage).toBe(84);
    }, 60000);

    it('should correctly compare images with transparent regions', async () => {
      // Compare red-center-transparent-bg with itself
      // Tests that transparent pixels (alpha=0) are compared correctly
      const svg = path.join(FIXTURES_DIR, 'red-center-transparent-bg.svg');
      const diffOutput = path.join(TEMP_DIR, 'transparent-region-self-diff.png');

      const { stdout } = runCommandWithExitCode('node', [
        SBB_COMPARE,
        svg,
        svg,
        '--out-diff',
        diffOutput,
        '--json',
        '--no-html',
        '--scale',
        '1'
      ]);

      const result = JSON.parse(stdout);

      // Self-comparison should be 0% different
      // This verifies transparent pixels (alpha=0) are compared correctly
      expect(result.diffPercentage).toBe(0);
      expect(result.differentPixels).toBe(0);
    }, 60000);
  });

  describe('Extended Color Accuracy Tests', () => {
    it('should render pure black as rgba(0,0,0,255)', async () => {
      const svgPath = path.join(FIXTURES_DIR, 'black-full.svg');
      const pngPath = path.join(TEMP_DIR, 'pure-black-test.png');

      await execFilePromise('node', [
        SBB_SVG2PNG,
        svgPath,
        pngPath,
        '--width',
        '10',
        '--height',
        '10',
        '--background',
        'transparent'
      ]);

      const analysis = analyzePixels(pngPath);

      // All 100 pixels should be opaque black
      expect(analysis.black).toBe(100);
      expect(analysis.opaque).toBe(100);
      expect(analysis.transparent).toBe(0);
      expect(analysis.other).toBe(0);

      // Verify exact RGBA values
      const png = analysis.rawPng;
      expect(png.data[0]).toBe(0); // R
      expect(png.data[1]).toBe(0); // G
      expect(png.data[2]).toBe(0); // B
      expect(png.data[3]).toBe(255); // A
    }, 30000);

    it('should render pure white as rgba(255,255,255,255)', async () => {
      const svgPath = path.join(FIXTURES_DIR, 'white-full.svg');
      const pngPath = path.join(TEMP_DIR, 'pure-white-test.png');

      await execFilePromise('node', [
        SBB_SVG2PNG,
        svgPath,
        pngPath,
        '--width',
        '10',
        '--height',
        '10',
        '--background',
        'transparent'
      ]);

      const analysis = analyzePixels(pngPath);

      // All 100 pixels should be opaque white
      expect(analysis.white).toBe(100);
      expect(analysis.opaque).toBe(100);
      expect(analysis.transparent).toBe(0);
      expect(analysis.other).toBe(0);

      // Verify exact RGBA values
      const png = analysis.rawPng;
      expect(png.data[0]).toBe(255); // R
      expect(png.data[1]).toBe(255); // G
      expect(png.data[2]).toBe(255); // B
      expect(png.data[3]).toBe(255); // A
    }, 30000);

    it('should render pure green as rgba(0,255,0,255)', async () => {
      const svgPath = path.join(FIXTURES_DIR, 'green-full.svg');
      const pngPath = path.join(TEMP_DIR, 'pure-green-test.png');

      await execFilePromise('node', [
        SBB_SVG2PNG,
        svgPath,
        pngPath,
        '--width',
        '10',
        '--height',
        '10',
        '--background',
        'transparent'
      ]);

      const analysis = analyzePixels(pngPath);

      // All 100 pixels should be opaque green
      expect(analysis.green).toBe(100);
      expect(analysis.opaque).toBe(100);
      expect(analysis.transparent).toBe(0);
      expect(analysis.other).toBe(0);

      // Verify exact RGBA values
      const png = analysis.rawPng;
      expect(png.data[0]).toBe(0); // R
      expect(png.data[1]).toBe(255); // G
      expect(png.data[2]).toBe(0); // B
      expect(png.data[3]).toBe(255); // A
    }, 30000);

    it('should render blue background with red center correctly', async () => {
      // Tests layered rectangles: 84 blue pixels, 16 red center
      const svgPath = path.join(FIXTURES_DIR, 'blue-square-red-center.svg');
      const pngPath = path.join(TEMP_DIR, 'blue-red-layered-test.png');

      await execFilePromise('node', [
        SBB_SVG2PNG,
        svgPath,
        pngPath,
        '--width',
        '10',
        '--height',
        '10',
        '--background',
        'transparent'
      ]);

      const analysis = analyzePixels(pngPath);

      // 84 blue + 16 red = 100 opaque
      expect(analysis.blue).toBe(84);
      expect(analysis.red).toBe(16);
      expect(analysis.opaque).toBe(100);
      expect(analysis.transparent).toBe(0);
      expect(analysis.other).toBe(0);
    }, 30000);

    it('should render black center on transparent background correctly', async () => {
      // Edge case: black pixels (R=0, G=0, B=0) with alpha=255
      const svgPath = path.join(FIXTURES_DIR, 'black-center-transparent-bg.svg');
      const pngPath = path.join(TEMP_DIR, 'black-center-test.png');

      await execFilePromise('node', [
        SBB_SVG2PNG,
        svgPath,
        pngPath,
        '--width',
        '10',
        '--height',
        '10',
        '--background',
        'transparent'
      ]);

      const analysis = analyzePixels(pngPath);

      // 84 transparent, 16 black
      expect(analysis.transparent).toBe(84);
      expect(analysis.black).toBe(16);
      expect(analysis.opaque).toBe(16);
      expect(analysis.other).toBe(0);
    }, 30000);

    it('should render white center on transparent background correctly', async () => {
      // Edge case: white pixels (R=255, G=255, B=255) with alpha=255
      const svgPath = path.join(FIXTURES_DIR, 'white-center-transparent-bg.svg');
      const pngPath = path.join(TEMP_DIR, 'white-center-test.png');

      await execFilePromise('node', [
        SBB_SVG2PNG,
        svgPath,
        pngPath,
        '--width',
        '10',
        '--height',
        '10',
        '--background',
        'transparent'
      ]);

      const analysis = analyzePixels(pngPath);

      // 84 transparent, 16 white
      expect(analysis.transparent).toBe(84);
      expect(analysis.white).toBe(16);
      expect(analysis.opaque).toBe(16);
      expect(analysis.other).toBe(0);
    }, 30000);
  });

  describe('Extended Alpha Channel Tests', () => {
    it('should render 25% alpha red correctly (~64 alpha)', async () => {
      const svgPath = path.join(FIXTURES_DIR, 'alpha-25-red.svg');
      const pngPath = path.join(TEMP_DIR, 'alpha-25-red-test.png');

      await execFilePromise('node', [
        SBB_SVG2PNG,
        svgPath,
        pngPath,
        '--width',
        '10',
        '--height',
        '10',
        '--background',
        'transparent'
      ]);

      const analysis = analyzePixels(pngPath);

      // All 100 pixels should be semi-transparent
      expect(analysis.semiTransparent).toBe(100);
      expect(analysis.transparent).toBe(0);
      expect(analysis.opaque).toBe(0);

      // Verify alpha is approximately 64 (25% of 255)
      const png = analysis.rawPng;
      const alpha = png.data[3];
      expect(alpha).toBeGreaterThanOrEqual(62);
      expect(alpha).toBeLessThanOrEqual(66);

      // Verify red color channel
      expect(png.data[0]).toBe(255); // R
      expect(png.data[1]).toBe(0); // G
      expect(png.data[2]).toBe(0); // B
    }, 30000);

    it('should render 50% alpha green correctly (~128 alpha)', async () => {
      const svgPath = path.join(FIXTURES_DIR, 'semi-transparent-green.svg');
      const pngPath = path.join(TEMP_DIR, 'alpha-50-green-test.png');

      await execFilePromise('node', [
        SBB_SVG2PNG,
        svgPath,
        pngPath,
        '--width',
        '10',
        '--height',
        '10',
        '--background',
        'transparent'
      ]);

      const analysis = analyzePixels(pngPath);

      // All 100 pixels should be semi-transparent
      expect(analysis.semiTransparent).toBe(100);
      expect(analysis.transparent).toBe(0);
      expect(analysis.opaque).toBe(0);

      // Verify alpha is approximately 128 (50% of 255)
      const png = analysis.rawPng;
      const alpha = png.data[3];
      expect(alpha).toBeGreaterThanOrEqual(126);
      expect(alpha).toBeLessThanOrEqual(129);

      // Verify green color channel
      expect(png.data[0]).toBe(0); // R
      expect(png.data[1]).toBe(255); // G (premultiplied, stays 255)
      expect(png.data[2]).toBe(0); // B
    }, 30000);

    it('should render 75% alpha blue correctly (~191 alpha)', async () => {
      const svgPath = path.join(FIXTURES_DIR, 'alpha-75-blue.svg');
      const pngPath = path.join(TEMP_DIR, 'alpha-75-blue-test.png');

      await execFilePromise('node', [
        SBB_SVG2PNG,
        svgPath,
        pngPath,
        '--width',
        '10',
        '--height',
        '10',
        '--background',
        'transparent'
      ]);

      const analysis = analyzePixels(pngPath);

      // All 100 pixels should be semi-transparent
      expect(analysis.semiTransparent).toBe(100);
      expect(analysis.transparent).toBe(0);
      expect(analysis.opaque).toBe(0);

      // Verify alpha is approximately 191 (75% of 255 = 191.25)
      const png = analysis.rawPng;
      const alpha = png.data[3];
      expect(alpha).toBeGreaterThanOrEqual(189);
      expect(alpha).toBeLessThanOrEqual(193);

      // Verify blue color channel
      expect(png.data[0]).toBe(0); // R
      expect(png.data[1]).toBe(0); // G
      expect(png.data[2]).toBe(255); // B
    }, 30000);
  });

  describe('Color Difference Edge Cases', () => {
    it('should detect black vs white as 100% different', async () => {
      // Maximum RGB difference (0,0,0 vs 255,255,255)
      const svg1 = path.join(FIXTURES_DIR, 'black-full.svg');
      const svg2 = path.join(FIXTURES_DIR, 'white-full.svg');
      const diffOutput = path.join(TEMP_DIR, 'black-vs-white-diff.png');

      const { stdout } = runCommandWithExitCode('node', [
        SBB_COMPARE,
        svg1,
        svg2,
        '--out-diff',
        diffOutput,
        '--json',
        '--no-html',
        '--scale',
        '1'
      ]);

      const result = JSON.parse(stdout);

      // All 100 pixels should be different (black vs white)
      expect(result.totalPixels).toBe(100);
      expect(result.differentPixels).toBe(100);
      expect(result.diffPercentage).toBe(100);
    }, 60000);

    it('should detect red vs green as 100% different', async () => {
      // Red (255,0,0) vs Green (0,255,0)
      const svg1 = path.join(DIFF_FIXTURES_DIR, 'red-full.svg');
      const svg2 = path.join(FIXTURES_DIR, 'green-full.svg');
      const diffOutput = path.join(TEMP_DIR, 'red-vs-green-diff.png');

      const { stdout } = runCommandWithExitCode('node', [
        SBB_COMPARE,
        svg1,
        svg2,
        '--out-diff',
        diffOutput,
        '--json',
        '--no-html',
        '--scale',
        '1'
      ]);

      const result = JSON.parse(stdout);

      // All 100 pixels should be different
      expect(result.totalPixels).toBe(100);
      expect(result.differentPixels).toBe(100);
      expect(result.diffPercentage).toBe(100);
    }, 60000);

    it('should detect difference only in alpha channel', async () => {
      // Semi-transparent blue (alpha ~128) vs opaque blue (alpha 255)
      const svg1 = path.join(FIXTURES_DIR, 'semi-transparent-blue.svg');
      const svg2 = path.join(DIFF_FIXTURES_DIR, 'blue-full.svg');
      const diffOutput = path.join(TEMP_DIR, 'alpha-only-diff.png');

      const { stdout } = runCommandWithExitCode('node', [
        SBB_COMPARE,
        svg1,
        svg2,
        '--out-diff',
        diffOutput,
        '--json',
        '--no-html',
        '--scale',
        '1'
      ]);

      const result = JSON.parse(stdout);

      // All 100 pixels should be different (alpha differs by ~127)
      expect(result.totalPixels).toBe(100);
      expect(result.differentPixels).toBe(100);
      expect(result.diffPercentage).toBe(100);
    }, 60000);

    it('should correctly compare layered images (blue+red vs red-only)', async () => {
      // Blue background + red center vs solid red
      const svg1 = path.join(FIXTURES_DIR, 'blue-square-red-center.svg');
      const svg2 = path.join(DIFF_FIXTURES_DIR, 'red-full.svg');
      const diffOutput = path.join(TEMP_DIR, 'layered-vs-solid-diff.png');

      const { stdout } = runCommandWithExitCode('node', [
        SBB_COMPARE,
        svg1,
        svg2,
        '--out-diff',
        diffOutput,
        '--json',
        '--no-html',
        '--scale',
        '1'
      ]);

      const result = JSON.parse(stdout);

      // 84 blue pixels differ from red, 16 red pixels match
      expect(result.totalPixels).toBe(100);
      expect(result.differentPixels).toBe(84);
      expect(result.diffPercentage).toBe(84);
    }, 60000);
  });
});
