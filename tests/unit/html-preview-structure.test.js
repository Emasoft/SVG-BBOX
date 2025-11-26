/**
 * HTML Preview Structure Validation Tests
 *
 * These tests verify that sbb-extractor.cjs generates HTML with the correct
 * structure to properly display preview thumbnails.
 *
 * WHAT WE TEST:
 * - Parent transform collection and wrapper generation
 * - Hidden container has NO viewBox
 * - Preview SVGs use viewBox (not width/height in user units)
 * - Coordinate precision preservation
 *
 * WHY NOT VISUAL TESTING:
 * The SvgVisualBBox library cannot measure <use> elements that reference external SVGs.
 * When cloning for rasterization, <use href="#id"> references break.
 * Manual verification by user confirmed: "yes, it worked!"
 *
 * CRITICAL HEADLESS BROWSER QUIRK:
 * style="display:none" does NOT work reliably in headless browsers (Chrome/Puppeteer)!
 * Elements with display:none may still be visible or may not render references correctly.
 * Instead, sbb-extractor.cjs uses CSS class .hidden-svg-container with:
 *   - position: absolute
 *   - width: 0; height: 0
 *   - overflow: hidden
 *   - visibility: hidden
 * This reliably hides the container while keeping SVG definitions accessible to <use>.
 *
 * These tests document the correct HTML structure so future changes don't break it.
 */

import { test, describe, expect } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import { JSDOM } from 'jsdom';

const execFilePromise = promisify(execFile);

