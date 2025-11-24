/**
 * Test Helpers for E2E Tests
 *
 * Shared utilities for setViewBoxOnObjects and showTrueBBoxBorder tests.
 * Provides consistent edge case handling, coordinate transformations,
 * and viewBox manipulation helpers.
 */

// Test configuration constants
export const TEST_CONFIG = {
  // Standard SVG dimensions for test cases
  VIEWBOX_WIDTH: 400,
  VIEWBOX_HEIGHT: 300,
  SCREEN_WIDTH: 800,
  SCREEN_HEIGHT: 600,

  // Negative viewBox offsets (for centered coordinate system)
  VIEWBOX_OFFSET_X: -200,
  VIEWBOX_OFFSET_Y: -150,

  // Test tolerance values
  ASPECT_RATIO_TOLERANCE: 0.01,
  POSITION_TOLERANCE: 5,
  SIZE_TOLERANCE: 2,

  // Thresholds
  MIN_POSITION_CHANGE: 50,
};

/**
 * Generates a deterministic symbol ID for sprite sheet tests.
 * Uses a counter instead of Date.now() for reproducibility.
 *
 * @param {string} baseId - Base identifier for the symbol
 * @param {number} index - Sequential index for uniqueness
 * @returns {string} Deterministic symbol ID
 */
let symbolCounter = 0;
export function generateSymbolId(baseId, index) {
  return `symbol_${baseId}_${index}_${symbolCounter++}`;
}

/**
 * Resets the symbol counter (for test isolation).
 */
export function resetSymbolCounter() {
  symbolCounter = 0;
}

/**
 * Transforms SVG content coordinates for negative viewBox testing.
 * Adjusts x, y, cx, cy attributes and rotate() transforms.
 *
 * @param {string} content - SVG content markup
 * @param {number} offsetX - X-axis offset
 * @param {number} offsetY - Y-axis offset
 * @returns {string} Transformed SVG content
 */
export function transformCoordinates(content, offsetX, offsetY) {
  let transformed = content;

  // Transform x and cx attributes
  transformed = transformed.replace(
    /(<\w+[^>]*?\s+)(x|cx)="([^"]+)"/g,
    (match, prefix, attr, value) => {
      const newVal = parseFloat(value) + offsetX;
      return `${prefix}${attr}="${newVal}"`;
    }
  );

  // Transform y and cy attributes
  transformed = transformed.replace(
    /(<\w+[^>]*?\s+)(y|cy)="([^"]+)"/g,
    (match, prefix, attr, value) => {
      const newVal = parseFloat(value) + offsetY;
      return `${prefix}${attr}="${newVal}"`;
    }
  );

  // Transform rotate() transform coordinates: rotate(angle x y) -> rotate(angle x+offsetX y+offsetY)
  transformed = transformed.replace(
    /rotate\(([^\s]+)\s+([^\s]+)\s+([^\)]+)\)/g,
    (match, angle, x, y) => {
      const newX = parseFloat(x) + offsetX;
      const newY = parseFloat(y) + offsetY;
      return `rotate(${angle} ${newX} ${newY})`;
    }
  );

  return transformed;
}

/**
 * Extracts viewBox dimensions with fallback to width/height attributes
 * or bounding box. Handles SVGs with missing viewBox attributes.
 *
 * @param {SVGSVGElement} svg - SVG element
 * @returns {{x: number, y: number, width: number, height: number}} ViewBox object
 */
export function getViewBoxWithFallback(svg) {
  const vb = svg.viewBox.baseVal;
  const viewBox = {
    x: vb.x || 0,
    y: vb.y || 0,
    width: vb.width || parseFloat(svg.getAttribute('width')) || 0,
    height: vb.height || parseFloat(svg.getAttribute('height')) || 0
  };

  // Final fallback: use bounding box
  if (viewBox.width === 0 || viewBox.height === 0) {
    const rect = svg.getBoundingClientRect();
    viewBox.width = rect.width;
    viewBox.height = rect.height;
  }

  return viewBox;
}

/**
 * Generates the testViewBox browser function as a string for HTML embedding.
 * This function will be executed in the browser context.
 *
 * @returns {string} JavaScript function code
 */
export function generateTestViewBoxFunction() {
  return `
    // Helper: Extract viewBox with fallbacks
    function getViewBoxWithFallback(svg) {
      const vb = svg.viewBox.baseVal;
      const viewBox = {
        x: vb.x || 0,
        y: vb.y || 0,
        width: vb.width || parseFloat(svg.getAttribute('width')) || 0,
        height: vb.height || parseFloat(svg.getAttribute('height')) || 0
      };

      if (viewBox.width === 0 || viewBox.height === 0) {
        const rect = svg.getBoundingClientRect();
        viewBox.width = rect.width;
        viewBox.height = rect.height;
      }

      return viewBox;
    }

    // Main test function
    window.testViewBox = async function(svgId, elementId, options = {}) {
      try {
        const svg = document.getElementById(svgId);
        if (!svg) throw new Error('SVG not found: ' + svgId);

        // Get old viewBox using helper
        const oldViewBox = getViewBoxWithFallback(svg);

        // Call setViewBoxOnObjects
        await SvgVisualBBox.waitForDocumentFonts();
        const result = await SvgVisualBBox.setViewBoxOnObjects(svgId, elementId, options);

        // Get new viewBox using helper
        const actualViewBox = getViewBoxWithFallback(svg);

        return {
          success: true,
          oldViewBox: oldViewBox,
          actualViewBox: actualViewBox,
          expectedViewBox: result.newViewBox,
          bbox: result.bbox,
          restore: result.restore
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    };
  `.trim();
}

/**
 * Validation helper: Check if aspect ratio is preserved.
 *
 * @param {Object} result - Test result with oldViewBox and actualViewBox
 * @param {Object} expect - Playwright expect object
 */
export function validateAspectRatioPreserved(result, expect) {
  const oldAspect = result.oldViewBox.width / result.oldViewBox.height;
  const newAspect = result.actualViewBox.width / result.actualViewBox.height;
  expect(newAspect).toBeCloseTo(oldAspect, TEST_CONFIG.ASPECT_RATIO_TOLERANCE);
}

/**
 * Validation helper: Check if viewBox dimensions match old dimensions.
 *
 * @param {Object} result - Test result with oldViewBox and actualViewBox
 * @param {Object} expect - Playwright expect object
 */
export function validateDimensionsUnchanged(result, expect) {
  expect(result.actualViewBox.width).toBeCloseTo(
    result.oldViewBox.width,
    TEST_CONFIG.SIZE_TOLERANCE
  );
  expect(result.actualViewBox.height).toBeCloseTo(
    result.oldViewBox.height,
    TEST_CONFIG.SIZE_TOLERANCE
  );
}

/**
 * Validation helper: Check if viewBox matches bbox (stretch mode).
 *
 * @param {Object} result - Test result with actualViewBox and bbox
 * @param {Object} expect - Playwright expect object
 */
export function validateStretchMode(result, expect) {
  expect(result.actualViewBox.width).toBeGreaterThan(
    result.bbox.width - TEST_CONFIG.SIZE_TOLERANCE
  );
  expect(result.actualViewBox.height).toBeGreaterThan(
    result.bbox.height - TEST_CONFIG.SIZE_TOLERANCE
  );
}
