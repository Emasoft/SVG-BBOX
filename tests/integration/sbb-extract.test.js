/**
 * @file Integration tests for sbb-extract CLI tool
 * @description Comprehensive tests for SVG object extraction/manipulation including:
 *   - List mode (--list) - catalog all objects
 *   - Rename mode (--rename) - apply ID renaming from JSON mapping
 *   - Extract mode (--extract) - extract specific elements by ID
 *   - Export all mode (--export-all) - export each object to separate file
 *   - Various SVG element types (rect, circle, path, text, groups, etc.)
 *   - Nested groups and transforms
 *   - Edge cases (non-existent IDs, invalid SVG, empty SVG)
 *   - Error handling
 *   - Real-world scenarios (sprite sheets, icon extraction)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

/**
 * Helper to parse SVG and extract attributes
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

/**
 * Helper to count elements in SVG
 */
async function countSvgElements(svgPath, selector) {
  const content = await fs.readFile(svgPath, 'utf8');
  const dom = new JSDOM(content, { contentType: 'image/svg+xml' });
  return dom.window.document.querySelectorAll(selector).length;
}

/**
 * Helper to check if element exists in SVG
 */
async function elementExists(svgPath, selector) {
  const content = await fs.readFile(svgPath, 'utf8');
  const dom = new JSDOM(content, { contentType: 'image/svg+xml' });
  return dom.window.document.querySelector(selector) !== null;
}

