/**
 * SvgVisualBBox.cjs — Node CommonJS entry point for the svg-bbox package.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Why this file exists
 * ─────────────────────────────────────────────────────────────────────────
 * `SvgVisualBBox.js` is a UMD bundle designed to run inside a browser
 * (or a Puppeteer page). The package's `"type": "module"` flag in
 * package.json makes Node load `.js` files through the ESM loader, where
 * the UMD's `module.exports = factory()` branch never runs — so a plain
 * `require('svg-bbox')` from a Node CommonJS file used to return `{}`.
 *
 * Bun handles UMD differently and `require('svg-bbox')` works there
 * out-of-the-box. This shim closes the gap so Node CommonJS consumers
 * get the same ergonomics: `require('svg-bbox').extractFbfFrame(...)`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * What you get from this entry
 * ─────────────────────────────────────────────────────────────────────────
 * **DOM-free helpers (work in plain Node, no Puppeteer needed):**
 *   - extractFbfFrame, describeFbf, isFbfSvg, pinFrame,
 *     formatFrameId, resolveFrameId
 *
 *   These are pure string manipulation. They share their implementation
 *   with `lib/fbf.cjs` (the single source of truth used by every CLI
 *   tool), so behaviour is byte-for-byte identical.
 *
 * **DOM-bound helpers (throw a helpful error if called in Node):**
 *   - waitForDocumentFonts
 *   - getSvgElementVisualBBoxTwoPassAggressive
 *   - getSvgElementsUnionVisualBBox
 *   - getSvgElementVisibleAndFullBBoxes
 *   - getSvgRootViewBoxExpansionForFullDrawing
 *   - showTrueBBoxBorder
 *   - setViewBoxOnObjects
 *
 *   These need `window`, `document`, `<canvas>`, and `getBBox()`, which
 *   plain Node doesn't have. Calling them throws an Error that explains
 *   the supported pattern: load `SvgVisualBBox.js` into a Puppeteer
 *   page via `page.addScriptTag({ path })` and call them from
 *   `page.evaluate()`. The svg-bbox CLI tools (sbb-getbbox, sbb-extract,
 *   sbb-svg2png, …) all use this pattern — read any of them for a
 *   complete worked example.
 *
 * Browser consumers (CDN, `<script>` tag, bundlers that follow the
 * `"browser"` export field) load the UMD `SvgVisualBBox.js` directly
 * and never see this shim.
 */

'use strict';

// FBF.SVG helpers — single source of truth lives in lib/fbf.cjs and is
// re-exported here so Node consumers can do
// `require('svg-bbox').extractFbfFrame(...)` without thinking about
// which subpath to use.
const {
  extractFbfFrame,
  describeFbf,
  isFbfSvg,
  pinFrame,
  formatFrameId,
  resolveFrameId
} = require('./lib/fbf.cjs');

/**
 * Build a stub that throws an actionable error when a DOM-bound helper
 * is invoked from plain Node. The message names the function and points
 * the caller at the working pattern instead of leaving them to puzzle
 * through "X is not a function" or a silent no-op.
 *
 * @param {string} name - Name of the DOM-bound helper.
 * @returns {(...args: unknown[]) => never}
 */
function _domOnly(name) {
  return function () {
    throw new Error(
      `svg-bbox: ${name}() needs a browser DOM (window, document, <canvas>, ` +
        `getBBox). Plain Node cannot run it. Load SvgVisualBBox.js into a ` +
        `Puppeteer page via page.addScriptTag({ path: require.resolve('svg-bbox') }) ` +
        `and call ${name} from page.evaluate(). The svg-bbox CLI tools ` +
        `(sbb-getbbox.cjs, sbb-extract.cjs, sbb-svg2png.cjs, …) use this ` +
        `pattern — read any of them for a complete worked example.`
    );
  };
}

module.exports = {
  // ── FBF.SVG support (works in plain Node) ─────────────────────────
  extractFbfFrame,
  describeFbf,
  isFbfSvg,
  pinFrame,
  formatFrameId,
  resolveFrameId,

  // ── DOM-bound helpers (throw with actionable error in Node) ────────
  waitForDocumentFonts: _domOnly('waitForDocumentFonts'),
  getSvgElementVisualBBoxTwoPassAggressive: _domOnly('getSvgElementVisualBBoxTwoPassAggressive'),
  getSvgElementsUnionVisualBBox: _domOnly('getSvgElementsUnionVisualBBox'),
  getSvgElementVisibleAndFullBBoxes: _domOnly('getSvgElementVisibleAndFullBBoxes'),
  getSvgRootViewBoxExpansionForFullDrawing: _domOnly('getSvgRootViewBoxExpansionForFullDrawing'),
  showTrueBBoxBorder: _domOnly('showTrueBBoxBorder'),
  setViewBoxOnObjects: _domOnly('setViewBoxOnObjects')
};
