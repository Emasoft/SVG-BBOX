/**
 * Integration Tests for sbb-inkscape-svg2png.cjs
 *
 * Tests the Inkscape-based SVG to PNG conversion tool.
 * These tests require Inkscape to be installed on the system.
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

const SVG2PNG_PATH = path.join(__dirname, '../../sbb-inkscape-svg2png.cjs');
const FIXTURES_DIR = path.join(__dirname, '../fixtures');
const TEMP_DIR = path.join(__dirname, '../.tmp-inkscape-svg2png-tests');

// Check if Inkscape is available
async function checkInkscapeAvailable() {
  try {
    await execFilePromise('inkscape', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// Helper to run sbb-inkscape-svg2png
async function runSvg2Png(inputSvg, args = []) {
  const inputPath = path.join(FIXTURES_DIR, inputSvg);
  const outputPath = path.join(TEMP_DIR, inputSvg.replace('.svg', '.png'));

  const { stdout, stderr } = await execFilePromise(
    'node',
    [SVG2PNG_PATH, inputPath, '--output', outputPath, ...args],
    {
      timeout: 30000 // 30 seconds timeout
    }
  );

  return { stdout, stderr, outputPath };
}

describe('sbb-inkscape-svg2png Integration Tests', () => {
  let inkscapeAvailable = false;

  beforeAll(async () => {
    inkscapeAvailable = await checkInkscapeAvailable();

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

  describe('Basic PNG Export', () => {
    it('should convert SVG to PNG', async () => {
      if (!inkscapeAvailable) {
        console.warn('⚠️  Skipping test: Inkscape not installed');
        return;
      }

      const { outputPath } = await runSvg2Png('simple-rect.svg');

      // Check output file exists
      expect(fs.existsSync(outputPath)).toBe(true);

      // Check it's a PNG file (PNG signature: 89 50 4E 47)
      const fileBuffer = fs.readFileSync(outputPath);
      expect(fileBuffer[0]).toBe(0x89);
      expect(fileBuffer[1]).toBe(0x50);
      expect(fileBuffer[2]).toBe(0x4e);
      expect(fileBuffer[3]).toBe(0x47);

      // Check file size is reasonable (not empty)
      const stats = fs.statSync(outputPath);
      expect(stats.size).toBeGreaterThan(100); // At least 100 bytes
    });

    it('should export circle SVG to PNG', async () => {
      if (!inkscapeAvailable) {
        console.warn('⚠️  Skipping test: Inkscape not installed');
        return;
      }

      const { outputPath } = await runSvg2Png('simple-circle.svg');

      expect(fs.existsSync(outputPath)).toBe(true);

      const fileBuffer = fs.readFileSync(outputPath);
      expect(fileBuffer[0]).toBe(0x89); // PNG signature
      expect(fileBuffer[1]).toBe(0x50);
    });
  });

  describe('With Dimensions', () => {
    it('should export with specific width and height', async () => {
      if (!inkscapeAvailable) {
        console.warn('⚠️  Skipping test: Inkscape not installed');
        return;
      }

      const { outputPath } = await runSvg2Png('simple-rect.svg', [
        '--width',
        '256',
        '--height',
        '256'
      ]);

      expect(fs.existsSync(outputPath)).toBe(true);

      // Verify it's a valid PNG
      const fileBuffer = fs.readFileSync(outputPath);
      expect(fileBuffer[0]).toBe(0x89);
    });
  });

  describe('With DPI', () => {
    it('should export with custom DPI', async () => {
      if (!inkscapeAvailable) {
        console.warn('⚠️  Skipping test: Inkscape not installed');
        return;
      }

      const { outputPath } = await runSvg2Png('simple-rect.svg', ['--dpi', '150']);

      expect(fs.existsSync(outputPath)).toBe(true);

      const fileBuffer = fs.readFileSync(outputPath);
      expect(fileBuffer[0]).toBe(0x89); // PNG signature
    });
  });

  describe('Export Area Options', () => {
    it('should export with area-page option', async () => {
      if (!inkscapeAvailable) {
        console.warn('⚠️  Skipping test: Inkscape not installed');
        return;
      }

      const { outputPath } = await runSvg2Png('simple-rect.svg', ['--area-page']);

      expect(fs.existsSync(outputPath)).toBe(true);
    });

    it('should export with area-drawing option', async () => {
      if (!inkscapeAvailable) {
        console.warn('⚠️  Skipping test: Inkscape not installed');
        return;
      }

      const { outputPath } = await runSvg2Png('simple-rect.svg', ['--area-drawing']);

      expect(fs.existsSync(outputPath)).toBe(true);
    });
  });

  describe('Compression and Quality', () => {
    it('should export with compression level', async () => {
      if (!inkscapeAvailable) {
        console.warn('⚠️  Skipping test: Inkscape not installed');
        return;
      }

      const { outputPath } = await runSvg2Png('simple-rect.svg', ['--compression', '9']);

      expect(fs.existsSync(outputPath)).toBe(true);
    });

    it('should export with antialiasing level', async () => {
      if (!inkscapeAvailable) {
        console.warn('⚠️  Skipping test: Inkscape not installed');
        return;
      }

      const { outputPath } = await runSvg2Png('simple-rect.svg', ['--antialias', '3']);

      expect(fs.existsSync(outputPath)).toBe(true);
    });
  });

  describe('Background Options', () => {
    it('should export with background color', async () => {
      if (!inkscapeAvailable) {
        console.warn('⚠️  Skipping test: Inkscape not installed');
        return;
      }

      const { outputPath } = await runSvg2Png('simple-rect.svg', ['--background', 'white']);

      expect(fs.existsSync(outputPath)).toBe(true);

      const fileBuffer = fs.readFileSync(outputPath);
      expect(fileBuffer[0]).toBe(0x89);
    });

    it('should export with background and opacity', async () => {
      if (!inkscapeAvailable) {
        console.warn('⚠️  Skipping test: Inkscape not installed');
        return;
      }

      const { outputPath } = await runSvg2Png('simple-rect.svg', [
        '--background',
        '#ff0000',
        '--background-opacity',
        '0.5'
      ]);

      expect(fs.existsSync(outputPath)).toBe(true);
    });
  });

  describe('Help and Version', () => {
    it('should display help text', async () => {
      const { stdout } = await execFilePromise('node', [SVG2PNG_PATH, '--help']);

      expect(stdout).toContain('sbb-inkscape-svg2png');
      expect(stdout).toContain('Export SVG files to PNG');
      expect(stdout).toContain('--width');
      expect(stdout).toContain('--dpi');
    });

    it('should display version', async () => {
      const { stdout } = await execFilePromise('node', [SVG2PNG_PATH, '--version']);

      expect(stdout).toContain('sbb-inkscape-svg2png');
      expect(stdout).toContain('svg-bbox toolkit');
    });
  });
});
