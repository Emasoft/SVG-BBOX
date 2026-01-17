/**
 * @file Integration tests for sbb-chrome-extract CLI tool options
 * @description Tests for CLI options including:
 *   - Basic extraction with --id option
 *   - --output option sets output path
 *   - --margin option adds margin to extracted element
 *   - --png option generates PNG output
 *   - --scale option scales the PNG output
 *   - --background option sets PNG background
 *   - --quiet option outputs only file path
 *   - --verbose option outputs detailed progress
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';
import { CLI_TIMEOUT_MS } from '../../config/timeouts.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

// CLI_EXEC_TIMEOUT: Timeout for CLI tool execution in integration tests
// WHY use CLI_TIMEOUT_MS * 2: CLI tools internally launch browsers, need overhead buffer
// Allows CI environment to override via config (CI is slower than local)
const CLI_EXEC_TIMEOUT = CLI_TIMEOUT_MS * 2;

/**
 * Helper to parse SVG and extract attributes
 * @param {string} svgPath - Path to SVG file
 * @returns {Promise<{viewBox: string|null, width: string|null, height: string|null, content: string}>}
 */
async function parseSvgAttributes(svgPath) {
  const content = await fs.readFile(svgPath, 'utf8');
  const dom = new JSDOM(content, { contentType: 'image/svg+xml' });
  const svg = dom.window.document.querySelector('svg');

  return {
    viewBox: svg?.getAttribute('viewBox') || null,
    width: svg?.getAttribute('width') || null,
    height: svg?.getAttribute('height') || null,
    content
  };
}

