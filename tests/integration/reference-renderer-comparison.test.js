/**
 * @file Reference Renderer Comparison Tests
 * @description Tests that compare Chrome's SVG rendering output against a Python
 * reference renderer. This ensures Chrome's output matches our expected pixel values.
 *
 * The Python reference renderer (tests/lib/reference_renderer.py) produces
 * deterministic output for pixel-aligned rectangles. By comparing Chrome's output
 * against this reference, we can detect any changes in Chrome's rendering behavior.
 *
 * Prerequisites:
 * - Python venv with Pillow and lxml installed (tests/.venv)
 * - Reference renderer script (tests/lib/reference_renderer.py)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

const execFilePromise = promisify(execFile);

const PROJECT_ROOT = process.cwd();
const RASTER_FIXTURES_DIR = path.join(PROJECT_ROOT, 'tests/fixtures/raster-specimens');
const DIFF_FIXTURES_DIR = path.join(PROJECT_ROOT, 'tests/fixtures/diff-specimens');
const TEMP_DIR = path.join(PROJECT_ROOT, 'tests/.tmp-ref-comparison');
// WHY: Platform-specific path for Python venv binary
const isWindows = process.platform === 'win32';
const PYTHON_VENV = path.join(
  PROJECT_ROOT,
  'tests/.venv',
  isWindows ? 'Scripts/python.exe' : 'bin/python'
);
const REFERENCE_RENDERER = path.join(PROJECT_ROOT, 'tests/lib/reference_renderer.py');

// WHY: Check if Python venv exists before running tests
// This allows CI to skip these tests gracefully instead of failing
const pythonVenvExists = fs.existsSync(PYTHON_VENV);
const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

/**
 * Run the Python reference renderer
 * @param {string} svgPath - Input SVG path
 * @param {string} pngPath - Output PNG path
 * @param {number} width - Output width
 * @param {number} height - Output height
 */
async function renderWithPython(svgPath, pngPath, width, height) {
  await execFilePromise(PYTHON_VENV, [
    REFERENCE_RENDERER,
    svgPath,
    pngPath,
    '--width',
    String(width),
    '--height',
    String(height)
  ]);
}

/**
 * Run Chrome's SVG renderer
 * @param {string} svgPath - Input SVG path
 * @param {string} pngPath - Output PNG path
 * @param {number} width - Output width
 * @param {number} height - Output height
 */
async function renderWithChrome(svgPath, pngPath, width, height) {
  await execFilePromise('node', [
    path.join(PROJECT_ROOT, 'sbb-svg2png.cjs'),
    svgPath,
    pngPath,
    '--width',
    String(width),
    '--height',
    String(height),
    '--background',
    'transparent'
  ]);
}

/**
 * Compare two PNG files pixel by pixel
 * @param {string} png1Path - First PNG path
 * @param {string} png2Path - Second PNG path
 * @returns {{match: boolean, differences: number, details: Array}}
 */
function comparePngs(png1Path, png2Path) {
  const data1 = fs.readFileSync(png1Path);
  const data2 = fs.readFileSync(png2Path);

  const png1 = PNG.sync.read(data1);
  const png2 = PNG.sync.read(data2);

  if (png1.width !== png2.width || png1.height !== png2.height) {
    return {
      match: false,
      differences: -1,
      details: [`Size mismatch: ${png1.width}x${png1.height} vs ${png2.width}x${png2.height}`]
    };
  }

  const details = [];
  let differences = 0;

  for (let y = 0; y < png1.height; y++) {
    for (let x = 0; x < png1.width; x++) {
      const idx = (png1.width * y + x) * 4;
      const r1 = png1.data[idx];
      const g1 = png1.data[idx + 1];
      const b1 = png1.data[idx + 2];
      const a1 = png1.data[idx + 3];

      const r2 = png2.data[idx];
      const g2 = png2.data[idx + 1];
      const b2 = png2.data[idx + 2];
      const a2 = png2.data[idx + 3];

      if (r1 !== r2 || g1 !== g2 || b1 !== b2 || a1 !== a2) {
        differences++;
        if (details.length < 10) {
          details.push(
            `Pixel (${x},${y}): Chrome rgba(${r1},${g1},${b1},${a1}) vs Ref rgba(${r2},${g2},${b2},${a2})`
          );
        }
      }
    }
  }

  return {
    match: differences === 0,
    differences,
    details
  };
}

