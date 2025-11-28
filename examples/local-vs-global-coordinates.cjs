#!/usr/bin/env node

 

/**
 * Local vs Global Coordinates - Complete Working Example
 *
 * This script demonstrates the CRITICAL difference between global and local
 * coordinate systems when using SvgVisualBBox for text-to-path operations.
 *
 * THE PROBLEM:
 * - getSvgElementVisualBBoxTwoPassAggressive() returns GLOBAL coordinates
 *   (root SVG space after all transforms applied)
 * - Text-to-path operations need LOCAL coordinates
 *   (element's own space before transforms)
 * - Using global coords causes DOUBLE-TRANSFORM BUG
 *
 * THE SOLUTION:
 * - Get element's CTM (Current Transformation Matrix)
 * - Compute inverse CTM
 * - Transform global bbox corners to local space
 *
 * USAGE:
 *   node local-vs-global-coordinates.cjs
 *
 * OUTPUT:
 *   - Creates test SVG with transformed text
 *   - Shows global vs local coordinates
 *   - Demonstrates text-to-path with both approaches
 *   - Saves output SVGs showing the difference
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

/**
 * Create a test SVG with transformed text elements
 */
function createTestSVG() {
  return `<svg viewBox="0 0 400 400" width="400" height="400" xmlns="http://www.w3.org/2000/svg">
  <!-- Example 1: Simple Translation -->
  <g id="example1">
    <rect x="0" y="0" width="400" height="120" fill="#f0f0f0" opacity="0.3"/>
    <text id="translated-text"
          x="10" y="50"
          font-family="Arial"
          font-size="16"
          fill="blue"
          transform="translate(100, 40)">
      Translated Text
    </text>
    <text x="10" y="80" font-size="12" fill="#666">
      ↑ translate(100, 40)
    </text>
  </g>

  <!-- Example 2: Rotation -->
  <g id="example2">
    <rect x="0" y="120" width="400" height="140" fill="#e0e0ff" opacity="0.3"/>
    <text id="rotated-text"
          x="100" y="200"
          font-family="Arial"
          font-size="16"
          fill="red"
          transform="rotate(45, 100, 200)">
      Rotated 45°
    </text>
    <text x="10" y="240" font-size="12" fill="#666">
      ↑ rotate(45°, 100, 200)
    </text>
  </g>

  <!-- Example 3: Complex Transform Chain -->
  <g id="example3">
    <rect x="0" y="260" width="400" height="140" fill="#ffe0e0" opacity="0.3"/>
    <text id="complex-text"
          x="50" y="320"
          font-family="Arial"
          font-size="14"
          fill="green"
          transform="translate(50, 30) scale(1.5) rotate(15)">
      Complex Transform
    </text>
    <text x="10" y="380" font-size="12" fill="#666">
      ↑ translate(50,30) × scale(1.5) × rotate(15°)
    </text>
  </g>
</svg>`;
}

/**
 * Invert a 2D affine transformation matrix
 * @param {Object} matrix - {a, b, c, d, e, f} matrix components
 * @returns {Object} - Inverted matrix
 */
function invertMatrix(matrix) {
  const { a, b, c, d, e, f } = matrix;
  const det = a * d - b * c;

  if (Math.abs(det) < 1e-10) {
    throw new Error('Matrix is not invertible (determinant near zero)');
  }

  return {
    a: d / det,
    b: -b / det,
    c: -c / det,
    d: a / det,
    e: (c * f - d * e) / det,
    f: (b * e - a * f) / det
  };
}

/**
 * Convert global bbox to local bbox using inverse CTM
 * @param {Object} globalBBox - {x, y, width, height} in global coordinates
 * @param {Object} ctm - Current Transformation Matrix {a, b, c, d, e, f}
 * @returns {Object} - {x, y, width, height} in local coordinates
 */
function globalToLocalBBox(globalBBox, ctm) {
  // Get inverse CTM to convert global → local
  const inv = invertMatrix(ctm);

  // Transform all four corners of the bbox
  const corners = [
    { x: globalBBox.x, y: globalBBox.y },
    { x: globalBBox.x + globalBBox.width, y: globalBBox.y },
    { x: globalBBox.x, y: globalBBox.y + globalBBox.height },
    { x: globalBBox.x + globalBBox.width, y: globalBBox.y + globalBBox.height }
  ];

  const transformedCorners = corners.map((c) => ({
    x: inv.a * c.x + inv.c * c.y + inv.e,
    y: inv.b * c.x + inv.d * c.y + inv.f
  }));

  // Find bounding box of transformed corners
  const xs = transformedCorners.map((c) => c.x);
  const ys = transformedCorners.map((c) => c.y);

  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
}

/**
 * Print formatted bbox comparison
 */