describe('sbb-chrome-extract CLI Options Tests', () => {
  let tempDir;

  beforeEach(async () => {
    // Create temporary directory for test files
    tempDir = path.join(projectRoot, `temp_sbb_chrome_extract_options_test_${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup temporary directory
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should extract element with --id option', async () => {
    /**
     * Test basic extraction using --id to specify element
     */
    const svgPath = path.join(tempDir, 'basic.svg');
    const outputPath = path.join(tempDir, 'extracted.svg');

    const svgContent = `<svg viewBox="0 0 200 200" width="200" height="200" xmlns="http://www.w3.org/2000/svg">
  <rect id="target" x="50" y="50" width="100" height="100" fill="blue"/>
  <circle id="other" cx="30" cy="30" r="20" fill="red"/>
</svg>`;
    await fs.writeFile(svgPath, svgContent, 'utf8');

    const { stdout } = await execFileAsync(
      'node',
      ['sbb-chrome-extract.cjs', svgPath, '--id', 'target', '--output', outputPath],
      {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      }
    );

    // Output SVG should exist
    const outputExists = await fs
      .access(outputPath)
      .then(() => true)
      .catch(() => false);
    expect(outputExists).toBe(true);

    // Should contain extracted element
    const { content } = await parseSvgAttributes(outputPath);
    expect(content).toContain('id="target"');
    expect(stdout).toContain('SVG extracted to:');
  });

  it('should create output at path specified by --output option', async () => {
    /**
     * Test that --output option correctly sets the output file path
     */
    const svgPath = path.join(tempDir, 'input.svg');
    const customOutputPath = path.join(tempDir, 'custom', 'nested', 'output.svg');

    const svgContent = `<svg viewBox="0 0 100 100" width="100" height="100" xmlns="http://www.w3.org/2000/svg">
  <rect id="box" x="10" y="10" width="80" height="80" fill="green"/>
</svg>`;
    await fs.writeFile(svgPath, svgContent, 'utf8');

    // Create nested output directory
    await fs.mkdir(path.dirname(customOutputPath), { recursive: true });

    await execFileAsync(
      'node',
      ['sbb-chrome-extract.cjs', svgPath, '--id', 'box', '--output', customOutputPath],
      {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      }
    );

    // Output should be at the specified path
    const outputExists = await fs
      .access(customOutputPath)
      .then(() => true)
      .catch(() => false);
    expect(outputExists).toBe(true);

    // Verify content was written correctly
    const { content } = await parseSvgAttributes(customOutputPath);
    expect(content).toContain('id="box"');
  });

  it('should add margin around extracted element with --margin option', async () => {
    /**
     * Test that --margin option expands the viewBox around the element
     */
    const svgPath = path.join(tempDir, 'margin-test.svg');
    const outputPath = path.join(tempDir, 'with-margin.svg');

    // Element at known position for predictable margin calculation
    const svgContent = `<svg viewBox="0 0 200 200" width="200" height="200" xmlns="http://www.w3.org/2000/svg">
  <rect id="centered" x="50" y="50" width="100" height="100" fill="purple"/>
</svg>`;
    await fs.writeFile(svgPath, svgContent, 'utf8');

    // Extract with 15 unit margin
    await execFileAsync(
      'node',
      [
        'sbb-chrome-extract.cjs',
        svgPath,
        '--id',
        'centered',
        '--output',
        outputPath,
        '--margin',
        '15'
      ],
      {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      }
    );

    const { viewBox } = await parseSvgAttributes(outputPath);
    expect(viewBox).toBeTruthy();

    // ViewBox should be expanded by margin
    // Original bbox: x=50, y=50, width=100, height=100
    // With margin 15: x=35, y=35, width=130, height=130
    expect(viewBox).toMatch(/35\s+35\s+130\s+130/);
  });

  it('should generate PNG output with --png option', async () => {
    /**
     * Test that --png option generates a PNG file alongside SVG
     */
    const svgPath = path.join(tempDir, 'for-png.svg');
    const outputSvgPath = path.join(tempDir, 'output.svg');
    const outputPngPath = path.join(tempDir, 'output.png');

    const svgContent = `<svg viewBox="0 0 100 100" width="100" height="100" xmlns="http://www.w3.org/2000/svg">
  <circle id="ball" cx="50" cy="50" r="40" fill="orange"/>
</svg>`;
    await fs.writeFile(svgPath, svgContent, 'utf8');

    const { stdout } = await execFileAsync(
      'node',
      [
        'sbb-chrome-extract.cjs',
        svgPath,
        '--id',
        'ball',
        '--output',
        outputSvgPath,
        '--png',
        outputPngPath
      ],
      {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      }
    );

    // Both SVG and PNG should exist
    const svgExists = await fs
      .access(outputSvgPath)
      .then(() => true)
      .catch(() => false);
    const pngExists = await fs
      .access(outputPngPath)
      .then(() => true)
      .catch(() => false);

    expect(svgExists).toBe(true);
    expect(pngExists).toBe(true);

    // Output should mention PNG
    expect(stdout).toContain('PNG rendered to:');

    // Verify PNG has content (PNG magic bytes: 89 50 4E 47)
    const pngBuffer = await fs.readFile(outputPngPath);
    expect(pngBuffer[0]).toBe(0x89);
    expect(pngBuffer[1]).toBe(0x50); // P
    expect(pngBuffer[2]).toBe(0x4e); // N
    expect(pngBuffer[3]).toBe(0x47); // G
  });

  it('should scale PNG output with --scale option', async () => {
    /**
     * Test that --scale option affects PNG resolution
     */
    const svgPath = path.join(tempDir, 'scale-test.svg');
    const outputSvgPath = path.join(tempDir, 'scaled.svg');
    const outputPngPath = path.join(tempDir, 'scaled.png');

    // Small element for clear scale testing
    const svgContent = `<svg viewBox="0 0 50 50" width="50" height="50" xmlns="http://www.w3.org/2000/svg">
  <rect id="small" x="10" y="10" width="30" height="30" fill="teal"/>
</svg>`;
    await fs.writeFile(svgPath, svgContent, 'utf8');

    // Use high scale factor
    const { stdout } = await execFileAsync(
      'node',
      [
        'sbb-chrome-extract.cjs',
        svgPath,
        '--id',
        'small',
        '--output',
        outputSvgPath,
        '--png',
        outputPngPath,
        '--scale',
        '8',
        '--verbose'
      ],
      {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      }
    );

    // PNG should exist
    const pngExists = await fs
      .access(outputPngPath)
      .then(() => true)
      .catch(() => false);
    expect(pngExists).toBe(true);

    // Verbose output should mention scale
    expect(stdout).toContain('scale: 8x');
  });

  it('should set PNG background color with --background option', async () => {
    /**
     * Test that --background option sets PNG background color
     */
    const svgPath = path.join(tempDir, 'bg-test.svg');
    const outputSvgPath = path.join(tempDir, 'with-bg.svg');
    const outputPngPath = path.join(tempDir, 'with-bg.png');

    const svgContent = `<svg viewBox="0 0 80 80" width="80" height="80" xmlns="http://www.w3.org/2000/svg">
  <rect id="square" x="20" y="20" width="40" height="40" fill="yellow"/>
</svg>`;
    await fs.writeFile(svgPath, svgContent, 'utf8');

    // Use white background
    const { stdout } = await execFileAsync(
      'node',
      [
        'sbb-chrome-extract.cjs',
        svgPath,
        '--id',
        'square',
        '--output',
        outputSvgPath,
        '--png',
        outputPngPath,
        '--background',
        'white',
        '--verbose'
      ],
      {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      }
    );

    // PNG should exist
    const pngExists = await fs
      .access(outputPngPath)
      .then(() => true)
      .catch(() => false);
    expect(pngExists).toBe(true);

    // Verbose output should mention background color
    expect(stdout).toContain('background: white');
  });

  it('should output only file paths with --quiet option', async () => {
    /**
     * Test that --quiet option suppresses all output except essential file paths
     */
    const svgPath = path.join(tempDir, 'quiet-test.svg');
    const outputPath = path.join(tempDir, 'quiet-output.svg');

    const svgContent = `<svg viewBox="0 0 100 100" width="100" height="100" xmlns="http://www.w3.org/2000/svg">
  <rect id="item" x="10" y="10" width="80" height="80" fill="navy"/>
</svg>`;
    await fs.writeFile(svgPath, svgContent, 'utf8');

    const { stdout } = await execFileAsync(
      'node',
      ['sbb-chrome-extract.cjs', svgPath, '--id', 'item', '--output', outputPath, '--quiet'],
      {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      }
    );

    // Should NOT contain version banner
    expect(stdout).not.toContain('sbb-chrome-extract v');
    expect(stdout).not.toContain('svg-bbox toolkit');

    // Should still contain essential output (file path)
    expect(stdout).toContain('SVG extracted to:');
    expect(stdout).toContain(outputPath);
  });

  it('should output detailed progress with --verbose option', async () => {
    /**
     * Test that --verbose option shows detailed progress information
     */
    const svgPath = path.join(tempDir, 'verbose-test.svg');
    const outputPath = path.join(tempDir, 'verbose-output.svg');

    const svgContent = `<svg viewBox="0 0 100 100" width="100" height="100" xmlns="http://www.w3.org/2000/svg">
  <rect id="block" x="20" y="20" width="60" height="60" fill="maroon"/>
</svg>`;
    await fs.writeFile(svgPath, svgContent, 'utf8');

    const { stdout } = await execFileAsync(
      'node',
      ['sbb-chrome-extract.cjs', svgPath, '--id', 'block', '--output', outputPath, '--verbose'],
      {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      }
    );

    // Should contain verbose output about getBBox result
    expect(stdout).toContain('Standard .getBBox() result:');
    expect(stdout).toContain('With margin');

    // Should still contain essential output
    expect(stdout).toContain('SVG extracted to:');
  });
});