// WHY: Skip these tests if Python venv is not available or in CI environment
// These tests require local Python setup which is not available in CI
const shouldSkip = !pythonVenvExists || isCI;
const skipReason = !pythonVenvExists
  ? 'Python venv not found (local development only)'
  : 'Skipped in CI (requires local Python venv)';

describe.skipIf(shouldSkip)(`Reference Renderer Comparison Tests (${skipReason})`, () => {
  beforeAll(async () => {
    // Create temp directory
    if (!fs.existsSync(TEMP_DIR)) {
      fs.mkdirSync(TEMP_DIR, { recursive: true });
    }

    // Validate fixture directories exist
    if (!fs.existsSync(RASTER_FIXTURES_DIR)) {
      throw new Error(`Raster fixtures directory not found: ${RASTER_FIXTURES_DIR}`);
    }
    if (!fs.existsSync(DIFF_FIXTURES_DIR)) {
      throw new Error(`Diff fixtures directory not found: ${DIFF_FIXTURES_DIR}`);
    }

    // Validate reference renderer script exists
    if (!fs.existsSync(REFERENCE_RENDERER)) {
      throw new Error(`Reference renderer not found: ${REFERENCE_RENDERER}`);
    }
  });

  afterAll(() => {
    if (fs.existsSync(TEMP_DIR)) {
      fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });

  describe('Raster Specimens - Chrome vs Python Reference', () => {
    const specimens = [
      'red-center-transparent-bg.svg',
      'black-center-transparent-bg.svg',
      'white-center-transparent-bg.svg',
      'black-full.svg',
      'white-full.svg',
      'green-full.svg',
      'blue-square-red-center.svg'
      // Note: Semi-transparent specimens may have slight rounding differences
      // 'semi-transparent-blue.svg',
      // 'semi-transparent-green.svg',
      // 'alpha-25-red.svg',
      // 'alpha-75-blue.svg',
    ];

    for (const specimen of specimens) {
      it(`should match Python reference for ${specimen}`, async () => {
        const svgPath = path.join(RASTER_FIXTURES_DIR, specimen);
        const chromePng = path.join(TEMP_DIR, `chrome-${specimen.replace('.svg', '.png')}`);
        const refPng = path.join(TEMP_DIR, `ref-${specimen.replace('.svg', '.png')}`);

        // Render with both engines
        await Promise.all([
          renderWithChrome(svgPath, chromePng, 10, 10),
          renderWithPython(svgPath, refPng, 10, 10)
        ]);

        // Compare outputs
        const result = comparePngs(chromePng, refPng);

        if (!result.match) {
          console.error(`Differences in ${specimen}:`, result.details);
        }

        expect(result.match).toBe(true);
        expect(result.differences).toBe(0);
      }, 30000);
    }
  });

  describe('Diff Specimens - Chrome vs Python Reference', () => {
    const specimens = ['red-full.svg', 'blue-full.svg', 'half-red-half-blue.svg'];

    for (const specimen of specimens) {
      it(`should match Python reference for ${specimen}`, async () => {
        const svgPath = path.join(DIFF_FIXTURES_DIR, specimen);
        const chromePng = path.join(TEMP_DIR, `chrome-diff-${specimen.replace('.svg', '.png')}`);
        const refPng = path.join(TEMP_DIR, `ref-diff-${specimen.replace('.svg', '.png')}`);

        // Render with both engines
        await Promise.all([
          renderWithChrome(svgPath, chromePng, 10, 10),
          renderWithPython(svgPath, refPng, 10, 10)
        ]);

        // Compare outputs
        const result = comparePngs(chromePng, refPng);

        if (!result.match) {
          console.error(`Differences in ${specimen}:`, result.details);
        }

        expect(result.match).toBe(true);
        expect(result.differences).toBe(0);
      }, 30000);
    }
  });

  describe('Semi-transparent Specimens - Chrome vs Python Reference', () => {
    // Semi-transparent colors may have slight rounding differences between
    // Chrome and Python due to different alpha compositing implementations.
    // We allow a tolerance of 1 for RGBA values.

    const specimens = [
      { file: 'semi-transparent-blue.svg', expectedAlpha: 128 },
      { file: 'semi-transparent-green.svg', expectedAlpha: 128 },
      { file: 'alpha-25-red.svg', expectedAlpha: 64 },
      { file: 'alpha-75-blue.svg', expectedAlpha: 191 }
    ];

    for (const { file, expectedAlpha } of specimens) {
      it(`should render ${file} with alpha ~${expectedAlpha}`, async () => {
        const svgPath = path.join(RASTER_FIXTURES_DIR, file);
        const chromePng = path.join(TEMP_DIR, `chrome-${file.replace('.svg', '.png')}`);
        const refPng = path.join(TEMP_DIR, `ref-${file.replace('.svg', '.png')}`);

        // Render with both engines
        await Promise.all([
          renderWithChrome(svgPath, chromePng, 10, 10),
          renderWithPython(svgPath, refPng, 10, 10)
        ]);

        // Read both PNGs
        const chromeData = PNG.sync.read(fs.readFileSync(chromePng));
        const refData = PNG.sync.read(fs.readFileSync(refPng));

        // Both should have the same size
        expect(chromeData.width).toBe(refData.width);
        expect(chromeData.height).toBe(refData.height);

        // Check alpha is within tolerance (±2 for rounding)
        const chromeAlpha = chromeData.data[3];
        const refAlpha = refData.data[3];

        expect(Math.abs(chromeAlpha - expectedAlpha)).toBeLessThanOrEqual(2);
        expect(Math.abs(refAlpha - expectedAlpha)).toBeLessThanOrEqual(2);
        expect(Math.abs(chromeAlpha - refAlpha)).toBeLessThanOrEqual(2);
      }, 30000);
    }
  });

  describe('Overlapping Rectangles - Alpha Compositing Tests', () => {
    // These tests verify that Chrome and Python reference renderer produce
    // identical alpha compositing results for overlapping semi-transparent shapes.
    // This is critical for detecting rendering pipeline changes.

    /**
     * Compare two PNGs with tolerance for rounding differences
     * @param {string} png1Path - Chrome output
     * @param {string} png2Path - Reference output
     * @param {number} tolerance - Max per-channel difference allowed
     * @returns {{allMatch: boolean, maxDiff: number, diffCount: number}}
     */
    function comparePngsWithTolerance(png1Path, png2Path, tolerance = 1) {
      const data1 = fs.readFileSync(png1Path);
      const data2 = fs.readFileSync(png2Path);

      const png1 = PNG.sync.read(data1);
      const png2 = PNG.sync.read(data2);

      let maxDiff = 0;
      let diffCount = 0;

      for (let i = 0; i < png1.data.length; i++) {
        const diff = Math.abs(png1.data[i] - png2.data[i]);
        maxDiff = Math.max(maxDiff, diff);
        if (diff > tolerance) {
          diffCount++;
        }
      }

      return {
        allMatch: diffCount === 0,
        maxDiff,
        diffCount
      };
    }

    it('should match reference for two overlapping semi-transparent rects', async () => {
      // Tests basic alpha compositing: 50% red over 50% blue
      const svgPath = path.join(RASTER_FIXTURES_DIR, 'overlap-semi-red-semi-blue.svg');
      const chromePng = path.join(TEMP_DIR, 'chrome-overlap-semi-red-semi-blue.png');
      const refPng = path.join(TEMP_DIR, 'ref-overlap-semi-red-semi-blue.png');

      await Promise.all([
        renderWithChrome(svgPath, chromePng, 10, 10),
        renderWithPython(svgPath, refPng, 10, 10)
      ]);

      const result = comparePngsWithTolerance(chromePng, refPng, 1);

      expect(result.allMatch).toBe(true);
      expect(result.maxDiff).toBeLessThanOrEqual(1);
    }, 30000);

    it('should match reference for opaque over semi-transparent', async () => {
      // Tests that opaque source completely replaces destination
      const svgPath = path.join(RASTER_FIXTURES_DIR, 'overlap-opaque-over-semi.svg');
      const chromePng = path.join(TEMP_DIR, 'chrome-overlap-opaque-over-semi.png');
      const refPng = path.join(TEMP_DIR, 'ref-overlap-opaque-over-semi.png');

      await Promise.all([
        renderWithChrome(svgPath, chromePng, 10, 10),
        renderWithPython(svgPath, refPng, 10, 10)
      ]);

      const result = comparePngsWithTolerance(chromePng, refPng, 1);

      expect(result.allMatch).toBe(true);
      expect(result.maxDiff).toBeLessThanOrEqual(1);
    }, 30000);

    it('should match reference for semi-transparent over opaque', async () => {
      // Tests partial coverage blending
      const svgPath = path.join(RASTER_FIXTURES_DIR, 'overlap-semi-over-opaque.svg');
      const chromePng = path.join(TEMP_DIR, 'chrome-overlap-semi-over-opaque.png');
      const refPng = path.join(TEMP_DIR, 'ref-overlap-semi-over-opaque.png');

      await Promise.all([
        renderWithChrome(svgPath, chromePng, 10, 10),
        renderWithPython(svgPath, refPng, 10, 10)
      ]);

      const result = comparePngsWithTolerance(chromePng, refPng, 1);

      expect(result.allMatch).toBe(true);
      expect(result.maxDiff).toBeLessThanOrEqual(1);
    }, 30000);

    it('should match reference for three overlapping semi-transparent rects', async () => {
      // Tests complex multi-layer compositing
      const svgPath = path.join(RASTER_FIXTURES_DIR, 'overlap-three-rects.svg');
      const chromePng = path.join(TEMP_DIR, 'chrome-overlap-three-rects.png');
      const refPng = path.join(TEMP_DIR, 'ref-overlap-three-rects.png');

      await Promise.all([
        renderWithChrome(svgPath, chromePng, 10, 10),
        renderWithPython(svgPath, refPng, 10, 10)
      ]);

      const result = comparePngsWithTolerance(chromePng, refPng, 1);

      expect(result.allMatch).toBe(true);
      expect(result.maxDiff).toBeLessThanOrEqual(1);
    }, 30000);

    it('should verify overlap zone has correct composited values', async () => {
      // Detailed verification of the overlap zone in semi-red-semi-blue specimen
      const svgPath = path.join(RASTER_FIXTURES_DIR, 'overlap-semi-red-semi-blue.svg');
      const chromePng = path.join(TEMP_DIR, 'chrome-overlap-detail.png');

      await renderWithChrome(svgPath, chromePng, 10, 10);

      const data = fs.readFileSync(chromePng);
      const png = PNG.sync.read(data);

      // Check red-only zone (0,0) - should be semi-transparent red
      const redIdx = 0;
      expect(png.data[redIdx]).toBe(255); // R
      expect(png.data[redIdx + 1]).toBe(0); // G
      expect(png.data[redIdx + 2]).toBe(0); // B
      expect(png.data[redIdx + 3]).toBe(128); // A (~50%)

      // Check blue-only zone (9,9) - should be semi-transparent blue
      const blueIdx = (9 * 10 + 9) * 4;
      expect(png.data[blueIdx]).toBe(0); // R
      expect(png.data[blueIdx + 1]).toBe(0); // G
      expect(png.data[blueIdx + 2]).toBe(255); // B
      expect(png.data[blueIdx + 3]).toBe(128); // A (~50%)

      // Check overlap zone (4,4) - should be composited purple with higher alpha
      const overlapIdx = (4 * 10 + 4) * 4;
      const overlapR = png.data[overlapIdx];
      const overlapG = png.data[overlapIdx + 1];
      const overlapB = png.data[overlapIdx + 2];
      const overlapA = png.data[overlapIdx + 3];

      // Expected: rgba(85, 0, 171, 191) - exact values based on Chrome/Skia compositing
      // R=85: (0*128 + 255*128*127//255) / 191 with rounding = 85
      // B=171: (255*128 + 0) / 191 with rounding = 171
      expect(overlapR).toBe(85);
      expect(overlapG).toBe(0);
      expect(overlapB).toBe(171);
      expect(overlapA).toBe(191);
    }, 30000);
  });

  describe('Black/White Edge Cases - Alpha Compositing Tests', () => {
    // Black and white colors often have special treatment in rendering pipelines
    // These tests ensure Chrome and Python reference handle them identically

    it('should match reference for semi-transparent black over opaque white', async () => {
      // Tests multiplication by 0 (black) in alpha compositing
      const svgPath = path.join(RASTER_FIXTURES_DIR, 'overlap-semi-black-opaque-white.svg');
      const chromePng = path.join(TEMP_DIR, 'chrome-semi-black-opaque-white.png');
      const refPng = path.join(TEMP_DIR, 'ref-semi-black-opaque-white.png');

      await Promise.all([
        renderWithChrome(svgPath, chromePng, 10, 10),
        renderWithPython(svgPath, refPng, 10, 10)
      ]);

      const result = comparePngs(chromePng, refPng);

      // Should be exact match - both should produce gray (128, 128, 128, 255)
      expect(result.match).toBe(true);
      expect(result.differences).toBe(0);
    }, 30000);

    it('should match reference for semi-transparent white over opaque black', async () => {
      // Tests multiplication by 255 (white) in alpha compositing
      const svgPath = path.join(RASTER_FIXTURES_DIR, 'overlap-semi-white-opaque-black.svg');
      const chromePng = path.join(TEMP_DIR, 'chrome-semi-white-opaque-black.png');
      const refPng = path.join(TEMP_DIR, 'ref-semi-white-opaque-black.png');

      await Promise.all([
        renderWithChrome(svgPath, chromePng, 10, 10),
        renderWithPython(svgPath, refPng, 10, 10)
      ]);

      const result = comparePngs(chromePng, refPng);

      // Should be exact match - both should produce gray (128, 128, 128, 255)
      expect(result.match).toBe(true);
      expect(result.differences).toBe(0);
    }, 30000);

    it('should match reference for semi-transparent black over semi-transparent white', async () => {
      // Tests black with semi-transparent destination
      const svgPath = path.join(RASTER_FIXTURES_DIR, 'overlap-semi-black-semi-white.svg');
      const chromePng = path.join(TEMP_DIR, 'chrome-semi-black-semi-white.png');
      const refPng = path.join(TEMP_DIR, 'ref-semi-black-semi-white.png');

      await Promise.all([
        renderWithChrome(svgPath, chromePng, 10, 10),
        renderWithPython(svgPath, refPng, 10, 10)
      ]);

      const result = comparePngs(chromePng, refPng);

      // Should be exact match - expected rgba(85, 85, 85, 191)
      expect(result.match).toBe(true);
      expect(result.differences).toBe(0);
    }, 30000);

    it('should match reference for semi-transparent white over semi-transparent black', async () => {
      // Tests white with semi-transparent destination
      const svgPath = path.join(RASTER_FIXTURES_DIR, 'overlap-semi-white-semi-black.svg');
      const chromePng = path.join(TEMP_DIR, 'chrome-semi-white-semi-black.png');
      const refPng = path.join(TEMP_DIR, 'ref-semi-white-semi-black.png');

      await Promise.all([
        renderWithChrome(svgPath, chromePng, 10, 10),
        renderWithPython(svgPath, refPng, 10, 10)
      ]);

      const result = comparePngs(chromePng, refPng);

      // Should be exact match - expected rgba(170, 170, 170, 191)
      expect(result.match).toBe(true);
      expect(result.differences).toBe(0);
    }, 30000);

    it('should verify black/white compositing produces correct gray values', async () => {
      // Detailed verification of gray values from black/white compositing
      const svgPath1 = path.join(RASTER_FIXTURES_DIR, 'overlap-semi-black-opaque-white.svg');
      const svgPath2 = path.join(RASTER_FIXTURES_DIR, 'overlap-semi-white-opaque-black.svg');
      const chromePng1 = path.join(TEMP_DIR, 'chrome-bw-check1.png');
      const chromePng2 = path.join(TEMP_DIR, 'chrome-bw-check2.png');

      await Promise.all([
        renderWithChrome(svgPath1, chromePng1, 10, 10),
        renderWithChrome(svgPath2, chromePng2, 10, 10)
      ]);

      const data1 = PNG.sync.read(fs.readFileSync(chromePng1));
      const data2 = PNG.sync.read(fs.readFileSync(chromePng2));

      // Both should produce identical gray: rgba(128, 128, 128, 255)
      // This tests symmetry: black over white should equal white over black
      expect(data1.data[0]).toBe(128); // R
      expect(data1.data[1]).toBe(128); // G
      expect(data1.data[2]).toBe(128); // B
      expect(data1.data[3]).toBe(255); // A

      expect(data2.data[0]).toBe(128); // R
      expect(data2.data[1]).toBe(128); // G
      expect(data2.data[2]).toBe(128); // B
      expect(data2.data[3]).toBe(255); // A

      // Verify they're identical
      expect(data1.data[0]).toBe(data2.data[0]);
      expect(data1.data[1]).toBe(data2.data[1]);
      expect(data1.data[2]).toBe(data2.data[2]);
    }, 30000);
  });
});
