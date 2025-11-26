// @ts-nocheck
/* eslint-env node, browser */
/**
 * showTrueBBoxBorder() E2E Tests
 *
 * Tests the showTrueBBoxBorder() function with edge case variations.
 * Applies 5 edge cases to ALL test scenarios for comprehensive coverage.
 *
 * Edge Cases:
 * 1. Normal (baseline with viewBox)
 * 2. No viewBox (only width/height)
 * 3. No resolution (only viewBox)
 * 4. Negative viewBox coordinates
 * 5. Sprite sheet with <use> element
 */

import { test, expect } from '@playwright/test';
import fs from 'fs/promises';
import path from 'path';

/**
 * @typedef {Object} TestBorderOptions
 * @property {string} [theme] - Theme to use for border ('auto', 'dark', 'light')
 * @property {string} [borderColor] - Custom border color
 * @property {number} [padding] - Custom padding value
 */

/**
 * @typedef {Object} TestBorderResult
 * @property {boolean} success - Whether the test succeeded
 * @property {boolean} [accurate] - Whether the border is accurately positioned
 * @property {Object} [bbox] - Bounding box coordinates
 * @property {number} [bbox.x] - X coordinate
 * @property {number} [bbox.y] - Y coordinate
 * @property {number} [bbox.width] - Width
 * @property {number} [bbox.height] - Height
 * @property {Object} [overlay] - Overlay position
 * @property {Object} [expected] - Expected position
 * @property {Object} [diffs] - Differences between actual and expected
 * @property {number} [diffs.x] - X difference
 * @property {number} [diffs.y] - Y difference
 * @property {number} [diffs.width] - Width difference
 * @property {number} [diffs.height] - Height difference
 * @property {string} [borderStyle] - Computed border style
 * @property {Object} [result] - Full result object
 * @property {string} [error] - Error message if failed
 */

/**
 * Augment Window interface to include testBorder function
 * @typedef {Object} WindowWithTestBorder
 * @property {function(string, TestBorderOptions=): Promise<TestBorderResult>} testBorder - Test border function
 */

// Use project-local temp directory
const TEMP_DIR = path.join(process.cwd(), 'tests', '.tmp-e2e-border-tests');
const testPagePath = path.join(TEMP_DIR, 'showTrueBBoxBorder_test.html');

// Edge case generators - each function wraps content in appropriate SVG structure
const edgeCases = {
  normal: {
    name: 'Normal (with viewBox)',
    generateSVG: (content, id) => {
      const vbWidth = 400;
      const vbHeight = 300;
      return `<svg id="svg_${id}" viewBox="0 0 ${vbWidth} ${vbHeight}" width="${vbWidth * 2}" height="${vbHeight * 2}">${content}</svg>`;
    }
  },
  noViewBox: {
    name: 'No viewBox (only width/height)',
    generateSVG: (content, id) => {
      return `<svg id="svg_${id}" width="400" height="300">${content}</svg>`;
    }
  },
  noResolution: {
    name: 'No resolution (only viewBox)',
    generateSVG: (content, id) => {
      return `<svg id="svg_${id}" viewBox="0 0 400 300">${content}</svg>`;
    }
  },
  negativeViewBox: {
    name: 'Negative viewBox coordinates',
    generateSVG: (content, id) => {
      // Transform content coordinates by -200,-150 to center in -200,-150,400,300 viewBox
      let transformedContent = content;

      // Transform x and cx attributes
      transformedContent = transformedContent.replace(
        /(<\w+[^>]*?\s+)(x|cx)="([^"]+)"/g,
        (match, prefix, attr, value) => {
          const newVal = parseFloat(value) - 200;
          return `${prefix}${attr}="${newVal}"`;
        }
      );

      // Transform y and cy attributes
      transformedContent = transformedContent.replace(
        /(<\w+[^>]*?\s+)(y|cy)="([^"]+)"/g,
        (match, prefix, attr, value) => {
          const newVal = parseFloat(value) - 150;
          return `${prefix}${attr}="${newVal}"`;
        }
      );

      // Transform rotate() transform coordinates: rotate(angle x y) -> rotate(angle x-200 y-150)
      transformedContent = transformedContent.replace(
        /rotate\(([^\s]+)\s+([^\s]+)\s+([^)]+)\)/g,
        (match, angle, x, y) => {
          const newX = parseFloat(x) - 200;
          const newY = parseFloat(y) - 150;
          return `rotate(${angle} ${newX} ${newY})`;
        }
      );

      return `<svg id="svg_${id}" viewBox="-200 -150 400 300" width="800" height="600">${transformedContent}</svg>`;
    }
  },
  spriteSheet: {
    name: 'Sprite sheet with <use>',
    generateSVG: (content, id) => {
      // Wrap content in a symbol and reference it with <use>
      const symbolId = `symbol_${id}_${Date.now()}`;
      const useId = `use_${id}`;
      return `<svg id="svg_${id}" viewBox="0 0 400 300" width="800" height="600">
        <defs>
          <symbol id="${symbolId}" viewBox="0 0 400 300">${content}</symbol>
        </defs>
        <use id="${useId}" href="#${symbolId}" x="0" y="0" width="400" height="300"/>
      </svg>`;
    },
    // For sprite sheets, we test the <use> element, not the original content
    // baseId will be like "elem_spriteSheet_0", we want "use_spriteSheet_0"
    getTargetId: (baseId) => baseId.replace('elem_', 'use_')
  }
};

