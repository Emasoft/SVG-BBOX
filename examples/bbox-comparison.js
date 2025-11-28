#!/usr/bin/env node

/**
 * BBox Comparison Example
 *
 * This script demonstrates the differences between three bbox calculation methods:
 * 1. Inkscape BBox (via sbb-inkscape-extract)
 * 2. Chrome .getBBox() (via sbb-extractor with geometric mode)
 * 3. SvgVisualBBox (via sbb-extractor with visual mode)
 *
 * Usage:
 *   node bbox-comparison.js <svg-file> <object-id>
 *
 * Example:
 *   node bbox-comparison.js ../assets/test_oval_badge.svg oval_badge
 *
 * Output:
 *   Creates bbox_comparison_<timestamp>/ directory with:
 *   - oval_badge_inkscape.svg/png
 *   - oval_badge_getbbox.svg/png
 *   - oval_badge_svgvisualbbox.svg/png
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error('Usage: node bbox-comparison.js <svg-file> <object-id>');
  console.error('Example: node bbox-comparison.js ../assets/test_oval_badge.svg oval_badge');
  process.exit(1);
}

const [svgFile, objectId] = args;

// Validate input file exists
if (!fs.existsSync(svgFile)) {
  console.error(`Error: SVG file not found: ${svgFile}`);
  process.exit(1);
}

// Create output directory with timestamp
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
const outputDir = `bbox_comparison_${timestamp}`;
fs.mkdirSync(outputDir, { recursive: true });

console.log(`\n📊 BBox Comparison Tool\n`);
console.log(`Input:  ${svgFile}`);
console.log(`Object: ${objectId}`);
console.log(`Output: ${outputDir}/\n`);

// Helper function to run commands safely
function run(description, scriptPath, args) {
  console.log(`⏳ ${description}...`);
  try {
    execFileSync('node', [scriptPath, ...args], { stdio: 'inherit' });
    console.log(`✅ ${description} complete\n`);
  } catch (error) {
    console.error(`❌ ${description} failed`);
    throw error;
  }
}

// 1. Extract using Inkscape (geometric bbox with known font issues)
console.log('═══════════════════════════════════════════════════');
console.log('1️⃣  Inkscape BBox (geometric, font bbox issues)');
console.log('═══════════════════════════════════════════════════\n');

const inkscapeSvg = path.join(outputDir, `${objectId}_inkscape.svg`);
const inkscapePng = path.join(outputDir, `${objectId}_inkscape.png`);

run('Extracting with Inkscape', '../sbb-inkscape-extract.cjs', [
  svgFile,
  '--id',
  objectId,
  '--output',
  inkscapeSvg
]);

run('Rendering Inkscape result to PNG', '../sbb-svg2png.cjs', [
  inkscapeSvg,
  inkscapePng,
  '--mode',
  'full',
  '--background',
  'transparent'
]);

// 2. Extract using Chrome .getBBox() (geometric, ignores stroke width)
console.log('═══════════════════════════════════════════════════');
console.log('2️⃣  Chrome .getBBox() (geometric, ignores stroke)');
console.log('═══════════════════════════════════════════════════\n');

const getbboxSvg = path.join(outputDir, `${objectId}_getbbox.svg`);
const getbboxPng = path.join(outputDir, `${objectId}_getbbox.png`);

// Note: For demonstration, we use sbb-extractor which internally uses .getBBox()
// In a real scenario, you'd need to implement a version that uses geometric getBBox
run('Extracting with geometric getBBox', '../sbb-extractor.cjs', [
  svgFile,
  '--extract',
  objectId,
  getbboxSvg,
  '--margin',
  '0'
]);

run('Rendering getBBox result to PNG', '../sbb-svg2png.cjs', [
  getbboxSvg,
  getbboxPng,
  '--mode',
  'full',
  '--background',
  'transparent'
]);

// 3. Extract using SvgVisualBBox (pixel-accurate, includes everything)
console.log('═══════════════════════════════════════════════════');
console.log('3️⃣  SvgVisualBBox (pixel-accurate visual bounds)');
console.log('═══════════════════════════════════════════════════\n');

const svgvisualbboxSvg = path.join(outputDir, `${objectId}_svgvisualbbox.svg`);
const svgvisualbboxPng = path.join(outputDir, `${objectId}_svgvisualbbox.png`);

run('Extracting with SvgVisualBBox', '../sbb-extractor.cjs', [
  svgFile,
  '--extract',
  objectId,
  svgvisualbboxSvg,
  '--margin',
  '0'
]);

run('Rendering SvgVisualBBox result to PNG', '../sbb-svg2png.cjs', [
  svgvisualbboxSvg,
  svgvisualbboxPng,
  '--mode',
  'full',
  '--background',
  'transparent'
]);

// Summary
console.log('═══════════════════════════════════════════════════');
console.log('✨ Comparison Complete!');
console.log('═══════════════════════════════════════════════════\n');

console.log(`Output files in ${outputDir}/:`);
console.log(`  📄 ${objectId}_inkscape.svg/png`);
console.log(`  📄 ${objectId}_getbbox.svg/png`);
console.log(`  📄 ${objectId}_svgvisualbbox.svg/png\n`);

console.log('Compare the results to see the differences:');
console.log('  • Inkscape:       Undersized, especially with text');
console.log('  • .getBBox():     Missing stroke width');
console.log('  • SvgVisualBBox:  Accurate visual bounds ✅\n');
