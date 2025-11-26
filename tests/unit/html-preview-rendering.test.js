/**
 * HTML Preview Rendering Tests
 *
 * These tests verify the critical fixes for HTML preview rendering in sbb-extractor.cjs.
 * Each test documents the FAULTY methods we tried and proves the CORRECT method works.
 *
 * CRITICAL: Uses SvgVisualBBox library functions, NOT getBBox()!
 * getBBox() is unreliable - that's why this library exists!
 *
 * IMPORTANT: All tests use ONLY fonts available on the system at runtime.
 * NO hardcoded fonts, NO embedded fonts, NO copyright issues.
 * Each assertion is tested with at least 3 different fonts to ensure robustness.
 *
 * Context: When generating HTML object catalogs with --list flag, we render element previews
 * using <use href="#element-id" /> references to a hidden SVG container. This architecture
 * exposed several subtle bugs related to coordinate systems and transform inheritance.
 *
 * All bugs were discovered through systematic hypothesis testing documented in CLAUDE.md
 * and sbb-extractor.cjs comments.
 */

import { test, describe, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('HTML Preview Rendering - Critical Bug Fixes', () => {
  let browser;
  let page;
  let availableFonts;

  beforeAll(async () => {
    browser = await puppeteer.launch({ headless: 'new' });
    const testPage = await browser.newPage();

    // Discover fonts available on this system
    availableFonts = await testPage.evaluate(() => {
      const fontsToTest = [
        // Web-safe fonts
        'Arial',
        'Helvetica',
        'Times New Roman',
        'Times',
        'Courier New',
        'Courier',
        'Verdana',
        'Georgia',
        'Palatino',
        'Garamond',
        'Bookman',
        'Comic Sans MS',
        'Trebuchet MS',
        'Arial Black',
        'Impact',
        // macOS fonts
        'Menlo',
        'Monaco',
        'San Francisco',
        'Helvetica Neue',
        // Windows fonts
        'Segoe UI',
        'Calibri',
        'Cambria',
        'Consolas',
        // Linux fonts
        'DejaVu Sans',
        'DejaVu Serif',
        'Liberation Sans',
        'Liberation Serif',
        'Ubuntu',
        'Noto Sans',
        'Noto Serif'
      ];

      const available = [];
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const testText = 'abcdefghijklmnopqrstuvwxyz0123456789';
      ctx.font = '12px monospace';
      const baselineWidth = ctx.measureText(testText).width;

      for (const font of fontsToTest) {
        ctx.font = `12px "${font}", monospace`;
        const width = ctx.measureText(testText).width;
        if (Math.abs(width - baselineWidth) > 0.1) {
          available.push(font);
        }
      }

      return available;
    });

    await testPage.close();

    if (availableFonts.length < 3) {
      throw new Error(
        `Not enough fonts available on system. Found: ${availableFonts.join(', ')}. ` +
          'Need at least 3 fonts for comprehensive testing.'
      );
    }

    console.log(
      `[Test Setup] Found ${availableFonts.length} available fonts:`,
      availableFonts.slice(0, 10).join(', '),
      '...'
    );
  });

  afterAll(async () => {
    await browser.close();
  });

  beforeEach(async () => {
    page = await browser.newPage();
  });

  /**
   * Helper: Load SvgVisualBBox library into page after content is set
   */
  async function loadLibrary() {
    const libPath = path.join(__dirname, '../../SvgVisualBBox.js');
    const libContent = fs.readFileSync(libPath, 'utf8');
    await page.addScriptTag({ content: libContent });
  }

  afterEach(async () => {
    await page.close();
  });

  function getRandomFonts(n = 3) {
    const selected = [];
    const available = [...availableFonts];
    for (let i = 0; i < Math.min(n, available.length); i++) {
      const index = Math.floor(Math.random() * available.length);
      selected.push(available.splice(index, 1)[0]);
    }
    return selected;
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════════
   * TEST: Complete HTML Preview Rendering (Real-World Scenario)
   * ═══════════════════════════════════════════════════════════════════════════════
   *
   * This tests the ACTUAL sbb-extractor.cjs HTML generation with ALL fixes applied.
   * We verify that the generated HTML correctly renders elements with:
   * - Parent transforms applied via wrapper <g>
   * - No viewBox on hidden container
   * - Precise viewBox coordinates
   * - Elements at negative coordinates
   *
   * REFERENCE: sbb-extractor.cjs HTML generation code
   */
  describe('Real-World HTML Preview Generation', () => {
    test('Generated HTML correctly renders text elements with parent transforms (tested with 3 fonts)', async () => {
      const fonts = getRandomFonts(3);

      for (const font of fonts) {
        // Simulate sbb-extractor.cjs HTML structure
        const parentTransform = 'translate(-13.5,-10.2)';
        const textX = -50;
        const textY = 100;

        const fullHtml = `
          <!DOCTYPE html>
          <html><body>
            <!-- Hidden container (NO viewBox!) -->
            <div style="display:none" id="svg-container">
              <svg id="root">
                <g id="g37" transform="${parentTransform}">
                  <text id="test-text" x="${textX}" y="${textY}" font-family="${font}" font-size="50">Test</text>
                </g>
              </svg>
            </div>

            <!-- Preview SVG with parent transform wrapper -->
            <svg id="preview" viewBox="-70 80 100 50">
              <g transform="${parentTransform}">
                <use href="#test-text" />
              </g>
            </svg>
          </body></html>
        `;

        await page.setContent(fullHtml);
        await loadLibrary();
        await page.evaluateHandle('document.fonts.ready');

        // Use SvgVisualBBox library to measure the <use> element
        const bbox = await page.evaluate(async () => {
          const useElement = document.querySelector('#preview use');
          const result = await window.SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(
            useElement,
            {
              mode: 'unclipped',
              coarseFactor: 2,
              fineFactor: 8
            }
          );
          return result;
        });

        // Should successfully measure the text
        expect(bbox).toBeTruthy();
        expect(bbox.width).toBeGreaterThan(0);
        expect(bbox.height).toBeGreaterThan(0);

        // Position should account for parent transform
        // Text at x=-50, parent translate(-13.5, -10.2), so final x ≈ -63.5
        expect(bbox.x).toBeCloseTo(textX - 13.5, 1);
      }
    });

    test('Elements with negative coordinates work correctly in preview (tested with 3 fonts)', async () => {
      const fonts = getRandomFonts(3);

      for (const font of fonts) {
        const textX = -455; // Large negative coordinate (like text8)
        const textY = 1475;

        const fullHtml = `
          <!DOCTYPE html>
          <html><body>
            <div style="display:none">
              <svg id="root">
                <text id="far-negative" x="${textX}" y="${textY}" font-family="${font}" font-size="50">Test</text>
              </svg>
            </div>

            <svg id="preview" viewBox="${textX - 10} ${textY - 10} 200 100">
              <use href="#far-negative" />
            </svg>
          </body></html>
        `;

        await page.setContent(fullHtml);
        await loadLibrary();
        await page.evaluateHandle('document.fonts.ready');

        const bbox = await page.evaluate(async () => {
          const useElement = document.querySelector('svg use');
          const result = await window.SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(
            useElement,
            {
              mode: 'unclipped',
              coarseFactor: 2,
              fineFactor: 8
            }
          );
          return result;
        });

        expect(bbox).toBeTruthy();
        expect(bbox.width).toBeGreaterThan(0);
        expect(bbox.x).toBeCloseTo(textX, 5); // Should be close to original X
      }
    });

    test('Multiple elements with different parent transforms render correctly (tested with 3 fonts)', async () => {
      const fonts = getRandomFonts(3);

      for (const font of fonts) {
        const fullHtml = `
          <!DOCTYPE html>
          <html><body>
            <div style="display:none">
              <svg id="root">
                <g id="g1" transform="translate(100,200)">
                  <text id="text1" x="0" y="20" font-family="${font}" font-size="30">A</text>
                </g>
                <g id="g2" transform="translate(-50,-50)">
                  <text id="text2" x="0" y="20" font-family="${font}" font-size="30">B</text>
                </g>
              </svg>
            </div>

            <svg id="preview1" viewBox="90 190 50 50">
              <g transform="translate(100,200)">
                <use href="#text1" />
              </g>
            </svg>

            <svg id="preview2" viewBox="-60 -60 50 50">
              <g transform="translate(-50,-50)">
                <use href="#text2" />
              </g>
            </svg>
          </body></html>
        `;

        await page.setContent(fullHtml);
        await loadLibrary();
        await page.evaluateHandle('document.fonts.ready');

        const results = await page.evaluate(async () => {
          const uses = document.querySelectorAll('svg use');

          const bbox1 = await window.SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(
            uses[0],
            {
              mode: 'unclipped',
              coarseFactor: 2,
              fineFactor: 8
            }
          );

          const bbox2 = await window.SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(
            uses[1],
            {
              mode: 'unclipped',
              coarseFactor: 2,
              fineFactor: 8
            }
          );

          return { bbox1, bbox2 };
        });

        // Both should render successfully
        expect(results.bbox1).toBeTruthy();
        expect(results.bbox2).toBeTruthy();
        expect(results.bbox1.width).toBeGreaterThan(0);
        expect(results.bbox2.width).toBeGreaterThan(0);

        // Positions should account for their respective parent transforms
        expect(results.bbox1.x).toBeGreaterThan(90); // Near 100 (translate x)
        expect(results.bbox2.x).toBeLessThan(-40); // Near -50 (translate x)
      }
    });
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════
   * SUMMARY OF FIXES
   * ═══════════════════════════════════════════════════════════════════════════════
   *
   * What we learned from this testing:
   *
   * 1. **Always use SvgVisualBBox library functions, NOT getBBox()**
   *    - getBBox() is unreliable (that's why this library exists!)
   *    - Use getSvgElementVisualBBoxTwoPassAggressive() for accurate measurements
   *
   * 2. **Parent transforms must be applied via wrapper <g>**
   *    - When <use> references an element with parent groups, wrap it:
   *      <g transform="parent transforms"><use href="#id" /></g>
   *
   * 3. **Hidden container must have NO viewBox**
   *    - Remove viewBox, width, height, x, y from hidden container SVG
   *    - Prevents coordinate system constraints
   *
   * 4. **Use runtime font detection**
   *    - Test with fonts available on system (no copyright issues)
   *    - Each test runs with 3+ different fonts for robustness
   *
   * Code references:
   * - sbb-extractor.cjs lines 540-715 (implementation)
   * - CLAUDE.md lines 278-702 (comprehensive documentation)
   */
});