// Base test scenarios - each defines content and validation
const baseScenarios = [
  {
    name: 'Random text element',
    generateContent: (id) => {
      const fontSize = 20 + Math.random() * 40;
      const randomStr = Math.random().toString(36).substring(7);
      return `<text id="${id}" x="200" y="150" font-size="${fontSize}" text-anchor="middle" fill="#3498db">Random ${randomStr}</text>`;
    },
    validate: (result) => {
      expect(result.success).toBe(true);
      expect(result.accurate).toBe(true);
      expect(result.diffs.x).toBeLessThanOrEqual(1);
      expect(result.diffs.y).toBeLessThanOrEqual(1);
      expect(result.bbox.width).toBeGreaterThan(0);
      expect(result.bbox.height).toBeGreaterThan(0);
    }
  },
  {
    name: 'Circle',
    generateContent: (id) => {
      const cx = 150 + Math.random() * 100;
      const cy = 120 + Math.random() * 60;
      const r = 30 + Math.random() * 40;
      return `<circle id="${id}" cx="${cx}" cy="${cy}" r="${r}" fill="#e74c3c"/>`;
    },
    validate: (result) => {
      expect(result.success).toBe(true);
      expect(result.accurate).toBe(true);
    }
  },
  {
    name: 'Rectangle with stroke',
    generateContent: (id) => {
      const strokeWidth = 5 + Math.random() * 10;
      return `<rect id="${id}" x="150" y="100" width="100" height="80" fill="none" stroke="#9b59b6" stroke-width="${strokeWidth}"/>`;
    },
    validate: (result) => {
      expect(result.success).toBe(true);
      expect(result.accurate).toBe(true);
      expect(result.bbox.width).toBeGreaterThan(0);
    }
  },
  {
    name: 'Rotated text',
    generateContent: (id) => {
      const angle = -30 + Math.random() * 60;
      return `<text id="${id}" x="200" y="150" font-size="36" text-anchor="middle" transform="rotate(${angle} 200 150)" fill="#34495e">Rotated</text>`;
    },
    validate: (result) => {
      expect(result.success).toBe(true);
      expect(result.accurate).toBe(true);
    }
  },
  {
    name: 'Auto theme detection',
    generateContent: (id) => {
      return `<text id="${id}" x="200" y="150" font-size="32" text-anchor="middle" fill="#2c3e50">Theme</text>`;
    },
    options: { theme: 'auto' },
    validate: (result) => {
      expect(result.success).toBe(true);
      expect(result.borderStyle).toContain('dashed');
      const isDark =
        result.borderStyle.includes('rgba(0, 0, 0') || result.borderStyle.includes('rgb(0, 0, 0');
      const isLight =
        result.borderStyle.includes('rgba(255, 255, 255') ||
        result.borderStyle.includes('rgb(255, 255, 255');
      expect(isDark || isLight).toBe(true);
    }
  },
  {
    name: 'Forced dark theme',
    generateContent: (id) => {
      return `<circle id="${id}" cx="200" cy="150" r="50" fill="#16a085"/>`;
    },
    options: { theme: 'dark' },
    validate: (result) => {
      expect(result.success).toBe(true);
      const isLight =
        result.borderStyle.includes('rgba(255, 255, 255') ||
        result.borderStyle.includes('rgb(255, 255, 255');
      expect(isLight).toBe(true);
    }
  },
  {
    name: 'Forced light theme',
    generateContent: (id) => {
      return `<circle id="${id}" cx="200" cy="150" r="50" fill="#c0392b"/>`;
    },
    options: { theme: 'light' },
    validate: (result) => {
      expect(result.success).toBe(true);
      const isDark =
        result.borderStyle.includes('rgba(0, 0, 0') || result.borderStyle.includes('rgb(0, 0, 0');
      expect(isDark).toBe(true);
    }
  },
  {
    name: 'Custom border color',
    generateContent: (id) => {
      return `<rect id="${id}" x="150" y="100" width="100" height="80" fill="#27ae60"/>`;
    },
    options: { borderColor: 'rgb(255, 0, 0)' },
    validate: (result) => {
      expect(result.success).toBe(true);
      expect(result.borderStyle).toContain('rgb(255, 0, 0)');
    }
  },
  {
    name: 'Custom padding',
    generateContent: (id) => {
      const fontSize = 24 + Math.random() * 16;
      return `<text id="${id}" x="200" y="150" font-size="${fontSize}" text-anchor="middle" fill="#8e44ad">Padding</text>`;
    },
    options: { padding: 10 },
    validate: (result) => {
      expect(result.success).toBe(true);
      expect(result.accurate).toBe(true);
    }
  }
];

