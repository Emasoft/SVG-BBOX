#!/usr/bin/env node
/**
 * Build Validation Script
 *
 * Validates that the build process completed successfully and produced valid output.
 * Run automatically as part of prepublishOnly to prevent publishing broken packages.
 *
 * WHY: Without validation, build failures can go unnoticed, causing:
 * - Broken packages published to npm
 * - Users downloading non-functional code
 * - Reputation damage and user frustration
 * - Emergency hotfix releases required
 *
 * WHAT NOT TO DO:
 * - Don't trust that build commands succeeded without validation
 * - Don't check only file existence (file could be empty or corrupted)
 * - Don't use soft failures (warnings instead of errors)
 *
 * FAIL-FAST PRINCIPLE: This script exits with code 1 on ANY validation failure,
 * blocking npm publish immediately.
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// Configuration Constants - Single Source of Truth
// ============================================================================

// File paths to validate
const REQUIRED_FILES = {
  SOURCE: path.join(__dirname, '../SvgVisualBBox.js'),
  MINIFIED: path.join(__dirname, '../SvgVisualBBox.min.js')
};

// Validation thresholds
const MIN_FILE_SIZE_BYTES = 1000; // Minified file must be at least 1KB (sanity check)
const MIN_SOURCE_SIZE_BYTES = 5000; // Source file must be at least 5KB (sanity check)
const MAX_SIZE_RATIO = 0.95; // Minified should be < 95% of source (otherwise not minified)

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validate that a file exists
 * @param {string} filePath - Path to file to validate
 * @param {string} description - Human-readable file description
 * @throws {Error} If file doesn't exist
 */
function validateFileExists(filePath, description) {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Build validation failed: ${description} not found at ${filePath}\n` +
        `This usually means the build script failed or was interrupted.\n` +
        `Run 'npm run build' and check for errors.`
    );
  }
  console.log(`✓ ${description} exists: ${filePath}`);
}

/**
 * Validate that a file is non-empty and meets minimum size requirements
 * @param {string} filePath - Path to file to validate
 * @param {string} description - Human-readable file description
 * @param {number} minSize - Minimum acceptable file size in bytes
 * @throws {Error} If file is too small
 */
function validateFileSize(filePath, description, minSize) {
  const stats = fs.statSync(filePath);
  const sizeKB = (stats.size / 1024).toFixed(1);

  if (stats.size === 0) {
    throw new Error(
      `Build validation failed: ${description} is empty (0 bytes)\n` +
        `This usually means the build process crashed or was killed.\n` +
        `File: ${filePath}`
    );
  }

  if (stats.size < minSize) {
    throw new Error(
      `Build validation failed: ${description} is suspiciously small (${sizeKB} KB)\n` +
        `Expected at least ${(minSize / 1024).toFixed(1)} KB\n` +
        `This may indicate a partial or corrupted build.\n` +
        `File: ${filePath}`
    );
  }

  console.log(`✓ ${description} size: ${sizeKB} KB (valid)`);
  return stats.size;
}

/**
 * Validate that minification actually reduced file size
 * @param {number} sourceSize - Size of source file in bytes
 * @param {number} minifiedSize - Size of minified file in bytes
 * @throws {Error} If minified file is not significantly smaller
 */
function validateMinification(sourceSize, minifiedSize) {
  const ratio = minifiedSize / sourceSize;
  const reduction = ((1 - ratio) * 100).toFixed(1);

  if (ratio >= MAX_SIZE_RATIO) {
    throw new Error(
      `Build validation failed: Minification did not reduce file size enough\n` +
        `Minified: ${(minifiedSize / 1024).toFixed(1)} KB\n` +
        `Source: ${(sourceSize / 1024).toFixed(1)} KB\n` +
        `Ratio: ${(ratio * 100).toFixed(1)}% (expected < ${(MAX_SIZE_RATIO * 100).toFixed(1)}%)\n` +
        `This usually means terser failed to minify or used incorrect settings.`
    );
  }

  console.log(`✓ Minification effective: ${reduction}% size reduction`);
}

/**
 * Validate that minified file contains expected code patterns
 * @param {string} filePath - Path to minified file
 * @throws {Error} If expected patterns are missing
 */
function validateMinifiedContent(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');

  // Check for critical function names that should be preserved
  const requiredPatterns = [
    { pattern: 'SvgVisualBBox', description: 'Main export name' },
    { pattern: 'getSvgElementVisualBBoxTwoPassAggressive', description: 'Core function name' }
  ];

  for (const { pattern, description } of requiredPatterns) {
    if (!content.includes(pattern)) {
      throw new Error(
        `Build validation failed: Minified file missing expected pattern\n` +
          `Pattern: "${pattern}" (${description})\n` +
          `This usually means minification used incorrect mangle settings.\n` +
          `File: ${filePath}`
      );
    }
  }

  console.log(`✓ Minified file contains expected code patterns`);
}

// ============================================================================
// Main Execution
// ============================================================================

async function main() {
  console.log('🔍 Validating build output...\n');

  try {
    // Step 1: Validate source file exists and has reasonable size
    validateFileExists(REQUIRED_FILES.SOURCE, 'Source file');
    const sourceSize = validateFileSize(
      REQUIRED_FILES.SOURCE,
      'Source file',
      MIN_SOURCE_SIZE_BYTES
    );

    // Step 2: Validate minified file exists and has reasonable size
    validateFileExists(REQUIRED_FILES.MINIFIED, 'Minified file');
    const minifiedSize = validateFileSize(
      REQUIRED_FILES.MINIFIED,
      'Minified file',
      MIN_FILE_SIZE_BYTES
    );

    // Step 3: Validate that minification was effective
    validateMinification(sourceSize, minifiedSize);

    // Step 4: Validate that minified file contains expected code
    validateMinifiedContent(REQUIRED_FILES.MINIFIED);

    console.log('\n✅ Build validation passed! Package is ready to publish.');
    process.exit(0);
  } catch (error) {
    // Handle unknown error type - check if it's an Error instance before accessing message
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ ${errorMessage}\n`);
    console.error('Cannot proceed with publishing until build issues are resolved.');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('❌ Unexpected validation error:', error);
  process.exit(1);
});
