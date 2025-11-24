/**
 * setViewBoxOnObjects() E2E Tests
 *
 * Tests the setViewBoxOnObjects() function with edge case variations.
 * Applies 5 edge cases to ALL test scenarios for comprehensive coverage.
 *
 * Edge Cases:
 * 1. Normal (baseline with viewBox)
 * 2. No viewBox (only width/height)
 * 3. No resolution (only viewBox)
 * 4. Negative viewBox coordinates
 * 5. Sprite sheet with <use> element
 */

import playwright from '@playwright/test';
const { test, expect } = playwright;
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { edgeCases, getEdgeCaseKeys } from './helpers/edgeCases.mjs';
import { generateSetViewBoxTestPage } from './helpers/htmlGenerator.mjs';
import {
  TEST_CONFIG,
  validateAspectRatioPreserved,
  validateDimensionsUnchanged,
  validateStretchMode,
  resetSymbolCounter
} from './helpers/testHelpers.mjs';

// Use platform-agnostic temp directory
const testPagePath = path.join(os.tmpdir(), 'setViewBoxOnObjects_test.html');

/**
 * Base test scenarios - each defines content generation and validation logic.
 *
 * Each scenario tests a specific setViewBoxOnObjects option or combination.
 * Scenarios are cross-multiplied with all 5 edge cases for comprehensive coverage.
 */
const baseScenarios = [
  {
    name: 'Stretch mode: single element',
    generateContent: (id) => {
      return `<circle id="${id}" cx="200" cy="150" r="50" fill="#e74c3c"/>`;
    },
    options: { aspect: 'stretch' },
    validate: (result) => {
      expect(result.success).toBe(true);
      validateStretchMode(result, expect);
    }
  },
  {
    name: 'Stretch with margin (user units)',
    generateContent: (id) => {
      return `<rect id="${id}" x="150" y="100" width="100" height="80" fill="#3498db"/>`;
    },
    options: { aspect: 'stretch', margin: 20 },
    validate: (result) => {
      expect(result.success).toBe(true);
      // ViewBox should be bbox + margin*2 on each side
      expect(result.actualViewBox.width).toBeCloseTo(result.bbox.width + 40, 1);
      expect(result.actualViewBox.height).toBeCloseTo(result.bbox.height + 40, 1);
    }
  },
  {
    name: 'ChangePosition mode',
    generateContent: (id) => {
      // Place element far from center to ensure detectable position change
      return `<text id="${id}" x="50" y="50" font-size="24" text-anchor="middle" fill="#2c3e50">Test</text>`;
    },
    options: { aspect: 'changePosition' },
    validate: (result) => {
      expect(result.success).toBe(true);
      // ViewBox dimensions should remain unchanged
      validateDimensionsUnchanged(result, expect);
      // Position should change significantly (element placed far from center)
      const positionChange = Math.sqrt(
        Math.pow(result.actualViewBox.x - result.oldViewBox.x, 2) +
        Math.pow(result.actualViewBox.y - result.oldViewBox.y, 2)
      );
      expect(positionChange).toBeGreaterThan(TEST_CONFIG.MIN_POSITION_CHANGE);
    }
  },
  {
    name: 'PreserveAspectRatio (meet)',
    generateContent: (id) => {
      return `<circle id="${id}" cx="200" cy="150" r="40" fill="#9b59b6"/>`;
    },
    options: { aspect: 'preserveAspectRatio', aspectRatioMode: 'meet', align: 'xMidYMid' },
    validate: (result) => {
      expect(result.success).toBe(true);
      validateAspectRatioPreserved(result, expect);
      // ViewBox should encompass the bbox
      expect(result.actualViewBox.width).toBeGreaterThanOrEqual(
        result.bbox.width - TEST_CONFIG.SIZE_TOLERANCE
      );
      expect(result.actualViewBox.height).toBeGreaterThanOrEqual(
        result.bbox.height - TEST_CONFIG.SIZE_TOLERANCE
      );
    }
  },
  {
    name: 'PreserveAspectRatio (slice)',
    generateContent: (id) => {
      return `<rect id="${id}" x="180" y="130" width="40" height="40" fill="#1abc9c"/>`;
    },
    options: { aspect: 'preserveAspectRatio', aspectRatioMode: 'slice', align: 'xMidYMid' },
    validate: (result) => {
      expect(result.success).toBe(true);
      validateAspectRatioPreserved(result, expect);
    }
  },
  {
    name: 'Alignment xMinYMin',
    generateContent: (id) => {
      return `<circle id="${id}" cx="100" cy="80" r="30" fill="#e67e22"/>`;
    },
    options: { aspect: 'preserveAspectRatio', aspectRatioMode: 'meet', align: 'xMinYMin' },
    validate: (result) => {
      expect(result.success).toBe(true);
      // Element bbox should be positioned at top-left of viewBox
      expect(result.actualViewBox.x).toBeCloseTo(result.bbox.x, TEST_CONFIG.POSITION_TOLERANCE);
      expect(result.actualViewBox.y).toBeCloseTo(result.bbox.y, TEST_CONFIG.POSITION_TOLERANCE);
    }
  },
  {
    name: 'Visibility hideAllExcept',
    generateContent: (id) => {
      return `<circle id="${id}" cx="200" cy="150" r="40" fill="#27ae60"/>
              <rect id="other_${id}" x="50" y="50" width="50" height="50" fill="#c0392b"/>`;
    },
    options: { aspect: 'stretch', visibility: 'hideAllExcept' },
    validate: async (result, page) => {
      expect(result.success).toBe(true);
      // Verify that other elements are hidden
      const hiddenCount = await page.evaluate(() => {
        const allElements = document.querySelectorAll('[id]');
        let hidden = 0;
        allElements.forEach(el => {
          const style = window.getComputedStyle(el);
          if (style.display === 'none') hidden++;
        });
        return hidden;
      });
      expect(hiddenCount).toBeGreaterThanOrEqual(1);
    }
  },
  {
    name: 'Dry-run mode',
    generateContent: (id) => {
      return `<circle id="${id}" cx="200" cy="150" r="50" fill="#34495e"/>`;
    },
    options: { aspect: 'stretch', dryRun: true },
    validate: (result) => {
      expect(result.success).toBe(true);
      // In dry-run mode, viewBox should remain unchanged
      expect(result.actualViewBox.x).toBe(result.oldViewBox.x);
      expect(result.actualViewBox.y).toBe(result.oldViewBox.y);
      expect(result.actualViewBox.width).toBe(result.oldViewBox.width);
      expect(result.actualViewBox.height).toBe(result.oldViewBox.height);
    }
  }
];