describe('sbb-extract CLI Integration Tests', () => {
  let tempDir;

  beforeEach(async () => {
    // Create temporary directory for test files
    tempDir = path.join(projectRoot, `temp_sbb_extract_test_${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup temporary directory
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('MODE 1: List Objects (--list)', () => {
    it('should list objects in simple SVG', async () => {
      /**
       * Test list mode with basic SVG containing multiple objects
       */
      const svgPath = path.join(tempDir, 'simple.svg');
      const htmlPath = path.join(tempDir, 'simple-list.html');
      const svgContent = `<svg viewBox="0 0 200 200" width="200" height="200" xmlns="http://www.w3.org/2000/svg">
  <rect id="rect1" x="10" y="10" width="80" height="80" fill="blue"/>
  <circle id="circle1" cx="150" cy="150" r="40" fill="red"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      const { stdout } = await execFileAsync(
        'node',
        ['sbb-extract.cjs', svgPath, '--list', '--out-html', htmlPath],
        {
          cwd: projectRoot,
          timeout: 60000
        }
      );

      expect(stdout).toContain('Objects found: 2');

      // Check HTML contains object IDs
      const htmlContent = await fs.readFile(htmlPath, 'utf8');
      expect(htmlContent).toContain('rect1');
      expect(htmlContent).toContain('circle1');
    });

    it('should generate HTML output with --list --out-html', async () => {
      /**
       * Test HTML generation in list mode
       */
      const svgPath = path.join(tempDir, 'for-html.svg');
      const htmlPath = path.join(tempDir, 'list.html');
      const svgContent = `<svg viewBox="0 0 100 100" width="100" height="100" xmlns="http://www.w3.org/2000/svg">
  <rect id="box" x="10" y="10" width="80" height="80" fill="green"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-extract.cjs', svgPath, '--list', '--out-html', htmlPath], {
        cwd: projectRoot,
        timeout: 60000
      });

      // HTML file should exist
      const htmlContent = await fs.readFile(htmlPath, 'utf8');
      expect(htmlContent).toContain('<!DOCTYPE html>');
      expect(htmlContent).toContain('box'); // Object ID in table
    });

    it('should assign IDs with --assign-ids flag', async () => {
      /**
       * Test automatic ID assignment for elements without IDs
       */
      const svgPath = path.join(tempDir, 'no-ids.svg');
      const fixedPath = path.join(tempDir, 'fixed.svg');
      const svgContent = `<svg viewBox="0 0 150 150" width="150" height="150" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="60" height="60" fill="blue"/>
  <circle cx="100" cy="100" r="30" fill="red"/>
  <path d="M 20 120 L 80 120 L 50 80 Z" fill="green"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync(
        'node',
        ['sbb-extract.cjs', svgPath, '--list', '--assign-ids', '--out-fixed', fixedPath],
        {
          cwd: projectRoot,
          timeout: 60000
        }
      );

      // Fixed SVG should exist with auto-assigned IDs
      const fixedContent = await fs.readFile(fixedPath, 'utf8');
      expect(fixedContent).toContain('id="auto_id_');
    });

    it('should output JSON with --json flag', async () => {
      /**
       * Test JSON output format in list mode
       */
      const svgPath = path.join(tempDir, 'json-test.svg');
      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect id="r1" x="10" y="10" width="80" height="80" fill="blue"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      const { stdout } = await execFileAsync(
        'node',
        ['sbb-extract.cjs', svgPath, '--list', '--json'],
        {
          cwd: projectRoot,
          timeout: 60000
        }
      );

      // Extract JSON from output (may have info messages before JSON)
      const jsonMatch = stdout.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      expect(jsonMatch).toBeTruthy();

      const json = JSON.parse(jsonMatch[0]);
      expect(json).toHaveProperty('objects');
      expect(Array.isArray(json.objects)).toBe(true);
    });

    it('should detect sprite sheet patterns', async () => {
      /**
       * Test sprite sheet detection with multiple uniform objects
       */
      const svgPath = path.join(tempDir, 'sprites.svg');
      const svgContent = `<svg viewBox="0 0 300 200" width="300" height="200" xmlns="http://www.w3.org/2000/svg">
  <rect id="icon_1" x="10" y="10" width="40" height="40" fill="blue"/>
  <rect id="icon_2" x="60" y="10" width="40" height="40" fill="red"/>
  <rect id="icon_3" x="110" y="10" width="40" height="40" fill="green"/>
  <rect id="sprite_4" x="10" y="60" width="40" height="40" fill="yellow"/>
  <rect id="sprite_5" x="60" y="60" width="40" height="40" fill="purple"/>
  <rect id="sprite_6" x="110" y="60" width="40" height="40" fill="orange"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      const { stdout } = await execFileAsync('node', ['sbb-extract.cjs', svgPath, '--list'], {
        cwd: projectRoot,
        timeout: 60000
      });

      // Should detect sprite sheet pattern
      expect(stdout).toMatch(/sprite.*sheet/i);
    });
  });

  describe('MODE 2: Rename IDs (--rename)', () => {
    it('should rename IDs from JSON mapping (object format)', async () => {
      /**
       * Test ID renaming with object-style mapping
       */
      const svgPath = path.join(tempDir, 'rename-source.svg');
      const outputPath = path.join(tempDir, 'renamed.svg');
      const mappingPath = path.join(tempDir, 'mapping.json');

      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect id="oldId" x="10" y="10" width="80" height="80" fill="blue"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      // Object-style mapping
      const mapping = { oldId: 'newId' };
      await fs.writeFile(mappingPath, JSON.stringify(mapping), 'utf8');

      await execFileAsync(
        'node',
        ['sbb-extract.cjs', svgPath, '--rename', mappingPath, outputPath],
        {
          cwd: projectRoot,
          timeout: 60000
        }
      );

      const outputContent = await fs.readFile(outputPath, 'utf8');
      expect(outputContent).toContain('id="newId"');
      expect(outputContent).not.toContain('id="oldId"');
    });

    it('should rename IDs from JSON mapping (array format)', async () => {
      /**
       * Test ID renaming with array-style mapping
       */
      const svgPath = path.join(tempDir, 'rename-array.svg');
      const outputPath = path.join(tempDir, 'renamed-array.svg');
      const mappingPath = path.join(tempDir, 'mapping-array.json');

      const svgContent = `<svg viewBox="0 0 150 150" xmlns="http://www.w3.org/2000/svg">
  <rect id="rect1" x="10" y="10" width="40" height="40" fill="blue"/>
  <circle id="circle1" cx="100" cy="100" r="30" fill="red"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      // Array-style mapping
      const mapping = [
        { from: 'rect1', to: 'box' },
        { from: 'circle1', to: 'ball' }
      ];
      await fs.writeFile(mappingPath, JSON.stringify(mapping), 'utf8');

      await execFileAsync(
        'node',
        ['sbb-extract.cjs', svgPath, '--rename', mappingPath, outputPath],
        {
          cwd: projectRoot,
          timeout: 60000
        }
      );

      const outputContent = await fs.readFile(outputPath, 'utf8');
      expect(outputContent).toContain('id="box"');
      expect(outputContent).toContain('id="ball"');
    });

    it('should update references when renaming IDs', async () => {
      /**
       * Test that references (href, url(#id)) are updated during rename
       */
      const svgPath = path.join(tempDir, 'with-refs.svg');
      const outputPath = path.join(tempDir, 'renamed-refs.svg');
      const mappingPath = path.join(tempDir, 'map.json');

      const svgContent = `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="grad1">
      <stop offset="0%" stop-color="blue"/>
      <stop offset="100%" stop-color="red"/>
    </linearGradient>
  </defs>
  <rect x="10" y="10" width="180" height="180" fill="url(#grad1)"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      const mapping = { grad1: 'gradient_main' };
      await fs.writeFile(mappingPath, JSON.stringify(mapping), 'utf8');

      await execFileAsync(
        'node',
        ['sbb-extract.cjs', svgPath, '--rename', mappingPath, outputPath],
        {
          cwd: projectRoot,
          timeout: 60000
        }
      );

      const outputContent = await fs.readFile(outputPath, 'utf8');
      expect(outputContent).toContain('id="gradient_main"');
      expect(outputContent).toContain('url(#gradient_main)');
    });

    it('should skip invalid ID mappings', async () => {
      /**
       * Test that invalid ID syntax is rejected
       */
      const svgPath = path.join(tempDir, 'invalid-rename.svg');
      const outputPath = path.join(tempDir, 'invalid-output.svg');
      const mappingPath = path.join(tempDir, 'invalid-map.json');

      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect id="valid" x="10" y="10" width="80" height="80" fill="blue"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      // Invalid ID (starts with number)
      const mapping = { valid: '123invalid' };
      await fs.writeFile(mappingPath, JSON.stringify(mapping), 'utf8');

      // Should fail with validation error
      await expect(
        execFileAsync('node', ['sbb-extract.cjs', svgPath, '--rename', mappingPath, outputPath], {
          cwd: projectRoot,
          timeout: 60000
        })
      ).rejects.toThrow(/Invalid ID format/);
    });
  });

  describe('MODE 3: Extract Object (--extract)', () => {
    it('should extract single object by ID (pure cut-out)', async () => {
      /**
       * Test extracting single object without siblings
       */
      const svgPath = path.join(tempDir, 'extract-source.svg');
      const outputPath = path.join(tempDir, 'extracted.svg');

      const svgContent = `<svg viewBox="0 0 200 200" width="200" height="200" xmlns="http://www.w3.org/2000/svg">
  <rect id="target" x="50" y="50" width="100" height="100" fill="blue"/>
  <circle id="other" cx="30" cy="30" r="20" fill="red"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-extract.cjs', svgPath, '--extract', 'target', outputPath], {
        cwd: projectRoot,
        timeout: 60000
      });

      // Should contain target but not other element
      const exists = await elementExists(outputPath, '#target');
      expect(exists).toBe(true);

      const otherExists = await elementExists(outputPath, '#other');
      expect(otherExists).toBe(false);
    });

    it('should extract with margin (--margin)', async () => {
      /**
       * Test extraction with added margin around object
       */
      const svgPath = path.join(tempDir, 'margin-test.svg');
      const outputPath = path.join(tempDir, 'with-margin.svg');

      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect id="box" x="40" y="40" width="20" height="20" fill="green"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync(
        'node',
        ['sbb-extract.cjs', svgPath, '--extract', 'box', outputPath, '--margin', '10'],
        {
          cwd: projectRoot,
          timeout: 60000
        }
      );

      const attrs = await parseSvgAttributes(outputPath);
      expect(attrs.viewBox).toBeTruthy();
      // ViewBox should be expanded by margin (40-10, 40-10, 20+20, 20+20) = (30, 30, 40, 40)
      expect(attrs.viewBox).toMatch(/30\s+30\s+40\s+40/);
    });

    it('should extract with context (--include-context)', async () => {
      /**
       * Test extraction preserving all objects with cropped viewBox
       */
      const svgPath = path.join(tempDir, 'context-test.svg');
      const outputPath = path.join(tempDir, 'with-context.svg');

      const svgContent = `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <rect id="target" x="50" y="50" width="80" height="80" fill="blue"/>
  <rect id="background" x="0" y="0" width="200" height="200" fill="gray" opacity="0.2"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync(
        'node',
        ['sbb-extract.cjs', svgPath, '--extract', 'target', outputPath, '--include-context'],
        {
          cwd: projectRoot,
          timeout: 60000
        }
      );

      // Should contain both elements
      const targetExists = await elementExists(outputPath, '#target');
      expect(targetExists).toBe(true);

      const bgExists = await elementExists(outputPath, '#background');
      expect(bgExists).toBe(true);
    });

    it('should fail gracefully for non-existent ID', async () => {
      /**
       * Test error handling for extracting non-existent object
       */
      const svgPath = path.join(tempDir, 'no-such-id.svg');
      const outputPath = path.join(tempDir, 'wont-exist.svg');

      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect id="exists" x="10" y="10" width="80" height="80" fill="blue"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await expect(
        execFileAsync(
          'node',
          ['sbb-extract.cjs', svgPath, '--extract', 'doesNotExist', outputPath],
          {
            cwd: projectRoot,
            timeout: 60000
          }
        )
      ).rejects.toThrow();
    });

    it('should preserve transforms when extracting nested object', async () => {
      /**
       * Test that ancestor transforms are preserved during extraction
       */
      const svgPath = path.join(tempDir, 'nested-transform.svg');
      const outputPath = path.join(tempDir, 'extracted-transform.svg');

      const svgContent = `<svg viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(100,100)">
    <g transform="scale(2)">
      <rect id="inner" x="10" y="10" width="20" height="20" fill="purple"/>
    </g>
  </g>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-extract.cjs', svgPath, '--extract', 'inner', outputPath], {
        cwd: projectRoot,
        timeout: 60000
      });

      const { content } = await parseSvgAttributes(outputPath);
      // Should preserve transform attributes
      expect(content).toContain('transform');
    });
  });

  describe('MODE 4: Export All Objects (--export-all)', () => {
    it('should export all objects to separate files', async () => {
      /**
       * Test exporting each object as separate SVG file
       */
      const svgPath = path.join(tempDir, 'export-all.svg');
      const outDir = path.join(tempDir, 'exported');

      const svgContent = `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <rect id="box1" x="10" y="10" width="40" height="40" fill="blue"/>
  <circle id="ball1" cx="150" cy="150" r="30" fill="red"/>
  <path id="triangle1" d="M 50 150 L 100 150 L 75 100 Z" fill="green"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-extract.cjs', svgPath, '--export-all', outDir], {
        cwd: projectRoot,
        timeout: 60000
      });

      // Should create output directory
      const files = await fs.readdir(outDir);
      expect(files.length).toBeGreaterThan(0);

      // Should have files for each object
      const hasBox = files.some((f) => f.includes('box1'));
      const hasBall = files.some((f) => f.includes('ball1'));
      const hasTriangle = files.some((f) => f.includes('triangle1'));

      expect(hasBox).toBe(true);
      expect(hasBall).toBe(true);
      expect(hasTriangle).toBe(true);
    });

    it('should export with margin (--margin)', async () => {
      /**
       * Test export-all with margin applied to all objects
       */
      const svgPath = path.join(tempDir, 'export-margin.svg');
      const outDir = path.join(tempDir, 'exported-margin');

      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect id="r1" x="30" y="30" width="10" height="10" fill="blue"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync(
        'node',
        ['sbb-extract.cjs', svgPath, '--export-all', outDir, '--margin', '5'],
        {
          cwd: projectRoot,
          timeout: 60000
        }
      );

      const files = await fs.readdir(outDir);
      expect(files.length).toBeGreaterThan(0);

      // Check first exported file has expanded viewBox
      const exportedPath = path.join(outDir, files[0]);
      const attrs = await parseSvgAttributes(exportedPath);
      // ViewBox should include margin: (30-5, 30-5, 10+10, 10+10) = (25, 25, 20, 20)
      expect(attrs.viewBox).toMatch(/25\s+25\s+20\s+20/);
    });

    it('should export groups with --export-groups', async () => {
      /**
       * Test that groups are also exported when flag is set
       */
      const svgPath = path.join(tempDir, 'with-groups.svg');
      const outDir = path.join(tempDir, 'exported-groups');

      const svgContent = `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <g id="group1">
    <rect id="r1" x="10" y="10" width="30" height="30" fill="blue"/>
    <rect id="r2" x="50" y="10" width="30" height="30" fill="red"/>
  </g>
  <circle id="c1" cx="150" cy="150" r="30" fill="green"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync(
        'node',
        ['sbb-extract.cjs', svgPath, '--export-all', outDir, '--export-groups'],
        {
          cwd: projectRoot,
          timeout: 60000
        }
      );

      const files = await fs.readdir(outDir);
      // Should have files for individual objects AND group
      const hasGroup = files.some((f) => f.includes('group1'));
      expect(hasGroup).toBe(true);
    });

    it('should export sprite sheet objects', async () => {
      /**
       * Test export-all on sprite sheet (real-world use case)
       */
      const svgPath = path.join(tempDir, 'sprite-sheet.svg');
      const outDir = path.join(tempDir, 'sprites');

      const svgContent = `<svg viewBox="0 0 300 100" xmlns="http://www.w3.org/2000/svg">
  <rect id="icon_save" x="10" y="10" width="80" height="80" fill="blue"/>
  <rect id="icon_delete" x="110" y="10" width="80" height="80" fill="red"/>
  <rect id="icon_edit" x="210" y="10" width="80" height="80" fill="green"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-extract.cjs', svgPath, '--export-all', outDir], {
        cwd: projectRoot,
        timeout: 60000
      });

      const files = await fs.readdir(outDir);
      expect(files.length).toBe(3); // 3 sprites

      // Each sprite should have its own file
      expect(files.some((f) => f.includes('icon_save'))).toBe(true);
      expect(files.some((f) => f.includes('icon_delete'))).toBe(true);
      expect(files.some((f) => f.includes('icon_edit'))).toBe(true);
    });

    it('should output JSON with --json flag', async () => {
      /**
       * Test JSON output in export-all mode
       */
      const svgPath = path.join(tempDir, 'export-json.svg');
      const outDir = path.join(tempDir, 'exported-json');

      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect id="b1" x="10" y="10" width="30" height="30" fill="blue"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      const { stdout } = await execFileAsync(
        'node',
        ['sbb-extract.cjs', svgPath, '--export-all', outDir, '--json'],
        {
          cwd: projectRoot,
          timeout: 60000
        }
      );

      // Extract JSON from output (may have info messages before JSON)
      const jsonMatch = stdout.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      expect(jsonMatch).toBeTruthy();

      const json = JSON.parse(jsonMatch[0]);
      expect(json).toHaveProperty('exported');
      expect(Array.isArray(json.exported)).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty SVG', async () => {
      /**
       * Test graceful handling of empty SVG
       */
      const svgPath = path.join(tempDir, 'empty.svg');
      const svgContent = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"></svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      const { stdout } = await execFileAsync('node', ['sbb-extract.cjs', svgPath, '--list'], {
        cwd: projectRoot,
        timeout: 60000
      });

      // Should not crash, may report no objects
      expect(stdout).toBeTruthy();
    });

    it('should handle invalid SVG gracefully', async () => {
      /**
       * Test error handling for malformed SVG
       */
      const invalidPath = path.join(tempDir, 'invalid.svg');
      await fs.writeFile(invalidPath, 'not valid svg content', 'utf8');

      await expect(
        execFileAsync('node', ['sbb-extract.cjs', invalidPath, '--list'], {
          cwd: projectRoot,
          timeout: 60000
        })
      ).rejects.toThrow();
    });

    it('should handle non-existent input file', async () => {
      /**
       * Test error handling for missing input file
       */
      const nonExistentPath = path.join(tempDir, 'does-not-exist.svg');

      await expect(
        execFileAsync('node', ['sbb-extract.cjs', nonExistentPath, '--list'], {
          cwd: projectRoot,
          timeout: 60000
        })
      ).rejects.toThrow();
    });

    it('should handle complex nested groups', async () => {
      /**
       * Test extraction from deeply nested structure
       */
      const svgPath = path.join(tempDir, 'complex-nested.svg');
      const outputPath = path.join(tempDir, 'extracted-nested.svg');

      const svgContent = `<svg viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg">
  <g id="level1" transform="translate(50,50)">
    <g id="level2" transform="scale(2)">
      <g id="level3" transform="rotate(45)">
        <rect id="deep" x="10" y="10" width="20" height="20" fill="teal"/>
      </g>
    </g>
  </g>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-extract.cjs', svgPath, '--extract', 'deep', outputPath], {
        cwd: projectRoot,
        timeout: 60000
      });

      // Should successfully extract with all ancestor transforms
      const exists = await elementExists(outputPath, '#deep');
      expect(exists).toBe(true);
    });

    it('should handle SVG with text elements', async () => {
      /**
       * Test export with text elements (font rendering)
       */
      const svgPath = path.join(tempDir, 'with-text.svg');
      const outDir = path.join(tempDir, 'exported-text');

      const svgContent = `<svg viewBox="0 0 300 100" xmlns="http://www.w3.org/2000/svg">
  <text id="label1" x="10" y="50" font-size="24" font-family="Arial">Hello</text>
  <text id="label2" x="150" y="50" font-size="24" font-family="Arial">World</text>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-extract.cjs', svgPath, '--export-all', outDir], {
        cwd: projectRoot,
        timeout: 60000
      });

      const files = await fs.readdir(outDir);
      expect(files.length).toBeGreaterThan(0);
    });

    it('should handle SVG with defs and filters', async () => {
      /**
       * Test that defs (filters, gradients) are preserved during extraction
       */
      const svgPath = path.join(tempDir, 'with-defs.svg');
      const outputPath = path.join(tempDir, 'extracted-defs.svg');

      const svgContent = `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="blur">
      <feGaussianBlur in="SourceGraphic" stdDeviation="5"/>
    </filter>
  </defs>
  <rect id="blurred" x="50" y="50" width="100" height="100" fill="blue" filter="url(#blur)"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync(
        'node',
        ['sbb-extract.cjs', svgPath, '--extract', 'blurred', outputPath],
        {
          cwd: projectRoot,
          timeout: 60000
        }
      );

      const { content } = await parseSvgAttributes(outputPath);
      // Should preserve filter definition
      expect(content).toContain('id="blur"');
      expect(content).toContain('feGaussianBlur');
    });

    it('should handle SVG with use elements', async () => {
      /**
       * Test extraction of <use> elements that reference other objects
       */
      const svgPath = path.join(tempDir, 'with-use.svg');
      const outputPath = path.join(tempDir, 'extracted-use.svg');

      const svgContent = `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <rect id="template" x="0" y="0" width="30" height="30" fill="blue"/>
  </defs>
  <use id="instance1" href="#template" x="50" y="50"/>
  <use id="instance2" href="#template" x="100" y="100"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync(
        'node',
        ['sbb-extract.cjs', svgPath, '--extract', 'instance1', outputPath],
        {
          cwd: projectRoot,
          timeout: 60000
        }
      );

      const { content } = await parseSvgAttributes(outputPath);
      // Should preserve referenced template
      expect(content).toContain('id="template"');
      expect(content).toContain('id="instance1"');
    });

    it('should handle various element types', async () => {
      /**
       * Test list mode with diverse SVG element types
       */
      const svgPath = path.join(tempDir, 'various-types.svg');
      const htmlPath = path.join(tempDir, 'various-types.html');
      const svgContent = `<svg viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg">
  <rect id="r" x="10" y="10" width="50" height="50" fill="blue"/>
  <circle id="c" cx="100" cy="100" r="30" fill="red"/>
  <ellipse id="e" cx="200" cy="200" rx="40" ry="20" fill="green"/>
  <polygon id="p" points="300,10 350,50 300,90 250,50" fill="purple"/>
  <polyline id="pl" points="10,200 50,250 90,220" stroke="orange" fill="none"/>
  <path id="path" d="M 10 300 Q 50 350, 90 300" fill="none" stroke="teal"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync('node', ['sbb-extract.cjs', svgPath, '--list', '--out-html', htmlPath], {
        cwd: projectRoot,
        timeout: 60000
      });

      // Check HTML contains all element types
      const htmlContent = await fs.readFile(htmlPath, 'utf8');
      expect(htmlContent).toContain('rect');
      expect(htmlContent).toContain('circle');
      expect(htmlContent).toContain('ellipse');
      expect(htmlContent).toContain('polygon');
      expect(htmlContent).toContain('polyline');
      expect(htmlContent).toContain('path');
    });
  });

  describe('Real-World Scenarios', () => {
    it('should extract logo from complex design', async () => {
      /**
       * Test extracting specific element from multi-element design
       */
      const svgPath = path.join(tempDir, 'design.svg');
      const outputPath = path.join(tempDir, 'logo-only.svg');

      const svgContent = `<svg viewBox="0 0 500 300" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="500" height="300" fill="#f5f5f5"/>
  <g id="header">
    <rect x="10" y="10" width="480" height="60" fill="white"/>
    <g id="logo" transform="translate(20,20)">
      <rect x="0" y="0" width="40" height="40" fill="#007bff"/>
      <text x="45" y="30" font-size="24">Brand</text>
    </g>
  </g>
  <rect x="10" y="80" width="480" height="200" fill="white"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      await execFileAsync(
        'node',
        ['sbb-extract.cjs', svgPath, '--extract', 'logo', outputPath, '--margin', '5'],
        {
          cwd: projectRoot,
          timeout: 60000
        }
      );

      const logoExists = await elementExists(outputPath, '#logo');
      expect(logoExists).toBe(true);

      // Should NOT contain page background
      const bgCount = await countSvgElements(outputPath, 'rect[width="500"]');
      expect(bgCount).toBe(0);
    });

    it('should convert icon set to individual files', async () => {
      /**
       * Test realistic icon extraction workflow
       */
      const svgPath = path.join(tempDir, 'iconset.svg');
      const outDir = path.join(tempDir, 'icons');

      const svgContent = `<svg viewBox="0 0 600 200" xmlns="http://www.w3.org/2000/svg">
  <g id="icon_home">
    <path id="home_path" d="M 10 100 L 50 60 L 90 100 L 90 140 L 10 140 Z" fill="#333"/>
  </g>
  <g id="icon_search">
    <circle id="search_circle" cx="140" cy="100" r="30" fill="none" stroke="#333" stroke-width="3"/>
    <line id="search_line" x1="165" y1="125" x2="185" y2="145" stroke="#333" stroke-width="3"/>
  </g>
  <g id="icon_settings">
    <circle id="settings_outer" cx="250" cy="100" r="20" fill="none" stroke="#333" stroke-width="3"/>
    <circle id="settings_inner" cx="250" cy="100" r="10" fill="#333"/>
  </g>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      // Export with --export-groups to include group elements
      await execFileAsync(
        'node',
        ['sbb-extract.cjs', svgPath, '--export-all', outDir, '--margin', '2', '--export-groups'],
        {
          cwd: projectRoot,
          timeout: 60000
        }
      );

      const files = await fs.readdir(outDir);
      expect(files.length).toBeGreaterThan(0);

      // Verify group files exist (when using --export-groups)
      const hasHome = files.some((f) => f.includes('icon_home'));
      const hasSearch = files.some((f) => f.includes('icon_search'));
      const hasSettings = files.some((f) => f.includes('icon_settings'));

      expect(hasHome).toBe(true);
      expect(hasSearch).toBe(true);
      expect(hasSettings).toBe(true);
    });

    it('should handle ID renaming workflow (list → rename)', async () => {
      /**
       * Test complete workflow: list with auto-IDs, then rename
       */
      const svgPath = path.join(tempDir, 'workflow.svg');
      const fixedPath = path.join(tempDir, 'with-ids.svg');
      const renamedPath = path.join(tempDir, 'renamed.svg');
      const mappingPath = path.join(tempDir, 'id-map.json');

      // Step 1: SVG without IDs
      const svgContent = `<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="10" width="80" height="80" fill="blue"/>
  <circle cx="150" cy="50" r="40" fill="red"/>
</svg>`;
      await fs.writeFile(svgPath, svgContent, 'utf8');

      // Step 2: List with auto-assigned IDs
      await execFileAsync(
        'node',
        ['sbb-extract.cjs', svgPath, '--list', '--assign-ids', '--out-fixed', fixedPath],
        {
          cwd: projectRoot,
          timeout: 60000
        }
      );

      // Read the fixed SVG to find the actual auto-assigned IDs
      const fixedContent = await fs.readFile(fixedPath, 'utf8');
      const rectIdMatch = fixedContent.match(/rect.*?id="(auto_id_[^"]+)"/);
      const circleIdMatch = fixedContent.match(/circle.*?id="(auto_id_[^"]+)"/);

      expect(rectIdMatch).toBeTruthy();
      expect(circleIdMatch).toBeTruthy();

      const rectId = rectIdMatch[1];
      const circleId = circleIdMatch[1];

      // Step 3: Rename auto-assigned IDs to meaningful names
      const mapping = {};
      mapping[rectId] = 'blue_box';
      mapping[circleId] = 'red_ball';
      await fs.writeFile(mappingPath, JSON.stringify(mapping), 'utf8');

      await execFileAsync(
        'node',
        ['sbb-extract.cjs', fixedPath, '--rename', mappingPath, renamedPath],
        {
          cwd: projectRoot,
          timeout: 60000
        }
      );

      const finalContent = await fs.readFile(renamedPath, 'utf8');
      expect(finalContent).toContain('id="blue_box"');
      expect(finalContent).toContain('id="red_ball"');
    });
  });
});
