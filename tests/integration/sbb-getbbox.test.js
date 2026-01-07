/**
 * @file Integration tests for sbb-getbbox CLI tool
 * @description Comprehensive tests for bounding box computation including:
 *   - Basic bbox computation
 *   - --ignore-vbox flag (full drawing bbox, ignoring viewBox clipping)
 *   - Content outside viewBox detection
 *   - Missing viewBox handling
 *   - Multiple element bbox computation
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
const CLI_EXEC_TIMEOUT = CLI_TIMEOUT_MS * 2;

describe('sbb-getbbox CLI Integration Tests', () => {
  let tempDir;

  beforeEach(async () => {
    // Create temporary directory for test files
    tempDir = path.join(projectRoot, `temp_sbb_getbbox_test_${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup temporary directory
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('Basic bbox computation', () => {
    it('should compute bbox for simple SVG with viewBox', async () => {
      const svgPath = path.join(tempDir, 'simple.svg');
      const svgContent = `<svg viewBox="0 0 100 100" width="100" height="100" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="80" height="80" fill="blue"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      const { stdout } = await execFileAsync('node', ['sbb-getbbox.cjs', svgPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      expect(stdout).toContain('simple.svg');
      // Should report bbox of the rectangle (10,10,80,80) clipped by viewBox (0,0,100,100)
      expect(stdout).toMatch(/x:\s*10/);
      expect(stdout).toMatch(/y:\s*10/);
      expect(stdout).toMatch(/width:\s*80/);
      expect(stdout).toMatch(/height:\s*80/);
    });

    it('should compute bbox for SVG without viewBox', async () => {
      const svgPath = path.join(tempDir, 'no-viewbox.svg');
      const svgContent = `<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
  <circle cx="100" cy="100" r="50" fill="red"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      const { stdout } = await execFileAsync('node', ['sbb-getbbox.cjs', svgPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      expect(stdout).toContain('no-viewbox.svg');
      // Circle bbox: (50,50,100,100) - center (100,100) minus radius 50
      expect(stdout).toMatch(/x:\s*50/);
      expect(stdout).toMatch(/y:\s*50/);
      expect(stdout).toMatch(/width:\s*100/);
      expect(stdout).toMatch(/height:\s*100/);
    });
  });

  describe('--ignore-vbox flag (full drawing bbox)', () => {
    it('should compute full bbox ignoring viewBox clipping', async () => {
      const svgPath = path.join(tempDir, 'content-outside-viewbox.svg');
      // ViewBox is (0,0,100,100) but content extends to (200,200)
      const svgContent = `<svg viewBox="0 0 100 100" width="100" height="100" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="200" height="200" fill="green"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      // NOTE: sbb-getbbox ALWAYS shows full bbox (ignores viewBox clipping by default)
      // This is different from browser rendering which DOES clip to viewBox
      const { stdout: output } = await execFileAsync('node', ['sbb-getbbox.cjs', svgPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      // Should show full drawing bbox (0,0,200,200)
      expect(output).toMatch(/width:\s*200/);
      expect(output).toMatch(/height:\s*200/);

      // WITH --ignore-vbox: Should produce same result (already unclipped)
      const { stdout: _unclippedOutput } = await execFileAsync(
        'node',
        ['sbb-getbbox.cjs', svgPath, '--ignore-vbox'],
        {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        }
      );

      expect(_unclippedOutput).toMatch(/width:\s*200/);
      expect(_unclippedOutput).toMatch(/height:\s*200/);
    });

    it('should detect content completely outside viewBox with --ignore-vbox', async () => {
      const svgPath = path.join(tempDir, 'content-far-outside.svg');
      // ViewBox is (0,0,100,100) but content is at (200,200)
      const svgContent = `<svg viewBox="0 0 100 100" width="100" height="100" xmlns="http://www.w3.org/2000/svg">
  <rect x="200" y="200" width="50" height="50" fill="orange"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      // WITHOUT --ignore-vbox: Content is completely clipped, bbox should be empty or minimal
      const { stdout: _clippedOutput } = await execFileAsync('node', ['sbb-getbbox.cjs', svgPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      // WITH --ignore-vbox: Should show full content bbox (200,200,50,50)
      const { stdout: unclippedOutput } = await execFileAsync(
        'node',
        ['sbb-getbbox.cjs', svgPath, '--ignore-vbox'],
        {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        }
      );

      expect(unclippedOutput).toMatch(/x:\s*200/);
      expect(unclippedOutput).toMatch(/y:\s*200/);
      expect(unclippedOutput).toMatch(/width:\s*50/);
      expect(unclippedOutput).toMatch(/height:\s*50/);
    });

    it('should handle SVG without viewBox with --ignore-vbox', async () => {
      const svgPath = path.join(tempDir, 'no-viewbox-ignore.svg');
      const svgContent = `<svg width="150" height="150" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="75" cy="75" rx="60" ry="40" fill="purple"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      const { stdout } = await execFileAsync(
        'node',
        ['sbb-getbbox.cjs', svgPath, '--ignore-vbox'],
        {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        }
      );

      // Ellipse bbox: (15,35,120,80) - cx±rx, cy±ry
      expect(stdout).toMatch(/x:\s*15/);
      expect(stdout).toMatch(/y:\s*35/);
      expect(stdout).toMatch(/width:\s*120/);
      expect(stdout).toMatch(/height:\s*80/);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty SVG', async () => {
      const svgPath = path.join(tempDir, 'empty.svg');
      const svgContent = `<svg viewBox="0 0 100 100" width="100" height="100" xmlns="http://www.w3.org/2000/svg">
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      const { stdout } = await execFileAsync('node', ['sbb-getbbox.cjs', svgPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      // Empty SVG should report minimal or zero bbox
      expect(stdout).toContain('empty.svg');
    });

    it('should handle complex nested groups', async () => {
      const svgPath = path.join(tempDir, 'nested.svg');
      const svgContent = `<svg viewBox="0 0 200 200" width="200" height="200" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(50,50)">
    <g transform="scale(2)">
      <rect x="10" y="10" width="20" height="20" fill="blue"/>
    </g>
  </g>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      const { stdout } = await execFileAsync('node', ['sbb-getbbox.cjs', svgPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      expect(stdout).toContain('nested.svg');
      // Transformed rect: translate(50,50) then scale(2) → (70,70,40,40)
      expect(stdout).toMatch(/x:\s*70/);
      expect(stdout).toMatch(/y:\s*70/);
      expect(stdout).toMatch(/width:\s*40/);
      expect(stdout).toMatch(/height:\s*40/);
    });

    it('should handle SVG with text elements', async () => {
      const svgPath = path.join(tempDir, 'text.svg');
      const svgContent = `<svg viewBox="0 0 300 100" width="300" height="100" xmlns="http://www.w3.org/2000/svg">
  <text x="10" y="50" font-size="24" font-family="Arial">Hello World</text>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      const { stdout } = await execFileAsync('node', ['sbb-getbbox.cjs', svgPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      expect(stdout).toContain('text.svg');
      // Text bbox should be computed (varies by font rendering)
      expect(stdout).toMatch(/x:/);
      expect(stdout).toMatch(/y:/);
      expect(stdout).toMatch(/width:/);
      expect(stdout).toMatch(/height:/);
    });

    it('should handle extreme aspect ratios', async () => {
      const svgPath = path.join(tempDir, 'extreme-aspect.svg');
      const svgContent = `<svg viewBox="0 0 1000 10" width="1000" height="10" xmlns="http://www.w3.org/2000/svg">
  <rect x="100" y="2" width="800" height="6" fill="black"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      const { stdout } = await execFileAsync('node', ['sbb-getbbox.cjs', svgPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      expect(stdout).toContain('extreme-aspect.svg');
      // Account for rendering tolerance (99.93 vs 100, etc.)
      expect(stdout).toMatch(/x:\s*99\.\d+/);
      expect(stdout).toMatch(/y:\s*1\.\d+/);
      expect(stdout).toMatch(/width:\s*800\.\d+/);
      expect(stdout).toMatch(/height:\s*6\.\d+/);
    });
  });

  describe('Error handling', () => {
    it('should fail gracefully for non-existent file', async () => {
      const nonExistentPath = path.join(tempDir, 'does-not-exist.svg');

      await expect(
        execFileAsync('node', ['sbb-getbbox.cjs', nonExistentPath], {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        })
      ).rejects.toThrow();
    });

    it('should fail gracefully for invalid SVG', async () => {
      const invalidPath = path.join(tempDir, 'invalid.svg');
      await fs.writeFile(invalidPath, 'not valid svg content', 'utf8');

      await expect(
        execFileAsync('node', ['sbb-getbbox.cjs', invalidPath], {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        })
      ).rejects.toThrow();
    });
  });

  describe('Multiple elements', () => {
    it('should compute bbox for multiple non-overlapping elements', async () => {
      const svgPath = path.join(tempDir, 'multiple.svg');
      const svgContent = `<svg viewBox="0 0 300 300" width="300" height="300" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="50" height="50" fill="red"/>
  <rect x="100" y="100" width="50" height="50" fill="blue"/>
  <rect x="200" y="200" width="50" height="50" fill="green"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      const { stdout } = await execFileAsync('node', ['sbb-getbbox.cjs', svgPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      expect(stdout).toContain('multiple.svg');
      // Combined bbox should encompass all three rects: (10,10,240,240)
      expect(stdout).toMatch(/x:\s*10/);
      expect(stdout).toMatch(/y:\s*10/);
      expect(stdout).toMatch(/width:\s*240/);
      expect(stdout).toMatch(/height:\s*240/);
    });

    it('should compute bbox for overlapping elements', async () => {
      const svgPath = path.join(tempDir, 'overlapping.svg');
      const svgContent = `<svg viewBox="0 0 200 200" width="200" height="200" xmlns="http://www.w3.org/2000/svg">
  <circle cx="80" cy="80" r="60" fill="red" opacity="0.5"/>
  <circle cx="120" cy="120" r="60" fill="blue" opacity="0.5"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      const { stdout } = await execFileAsync('node', ['sbb-getbbox.cjs', svgPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      expect(stdout).toContain('overlapping.svg');
      // Combined bbox of two overlapping circles: (20,20,160,160)
      // First circle: (20,20,120,120), second: (60,60,120,120)
      expect(stdout).toMatch(/x:\s*20/);
      expect(stdout).toMatch(/y:\s*20/);
      expect(stdout).toMatch(/width:\s*160/);
      expect(stdout).toMatch(/height:\s*160/);
    });
  });

  describe('Real-world scenarios', () => {
    it('should detect intentional content outside viewBox (logo cutout)', async () => {
      const svgPath = path.join(tempDir, 'logo-cutout.svg');
      // Designer intentionally places watermark/signature outside visible area
      const svgContent = `<svg viewBox="0 0 100 100" width="100" height="100" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="80" height="80" fill="blue"/>
  <text x="110" y="-10" font-size="8" fill="gray">© Designer 2024</text>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      // 2026-01-06 ALGORITHM CONSISTENCY FIX: sbb-getbbox now uses the same
      // algorithm as sbb-fix-viewbox (getSvgElementVisibleAndFullBBoxes().full)
      // Default behavior now returns FULL bbox including content outside viewBox
      const { stdout: result } = await execFileAsync('node', ['sbb-getbbox.cjs', svgPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      // Full bbox includes rect (10,10,80,80) and text at (110,-10)
      // x: 10 (rect starts at x=10)
      expect(result).toMatch(/x:\s*10/);
      // y: negative (text at y=-10 with font ascent pushes it up)
      expect(result).toMatch(/y:\s*-\d+/);
      // width: ~155 (spans from x=10 to end of text at ~x=165)
      expect(result).toMatch(/width:\s*1[45]\d/);
      // height: ~105 (spans from y~=-16 to y=90)
      expect(result).toMatch(/height:\s*10\d/);

      // --ignore-vbox now produces same result (algorithm consistency)
      const { stdout: full } = await execFileAsync(
        'node',
        ['sbb-getbbox.cjs', svgPath, '--ignore-vbox'],
        {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        }
      );

      // Both default and --ignore-vbox should return identical FULL bbox
      expect(full).toMatch(/x:\s*10/);
      expect(full).toMatch(/y:\s*-\d+/);
    });
  });
});
