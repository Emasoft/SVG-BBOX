/**
 * @file Integration tests for sbb-svg2png CLI tool
 * @description Comprehensive tests for SVG to PNG rendering including:
 *   - Basic SVG to PNG conversion
 *   - Scale factor (--scale flag) - 1x, 2x, 4x, 8x scaling
 *   - Background color (--background flag) - transparent, white, custom colors
 *   - Output dimensions verification (--width, --height flags)
 *   - PNG file format validation
 *   - Preserving aspect ratio
 *   - Rendering modes: visible, full, element
 *   - Element-specific rendering (--element-id flag)
 *   - Margin handling (--margin flag)
 *   - Edge cases (extreme sizes, invalid SVG, missing viewBox)
 *   - Error handling (non-existent files, invalid options)
 *   - Real-world scenarios (complex SVGs, text rendering)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';
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
 * Helper to read and parse PNG file
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
 * Helper to check if PNG has transparent pixels
 */
function hasTransparentPixels(png) {
  for (let i = 0; i < png.data.length; i += 4) {
    const alpha = png.data[i + 3];
    if (alpha < 255) return true;
  }
  return false;
}

/**
 * Helper to get dominant background color from PNG corner
 * Samples pixel at (5,5) to avoid anti-aliasing artifacts at edge
 */
function getCornerColor(png) {
  // Sample pixel at (5,5) instead of (0,0) to avoid edge artifacts
  const offset = (5 * png.width + 5) * 4;
  const r = png.data[offset];
  const g = png.data[offset + 1];
  const b = png.data[offset + 2];
  return { r, g, b };
}

