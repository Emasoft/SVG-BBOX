#!/usr/bin/env node

/**
 * Extract Visual Bounding Boxes for Text Elements
 *
 * This script demonstrates how to use SvgVisualBBox in a Node.js environment
 * via Puppeteer to extract accurate visual bounding boxes for text elements.
 * This is useful for converting text to paths while preserving exact bounds.
 *
 * Usage:
 *   node get_bboxes_for_text2path.js <svg-file>
 *
 * Example:
 *   node get_bboxes_for_text2path.js ../assets/test_oval_badge.svg
 *
 * Output:
 *   JSON array with bbox data for each text element
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

/**
 * Main function to extract bounding boxes from text elements
 * @param {string} svgFilePath - Path to SVG file
 * @returns {Promise<Array<{id: string, bbox: {x: number, y: number, width: number, height: number}}>>}
 */
async function extractTextBBoxes(svgFilePath) {
  // Validate input
  if (!fs.existsSync(svgFilePath)) {
    throw new Error(`SVG file not found: ${svgFilePath}`);
  }

  const svgContent = fs.readFileSync(svgFilePath, 'utf-8');
  const svgVisualBBoxPath = path.join(__dirname, '..', 'SvgVisualBBox.js');
  const svgVisualBBoxCode = fs.readFileSync(svgVisualBBoxPath, 'utf-8');

  // Launch browser with proper headless mode (boolean, not "new")
  const browser = await puppeteer.launch({
    headless: true, // Use boolean, not "new"
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  try {
    // Create HTML page with SVG and SvgVisualBBox library
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

    // Inject SvgVisualBBox library into the page
    await page.addScriptTag({ content: svgVisualBBoxCode });

    // Wait for fonts to load
    // Note: SvgVisualBBox and document are browser globals in page.evaluate() context
    /* global SvgVisualBBox, document */
    await page.evaluate(() => SvgVisualBBox.waitForDocumentFonts(document, 5000));

    // Extract bounding boxes for all text elements
    const results = await page.evaluate(() => {
      const textElements = document.querySelectorAll('text');
      const bboxPromises = [];

      // Convert NodeListOf to Array using Array.from()
      for (const textEl of Array.from(textElements)) {
        const promise = (async () => {
          try {
            const bbox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(textEl, {
              mode: 'unclipped',
              coarseFactor: 3,
              fineFactor: 24
            });

            return {
              id: textEl.id || `text_${textEl.textContent?.slice(0, 20)}`,
              textContent: textEl.textContent,
              bbox: {
                x: bbox.x,
                y: bbox.y,
                width: bbox.width,
                height: bbox.height
              }
            };
          } catch (error) {
            console.error(`Error processing text element:`, error);
            return null;
          }
        })();

        bboxPromises.push(promise);
      }

      return Promise.all(bboxPromises);
    });

    // Filter out null results (failed extractions)
    const validResults = results.filter((result) => result !== null);

    return validResults;
  } finally {
    await browser.close();
  }
}

// Main execution
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: node get_bboxes_for_text2path.js <svg-file>');
    console.error('Example: node get_bboxes_for_text2path.js ../assets/test_oval_badge.svg');
    process.exit(1);
  }

  const svgFile = args[0];

  extractTextBBoxes(svgFile)
    .then((results) => {
      console.log('\n📊 Text Element Bounding Boxes:\n');
      console.log(JSON.stringify(results, null, 2));
      console.log(`\n✅ Extracted ${results.length} text element(s)\n`);
    })
    .catch((error) => {
      console.error('❌ Error:', error.message);
      process.exit(1);
    });
}

module.exports = { extractTextBBoxes };
