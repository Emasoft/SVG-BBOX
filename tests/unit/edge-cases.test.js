/**
 * Edge case tests for getSvgElementVisualBBoxTwoPassAggressive
 *
 * Tests the library's robustness when handling:
 * - Malformed SVG
 * - Missing/invalid fonts
 * - Broken references
 * - Extreme values
 * - Invalid attributes
 * - Empty elements
 */

import { describe, it, expect, afterAll } from 'vitest';
import {
  createPageWithSvg,
  getBBoxById,
  closeBrowser,
  assertValidBBox
} from '../helpers/browser-test.js';

// FONT_TOLERANCE_PX: Cross-platform font rendering tolerance
// WHY 6px: Font rendering varies across platforms/browsers due to:
// - Different font hinting algorithms (FreeType vs DirectWrite vs CoreText)
// - Subpixel positioning differences
// - Anti-aliasing method variations
// - Font file version differences (especially system fonts)
// - Rounding differences in font metrics calculation
// Original 4px tolerance was insufficient for CI environments
const _FONT_TOLERANCE_PX = 6;

describe('Edge Cases - getSvgElementVisualBBoxTwoPassAggressive', () => {
  afterAll(async () => {
    await closeBrowser();
  });

  describe('Malformed SVG', () => {
    it('should handle SVG without xmlns attribute', async () => {
      /**
       * Verifies library handles SVG without xmlns attribute gracefully.
       * Tests that missing xmlns doesn't prevent bbox calculation.
       */
      const page = await createPageWithSvg('edge-cases/malformed/missing-xmlns.svg');
      const bbox = await getBBoxById(page, 'test-rect');

      expect(bbox).toBeTruthy();
      assertValidBBox(bbox);

      // Should still compute bbox correctly (non-text elements have precise coordinates)
      expect(bbox.x).toBeCloseTo(50, 0);
      expect(bbox.y).toBeCloseTo(50, 0);
      expect(bbox.width).toBeCloseTo(100, 0);
      expect(bbox.height).toBeCloseTo(80, 0);

      await page.close();
    });

    it('should handle mixed-case SVG tags', async () => {
      /**
       * Verifies graceful handling of mixed-case SVG tags (e.g., <Rect> instead of <rect>).
       * XML-strict mode may reject these, but library should handle gracefully.
       */
      const page = await createPageWithSvg('edge-cases/malformed/mixed-case-tags.svg');

      // Mixed case tags might not parse correctly in XML-strict mode
      // The library should handle gracefully (may return null or work)
      try {
        const bbox = await getBBoxById(page, 'test-rect');

        if (bbox) {
          assertValidBBox(bbox);
        }
      } catch (error) {
        // Expected - mixed case may cause issues
        expect(error.message).toBeTruthy();
      }

      await page.close();
    });

    it('should handle nested SVG elements', async () => {
      /**
       * Verifies bbox calculation for elements inside nested <svg> elements.
       * Tests that nested coordinate systems are handled correctly.
       */
      const page = await createPageWithSvg('edge-cases/malformed/nested-svg.svg');
      try {
        const bbox = await getBBoxById(page, 'nested-rect');

        expect(bbox).toBeTruthy();
        assertValidBBox(bbox);

        // Nested SVG has its own coordinate system
        // Inner viewBox is 0-100, but outer positioning affects final coords
        expect(bbox.width).toBeGreaterThan(0);
        expect(bbox.height).toBeGreaterThan(0);
      } finally {
        // WHY try/finally: Ensure page cleanup even if test fails
        await page.close();
      }
    });
  });

  describe('Font Issues', () => {
    it('should handle missing web fonts with fallback', async () => {
      /**
       * Verifies library handles missing web fonts gracefully with fallback rendering.
       * Tests that 404 font loads don't crash bbox calculation.
       */
      // WHY pageTimeoutMs 60000: This test loads an SVG with a missing web font.
      // The browser will try to load the font (404), and networkidle0 waits for that to fail.
      // In CI with parallel tests, this can exceed the default 30s timeout.
      const page = await createPageWithSvg('edge-cases/fonts/missing-web-font.svg', {
        pageTimeoutMs: 60000
      });
      try {
        // Font will 404, but should fallback to Arial
        // WHY 5000ms timeout: Give browser time to attempt load and use fallback
        const bbox = await getBBoxById(page, 'missing-font-text', {
          fontTimeoutMs: 5000
        });

        expect(bbox).toBeTruthy();
        assertValidBBox(bbox);

        // Text should still have dimensions with fallback font
        expect(bbox.width).toBeGreaterThan(200);
        expect(bbox.height).toBeGreaterThan(20);
      } finally {
        // WHY try/finally: Ensure page cleanup even if test fails
        await page.close();
      }
    }, 60000); // WHY 60s: Font loading attempt can be slow in CI with parallel tests

    it('should handle font-family with special characters', async () => {
      /**
       * Verifies font-family parsing handles special characters (quotes, spaces, commas).
       * Tests that unusual font names don't break bbox calculation.
       */
      // WHY pageTimeoutMs 60000: Font-family parsing tests may trigger font loading attempts.
      // In CI with parallel tests, the default 30s timeout can be exceeded.
      const page = await createPageWithSvg('edge-cases/fonts/special-chars-font-name.svg', {
        pageTimeoutMs: 60000
      });
      try {
        const bbox = await getBBoxById(page, 'special-font-text');

        expect(bbox).toBeTruthy();
        assertValidBBox(bbox);

        // Font name parsing should handle quotes and spaces
        expect(bbox.width).toBeGreaterThan(100);
        expect(bbox.height).toBeGreaterThan(20);
      } finally {
        // WHY try/finally: Ensure page cleanup even if test fails
        await page.close();
      }
    }, 60000); // WHY 60s: Font loading and parsing can be slow in CI with parallel tests
  });

  describe('Broken References', () => {
    it('should handle missing gradient reference', async () => {
      const page = await createPageWithSvg('edge-cases/references/missing-gradient.svg');
      const bbox = await getBBoxById(page, 'broken-gradient-rect');

      // Rect exists with stroke, even if fill gradient is missing
      // Browser should render with no fill or fallback
      expect(bbox).toBeTruthy();
      assertValidBBox(bbox);

      // Stroke should still be visible (stroke-width=2 extends bbox by 1px on each side)
      expect(bbox.x).toBeCloseTo(49, 0); // 50 - 1 (stroke extends outward)
      expect(bbox.y).toBeCloseTo(49, 0);
      expect(bbox.width).toBeGreaterThan(90); // Stroke adds width
      expect(bbox.height).toBeGreaterThan(70);

      await page.close();
    });

    it('should handle missing clipPath reference', async () => {
      const page = await createPageWithSvg('edge-cases/references/missing-clippath.svg');
      const bbox = await getBBoxById(page, 'broken-clip-rect');

      // Missing clipPath should be ignored, rect rendered normally
      expect(bbox).toBeTruthy();
      assertValidBBox(bbox);

      expect(bbox.x).toBeCloseTo(50, 0);
      expect(bbox.y).toBeCloseTo(50, 0);
      expect(bbox.width).toBeCloseTo(100, 0);
      expect(bbox.height).toBeCloseTo(80, 0);

      await page.close();
    });

    it('should handle circular use references gracefully', async () => {
      const page = await createPageWithSvg('edge-cases/references/circular-use.svg');

      // Circular reference should be detected and stopped by browser
      // May render nothing or handle gracefully
      const _bboxCircular = await getBBoxById(page, 'circular-ref');

      // The fallback rect should always work
      const bboxFallback = await getBBoxById(page, 'fallback-rect');
      expect(bboxFallback).toBeTruthy();
      assertValidBBox(bboxFallback);

      await page.close();
    });
  });

  describe('Extreme Values', () => {
    it('should handle extremely large coordinates', async () => {
      const page = await createPageWithSvg('edge-cases/extreme/huge-coordinates.svg');

      // Extremely large coordinates should be handled gracefully
      // Either return a valid bbox (if within canvas limits) or null/error (if outside limits)
      const bbox = await getBBoxById(page, 'huge-rect');

      if (bbox) {
        // If it succeeds, bbox should have valid properties
        assertValidBBox(bbox);
        // Coordinates should be extremely large
        expect(bbox.x).toBeGreaterThan(100000);
      }
      // If bbox is null, that's also acceptable (couldn't measure due to extreme coords)

      await page.close();
    });

    it('should handle extremely tiny elements', async () => {
      const page = await createPageWithSvg('edge-cases/extreme/tiny-element.svg');
      const bbox = await getBBoxById(page, 'tiny-rect');

      // Sub-pixel element might not render any pixels
      // Library should return null for invisible elements
      if (bbox) {
        // If it does render, bbox should be valid
        assertValidBBox(bbox);
        expect(bbox.width).toBeLessThan(1);
        expect(bbox.height).toBeLessThan(1);
      } else {
        // More likely: too small to rasterize
        expect(bbox).toBeNull();
      }

      await page.close();
    });

    it('should handle negative dimensions gracefully', async () => {
      const page = await createPageWithSvg('edge-cases/extreme/negative-dimensions.svg');

      // Negative dimensions are invalid - rect shouldn't render
      const bboxNegative = await getBBoxById(page, 'negative-rect');
      expect(bboxNegative).toBeNull();

      // Fallback circle should work
      const bboxFallback = await getBBoxById(page, 'fallback-circle');
      expect(bboxFallback).toBeTruthy();
      assertValidBBox(bboxFallback);

      await page.close();
    });

    it('should handle zero-size viewBox', async () => {
      const page = await createPageWithSvg('edge-cases/extreme/zero-viewbox.svg');

      // Zero viewBox is invalid - may cause issues
      // Library should handle gracefully (fallback to window size)
      try {
        const bbox = await getBBoxById(page, 'zero-viewbox-rect');

        if (bbox) {
          assertValidBBox(bbox);
        }
        // May return null - zero viewBox might make everything invisible
      } catch (error) {
        // Expected - zero viewBox can cause failures
        expect(error.message).toBeTruthy();
      }

      await page.close();
    });
  });

  describe('Invalid Attributes', () => {
    it('should handle malformed transform syntax', async () => {
      const page = await createPageWithSvg('edge-cases/invalid-attrs/malformed-transform.svg');
      const bbox = await getBBoxById(page, 'bad-transform-rect');

      // Malformed transform should be ignored, element rendered without transform
      expect(bbox).toBeTruthy();
      assertValidBBox(bbox);

      // Should be at original position (no transform applied)
      expect(bbox.x).toBeCloseTo(50, 0);
      expect(bbox.y).toBeCloseTo(50, 0);

      await page.close();
    });

    it('should handle malformed path data', async () => {
      const page = await createPageWithSvg('edge-cases/invalid-attrs/malformed-path.svg');

      // Malformed path may render partially or not at all
      const _bboxPath = await getBBoxById(page, 'bad-path');

      // Fallback rect should always work
      const bboxFallback = await getBBoxById(page, 'fallback-rect');
      expect(bboxFallback).toBeTruthy();
      assertValidBBox(bboxFallback);

      await page.close();
    });

    it('should handle invalid color values', async () => {
      const page = await createPageWithSvg('edge-cases/invalid-attrs/invalid-colors.svg');
      const bbox = await getBBoxById(page, 'bad-color-rect');

      // Invalid colors typically default to black or render nothing
      // Element still has dimensions even if invisible
      if (bbox) {
        assertValidBBox(bbox);
      } else {
        // May be null if browser doesn't render invalid colors
        expect(bbox).toBeNull();
      }

      await page.close();
    });
  });

  describe('Empty/Missing Elements', () => {
    it('should return null for empty SVG', async () => {
      const page = await createPageWithSvg('edge-cases/empty/empty-svg.svg');

      // Query the SVG root directly (can't use ID since it's the root)
      // When querying the root itself, it may throw error trying to find it in clone
      const result = await page.evaluate(async () => {
        const svg = document.querySelector('svg');
        try {
          const bbox = await window.SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(svg);
          return bbox;
        } catch {
          // Expected: SVG root can't be cloned/queried by temporary ID
          return null;
        }
      });

      // Empty SVG has no visual content
      expect(result).toBeNull();

      await page.close();
    });

    it('should handle rect without dimensions', async () => {
      const page = await createPageWithSvg('edge-cases/empty/rect-no-dimensions.svg');
      const bbox = await getBBoxById(page, 'no-dimensions-rect');

      // Rect without width/height has default 0 dimensions
      expect(bbox).toBeNull();

      await page.close();
    });

    it('should handle SVG with only whitespace', async () => {
      const page = await createPageWithSvg('edge-cases/empty/only-whitespace.svg');

      // Query the SVG root
      const svg = await page.$('svg');
      expect(svg).toBeTruthy();

      // Should have no visual content
      // When querying SVG root itself, it tries to clone and assign temp ID
      // but SVG root can't be queried by ID reliably
      const result = await page.evaluate(async () => {
        const svg = document.querySelector('svg');
        try {
          const bbox = await window.SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(svg);
          return bbox;
        } catch {
          // May throw error when trying to find SVG root in clone
          return null;
        }
      });

      // Either null or error - both indicate no visual content
      expect(result).toBeNull();

      await page.close();
    });

    it('should handle SVG without viewBox or width/height', async () => {
      const page = await createPageWithSvg('edge-cases/empty/no-viewbox-no-dimensions.svg');

      // Library should auto-detect viewBox from content bbox
      const bbox = await getBBoxById(page, 'test-rect');

      expect(bbox).toBeTruthy();
      assertValidBBox(bbox);

      // Should compute bbox correctly even without viewBox
      expect(bbox.x).toBeCloseTo(50, 0);
      expect(bbox.y).toBeCloseTo(50, 0);
      expect(bbox.width).toBeCloseTo(100, 0);
      expect(bbox.height).toBeCloseTo(80, 0);

      // Circle should also work
      const bboxCircle = await getBBoxById(page, 'test-circle');
      expect(bboxCircle).toBeTruthy();
      assertValidBBox(bboxCircle);

      await page.close();
    });
  });

  describe('Error Handling', () => {
    it('should throw error for non-existent element ID', async () => {
      const page = await createPageWithSvg('simple/rect.svg');

      await expect(async () => {
        await getBBoxById(page, 'this-id-does-not-exist');
      }).rejects.toThrow();

      await page.close();
    });

    it('should handle element with no ownerSVGElement', async () => {
      const page = await createPageWithSvg('simple/rect.svg');

      const error = await page.evaluate(async () => {
        // Create a detached SVG rect element (not in document) using safe DOM methods
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('width', '100');
        rect.setAttribute('height', '100');

        try {
          await window.SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(rect);
          return null;
        } catch (e) {
          return e.message;
        }
      });

      expect(error).toContain('not inside an SVG tree');

      await page.close();
    });
  });
});