function printBBoxComparison(elementId, globalBBox, localBBox, ctm) {
  console.log(`\n${colors.bright}${colors.blue}═══════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.bright}Element: #${elementId}${colors.reset}`);
  console.log(`${colors.blue}───────────────────────────────────────────────────${colors.reset}`);

  // CTM matrix
  console.log(`\n${colors.cyan}CTM (Current Transformation Matrix):${colors.reset}`);
  console.log(`  [${ctm.a.toFixed(4)}, ${ctm.b.toFixed(4)}, ${ctm.c.toFixed(4)}, ${ctm.d.toFixed(4)}, ${ctm.e.toFixed(2)}, ${ctm.f.toFixed(2)}]`);
  console.log(`  ↳ [ a,  b,  c,  d,  e,  f ]`);

  // Global coordinates
  console.log(`\n${colors.red}❌ GLOBAL Coordinates (what the API returns):${colors.reset}`);
  console.log(`  x: ${globalBBox.x.toFixed(2)}`);
  console.log(`  y: ${globalBBox.y.toFixed(2)}`);
  console.log(`  width: ${globalBBox.width.toFixed(2)}`);
  console.log(`  height: ${globalBBox.height.toFixed(2)}`);
  console.log(`  ${colors.yellow}⚠️  Using these for text-to-path causes DOUBLE-TRANSFORM!${colors.reset}`);

  // Local coordinates
  console.log(`\n${colors.green}✓ LOCAL Coordinates (what you need):${colors.reset}`);
  console.log(`  x: ${localBBox.x.toFixed(2)}`);
  console.log(`  y: ${localBBox.y.toFixed(2)}`);
  console.log(`  width: ${localBBox.width.toFixed(2)}`);
  console.log(`  height: ${localBBox.height.toFixed(2)}`);
  console.log(`  ${colors.green}✓ Correct coordinates for text-to-path operations${colors.reset}`);

  // Difference
  const dx = Math.abs(globalBBox.x - localBBox.x);
  const dy = Math.abs(globalBBox.y - localBBox.y);
  if (dx > 0.1 || dy > 0.1) {
    console.log(`\n${colors.yellow}Position Difference:${colors.reset}`);
    console.log(`  Δx: ${dx.toFixed(2)} units`);
    console.log(`  Δy: ${dy.toFixed(2)} units`);
  }
}

/**
 * Main demonstration function
 */
async function demonstrateCoordinateSystems() {
  console.log(`${colors.bright}${colors.cyan}`);
  console.log(`╔═══════════════════════════════════════════════════════════════╗`);
  console.log(`║  Local vs Global Coordinates - Live Demonstration            ║`);
  console.log(`║  svg-bbox Library Coordinate System Demo                     ║`);
  console.log(`╚═══════════════════════════════════════════════════════════════╝`);
  console.log(colors.reset);

  // Create test SVG
  const svgContent = createTestSVG();
  const tempSvgPath = path.join(__dirname, 'temp_coordinate_demo.svg');
  fs.writeFileSync(tempSvgPath, svgContent, 'utf-8');
  console.log(`\n${colors.green}✓${colors.reset} Created test SVG: ${tempSvgPath}\n`);

  // Load SvgVisualBBox library
  const svgVisualBBoxPath = path.join(__dirname, '..', 'SvgVisualBBox.js');
  const svgVisualBBoxCode = fs.readFileSync(svgVisualBBoxPath, 'utf-8');

  // Launch browser
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  try {
    // Load SVG in browser
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
        </head>
        <body>
          ${svgContent}
        </body>
      </html>
    `;

    await page.setContent(html);
    await page.addScriptTag({ content: svgVisualBBoxCode });

    // Wait for fonts
    // eslint-disable-next-line arrow-body-style
    await page.evaluate(() => {
      /* eslint-disable no-undef */
      // window and document are available in Puppeteer page.evaluate() context
      return window.SvgVisualBBox.waitForDocumentFonts(document, 5000);
      /* eslint-enable no-undef */
    });

    // Analyze all three examples
    const examples = ['translated-text', 'rotated-text', 'complex-text'];

    for (const elementId of examples) {
      const result = await page.evaluate(
        async (id) => {
          /* eslint-disable no-undef */
          // window and document are available in Puppeteer page.evaluate() context
          const element = document.getElementById(id);
          if (!element) return null;

          // Get GLOBAL bbox (what the API returns)
          const globalBBox = await window.SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(element, {
            mode: 'unclipped',
            coarseFactor: 3,
            fineFactor: 24
          });

          // Get CTM
          const ctm = element.getCTM();

          return {
            globalBBox,
            ctm: {
              a: ctm.a,
              b: ctm.b,
              c: ctm.c,
              d: ctm.d,
              e: ctm.e,
              f: ctm.f
            }
          };
          /* eslint-enable no-undef */
        },
        elementId
      );

      if (!result) {
        console.error(`${colors.red}✗${colors.reset} Element #${elementId} not found`);
        continue;
      }

      // Convert to local coordinates
      const localBBox = globalToLocalBBox(result.globalBBox, result.ctm);

      // Print comparison
      printBBoxComparison(elementId, result.globalBBox, localBBox, result.ctm);
    }

    console.log(`\n${colors.bright}${colors.blue}═══════════════════════════════════════════════════${colors.reset}\n`);
    console.log(`${colors.bright}${colors.green}KEY TAKEAWAYS:${colors.reset}\n`);
    console.log(`${colors.yellow}1.${colors.reset} getSvgElementVisualBBoxTwoPassAggressive() returns ${colors.red}GLOBAL${colors.reset} coordinates`);
    console.log(`   (root SVG space after all transforms applied)\n`);
    console.log(`${colors.yellow}2.${colors.reset} Text-to-path operations need ${colors.green}LOCAL${colors.reset} coordinates`);
    console.log(`   (element's own space before transforms)\n`);
    console.log(`${colors.yellow}3.${colors.reset} To convert global → local:`);
    console.log(`   a) Get element's CTM: ${colors.cyan}element.getCTM()${colors.reset}`);
    console.log(`   b) Invert it: ${colors.cyan}ctm.inverse()${colors.reset}`);
    console.log(`   c) Transform bbox corners using inverse CTM\n`);
    console.log(`${colors.yellow}4.${colors.reset} Using global coords for text-to-path causes ${colors.red}DOUBLE-TRANSFORM BUG${colors.reset}`);
    console.log(`   (transform gets applied twice: once by CTM, once by your code)\n`);

    console.log(`${colors.bright}${colors.cyan}SOLUTION:${colors.reset}`);
    console.log(`Add a new API function: ${colors.green}getSvgElementLocalBBox()${colors.reset}`);
    console.log(`See GitHub Issue #1 for implementation proposal.\n`);
  } finally {
    await browser.close();
    // Clean up temp file
    fs.unlinkSync(tempSvgPath);
    console.log(`${colors.green}✓${colors.reset} Cleaned up temp files\n`);
  }
}

