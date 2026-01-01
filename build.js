#!/usr/bin/env bun
/* global Bun */
/**
 * Bun Build Script for SVG-BBOX
 *
 * Creates minified SvgVisualBBox.min.js for CDN distribution using Bun's
 * built-in bundler and minifier.
 *
 * Usage:
 *   bun run build.js          # Production build
 *   bun run build.js --dev    # Development build (no minification)
 *   bun run build.js --watch  # Watch mode for development
 *
 * Based on: BUN_MIGRATION_GUIDE.md (SVG-MATRIX v1.2.0 migration)
 */

import { existsSync, readFileSync, statSync, watch } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const SOURCE_FILE = join(__dirname, 'SvgVisualBBox.js');
const OUTPUT_FILE = join(__dirname, 'SvgVisualBBox.min.js');
const isWatch = process.argv.includes('--watch');
const isDev = process.argv.includes('--dev');

/**
 * Get version from package.json
 */
function getVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
    return pkg.version;
  } catch {
    return '1.1.1';
  }
}

/**
 * Format file size for display
 * @param {number} bytes - File size in bytes
 * @returns {string} Formatted size in KB
 */
function formatSize(bytes) {
  return (bytes / 1024).toFixed(1);
}

/**
 * Build the minified bundle using Bun.build() API
 */
async function build() {
  const startTime = Date.now();
  const version = getVersion();

  console.log('Building minified SvgVisualBBox.js for CDN...\n');

  // Check source file exists
  if (!existsSync(SOURCE_FILE)) {
    console.error(`Source file not found: ${SOURCE_FILE}`);
    process.exit(1);
  }

  try {
    // Bun.build() for minification
    // Note: SvgVisualBBox.js is a UMD module, we preserve its format
    const result = await Bun.build({
      entrypoints: [SOURCE_FILE],
      outdir: __dirname,
      naming: 'SvgVisualBBox.min.js',
      minify: !isDev,
      sourcemap: isDev ? 'inline' : 'none',
      target: 'browser',
      // Keep as single file, don't split
      splitting: false,
      // Banner with version and license
      banner: `/*! SvgVisualBBox.js v${version} | MIT License | https://github.com/Emasoft/SVG-BBOX */`,
      // Define compile-time constants
      define: {
        'process.env.NODE_ENV': isDev ? '"development"' : '"production"'
      }
    });

    if (!result.success) {
      console.error('Build failed:');
      result.logs.forEach((/** @type {unknown} */ log) => console.error(log));
      process.exit(1);
    }

    // Get file sizes for comparison
    const originalSize = statSync(SOURCE_FILE).size;
    const minifiedSize = statSync(OUTPUT_FILE).size;
    const reduction = ((1 - minifiedSize / originalSize) * 100).toFixed(1);
    const elapsed = Date.now() - startTime;

    // Report results
    console.log('Bundle sizes:');
    console.log('-'.repeat(45));
    console.log(`  SvgVisualBBox.js (original)     ${formatSize(originalSize)} KB`);
    console.log(`  SvgVisualBBox.min.js (minified) ${formatSize(minifiedSize)} KB`);
    console.log('-'.repeat(45));
    console.log(`  Reduction: ${reduction}%`);
    console.log(`\nBuild completed in ${elapsed}ms`);

    console.log(`\nOutput: ${OUTPUT_FILE}`);
    console.log('\nCDN URLs after publishing:');
    console.log('   unpkg:    https://unpkg.com/svg-bbox@latest/SvgVisualBBox.min.js');
    console.log('   jsdelivr: https://cdn.jsdelivr.net/npm/svg-bbox@latest/SvgVisualBBox.min.js');

    return true;
  } catch (error) {
    console.error('Build error:', error);
    process.exit(1);
  }
}

// Main execution
await build();

// Watch mode
if (isWatch) {
  console.log('\nWatching for changes in SvgVisualBBox.js ...');

  watch(SOURCE_FILE, async (eventType) => {
    if (eventType === 'change') {
      console.log('\nFile changed, rebuilding...');
      await build();
    }
  });

  // Keep process alive
  process.stdin.resume();
}
