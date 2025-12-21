#!/usr/bin/env node
/**
 * Build script to create minified version of SvgVisualBBox.js for CDN distribution
 *
 * This creates SvgVisualBBox.min.js which can be:
 * - Included in the npm package
 * - Served via unpkg.com or jsdelivr.com CDN
 * - Used directly in browsers without build tools
 */

const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

const SOURCE_FILE = path.join(__dirname, '../SvgVisualBBox.js');
const OUTPUT_FILE = path.join(__dirname, '../SvgVisualBBox.min.js');

async function build() {
  console.log('📦 Building minified SvgVisualBBox.js for CDN...');

  // Read source file
  const sourceCode = fs.readFileSync(SOURCE_FILE, 'utf-8');

  // Minify with terser
  const result = await minify(sourceCode, {
    compress: {
      dead_code: true,
      drop_console: false, // Keep console for debugging
      drop_debugger: true,
      pure_funcs: []
    },
    mangle: {
      // Keep public API names readable
      reserved: [
        'SvgVisualBBox',
        'waitForDocumentFonts',
        'getSvgElementVisualBBoxTwoPassAggressive',
        'getSvgElementsUnionVisualBBox',
        'getSvgElementVisibleAndFullBBoxes',
        'getSvgRootViewBoxExpansionForFullDrawing',
        'showTrueBBoxBorder',
        'setViewBoxOnObjects'
      ]
    },
    format: {
      comments: /^!/, // Keep comments starting with !
      preamble: `/*! SvgVisualBBox.js v${getVersion()} | MIT License | https://github.com/Emasoft/SVG-BBOX */`
    }
  });

  // Terser returns undefined code on failure (no error property on MinifyOutput type)
  if (!result.code) {
    console.error('❌ Minification failed: terser returned no code');
    process.exit(1);
  }

  // Write minified file (result.code is guaranteed to be string after check above)
  fs.writeFileSync(OUTPUT_FILE, result.code, 'utf-8');

  // Get file sizes
  const originalSize = fs.statSync(SOURCE_FILE).size;
  const minifiedSize = fs.statSync(OUTPUT_FILE).size;
  const reduction = ((1 - minifiedSize / originalSize) * 100).toFixed(1);

  console.log('✅ Minification complete!');
  console.log(`   Original: ${(originalSize / 1024).toFixed(1)} KB`);
  console.log(`   Minified: ${(minifiedSize / 1024).toFixed(1)} KB`);
  console.log(`   Reduction: ${reduction}%`);
  console.log(`\n📍 Output: ${OUTPUT_FILE}`);
  console.log('\n🌐 CDN URLs after publishing:');
  console.log('   unpkg:    https://unpkg.com/svg-bbox@latest/SvgVisualBBox.min.js');
  console.log('   jsdelivr: https://cdn.jsdelivr.net/npm/svg-bbox@latest/SvgVisualBBox.min.js');
}

function getVersion() {
  try {
    const pkg = require('../package.json');
    return pkg.version;
  } catch {
    return '1.0.1';
  }
}

build().catch((error) => {
  console.error('❌ Build failed:', error);
  process.exit(1);
});
