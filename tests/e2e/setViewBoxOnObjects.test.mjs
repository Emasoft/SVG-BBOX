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
import path from 'path';

const testPagePath = '/tmp/setViewBoxOnObjects_test.html';

// Edge case generators - each function wraps content in appropriate SVG structure
const edgeCases = {
  normal: {
    name: 'Normal (with viewBox)',
    generateSVG: (content, id) => {
      return `<svg id="svg_${id}" viewBox="0 0 400 300" width="800" height="600">${content}</svg>`;
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
      transformedContent = transformedContent.replace(/(<\w+[^>]*?\s+)(x|cx)="([^"]+)"/g, (match, prefix, attr, value) => {
        const newVal = parseFloat(value) - 200;
        return `${prefix}${attr}="${newVal}"`;
      });

      // Transform y and cy attributes
      transformedContent = transformedContent.replace(/(<\w+[^>]*?\s+)(y|cy)="([^"]+)"/g, (match, prefix, attr, value) => {
        const newVal = parseFloat(value) - 150;
        return `${prefix}${attr}="${newVal}"`;
      });

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
    // For sprite sheets, we test the <use> element
    getTargetId: (baseId) => baseId.replace(/^elem_/, 'use_')
  }
};

// Base test scenarios - each defines content and validation
const baseScenarios = [
  {
    name: 'Stretch mode: single element',
    generateContent: (id) => {
      return `<circle id="${id}" cx="200" cy="150" r="50" fill="#e74c3c"/>`;
    },
    options: { aspect: 'stretch' },
    validate: (result) => {
      expect(result.success).toBe(true);
      // ViewBox should match bbox (with some tolerance for rounding)
      expect(result.actualViewBox.width).toBeGreaterThan(result.bbox.width - 2);
      expect(result.actualViewBox.height).toBeGreaterThan(result.bbox.height - 2);
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
      // ViewBox should be bbox + 2*margin on each side
      expect(result.actualViewBox.width).toBeCloseTo(result.bbox.width + 40, 1);
      expect(result.actualViewBox.height).toBeCloseTo(result.bbox.height + 40, 1);
    }
  },
  {
    name: 'ChangePosition mode',
    generateContent: (id) => {
      // Place text far from center (50, 50) so position change is > 1
      return `<text id="${id}" x="50" y="50" font-size="24" text-anchor="middle" fill="#2c3e50">Test</text>`;
    },
    options: { aspect: 'changePosition' },
    validate: (result) => {
      expect(result.success).toBe(true);
      // ViewBox dimensions should match old dimensions
      expect(result.actualViewBox.width).toBeCloseTo(result.oldViewBox.width, 0.1);
      expect(result.actualViewBox.height).toBeCloseTo(result.oldViewBox.height, 0.1);
      // Position should change significantly (element far from center)
      const positionChange = Math.sqrt(
        Math.pow(result.actualViewBox.x - result.oldViewBox.x, 2) +
        Math.pow(result.actualViewBox.y - result.oldViewBox.y, 2)
      );
      expect(positionChange).toBeGreaterThan(50);
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
      // Aspect ratio should be preserved
      const oldAspect = result.oldViewBox.width / result.oldViewBox.height;
      const newAspect = result.actualViewBox.width / result.actualViewBox.height;
      expect(newAspect).toBeCloseTo(oldAspect, 0.01);
      // ViewBox should encompass the bbox
      expect(result.actualViewBox.width).toBeGreaterThanOrEqual(result.bbox.width - 1);
      expect(result.actualViewBox.height).toBeGreaterThanOrEqual(result.bbox.height - 1);
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
      // Aspect ratio should be preserved
      const oldAspect = result.oldViewBox.width / result.oldViewBox.height;
      const newAspect = result.actualViewBox.width / result.actualViewBox.height;
      expect(newAspect).toBeCloseTo(oldAspect, 0.01);
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
      // Element bbox should be at top-left of viewBox (approximately)
      expect(result.actualViewBox.x).toBeCloseTo(result.bbox.x, 5);
      expect(result.actualViewBox.y).toBeCloseTo(result.bbox.y, 5);
    }
  },
  {
    name: 'Visibility hideAllExcept',
    generateContent: (id) => {
      return `<circle id="${id}" cx="200" cy="150" r="40" fill="#27ae60"/>
              <rect id="other_${id}" x="50" y="50" width="50" height="50" fill="#c0392b"/>`;
    },
    options: { aspect: 'stretch', visibility: 'hideAllExcept' },
    validate: async (result, page, targetId) => {
      expect(result.success).toBe(true);
      // Check that other elements are hidden
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
    validate: async (result, page, targetId, svgId) => {
      expect(result.success).toBe(true);
      // In dry-run, the viewBox should not be modified
      // We check that oldViewBox matches actualViewBox
      expect(result.actualViewBox.x).toBe(result.oldViewBox.x);
      expect(result.actualViewBox.y).toBe(result.oldViewBox.y);
      expect(result.actualViewBox.width).toBe(result.oldViewBox.width);
      expect(result.actualViewBox.height).toBe(result.oldViewBox.height);
    }
  }
];

test.beforeAll(async ({ }, testInfo) => {
  // Skip if file already exists
  try {
    await fs.access(testPagePath);
    console.log('Test page already exists');
    return;
  } catch (e) {
    // File doesn't exist, create it
  }

  // Generate all SVG combinations dynamically
  let sections = [];
  let testIndex = 0;

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
      testIndex++;
    }
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>setViewBoxOnObjects Test - Edge Cases</title>
  <script src="file://${path.resolve('SvgVisualBBox.js')}"></script>
  <style>
    body { margin: 20px; font-family: Arial, sans-serif; }
    .section { margin: 30px 0; padding: 20px; border: 1px solid #ddd; background: #f9f9f9; }
    svg { border: 1px solid #ccc; margin: 10px 0; background: white; }
    h3 { margin: 0 0 10px 0; color: #333; font-size: 14px; }
  </style>
</head>
<body>
  <h1>setViewBoxOnObjects() Test Page - Edge Cases</h1>
  <p>Testing ${baseScenarios.length} scenarios × ${Object.keys(edgeCases).length} edge cases = ${baseScenarios.length * Object.keys(edgeCases).length} tests</p>
  ${sections.join('\n')}

  <script>
    window.testViewBox = async function(svgId, elementId, options = {}) {
      try {
        const svg = document.getElementById(svgId);
        if (!svg) throw new Error('SVG not found: ' + svgId);

        // Get old viewBox
        const oldVB = svg.viewBox.baseVal;
        const oldViewBox = {
          x: oldVB.x || 0,
          y: oldVB.y || 0,
          width: oldVB.width || parseFloat(svg.getAttribute('width')) || 0,
          height: oldVB.height || parseFloat(svg.getAttribute('height')) || 0
        };

        if (oldViewBox.width === 0 || oldViewBox.height === 0) {
          const rect = svg.getBoundingClientRect();
          oldViewBox.width = rect.width;
          oldViewBox.height = rect.height;
        }

        // Call setViewBoxOnObjects
        await SvgVisualBBox.waitForDocumentFonts();
        const result = await SvgVisualBBox.setViewBoxOnObjects(svgId, elementId, options);

        // Get new viewBox (with same fallback logic as oldViewBox)
        const newVB = svg.viewBox.baseVal;
        const actualViewBox = {
          x: newVB.x || 0,
          y: newVB.y || 0,
          width: newVB.width || parseFloat(svg.getAttribute('width')) || 0,
          height: newVB.height || parseFloat(svg.getAttribute('height')) || 0
        };

        if (actualViewBox.width === 0 || actualViewBox.height === 0) {
          const rect = svg.getBoundingClientRect();
          actualViewBox.width = rect.width;
          actualViewBox.height = rect.height;
        }

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
  </script>
</body>
</html>`;

  await fs.writeFile(testPagePath, html, 'utf8');
  console.log('Test page generated: ' + testPagePath);
  console.log(`Total tests: ${baseScenarios.length * Object.keys(edgeCases).length}`);
});

test.afterAll(async () => {
  // Don't delete - let OS clean up /tmp
});

test.describe('setViewBoxOnObjects() - Comprehensive Edge Case Tests', () => {
  test.describe.configure({ mode: 'serial' });

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

          const svgId = `svg_${edgeKey}_${scenarioIdx}`;
          const options = scenario.options || {};

          const result = await page.evaluate(({ svg, elem, opts }) => {
            return window.testViewBox(svg, elem, opts);
          }, { svg: svgId, elem: targetId, opts: options });

          // Run scenario-specific validation
          if (scenario.validate.length > 2) {
            // Validation needs page access
            await scenario.validate(result, page, targetId, svgId);
          } else {
            scenario.validate(result);
          }

          // Log success
          const edgeLabel = edgeKey.padEnd(15);
          const scenarioLabel = scenario.name.padEnd(40);
          console.log(`✓ [${edgeLabel}] ${scenarioLabel}`);
        });
      }
    });
  }

  // Additional test: Restore function
  test('Restore function: undoes changes', async ({ page }) => {
    await page.goto('file://' + testPagePath);

    const result = await page.evaluate(async () => {
      const svgId = 'svg_normal_0';
      const svg = document.getElementById(svgId);
      const oldVBString = svg.getAttribute('viewBox');

      const res = await window.testViewBox(svgId, 'elem_normal_0', { aspect: 'stretch' });

      const changedVBString = svg.getAttribute('viewBox');

      // Call restore
      res.restore();

      const restoredVBString = svg.getAttribute('viewBox');

      return {
        wasChanged: oldVBString !== changedVBString,
        wasRestored: oldVBString === restoredVBString
      };
    });

    expect(result.wasChanged).toBe(true);
    expect(result.wasRestored).toBe(true);

    console.log('✓ Restore function - viewBox restored');
  });

  // Additional test: Error handling
  test('Error: nonexistent element ID', async ({ page }) => {
    await page.goto('file://' + testPagePath);

    const result = await page.evaluate(() => {
      return window.testViewBox('svg_normal_0', 'nonexistent', { aspect: 'stretch' });
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');

    console.log('✓ Error handling - nonexistent element');
  });
});
