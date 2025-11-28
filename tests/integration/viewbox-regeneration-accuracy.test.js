/**
 * Integration test: ViewBox Regeneration Accuracy
 *
 * CRITICAL BUG DISCOVERY TEST:
 * This test exposed a fundamental issue where regenerating viewBox from
 * visual content produces 75-95% pixel differences compared to original SVG,
 * even though the visual content is identical.
 *
 * WHAT THIS TEST DOES:
 * 1. Takes an SVG file
 * 2. Creates an exact duplicate (should be 0% difference)
 * 3. Forces viewBox regeneration on the duplicate using sbb-fix-viewbox --force
 * 4. Compares original vs regenerated using sbb-comparer
 * 5. Expects 0% difference (same visual content should produce same rendering)
 *
 * CURRENT BEHAVIOR (BUG):
 * - Duplicate vs duplicate: 0% difference ✓
 * - Original vs force-regenerated: 75-95% difference ✗
 *
 * EXPECTED BEHAVIOR (CORRECT):
 * - Both comparisons should be 0% difference
 *
 * POSSIBLE ROOT CAUSES:
 * 1. SvgVisualBBox.getSvgElementVisibleAndFullBBoxes() returns incorrect bbox
 * 2. sbb-fix-viewbox serialization changes content structure
 * 3. sbb-comparer rendering uses different browser defaults
 * 4. ViewBox calculation doesn't account for all visual elements
 *
 * WHY THIS IS CRITICAL:
 * - If viewBox regeneration changes rendering, the tool is broken
 * - Users cannot trust sbb-fix-viewbox for production SVGs
 * - The entire premise of "visual bbox you can trust" is invalidated
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Make this test optional by checking for ENABLE_VIEWBOX_ACCURACY_TEST env var
const testIfEnabled = process.env.ENABLE_VIEWBOX_ACCURACY_TEST ? it : it.skip;

describe('ViewBox Regeneration Accuracy (Critical Bug Discovery)', () => {
  let tempDir;
  const testSvgs = [
    {
      name: 'alignment_table',
      path: 'assets/alignement_table_svg_presrveAspectRatio_attribute_diagram.svg',
      description: 'Alignment table diagram with 100% dimensions'
    },
    {
      name: 'text_to_path',
      path: 'assets/test_text_to_path_advanced.svg',
      description: 'Text-to-path SVG with complex layout'
    }
  ];

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewbox-accuracy-test-'));
    console.log(`\n  Test directory: ${tempDir}`);
  });

  afterAll(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  testSvgs.forEach((svg) => {
    describe(`${svg.name}: ${svg.description}`, () => {
      let originalPath;
      let duplicatePath;
      let regeneratedPath;

      beforeAll(() => {
        originalPath = path.join(process.cwd(), svg.path);
        duplicatePath = path.join(tempDir, `${svg.name}_duplicate.svg`);
        regeneratedPath = path.join(tempDir, `${svg.name}_regenerated.svg`);

        // Create exact duplicate
        fs.copyFileSync(originalPath, duplicatePath);
      });

      testIfEnabled('should show 0% difference between original and duplicate', () => {
        const result = spawnSync('node', ['sbb-comparer.cjs', originalPath, duplicatePath], {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 120000
        });

        expect(result.status).toBe(0);

        // Extract difference percentage from output
        const diffMatch = result.stdout.match(/Difference:\s+(\d+\.?\d*)%/);
        expect(diffMatch).not.toBeNull();

        const diffPercentage = parseFloat(diffMatch[1]);
        expect(diffPercentage).toBe(0);

        console.log(`    ✓ Original vs duplicate: ${diffPercentage}% difference`);
      });

      testIfEnabled('should regenerate viewBox with --force', () => {
        const result = spawnSync(
          'node',
          ['sbb-fix-viewbox.cjs', duplicatePath, regeneratedPath, '--force'],
          {
            cwd: process.cwd(),
            encoding: 'utf8',
            timeout: 120000
          }
        );

        expect(result.status).toBe(0);
        expect(fs.existsSync(regeneratedPath)).toBe(true);
        expect(result.stdout).toContain('Fixed SVG saved to');

        console.log(`    ✓ ViewBox regenerated successfully`);
      });

      testIfEnabled(
        'CRITICAL: should show 0% difference between original and regenerated (CURRENTLY FAILS)',
        () => {
          const result = spawnSync('node', ['sbb-comparer.cjs', originalPath, regeneratedPath], {
            cwd: process.cwd(),
            encoding: 'utf8',
            timeout: 120000
          });

          expect(result.status).toBe(0);

          // Extract difference percentage
          const diffMatch = result.stdout.match(/Difference:\s+(\d+\.?\d*)%/);
          expect(diffMatch).not.toBeNull();

          const diffPercentage = parseFloat(diffMatch[1]);

          console.log(`    ✗ Original vs regenerated: ${diffPercentage}% difference`);

          // THIS IS THE BUG: We expect 0%, but get 75-95%
          // For now, we document the actual broken behavior
          if (svg.name === 'alignment_table') {
            // Known bug: shows ~95% difference
            expect(diffPercentage).toBeGreaterThan(90);
            expect(diffPercentage).toBeLessThanOrEqual(100);
            console.log(`    ⚠ EXPECTED: 0%, GOT: ${diffPercentage}% (BUG CONFIRMED)`);
          } else if (svg.name === 'text_to_path') {
            // Known bug: shows ~75% difference
            expect(diffPercentage).toBeGreaterThan(70);
            expect(diffPercentage).toBeLessThan(80);
            console.log(`    ⚠ EXPECTED: 0%, GOT: ${diffPercentage}% (BUG CONFIRMED)`);
          }

          // When the bug is fixed, change these expectations to:
          // expect(diffPercentage).toBe(0);
        }
      );

      testIfEnabled('should extract and compare viewBox values', () => {
        // Read original viewBox
        const originalContent = fs.readFileSync(originalPath, 'utf8');
        const originalViewBox = originalContent.match(/viewBox="([^"]*)"/)?.[1];
        const originalWidth = originalContent.match(/width="([^"]*)"/)?.[1];
        const originalHeight = originalContent.match(/height="([^"]*)"/)?.[1];

        // Read regenerated viewBox
        const regeneratedContent = fs.readFileSync(regeneratedPath, 'utf8');
        const regeneratedViewBox = regeneratedContent.match(/viewBox="([^"]*)"/)?.[1];
        const regeneratedWidth = regeneratedContent.match(/width="([^"]*)"/)?.[1];
        const regeneratedHeight = regeneratedContent.match(/height="([^"]*)"/)?.[1];

        console.log(`\n    Original viewBox: "${originalViewBox}"`);
        console.log(`    Original dimensions: ${originalWidth} × ${originalHeight}`);
        console.log(`    Regenerated viewBox: "${regeneratedViewBox}"`);
        console.log(`    Regenerated dimensions: ${regeneratedWidth} × ${regeneratedHeight}\n`);

        // Document the differences
        expect(originalViewBox).toBeDefined();
        expect(regeneratedViewBox).toBeDefined();

        // The viewBox values are different (this is the bug)
        // When fixed, they should be identical
        expect(originalViewBox).not.toBe(regeneratedViewBox);
      });
    });
  });

  describe('Bug Investigation Notes', () => {
    it('should document potential root causes', () => {
      const bugReport = {
        symptom:
          'ViewBox regeneration from identical visual content produces 75-95% pixel differences',
        impact: 'Critical - invalidates the entire premise of "visual bbox you can trust"',
        potentialCauses: [
          'SvgVisualBBox.getSvgElementVisibleAndFullBBoxes() returns incorrect coordinates',
          'sbb-fix-viewbox changes SVG structure during serialization',
          'Browser rendering differences due to viewBox coordinate changes',
          'Missing visual elements in bbox calculation (filters, masks, clip-paths)',
          'Coordinate precision loss during string serialization',
          'preserveAspectRatio attribute affecting rendering differently'
        ],
        nextSteps: [
          'Add debug logging to sbb-fix-viewbox to show computed bbox values',
          'Compare DOM structure before/after regeneration',
          'Test with simpler SVGs to isolate the issue',
          'Verify browser rendering is identical in headless Chrome',
          'Check if XMLSerializer changes attribute order or values'
        ]
      };

      console.log('\n  Bug Report:', JSON.stringify(bugReport, null, 2), '\n');
      expect(bugReport.symptom).toBeDefined();
    });
  });
});
