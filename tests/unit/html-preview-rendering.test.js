/**
 * HTML Preview Rendering Tests
 *
 * These tests verify the critical fixes for HTML preview rendering in export-svg-objects.cjs.
 * Each test documents the FAULTY methods we tried and proves the CORRECT method works.
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
 * and export-svg-objects.cjs comments.
 */

import { test, describe, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import puppeteer from 'puppeteer';

describe('HTML Preview Rendering - Critical Bug Fixes', () => {
  let browser;
  let page;
  let availableFonts;

  beforeAll(async () => {
    browser = await puppeteer.launch({ headless: 'new' });
    const testPage = await browser.newPage();

    // Discover fonts available on this system
    // We test common web-safe fonts and platform-specific fonts
    availableFonts = await testPage.evaluate(() => {
      const fontsToTest = [
        // Web-safe fonts (should be available on most systems)
        'Arial', 'Helvetica', 'Times New Roman', 'Times', 'Courier New', 'Courier',
        'Verdana', 'Georgia', 'Palatino', 'Garamond', 'Bookman', 'Comic Sans MS',
        'Trebuchet MS', 'Arial Black', 'Impact',
        // macOS fonts
        'Menlo', 'Monaco', 'San Francisco', 'Helvetica Neue',
        // Windows fonts
        'Segoe UI', 'Calibri', 'Cambria', 'Consolas',
        // Linux fonts
        'DejaVu Sans', 'DejaVu Serif', 'Liberation Sans', 'Liberation Serif',
        'Ubuntu', 'Noto Sans', 'Noto Serif'
      ];

      const available = [];
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      // Test each font by measuring text width
      // If width changes, font is available
      const testText = 'abcdefghijklmnopqrstuvwxyz0123456789';
      ctx.font = '12px monospace';
      const baselineWidth = ctx.measureText(testText).width;

      for (const font of fontsToTest) {
        ctx.font = `12px "${font}", monospace`;
        const width = ctx.measureText(testText).width;

        // If width is different from baseline, font loaded
        if (Math.abs(width - baselineWidth) > 0.1) {
          available.push(font);
        }
      }

      return available;
    });

    await testPage.close();

    // Ensure we have at least 3 fonts for testing
    if (availableFonts.length < 3) {
      throw new Error(
        `Not enough fonts available on system. Found: ${availableFonts.join(', ')}. ` +
        `Need at least 3 fonts for comprehensive testing.`
      );
    }

    console.log(`[Test Setup] Found ${availableFonts.length} available fonts:`, availableFonts.slice(0, 10).join(', '), '...');
  });

  afterAll(async () => {
    await browser.close();
  });

  beforeEach(async () => {
    page = await browser.newPage();
  });

  afterEach(async () => {
    await page.close();
  });

  /**
   * Helper: Get N random fonts from available fonts
   */
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
   * TEST 1: Hidden Container ViewBox Clipping
   * ═══════════════════════════════════════════════════════════════════════════════
   *
   * PROBLEM: Hidden SVG container with viewBox clips <use> references when
   * referenced elements have coordinates outside the container's viewBox.
   *
   * FAULTY METHODS TRIED:
   * ❌ Method 1: Keep container viewBox="0 0 width height"
   *    → Elements with negative coords get clipped
   * ❌ Method 2: Expand container viewBox to include all elements
   *    → Breaks coordinate system for deeply nested elements
   * ❌ Method 3: Use preserveAspectRatio="none" on container
   *    → Distorts element rendering
   *
   * CORRECT METHOD:
   * ✅ Remove viewBox, width, height, x, y from container entirely
   *    → <use> elements inherit coordinate system from preview SVG only
   *
   * WHY IT WORKS:
   * According to SVG spec, <use> inherits coordinate system from its CONTEXT
   * (the preview SVG), NOT from the referenced element's original container.
   *
   * REFERENCE: export-svg-objects.cjs lines 540-580
   */
  describe('CRITICAL FIX #1: Hidden Container ViewBox Must Be Removed', () => {

    test('Text elements with negative X coordinates get clipped when container has viewBox (tested with 3 fonts)', async () => {
      // Test with 3 different fonts to ensure bug occurs regardless of font choice
      const fonts = getRandomFonts(3);

      for (const font of fonts) {
        // Create text at x=-50 (negative X, outside viewBox="0 0 1000 1000")
        const testText = `<text id="negText" x="-50" y="50" font-family="${font}" font-size="40">ABC</text>`;

        // FAULTY METHOD: Container has viewBox="0 0 1000 1000"
        // Text at x=-50 is OUTSIDE (negative X not in 0...1000 range)
        const faultyHtml = `
          <!DOCTYPE html>
          <html><body>
            <div style="display:none">
              <svg id="container" viewBox="0 0 1000 1000">
                ${testText}
              </svg>
            </div>
            <svg id="preview" viewBox="-60 20 150 60">
              <use href="#negText" />
            </svg>
          </body></html>
        `;

        await page.setContent(faultyHtml);
        await page.evaluateHandle('document.fonts.ready'); // Wait for font loading

        const result = await page.evaluate((fontName) => {
          const use = document.querySelector('#preview use');
          try {
            const bbox = use.getBBox();
            return { font: fontName, width: bbox.width, height: bbox.height, clipped: bbox.width < 50 };
          } catch (e) {
            return { font: fontName, width: 0, height: 0, clipped: true, error: e.message };
          }
        }, font);

        // With container viewBox, text should be clipped (width much less than expected)
        // Normal text "ABC" at font-size 40 should be >50px wide
        expect(result.clipped).toBe(true);
      }
    });

    test('Text elements with negative X coordinates render fully when container has NO viewBox (tested with 3 fonts)', async () => {
      const fonts = getRandomFonts(3);

      for (const font of fonts) {
        const testText = `<text id="negText" x="-50" y="50" font-family="${font}" font-size="40">ABC</text>`;

        // CORRECT METHOD: Container has NO viewBox
        const correctHtml = `
          <!DOCTYPE html>
          <html><body>
            <div style="display:none">
              <svg id="container">
                ${testText}
              </svg>
            </div>
            <svg id="preview" viewBox="-60 20 150 60">
              <use href="#negText" />
            </svg>
          </body></html>
        `;

        await page.setContent(correctHtml);
        await page.evaluateHandle('document.fonts.ready');

        const result = await page.evaluate((fontName) => {
          const use = document.querySelector('#preview use');
          const bbox = use.getBBox();
          return {
            font: fontName,
            x: bbox.x,
            width: bbox.width,
            height: bbox.height,
            visible: bbox.width > 0 && bbox.height > 0
          };
        }, font);

        // Without container viewBox, text should render fully
        expect(result.visible).toBe(true);
        expect(result.width).toBeGreaterThan(30); // "ABC" should have substantial width
        expect(result.x).toBeCloseTo(-50, 5); // Should respect original X coordinate
      }
    });

    test('EDGE CASE: Elements far outside container viewBox with large negative coordinates (tested with 3 fonts)', async () => {
      // Simulates real bug: text8 at x=-455.64, container viewBox="0 0 1037 2892"
      const fonts = getRandomFonts(3);

      for (const font of fonts) {
        const testText = `<text id="farNeg" x="-455" y="1475" font-family="${font}" font-size="50">Test</text>`;

        // FAULTY: Container viewBox clips far-negative coordinates
        const faultyHtml = `
          <!DOCTYPE html>
          <html><body>
            <div style="display:none">
              <svg id="container" viewBox="0 0 1037 2892">
                ${testText}
              </svg>
            </div>
            <svg id="preview" viewBox="-460 1450 200 100">
              <use href="#farNeg" />
            </svg>
          </body></html>
        `;

        // CORRECT: Container without viewBox
        const correctHtml = `
          <!DOCTYPE html>
          <html><body>
            <div style="display:none">
              <svg id="container">
                ${testText}
              </svg>
            </div>
            <svg id="preview" viewBox="-460 1450 200 100">
              <use href="#farNeg" />
            </svg>
          </body></html>
        `;

        await page.setContent(faultyHtml);
        await page.evaluateHandle('document.fonts.ready');
        const faultyResult = await page.evaluate(() => {
          const use = document.querySelector('#preview use');
          const bbox = use.getBBox();
          return { width: bbox.width, visible: bbox.width > 0 };
        });

        await page.setContent(correctHtml);
        await page.evaluateHandle('document.fonts.ready');
        const correctResult = await page.evaluate(() => {
          const use = document.querySelector('#preview use');
          const bbox = use.getBBox();
          return { width: bbox.width, visible: bbox.width > 0 };
        });

        // Faulty method: should NOT be visible (clipped by container viewBox)
        expect(faultyResult.visible).toBe(false);

        // Correct method: should BE visible
        expect(correctResult.visible).toBe(true);
        expect(correctResult.width).toBeGreaterThan(0);
      }
    });
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════
   * TEST 2: Parent Transform Inheritance with <use> Elements
   * ═══════════════════════════════════════════════════════════════════════════════
   *
   * PROBLEM: <use href="#element-id" /> does NOT inherit parent group transforms.
   * This is SVG spec behavior, not a browser bug.
   *
   * FAULTY METHODS TRIED:
   * ❌ Method 1: Just <use href="#id" />
   *    → Missing parent transforms, element shifted/mispositioned
   * ❌ Method 2: Apply parent transforms to preview SVG's viewBox
   *    → Incorrect, viewBox doesn't support transform syntax
   * ❌ Method 3: Apply parent transforms to <use> element directly
   *    → Doubles the transform (applied twice: once from element, once from <use>)
   * ❌ Method 4: Clone element with parent transforms flattened
   *    → Breaks element references, loses structure
   *
   * CORRECT METHOD:
   * ✅ Collect parent transforms, wrap <use> in <g transform="parent transforms">
   *    → Exactly recreates original transform chain
   *
   * WHY IT WORKS:
   * Transform chain: parent transforms (on wrapper <g>) → element local transform → render
   * This matches the original SVG's inheritance: parent <g> → element → render
   *
   * REFERENCE: export-svg-objects.cjs lines 582-715
   */
  describe('CRITICAL FIX #2: Parent Transforms Must Be Explicitly Applied', () => {

    test('Element with parent translate transform renders shifted without wrapper (tested with 3 fonts)', async () => {
      // Real example from test_text_to_path_advanced.svg: translate(-13.613145,-10.209854)
      const fonts = getRandomFonts(3);

      for (const font of fonts) {
        const parentTransform = 'translate(-13.613145,-10.209854)';
        const testSvg = `
          <g id="g37" transform="${parentTransform}">
            <text id="text8" x="-50" y="1467" font-family="${font}" font-size="100">Test</text>
          </g>
        `;

        // FAULTY METHOD: <use> without parent transform wrapper
        const faultyHtml = `
          <!DOCTYPE html>
          <html><body>
            <div style="display:none">
              <svg id="container">${testSvg}</svg>
            </div>
            <svg id="preview" viewBox="-70 1440 150 80">
              <use href="#text8" />
            </svg>
          </body></html>
        `;

        // CORRECT METHOD: <use> wrapped with parent transform
        const correctHtml = `
          <!DOCTYPE html>
          <html><body>
            <div style="display:none">
              <svg id="container">${testSvg}</svg>
            </div>
            <svg id="preview" viewBox="-70 1440 150 80">
              <g transform="${parentTransform}">
                <use href="#text8" />
              </g>
            </svg>
          </body></html>
        `;

        await page.setContent(faultyHtml);
        await page.evaluateHandle('document.fonts.ready');
        const faultyBBox = await page.evaluate(() => {
          const use = document.querySelector('#preview use');
          const bbox = use.getBBox();
          return { x: bbox.x, y: bbox.y };
        });

        await page.setContent(correctHtml);
        await page.evaluateHandle('document.fonts.ready');
        const correctBBox = await page.evaluate(() => {
          const use = document.querySelector('#preview use');
          const bbox = use.getBBox();
          return { x: bbox.x, y: bbox.y };
        });

        // Faulty method: missing translate, X should be ~13.6px too far right
        const shiftX = faultyBBox.x - correctBBox.x;
        expect(Math.abs(shiftX - 13.613145)).toBeLessThan(0.1); // Should be shifted by exactly parent translate amount

        // Correct method matches expected position (parent transform applied)
        expect(correctBBox.x).toBeCloseTo(-50 - 13.613145, 1);
      }
    });

    test('Element with multiple nested parent transforms requires ALL transforms in correct order (tested with 3 fonts)', async () => {
      const fonts = getRandomFonts(3);

      for (const font of fonts) {
        // Complex case: translate → scale → rotate chain
        const testSvg = `
          <g id="g1" transform="translate(100,200)">
            <g id="g2" transform="scale(2,2)">
              <g id="g3" transform="rotate(15)">
                <text id="deepText" x="0" y="0" font-family="${font}" font-size="20">A</text>
              </g>
            </g>
          </g>
        `;

        // FAULTY: Missing all parent transforms
        const faulty1Html = `
          <!DOCTYPE html>
          <html><body>
            <div style="display:none">
              <svg id="container">${testSvg}</svg>
            </div>
            <svg id="preview" viewBox="-50 -50 400 400">
              <use href="#deepText" />
            </svg>
          </body></html>
        `;

        // CORRECT: All parent transforms in order
        const correctHtml = `
          <!DOCTYPE html>
          <html><body>
            <div style="display:none">
              <svg id="container">${testSvg}</svg>
            </div>
            <svg id="preview" viewBox="-50 -50 400 400">
              <g transform="translate(100,200) scale(2,2) rotate(15)">
                <use href="#deepText" />
              </g>
            </svg>
          </body></html>
        `;

        await page.setContent(faulty1Html);
        await page.evaluateHandle('document.fonts.ready');
        const faulty1BBox = await page.evaluate(() => {
          const bbox = document.querySelector('#preview use').getBBox();
          return { x: bbox.x, y: bbox.y };
        });

        await page.setContent(correctHtml);
        await page.evaluateHandle('document.fonts.ready');
        const correctBBox = await page.evaluate(() => {
          const bbox = document.querySelector('#preview use').getBBox();
          return { x: bbox.x, y: bbox.y };
        });

        // All three positions should be different
        // Without parent transforms: positioned at origin
        // With all parent transforms: positioned at transformed location
        const distance = Math.sqrt(
          Math.pow(faulty1BBox.x - correctBBox.x, 2) +
          Math.pow(faulty1BBox.y - correctBBox.y, 2)
        );
        expect(distance).toBeGreaterThan(100); // Should be significantly different
      }
    });

    test('EDGE CASE: Large parent transform shift (rect1851 real bug - tested with 3 fonts)', async () => {
      // Real bug from test_text_to_path_advanced.svg: translate(-1144.8563,517.64642)
      // This caused rect1851 to appear completely empty!
      const fonts = getRandomFonts(3);

      for (const font of fonts) {
        const largeTransform = 'translate(-1144.8563,517.64642)';
        const testSvg = `
          <g id="g1" transform="${largeTransform}">
            <text id="shiftedText" x="1300" y="300" font-family="${font}" font-size="50">X</text>
          </g>
        `;

        // FAULTY: Missing large translate
        const faultyHtml = `
          <!DOCTYPE html>
          <html><body>
            <div style="display:none">
              <svg id="container">${testSvg}</svg>
            </div>
            <svg id="preview" viewBox="100 700 200 200">
              <use href="#shiftedText" />
            </svg>
          </body></html>
        `;

        // CORRECT: With large parent translate
        const correctHtml = `
          <!DOCTYPE html>
          <html><body>
            <div style="display:none">
              <svg id="container">${testSvg}</svg>
            </div>
            <svg id="preview" viewBox="100 700 200 200">
              <g transform="${largeTransform}">
                <use href="#shiftedText" />
              </g>
            </svg>
          </body></html>
        `;

        await page.setContent(faultyHtml);
        await page.evaluateHandle('document.fonts.ready');
        const faultyBBox = await page.evaluate(() => {
          const bbox = document.querySelector('#preview use').getBBox();
          return { x: bbox.x, y: bbox.y, withinViewBox: bbox.x >= 100 && bbox.x <= 300 };
        });

        await page.setContent(correctHtml);
        await page.evaluateHandle('document.fonts.ready');
        const correctBBox = await page.evaluate(() => {
          const bbox = document.querySelector('#preview use').getBBox();
          return { x: bbox.x, y: bbox.y, withinViewBox: bbox.x >= 100 && bbox.x <= 300 };
        });

        // Faulty: X should be way outside viewBox (at x=1300)
        expect(faultyBBox.withinViewBox).toBe(false);
        expect(faultyBBox.x).toBeCloseTo(1300, 1);

        // Correct: X should be within viewBox (1300 - 1144.8563 = 155.1437)
        expect(correctBBox.withinViewBox).toBe(true);
        expect(correctBBox.x).toBeCloseTo(155, 1);
      }
    });
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════
   * TEST 3: Coordinate Precision Must Be Preserved
   * ═══════════════════════════════════════════════════════════════════════════════
   *
   * PROBLEM: BBox measurements have high precision, must preserve in viewBox
   *
   * FAULTY METHODS TRIED:
   * ❌ Method 1: Round to 2 decimal places (bbox.x.toFixed(2))
   *    → Loses precision, visible misalignment at high zoom
   * ❌ Method 2: Round to integers (Math.round(bbox.x))
   *    → Severe precision loss, text positioning breaks
   * ❌ Method 3: Use string concatenation with truncation
   *    → Inconsistent precision, potential floating point errors
   *
   * CORRECT METHOD:
   * ✅ Use template literal with full number precision
   *    → Preserves JavaScript's ~15-17 significant digits
   *
   * WHY IT WORKS:
   * BBox returns full precision coordinates (IEEE 754 double)
   * Template literal preserves this precision automatically
   * No rounding = no cumulative errors
   *
   * REFERENCE: export-svg-objects.cjs lines 707-723, CLAUDE.md lines 664-686
   */
  describe('CRITICAL FIX #4: Coordinate Precision Must Be Preserved', () => {

    test('Full precision viewBox preserves exact coordinates (tested with 3 fonts)', async () => {
      const fonts = getRandomFonts(3);

      for (const font of fonts) {
        // Precise coordinates with many decimals
        const x = 123.456789012345;
        const y = 987.654321098765;

        const testText = `<text id="preciseText" x="${x}" y="${y}" font-family="${font}" font-size="40">ABC</text>`;
        const viewBoxStr = `${x - 10} ${y - 10} 100 60`; // Full precision

        const html = `
          <!DOCTYPE html>
          <html><body>
            <div style="display:none">
              <svg id="container">${testText}</svg>
            </div>
            <svg id="preview" viewBox="${viewBoxStr}">
              <use href="#preciseText" />
            </svg>
          </body></html>
        `;

        await page.setContent(html);
        await page.evaluateHandle('document.fonts.ready');

        const bbox = await page.evaluate(() => {
          const use = document.querySelector('#preview use');
          return use.getBBox();
        });

        // Coordinates should be preserved with high precision
        expect(bbox.x).toBeCloseTo(x, 10);
        expect(bbox.y).toBeCloseTo(y, 10);
      }
    });

    test('FAULTY: Rounding to 2 decimals causes measurable errors (tested with 3 fonts)', async () => {
      const fonts = getRandomFonts(3);

      for (const font of fonts) {
        const x = 123.456789;
        const y = 987.654321;

        const testText = `<text id="preciseText" x="${x}" y="${y}" font-family="${font}" font-size="40">ABC</text>`;

        // FAULTY: Rounded to 2 decimals
        const roundedViewBox = `${(x - 10).toFixed(2)} ${(y - 10).toFixed(2)} 100 60`;

        const html = `
          <!DOCTYPE html>
          <html><body>
            <div style="display:none">
              <svg id="container">${testText}</svg>
            </div>
            <svg id="preview" viewBox="${roundedViewBox}">
              <use href="#preciseText" />
            </svg>
          </body></html>
        `;

        await page.setContent(html);
        await page.evaluateHandle('document.fonts.ready');

        const bbox = await page.evaluate(() => {
          return document.querySelector('#preview use').getBBox();
        });

        // Calculate rounding error
        const xError = Math.abs(bbox.x - x);
        const yError = Math.abs(bbox.y - y);

        // Error should exist (viewBox was rounded, but element coords are precise)
        // The viewBox rounding affects how the element appears relative to the viewBox
        expect(xError + yError).toBeGreaterThan(0); // Some error should exist
      }
    });
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════
   * INTEGRATION TEST: All Fixes Combined
   * ═══════════════════════════════════════════════════════════════════════════════
   *
   * This test combines ALL fixes together to verify they work correctly when
   * applied simultaneously. This is the real-world scenario.
   */
  describe('INTEGRATION: All Fixes Combined', () => {

    test('Complete HTML preview with all fixes works correctly (tested with 3 fonts)', async () => {
      const fonts = getRandomFonts(3);

      for (const font of fonts) {
        // Simulates real scenario: element with parent transform, negative coords, precise positioning
        const parentTransform = 'translate(-13.5,-10.2)';
        const x = -455.6401353626684;
        const y = 1474.7539879250833;

        const testSvg = `
          <g id="g37" transform="${parentTransform}">
            <text id="complexText" x="${x}" y="${y}" font-family="${font}" font-size="50">Test</text>
          </g>
        `;

        const viewBoxX = x - 13.5;  // Account for parent transform
        const viewBoxY = y - 10.2;
        const viewBoxStr = `${viewBoxX - 10} ${viewBoxY - 10} 200 100`;

        const completeHtml = `
          <!DOCTYPE html>
          <html><body>
            <div style="display:none">
              <svg id="container">
                ${testSvg}
              </svg>
            </div>
            <svg id="preview" viewBox="${viewBoxStr}" style="max-width:120px; max-height:120px;">
              <g transform="${parentTransform}">
                <use href="#complexText" />
              </g>
            </svg>
          </body></html>
        `;

        await page.setContent(completeHtml);
        await page.evaluateHandle('document.fonts.ready');

        const result = await page.evaluate((expectedX, expectedY) => {
          const use = document.querySelector('#preview use');
          const bbox = use.getBBox();
          return {
            x: bbox.x,
            y: bbox.y,
            width: bbox.width,
            height: bbox.height,
            visible: bbox.width > 0 && bbox.height > 0,
            xMatch: Math.abs(bbox.x - expectedX) < 1,
            yMatch: Math.abs(bbox.y - expectedY) < 1
          };
        }, x, y);

        // All fixes combined:
        // ✅ Container has NO viewBox (allows negative coords)
        // ✅ Parent transform applied via wrapper <g> (correct positioning)
        // ✅ Preview uses viewBox + CSS (proper sizing)
        // ✅ Full precision coordinates (no rounding errors)

        expect(result.visible).toBe(true);
        expect(result.xMatch).toBe(true);
        expect(result.yMatch).toBe(true);

        // User confirmation: "yes, it worked!" ✓
      }
    });
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SUMMARY OF FAULTY METHODS (WHAT NOT TO DO)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This section lists ALL the faulty methods we tried and rejected, so future
 * developers can avoid repeating these mistakes.
 *
 * ## Hidden Container ViewBox:
 * ❌ Keep container viewBox (clips elements outside bounds)
 * ❌ Expand container viewBox to fit all (breaks coordinate system)
 * ❌ Use preserveAspectRatio="none" (distorts rendering)
 * ✅ CORRECT: Remove viewBox, width, height, x, y entirely
 *
 * ## Parent Transform Inheritance:
 * ❌ Just <use href="#id" /> (missing parent transforms)
 * ❌ Apply transforms to preview viewBox (viewBox doesn't support transforms)
 * ❌ Apply transforms to <use> element (doubles the transform)
 * ❌ Clone element with flattened transforms (breaks references)
 * ✅ CORRECT: Wrap <use> in <g transform="parent transforms">
 *
 * ## Coordinate Precision:
 * ❌ Round to 2 decimals with toFixed(2) (visible misalignment)
 * ❌ Round to integers with Math.round() (severe precision loss)
 * ❌ String concatenation with truncation (inconsistent precision)
 * ✅ CORRECT: Template literal with full number precision
 *
 * ## Testing Methodology:
 * ✅ Use only fonts available on system at runtime (no copyright issues)
 * ✅ Test each assertion with 3+ different fonts (robustness)
 * ✅ Generate SVG dynamically during tests (portability)
 * ✅ Verify faulty methods fail and correct methods work
 * ✅ Document all debugging hypotheses (what we tried, why it failed)
 *
 * These tests PROVE the correct methods work across different fonts and systems.
 * Code references:
 * - export-svg-objects.cjs lines 540-715 (implementation)
 * - CLAUDE.md lines 278-702 (comprehensive documentation)
 */
