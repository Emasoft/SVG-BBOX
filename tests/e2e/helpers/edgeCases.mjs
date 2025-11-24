/**
 * Edge Case Generators for SVG Tests
 *
 * Provides 5 structural variations of SVG markup to ensure functions
 * handle all common real-world SVG configurations.
 */

import { TEST_CONFIG, transformCoordinates, generateSymbolId } from './testHelpers.mjs';

/**
 * Edge case generators - each wraps content in a different SVG structure.
 *
 * Structure:
 * - name: Human-readable description
 * - generateSVG: Function that wraps content in appropriate SVG wrapper
 * - getTargetId: (Optional) Function to transform element ID for testing
 */
export const edgeCases = {
  /**
   * Normal case: SVG with both viewBox and resolution attributes
   */
  normal: {
    name: 'Normal (with viewBox)',
    generateSVG: (content, id) => {
      return `<svg id="svg_${id}" viewBox="0 0 ${TEST_CONFIG.VIEWBOX_WIDTH} ${TEST_CONFIG.VIEWBOX_HEIGHT}" width="${TEST_CONFIG.SCREEN_WIDTH}" height="${TEST_CONFIG.SCREEN_HEIGHT}">${content}</svg>`;
    }
  },

  /**
   * No viewBox: SVG with only width/height attributes
   * Tests fallback to screen dimensions
   */
  noViewBox: {
    name: 'No viewBox (only width/height)',
    generateSVG: (content, id) => {
      return `<svg id="svg_${id}" width="${TEST_CONFIG.VIEWBOX_WIDTH}" height="${TEST_CONFIG.VIEWBOX_HEIGHT}">${content}</svg>`;
    }
  },

  /**
   * No resolution: SVG with only viewBox attribute
   * Tests default rendering size handling
   */
  noResolution: {
    name: 'No resolution (only viewBox)',
    generateSVG: (content, id) => {
      return `<svg id="svg_${id}" viewBox="0 0 ${TEST_CONFIG.VIEWBOX_WIDTH} ${TEST_CONFIG.VIEWBOX_HEIGHT}">${content}</svg>`;
    }
  },

  /**
   * Negative viewBox: SVG with negative origin coordinates
   * Tests centered coordinate systems
   */
  negativeViewBox: {
    name: 'Negative viewBox coordinates',
    generateSVG: (content, id) => {
      // Transform content coordinates to match negative viewBox origin
      const transformedContent = transformCoordinates(
        content,
        TEST_CONFIG.VIEWBOX_OFFSET_X,
        TEST_CONFIG.VIEWBOX_OFFSET_Y
      );

      return `<svg id="svg_${id}" viewBox="${TEST_CONFIG.VIEWBOX_OFFSET_X} ${TEST_CONFIG.VIEWBOX_OFFSET_Y} ${TEST_CONFIG.VIEWBOX_WIDTH} ${TEST_CONFIG.VIEWBOX_HEIGHT}" width="${TEST_CONFIG.SCREEN_WIDTH}" height="${TEST_CONFIG.SCREEN_HEIGHT}">${transformedContent}</svg>`;
    }
  },

  /**
   * Sprite sheet: SVG using <symbol> and <use> elements
   * Tests symbol/instance pattern common in icon systems
   */
  spriteSheet: {
    name: 'Sprite sheet with <use>',
    generateSVG: (content, id, index = 0) => {
      // Use deterministic symbol ID for reproducible tests
      const symbolId = generateSymbolId(id, index);
      const useId = `use_${id}`;

      return `<svg id="svg_${id}" viewBox="0 0 ${TEST_CONFIG.VIEWBOX_WIDTH} ${TEST_CONFIG.VIEWBOX_HEIGHT}" width="${TEST_CONFIG.SCREEN_WIDTH}" height="${TEST_CONFIG.SCREEN_HEIGHT}">
        <defs>
          <symbol id="${symbolId}" viewBox="0 0 ${TEST_CONFIG.VIEWBOX_WIDTH} ${TEST_CONFIG.VIEWBOX_HEIGHT}">${content}</symbol>
        </defs>
        <use id="${useId}" href="#${symbolId}" x="0" y="0" width="${TEST_CONFIG.VIEWBOX_WIDTH}" height="${TEST_CONFIG.VIEWBOX_HEIGHT}"/>
      </svg>`;
    },
    /**
     * For sprite sheets, we test the <use> element instead of the content element.
     * Transforms elem_* ID to use_* ID.
     *
     * @param {string} baseId - Original element ID (e.g., "elem_spriteSheet_0")
     * @returns {string} Use element ID (e.g., "use_spriteSheet_0")
     */
    getTargetId: (baseId) => baseId.replace(/^elem_/, 'use_')
  }
};

/**
 * Get list of all edge case keys for iteration.
 *
 * @returns {string[]} Array of edge case keys
 */
export function getEdgeCaseKeys() {
  return Object.keys(edgeCases);
}

/**
 * Get total number of edge cases.
 *
 * @returns {number} Count of edge cases
 */
export function getEdgeCaseCount() {
  return Object.keys(edgeCases).length;
}