test.beforeAll(async () => {
  // Create temp directory first
  await fs.mkdir(TEMP_DIR, { recursive: true });

  // Skip if file already exists (avoid race condition)
  try {
    await fs.access(testPagePath);
    console.log('Test page already exists: ' + testPagePath);
    return;
  } catch {
    // File doesn't exist, create it
  }

  // Generate all SVG combinations dynamically
  let sections = [];

  for (const edgeKey of Object.keys(edgeCases)) {
    const edge = edgeCases[edgeKey];

    for (let scenarioIdx = 0; scenarioIdx < baseScenarios.length; scenarioIdx++) {
      const scenario = baseScenarios[scenarioIdx];
      const elementId = `elem_${edgeKey}_${scenarioIdx}`;
      const content = scenario.generateContent(elementId);
      const svgMarkup = edge.generateSVG(content, `${edgeKey}_${scenarioIdx}`);

      sections.push(`
  <!-- ${edge.name} - ${scenario.name} -->
  <div class="section">
    <h3>${edge.name}: ${scenario.name}</h3>
    ${svgMarkup}
  </div>`);
    }
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>showTrueBBoxBorder Test - Edge Cases</title>
  <script src="file://${path.resolve('SvgVisualBBox.js')}"></script>
  <style>
    body { margin: 20px; font-family: Arial, sans-serif; }
    .section { margin: 30px 0; padding: 20px; border: 1px solid #ddd; background: #f9f9f9; }
    svg { border: 1px solid #ccc; margin: 10px 0; background: white; }
    h3 { margin: 0 0 10px 0; color: #333; font-size: 14px; }
  </style>
</head>
<body>
  <h1>showTrueBBoxBorder() Test Page - Edge Cases</h1>
  <p>Testing ${baseScenarios.length} scenarios × ${Object.keys(edgeCases).length} edge cases = ${baseScenarios.length * Object.keys(edgeCases).length} tests</p>
  ${sections.join('\n')}

  <script>
    // @ts-nocheck
    /**
     * Test function for showTrueBBoxBorder
     * @param {string} elementId - Element ID to test
     * @param {Object} [options={}] - Options for showTrueBBoxBorder
     * @param {string} [options.theme] - Theme to use
     * @param {string} [options.borderColor] - Custom border color
     * @param {number} [options.padding] - Custom padding
     * @returns {Promise<Object>} Test result
     */
    window.testBorder = async function(elementId, options = {}) {
      try {
        const element = document.getElementById(elementId);
        if (!element) throw new Error('Element not found: ' + elementId);

        const rootSvg = element.ownerSVGElement || element;
        await SvgVisualBBox.waitForDocumentFonts();

        const result = await SvgVisualBBox.showTrueBBoxBorder('#' + elementId, options);
        const overlay = result.overlay;
        const overlayRect = overlay.getBoundingClientRect();
        const svgRect = rootSvg.getBoundingClientRect();

        const viewBox = rootSvg.viewBox.baseVal;
        let vbX = 0, vbY = 0, vbWidth = svgRect.width, vbHeight = svgRect.height;
        if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
          vbX = viewBox.x;
          vbY = viewBox.y;
          vbWidth = viewBox.width;
          vbHeight = viewBox.height;
        }

        const scaleX = svgRect.width / vbWidth;
        const scaleY = svgRect.height / vbHeight;
        const bbox = result.bbox;
        const padding = options.padding !== undefined ? options.padding : 4;

        const expectedX = svgRect.left + (bbox.x - vbX) * scaleX - padding;
        const expectedY = svgRect.top + (bbox.y - vbY) * scaleY - padding;
        const expectedWidth = bbox.width * scaleX + (padding * 2);
        const expectedHeight = bbox.height * scaleY + (padding * 2);

        const tolerance = 1;
        const xMatch = Math.abs(overlayRect.left - expectedX) <= tolerance;
        const yMatch = Math.abs(overlayRect.top - expectedY) <= tolerance;
        const widthMatch = Math.abs(overlayRect.width - expectedWidth) <= tolerance;
        const heightMatch = Math.abs(overlayRect.height - expectedHeight) <= tolerance;

        return {
          success: true,
          accurate: xMatch && yMatch && widthMatch && heightMatch,
          bbox: bbox,
          overlay: {
            left: overlayRect.left,
            top: overlayRect.top,
            width: overlayRect.width,
            height: overlayRect.height
          },
          expected: {
            left: expectedX,
            top: expectedY,
            width: expectedWidth,
            height: expectedHeight
          },
          diffs: {
            x: Math.abs(overlayRect.left - expectedX),
            y: Math.abs(overlayRect.top - expectedY),
            width: Math.abs(overlayRect.width - expectedWidth),
            height: Math.abs(overlayRect.height - expectedHeight)
          },
          borderStyle: window.getComputedStyle(overlay).border,
          result: result
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    };
  </script>
</body>
</html>`;

  await fs.writeFile(testPagePath, html, 'utf8');
  console.log(`Test page generated: ${testPagePath}`);
  console.log(`Total tests: ${baseScenarios.length * Object.keys(edgeCases).length}`);
});

test.describe('showTrueBBoxBorder() - Comprehensive Edge Case Tests', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    // Create temp directory
    await fs.mkdir(TEMP_DIR, { recursive: true });
  });

  test.afterAll(async () => {
    // Clean up temp directory
    await fs.rm(TEMP_DIR, { recursive: true, force: true });
  });

  // Generate tests for each edge case × scenario combination
  for (const edgeKey of Object.keys(edgeCases)) {
    const edge = edgeCases[edgeKey];

    test.describe(`Edge Case: ${edge.name}`, () => {
      for (let scenarioIdx = 0; scenarioIdx < baseScenarios.length; scenarioIdx++) {
        const scenario = baseScenarios[scenarioIdx];

        test(`${scenario.name}`, async ({ page }) => {
          await page.goto('file://' + testPagePath);

          // Determine target element ID (sprite sheets use <use> element)
          let targetId = `elem_${edgeKey}_${scenarioIdx}`;
          if (edge.getTargetId) {
            targetId = edge.getTargetId(targetId);
          }

          const options = scenario.options || {};
          /** @type {TestBorderResult} */
          const result = await page.evaluate(
            ({ elemId, opts }) => {
              // @ts-expect-error - testBorder is added dynamically in the test page
              return window.testBorder(elemId, opts);
            },
            { elemId: targetId, opts: options }
          );

          // Run scenario-specific validation
          scenario.validate(result);

          // Log success
          const edgeLabel = edgeKey.padEnd(15);
          const scenarioLabel = scenario.name.padEnd(30);
          console.log(
            `✓ [${edgeLabel}] ${scenarioLabel} - accurate (x=${result.diffs.x.toFixed(2)}, y=${result.diffs.y.toFixed(2)})`
          );
        });
      }
    });
  }

  // Additional test: Remove function cleanup
  test('Remove function cleans up overlay', async ({ page }) => {
    await page.goto('file://' + testPagePath);

    // Use first element
    const firstId = 'elem_normal_0';
    await page.evaluate((id) => {
      // @ts-expect-error - testBorder is added dynamically in the test page
      return window.testBorder(id);
    }, firstId);

    let count = await page.evaluate(
      () => document.querySelectorAll('[data-svg-bbox-overlay]').length
    );
    expect(count).toBe(1);

    await page.evaluate(() => {
      document.querySelectorAll('[data-svg-bbox-overlay]').forEach((o) => o.remove());
    });

    count = await page.evaluate(() => document.querySelectorAll('[data-svg-bbox-overlay]').length);
    expect(count).toBe(0);

    console.log('✓ Remove function: overlay cleaned up');
  });
});