describe('HTML Preview Structure Validation', () => {
  test('export-svg-objects generates HTML with parent transform wrappers', async () => {
    // Generate HTML from sample SVG
    const { stdout: _stdout } = await execFilePromise('node', [
      'sbb-extractor.cjs',
      'samples/test_text_to_path_advanced.svg',
      '--list',
      '--out-html',
      '/tmp/test_structure.html'
    ]);

    // Read generated HTML
    const html = await fs.readFile('/tmp/test_structure.html', 'utf8');
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Find preview cells with parent transforms
    const previewsWithWrappers = doc.querySelectorAll('svg g[transform] use');

    // Should have multiple elements with parent transform wrappers
    // (text8, text9, rect1851 all have parent groups with transforms)
    expect(previewsWithWrappers.length).toBeGreaterThan(0);

    // Verify structure: <g transform="..."><use href="#id" /></g>
    previewsWithWrappers.forEach((use) => {
      const wrapper = use.parentElement;
      expect(wrapper.tagName).toBe('g');
      expect(wrapper.hasAttribute('transform')).toBe(true);
      expect(use.tagName).toBe('use');
      expect(use.hasAttribute('href')).toBe(true);
    });
  }, 30000);

  test('Hidden container SVG has NO viewBox attribute', async () => {
    const html = await fs.readFile('/tmp/test_structure.html', 'utf8');
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Find hidden container by CSS class (not inline style)
    // IMPORTANT: style="display:none" doesn't work reliably in headless browsers!
    // We use CSS class .hidden-svg-container with visibility:hidden instead
    const hiddenDiv = doc.querySelector('.hidden-svg-container');
    expect(hiddenDiv).toBeTruthy();

    const containerSvg = hiddenDiv.querySelector('svg');
    expect(containerSvg).toBeTruthy();

    // CRITICAL: Container must NOT have viewBox
    expect(containerSvg.hasAttribute('viewBox')).toBe(false);
    expect(containerSvg.hasAttribute('width')).toBe(false);
    expect(containerSvg.hasAttribute('height')).toBe(false);
    expect(containerSvg.hasAttribute('x')).toBe(false);
    expect(containerSvg.hasAttribute('y')).toBe(false);
  });

  test('Preview SVGs use viewBox with full precision coordinates', async () => {
    const html = await fs.readFile('/tmp/test_structure.html', 'utf8');
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Find preview SVGs (not in hidden container)
    // IMPORTANT: Hidden container uses CSS class, not inline style!
    const previewSvgs = Array.from(doc.querySelectorAll('svg')).filter(
      (svg) => !svg.closest('.hidden-svg-container')
    );

    expect(previewSvgs.length).toBeGreaterThan(0);

    previewSvgs.forEach((svg) => {
      // Must have viewBox
      expect(svg.hasAttribute('viewBox')).toBe(true);

      const viewBox = svg.getAttribute('viewBox');
      const values = viewBox.split(/\s+/);
      expect(values).toHaveLength(4);

      // Check precision: should have decimal places (not rounded to integers)
      const hasDecimalPrecision = values.some((v) => v.includes('.'));
      if (hasDecimalPrecision) {
        // If any value has decimals, verify they're preserved (not rounded to 2 decimals)
        const decimalValues = values.filter((v) => v.includes('.'));
        const hasPrecision = decimalValues.some((v) => {
          const decimals = v.split('.')[1];
          return decimals && decimals.length > 2;
        });
        expect(hasPrecision).toBe(true);
      }
    });
  });

  test('text8 preview has correct parent transform from g37', async () => {
    const html = await fs.readFile('/tmp/test_structure.html', 'utf8');

    // Find text8's preview cell (contains <use href="#text8" />)
    const text8Match = html.match(
      /<svg[^>]*viewBox="[^"]*"[^>]*>.*?<g\s+transform="([^"]*)"[^>]*>.*?<use\s+href="#text8"[^>]*>.*?<\/svg>/s
    );

    expect(text8Match).toBeTruthy();

    // Extract the transform from wrapper <g>
    const transform = text8Match[1];

    // Should be translate(-13.613145,-10.209854) from parent g37
    expect(transform).toContain('translate');
    expect(transform).toContain('-13.613145');
    expect(transform).toContain('-10.209854');
  });

  test('rect1851 preview has correct parent transform from g1 and g37', async () => {
    const html = await fs.readFile('/tmp/test_structure.html', 'utf8');

    // Find rect1851's specific row by data-id attribute, then extract the transform
    // This is more robust than regex matching across the whole document
    const rect1851Match = html.match(
      /data-id="rect1851"[\s\S]*?<g\s+transform="([^"]*)"[^>]*>[\s\S]*?<use\s+href="#rect1851"/
    );

    expect(rect1851Match).toBeTruthy();

    const transform = rect1851Match[1];

    // rect1851 is inside g1 which is inside g37
    // Should have BOTH parent transforms concatenated in single attribute:
    // translate(-13.613145,-10.209854) from g37
    // translate(-1144.8563,517.64642) from g1
    expect(transform).toContain('translate');
    expect(transform).toContain('-13.613145');
    expect(transform).toContain('-10.209854');
    expect(transform).toContain('-1144.8563');
    expect(transform).toContain('517.64642');
  });

  test('Elements without parent transforms have no wrapper <g>', async () => {
    const html = await fs.readFile('/tmp/test_structure.html', 'utf8');
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Find all preview <use> elements (not in hidden container)
    // IMPORTANT: Hidden container uses CSS class, not inline style!
    const allUses = Array.from(doc.querySelectorAll('svg use')).filter(
      (use) => !use.closest('.hidden-svg-container')
    );

    // Some should NOT have a wrapper <g> (elements without parent transforms)
    const usesWithoutWrapper = allUses.filter((use) => {
      const parent = use.parentElement;
      return parent.tagName !== 'g' || !parent.hasAttribute('transform');
    });

    // Should have at least some elements without parent transforms
    // (text37 is a direct child of root SVG, no parent group)
    expect(usesWithoutWrapper.length).toBeGreaterThan(0);
  });

  test('Preview cells have correct border structure (external to SVG)', async () => {
    const html = await fs.readFile('/tmp/test_structure.html', 'utf8');
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Find all preview SVGs (not in hidden container)
    const previewSvgs = Array.from(doc.querySelectorAll('svg')).filter(
      (svg) => !svg.closest('.hidden-svg-container')
    );

    expect(previewSvgs.length).toBeGreaterThan(0);

    previewSvgs.forEach((svg) => {
      // SVG must have width="100%" height="100%"
      expect(svg.getAttribute('width')).toBe('100%');
      expect(svg.getAttribute('height')).toBe('100%');

      // SVG must have viewBox
      expect(svg.hasAttribute('viewBox')).toBe(true);

      // SVG must have display:block style
      const svgStyle = svg.getAttribute('style');
      expect(svgStyle).toContain('display:block');
      expect(svgStyle).toContain('max-width:120px');
      expect(svgStyle).toContain('max-height:120px');

      // SVG must be wrapped in <span> with border
      const wrapper = svg.parentElement;
      expect(wrapper.tagName).toBe('SPAN');

      const wrapperStyle = wrapper.getAttribute('style');
      // Wrapper must have display:inline-block
      expect(wrapperStyle).toContain('display:inline-block');

      // Wrapper must have line-height:0 to remove inline spacing
      expect(wrapperStyle).toContain('line-height:0');

      // Wrapper must have border (NOT on SVG!)
      expect(wrapperStyle).toContain('border:1px dashed rgba(0,0,0,0.4)');

      // SVG itself should NOT have border or outline
      if (svgStyle) {
        expect(svgStyle).not.toContain('border');
        expect(svgStyle).not.toContain('outline');
      }
    });
  });

  test('Border wrapper structure allows external border (no overlap)', async () => {
    const html = await fs.readFile('/tmp/test_structure.html', 'utf8');
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Find first preview cell
    const previewSvg = Array.from(doc.querySelectorAll('svg')).find(
      (svg) => !svg.closest('.hidden-svg-container')
    );

    expect(previewSvg).toBeTruthy();

    // Verify complete structure:
    // <div style="width:120px; height:120px; ...">  ← Container
    //   <span style="display:inline-block; border:1px dashed rgba(0,0,0,0.4); line-height:0;">  ← Border wrapper
    //     <svg viewBox="..." width="100%" height="100%" style="max-width:120px; max-height:120px; display:block;">
    //       ...
    //     </svg>
    //   </span>
    // </div>

    const borderWrapper = previewSvg.parentElement;
    expect(borderWrapper.tagName).toBe('SPAN');

    const container = borderWrapper.parentElement;
    expect(container.tagName).toBe('DIV');

    const containerStyle = container.getAttribute('style');
    expect(containerStyle).toContain('width:120px');
    expect(containerStyle).toContain('height:120px');
    expect(containerStyle).toContain('display:flex');
    expect(containerStyle).toContain('align-items:center');
    expect(containerStyle).toContain('justify-content:center');

    // Border must be on wrapper, not SVG
    const wrapperStyle = borderWrapper.getAttribute('style');
    expect(wrapperStyle).toContain('border:1px dashed rgba(0,0,0,0.4)');

    const svgStyle = previewSvg.getAttribute('style') || '';
    expect(svgStyle).not.toContain('border');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SUMMARY OF VALIDATED STRUCTURE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * These tests verify the HTML structure is correct:
 *
 * ✅ Parent transform wrappers: <g transform="..."><use href="#id" /></g>
 * ✅ Hidden container: NO viewBox attribute
 * ✅ Preview SVGs: Use viewBox with full precision
 * ✅ Specific examples: text8, rect1851 have correct parent transforms
 * ✅ No unnecessary wrappers: Elements without parent transforms unwrapped
 * ✅ Border structure: <span> wrapper with border (NOT on SVG) for external border
 *
 * Manual verification (user confirmed): "yes, it worked!"
 *
 * This structure ensures previews render correctly with:
 * - Correct transform chains
 * - No coordinate clipping
 * - Pixel-perfect precision
 */
