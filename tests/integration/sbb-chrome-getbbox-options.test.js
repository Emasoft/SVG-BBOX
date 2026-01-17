/**
 * @file Integration tests for sbb-chrome-getbbox CLI tool options
 * @description Tests for CLI options including:
 *   - Basic bbox computation (baseline)
 *   - --margin option (add margin to bbox)
 *   - --json option (output as JSON)
 *   - --quiet option (minimal output)
 *   - --verbose option (detailed output)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { CLI_TIMEOUT_MS } from '../../config/timeouts.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

// CLI_EXEC_TIMEOUT: Timeout for CLI tool execution in integration tests
// Chrome-based tools need extra time for browser launch
const CLI_EXEC_TIMEOUT = CLI_TIMEOUT_MS * 2;

describe('sbb-chrome-getbbox CLI Options Tests', () => {
  let tempDir;

  beforeEach(async () => {
    // Create temporary directory for test files
    tempDir = path.join(projectRoot, `temp_sbb_chrome_getbbox_test_${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup temporary directory
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('should compute basic bbox for simple SVG (baseline)', async () => {
    /**
     * Baseline test: Verify basic bbox computation works with Chrome getBBox()
     */
    const svgPath = path.join(tempDir, 'basic.svg');
    const svgContent = `<svg viewBox="0 0 100 100" width="100" height="100" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="20" width="60" height="40" fill="blue"/>
</svg>`;
    await fs.writeFile(svgPath, svgContent, 'utf8');

    const { stdout } = await execFileAsync('node', ['sbb-chrome-getbbox.cjs', svgPath], {
      cwd: projectRoot,
      timeout: CLI_EXEC_TIMEOUT
    });

    // Should report bbox of the rectangle (10,20,60,40)
    expect(stdout).toContain('WHOLE CONTENT');
    expect(stdout).toMatch(/x:\s*10/);
    expect(stdout).toMatch(/y:\s*20/);
    expect(stdout).toMatch(/width:\s*60/);
    expect(stdout).toMatch(/height:\s*40/);
  });

  it('should apply margin to bbox with --margin option', async () => {
    /**
     * Test --margin option: Verify margin is added to bbox dimensions
     */
    const svgPath = path.join(tempDir, 'margin-test.svg');
    const svgContent = `<svg viewBox="0 0 100 100" width="100" height="100" xmlns="http://www.w3.org/2000/svg">
  <rect x="20" y="20" width="50" height="50" fill="red"/>
</svg>`;
    await fs.writeFile(svgPath, svgContent, 'utf8');

    // Run with custom margin of 15
    const { stdout } = await execFileAsync(
      'node',
      ['sbb-chrome-getbbox.cjs', svgPath, '--margin', '15'],
      {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      }
    );

    // Output shows both original bbox and with-margin dimensions
    // Original: (20,20,50,50), with margin 15: dimensions become 50+30=80 x 50+30=80
    expect(stdout).toMatch(/x:\s*20/); // Original x
    expect(stdout).toMatch(/y:\s*20/); // Original y
    expect(stdout).toMatch(/width:\s*50/); // Original width
    expect(stdout).toMatch(/height:\s*50/); // Original height
    expect(stdout).toMatch(/with margin:\s*80\.00\s*×\s*80\.00/); // With margin applied
  });

  it('should output valid JSON with --json option', async () => {
    /**
     * Test --json option: Verify JSON output contains x, y, width, height fields
     */
    const svgPath = path.join(tempDir, 'json-test.svg');
    const svgContent = `<svg viewBox="0 0 200 200" width="200" height="200" xmlns="http://www.w3.org/2000/svg">
  <circle cx="100" cy="100" r="50" fill="green"/>
</svg>`;
    await fs.writeFile(svgPath, svgContent, 'utf8');

    const jsonPath = path.join(tempDir, 'output.json');

    await execFileAsync('node', ['sbb-chrome-getbbox.cjs', svgPath, '--json', jsonPath], {
      cwd: projectRoot,
      timeout: CLI_EXEC_TIMEOUT
    });

    // Read and parse JSON output
    const jsonContent = await fs.readFile(jsonPath, 'utf8');
    const result = JSON.parse(jsonContent);

    // JSON should have the file path as key
    const keys = Object.keys(result);
    expect(keys.length).toBe(1);

    // Get the results for our file
    const fileResults = result[keys[0]];
    expect(fileResults).toHaveProperty('WHOLE CONTENT');

    // Check bbox fields exist and have correct structure
    const wholeContent = fileResults['WHOLE CONTENT'];
    expect(wholeContent).toHaveProperty('bbox');
    expect(wholeContent).toHaveProperty('originalBbox');
    expect(wholeContent.originalBbox).toHaveProperty('x');
    expect(wholeContent.originalBbox).toHaveProperty('y');
    expect(wholeContent.originalBbox).toHaveProperty('width');
    expect(wholeContent.originalBbox).toHaveProperty('height');

    // Circle bbox: (50,50,100,100) - center (100,100) minus radius 50
    expect(wholeContent.originalBbox.x).toBe(50);
    expect(wholeContent.originalBbox.y).toBe(50);
    expect(wholeContent.originalBbox.width).toBe(100);
    expect(wholeContent.originalBbox.height).toBe(100);
  });

  it('should output only bbox values with --quiet option', async () => {
    /**
     * Test --quiet option: Verify minimal output format (only bbox values)
     */
    const svgPath = path.join(tempDir, 'quiet-test.svg');
    const svgContent = `<svg viewBox="0 0 100 100" width="100" height="100" xmlns="http://www.w3.org/2000/svg">
  <rect x="5" y="10" width="30" height="40" fill="purple"/>
</svg>`;
    await fs.writeFile(svgPath, svgContent, 'utf8');

    const { stdout } = await execFileAsync('node', ['sbb-chrome-getbbox.cjs', svgPath, '--quiet'], {
      cwd: projectRoot,
      timeout: CLI_EXEC_TIMEOUT
    });

    // Quiet mode outputs only: key: x,y,width,height
    // Should NOT contain version banner or decorative output
    expect(stdout).not.toContain('sbb-chrome-getbbox v');
    expect(stdout).not.toContain('svg-bbox toolkit');

    // Should contain the compact bbox format
    expect(stdout).toMatch(/WHOLE CONTENT:\s*5\.00,10\.00,30\.00,40\.00/);
  });

  it('should output detailed progress with --verbose option', async () => {
    /**
     * Test --verbose option: Verify detailed progress information is shown
     */
    const svgPath = path.join(tempDir, 'verbose-test.svg');
    const svgContent = `<svg viewBox="0 0 100 100" width="100" height="100" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="100" height="100" fill="orange"/>
</svg>`;
    await fs.writeFile(svgPath, svgContent, 'utf8');

    const { stdout } = await execFileAsync(
      'node',
      ['sbb-chrome-getbbox.cjs', svgPath, '--verbose'],
      {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      }
    );

    // Verbose mode should show progress information
    expect(stdout).toContain('Processing:');
    expect(stdout).toContain('verbose-test.svg');
    expect(stdout).toContain('Element IDs:');
    expect(stdout).toContain('WHOLE CONTENT');
    expect(stdout).toContain('Margin:');
    expect(stdout).toContain('Launching browser');
    expect(stdout).toContain('Browser operation completed');
  });
});