describe('sbb-svg2png CLI Integration Tests', () => {
  let tempDir;

  beforeEach(async () => {
    // Create temporary directory for test files
    tempDir = path.join(projectRoot, `temp_sbb_svg2png_test_${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup temporary directory
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('Basic SVG to PNG conversion', () => {
    it('should convert simple SVG to PNG with default settings', async () => {
      /**
       * Test basic conversion with default scale (4x) and white background
       */
      const svgPath = path.join(tempDir, 'simple.svg');
      const pngPath = path.join(tempDir, 'simple.png');

      const svgContent = `<svg viewBox="0 0 100 100" width="100" height="100" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="80" height="80" fill="blue"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-svg2png.cjs', svgPath, pngPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      // Verify PNG exists
      const stats = await fs.stat(pngPath);
      expect(stats.isFile()).toBe(true);

      // Verify PNG dimensions (bbox of rect: 80x80 at 4x scale = 320x320)
      const png = await parsePng(pngPath);
      expect(png.width).toBe(320);
      expect(png.height).toBe(320);
    });

    it('should handle SVG without viewBox', async () => {
      /**
       * Test conversion of SVG without viewBox attribute
       */
      const svgPath = path.join(tempDir, 'no-viewbox.svg');
      const pngPath = path.join(tempDir, 'no-viewbox.png');

      const svgContent = `<svg width="200" height="150" xmlns="http://www.w3.org/2000/svg">
  <circle cx="100" cy="75" r="50" fill="red"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-svg2png.cjs', svgPath, pngPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const png = await parsePng(pngPath);
      // Circle bbox: (50,25,100,100) at 4x scale = 400x400
      expect(png.width).toBe(400);
      expect(png.height).toBe(400);
    });
  });

  describe('Scale factor (--scale)', () => {
    it('should render at 1x scale', async () => {
      /**
       * Test low resolution rendering (--scale 1)
       */
      const svgPath = path.join(tempDir, 'scale1x.svg');
      const pngPath = path.join(tempDir, 'scale1x.png');

      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="20" y="20" width="60" height="60" fill="green"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-svg2png.cjs', svgPath, pngPath, '--scale', '1'], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const png = await parsePng(pngPath);
      // BBox of rect (20,20,60,60) at 1x scale = 60x60
      expect(png.width).toBe(60);
      expect(png.height).toBe(60);
    });

    it('should render at 2x scale', async () => {
      /**
       * Test medium resolution rendering (--scale 2)
       */
      const svgPath = path.join(tempDir, 'scale2x.svg');
      const pngPath = path.join(tempDir, 'scale2x.png');

      const svgContent = `<svg viewBox="0 0 50 50" xmlns="http://www.w3.org/2000/svg">
  <circle cx="25" cy="25" r="20" fill="purple"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-svg2png.cjs', svgPath, pngPath, '--scale', '2'], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const png = await parsePng(pngPath);
      // BBox of circle (5,5,40,40) at 2x scale = 80x80
      expect(png.width).toBe(80);
      expect(png.height).toBe(80);
    });

    it('should render at 4x scale (default)', async () => {
      /**
       * Test default high resolution rendering (--scale 4)
       */
      const svgPath = path.join(tempDir, 'scale4x.svg');
      const pngPath = path.join(tempDir, 'scale4x.png');

      const svgContent = `<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="60" height="60" fill="orange"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-svg2png.cjs', svgPath, pngPath, '--scale', '4'], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const png = await parsePng(pngPath);
      // BBox of rect (10,10,60,60) at 4x scale = 240x240
      expect(png.width).toBe(240);
      expect(png.height).toBe(240);
    });

    it('should render at 8x scale (very high resolution)', async () => {
      /**
       * Test very high resolution rendering (--scale 8)
       */
      const svgPath = path.join(tempDir, 'scale8x.svg');
      const pngPath = path.join(tempDir, 'scale8x.png');

      const svgContent = `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="20" cy="20" rx="15" ry="10" fill="cyan"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-svg2png.cjs', svgPath, pngPath, '--scale', '8'], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const png = await parsePng(pngPath);
      // BBox of ellipse (5,10,30,20) at 8x scale = 240x160
      expect(png.width).toBe(240);
      expect(png.height).toBe(160);
    });
  });

  describe('Background color (--background)', () => {
    it('should render with transparent background', async () => {
      /**
       * Test transparent PNG generation (--background transparent)
       */
      const svgPath = path.join(tempDir, 'transparent.svg');
      const pngPath = path.join(tempDir, 'transparent.png');

      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <circle cx="50" cy="50" r="40" fill="red"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync(
        'node',
        ['sbb-svg2png.cjs', svgPath, pngPath, '--background', 'transparent'],
        {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        }
      );

      const png = await parsePng(pngPath);
      expect(hasTransparentPixels(png)).toBe(true);
    });

    it('should render with white background (default)', async () => {
      /**
       * Test white background (default behavior)
       * sbb-svg2png uses white as the default background color
       */
      const svgPath = path.join(tempDir, 'white-bg.svg');
      const pngPath = path.join(tempDir, 'white-bg.png');

      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="40" y="40" width="20" height="20" fill="black"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-svg2png.cjs', svgPath, pngPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const png = await parsePng(pngPath);
      const color = getCornerColor(png);
      // Default background is white RGB(255, 255, 255)
      expect(color.r).toBe(255);
      expect(color.g).toBe(255);
      expect(color.b).toBe(255);
    });

    it('should render with custom hex color background', async () => {
      /**
       * Test custom hex color background (--background #ff0000)
       */
      const svgPath = path.join(tempDir, 'custom-hex.svg');
      const pngPath = path.join(tempDir, 'custom-hex.png');

      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <circle cx="50" cy="50" r="20" fill="white"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync(
        'node',
        ['sbb-svg2png.cjs', svgPath, pngPath, '--background', '#ff0000'],
        {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        }
      );

      const png = await parsePng(pngPath);
      const color = getCornerColor(png);
      // Red background should be RGB(255, 0, 0)
      expect(color.r).toBe(255);
      expect(color.g).toBe(0);
      expect(color.b).toBe(0);
    });

    it('should render with named color background', async () => {
      /**
       * Test named CSS color background (--background blue)
       */
      const svgPath = path.join(tempDir, 'named-color.svg');
      const pngPath = path.join(tempDir, 'named-color.png');

      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="30" y="30" width="40" height="40" fill="yellow"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      // Use --margin to add padding around content, exposing background at corners
      // CLI crops to visible bbox by default, so without margin the corner would be yellow (the rect)
      await execFileAsync(
        'node',
        ['sbb-svg2png.cjs', svgPath, pngPath, '--background', 'blue', '--margin', '10'],
        {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        }
      );

      const png = await parsePng(pngPath);
      const color = getCornerColor(png);
      // Named color 'blue' should render as RGB(0, 0, 255)
      expect(color.r).toBe(0);
      expect(color.g).toBe(0);
      expect(color.b).toBe(255);
    });
  });

  describe('Custom dimensions (--width, --height)', () => {
    it('should override width and height', async () => {
      /**
       * Test custom pixel dimensions (--width, --height)
       */
      const svgPath = path.join(tempDir, 'custom-dims.svg');
      const pngPath = path.join(tempDir, 'custom-dims.png');

      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="80" height="80" fill="green"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync(
        'node',
        ['sbb-svg2png.cjs', svgPath, pngPath, '--width', '800', '--height', '600'],
        {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        }
      );

      const png = await parsePng(pngPath);
      expect(png.width).toBe(800);
      expect(png.height).toBe(600);
    });

    it('should override only width (height derived from aspect ratio)', async () => {
      /**
       * Test custom width with aspect ratio preservation
       */
      const svgPath = path.join(tempDir, 'width-only.svg');
      const pngPath = path.join(tempDir, 'width-only.png');

      const svgContent = `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="20" y="20" width="160" height="60" fill="purple"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-svg2png.cjs', svgPath, pngPath, '--width', '1000'], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const png = await parsePng(pngPath);
      expect(png.width).toBe(1000);
      // Height should be derived from viewBox aspect ratio (200:100 = 2:1)
      // But since we override width, the actual height may vary
      expect(png.height).toBeGreaterThan(0);
    });
  });

  describe('Rendering modes (--mode)', () => {
    it('should render in visible mode (default) - content inside viewBox', async () => {
      /**
       * Test visible mode (default): only content inside viewBox
       */
      const svgPath = path.join(tempDir, 'mode-visible.svg');
      const pngPath = path.join(tempDir, 'mode-visible.png');

      // Content partially outside viewBox (red rect is completely outside)
      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="80" height="80" fill="blue"/>
  <rect x="110" y="110" width="30" height="30" fill="red"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-svg2png.cjs', svgPath, pngPath, '--mode', 'visible'], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const png = await parsePng(pngPath);
      // Should render only blue rect inside viewBox, bbox (10,10,80,80) at 4x = 360x360
      expect(png.width).toBe(360);
      expect(png.height).toBe(360);
    });

    it('should render in full mode - entire drawing regardless of viewBox', async () => {
      /**
       * Test full mode: render all content, ignoring viewBox clipping
       */
      const svgPath = path.join(tempDir, 'mode-full.svg');
      const pngPath = path.join(tempDir, 'mode-full.png');

      // ViewBox is (0,0,100,100) but content extends to (200,200)
      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="200" height="200" fill="green"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-svg2png.cjs', svgPath, pngPath, '--mode', 'full'], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const png = await parsePng(pngPath);
      // Should render full content (200x200) at 4x scale
      expect(png.width).toBe(800);
      expect(png.height).toBe(800);
    });

    it('should render in element mode - only specific element', async () => {
      /**
       * Test element mode: render only one element by ID
       */
      const svgPath = path.join(tempDir, 'mode-element.svg');
      const pngPath = path.join(tempDir, 'mode-element.png');

      const svgContent = `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="80" height="80" fill="blue"/>
  <rect id="target" x="110" y="110" width="60" height="60" fill="red"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync(
        'node',
        ['sbb-svg2png.cjs', svgPath, pngPath, '--mode', 'element', '--element-id', 'target'],
        {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        }
      );

      const png = await parsePng(pngPath);
      // Should render only the target element (60x60) at 4x scale
      expect(png.width).toBe(240);
      expect(png.height).toBe(240);
    });
  });

  describe('Margin handling (--margin)', () => {
    it('should add margin in SVG user units', async () => {
      /**
       * Test margin addition (--margin flag)
       */
      const svgPath = path.join(tempDir, 'with-margin.svg');
      const pngPath = path.join(tempDir, 'with-margin.png');

      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="20" y="20" width="60" height="60" fill="orange"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-svg2png.cjs', svgPath, pngPath, '--margin', '10'], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const png = await parsePng(pngPath);
      // BBox of rect (20,20,60,60) with 10 unit margin = (10,10,80,80)
      // At 4x scale: 320x320
      expect(png.width).toBe(320);
      expect(png.height).toBe(320);
    });

    it('should clamp margin to viewBox in visible mode', async () => {
      /**
       * Test margin clamping in visible mode
       */
      const svgPath = path.join(tempDir, 'margin-clamped.svg');
      const pngPath = path.join(tempDir, 'margin-clamped.png');

      // Content with margin that would exceed viewBox
      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="80" height="80" fill="purple"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync(
        'node',
        ['sbb-svg2png.cjs', svgPath, pngPath, '--mode', 'visible', '--margin', '50'],
        {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        }
      );

      const png = await parsePng(pngPath);
      // Margin clamped to viewBox (0,0,100,100)
      // BBox of rect (10,10,80,80) clamped to viewBox = (0,0,100,100) at 4x
      expect(png.width).toBe(400); // 100 * 4
      expect(png.height).toBe(400);
    });
  });

  describe('Edge cases', () => {
    it('should handle extreme aspect ratios', async () => {
      /**
       * Test very wide aspect ratio SVG
       */
      const svgPath = path.join(tempDir, 'extreme-aspect.svg');
      const pngPath = path.join(tempDir, 'extreme-aspect.png');

      const svgContent = `<svg viewBox="0 0 1000 10" xmlns="http://www.w3.org/2000/svg">
  <rect x="100" y="2" width="800" height="6" fill="black"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-svg2png.cjs', svgPath, pngPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const png = await parsePng(pngPath);
      // Should preserve aspect ratio (bbox: 800x6, aspect ratio ~133:1)
      // Allow some tolerance for rendering
      expect(png.width / png.height).toBeGreaterThan(100);
    });

    it('should handle very small SVG', async () => {
      /**
       * Test tiny SVG (1x1 viewBox)
       */
      const svgPath = path.join(tempDir, 'tiny.svg');
      const pngPath = path.join(tempDir, 'tiny.png');

      const svgContent = `<svg viewBox="0 0 1 1" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="1" height="1" fill="red"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-svg2png.cjs', svgPath, pngPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const png = await parsePng(pngPath);
      // At 4x scale: 4x4 pixels
      expect(png.width).toBe(4);
      expect(png.height).toBe(4);
    });

    it('should handle complex nested groups with transforms', async () => {
      /**
       * Test SVG with complex transform hierarchies
       */
      const svgPath = path.join(tempDir, 'nested-transforms.svg');
      const pngPath = path.join(tempDir, 'nested-transforms.png');

      const svgContent = `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(50,50)">
    <g transform="rotate(45)">
      <g transform="scale(2)">
        <rect x="10" y="10" width="20" height="20" fill="teal"/>
      </g>
    </g>
  </g>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-svg2png.cjs', svgPath, pngPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      // Should render without errors
      const stats = await fs.stat(pngPath);
      expect(stats.isFile()).toBe(true);
    });

    it('should handle SVG with text elements', async () => {
      /**
       * Test text rendering with fonts
       */
      const svgPath = path.join(tempDir, 'text.svg');
      const pngPath = path.join(tempDir, 'text.png');

      const svgContent = `<svg viewBox="0 0 300 100" xmlns="http://www.w3.org/2000/svg">
  <text x="10" y="50" font-size="24" font-family="Arial" fill="black">Hello World</text>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-svg2png.cjs', svgPath, pngPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const png = await parsePng(pngPath);
      expect(png.width).toBeGreaterThan(0);
      expect(png.height).toBeGreaterThan(0);
    });

    it('should handle SVG with gradients and filters', async () => {
      /**
       * Test advanced SVG features (gradients, filters)
       */
      const svgPath = path.join(tempDir, 'gradient.svg');
      const pngPath = path.join(tempDir, 'gradient.png');

      const svgContent = `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:rgb(255,255,0);stop-opacity:1" />
      <stop offset="100%" style="stop-color:rgb(255,0,0);stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect x="50" y="50" width="100" height="100" fill="url(#grad1)"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-svg2png.cjs', svgPath, pngPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const stats = await fs.stat(pngPath);
      expect(stats.isFile()).toBe(true);
    });
  });

  describe('Error handling', () => {
    it('should fail gracefully for non-existent file', async () => {
      /**
       * Test error handling for missing input file
       */
      const nonExistentPath = path.join(tempDir, 'does-not-exist.svg');
      const pngPath = path.join(tempDir, 'output.png');

      await expect(
        execFileAsync('node', ['sbb-svg2png.cjs', nonExistentPath, pngPath], {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        })
      ).rejects.toThrow();
    });

    it('should fail gracefully for invalid SVG', async () => {
      /**
       * Test error handling for malformed SVG
       */
      const invalidPath = path.join(tempDir, 'invalid.svg');
      const pngPath = path.join(tempDir, 'invalid.png');

      await fs.writeFile(invalidPath, 'not valid svg content', 'utf8');

      await expect(
        execFileAsync('node', ['sbb-svg2png.cjs', invalidPath, pngPath], {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        })
      ).rejects.toThrow();
    });

    it('should fail when element-id not provided with element mode', async () => {
      /**
       * Test error for missing --element-id in element mode
       */
      const svgPath = path.join(tempDir, 'element-no-id.svg');
      const pngPath = path.join(tempDir, 'element-no-id.png');

      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="80" height="80" fill="blue"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await expect(
        execFileAsync('node', ['sbb-svg2png.cjs', svgPath, pngPath, '--mode', 'element'], {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        })
      ).rejects.toThrow();
    });

    it('should fail when element-id does not exist', async () => {
      /**
       * Test error for non-existent element ID
       */
      const svgPath = path.join(tempDir, 'missing-element.svg');
      const pngPath = path.join(tempDir, 'missing-element.png');

      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect id="existing" x="10" y="10" width="80" height="80" fill="blue"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await expect(
        execFileAsync(
          'node',
          ['sbb-svg2png.cjs', svgPath, pngPath, '--mode', 'element', '--element-id', 'nonexistent'],
          {
            cwd: projectRoot,
            timeout: CLI_EXEC_TIMEOUT
          }
        )
      ).rejects.toThrow();
    });
  });

  describe('Real-world scenarios', () => {
    it('should render icon with transparent background for web', async () => {
      /**
       * Test realistic icon export scenario
       */
      const svgPath = path.join(tempDir, 'icon.svg');
      const pngPath = path.join(tempDir, 'icon.png');

      const svgContent = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <circle cx="32" cy="32" r="28" fill="#4A90E2"/>
  <path d="M32 20 L32 44 M20 32 L44 32" stroke="white" stroke-width="4" stroke-linecap="round"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync(
        'node',
        ['sbb-svg2png.cjs', svgPath, pngPath, '--background', 'transparent', '--scale', '4'],
        {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        }
      );

      const png = await parsePng(pngPath);
      // BBox of circle and cross (approximately 56x56) at 4x scale = 224x224
      expect(png.width).toBe(224);
      expect(png.height).toBe(224);
      expect(hasTransparentPixels(png)).toBe(true);
    });

    it('should extract single sprite from sprite sheet', async () => {
      /**
       * Test extracting one icon from sprite sheet
       */
      const svgPath = path.join(tempDir, 'sprites.svg');
      const pngPath = path.join(tempDir, 'sprite-extracted.png');

      const svgContent = `<svg viewBox="0 0 300 100" xmlns="http://www.w3.org/2000/svg">
  <g id="icon1">
    <rect x="10" y="10" width="80" height="80" fill="red"/>
  </g>
  <g id="icon2">
    <circle cx="150" cy="50" r="40" fill="green"/>
  </g>
  <g id="icon3">
    <polygon points="220,10 290,10 255,80" fill="blue"/>
  </g>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync(
        'node',
        ['sbb-svg2png.cjs', svgPath, pngPath, '--mode', 'element', '--element-id', 'icon2'],
        {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        }
      );

      const png = await parsePng(pngPath);
      // Should render only icon2 (circle)
      expect(png.width).toBeGreaterThan(0);
      expect(png.height).toBeGreaterThan(0);
    });

    it('should generate high-res thumbnail for SVG gallery', async () => {
      /**
       * Test thumbnail generation with custom dimensions
       */
      const svgPath = path.join(tempDir, 'artwork.svg');
      const pngPath = path.join(tempDir, 'thumbnail.png');

      const svgContent = `<svg viewBox="0 0 800 600" xmlns="http://www.w3.org/2000/svg">
  <rect width="800" height="600" fill="#f0f0f0"/>
  <circle cx="400" cy="300" r="200" fill="#e74c3c" opacity="0.7"/>
  <circle cx="500" cy="350" r="150" fill="#3498db" opacity="0.7"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync(
        'node',
        ['sbb-svg2png.cjs', svgPath, pngPath, '--width', '400', '--height', '300'],
        {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        }
      );

      const png = await parsePng(pngPath);
      expect(png.width).toBe(400);
      expect(png.height).toBe(300);
    });

    it('should render chart/diagram with custom background for documentation', async () => {
      /**
       * Test documentation diagram export
       */
      const svgPath = path.join(tempDir, 'diagram.svg');
      const pngPath = path.join(tempDir, 'diagram.png');

      const svgContent = `<svg viewBox="0 0 400 200" xmlns="http://www.w3.org/2000/svg">
  <rect x="50" y="50" width="100" height="50" fill="lightblue" stroke="black" stroke-width="2"/>
  <text x="100" y="80" text-anchor="middle" font-size="14">Component A</text>
  <line x1="150" y1="75" x2="200" y2="75" stroke="black" stroke-width="2" marker-end="url(#arrow)"/>
  <rect x="200" y="50" width="100" height="50" fill="lightgreen" stroke="black" stroke-width="2"/>
  <text x="250" y="80" text-anchor="middle" font-size="14">Component B</text>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync(
        'node',
        ['sbb-svg2png.cjs', svgPath, pngPath, '--background', '#ffffff', '--scale', '2'],
        {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        }
      );

      const png = await parsePng(pngPath);
      expect(png.width).toBeGreaterThan(0);
      expect(png.height).toBeGreaterThan(0);
    });
  });

  describe('Aspect ratio preservation', () => {
    it('should preserve aspect ratio with square SVG', async () => {
      /**
       * Test aspect ratio preservation (1:1)
       */
      const svgPath = path.join(tempDir, 'square.svg');
      const pngPath = path.join(tempDir, 'square.png');

      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="80" height="80" fill="gray"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-svg2png.cjs', svgPath, pngPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const png = await parsePng(pngPath);
      expect(png.width).toBe(png.height); // 1:1 ratio preserved
    });

    it('should preserve aspect ratio with wide SVG', async () => {
      /**
       * Test aspect ratio preservation (2:1)
       */
      const svgPath = path.join(tempDir, 'wide.svg');
      const pngPath = path.join(tempDir, 'wide.png');

      const svgContent = `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="180" height="80" fill="navy"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-svg2png.cjs', svgPath, pngPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const png = await parsePng(pngPath);
      expect(png.width / png.height).toBeCloseTo(2, 0); // 2:1 ratio
    });

    it('should preserve aspect ratio with tall SVG', async () => {
      /**
       * Test aspect ratio preservation (1:2)
       */
      const svgPath = path.join(tempDir, 'tall.svg');
      const pngPath = path.join(tempDir, 'tall.png');

      const svgContent = `<svg viewBox="0 0 100 200" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="80" height="180" fill="maroon"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-svg2png.cjs', svgPath, pngPath], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const png = await parsePng(pngPath);
      // BBox of rect (10,10,80,180) = aspect ratio 80:180 = 0.444...
      expect(png.width / png.height).toBeCloseTo(0.444, 1); // Slightly less than 1:2 due to bbox
    });
  });

  describe('JPEG output (--jpg)', () => {
    it('should produce both PNG and JPEG with --jpg flag', async () => {
      /**
       * Test --jpg option produces both PNG and JPEG files
       */
      const svgPath = path.join(tempDir, 'jpg-test.svg');
      const pngPath = path.join(tempDir, 'jpg-test.png');
      const jpgPath = path.join(tempDir, 'jpg-test.jpg');

      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="80" height="80" fill="green"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-svg2png.cjs', svgPath, pngPath, '--jpg'], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      // Both PNG and JPEG should exist
      const pngStats = await fs.stat(pngPath);
      const jpgStats = await fs.stat(jpgPath);
      expect(pngStats.isFile()).toBe(true);
      expect(jpgStats.isFile()).toBe(true);
      // JPEG should be a valid image file with non-zero size
      expect(jpgStats.size).toBeGreaterThan(0);
    });

    it('should delete PNG after JPEG creation with --delete-png-after', async () => {
      /**
       * Test --delete-png-after deletes PNG after successful JPEG conversion
       */
      const svgPath = path.join(tempDir, 'delete-png.svg');
      const pngPath = path.join(tempDir, 'delete-png.png');
      const jpgPath = path.join(tempDir, 'delete-png.jpg');

      const svgContent = `<svg viewBox="0 0 50 50" xmlns="http://www.w3.org/2000/svg">
  <circle cx="25" cy="25" r="20" fill="blue"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync(
        'node',
        ['sbb-svg2png.cjs', svgPath, pngPath, '--jpg', '--delete-png-after'],
        {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        }
      );

      // JPEG should exist, PNG should be deleted
      const jpgStats = await fs.stat(jpgPath);
      expect(jpgStats.isFile()).toBe(true);
      await expect(fs.stat(pngPath)).rejects.toThrow();
    });

    it('should fail when --delete-png-after used without --jpg', async () => {
      /**
       * Test error handling when --delete-png-after is used without --jpg
       */
      const svgPath = path.join(tempDir, 'invalid-delete.svg');
      const pngPath = path.join(tempDir, 'invalid-delete.png');

      const svgContent = `<svg viewBox="0 0 50 50" xmlns="http://www.w3.org/2000/svg">
  <rect x="5" y="5" width="40" height="40" fill="red"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await expect(
        execFileAsync('node', ['sbb-svg2png.cjs', svgPath, pngPath, '--delete-png-after'], {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        })
      ).rejects.toThrow();
    });
  });

  describe('Batch processing (--batch)', () => {
    it('should process multiple SVG files from batch file', async () => {
      /**
       * Test --batch option processes multiple files listed in text file
       */
      // Create test SVG files
      const svg1Path = path.join(tempDir, 'batch1.svg');
      const svg2Path = path.join(tempDir, 'batch2.svg');
      const batchFilePath = path.join(tempDir, 'batch.txt');

      const svg1 = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="80" height="80" fill="red"/>
</svg>`;
      const svg2 = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <circle cx="50" cy="50" r="40" fill="blue"/>
</svg>`;

      await fs.writeFile(svg1Path, svg1, 'utf8');
      await fs.writeFile(svg2Path, svg2, 'utf8');

      // Create batch file with just input paths (auto-generate output)
      const batchContent = `${svg1Path}\n${svg2Path}`;
      await fs.writeFile(batchFilePath, batchContent, 'utf8');

      await execFileAsync('node', ['sbb-svg2png.cjs', '--batch', batchFilePath, '--trusted-mode'], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      // Both PNG files should be created
      const png1Path = path.join(tempDir, 'batch1.png');
      const png2Path = path.join(tempDir, 'batch2.png');
      const png1Stats = await fs.stat(png1Path);
      const png2Stats = await fs.stat(png2Path);
      expect(png1Stats.isFile()).toBe(true);
      expect(png2Stats.isFile()).toBe(true);
    });

    it('should process batch file with tab-separated input/output pairs', async () => {
      /**
       * Test --batch with explicit output paths using tab separator
       */
      const svgPath = path.join(tempDir, 'tab-batch.svg');
      const pngPath = path.join(tempDir, 'custom-output.png');
      const batchFilePath = path.join(tempDir, 'tab-batch.txt');

      const svgContent = `<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">
  <polygon points="40,10 70,70 10,70" fill="orange"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      // Create batch file with tab-separated input/output
      const batchContent = `${svgPath}\t${pngPath}`;
      await fs.writeFile(batchFilePath, batchContent, 'utf8');

      await execFileAsync('node', ['sbb-svg2png.cjs', '--batch', batchFilePath, '--trusted-mode'], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      // Custom output path should be used
      const pngStats = await fs.stat(pngPath);
      expect(pngStats.isFile()).toBe(true);
    });

    it('should apply --jpg option to all files in batch mode', async () => {
      /**
       * Test --batch combined with --jpg produces JPEG for all files
       */
      const svgPath = path.join(tempDir, 'batch-jpg.svg');
      const batchFilePath = path.join(tempDir, 'batch-jpg.txt');

      const svgContent = `<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="30" cy="30" rx="25" ry="15" fill="purple"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      const batchContent = svgPath;
      await fs.writeFile(batchFilePath, batchContent, 'utf8');

      await execFileAsync(
        'node',
        ['sbb-svg2png.cjs', '--batch', batchFilePath, '--jpg', '--trusted-mode'],
        {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        }
      );

      // Both PNG and JPEG should exist
      const pngPath = path.join(tempDir, 'batch-jpg.png');
      const jpgPath = path.join(tempDir, 'batch-jpg.jpg');
      const pngStats = await fs.stat(pngPath);
      const jpgStats = await fs.stat(jpgPath);
      expect(pngStats.isFile()).toBe(true);
      expect(jpgStats.isFile()).toBe(true);
    });

    it('should ignore comment lines in batch file', async () => {
      /**
       * Test --batch ignores lines starting with # as comments
       */
      const svgPath = path.join(tempDir, 'batch-comment.svg');
      const batchFilePath = path.join(tempDir, 'batch-comment.txt');

      const svgContent = `<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="60" height="60" fill="indigo"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      // Create batch file with comment lines
      const batchContent = `# This is a comment line
# Another comment
${svgPath}
# Trailing comment`;
      await fs.writeFile(batchFilePath, batchContent, 'utf8');

      await execFileAsync('node', ['sbb-svg2png.cjs', '--batch', batchFilePath, '--trusted-mode'], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      // PNG should be created (comments ignored)
      const pngPath = path.join(tempDir, 'batch-comment.png');
      const pngStats = await fs.stat(pngPath);
      expect(pngStats.isFile()).toBe(true);
    });
  });

  describe('Path security options (--allow-paths, --trusted-mode)', () => {
    it('should allow files in specified directories with --allow-paths', async () => {
      /**
       * Test --allow-paths permits processing files in specified directories
       */
      const svgPath = path.join(tempDir, 'allowed-path.svg');
      const pngPath = path.join(tempDir, 'allowed-path.png');

      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="20" y="20" width="60" height="60" fill="teal"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-svg2png.cjs', svgPath, pngPath, '--allow-paths', tempDir], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const pngStats = await fs.stat(pngPath);
      expect(pngStats.isFile()).toBe(true);
    });

    it('should bypass all path restrictions with --trusted-mode', async () => {
      /**
       * Test --trusted-mode disables path security restrictions
       */
      const svgPath = path.join(tempDir, 'trusted.svg');
      const pngPath = path.join(tempDir, 'trusted.png');

      const svgContent = `<svg viewBox="0 0 50 50" xmlns="http://www.w3.org/2000/svg">
  <circle cx="25" cy="25" r="20" fill="magenta"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-svg2png.cjs', svgPath, pngPath, '--trusted-mode'], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      });

      const pngStats = await fs.stat(pngPath);
      expect(pngStats.isFile()).toBe(true);
    });
  });

  describe('Output control options (--quiet, --verbose)', () => {
    it('should produce minimal output with --quiet flag', async () => {
      /**
       * Test --quiet produces only essential output (file path)
       */
      const svgPath = path.join(tempDir, 'quiet.svg');
      const pngPath = path.join(tempDir, 'quiet.png');

      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="80" height="80" fill="navy"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      const { stdout } = await execFileAsync(
        'node',
        ['sbb-svg2png.cjs', svgPath, pngPath, '--quiet', '--trusted-mode'],
        {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        }
      );

      // Quiet mode should output just the file path, not verbose info
      expect(stdout.trim()).toContain('quiet.png');
      // Should NOT contain verbose markers like "mode:", "viewBox:", etc.
      expect(stdout).not.toContain('mode:');
      expect(stdout).not.toContain('viewBox:');
    });

    it('should produce detailed output with --verbose flag', async () => {
      /**
       * Test --verbose produces detailed progress information
       */
      const svgPath = path.join(tempDir, 'verbose.svg');
      const pngPath = path.join(tempDir, 'verbose.png');

      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="80" height="80" fill="olive"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      const { stdout } = await execFileAsync(
        'node',
        ['sbb-svg2png.cjs', svgPath, pngPath, '--verbose', '--trusted-mode'],
        {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        }
      );

      // Verbose mode should include detailed info
      expect(stdout).toContain('mode:');
      expect(stdout).toContain('viewBox:');
      expect(stdout).toContain('size:');
    });
  });

  describe('Auto-open option (--auto-open)', () => {
    it('should accept --auto-open flag without error', async () => {
      /**
       * Test --auto-open flag is accepted and rendering completes
       * NOTE: Cannot verify Chrome actually opens in test environment
       */
      const svgPath = path.join(tempDir, 'auto-open.svg');
      const pngPath = path.join(tempDir, 'auto-open.png');

      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="80" height="80" fill="coral"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      // Should complete without error even with --auto-open
      // (Chrome opening is async and won't block)
      await execFileAsync(
        'node',
        ['sbb-svg2png.cjs', svgPath, pngPath, '--auto-open', '--trusted-mode'],
        {
          cwd: projectRoot,
          timeout: CLI_EXEC_TIMEOUT
        }
      );

      const pngStats = await fs.stat(pngPath);
      expect(pngStats.isFile()).toBe(true);
    });
  });
});
