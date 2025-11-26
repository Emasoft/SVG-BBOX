/**
 * HTML Test Page Generator
 *
 * Generates standalone HTML pages for E2E browser tests.
 * Separates HTML generation logic from test orchestration.
 */

import path from 'path';
import { generateTestViewBoxFunction } from './testHelpers.mjs';

/**
 * Generates a complete HTML test page with embedded SVG test cases.
 *
 * @param {Object} options - Configuration options
 * @param {string} options.title - Page title
 * @param {Array} options.sections - Array of {title, markup} objects
 * @param {string} options.scriptFunction - Browser-side test function code
 * @param {string} options.libraryPath - Path to SvgVisualBBox.js
 * @param {number} options.totalTests - Total number of tests
 * @returns {string} Complete HTML document
 */
export function generateTestPage({ title, sections, scriptFunction, libraryPath, totalTests }) {
  const sectionsHTML = sections
    .map(
      ({ title: sectionTitle, markup }) => `
  <!-- ${sectionTitle} -->
  <div class="section">
    <h3>${sectionTitle}</h3>
    ${markup}
  </div>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <script src="file://${path.resolve(libraryPath)}"></script>
  <style>
    body {
      margin: 20px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #333;
    }
    h1 {
      font-size: 24px;
      margin-bottom: 10px;
      border-bottom: 2px solid #007acc;
      padding-bottom: 10px;
    }
    .section {
      margin: 30px 0;
      padding: 20px;
      border: 1px solid #ddd;
      border-radius: 4px;
      background: #f9f9f9;
    }
    h3 {
      margin: 0 0 10px 0;
      color: #333;
      font-size: 14px;
      font-weight: 600;
    }
    svg {
      border: 1px solid #ccc;
      margin: 10px 0;
      background: white;
      display: block;
    }
    .info {
      background: #e7f3ff;
      padding: 10px;
      border-left: 4px solid #007acc;
      margin-bottom: 20px;
    }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <div class="info">
    <strong>Total tests:</strong> ${totalTests}
  </div>
  ${sectionsHTML}

  <script>
    ${scriptFunction}
  </script>
</body>
</html>`;
}

/**
 * Generates test sections from edge cases and scenarios.
 *
 * @param {Object} edgeCases - Edge case generators
 * @param {Array} baseScenarios - Base test scenarios
 * @returns {Array} Array of section objects
 */
export function generateTestSections(edgeCases, baseScenarios) {
  const sections = [];

  for (const edgeKey of Object.keys(edgeCases)) {
    const edge = edgeCases[edgeKey];

    for (let scenarioIdx = 0; scenarioIdx < baseScenarios.length; scenarioIdx++) {
      const scenario = baseScenarios[scenarioIdx];
      const elementId = `elem_${edgeKey}_${scenarioIdx}`;
      const content = scenario.generateContent(elementId);
      const svgMarkup = edge.generateSVG(content, `${edgeKey}_${scenarioIdx}`, scenarioIdx);

      sections.push({
        title: `${edge.name} - ${scenario.name}`,
        markup: svgMarkup
      });
    }
  }

  return sections;
}

/**
 * Generates HTML page for setViewBoxOnObjects tests.
 *
 * @param {Object} edgeCases - Edge case generators
 * @param {Array} baseScenarios - Base test scenarios
 * @returns {string} Complete HTML document
 */
export function generateSetViewBoxTestPage(edgeCases, baseScenarios) {
  const sections = generateTestSections(edgeCases, baseScenarios);
  const totalTests = Object.keys(edgeCases).length * baseScenarios.length;

  return generateTestPage({
    title: 'setViewBoxOnObjects() Test Page - Edge Cases',
    sections,
    scriptFunction: generateTestViewBoxFunction(),
    libraryPath: 'SvgVisualBBox.js',
    totalTests
  });
}