/**
 * Test setup: Generate HTML test page before running tests.
 * Uses platform-agnostic temp directory and proper error handling.
 */
test.beforeAll(async () => {
  // Reset symbol counter for deterministic test data
  resetSymbolCounter();

  // Check if test page already exists
  try {
    await fs.access(testPagePath);
    console.log(`Test page already exists: ${testPagePath}`);
    return;
  } catch (error) {
    // File doesn't exist, continue to create it
    if (error.code !== 'ENOENT') {
      // Unexpected error accessing file
      throw new Error(`Failed to check test page: ${error.message}`);
    }
  }

  try {
    // Generate HTML test page
    const html = generateSetViewBoxTestPage(edgeCases, baseScenarios);
    await fs.writeFile(testPagePath, html, 'utf8');
    console.log(`Test page generated: ${testPagePath}`);
    console.log(`Total test combinations: ${getEdgeCaseKeys().length * baseScenarios.length}`);
  } catch (error) {
    throw new Error(`Failed to generate test page: ${error.message}`);
  }
});

/**
 * Test cleanup: Let OS handle temp file cleanup (no explicit deletion needed).
 */
test.afterAll(async () => {
  // OS will clean up temp directory - no explicit cleanup needed
});

/**
 * Main test suite: setViewBoxOnObjects() comprehensive edge case testing.
 *
 * Tests are generated dynamically by cross-multiplying edge cases with scenarios.
 * Uses serial mode to avoid race conditions with shared browser state.
 */
test.describe('setViewBoxOnObjects() - Comprehensive Edge Case Tests', () => {
  test.describe.configure({ mode: 'serial' });

  // Generate tests for each edge case × scenario combination
  for (const edgeKey of getEdgeCaseKeys()) {
    const edge = edgeCases[edgeKey];

    test.describe(`Edge Case: ${edge.name}`, () => {
      for (let scenarioIdx = 0; scenarioIdx < baseScenarios.length; scenarioIdx++) {
        const scenario = baseScenarios[scenarioIdx];

        test(`${scenario.name}`, async ({ page }) => {
          await page.goto('file://' + testPagePath);

          // Determine target element ID
          // For sprite sheets, test the <use> element instead of content
          let targetId = `elem_${edgeKey}_${scenarioIdx}`;
          if (edge.getTargetId) {
            targetId = edge.getTargetId(targetId);
          }

          const svgId = `svg_${edgeKey}_${scenarioIdx}`;
          const options = scenario.options || {};

          // Execute test in browser context
          const result = await page.evaluate(({ svg, elem, opts }) => {
            return window.testViewBox(svg, elem, opts);
          }, { svg: svgId, elem: targetId, opts: options });

          // Run scenario-specific validation
          // Check function arity to determine if validation needs page access
          if (scenario.validate.length > 1) {
            await scenario.validate(result, page, targetId, svgId);
          } else {
            scenario.validate(result);
          }

          // Log test completion
          const edgeLabel = edgeKey.padEnd(15);
          const scenarioLabel = scenario.name.padEnd(40);
          console.log(`✓ [${edgeLabel}] ${scenarioLabel}`);
        });
      }
    });
  }

  /**
   * Additional test: Restore function correctly undoes changes.
   */
  test('Restore function: undoes changes', async ({ page }) => {
    await page.goto('file://' + testPagePath);

    const result = await page.evaluate(async () => {
      const svgId = 'svg_normal_0';
      const svg = document.getElementById(svgId);
      const oldVBString = svg.getAttribute('viewBox');

      const res = await window.testViewBox(svgId, 'elem_normal_0', { aspect: 'stretch' });

      const changedVBString = svg.getAttribute('viewBox');

      // Call restore function
      res.restore();

      const restoredVBString = svg.getAttribute('viewBox');

      return {
        wasChanged: oldVBString !== changedVBString,
        wasRestored: oldVBString === restoredVBString
      };
    });

    expect(result.wasChanged).toBe(true);
    expect(result.wasRestored).toBe(true);

    console.log('✓ Restore function - viewBox correctly restored');
  });

  /**
   * Additional test: Error handling for nonexistent element ID.
   */
  test('Error: nonexistent element ID', async ({ page }) => {
    await page.goto('file://' + testPagePath);

    const result = await page.evaluate(() => {
      return window.testViewBox('svg_normal_0', 'nonexistent', { aspect: 'stretch' });
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');

    console.log('✓ Error handling - nonexistent element ID');
  });
});
