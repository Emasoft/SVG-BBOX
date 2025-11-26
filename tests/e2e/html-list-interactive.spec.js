/* eslint-env node, browser */
/**
 * HTML List Interactive Features E2E Tests
 *
 * These tests use Playwright to validate the interactive features of the HTML catalog:
 * - Real-time ID validation while typing
 * - Red background on invalid IDs
 * - Error messages under invalid inputs
 * - Save button disabled when errors exist
 * - JSON export with correct mapping format
 * - Checkbox interaction
 * - Filter functionality
 *
 * CRITICAL: These are REAL browser tests, NOT mocks!
 * - Launches actual Chromium browser
 * - Loads actual generated HTML file
 * - Simulates real user typing/clicking
 * - Validates actual DOM changes and computed styles
 */

import { test, expect } from '@playwright/test';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execFilePromise = promisify(execFile);

// Use project-local temp directory
const TEMP_DIR = path.join(process.cwd(), 'tests', '.tmp-e2e-interactive-tests');
const TEST_HTML = path.join(TEMP_DIR, 'test_interactive.html');

// Generate HTML file once before all tests
test.beforeAll(async () => {
  // Create temp directory
  await fs.mkdir(TEMP_DIR, { recursive: true });

  console.log('Generating HTML catalog for interactive testing...');
  await execFilePromise('node', [
    'sbb-extractor.cjs',
    'samples/test_text_to_path_advanced.svg',
    '--list',
    '--out-html',
    TEST_HTML
  ]);
  console.log(`HTML catalog generated at ${TEST_HTML}`);
});

test.afterAll(async () => {
  // Clean up temp directory
  await fs.rm(TEMP_DIR, { recursive: true, force: true });
});