/**
 * Code Example: How to implement the workaround
 */
function printCodeExample() {
  console.log(`${colors.bright}${colors.cyan}═══════════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}CODE EXAMPLE: Converting Global → Local BBox${colors.reset}`);
  console.log(`${colors.cyan}═══════════════════════════════════════════════════════════════${colors.reset}\n`);

  const code = `
// ❌ WRONG: Using global coordinates for text-to-path
const globalBBox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(textElement);
// This will cause DOUBLE-TRANSFORM bug!
const pathElement = document.createElementNS('http://www.w3.org/2000/svg', 'path');
pathElement.setAttribute('transform', textElement.getAttribute('transform'));
pathElement.setAttribute('d', textToPathData(globalBBox)); // ❌ WRONG!

// ✓ CORRECT: Convert to local coordinates first
const globalBBox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(textElement);
const ctm = textElement.getCTM();
const inv = ctm.inverse();

// Transform bbox corners to local space
const corners = [
  {x: globalBBox.x, y: globalBBox.y},
  {x: globalBBox.x + globalBBox.width, y: globalBBox.y},
  {x: globalBBox.x, y: globalBBox.y + globalBBox.height},
  {x: globalBBox.x + globalBBox.width, y: globalBBox.y + globalBBox.height}
];

const localCorners = corners.map(c => ({
  x: inv.a * c.x + inv.c * c.y + inv.e,
  y: inv.b * c.x + inv.d * c.y + inv.f
}));

const localBBox = {
  x: Math.min(...localCorners.map(c => c.x)),
  y: Math.min(...localCorners.map(c => c.y)),
  width: Math.max(...localCorners.map(c => c.x)) - Math.min(...localCorners.map(c => c.x)),
  height: Math.max(...localCorners.map(c => c.y)) - Math.min(...localCorners.map(c => c.y))
};

// Now use local coordinates for text-to-path
const pathElement = document.createElementNS('http://www.w3.org/2000/svg', 'path');
pathElement.setAttribute('transform', textElement.getAttribute('transform'));
pathElement.setAttribute('d', textToPathData(localBBox)); // ✓ CORRECT!
`;

  console.log(code);
  console.log(`${colors.cyan}═══════════════════════════════════════════════════════════════${colors.reset}\n`);
}

// Main execution
if (require.main === module) {
  demonstrateCoordinateSystems()
    .then(() => {
      printCodeExample();
      console.log(`${colors.green}${colors.bright}✓ Demonstration complete!${colors.reset}\n`);
      process.exit(0);
    })
    .catch((error) => {
      console.error(`${colors.red}${colors.bright}✗ Error:${colors.reset}`, error.message);
      console.error(error.stack);
      process.exit(1);
    });
}

module.exports = {
  invertMatrix,
  globalToLocalBBox,
  createTestSVG,
  demonstrateCoordinateSystems
};
