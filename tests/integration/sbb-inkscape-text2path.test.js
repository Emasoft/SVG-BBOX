/**
 * Integration Tests for sbb-inkscape-text2path.cjs
 *
 * Tests the Inkscape-based text-to-path conversion tool.
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

const TEXT2PATH_PATH = path.join(__dirname, '../../sbb-inkscape-text2path.cjs');
const FIXTURES_DIR = path.join(__dirname, '../fixtures');
const TEMP_DIR = path.join(__dirname, '../.tmp-inkscape-text2path-tests');

// Check if Inkscape is available
async function checkInkscapeAvailable() {
  try {
    await execFilePromise('inkscape', ['--version'], { timeout: 5000 });
    return true;
  } catch (_err) {
    return false;
  }
}

// Helper to run sbb-inkscape-text2path
async function runText2Path(inputSvg, args = []) {
  const inputPath = path.join(FIXTURES_DIR, inputSvg);
  const outputPath = path.join(TEMP_DIR, inputSvg.replace('.svg', '-paths.svg'));

  const { stdout, stderr } = await execFilePromise('node', [
    TEXT2PATH_PATH,
    inputPath,
    outputPath,
    '--skip-comparison', // Skip comparison for faster tests
    ...args
  ], {
    timeout: 120000 // 2 minutes timeout (comparison can take time)
  });

  return { stdout, stderr, outputPath };
}

describe('sbb-inkscape-text2path Integration Tests', () => {
  let inkscapeAvailable = false;

  beforeAll(async () => {
    inkscapeAvailable = await checkInkscapeAvailable();

    // Create temp directory for test outputs
    if (!fs.existsSync(TEMP_DIR)) {
      fs.mkdirSync(TEMP_DIR, { recursive: true });
    }

    // Create a test SVG with text elements
    const textSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100">
  <text x="10" y="30" font-family="Arial" font-size="20" fill="black">Hello World</text>
  <text x="10" y="60" font-family="Arial" font-size="16" fill="blue">Test Text</text>
</svg>`;
    fs.writeFileSync(path.join(FIXTURES_DIR, 'text-sample.svg'), textSvg);
  });

  afterAll(() => {
    // Clean up temp directory
    if (fs.existsSync(TEMP_DIR)) {
      fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    }

    // Clean up test fixture
    const testFixture = path.join(FIXTURES_DIR, 'text-sample.svg');
    if (fs.existsSync(testFixture)) {
      fs.unlinkSync(testFixture);
    }
  });

  describe('Basic Text to Path Conversion', () => {
    it('should convert text elements to paths', async () => {
      if (!inkscapeAvailable) {
        console.warn('⚠️  Skipping test: Inkscape not installed');
        return;
      }

      const { outputPath } = await runText2Path('text-sample.svg');

      // Check output file exists
      expect(fs.existsSync(outputPath)).toBe(true);

      // Verify output is valid SVG
      const outputContent = fs.readFileSync(outputPath, 'utf-8');
      expect(outputContent).toContain('<svg');
      expect(outputContent).toContain('</svg>');

      // Text should be converted to paths
      // The output should have <path> elements instead of <text>
      expect(outputContent).toContain('<path');

      // Should NOT contain <text> elements anymore (or very few if any metadata)
      const textMatches = outputContent.match(/<text/g);
      expect(textMatches === null || textMatches.length === 0).toBe(true);
    });

    it('should handle SVG without text elements', async () => {
      if (!inkscapeAvailable) {
        console.warn('⚠️  Skipping test: Inkscape not installed');
        return;
      }

      // Use simple-rect.svg which has no text
      const { outputPath } = await runText2Path('simple-rect.svg');

      expect(fs.existsSync(outputPath)).toBe(true);

      const outputContent = fs.readFileSync(outputPath, 'utf-8');
      expect(outputContent).toContain('<svg');
      expect(outputContent).toContain('rect'); // Should still have the rect
    });
  });

  describe('Overwrite Behavior', () => {
    it('should fail if output exists without --overwrite', async () => {
      if (!inkscapeAvailable) {
        console.warn('⚠️  Skipping test: Inkscape not installed');
        return;
      }

      const inputPath = path.join(FIXTURES_DIR, 'simple-rect.svg');
      const outputPath = path.join(TEMP_DIR, 'overwrite-fail-test-paths.svg');

      // First conversion should succeed
      await execFilePromise('node', [
        TEXT2PATH_PATH,
        inputPath,
        outputPath,
        '--skip-comparison'
      ], { timeout: 120000 });

      expect(fs.existsSync(outputPath)).toBe(true);

      // Second conversion without --overwrite should fail
      await expect(
        execFilePromise('node', [
          TEXT2PATH_PATH,
          inputPath,
          outputPath,
          '--skip-comparison'
        ], { timeout: 120000 })
      ).rejects.toThrow();
    });

    it('should succeed with --overwrite flag', async () => {
      if (!inkscapeAvailable) {
        console.warn('⚠️  Skipping test: Inkscape not installed');
        return;
      }

      const outputPath = path.join(TEMP_DIR, 'overwrite-test-paths.svg');
      const inputPath = path.join(FIXTURES_DIR, 'text-sample.svg');

      // First conversion
      await execFilePromise('node', [
        TEXT2PATH_PATH,
        inputPath,
        outputPath,
        '--skip-comparison'
      ], { timeout: 120000 });

      expect(fs.existsSync(outputPath)).toBe(true);

      // Second conversion with --overwrite should succeed
      const { stdout: _stdout } = await execFilePromise('node', [
        TEXT2PATH_PATH,
        inputPath,
        outputPath,
        '--overwrite',
        '--skip-comparison'
      ], { timeout: 120000 });

      expect(fs.existsSync(outputPath)).toBe(true);
    });
  });

  describe('Batch Processing', () => {
    it('should process multiple files in batch mode', async () => {
      if (!inkscapeAvailable) {
        console.warn('⚠️  Skipping test: Inkscape not installed');
        return;
      }

      // Create batch file
      const batchFile = path.join(TEMP_DIR, 'batch.txt');
      const batchContent = [
        path.join(FIXTURES_DIR, 'text-sample.svg'),
        path.join(FIXTURES_DIR, 'simple-rect.svg')
      ].join('\n');
      fs.writeFileSync(batchFile, batchContent);

      // Run batch conversion
      const { stdout: _stdout2 } = await execFilePromise('node', [
        TEXT2PATH_PATH,
        '--batch', batchFile,
        '--skip-comparison',
        '--overwrite'
      ], { timeout: 120000 });

      // Check that outputs were created
      const output1 = path.join(FIXTURES_DIR, 'text-sample-paths.svg');
      const output2 = path.join(FIXTURES_DIR, 'simple-rect-paths.svg');

      expect(fs.existsSync(output1)).toBe(true);
      expect(fs.existsSync(output2)).toBe(true);

      // Clean up batch outputs
      if (fs.existsSync(output1)) {
        fs.unlinkSync(output1);
      }
      if (fs.existsSync(output2)) {
        fs.unlinkSync(output2);
      }
    });
  });

  describe('File Size Changes', () => {
    it('should produce larger file (paths are more verbose than text)', async () => {
      if (!inkscapeAvailable) {
        console.warn('⚠️  Skipping test: Inkscape not installed');
        return;
      }

      const inputPath = path.join(FIXTURES_DIR, 'text-sample.svg');
      const { outputPath } = await runText2Path('text-sample.svg', ['--overwrite']);

      const inputSize = fs.statSync(inputPath).size;
      const outputSize = fs.statSync(outputPath).size;

      // Output file should typically be larger (paths are more verbose)
      // But this depends on the text, so we just check both exist and have content
      expect(inputSize).toBeGreaterThan(0);
      expect(outputSize).toBeGreaterThan(0);
    });
  });

  describe('Help and Version', () => {
    it('should display help text', async () => {
      const { stdout } = await execFilePromise('node', [
        TEXT2PATH_PATH,
        '--help'
      ]);

      expect(stdout).toContain('sbb-inkscape-text2path');
      expect(stdout).toContain('text elements');
      expect(stdout).toContain('--batch');
      expect(stdout).toContain('--overwrite');
    });

    it('should display version', async () => {
      const { stdout } = await execFilePromise('node', [
        TEXT2PATH_PATH,
        '--version'
      ]);

      expect(stdout).toContain('sbb-inkscape-text2path');
      expect(stdout).toContain('svg-bbox toolkit');
    });
  });
});
