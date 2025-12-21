/**
 * Unit tests for getSvgElementVisualBBoxTwoPassAggressive
 *
 * Tests the core two-pass rasterization algorithm that provides
 * high-accuracy visual bounding boxes.
 */

import { describe, it, expect, afterAll } from 'vitest';
import {
  createPageWithSvg,
  getBBoxById,
  closeBrowser,
  assertValidBBox
} from '../helpers/browser-test.js';

describe('getSvgElementVisualBBoxTwoPassAggressive', () => {
  afterAll(async () => {
    await closeBrowser();
  });

  describe('Simple shapes (baseline)', () => {
    it('should compute bbox for a simple rectangle', async () => {
      const page = await createPageWithSvg('simple/rect.svg');
      const bbox = await getBBoxById(page, 'test-rect');

      expect(bbox).toBeTruthy();
      assertValidBBox(bbox);

      // Rectangle at x=50, y=50, width=100, height=80
      expect(bbox.x).toBeCloseTo(50, 0);
      expect(bbox.y).toBeCloseTo(50, 0);
      expect(bbox.width).toBeCloseTo(100, 0);
      expect(bbox.height).toBeCloseTo(80, 0);

      await page.close();
    });

    it('should compute bbox for a simple circle', async () => {
      const page = await createPageWithSvg('simple/circle.svg');
      const bbox = await getBBoxById(page, 'test-circle');

      expect(bbox).toBeTruthy();
      assertValidBBox(bbox);

      // Circle at cx=100, cy=100, r=50 → bbox should be centered at 100 with size ~100x100
      expect(bbox.x).toBeCloseTo(50, 0);
      expect(bbox.y).toBeCloseTo(50, 0);
      expect(bbox.width).toBeCloseTo(100, 0);
      expect(bbox.height).toBeCloseTo(100, 0);

      await page.close();
    });

    it('should compute bbox for a simple path', async () => {
      const page = await createPageWithSvg('simple/path.svg');
      const bbox = await getBBoxById(page, 'test-path');

      expect(bbox).toBeTruthy();
      assertValidBBox(bbox);

      // Diamond path from 50 to 150 in both x and y
      expect(bbox.x).toBeCloseTo(50, 0);
      expect(bbox.y).toBeCloseTo(50, 0);
      expect(bbox.width).toBeCloseTo(100, 0);
      expect(bbox.height).toBeCloseTo(100, 0);

      await page.close();
    });
  });

  describe('Groups and transforms', () => {
    it('should compute bbox for elements inside a transformed group', async () => {
      const page = await createPageWithSvg('simple/group.svg');
      // Test the rect inside the group instead of the group itself
      const bbox = await getBBoxById(page, 'rect-in-group');

      expect(bbox).toBeTruthy();
      assertValidBBox(bbox);

      // Rect at x=30, y=30 with group transform translate(20,20)
      // The bbox is calculated from actual rendered pixels, which includes the transform.
      // Ancestor transforms are removed during cloning to prevent double-application,
      // so the bbox reflects the element's position AS RENDERED (with transforms applied).
      expect(bbox.x).toBeCloseTo(50, 0); // 30 + 20 (transform)
      expect(bbox.y).toBeCloseTo(50, 0); // 30 + 20 (transform)
      expect(bbox.width).toBeCloseTo(60, 1);
      expect(bbox.height).toBeCloseTo(40, 1);

      await page.close();
    });

    it('should compute bbox for rotated element', async () => {
      const page = await createPageWithSvg('transforms/rotation.svg');
      const bbox = await getBBoxById(page, 'rotated-rect');

      expect(bbox).toBeTruthy();
      assertValidBBox(bbox);

      // Rotated 45° → diagonal dimension increases
      expect(bbox.width).toBeGreaterThan(100);
      expect(bbox.height).toBeGreaterThan(60);

      await page.close();
    });

    it('should compute bbox for deeply nested transformed groups', async () => {
      const page = await createPageWithSvg('transforms/nested-groups.svg');
      const bbox = await getBBoxById(page, 'deeply-nested-rect');

      expect(bbox).toBeTruthy();
      assertValidBBox(bbox);

      await page.close();
    });
  });

  describe('Text elements', () => {
    it('should compute bbox for CJK text', async () => {
      // WHY pageTimeoutMs 60000: CJK fonts are large and may take longer to load.
      // In CI with parallel tests, the default 30s timeout can be exceeded.
      const page = await createPageWithSvg('text/cjk.svg', { pageTimeoutMs: 60000 });
      const bbox = await getBBoxById(page, 'cjk-text', { fontTimeoutMs: 5000 });

      expect(bbox).toBeTruthy();
      assertValidBBox(bbox);

      // CJK text should have substantial width and height
      expect(bbox.width).toBeGreaterThan(100);
      expect(bbox.height).toBeGreaterThan(30);

      await page.close();
    }, 60000); // WHY 60s: CJK font loading can be slow in CI with parallel tests

    it('should compute bbox for Arabic RTL text', async () => {
      // WHY pageTimeoutMs 60000: Arabic fonts and RTL shaping may take longer to load.
      // In CI with parallel tests, the default 30s timeout can be exceeded.
      const page = await createPageWithSvg('text/arabic-rtl.svg', { pageTimeoutMs: 60000 });
      const bbox = await getBBoxById(page, 'arabic-text', { fontTimeoutMs: 5000 });

      expect(bbox).toBeTruthy();
      assertValidBBox(bbox);

      expect(bbox.width).toBeGreaterThan(50);
      expect(bbox.height).toBeGreaterThan(20);

      await page.close();
    }, 60000); // WHY 60s: Arabic RTL font loading can be slow in CI with parallel tests

    it('should compute bbox for text with ligatures', async () => {
      const page = await createPageWithSvg('text/ligatures.svg');
      const bbox = await getBBoxById(page, 'ligatures-text');

      expect(bbox).toBeTruthy();
      assertValidBBox(bbox);

      await page.close();
    });

    it('should compute bbox for text on path', async () => {
      const page = await createPageWithSvg('text/textpath.svg');
      const bbox = await getBBoxById(page, 'text-on-path');

      expect(bbox).toBeTruthy();
      assertValidBBox(bbox);

      // Text following curved path
      expect(bbox.width).toBeGreaterThan(100);

      await page.close();
    });

    it('should compute bbox for nested tspan elements', async () => {
      const page = await createPageWithSvg('text/tspan-nested.svg');
      const bbox = await getBBoxById(page, 'nested-tspan');

      expect(bbox).toBeTruthy();
      assertValidBBox(bbox);

      // Multiple lines with different styles
      expect(bbox.height).toBeGreaterThan(60); // Two lines

      await page.close();
    });
  });

  describe('Filters (bbox extension)', () => {
    it('should extend bbox for blurred element', async () => {
      const page = await createPageWithSvg('filters/blur-10px.svg');

      // Get bbox without considering the blur would be wrong
      // The two-pass algorithm should catch the filter extension
      const bbox = await getBBoxById(page, 'blurred-rect');

      expect(bbox).toBeTruthy();
      assertValidBBox(bbox);

      // Blur 10px extends bbox by ~30px (3 * stdDeviation) on each side
      // Original rect: x=100, y=100, width=100, height=80
      // With blur, should be larger
      expect(bbox.width).toBeGreaterThan(100);
      expect(bbox.height).toBeGreaterThan(80);
      expect(bbox.x).toBeLessThan(100);
      expect(bbox.y).toBeLessThan(100);

      await page.close();
    });

    it('should extend bbox for drop shadow', async () => {
      const page = await createPageWithSvg('filters/drop-shadow.svg');
      const bbox = await getBBoxById(page, 'shadowed-circle');

      expect(bbox).toBeTruthy();
      assertValidBBox(bbox);

      // Shadow offset dx=10, dy=10 should extend bbox
      // Original circle: cx=150, cy=150, r=50 → bbox 100-200
      // With shadow should extend to the right and bottom
      expect(bbox.x + bbox.width).toBeGreaterThan(200);
      expect(bbox.y + bbox.height).toBeGreaterThan(200);

      await page.close();
    });

    it('should handle complex filter chain', async () => {
      const page = await createPageWithSvg('filters/filter-chain.svg');
      const bbox = await getBBoxById(page, 'complex-filtered-path');

      expect(bbox).toBeTruthy();
      assertValidBBox(bbox);

      // Complex filter: blur + offset + dilate
      expect(bbox.width).toBeGreaterThan(0);
      expect(bbox.height).toBeGreaterThan(0);

      await page.close();
    });
  });

  describe('Strokes (bbox extension)', () => {
    it('should extend bbox for thick stroke', async () => {
      const page = await createPageWithSvg('stroke/thick-stroke.svg');
      const bbox = await getBBoxById(page, 'thick-stroke-path');

      expect(bbox).toBeTruthy();
      assertValidBBox(bbox);

      // Line from (50,150) to (250,150) with stroke-width=50
      // Should extend 25px above and below the line
      expect(bbox.height).toBeCloseTo(50, 0);
      expect(bbox.y).toBeCloseTo(125, 0); // 150 - 25

      await page.close();
    });

    it('should include markers in bbox', async () => {
      const page = await createPageWithSvg('stroke/markers.svg');
      const bbox = await getBBoxById(page, 'path-with-markers');

      expect(bbox).toBeTruthy();
      assertValidBBox(bbox);

      // Path with markers at start, mid, and end
      // Markers extend beyond the path itself
      expect(bbox.width).toBeGreaterThan(0);
      expect(bbox.height).toBeGreaterThan(0);

      await page.close();
    });

    it('should handle non-scaling stroke', async () => {
      const page = await createPageWithSvg('stroke/non-scaling.svg');
      const bbox = await getBBoxById(page, 'non-scaling-stroke-path', {
        useLayoutScale: true
      });

      expect(bbox).toBeTruthy();
      assertValidBBox(bbox);

      await page.close();
    });
  });

  describe('Use and defs', () => {
    it('should compute bbox for <use> element', async () => {
      const page = await createPageWithSvg('use-defs/use-symbol.svg');
      const bbox = await getBBoxById(page, 'star-instance-1');

      expect(bbox).toBeTruthy();
      assertValidBBox(bbox);

      // Use at x=50, y=50, width=100, height=100
      // Star path has some internal margins, so bbox might not be exactly at 50,50
      expect(bbox.x).toBeGreaterThanOrEqual(50);
      expect(bbox.x).toBeLessThanOrEqual(60);
      expect(bbox.y).toBeGreaterThanOrEqual(50);
      expect(bbox.y).toBeLessThanOrEqual(60);
      expect(bbox.width).toBeGreaterThan(80);
      expect(bbox.width).toBeLessThanOrEqual(100);
      expect(bbox.height).toBeGreaterThan(80);
      expect(bbox.height).toBeLessThanOrEqual(100);

      await page.close();
    });

    it('should compute bbox for element with gradient fill', async () => {
      const page = await createPageWithSvg('use-defs/gradients.svg');
      const bbox1 = await getBBoxById(page, 'linear-rect');
      const bbox2 = await getBBoxById(page, 'radial-circle');

      expect(bbox1).toBeTruthy();
      assertValidBBox(bbox1);

      expect(bbox2).toBeTruthy();
      assertValidBBox(bbox2);

      await page.close();
    });
  });

  describe('Edge cases', () => {
    it('should return null for fully transparent element', async () => {
      const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
          <rect id="transparent" x="50" y="50" width="100" height="80" fill-opacity="0" fill="#000"/>
        </svg>`;

      const page = await createPageWithSvg(svg);
      const bbox = await getBBoxById(page, 'transparent');

      expect(bbox).toBeNull();

      await page.close();
    });

    it('should return null for element with display:none', async () => {
      const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
          <rect id="hidden" x="50" y="50" width="100" height="80" fill="#000" display="none"/>
        </svg>`;

      const page = await createPageWithSvg(svg);
      const bbox = await getBBoxById(page, 'hidden');

      expect(bbox).toBeNull();

      await page.close();
    });

    it('should handle element fully clipped by viewBox in clipped mode', async () => {
      const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
          <rect id="outside" x="200" y="200" width="50" height="50" fill="#000"/>
        </svg>`;

      const page = await createPageWithSvg(svg);
      const bbox = await getBBoxById(page, 'outside', { mode: 'clipped' });

      expect(bbox).toBeNull();

      await page.close();
    });

    it('should find element outside viewBox in unclipped mode', async () => {
      const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
          <rect id="outside" x="200" y="200" width="50" height="50" fill="#000"/>
        </svg>`;

      const page = await createPageWithSvg(svg);
      const bbox = await getBBoxById(page, 'outside', { mode: 'unclipped' });

      expect(bbox).toBeTruthy();
      assertValidBBox(bbox);
      expect(bbox.x).toBeCloseTo(200, 1);
      expect(bbox.y).toBeCloseTo(200, 1);

      await page.close();
    });
  });

  describe('Options', () => {
    it('should respect coarseFactor and fineFactor', async () => {
      const page = await createPageWithSvg('simple/rect.svg');

      const bbox1 = await getBBoxById(page, 'test-rect', {
        coarseFactor: 1,
        fineFactor: 4
      });

      const bbox2 = await getBBoxById(page, 'test-rect', {
        coarseFactor: 3,
        fineFactor: 24
      });

      // Both should return valid results, bbox2 might be slightly more accurate
      expect(bbox1).toBeTruthy();
      expect(bbox2).toBeTruthy();
      assertValidBBox(bbox1);
      assertValidBBox(bbox2);

      await page.close();
    });

    it('should use safetyMarginUser when provided', async () => {
      const page = await createPageWithSvg('simple/rect.svg');

      const bbox = await getBBoxById(page, 'test-rect', {
        safetyMarginUser: 50 // Large safety margin
      });

      expect(bbox).toBeTruthy();
      assertValidBBox(bbox);

      await page.close();
    });
  });
});