test.describe('HTML List Interactive Features', () => {
  // Run tests in this file serially to avoid race conditions with shared HTML file
  test.describe.configure({ mode: 'serial' });

  test('Page loads correctly with all interactive elements', async ({ page }) => {
    await page.goto(`file://${path.resolve(TEST_HTML)}`);

    // Check title
    await expect(page).toHaveTitle(/SVG Objects/);

    // Check filter inputs exist
    await expect(page.locator('#filterRegex')).toBeVisible();
    await expect(page.locator('#filterTag')).toBeVisible();
    await expect(page.locator('#filterGroupId')).toBeVisible();

    // Check save button exists
    const saveButton = page.locator('button:has-text("Save JSON with renaming")');
    await expect(saveButton).toBeVisible();

    // Check at least one row exists
    const rows = page.locator('tbody tr');
    await expect(rows.first()).toBeVisible();
  });

  test('Valid ID input shows NO error and NO red background', async ({ page }) => {
    await page.goto(`file://${path.resolve(TEST_HTML)}`);

    // Find first row with an ID
    const firstRow = page.locator('tbody tr').first();
    const input = firstRow.locator('input[type="text"]');
    const checkbox = firstRow.locator('input[type="checkbox"]');

    // Type a valid ID
    await input.fill('valid_icon_name');
    await checkbox.check();

    // Wait for validation to run
    await page.waitForTimeout(100);

    // Check NO red background (should be white or transparent)
    const bgColor = await firstRow.evaluate((el) => {
      return window.getComputedStyle(el).backgroundColor;
    });
    expect(bgColor).not.toContain('255, 0, 0'); // Not red
    expect(bgColor).not.toContain('rgb(255, 200, 200)'); // Not light red

    // Check NO error message
    const errorMsg = firstRow.locator('.error-message');
    await expect(errorMsg).not.toBeVisible();
  });

  test('Invalid ID syntax shows red background and error message', async ({ page }) => {
    await page.goto(`file://${path.resolve(TEST_HTML)}`);

    const firstRow = page.locator('tbody tr').first();
    const input = firstRow.locator('input[type="text"]');
    const checkbox = firstRow.locator('input[type="checkbox"]');

    // Type INVALID ID (starts with number)
    await input.fill('123invalid');
    await checkbox.check();

    // Wait for validation
    await page.waitForTimeout(100);

    // Check red background (CSS applies to td, not tr)
    const bgColor = await firstRow
      .locator('td')
      .first()
      .evaluate((el) => {
        return window.getComputedStyle(el).backgroundColor;
      });
    expect(bgColor).toMatch(/rgb\(255, 200, 200\)|rgba\(255, 200, 200/);

    // Check error message appears
    const errorMsg = firstRow.locator('.error-message');
    await expect(errorMsg).toBeVisible();
    await expect(errorMsg).toContainText(/invalid.*syntax|must start with/i);
  });

  test('Duplicate ID shows red background and collision error', async ({ page }) => {
    await page.goto(`file://${path.resolve(TEST_HTML)}`);

    const rows = page.locator('tbody tr');
    const firstRow = rows.nth(0);
    const secondRow = rows.nth(1);

    const input1 = firstRow.locator('input[type="text"]');
    const checkbox1 = firstRow.locator('input[type="checkbox"]');
    const input2 = secondRow.locator('input[type="text"]');
    const checkbox2 = secondRow.locator('input[type="checkbox"]');

    // Type same ID in both rows
    await input1.fill('duplicate_name');
    await checkbox1.check();
    await input2.fill('duplicate_name');
    await checkbox2.check();

    // Wait for validation
    await page.waitForTimeout(100);

    // Second row should have red background (lower priority loses) (CSS applies to td)
    const bgColor2 = await secondRow
      .locator('td')
      .first()
      .evaluate((el) => {
        return window.getComputedStyle(el).backgroundColor;
      });
    expect(bgColor2).toMatch(/rgb\(255, 200, 200\)|rgba\(255, 200, 200/);

    // Check error message
    const errorMsg2 = secondRow.locator('.error-message');
    await expect(errorMsg2).toBeVisible();
    await expect(errorMsg2).toContainText(/collision|already.*used|already.*exists|duplicate/i);
  });

  test('Collision with existing SVG ID shows red background and error', async ({ page }) => {
    await page.goto(`file://${path.resolve(TEST_HTML)}`);

    const rows = page.locator('tbody tr');

    // Get first row's current ID (from "OBJECT ID" column)
    const firstRow = rows.nth(0);
    const currentId = await firstRow.locator('td').nth(1).textContent();

    if (!currentId || currentId.trim() === '') {
      // @ts-expect-error - Playwright test.skip can be called with a string message
      test.skip('First row has no ID to test collision');
      return;
    }

    // Try to rename a DIFFERENT row to the same ID
    const secondRow = rows.nth(1);
    const input2 = secondRow.locator('input[type="text"]');
    const checkbox2 = secondRow.locator('input[type="checkbox"]');

    await input2.fill(currentId.trim());
    await checkbox2.check();

    // Wait for validation
    await page.waitForTimeout(100);

    // Should have red background (CSS applies to td)
    const bgColor = await secondRow
      .locator('td')
      .first()
      .evaluate((el) => {
        return window.getComputedStyle(el).backgroundColor;
      });
    expect(bgColor).toMatch(/rgb\(255, 200, 200\)|rgba\(255, 200, 200/);

    // Check error message
    const errorMsg = secondRow.locator('.error-message');
    await expect(errorMsg).toBeVisible();
    await expect(errorMsg).toContainText(/exists|collision|already/i);
  });

  test('Save button is DISABLED when errors exist', async ({ page }) => {
    await page.goto(`file://${path.resolve(TEST_HTML)}`);

    const firstRow = page.locator('tbody tr').first();
    const input = firstRow.locator('input[type="text"]');
    const checkbox = firstRow.locator('input[type="checkbox"]');
    const saveButton = page.locator('button:has-text("Save JSON with renaming")');

    // Initially button should be enabled (no errors)
    await expect(saveButton).toBeEnabled();

    // Type invalid ID
    await input.fill('999invalid');
    await checkbox.check();

    // Wait for validation
    await page.waitForTimeout(100);

    // Button should now be DISABLED
    await expect(saveButton).toBeDisabled();
  });

  test('Save button is ENABLED when all checked rows are valid', async ({ page }) => {
    await page.goto(`file://${path.resolve(TEST_HTML)}`);

    const firstRow = page.locator('tbody tr').first();
    const input = firstRow.locator('input[type="text"]');
    const checkbox = firstRow.locator('input[type="checkbox"]');
    const saveButton = page.locator('button:has-text("Save JSON with renaming")');

    // Type valid ID
    await input.fill('valid_unique_name');
    await checkbox.check();

    // Wait for validation
    await page.waitForTimeout(100);

    // Button should be ENABLED
    await expect(saveButton).toBeEnabled();
  });

  test('JSON export contains correct mapping with user-provided names', async ({ page }) => {
    await page.goto(`file://${path.resolve(TEST_HTML)}`);

    const rows = page.locator('tbody tr');
    const firstRow = rows.nth(0);
    const secondRow = rows.nth(1);

    // Get original IDs
    const originalId1 = await firstRow.locator('td').nth(1).textContent();
    const originalId2 = await secondRow.locator('td').nth(1).textContent();

    // Fill new names
    const input1 = firstRow.locator('input[type="text"]');
    const checkbox1 = firstRow.locator('input[type="checkbox"]');
    const input2 = secondRow.locator('input[type="text"]');
    const checkbox2 = secondRow.locator('input[type="checkbox"]');

    await input1.fill('renamed_first');
    await checkbox1.check();
    await input2.fill('renamed_second');
    await checkbox2.check();

    // Wait for validation
    await page.waitForTimeout(100);

    // Listen for download
    const downloadPromise = page.waitForEvent('download');

    // Click save button
    const saveButton = page.locator('button:has-text("Save JSON with renaming")');
    await saveButton.click();

    // Wait for download
    const download = await downloadPromise;

    // Save to temp file
    const downloadPath = path.join(TEMP_DIR, 'test_rename_mapping.json');
    await download.saveAs(downloadPath);

    // Read and parse JSON
    const jsonContent = await fs.readFile(downloadPath, 'utf8');
    const mapping = JSON.parse(jsonContent);

    // Validate JSON structure
    expect(mapping).toHaveProperty('sourceSvgFile');
    expect(mapping.sourceSvgFile).toContain('test_text_to_path_advanced.svg');
    expect(mapping).toHaveProperty('createdAt');
    expect(mapping).toHaveProperty('mappings');
    expect(Array.isArray(mapping.mappings)).toBe(true);

    // Validate mappings array contains our renames
    expect(mapping.mappings.length).toBeGreaterThanOrEqual(2);

    const map1 = mapping.mappings.find((m) => m.to === 'renamed_first');
    const map2 = mapping.mappings.find((m) => m.to === 'renamed_second');

    expect(map1).toBeDefined();
    expect(map1.from).toBe(originalId1.trim());
    expect(map1.to).toBe('renamed_first');

    expect(map2).toBeDefined();
    expect(map2.from).toBe(originalId2.trim());
    expect(map2.to).toBe('renamed_second');
  });

  test('Unchecked rows are NOT included in JSON export', async ({ page }) => {
    await page.goto(`file://${path.resolve(TEST_HTML)}`);

    const rows = page.locator('tbody tr');
    const firstRow = rows.nth(0);
    const secondRow = rows.nth(1);

    // Fill first row but DON'T check it
    const input1 = firstRow.locator('input[type="text"]');
    await input1.fill('not_checked');
    // checkbox1 NOT checked

    // Fill second row and CHECK it
    const input2 = secondRow.locator('input[type="text"]');
    const checkbox2 = secondRow.locator('input[type="checkbox"]');
    await input2.fill('checked_item');
    await checkbox2.check();

    // Wait for validation
    await page.waitForTimeout(100);

    // Listen for download
    const downloadPromise = page.waitForEvent('download');

    // Click save button
    const saveButton = page.locator('button:has-text("Save JSON with renaming")');
    await saveButton.click();

    // Wait for download
    const download = await downloadPromise;

    // Save to temp file
    const downloadPath = path.join(TEMP_DIR, 'test_rename_unchecked.json');
    await download.saveAs(downloadPath);

    // Read and parse JSON
    const jsonContent = await fs.readFile(downloadPath, 'utf8');
    const mapping = JSON.parse(jsonContent);

    // Should have exactly 1 mapping (only the checked one)
    expect(mapping.mappings.length).toBe(1);
    expect(mapping.mappings[0].to).toBe('checked_item');

    // Should NOT contain unchecked item
    const uncheckedItem = mapping.mappings.find((m) => m.to === 'not_checked');
    expect(uncheckedItem).toBeUndefined();
  });

  test('Regex filter hides non-matching rows', async ({ page }) => {
    await page.goto(`file://${path.resolve(TEST_HTML)}`);

    const filterInput = page.locator('#filterRegex');
    const rows = page.locator('tbody tr');

    // Count initial visible rows
    const initialCount = await rows.count();
    expect(initialCount).toBeGreaterThan(0);

    // Type filter regex (e.g., only IDs starting with "g")
    await filterInput.fill('^g');

    // Wait for filter to apply
    await page.waitForTimeout(100);

    // Count visible rows (should be fewer than initial)
    const visibleRows = await rows.evaluateAll((rows) => {
      return rows.filter((row) => row.style.display !== 'none');
    });
    const filteredCount = visibleRows.length;

    // At least some rows should be hidden
    expect(filteredCount).toBeLessThan(initialCount);

    // Check that all visible rows match the filter
    const visibleIds = await rows.evaluateAll((rows) => {
      return rows
        .filter((row) => /** @type {HTMLElement} */ (row).style.display !== 'none')
        .map((row) => /** @type {HTMLTableRowElement} */ (row).cells[1]?.textContent?.trim()); // ID column
    });
    visibleIds.forEach((id) => {
      expect(id).toMatch(/^g/);
    });
  });

  test('Tag filter shows only matching element types', async ({ page }) => {
    await page.goto(`file://${path.resolve(TEST_HTML)}`);

    const filterSelect = page.locator('#filterTag');
    const rows = page.locator('tbody tr');

    // Select "path" from dropdown
    await filterSelect.selectOption('path');

    // Wait for filter to apply
    await page.waitForTimeout(100);

    // Get all visible rows
    const visibleRows = await rows.evaluateAll((rows) => {
      return rows
        .filter((row) => /** @type {HTMLElement} */ (row).style.display !== 'none')
        .map((row) => {
          const text = /** @type {HTMLTableRowElement} */ (row).cells[2]?.textContent?.trim(); // Tag column
          // Extract tag name from <tag> format
          const match = text?.match(/<(\w+)>/);
          return match ? match[1] : text;
        });
    });

    // All visible rows should be "path"
    visibleRows.forEach((tag) => {
      expect(tag).toBe('path');
    });
  });

  test('Real-time validation updates on every keystroke', async ({ page }) => {
    await page.goto(`file://${path.resolve(TEST_HTML)}`);

    const firstRow = page.locator('tbody tr').first();
    const input = firstRow.locator('input[type="text"]');
    const checkbox = firstRow.locator('input[type="checkbox"]');

    await checkbox.check();

    // Type invalid ID one character at a time
    await input.fill('');
    await input.type('1'); // Invalid (starts with number)
    await page.waitForTimeout(50);

    // Should show error immediately (CSS applies to td)
    let bgColor = await firstRow
      .locator('td')
      .first()
      .evaluate((el) => {
        return window.getComputedStyle(el).backgroundColor;
      });
    expect(bgColor).toMatch(/rgb\(255, 200, 200\)|rgba\(255, 200, 200/);

    // Now type a valid prefix
    await input.fill('');
    await input.type('v'); // Valid so far
    await page.waitForTimeout(50);

    // Should NOT show error
    bgColor = await firstRow
      .locator('td')
      .first()
      .evaluate((el) => {
        return window.getComputedStyle(el).backgroundColor;
      });
    expect(bgColor).not.toContain('255, 200, 200');

    // Continue typing valid characters
    await input.type('alid_name');
    await page.waitForTimeout(50);

    // Still no error
    bgColor = await firstRow
      .locator('td')
      .first()
      .evaluate((el) => {
        return window.getComputedStyle(el).backgroundColor;
      });
    expect(bgColor).not.toContain('255, 200, 200');
  });

  test('Empty input with checked box shows error', async ({ page }) => {
    await page.goto(`file://${path.resolve(TEST_HTML)}`);

    const firstRow = page.locator('tbody tr').first();
    const input = firstRow.locator('input[type="text"]');
    const checkbox = firstRow.locator('input[type="checkbox"]');

    // Check box but leave input empty
    await input.fill('');
    await checkbox.check();

    // Wait for validation
    await page.waitForTimeout(100);

    // Should show error (empty new ID is invalid) (CSS applies to td)
    const bgColor = await firstRow
      .locator('td')
      .first()
      .evaluate((el) => {
        return window.getComputedStyle(el).backgroundColor;
      });
    expect(bgColor).toMatch(/rgb\(255, 200, 200\)|rgba\(255, 200, 200/);

    // Error message should appear
    const errorMsg = firstRow.locator('.error-message');
    await expect(errorMsg).toBeVisible();
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SUMMARY OF INTERACTIVE TESTS
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * These E2E tests validate REAL browser behavior:
 *
 * ✅ Real-time validation while typing (every keystroke)
 * ✅ Red background appears/disappears based on validity
 * ✅ Error messages show specific validation failures
 * ✅ Save button disabled when errors exist
 * ✅ JSON export with correct structure and mappings
 * ✅ Checkbox filtering (unchecked rows excluded)
 * ✅ Regex filter hides non-matching rows
 * ✅ Tag filter shows only matching element types
 * ✅ Duplicate detection and collision warnings
 * ✅ Empty input validation
 *
 * NOT MOCKED - Uses real Chromium browser via Playwright
 */
