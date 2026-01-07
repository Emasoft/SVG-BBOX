/**
 * Integration Tests for sbb-inkscape-extract.cjs
 *
 * Tests the Inkscape-based SVG object extraction tool.
 * These tests require Inkscape to be installed on the system.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CLI_TIMEOUT_MS } from '../../config/timeouts.js';

const execFilePromise = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CLI_EXEC_TIMEOUT: Timeout for CLI tool execution in integration tests
const CLI_EXEC_TIMEOUT = CLI_TIMEOUT_MS * 2;

const EXTRACT_PATH = path.join(__dirname, '../../sbb-inkscape-extract.cjs');
const FIXTURES_DIR = path.join(__dirname, '../fixtures');
const TEMP_DIR = path.join(__dirname, '../.tmp-inkscape-extract-tests');

// Check if Inkscape is available
async function checkInkscapeAvailable() {
  try {
    // WHY CLI_TIMEOUT_MS / 2: Inkscape can take 10+ seconds to start on systems with many fonts
    // as it needs to build/load the font cache on first run
    await execFilePromise('inkscape', ['--version'], { timeout: CLI_TIMEOUT_MS / 2 });
    return true;
  } catch {
    return false;
  }
}

// Helper to run sbb-inkscape-extract
async function runExtract(inputSvg, objectId, args = []) {
  const inputPath = path.join(FIXTURES_DIR, inputSvg);
  const outputPath = path.join(TEMP_DIR, `extracted_${objectId}.svg`);

  const { stdout, stderr } = await execFilePromise(
    'node',
    [EXTRACT_PATH, inputPath, '--id', objectId, '--output', outputPath, ...args],
    {
      timeout: 30000 // 30 seconds timeout
    }
  );

  return { stdout, stderr, outputPath };
}

describe('sbb-inkscape-extract Integration Tests', () => {
  let inkscapeAvailable = false;

  beforeAll(async () => {
    inkscapeAvailable = await checkInkscapeAvailable();

    // Create temp directory for test outputs
    if (!fs.existsSync(TEMP_DIR)) {
      fs.mkdirSync(TEMP_DIR, { recursive: true });
    }

    // Create a test SVG with multiple objects
    const testSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <rect id="rect1" x="10" y="10" width="50" height="50" fill="blue"/>
  <circle id="circle1" cx="150" cy="150" r="30" fill="red"/>
  <text id="text1" x="50" y="100" font-size="20">Hello</text>
</svg>`;
    fs.writeFileSync(path.join(FIXTURES_DIR, 'multi-objects.svg'), testSvg);
  });

  afterAll(() => {
    // Clean up temp directory only
    // WHY: Only clean up test outputs, NOT the fixture file
    // DO NOT delete multi-objects.svg here - it causes flaky tests when Vitest retries
    // because beforeAll doesn't re-run on retry, leaving the fixture missing
    if (fs.existsSync(TEMP_DIR)) {
      fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    }
    // NOTE: multi-objects.svg is left in fixtures dir - this is intentional
    // It will be overwritten on next test run by beforeAll
  });

  describe('Basic Object Extraction', () => {
    it('should extract a single object by ID', async () => {
      if (!inkscapeAvailable) {
        console.warn('⚠️  Skipping test: Inkscape not installed');
        return;
      }

      const { outputPath } = await runExtract('multi-objects.svg', 'rect1');

      // Check output file exists
      expect(fs.existsSync(outputPath)).toBe(true);

      // Verify output is valid SVG
      const outputContent = fs.readFileSync(outputPath, 'utf-8');
      expect(outputContent).toContain('<svg');
      expect(outputContent).toContain('</svg>');
      expect(outputContent).toContain('rect1'); // Should contain the extracted object
    });

    it('should extract circle object', async () => {
      if (!inkscapeAvailable) {
        console.warn('⚠️  Skipping test: Inkscape not installed');
        return;
      }

      const { outputPath } = await runExtract('multi-objects.svg', 'circle1');

      expect(fs.existsSync(outputPath)).toBe(true);

      const outputContent = fs.readFileSync(outputPath, 'utf-8');
      expect(outputContent).toContain('<svg');
      expect(outputContent).toContain('circle1');
    });
  });

  describe('With Margin Parameter', () => {
    it('should extract object with margin', async () => {
      if (!inkscapeAvailable) {
        console.warn('⚠️  Skipping test: Inkscape not installed');
        return;
      }

      const { outputPath } = await runExtract('multi-objects.svg', 'rect1', ['--margin', '10']);

      expect(fs.existsSync(outputPath)).toBe(true);

      // Output should be valid SVG
      const outputContent = fs.readFileSync(outputPath, 'utf-8');
      expect(outputContent).toContain('<svg');
      expect(outputContent).toContain('rect1');
    });
  });

  describe('Error Handling', () => {
    it('should fail gracefully for non-existent object ID', async () => {
      if (!inkscapeAvailable) {
        console.warn('⚠️  Skipping test: Inkscape not installed');
        return;
      }

      await expect(runExtract('multi-objects.svg', 'nonexistent-id')).rejects.toThrow();
    });
  });

  describe('Batch Mode', () => {
    it('should process batch file with multiple extractions', async () => {
      if (!inkscapeAvailable) {
        console.warn('⚠️  Skipping test: Inkscape not installed');
        return;
      }

      // Create batch file with relative paths from PROJECT ROOT
      // WHY: Security validation only allows files within cwd
      // So we run from project root and use relative paths to fixtures
      const batchFile = path.join(TEMP_DIR, 'batch-extract.txt');
      const relativeInputSvg = 'tests/fixtures/multi-objects.svg';
      const relativeOutputDir = 'tests/.tmp-inkscape-extract-tests';
      const batchContent = `# Batch extraction test
${relativeInputSvg}\trect1\t${relativeOutputDir}/batch_rect1.svg
${relativeInputSvg}\tcircle1\t${relativeOutputDir}/batch_circle1.svg
${relativeInputSvg}\ttext1\t${relativeOutputDir}/batch_text1.svg`;

      fs.writeFileSync(batchFile, batchContent);

      // Run batch extraction from PROJECT ROOT (not TEMP_DIR)
      // WHY: Security validation restricts paths to cwd - project root includes both fixtures and temp dirs
      const projectRoot = path.join(__dirname, '../..');
      const { stdout } = await execFilePromise('node', [EXTRACT_PATH, '--batch', batchFile], {
        timeout: CLI_EXEC_TIMEOUT,
        cwd: projectRoot
      });

      // Check outputs exist
      expect(fs.existsSync(path.join(TEMP_DIR, 'batch_rect1.svg'))).toBe(true);
      expect(fs.existsSync(path.join(TEMP_DIR, 'batch_circle1.svg'))).toBe(true);
      expect(fs.existsSync(path.join(TEMP_DIR, 'batch_text1.svg'))).toBe(true);

      // Verify stdout shows progress
      expect(stdout).toContain('[1/3]');
      expect(stdout).toContain('[2/3]');
      expect(stdout).toContain('[3/3]');
      expect(stdout).toContain('Batch complete');
    });

    it('should handle batch file with comments and empty lines', async () => {
      if (!inkscapeAvailable) {
        console.warn('⚠️  Skipping test: Inkscape not installed');
        return;
      }

      // Create batch file with comments and relative paths from PROJECT ROOT
      // WHY: Security validation only allows files within cwd
      const batchFile = path.join(TEMP_DIR, 'batch-comments.txt');
      const relativeInputSvg = 'tests/fixtures/multi-objects.svg';
      const relativeOutputDir = 'tests/.tmp-inkscape-extract-tests';
      const batchContent = `# This is a comment

# Extract rect
${relativeInputSvg}\trect1\t${relativeOutputDir}/batch_comment_rect.svg

# Another comment
`;

      fs.writeFileSync(batchFile, batchContent);

      // Run batch extraction from PROJECT ROOT (not TEMP_DIR)
      // WHY: Security validation restricts paths to cwd
      const projectRoot = path.join(__dirname, '../..');
      await execFilePromise('node', [EXTRACT_PATH, '--batch', batchFile], {
        timeout: CLI_EXEC_TIMEOUT,
        cwd: projectRoot
      });

      // Check output exists
      expect(fs.existsSync(path.join(TEMP_DIR, 'batch_comment_rect.svg'))).toBe(true);
    });

    it('should fail for empty batch file', async () => {
      const batchFile = path.join(TEMP_DIR, 'batch-empty.txt');
      fs.writeFileSync(batchFile, '# Only comments\n\n');

      await expect(
        execFilePromise('node', [EXTRACT_PATH, '--batch', batchFile], {
          timeout: 30000
        })
      ).rejects.toThrow();
    });

    it('should fail for invalid batch file format', async () => {
      const batchFile = path.join(TEMP_DIR, 'batch-invalid.txt');
      fs.writeFileSync(batchFile, 'only-one-field.svg\n');

      await expect(
        execFilePromise('node', [EXTRACT_PATH, '--batch', batchFile], {
          timeout: 30000
        })
      ).rejects.toThrow();
    });

    it('should apply margin to all batch extractions', async () => {
      if (!inkscapeAvailable) {
        console.warn('⚠️  Skipping test: Inkscape not installed');
        return;
      }

      // Create batch file with relative paths from PROJECT ROOT
      // WHY: Security validation only allows files within cwd
      const batchFile = path.join(TEMP_DIR, 'batch-margin.txt');
      const relativeInputSvg = 'tests/fixtures/multi-objects.svg';
      const relativeOutputDir = 'tests/.tmp-inkscape-extract-tests';
      const batchContent = `${relativeInputSvg}\trect1\t${relativeOutputDir}/batch_margin_rect.svg
${relativeInputSvg}\tcircle1\t${relativeOutputDir}/batch_margin_circle.svg`;

      fs.writeFileSync(batchFile, batchContent);

      // Run batch extraction with margin from PROJECT ROOT (not TEMP_DIR)
      // WHY: Security validation restricts paths to cwd
      const projectRoot = path.join(__dirname, '../..');
      await execFilePromise('node', [EXTRACT_PATH, '--batch', batchFile, '--margin', '5'], {
        timeout: CLI_EXEC_TIMEOUT,
        cwd: projectRoot
      });

      // Check outputs exist
      expect(fs.existsSync(path.join(TEMP_DIR, 'batch_margin_rect.svg'))).toBe(true);
      expect(fs.existsSync(path.join(TEMP_DIR, 'batch_margin_circle.svg'))).toBe(true);
    });
  });

  describe('Help and Version', () => {
    it('should display help text', async () => {
      const { stdout } = await execFilePromise('node', [EXTRACT_PATH, '--help']);

      expect(stdout).toContain('sbb-inkscape-extract');
      expect(stdout).toContain('Extract a single object');
      expect(stdout).toContain('--id');
      expect(stdout).toContain('--batch');
    });

    it('should display version', async () => {
      const { stdout } = await execFilePromise('node', [EXTRACT_PATH, '--version']);

      expect(stdout).toContain('sbb-inkscape-extract');
      expect(stdout).toContain('svg-bbox toolkit');
    });
  });
});
