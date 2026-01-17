/**
 * @file Integration tests for sbb-fix-viewbox CLI tool
 * @description Comprehensive tests for SVG viewBox/dimension repair including:
 *   - Missing viewBox detection and generation
 *   - Missing width/height synthesis from viewBox
 *   - --force flag (regenerate existing viewBox)
 *   - --overwrite flag (overwrite original file)
 *   - Default _fixed.svg suffix behavior
 *   - Content outside viewBox scenarios
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
const CLI_EXEC_TIMEOUT = CLI_TIMEOUT_MS * 2;

/**
 * Helper to parse SVG and extract viewBox, width, height attributes
 */
async function parseSvgAttributes(svgPath) {
  const content = await fs.readFile(svgPath, 'utf8');
  const dom = new JSDOM(content, { contentType: 'image/svg+xml' });
  const svg = dom.window.document.querySelector('svg');

  return {
    viewBox: svg?.getAttribute('viewBox') || null,
    width: svg?.getAttribute('width') || null,
    height: svg?.getAttribute('height') || null
  };
}

describe('sbb-fix-viewbox CLI Integration Tests', () => {
  let tempDir;

  beforeEach(async () => {
    // Create temporary directory for test files
    tempDir = path.join(projectRoot, `temp_sbb_fix_viewbox_test_${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup temporary directory
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('Missing viewBox repair', () => {
    it('should add viewBox to SVG missing viewBox (with width/height)', async () => {
      const inputPath = path.join(tempDir, 'no-viewbox.svg');
      const outputPath = path.join(tempDir, 'no-viewbox_fixed.svg');

      // SVG with width/height but NO viewBox
      const svgContent = `<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="180" height="180" fill="blue"/>
</svg>`;
      await fs.writeFile(inputPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-fix-viewbox.cjs', inputPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      // Should create _fixed.svg by default
      const attrs = await parseSvgAttributes(outputPath);
      expect(attrs.viewBox).toBeTruthy();
      expect(attrs.viewBox).toMatch(/10\s+10\s+180\s+180/); // bbox of rect
    });

    it('should add viewBox to SVG with NO viewBox and NO dimensions', async () => {
      const inputPath = path.join(tempDir, 'bare.svg');
      const outputPath = path.join(tempDir, 'bare_fixed.svg');

      // Bare SVG with no viewBox, width, or height
      const svgContent = `<svg xmlns="http://www.w3.org/2000/svg">
  <circle cx="50" cy="50" r="40" fill="red"/>
</svg>`;
      await fs.writeFile(inputPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-fix-viewbox.cjs', inputPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const attrs = await parseSvgAttributes(outputPath);
      expect(attrs.viewBox).toBeTruthy();
      // Circle: (10,10,80,80) - cx±r, cy±r
      expect(attrs.viewBox).toMatch(/10\s+10\s+80\s+80/);
      // Should synthesize width/height from viewBox
      expect(attrs.width).toBe('80');
      expect(attrs.height).toBe('80');
    });
  });

  describe('Missing dimensions repair', () => {
    it('should add width/height when both missing (SVG has viewBox)', async () => {
      const inputPath = path.join(tempDir, 'no-dims.svg');
      const outputPath = path.join(tempDir, 'no-dims_fixed.svg');

      // SVG with viewBox but NO width/height
      const svgContent = `<svg viewBox="0 0 300 200" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="280" height="180" fill="green"/>
</svg>`;
      await fs.writeFile(inputPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-fix-viewbox.cjs', inputPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const attrs = await parseSvgAttributes(outputPath);
      expect(attrs.viewBox).toBe('0 0 300 200'); // Preserved
      expect(attrs.width).toBe('300'); // Derived from viewBox
      expect(attrs.height).toBe('200');
    });

    it('should derive width from height using viewBox aspect ratio', async () => {
      const inputPath = path.join(tempDir, 'missing-width.svg');
      const outputPath = path.join(tempDir, 'missing-width_fixed.svg');

      // SVG with viewBox and height, but NO width
      const svgContent = `<svg viewBox="0 0 400 200" height="100" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="380" height="180" fill="purple"/>
</svg>`;
      await fs.writeFile(inputPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-fix-viewbox.cjs', inputPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const attrs = await parseSvgAttributes(outputPath);
      expect(attrs.height).toBe('100');
      // Width = height × (viewBox width / viewBox height) = 100 × (400/200) = 200
      expect(attrs.width).toBe('200');
    });

    it('should derive height from width using viewBox aspect ratio', async () => {
      const inputPath = path.join(tempDir, 'missing-height.svg');
      const outputPath = path.join(tempDir, 'missing-height_fixed.svg');

      // SVG with viewBox and width, but NO height
      const svgContent = `<svg viewBox="0 0 300 150" width="600" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="280" height="130" fill="orange"/>
</svg>`;
      await fs.writeFile(inputPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-fix-viewbox.cjs', inputPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const attrs = await parseSvgAttributes(outputPath);
      expect(attrs.width).toBe('600');
      // Height = width ÷ (viewBox width / viewBox height) = 600 ÷ (300/150) = 300
      expect(attrs.height).toBe('300');
    });
  });

  describe('--force flag (regenerate viewBox)', () => {
    it('should regenerate viewBox with --force even if one exists', async () => {
      const inputPath = path.join(tempDir, 'existing-viewbox.svg');
      const outputPath = path.join(tempDir, 'existing-viewbox_fixed.svg');

      // SVG with existing viewBox (0,0,100,100) but content extends beyond it
      const svgContent = `<svg viewBox="0 0 100 100" width="100" height="100" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="200" height="200" fill="cyan"/>
</svg>`;
      await fs.writeFile(inputPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-fix-viewbox.cjs', inputPath, '--force'], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const attrs = await parseSvgAttributes(outputPath);
      // Should regenerate viewBox to full drawing bbox (0,0,200,200)
      expect(attrs.viewBox).toMatch(/0\s+0\s+200\s+200/);
      expect(attrs.width).toBe('200');
      expect(attrs.height).toBe('200');
    });

    it('should NOT regenerate viewBox without --force (preserve existing)', async () => {
      const inputPath = path.join(tempDir, 'preserve-viewbox.svg');
      const outputPath = path.join(tempDir, 'preserve-viewbox_fixed.svg');

      // SVG with existing viewBox
      const svgContent = `<svg viewBox="10 10 80 80" width="80" height="80" xmlns="http://www.w3.org/2000/svg">
  <rect x="20" y="20" width="60" height="60" fill="magenta"/>
</svg>`;
      await fs.writeFile(inputPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-fix-viewbox.cjs', inputPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const attrs = await parseSvgAttributes(outputPath);
      // Should preserve original viewBox
      expect(attrs.viewBox).toBe('10 10 80 80');
      expect(attrs.width).toBe('80');
      expect(attrs.height).toBe('80');
    });
  });

  describe('--overwrite flag (file handling)', () => {
    it('should create _fixed.svg by default (no --overwrite)', async () => {
      const inputPath = path.join(tempDir, 'original.svg');
      const fixedPath = path.join(tempDir, 'original_fixed.svg');

      const svgContent = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="80" height="80" fill="yellow"/>
</svg>`;
      await fs.writeFile(inputPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-fix-viewbox.cjs', inputPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      // Original should be untouched
      const originalContent = await fs.readFile(inputPath, 'utf8');
      expect(originalContent).toContain('width="100"');
      expect(originalContent).not.toContain('viewBox'); // Original has no viewBox

      // _fixed.svg should exist with viewBox
      const fixedAttrs = await parseSvgAttributes(fixedPath);
      expect(fixedAttrs.viewBox).toBeTruthy();
    });

    it('should overwrite original file with --overwrite flag', async () => {
      const inputPath = path.join(tempDir, 'overwrite-me.svg');

      const svgContent = `<svg width="150" height="150" xmlns="http://www.w3.org/2000/svg">
  <circle cx="75" cy="75" r="60" fill="brown"/>
</svg>`;
      await fs.writeFile(inputPath, svgContent, 'utf8');

      // Wait for warning delay (2 seconds)
      await execFileAsync('node', ['sbb-fix-viewbox.cjs', inputPath, '--overwrite'], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      // Original file should now have viewBox
      const attrs = await parseSvgAttributes(inputPath);
      expect(attrs.viewBox).toBeTruthy();
      expect(attrs.viewBox).toMatch(/15\s+15\s+120\s+120/); // Circle bbox

      // _fixed.svg should NOT exist
      const fixedPath = path.join(tempDir, 'overwrite-me_fixed.svg');
      await expect(fs.access(fixedPath)).rejects.toThrow();
    });

    it('should respect custom output path', async () => {
      const inputPath = path.join(tempDir, 'input.svg');
      const customPath = path.join(tempDir, 'custom-output.svg');

      const svgContent = `<svg xmlns="http://www.w3.org/2000/svg">
  <rect x="5" y="5" width="90" height="90" fill="gray"/>
</svg>`;
      await fs.writeFile(inputPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-fix-viewbox.cjs', inputPath, customPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      // Custom path should exist with viewBox
      const attrs = await parseSvgAttributes(customPath);
      expect(attrs.viewBox).toBeTruthy();

      // _fixed.svg should NOT exist
      const fixedPath = path.join(tempDir, 'input_fixed.svg');
      await expect(fs.access(fixedPath)).rejects.toThrow();
    });
  });

  describe('Edge cases', () => {
    it('should handle SVG with content outside viewBox', async () => {
      const inputPath = path.join(tempDir, 'content-outside.svg');
      const outputPath = path.join(tempDir, 'content-outside_fixed.svg');

      // ViewBox (0,0,100,100) but content at (200,200)
      const svgContent = `<svg viewBox="0 0 100 100" width="100" height="100" xmlns="http://www.w3.org/2000/svg">
  <rect x="200" y="200" width="50" height="50" fill="pink"/>
</svg>`;
      await fs.writeFile(inputPath, svgContent, 'utf8');

      // Without --force: Should preserve viewBox (content is clipped)
      await execFileAsync('node', ['sbb-fix-viewbox.cjs', inputPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const attrsNoForce = await parseSvgAttributes(outputPath);
      expect(attrsNoForce.viewBox).toBe('0 0 100 100'); // Preserved

      // Clean up for next test
      await fs.rm(outputPath);

      // WITH --force: Should regenerate to include full content
      await execFileAsync('node', ['sbb-fix-viewbox.cjs', inputPath, '--force'], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const attrsForce = await parseSvgAttributes(outputPath);
      expect(attrsForce.viewBox).toMatch(/200\s+200\s+50\s+50/); // Full bbox
    });

    it('should handle empty SVG', async () => {
      const inputPath = path.join(tempDir, 'empty.svg');

      const svgContent = `<svg xmlns="http://www.w3.org/2000/svg"></svg>`;
      await fs.writeFile(inputPath, svgContent, 'utf8');

      // Should fail or produce minimal bbox
      await expect(
        execFileAsync('node', ['sbb-fix-viewbox.cjs', inputPath], {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        })
      ).rejects.toThrow();
    });

    it('should handle SVG with transforms', async () => {
      const inputPath = path.join(tempDir, 'transformed.svg');
      const outputPath = path.join(tempDir, 'transformed_fixed.svg');

      const svgContent = `<svg xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(100,100) scale(2)">
    <rect x="10" y="10" width="20" height="20" fill="teal"/>
  </g>
</svg>`;
      await fs.writeFile(inputPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-fix-viewbox.cjs', inputPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const attrs = await parseSvgAttributes(outputPath);
      expect(attrs.viewBox).toBeTruthy();
      // Transform: translate(100,100) then scale(2) → (120,120,40,40)
      expect(attrs.viewBox).toMatch(/120\s+120\s+40\s+40/);
    });
  });

  describe('Error handling', () => {
    it('should fail gracefully for non-existent file', async () => {
      const nonExistentPath = path.join(tempDir, 'does-not-exist.svg');

      await expect(
        execFileAsync('node', ['sbb-fix-viewbox.cjs', nonExistentPath], {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        })
      ).rejects.toThrow();
    });

    it('should fail gracefully for invalid SVG', async () => {
      const invalidPath = path.join(tempDir, 'invalid.svg');
      await fs.writeFile(invalidPath, 'not valid svg content', 'utf8');

      await expect(
        execFileAsync('node', ['sbb-fix-viewbox.cjs', invalidPath], {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        })
      ).rejects.toThrow();
    });
  });

  describe('--batch option (batch processing)', () => {
    it('should process multiple files from batch file with auto-generated outputs', async () => {
      // Create test SVGs
      const svg1 = path.join(tempDir, 'batch1.svg');
      const svg2 = path.join(tempDir, 'batch2.svg');
      await fs.writeFile(
        svg1,
        '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="100" height="100" fill="red"/></svg>',
        'utf8'
      );
      await fs.writeFile(
        svg2,
        '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40" fill="blue"/></svg>',
        'utf8'
      );

      // Create batch file (input only format)
      const batchFile = path.join(tempDir, 'batch.txt');
      await fs.writeFile(batchFile, `${svg1}\n${svg2}`, 'utf8');

      await execFileAsync('node', ['sbb-fix-viewbox.cjs', '--batch', batchFile], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      // Verify outputs created with _fixed suffix
      const out1 = path.join(tempDir, 'batch1_fixed.svg');
      const out2 = path.join(tempDir, 'batch2_fixed.svg');

      const attrs1 = await parseSvgAttributes(out1);
      const attrs2 = await parseSvgAttributes(out2);

      expect(attrs1.viewBox).toBeTruthy();
      expect(attrs2.viewBox).toBeTruthy();
    });

    it('should process batch file with explicit input/output pairs', async () => {
      const inputSvg = path.join(tempDir, 'input_pair.svg');
      const outputSvg = path.join(tempDir, 'custom_output.svg');
      await fs.writeFile(
        inputSvg,
        '<svg xmlns="http://www.w3.org/2000/svg"><rect x="5" y="5" width="90" height="90" fill="green"/></svg>',
        'utf8'
      );

      // Create batch file with tab-separated input/output pair
      const batchFile = path.join(tempDir, 'batch_pairs.txt');
      await fs.writeFile(batchFile, `${inputSvg}\t${outputSvg}`, 'utf8');

      await execFileAsync('node', ['sbb-fix-viewbox.cjs', '--batch', batchFile], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      // Verify custom output path was used
      const attrs = await parseSvgAttributes(outputSvg);
      expect(attrs.viewBox).toBeTruthy();

      // Default _fixed.svg should NOT exist
      const defaultOutput = path.join(tempDir, 'input_pair_fixed.svg');
      await expect(fs.access(defaultOutput)).rejects.toThrow();
    });

    it('should apply --force flag in batch mode', async () => {
      const inputSvg = path.join(tempDir, 'batch_force.svg');
      // SVG with existing viewBox (0,0,50,50) but content extends to 200x200
      await fs.writeFile(
        inputSvg,
        '<svg viewBox="0 0 50 50" width="50" height="50" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="200" height="200" fill="orange"/></svg>',
        'utf8'
      );

      const batchFile = path.join(tempDir, 'batch_force.txt');
      await fs.writeFile(batchFile, inputSvg, 'utf8');

      await execFileAsync('node', ['sbb-fix-viewbox.cjs', '--batch', batchFile, '--force'], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const outputSvg = path.join(tempDir, 'batch_force_fixed.svg');
      const attrs = await parseSvgAttributes(outputSvg);
      // Should regenerate viewBox to full drawing bbox (0,0,200,200)
      expect(attrs.viewBox).toMatch(/0\s+0\s+200\s+200/);
    });
  });

  describe('--auto-open option', () => {
    it('should accept --auto-open flag without error', async () => {
      const inputPath = path.join(tempDir, 'auto-open.svg');
      const outputPath = path.join(tempDir, 'auto-open_fixed.svg');

      await fs.writeFile(
        inputPath,
        '<svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="80" height="80" fill="purple"/></svg>',
        'utf8'
      );

      // --auto-open should not cause error (even if Chrome isn't available)
      // WHY: The tool attempts to open but continues gracefully if browser unavailable
      const { stdout: _stdout } = await execFileAsync(
        'node',
        ['sbb-fix-viewbox.cjs', inputPath, '--auto-open'],
        {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        }
      );

      // Output file should be created regardless of auto-open success
      const attrs = await parseSvgAttributes(outputPath);
      expect(attrs.viewBox).toBeTruthy();
    });
  });

  describe('--quiet option (minimal output)', () => {
    it('should output only file path in quiet mode (single file)', async () => {
      const inputPath = path.join(tempDir, 'quiet-single.svg');
      const outputPath = path.join(tempDir, 'quiet-single_fixed.svg');

      await fs.writeFile(
        inputPath,
        '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="50" height="50" fill="cyan"/></svg>',
        'utf8'
      );

      const { stdout } = await execFileAsync(
        'node',
        ['sbb-fix-viewbox.cjs', inputPath, '--quiet'],
        {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        }
      );

      // In quiet mode, stdout should contain only the output file path
      const trimmedOutput = stdout.trim();
      expect(trimmedOutput).toBe(outputPath);
      // Should NOT contain verbose messages like "sbb-fix-viewbox" or "Fixed SVG saved"
      expect(stdout).not.toContain('sbb-fix-viewbox v');
      expect(stdout).not.toContain('Fixed SVG saved');
    });

    it('should output only file paths in quiet mode (batch)', async () => {
      const svg1 = path.join(tempDir, 'quiet-batch1.svg');
      const svg2 = path.join(tempDir, 'quiet-batch2.svg');
      await fs.writeFile(
        svg1,
        '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="30" height="30" fill="red"/></svg>',
        'utf8'
      );
      await fs.writeFile(
        svg2,
        '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="40" height="40" fill="blue"/></svg>',
        'utf8'
      );

      const batchFile = path.join(tempDir, 'quiet-batch.txt');
      await fs.writeFile(batchFile, `${svg1}\n${svg2}`, 'utf8');

      const { stdout } = await execFileAsync(
        'node',
        ['sbb-fix-viewbox.cjs', '--batch', batchFile, '--quiet'],
        {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        }
      );

      // Should contain output paths but not verbose messages
      expect(stdout).toContain('quiet-batch1_fixed.svg');
      expect(stdout).toContain('quiet-batch2_fixed.svg');
      expect(stdout).not.toContain('Processing');
      expect(stdout).not.toContain('Batch complete');
    });
  });

  describe('--verbose option (detailed output)', () => {
    it('should show detailed progress in verbose mode', async () => {
      const inputPath = path.join(tempDir, 'verbose-test.svg');
      const outputPath = path.join(tempDir, 'verbose-test_fixed.svg');

      await fs.writeFile(
        inputPath,
        '<svg xmlns="http://www.w3.org/2000/svg"><rect x="5" y="5" width="60" height="60" fill="magenta"/></svg>',
        'utf8'
      );

      const { stdout } = await execFileAsync(
        'node',
        ['sbb-fix-viewbox.cjs', inputPath, '--verbose'],
        {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        }
      );

      // Verbose mode should include detailed messages
      expect(stdout).toContain('Processing:');
      expect(stdout).toContain('Output target:');
      expect(stdout).toContain('Validated input path:');
      expect(stdout).toContain('Read SVG content:');
      expect(stdout).toContain('Launching headless browser');

      // Output file should still be created
      const attrs = await parseSvgAttributes(outputPath);
      expect(attrs.viewBox).toBeTruthy();
    });
  });

  describe('Real-world scenarios', () => {
    it('should repair SVG from design tool missing viewBox', async () => {
      const inputPath = path.join(tempDir, 'from-figma.svg');
      const outputPath = path.join(tempDir, 'from-figma_fixed.svg');

      // Common export from Figma: has width/height but NO viewBox
      const svgContent = `<svg width="375" height="812" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="375" height="812" fill="#F5F5F5"/>
  <rect x="16" y="64" width="343" height="48" rx="8" fill="white"/>
</svg>`;
      await fs.writeFile(inputPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-fix-viewbox.cjs', inputPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const attrs = await parseSvgAttributes(outputPath);
      expect(attrs.viewBox).toBeTruthy();
      // Account for rendering tolerance (~0.2px variance)
      expect(attrs.viewBox).toMatch(/^-?[\d.]+\s+-?[\d.]+\s+375[\d.]*\s+812[\d.]*$/);
      expect(attrs.width).toBe('375');
      expect(attrs.height).toBe('812');
    });

    it('should handle SVG with hidden watermark outside viewBox', async () => {
      const inputPath = path.join(tempDir, 'watermarked.svg');
      const outputPath = path.join(tempDir, 'watermarked_fixed.svg');

      // Designer intentionally places watermark outside visible area
      const svgContent = `<svg viewBox="0 0 200 200" width="200" height="200" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="180" height="180" fill="lightblue"/>
  <text x="210" y="-10" font-size="8" fill="gray">© Designer 2024</text>
</svg>`;
      await fs.writeFile(inputPath, svgContent, 'utf8');

      // Default (no --force): Preserve viewBox, hide watermark
      await execFileAsync('node', ['sbb-fix-viewbox.cjs', inputPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const attrsDefault = await parseSvgAttributes(outputPath);
      expect(attrsDefault.viewBox).toBe('0 0 200 200'); // Preserved

      // Clean up for next test
      await fs.rm(outputPath);

      // WITH --force: Expose hidden watermark
      await execFileAsync('node', ['sbb-fix-viewbox.cjs', inputPath, '--force'], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const attrsForce = await parseSvgAttributes(outputPath);
      // Should expand viewBox to include watermark
      expect(attrsForce.viewBox).not.toBe('0 0 200 200');
      expect(attrsForce.viewBox).toMatch(/10/); // Includes content area
    });
  });
});
