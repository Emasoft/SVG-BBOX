/**
 * SvgVisualBBox.js
 *
 * High-accuracy *visual* bounding boxes for SVG content using a two-pass
 * rasterization strategy. Designed to handle:
 *   - complex text (CJK, Arabic, ligatures, RTL/LTR mixing, text-anchor)
 *   - <use>, <symbol>, <defs>, markers, gradients, patterns
 *   - stroke width, caps, joins, markers, vector-effect
 *   - filters, masks, clipPaths, compositing, images/bitmaps
 *
 * Approach
 * --------
 * 1. Clone the root <svg>, isolate the target element while keeping <defs>.
 * 2. PASS 1: rasterize a large region at coarse resolution → rough bbox.
 * 3. Expand rough bbox with a large safety margin.
 * 4. PASS 2: rasterize only that region at high resolution → precise bbox.
 *
 * All bounding boxes are returned in the root <svg>'s user coordinate system
 * (i.e. its viewBox units). That makes them directly comparable to all
 * other SVG coordinates (paths, rects, etc).
 *
 * Security / CORS
 * ---------------
 * Reading back pixels from <canvas> requires that the SVG and all referenced
 * images/fonts are same-origin or CORS-enabled. Otherwise the canvas is
 * "tainted" and getImageData() will throw a SecurityError.
 *
 * Public API (namespace: SvgVisualBBox)
 * -------------------------------------
 *  - waitForDocumentFonts(doc?, timeoutMs?)
 *      Waits for document fonts to load (CSS Font Loading API), with timeout.
 *
 *  - getSvgElementVisualBBoxTwoPassAggressive(target, options?)
 *      High-accuracy visual bbox for a single SVG element.
 *
 *  - getSvgElementsUnionVisualBBox(targets[], options?)
 *      Union bbox for multiple SVG elements in the same <svg>.
 *
 *  - getSvgElementVisibleAndFullBBoxes(target, options?)
 *      Returns both:
 *        - visible: bbox clipped to viewBox / viewport
 *        - full:    bbox ignoring viewBox clipping (whole drawing ROI)
 *
 *  - getSvgRootViewBoxExpansionForFullDrawing(svgRootOrId, options?)
 *      For a root <svg> with a viewBox, computes how much padding you'd
 *      need to expand the viewBox so its visible area fully covers the
 *      drawing's full visual bbox.
 *
 *  - showTrueBBoxBorder(target, options?)
 *      Visual debug helper: displays a dotted border around any SVG element's
 *      true visual bounding box. Auto-detects dark/light theme. Works with all
 *      SVG types. Returns {bbox, overlay, remove()} for cleanup.
 *
 * Usage
 * -----
 *  <script src="SvgVisualBBox.js"></script>
 *
 *  (async () => {
 *    const bbox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive('myTextId', {
 *      mode: 'clipped',        // or 'unclipped'
 *      coarseFactor: 3,
 *      fineFactor: 24
 *    });
 *
 *    console.log(bbox.x, bbox.y, bbox.width, bbox.height);
 *  })();
 *
 *  // Multiple elements:
 *  const union = await SvgVisualBBox.getSvgElementsUnionVisualBBox(
 *    ['text1', 'text2', pathElement]
 *  );
 *
 *  // Visible vs full (before viewBox clipping):
 *  const { visible, full } = await SvgVisualBBox.getSvgElementVisibleAndFullBBoxes('mySvg');
 *
 *  // Compute how much to expand the viewBox to cover full drawing:
 *  const expansion = await SvgVisualBBox.getSvgRootViewBoxExpansionForFullDrawing('mySvg');
 */

(function (root, factory) {
  // @ts-ignore - UMD pattern: define.amd check is intentional
  if (typeof define === 'function' && define.amd) {
    // AMD
    // @ts-ignore - UMD pattern: AMD define signature
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    // CommonJS / Node
    module.exports = factory();
  } else {
    // Browser global
    // @ts-ignore - UMD pattern: dynamic property assignment to global
    root.SvgVisualBBox = factory();
  }
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  /**
   * @typedef {{x: number, y: number, width: number, height: number}} BBox
   * @typedef {{x: number, y: number, width: number, height: number, element: Element, svgRoot: SVGSVGElement}} BBoxResult
   * @typedef {{x: number, y: number, width: number, height: number, svgRoot: SVGSVGElement, bboxes: BBoxResult[]}} UnionBBoxResult
   * @typedef {{scale: number, scaleX?: undefined, scaleY?: undefined, offsetX: number, offsetY: number, uniform: true}|{scale?: undefined, scaleX: number, scaleY: number, offsetX: number, offsetY: number, uniform: false}} ScalingResult
   * @typedef {{display: string, visibility: string, opacity: string}} VisibilityState
   * @typedef {{[key: string]: VisibilityState}} VisibilityList
   */

  // Debug flag - set to true to enable console logging
  const DEBUG = false;

  // CRITICAL FIX #2: Mutex for preventing race conditions
  // WHY: Multiple simultaneous getBBox calls on same element can interfere
  // IMPACT: Ensures operations complete atomically, preventing corrupted results
  // Map: element -> promise (pending operation)
  const elementLocks = new WeakMap();

  /**
   * INTERNAL: Check if an ID looks like an auto-generated ID
   * @param {string} id
   * @returns {boolean}
   */
  function isAutoGeneratedId(id) {
    return Boolean(id && /^auto_id_/.test(id));
  }

  /**
   * INTERNAL: Get detailed information about an SVG element for error reporting
   * @param {SVGElement} el
   * @returns {string} Human-readable element description
   */
  function getElementDescription(el) {
    if (!el) {
      return 'null/undefined element';
    }

    const parts = [];

    // Tag name
    const tag = el.tagName || el.nodeName || 'unknown';
    parts.push(`<${tag}>`);

    // ID if present
    if (el.id) {
      const idDesc = isAutoGeneratedId(el.id)
        ? `id="${el.id}" (AUTO-GENERATED - not in original SVG!)`
        : `id="${el.id}"`;
      parts.push(idDesc);
    }

    // Class if present
    if (el.getAttribute && el.getAttribute('class')) {
      parts.push(`class="${el.getAttribute('class')}"`);
    }

    // Position in DOM
    const parent = el.parentNode;
    if (parent && parent instanceof Element) {
      const parentIdDesc = parent.id
        ? isAutoGeneratedId(parent.id)
          ? ` id="${parent.id}" (AUTO-GENERATED)`
          : ` id="${parent.id}"`
        : '';
      parts.push(`(child of <${parent.tagName}>${parentIdDesc})`);
    }

    return parts.join(' ');
  }

  /**
   * INTERNAL: Save debug SVG to global for error handling
   * @param {SVGSVGElement} svgRoot
   */
  function saveDebugSvgToGlobal(svgRoot) {
    if (!svgRoot) {
      return;
    }

    try {
      const serializer = new XMLSerializer();
      const svgString = serializer.serializeToString(svgRoot);
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .replace('T', '_')
        .slice(0, -5);
      const svgId = svgRoot.id || 'svg';

      // Store in global for error handler to access
      if (typeof window !== 'undefined') {
        // @ts-ignore - Dynamic debug property added at runtime
        window.__DEBUG_SVG_DATA__ = {
          content: svgString,
          filename: `${svgId}_debug_${timestamp}.svg`,
          timestamp: timestamp
        };
      }
    } catch (e) {
      // CRITICAL FIX #4: Intentionally silent error (debug helper only)
      // WHY: Saving debug data should never break the main operation
      // IMPACT: Debug failures don't propagate to user-facing code
      if (DEBUG && typeof console !== 'undefined' && console.warn) {
        console.warn('[DEBUG] Failed to save debug SVG data:', e);
      }
    }
  }

  /**
   * INTERNAL: Get auto-ID warning text if any IDs are auto-generated
   * @param {SVGElement} el
   * @param {SVGSVGElement} svgRoot
   * @returns {string} Warning text or empty string
   */
  function getAutoIdWarning(el, svgRoot) {
    const hasAutoId = el && el.id && isAutoGeneratedId(el.id);
    const parentHasAutoId =
      el &&
      el.parentNode &&
      el.parentNode instanceof Element &&
      el.parentNode.id &&
      isAutoGeneratedId(el.parentNode.id);
    const rootHasAutoId = svgRoot && svgRoot.id && isAutoGeneratedId(svgRoot.id);

    if (!hasAutoId && !parentHasAutoId && !rootHasAutoId) {
      return '';
    }

    // Save debug SVG to global for Node.js error handler to save
    saveDebugSvgToGlobal(svgRoot);

    const elementId = el && el.id ? el.id : '(none)';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, -5);
    const svgId = svgRoot && svgRoot.id ? svgRoot.id : 'svg';
    const debugFilename = `${svgId}_debug_${timestamp}.svg`;

    return (
      '\n' +
      '⚠️  AUTO-GENERATED ID WARNING:\n' +
      '   The IDs shown above were automatically assigned by sbb-extract.cjs.\n' +
      '   These IDs DO NOT EXIST in your original SVG file!\n' +
      '\n' +
      '   🔍 DEBUG SVG WILL BE AUTOMATICALLY SAVED:\n' +
      `   ${debugFilename}\n` +
      '\n' +
      '   To find this element in your original SVG:\n' +
      '   1. Open the debug SVG file (saved automatically in current directory)\n' +
      `   2. Search for the ID "${elementId}" to locate the problematic element\n` +
      "   3. Note the element's position, visual appearance, and attributes\n" +
      '   4. Find the corresponding element in your original SVG using these details\n'
    );
  }

  /**
   * INTERNAL: Get detailed font information from an element
   * @param {SVGElement} el
   * @returns {string} Font family and detected fonts
   */
  function getFontDescription(el) {
    if (!el || typeof window === 'undefined' || !window.getComputedStyle) {
      return 'unknown';
    }

    try {
      const style = window.getComputedStyle(el);
      const fontFamily = style.fontFamily || style.getPropertyValue('font-family');
      return fontFamily || 'default';
    } catch {
      // CRITICAL FIX #4: Intentionally silent error (error reporting helper)
      // WHY: Font detection failure shouldn't prevent error reporting
      // IMPACT: Returns fallback string instead of throwing
      return 'error detecting font';
    }
  }

  /**
   * Wait until the document's fonts are loaded (CSS Font Loading API),
   * with a timeout so we don't hang forever if the network is flaky.
   *
   * @param {Document} [doc=document]  The document whose fonts to wait for.
   * @param {number} [timeoutMs=5000]  Max time to wait (ms). If <=0, waits fully.
   * @returns {Promise<void>}
   */
  async function waitForDocumentFonts(doc, timeoutMs) {
    if (!doc) {
      doc = document;
    }
    if (typeof timeoutMs !== 'number' || !isFinite(timeoutMs)) {
      // CRITICAL FIX #3: Default timeout to prevent indefinite hangs
      // Also handle NaN since typeof NaN === 'number' but setTimeout(NaN) fires immediately
      timeoutMs = 5000;
    }

    const fonts = doc.fonts;
    if (!fonts || !fonts.ready) {
      // CSS Font Loading API not supported; nothing we can do.
      return;
    }

    const readyPromise = fonts.ready;

    if (timeoutMs <= 0) {
      await readyPromise;
      return;
    }

    // CRITICAL FIX #3: Add timeout handler with clear error message
    // WHY: Without timeout, font loading can hang indefinitely if network is slow/blocked
    // IMPACT: Prevents browser tab freezes when fonts fail to load
    await Promise.race([
      readyPromise,
      /** @type {Promise<void>} */ (
        new Promise((resolve) =>
          setTimeout(() => {
            if (DEBUG && typeof console !== 'undefined' && console.warn) {
              console.warn(
                `[waitForDocumentFonts] Font loading timeout after ${timeoutMs}ms - proceeding anyway`
              );
            }
            resolve(undefined);
          }, timeoutMs)
        )
      )
    ]);
  }

  /**
   * INTERNAL: Parse preserveAspectRatio attribute and calculate scaling parameters
   * for converting between page pixel coordinates and SVG user coordinates.
   *
   * @param {SVGSVGElement} svgEl - The SVG root element
   * @param {{x:number,y:number,width:number,height:number}} viewBox - The viewBox
   * @param {DOMRect} renderedRect - The getBoundingClientRect() of the SVG element
   * @returns {ScalingResult}
   */
  function parsePreserveAspectRatio(svgEl, viewBox, renderedRect) {
    const scaleX = viewBox.width / renderedRect.width;
    const scaleY = viewBox.height / renderedRect.height;

    // Get preserveAspectRatio attribute (default: "xMidYMid meet")
    const aspectRatio = svgEl.getAttribute('preserveAspectRatio') || 'xMidYMid meet';

    // Filter out "defer" keyword (only meaningful for <image> elements, not <svg>)
    const parts = aspectRatio
      .trim()
      .split(/\s+/)
      .filter((p) => p !== 'defer');

    if (parts.length === 1 && parts[0] === 'none') {
      // Non-uniform scaling - no offset needed
      return { scaleX, scaleY, offsetX: 0, offsetY: 0, uniform: false };
    }

    const align = parts[0] || 'xMidYMid';
    const meetOrSlice = parts[1] || 'meet';

    // Determine uniform scale factor
    let scale;
    if (meetOrSlice === 'slice') {
      // slice: covers viewport (SVG→page uses MAX) → page→user uses MIN
      scale = Math.min(scaleX, scaleY);
    } else {
      // meet: fits inside viewport (SVG→page uses MIN) → page→user uses MAX
      scale = Math.max(scaleX, scaleY);
    }

    // Calculate the offset due to alignment (letterboxing/pillarboxing)
    // Scaled viewBox dimensions in page pixels
    const scaledViewBoxWidth = viewBox.width / scale;
    const scaledViewBoxHeight = viewBox.height / scale;

    // Extra space in page pixels
    const extraX = renderedRect.width - scaledViewBoxWidth;
    const extraY = renderedRect.height - scaledViewBoxHeight;

    let offsetX = 0;
    let offsetY = 0;

    // Horizontal alignment (xMin/xMid/xMax)
    if (align.startsWith('xMid')) {
      offsetX = extraX / 2;
    } else if (align.startsWith('xMax')) {
      offsetX = extraX;
    }
    // xMin: offsetX = 0 (already set)

    // Vertical alignment (YMin/YMid/YMax)
    if (align.includes('YMid')) {
      offsetY = extraY / 2;
    } else if (align.includes('YMax')) {
      offsetY = extraY;
    }
    // YMin: offsetY = 0 (already set)

    return { scale, offsetX, offsetY, uniform: true };
  }

  /**
   * INTERNAL: Get a bounding box for an SVG element using ONLY getBoundingClientRect()
   * and convert from page pixels to SVG user coordinates.
   * Returns null if unable or if values are NaN/infinite.
   *
   * IMPORTANT: We do NOT use getBBox() because it:
   * - Ignores strokes, filters, transforms, and dashed lines
   * - Returns empty objects for some elements (paths, textPath)
   * - Gives incorrect results for elements outside viewBox
   *
   * @param {SVGElement} el
   * @returns {{x:number,y:number,width:number,height:number}|null}
   */
  function safeGetBBox(el) {
    try {
      const clientRect = el.getBoundingClientRect();
      const svgRoot = el.ownerSVGElement || (el instanceof SVGSVGElement ? el : null);

      if (!svgRoot || !clientRect) {
        return null;
      }
      if (clientRect.width === 0 && clientRect.height === 0) {
        return null;
      }

      // Convert screen coordinates to SVG user coordinates
      const rootRect = svgRoot.getBoundingClientRect();
      const vb = svgRoot.viewBox && svgRoot.viewBox.baseVal;

      if (!vb || vb.width <= 0 || vb.height <= 0) {
        return null;
      }
      if (rootRect.width <= 0 || rootRect.height <= 0) {
        return null;
      }

      // Parse preserveAspectRatio attribute
      const scaling = parsePreserveAspectRatio(svgRoot, vb, rootRect);

      let x, y, width, height;

      if (scaling.uniform) {
        // Uniform scaling (meet or slice) - subtract offset before scaling
        const scale = scaling.scale;
        x = vb.x + (clientRect.left - rootRect.left - scaling.offsetX) * scale;
        y = vb.y + (clientRect.top - rootRect.top - scaling.offsetY) * scale;
        width = clientRect.width * scale;
        height = clientRect.height * scale;
      } else {
        // Non-uniform scaling (preserveAspectRatio="none") - no offset
        x = vb.x + (clientRect.left - rootRect.left) * scaling.scaleX;
        y = vb.y + (clientRect.top - rootRect.top) * scaling.scaleY;
        width = clientRect.width * scaling.scaleX;
        height = clientRect.height * scaling.scaleY;
      }

      if (!isFinite(x) || !isFinite(y)) {
        return null;
      }
      if (!isFinite(width) || !isFinite(height)) {
        return null;
      }

      return { x, y, width, height };
    } catch {
      // CRITICAL FIX #4: Intentionally silent error (fallback function)
      // WHY: getBoundingClientRect can fail for detached/invalid elements
      // IMPACT: Returns null to signal fallback to caller, doesn't crash
      return null;
    }
  }

  // NOTE: _normalizeTargetForText() was removed in v1.1.2 audit (2026-01-05)
  // It was dead code - defined but never called. The function attempted to
  // normalize textPath/tspan elements by returning their parent <text>,
  // but this functionality is handled elsewhere in the codebase.

  /**
   * INTERNAL: Rasterize ONE element of ONE SVG into a canvas over a given
   * ROI (region of interest) in SVG user units, at a given resolution
   * (pixelsPerUnit), and return a visual bbox in user units.
   *
   * roi = { x, y, width, height } in svgRoot user units
   * pixelsPerUnit = canvas pixels per 1 user unit (high = better accuracy)
   *
   * @param {SVGElement} el
   * @param {SVGSVGElement} svgRoot
   * @param {{x:number,y:number,width:number,height:number}} roi
   * @param {number} pixelsPerUnit
   * @returns {Promise<{x:number,y:number,width:number,height:number}|null>}
   */
  async function rasterizeSvgElementToBBox(el, svgRoot, roi, pixelsPerUnit) {
    // CRITICAL FIX #5: Input validation for robustness
    // WHY: Invalid inputs can cause cryptic errors later in the pipeline
    // IMPACT: Clear error messages help users identify problems early
    if (!el) {
      throw new Error('rasterizeSvgElementToBBox: element parameter is null or undefined');
    }
    if (!svgRoot) {
      throw new Error('rasterizeSvgElementToBBox: svgRoot parameter is null or undefined');
    }
    if (!roi || typeof roi !== 'object') {
      throw new Error(
        'rasterizeSvgElementToBBox: roi parameter must be an object with x, y, width, height'
      );
    }
    if (roi.width <= 0 || roi.height <= 0) {
      return null; // Zero-size ROI is valid, just means no content
    }
    if (typeof pixelsPerUnit !== 'number' || pixelsPerUnit <= 0 || !isFinite(pixelsPerUnit)) {
      throw new Error(
        `rasterizeSvgElementToBBox: pixelsPerUnit must be a positive finite number, got: ${pixelsPerUnit}`
      );
    }

    const vb = roi;

    // ═══════════════════════════════════════════════════════════════════════════════
    // CRITICAL FIX #1: Temp ID Assignment Timing
    // ═══════════════════════════════════════════════════════════════════════════════
    // PROBLEM: Elements without IDs were failing with "Element not found in cloned SVG"
    //
    // ❌ WRONG SOLUTION #1 - Assign temp ID AFTER cloning (original broken code):
    //   const clonedSvg = svgRoot.cloneNode(true);           // Clone first
    //   if (!el.id) {
    //     el.id = '__temp_' + Math.random();                  // Assign ID after
    //   }
    //   const cloneTarget = clonedSvg.getElementById(el.id); // Try to find → FAILS!
    //
    // WHY IT FAILS:
    //   - cloneNode() creates snapshot of DOM at moment of cloning
    //   - Element has NO ID when cloned → cloned element also has NO ID
    //   - Adding ID to original AFTER clone doesn't affect the clone
    //   - getElementById(el.id) searches clone for an ID that doesn't exist
    //   - Result: cloneTarget = null → "Element not found" error
    //
    // ❌ WRONG SOLUTION #2 - Don't remove temp ID from original:
    //   if (!el.id) {
    //     el.id = '__temp_' + Math.random();
    //   }
    //   const clonedSvg = svgRoot.cloneNode(true);
    //   const cloneTarget = clonedSvg.getElementById(el.id); // This works BUT...
    //   // Missing: el.removeAttribute('id')
    //
    // WHY IT FAILS:
    //   - Pollutes original DOM with temp IDs that never get cleaned up
    //   - Multiple calls accumulate temp IDs in the document
    //   - Breaks ID uniqueness assumptions in user's code
    //   - User's code might rely on elements not having IDs
    //   - Memory leak: temp IDs persist forever
    //
    // ✅ CORRECT SOLUTION - Assign BEFORE clone, remove AFTER clone:
    //   const hadId = !!el.id;
    //   let tmpId;
    //   if (!hadId) {
    //     tmpId = '__svg_visual_bbox_tmp_' + Math.random().toString(36).slice(2);
    //     el.id = tmpId;                                     // Assign BEFORE clone
    //   }
    //   const clonedSvg = svgRoot.cloneNode(true);          // Clone (includes temp ID)
    //   if (!hadId) {
    //     el.removeAttribute('id');                          // Clean up original DOM
    //   }
    //   const idToFind = tmpId || el.id;                    // Use saved tmpId
    //   const cloneTarget = clonedSvg.getElementById(idToFind); // SUCCESS!
    //
    // WHY IT WORKS:
    //   1. Element HAS ID when cloned → cloned element also HAS ID
    //   2. We save tmpId BEFORE cleanup so we can use it later
    //   3. Original DOM is restored to pristine state (no temp IDs left behind)
    //   4. We can find cloned element by the ID it actually has
    //   5. No pollution, no memory leaks, no side effects
    const hadId = !!el.id;
    let tmpId;
    if (!hadId) {
      tmpId = '__svg_visual_bbox_tmp_' + Math.random().toString(36).slice(2);
      el.id = tmpId;
    }

    // Clone the root <svg> so we don't touch the real DOM
    const clonedSvg = /** @type {SVGSVGElement} */ (svgRoot.cloneNode(true));

    // Remove temp ID from original element immediately after cloning
    // This keeps the original DOM tree clean and unchanged
    if (!hadId) {
      el.removeAttribute('id');
    }

    if (!clonedSvg.getAttribute('xmlns')) {
      clonedSvg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    }

    // Map ROI user space → viewport
    clonedSvg.setAttribute('viewBox', vb.x + ' ' + vb.y + ' ' + vb.width + ' ' + vb.height);

    // Maximum canvas dimensions to avoid out-of-memory errors
    // Modern browsers support up to 16384×16384
    // Using higher limit ensures consistent actualPixelsPerUnit across elements (critical for alignment)
    const MAX_CANVAS_DIMENSION = 16384;

    // Calculate initial canvas dimensions
    const requestedPixelWidth = Math.max(1, Math.round(vb.width * pixelsPerUnit));
    const requestedPixelHeight = Math.max(1, Math.round(vb.height * pixelsPerUnit));

    // Scale down uniformly if canvas would exceed maximum dimensions (preserves aspect ratio)
    let actualPixelsPerUnit = pixelsPerUnit;
    let pixelWidth = requestedPixelWidth;
    let pixelHeight = requestedPixelHeight;

    if (requestedPixelWidth > MAX_CANVAS_DIMENSION || requestedPixelHeight > MAX_CANVAS_DIMENSION) {
      // Find which dimension exceeds the limit more
      const scaleW = MAX_CANVAS_DIMENSION / requestedPixelWidth;
      const scaleH = MAX_CANVAS_DIMENSION / requestedPixelHeight;
      // Use the smaller scale factor to ensure both dimensions fit
      const scale = Math.min(scaleW, scaleH);

      // Apply uniform scaling to preserve aspect ratio
      actualPixelsPerUnit = pixelsPerUnit * scale;
      pixelWidth = Math.max(1, Math.round(vb.width * actualPixelsPerUnit));
      pixelHeight = Math.max(1, Math.round(vb.height * actualPixelsPerUnit));

      if (DEBUG && typeof console !== 'undefined' && console.warn) {
        console.warn(
          '[DEBUG rasterize] Canvas size exceeded maximum, scaling down uniformly:\n' +
            `  Requested: ${requestedPixelWidth}×${requestedPixelHeight}\n` +
            `  Scaled:    ${pixelWidth}×${pixelHeight}\n` +
            `  Scale factor: ${scale.toFixed(3)} (${(scale * 100).toFixed(1)}%)\n` +
            `  Aspect ratio preserved: ${(vb.width / vb.height).toFixed(3)} → ${(pixelWidth / pixelHeight).toFixed(3)}`
        );
      }
    }

    clonedSvg.setAttribute('width', String(pixelWidth));
    clonedSvg.setAttribute('height', String(pixelHeight));
    // CRITICAL: Set preserveAspectRatio="none" to prevent unwanted scaling/letterboxing
    // The viewBox and width/height are already calculated to match exactly
    clonedSvg.setAttribute('preserveAspectRatio', 'none');

    // CRITICAL: Remove x/y attributes from cloned SVG to prevent offset during canvas rendering
    // The x/y attributes are for positioning when SVG is embedded as a child element,
    // but they cause unwanted offsets when rendering to canvas via data URL
    clonedSvg.removeAttribute('x');
    clonedSvg.removeAttribute('y');

    if (DEBUG && typeof console !== 'undefined' && console.log) {
      console.log('[DEBUG rasterize] After removing x/y:', {
        x: clonedSvg.getAttribute('x'),
        y: clonedSvg.getAttribute('y'),
        hasX: clonedSvg.hasAttribute('x'),
        hasY: clonedSvg.hasAttribute('y')
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // CRITICAL FIX #2 & #3: SVG Root Element + Temp ID Variable Usage
    // ═══════════════════════════════════════════════════════════════════════════════
    // PROBLEM #2: Couldn't measure SVG root element itself
    // PROBLEM #3: After removing temp ID from original, el.id was empty when searching clone
    //
    // ❌ WRONG SOLUTION #1 - Always use getElementById (original broken code):
    //   const cloneTarget = clonedSvg.getElementById(el.id); // Fails for SVG root!
    //
    // WHY IT FAILS (Issue #2):
    //   - getElementById() searches DESCENDANTS only, not the element itself
    //   - clonedSvg.getElementById(id) searches INSIDE clonedSvg, not clonedSvg itself
    //   - If el === svgRoot, we're measuring the root SVG element
    //   - But getElementById can't find the root because it IS the root!
    //   - Analogy: You can't find yourself by looking inside yourself
    //   - Result: cloneTarget = null for SVG root elements
    //
    // ❌ WRONG SOLUTION #2 - Use el.id after cleanup (another bug):
    //   if (!hadId) {
    //     el.removeAttribute('id');  // Remove temp ID from original
    //   }
    //   const cloneTarget = clonedSvg.getElementById(el.id); // el.id is empty now!
    //
    // WHY IT FAILS (Issue #3):
    //   - We removed the temp ID from original element at line 496
    //   - Now el.id is empty string (no ID attribute)
    //   - getElementById("") searches for empty string → returns null
    //   - The temp ID still exists in CLONE, but we lost the value!
    //   - We're asking "find element with ID ''" → nonsensical query
    //
    // ❌ WRONG SOLUTION #3 - Re-read ID from original element:
    //   const cloneTarget = clonedSvg.getElementById(el.getAttribute('id'));
    //
    // WHY IT FAILS:
    //   - getAttribute('id') returns null if no ID (after we removed it)
    //   - getElementById(null) searches for string "null" → wrong!
    //   - Still doesn't solve SVG root issue (#2)
    //
    // ✅ CORRECT SOLUTION - Special case for root + use saved tmpId:
    //   let cloneTarget;
    //   if (el === svgRoot) {
    //     cloneTarget = clonedSvg;              // Fix #2: Return root directly
    //   } else {
    //     const idToFind = tmpId || el.id;      // Fix #3: Use SAVED tmpId
    //     cloneTarget = clonedSvg.getElementById(idToFind);
    //   }
    //
    // WHY IT WORKS:
    //   Fix #2: Detect when measuring SVG root and return cloned root directly
    //     - No need for getElementById when target IS the root
    //     - Direct reference: clonedSvg is exactly what we need
    //   Fix #3: Use tmpId variable saved BEFORE cleanup
    //     - tmpId was captured at line 498 before removeAttribute
    //     - It contains the exact temp ID that exists in the clone
    //     - For elements with original IDs: tmpId is undefined, use el.id (still intact)
    //     - For elements with temp IDs: use tmpId (saved value before cleanup)
    let cloneTarget;
    if (el === svgRoot) {
      cloneTarget = clonedSvg;
    } else {
      // Use the saved ID (either original or temp) to find the cloned element
      const idToFind = tmpId || el.id;
      cloneTarget = clonedSvg.getElementById(idToFind);
    }

    if (!cloneTarget) {
      const elementInfo = getElementDescription(el);
      const tempIdUsed = tmpId
        ? `Temporary ID used: "${tmpId}"`
        : `Element ID: ${el.id ? `"${el.id}"` : '(none)'}`;
      const autoIdWarning = getAutoIdWarning(el, svgRoot);
      throw new Error(
        '❌ Cannot render SVG element: Element not found in cloned SVG\n' +
          '\n' +
          'ELEMENT DETAILS:\n' +
          `  ${elementInfo}\n` +
          `  ${tempIdUsed}\n` +
          `  SVG Root: ${svgRoot.id ? `id="${svgRoot.id}"` : '(no id)'}\n` +
          autoIdWarning +
          '\n' +
          'This typically happens when:\n' +
          '  1. The element IS the SVG root itself (not supported - query a child element instead)\n' +
          '  2. The element was removed or modified during cloning\n' +
          "  3. The element's ID conflicts with another element\n" +
          '\n' +
          'How to fix:\n' +
          '  • If querying the root <svg>, query a child element instead\n' +
          "  • Ensure the element has a unique 'id' attribute\n" +
          '  • Check that the element exists in the DOM before calling this function\n' +
          "  • Verify the element hasn't been dynamically removed"
      );
    }

    // Keep:
    //  - target
    //  - its ancestors
    //  - its descendants
    //  - all <defs> (filters, markers, gradients, patterns, etc.)
    //  - sibling tspan/textPath elements (needed for proper text layout)
    const allowed = new Set();
    let node = /** @type {Node | null} */ (cloneTarget);
    while (node) {
      allowed.add(node);
      if (node === clonedSvg) {
        break;
      }
      node = node.parentNode;
    }

    // Add all descendants of the target
    (function addDescendants(n) {
      allowed.add(n);
      const children = n.children;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child) addDescendants(child);
      }
    })(cloneTarget);

    // ═══════════════════════════════════════════════════════════════════════════════
    // CRITICAL FIX #4: Cross-SVG Reference Resolution
    // ═══════════════════════════════════════════════════════════════════════════════
    // PROBLEM: <use href="#id"/> elements referencing elements in DIFFERENT SVG roots failed
    //
    // REAL-WORLD SCENARIO (HTML Preview Catalogs generated by sbb-extract.cjs --list):
    //
    //   <!-- Hidden container with actual elements -->
    //   <div style="display:none">
    //     <svg id="root">
    //       <g id="g37" transform="translate(-13.5,-10.2)">
    //         <text id="text8" x="-50" y="100">Hello</text>
    //       </g>
    //     </svg>
    //   </div>
    //
    //   <!-- Visible preview SVG using <use> to reference hidden element -->
    //   <svg id="preview" viewBox="-70 80 100 50">
    //     <g transform="translate(-13.5,-10.2)">
    //       <use href="#text8" />  <!-- References element in DIFFERENT SVG! -->
    //     </g>
    //   </svg>
    //
    // ❌ WRONG SOLUTION #1 - Only search within cloned SVG (original broken code):
    //   const refEl = clonedSvg.getElementById(refId);
    //   if (refEl) {
    //     allowed.add(refEl); // Add to whitelist
    //   }
    //   // If not found, do nothing (WRONG!)
    //
    // WHY IT FAILS:
    //   - We clone ONLY the preview SVG (id="preview")
    //   - The clone contains: <use href="#text8" />
    //   - But #text8 lives in DIFFERENT SVG (id="root" in hidden container)
    //   - clonedSvg.getElementById("text8") returns null
    //   - We don't add the referenced element to the clone
    //   - Browser tries to render <use href="#text8" /> but can't find #text8
    //   - Result: Blank rendering (use element renders nothing)
    //
    // ❌ WRONG SOLUTION #2 - Clone element WITH parent transforms:
    //   const originalRefEl = document.getElementById(refId);
    //   if (originalRefEl) {
    //     // Build transform chain from parent <g> elements
    //     const transforms = [];
    //     let parent = originalRefEl.parentNode;
    //     while (parent && parent.tagName !== 'svg') {
    //       if (parent.getAttribute('transform')) {
    //         transforms.push(parent.getAttribute('transform'));
    //       }
    //       parent = parent.parentNode;
    //     }
    //     // Wrap cloned element in <g> with transforms
    //     let wrapped = originalRefEl.cloneNode(true);
    //     for (const t of transforms) {
    //       const g = document.createElementNS('...', 'g');
    //       g.setAttribute('transform', t);
    //       g.appendChild(wrapped);
    //       wrapped = g;
    //     }
    //     defs.appendChild(wrapped);
    //   }
    //
    // WHY IT FAILS:
    //   - Original element has transform: translate(-13.5,-10.2) from parent <g id="g37">
    //   - We wrap cloned element with this transform
    //   - But preview SVG ALSO has <g transform="translate(-13.5,-10.2)">!
    //   - Transform gets applied TWICE: once from wrapped element, once from preview <g>
    //   - Result: Element appears at WRONG position (double transform)
    //   - Example: text at x=-50 should be at -63.5, but appears at -77 (double offset)
    //
    // ❌ WRONG SOLUTION #3 - Don't clone, just reference original:
    //   // Don't clone at all, assume browser will find it in original document
    //
    // WHY IT FAILS:
    //   - The cloned SVG is rendered in isolation (via data URL to canvas)
    //   - It's a SEPARATE document context from the original DOM
    //   - References can't reach across document boundaries
    //   - Browser can't find #text8 because it's in different document
    //
    // ✅ CORRECT SOLUTION - Clone referenced element to <defs>, no transform wrapper:
    //   let refEl = clonedSvg.getElementById(refId);
    //   if (!refEl) {
    //     const originalRefEl = document.getElementById(refId);  // Search whole document
    //     if (originalRefEl) {
    //       let defs = clonedSvg.querySelector('defs');
    //       if (!defs) {
    //         defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    //         clonedSvg.insertBefore(defs, clonedSvg.firstChild);
    //       }
    //       refEl = originalRefEl.cloneNode(true);  // Clone WITHOUT transform wrapper
    //       defs.appendChild(refEl);
    //       allowed.add(defs);
    //     }
    //   }
    //
    // WHY IT WORKS:
    //   1. Search cloned SVG first (handles normal same-SVG references)
    //   2. If not found, search ENTIRE document with document.getElementById()
    //   3. Clone the referenced element and add to <defs>
    //   4. DON'T wrap with parent transforms (preview SVG already has them)
    //   5. <use> element can now find its target in <defs>
    //   6. Browser renders <use> correctly with transform from preview SVG
    //   7. Transform applied ONCE (not doubled)
    //
    // KEY INSIGHT:
    //   - <use> elements instantiate a COPY of the target (like a function call)
    //   - The target just needs to EXIST in the document (in <defs> is fine)
    //   - Transforms should be on the <use> or its parents, NOT on the definition
    //   - This is why HTML preview has <g transform="..."><use /></g> structure
    (function addReferencedElements(n) {
      // Check for xlink:href or href attributes (textPath, use, image, etc.)
      const xlinkHref = n.getAttribute && n.getAttribute('xlink:href');
      const href = n.getAttribute && n.getAttribute('href');

      for (const refAttr of [xlinkHref, href]) {
        if (refAttr && refAttr.startsWith('#')) {
          const refId = refAttr.substring(1);
          let refEl = clonedSvg.getElementById(refId);

          // Handle cross-SVG references (e.g., <use href="#id"/> referencing hidden container)
          if (!refEl) {
            // Element not in cloned SVG - try to find it in the original document
            const originalRefEl = document.getElementById(refId);
            if (originalRefEl) {
              // Clone the referenced element and add it to a <defs> section in the cloned SVG
              let defs = clonedSvg.querySelector('defs');
              if (!defs) {
                defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
                clonedSvg.insertBefore(defs, clonedSvg.firstChild);
              }
              // TYPE SAFETY: cloneNode(true) returns Node, but we know it's an Element
              // JSDoc type cast satisfies TypeScript without runtime overhead
              // This is safe because getElementById always returns Element | null
              refEl = /** @type {Element} */ (originalRefEl.cloneNode(true));
              defs.appendChild(refEl);
              allowed.add(defs);
            }
          }

          if (refEl && !allowed.has(refEl)) {
            allowed.add(refEl);
            // Also add ancestors of referenced element (might be in <defs>)
            let parent = refEl.parentNode;
            while (parent && parent !== clonedSvg) {
              allowed.add(parent);
              parent = parent.parentNode;
            }
          }
        }
      }

      // Check for url(#...) in style attributes (fill, stroke, filter, mask, etc.)
      const style = n.getAttribute && n.getAttribute('style');
      if (style) {
        const urlRefs = style.match(/url\(#([^)]+)\)/g);
        if (urlRefs) {
          for (const urlRef of urlRefs) {
            const refMatch = urlRef.match(/url\(#([^)]+)\)/);
            if (!refMatch) continue;
            const refId = refMatch[1];
            if (!refId) continue;
            const refEl = clonedSvg.getElementById(refId);
            if (refEl && !allowed.has(refEl)) {
              allowed.add(refEl);
              let parent = refEl.parentNode;
              while (parent && parent !== clonedSvg) {
                allowed.add(parent);
                parent = parent.parentNode;
              }
            }
          }
        }
      }

      // Recurse to children
      const children = n.children;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child) addReferencedElements(child);
      }
    })(cloneTarget);

    // Special case: for tspan/textPath elements, keep all siblings
    // because text layout depends on sibling positioning
    const targetTag = cloneTarget.tagName && cloneTarget.tagName.toLowerCase();
    if (targetTag === 'tspan' || targetTag === 'textpath') {
      const parent = cloneTarget.parentNode;
      if (parent) {
        const siblings = Array.from(parent.children);
        for (const sibling of siblings) {
          const siblingTag = sibling.tagName && sibling.tagName.toLowerCase();
          if (siblingTag === 'tspan' || siblingTag === 'textpath') {
            allowed.add(sibling);
            // Also add all descendants of sibling tspans
            (function addDescendants(n) {
              allowed.add(n);
              const children = n.children;
              for (let i = 0; i < children.length; i++) {
                const child = children[i];
                if (child) addDescendants(child);
              }
            })(sibling);
          }
        }
      }
    }

    (function removeIrrelevant(rootNode) {
      const children = Array.prototype.slice.call(rootNode.children);
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const tag = child.tagName && child.tagName.toLowerCase();

        if (tag === 'defs') {
          // Keep all defs intact
          continue;
        }

        if (!allowed.has(child) && !child.contains(cloneTarget)) {
          // REMOVE the element entirely - display='none' doesn't work reliably in SVG-as-image
          child.parentNode.removeChild(child);
        } else {
          removeIrrelevant(child);
        }
      }
    })(clonedSvg);

    // Serialize SVG → Blob → Image
    const xml = new XMLSerializer().serializeToString(clonedSvg);

    if (DEBUG && typeof console !== 'undefined' && console.log) {
      console.log('[DEBUG rasterize] Serialized SVG length:', xml.length);
      console.log('[DEBUG rasterize] SVG contains textPath:', xml.includes('textPath'));
      console.log('[DEBUG rasterize] SVG contains curve:', xml.includes('id="curve"'));
      if (xml.length < 2000) {
        console.log('[DEBUG rasterize] Full SVG:', xml);
      }
    }

    const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    // CRITICAL FIX #1: Initialize cleanup variables outside try block
    // WHY: Ensures cleanup happens even if errors occur during rendering
    // IMPACT: Prevents memory leaks from unreleased blob URLs and event listeners
    const img = new Image();
    let canvas = null;
    let ctx = null;

    try {
      img.decoding = 'async';
      img.crossOrigin = 'anonymous';
      img.src = url;

      await new Promise((resolve, reject) => {
        // CRITICAL FIX #1: Store event handlers for cleanup
        // WHY: Event listeners must be removed to allow garbage collection
        const onload = function () {
          // Remove event listeners immediately after firing
          img.onload = null;
          img.onerror = null;
          resolve(undefined);
        };
        /** @param {Event} e */
        const onerror = function (e) {
          // Remove event listeners immediately after firing
          img.onload = null;
          img.onerror = null;

          const errorMsg =
            e && typeof e === 'object' && 'message' in e ? String(e.message) : 'unknown error';
          const elementInfo = getElementDescription(el);
          const fontInfo = getFontDescription(el);
          const autoIdWarning = getAutoIdWarning(el, svgRoot);

          reject(
            new Error(
              `❌ Failed to render SVG as image: ${errorMsg}\n` +
                '\n' +
                'ELEMENT DETAILS:\n' +
                `  ${elementInfo}\n` +
                `  Font-family: ${fontInfo}\n` +
                `  SVG Root: ${svgRoot.id ? `id="${svgRoot.id}"` : '(no id)'}\n` +
                autoIdWarning +
                '\n' +
                'This can happen when:\n' +
                '  1. The SVG contains invalid XML syntax\n' +
                '  2. Referenced resources (images, fonts) failed to load\n' +
                '  3. The SVG uses unsupported features\n' +
                '  4. Browser security policies blocked the rendering\n' +
                '\n' +
                'How to fix:\n' +
                '  • Validate your SVG with an XML validator\n' +
                '  • Check that all external resources (images, fonts) are accessible\n' +
                '  • Ensure referenced elements (gradients, patterns, etc.) exist in <defs>\n' +
                '  • If fonts are missing, ensure they are installed or embedded in the SVG\n' +
                '  • Try simplifying the SVG to isolate the problematic element'
            )
          );
        };

        img.onload = onload;
        img.onerror = /** @type {OnErrorEventHandler} */ (onerror);
      });

      canvas = document.createElement('canvas');
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;

      ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Failed to get canvas 2D context');
      ctx.clearRect(0, 0, pixelWidth, pixelHeight);
      ctx.drawImage(img, 0, 0, pixelWidth, pixelHeight);
    } finally {
      // CRITICAL FIX #1: Cleanup in finally block guarantees execution
      // WHY: Finally block runs even if errors occur, preventing memory leaks
      // IMPACT: Blob URLs are always released, allowing browser to free memory

      // Revoke blob URL to free memory (critical for repeated calls)
      URL.revokeObjectURL(url);

      // Clear image src to release blob reference
      img.src = '';

      // Remove any remaining event listeners
      img.onload = null;
      img.onerror = null;
    }

    let imageData;
    try {
      if (!ctx) throw new Error('Canvas context is null');
      imageData = ctx.getImageData(0, 0, pixelWidth, pixelHeight);
    } catch (e) {
      // Detect specific error types for better user guidance
      const errMsg = e instanceof Error ? e.message : '';
      const isOutOfMemory = /out of memory/i.test(errMsg);
      const isTainted = /tainted/i.test(errMsg);

      if (isOutOfMemory) {
        const elementInfo = getElementDescription(el);
        const autoIdWarning = getAutoIdWarning(el, svgRoot);
        throw new Error(
          '❌ Cannot render SVG: Canvas out of memory\n' +
            '\n' +
            'ELEMENT DETAILS:\n' +
            `  ${elementInfo}\n` +
            `  SVG Root: ${svgRoot.id ? `id="${svgRoot.id}"` : '(no id)'}\n` +
            autoIdWarning +
            '\n' +
            'The SVG coordinates or dimensions are too large for canvas rasterization.\n' +
            `Current viewBox: ${vb.x} ${vb.y} ${vb.width} ${vb.height}\n` +
            `Attempted canvas size: ${pixelWidth}×${pixelHeight} pixels\n` +
            '\n' +
            'How to fix:\n' +
            '  • Reduce the viewBox dimensions to a reasonable size (< 10,000 units)\n' +
            '  • Use smaller coordinates (avoid values > 100,000)\n' +
            '  • Decrease the pixelsPerUnit scaling factor\n' +
            '  • Split large SVG into smaller regions and process separately\n' +
            '\n' +
            `Original error: ${errMsg}`
        );
      }

      if (isTainted) {
        const elementInfo = getElementDescription(el);
        const fontInfo = getFontDescription(el);
        const autoIdWarning = getAutoIdWarning(el, svgRoot);
        throw new Error(
          '❌ Cannot read SVG pixels: Canvas is tainted by cross-origin resources\n' +
            '\n' +
            'ELEMENT DETAILS:\n' +
            `  ${elementInfo}\n` +
            `  Font-family: ${fontInfo}\n` +
            `  SVG Root: ${svgRoot.id ? `id="${svgRoot.id}"` : '(no id)'}\n` +
            autoIdWarning +
            '\n' +
            'This happens when your SVG references external resources without CORS:\n' +
            '  • External images (PNG, JPG, etc.) from different domains\n' +
            '  • Web fonts from CDNs without proper CORS headers\n' +
            '  • SVG <use> elements referencing external files\n' +
            '\n' +
            'How to fix:\n' +
            '  • Host images/fonts on the same domain as your page\n' +
            '  • Configure CORS headers on external resources (Access-Control-Allow-Origin: *)\n' +
            '  • Use data URLs for images instead of external URLs\n' +
            '  • Embed fonts directly in the SVG using @font-face with data URLs\n' +
            `  • If using web fonts (like "${fontInfo}"), ensure they have CORS headers or embed them\n` +
            '\n' +
            `Original error: ${errMsg}`
        );
      }

      // Generic canvas error
      const elementInfo = getElementDescription(el);
      const fontInfo = getFontDescription(el);
      const autoIdWarning = getAutoIdWarning(el, svgRoot);
      throw new Error(
        '❌ Cannot read SVG pixels from canvas\n' +
          '\n' +
          'ELEMENT DETAILS:\n' +
          `  ${elementInfo}\n` +
          `  Font-family: ${fontInfo}\n` +
          `  SVG Root: ${svgRoot.id ? `id="${svgRoot.id}"` : '(no id)'}\n` +
          autoIdWarning +
          '\n' +
          `Error: ${errMsg || 'unknown canvas error'}\n` +
          '\n' +
          'Common causes:\n' +
          '  • Cross-origin images/fonts without CORS (canvas becomes "tainted")\n' +
          '  • Canvas size too large (out of memory)\n' +
          '  • Browser security restrictions\n' +
          '\n' +
          'How to fix:\n' +
          '  • Check browser console for specific CORS errors\n' +
          '  • Ensure all external resources are same-origin or have CORS enabled\n' +
          '  • Try reducing the SVG size or complexity'
      );
    }

    const data = imageData.data;

    if (DEBUG && typeof console !== 'undefined' && console.log) {
      // Count non-transparent pixels for debugging
      let nonZeroAlpha = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] !== 0) {
          nonZeroAlpha++;
        }
      }
      console.log('[DEBUG rasterize] Total pixels with alpha > 0:', nonZeroAlpha);
    }

    let xMin = pixelWidth,
      xMax = -1;
    let yMin = pixelHeight,
      yMax = -1;

    for (let y = 0; y < pixelHeight; y++) {
      const rowOffset = y * pixelWidth * 4;
      for (let x = 0; x < pixelWidth; x++) {
        const idx = rowOffset + x * 4;
        const alpha = data[idx + 3];
        if (alpha !== 0) {
          if (x < xMin) {
            xMin = x;
          }
          if (x > xMax) {
            xMax = x;
          }
          if (y < yMin) {
            yMin = y;
          }
          if (y > yMax) {
            yMax = y;
          }
        }
      }
    }

    if (DEBUG && typeof console !== 'undefined' && console.log) {
      console.log('[DEBUG rasterize] xMin/xMax:', xMin, xMax, 'yMin/yMax:', yMin, yMax);
      console.log('[DEBUG rasterize] pixelWidth/Height:', pixelWidth, pixelHeight);
    }

    if (xMax < xMin || yMax < yMin) {
      // No visible pixels (fully clipped / transparent)
      if (DEBUG && typeof console !== 'undefined' && console.log) {
        console.log('[DEBUG rasterize] No pixels detected');
      }
      return null;
    }

    // Coordinate conversion: canvas pixels → SVG user units
    // xMin is measured in a canvas rendered at actualPixelsPerUnit scale
    // To convert to user units: userOffset = xMin / actualPixelsPerUnit
    const userX = vb.x + xMin / actualPixelsPerUnit;
    const userY = vb.y + yMin / actualPixelsPerUnit;
    const userW = (xMax - xMin + 1) / actualPixelsPerUnit;
    const userH = (yMax - yMin + 1) / actualPixelsPerUnit;

    if (DEBUG && typeof console !== 'undefined' && console.log) {
      console.log(
        '[DEBUG rasterize] Element:',
        el.id || el.tagName,
        'actualPPU:',
        actualPixelsPerUnit.toFixed(6),
        'pixelsPerUnit:',
        pixelsPerUnit.toFixed(6),
        'xMin:',
        xMin,
        'userX:',
        userX.toFixed(6)
      );
    }

    return { x: userX, y: userY, width: userW, height: userH };
  }

  /**
   * Aggressive 2-pass *visual* bounding box of an SVG element.
   *
   * - Rasterizes the element (with all filters, masks, stroke, markers, etc.)
   * - PASS 1: over a large region at coarse resolution.
   * - PASS 2: over coarse bbox expanded by a large margin at high resolution.
   *
   * Bounding box is returned in the root <svg>'s user coordinate system.
   *
   * @param {Element|string} target  SVG element or its id.
   * @param {object} [options]
   *   @param {"clipped"|"unclipped"} [options.mode="clipped"]
   *      "clipped"   → restrict ROI to viewBox / viewport
   *      "unclipped" → ROI is full drawing geometry (no clipping)
   *   @param {number} [options.coarseFactor=3]
   *      Coarse pixels-per-unit multiplier (× base layout scale)
   *   @param {number} [options.fineFactor=24]
   *      Fine pixels-per-unit multiplier (× base layout scale)
   *   @param {number|null} [options.safetyMarginUser=null]
   *      Extra margin (user units) around pass-1 bbox for pass-2.
   *      If null, an aggressive default is used.
   *   @param {boolean} [options.useLayoutScale=true]
   *      If true, derive base pixels-per-unit from getBoundingClientRect()
   *      and the SVG's viewBox so non-scaling strokes etc. relate to actual
   *      onscreen pixels.
   *   @param {number} [options.fontTimeoutMs=8000]
   *      Max time to wait for document fonts to load (ms).
   *
   * @returns {Promise<{x:number,y:number,width:number,height:number,element:Element,svgRoot:SVGSVGElement}|null>}
   */
  async function getSvgElementVisualBBoxTwoPassAggressive(target, options) {
    options = options || {};
    const mode = options.mode || 'clipped';
    const coarseFactor = typeof options.coarseFactor === 'number' ? options.coarseFactor : 3;
    const fineFactor = typeof options.fineFactor === 'number' ? options.fineFactor : 24;
    const safetyMarginUser =
      typeof options.safetyMarginUser === 'number' ? options.safetyMarginUser : null;
    const useLayoutScale =
      typeof options.useLayoutScale === 'boolean' ? options.useLayoutScale : true;
    const fontTimeoutMs = typeof options.fontTimeoutMs === 'number' ? options.fontTimeoutMs : 5000;

    // Resolve element
    const el = /** @type {SVGElement | null} */ (
      typeof target === 'string' ? document.getElementById(target) : target
    );

    if (!el) {
      const targetDesc = typeof target === 'string' ? `id="${target}"` : 'provided reference';
      throw new Error(
        '❌ Cannot compute SVG bounding box: Element not found\n' +
          '\n' +
          'REQUESTED ELEMENT:\n' +
          `  ${targetDesc}\n` +
          `  Type: ${typeof target}\n` +
          '\n' +
          'How to fix:\n' +
          '  • Check that the element exists in the DOM\n' +
          '  • Verify the element ID is correct (case-sensitive)\n' +
          "  • Ensure the element hasn't been removed from the DOM\n" +
          "  • If passing an element reference, make sure it's not null/undefined"
      );
    }

    // CRITICAL FIX #2: Race condition prevention via mutex pattern
    // WHY: Multiple simultaneous calls on same element can interfere with each other
    // SCENARIO: User calls getBBox twice rapidly → temp IDs conflict, DOM state corrupted
    // SOLUTION: If operation pending on this element, wait for it to complete first
    // IMPACT: Ensures atomic operations, prevents undefined behavior from concurrent access
    const existingLock = elementLocks.get(el);
    if (existingLock) {
      // Another operation is in progress on this element - wait for it
      if (DEBUG && typeof console !== 'undefined' && console.log) {
        console.log('[DEBUG] Waiting for existing operation on element:', el.id || el.tagName);
      }
      await existingLock;
    }

    // Create new lock for this operation
    // Initialize with no-op to satisfy TypeScript - will be reassigned synchronously by Promise executor
    /** @type {(value?: any) => void} */
    let resolveLock = (_value) => {};
    const lockPromise = new Promise((resolve) => {
      resolveLock = resolve;
    });
    elementLocks.set(el, lockPromise);

    try {
      const doc = el.ownerDocument || document;
      await waitForDocumentFonts(doc, fontTimeoutMs);

      const svgRoot = el.ownerSVGElement || (el instanceof SVGSVGElement ? el : null);
      if (!svgRoot) {
        const elementInfo = getElementDescription(el);
        // Can't use getAutoIdWarning here since we don't have svgRoot yet
        const autoIdNote =
          el && el.id && isAutoGeneratedId(el.id)
            ? `\n⚠️  NOTE: This element has an AUTO-GENERATED ID ("${el.id}").\n` +
              "   This ID was added by sbb-extract.cjs and doesn't exist in your original SVG.\n\n"
            : '';
        throw new Error(
          '❌ Cannot compute SVG bounding box: Element is not inside an SVG tree\n' +
            '\n' +
            'ELEMENT DETAILS:\n' +
            `  ${elementInfo}\n` +
            autoIdNote +
            'This element is not connected to an <svg> root element.\n' +
            '\n' +
            'How to fix:\n' +
            '  • Ensure the element is inside an <svg> tag in the DOM\n' +
            "  • Check that you're not querying a detached/orphaned element\n" +
            '  • If creating elements programmatically, append them to the SVG tree first\n' +
            "  • Verify the element hasn't been removed from the document"
        );
      }

      // Root viewBox (user coordinate system)
      const vbVal = svgRoot.viewBox && svgRoot.viewBox.baseVal;
      let viewBox;
      if (vbVal && vbVal.width && vbVal.height) {
        viewBox = { x: vbVal.x, y: vbVal.y, width: vbVal.width, height: vbVal.height };
      } else {
        // fallback: geometry box of full SVG (ignores clipping)
        const box = safeGetBBox(svgRoot);
        if (box) {
          viewBox = { x: box.x, y: box.y, width: box.width, height: box.height };
        } else {
          // Last resort: arbitrary large window
          viewBox = { x: -2000, y: -2000, width: 4000, height: 4000 };
        }
      }

      // Collect all referenced elements (textPath, use, gradients, filters, etc.)
      // so we can include them in ROI calculation
      /** @type {Element[]} */
      const referencedElements = [];
      (function collectReferences(n) {
        // Check for xlink:href or href attributes
        const xlinkHref = n.getAttribute && n.getAttribute('xlink:href');
        const href = n.getAttribute && n.getAttribute('href');

        for (const refAttr of [xlinkHref, href]) {
          if (refAttr && refAttr.startsWith('#')) {
            const refId = refAttr.substring(1);
            const refEl = svgRoot.getElementById(refId);
            if (refEl && !referencedElements.includes(refEl)) {
              referencedElements.push(refEl);
            }
          }
        }

        // Check for url(#...) in style
        const style = n.getAttribute && n.getAttribute('style');
        if (style) {
          const urlMatches = style.match(/url\(#([^)]+)\)/g);
          if (urlMatches) {
            for (const urlMatch of urlMatches) {
              const refMatch = urlMatch.match(/url\(#([^)]+)\)/);
              if (!refMatch) continue;
              const refId = refMatch[1];
              if (!refId) continue;
              const refEl = svgRoot.getElementById(refId);
              if (refEl && !referencedElements.includes(refEl)) {
                referencedElements.push(refEl);
              }
            }
          }
        }

        // Recurse to children
        const children = n.children;
        for (let i = 0; i < children.length; i++) {
          collectReferences(/** @type {SVGElement} */ (children[i]));
        }
      })(el);

      // Decide coarse region of interest (ROI) for PASS 1
      // CRITICAL: getBBox() is UNRELIABLE (ignores strokes, filters, transforms, dashed lines, and returns empty for some elements)
      // Solution: Convert element's getBoundingClientRect() from page pixels to SVG user coordinates
      let coarseROI;
      if (mode === 'unclipped') {
        // Start with viewBox as default
        let minX = viewBox.x;
        let minY = viewBox.y;
        let maxX = viewBox.x + viewBox.width;
        let maxY = viewBox.y + viewBox.height;

        // Parse preserveAspectRatio to get scaling and offset
        const scaling = parsePreserveAspectRatio(svgRoot, viewBox, svgRoot.getBoundingClientRect());

        // Helper to expand ROI for an element
        /** @param {Element} elem */
        const expandROIForElement = (elem) => {
          try {
            const elRect = elem.getBoundingClientRect();
            const svgRect = svgRoot.getBoundingClientRect();

            // Only expand if element has non-zero dimensions
            if (elRect.width > 0 && elRect.height > 0) {
              let elUserLeft, elUserTop, elUserRight, elUserBottom;

              if (scaling.uniform) {
                // Uniform scaling (meet or slice) - subtract offset before scaling
                const scale = scaling.scale;
                elUserLeft = viewBox.x + (elRect.left - svgRect.left - scaling.offsetX) * scale;
                elUserTop = viewBox.y + (elRect.top - svgRect.top - scaling.offsetY) * scale;
                elUserRight = viewBox.x + (elRect.right - svgRect.left - scaling.offsetX) * scale;
                elUserBottom = viewBox.y + (elRect.bottom - svgRect.top - scaling.offsetY) * scale;
              } else {
                // Non-uniform scaling (preserveAspectRatio="none") - no offset
                elUserLeft = viewBox.x + (elRect.left - svgRect.left) * scaling.scaleX;
                elUserTop = viewBox.y + (elRect.top - svgRect.top) * scaling.scaleY;
                elUserRight = viewBox.x + (elRect.right - svgRect.left) * scaling.scaleX;
                elUserBottom = viewBox.y + (elRect.bottom - svgRect.top) * scaling.scaleY;
              }

              // Expand ROI to include element with generous padding for strokes/filters
              const padding = 200; // SVG user units (increased for safety)
              minX = Math.min(minX, elUserLeft - padding);
              minY = Math.min(minY, elUserTop - padding);
              maxX = Math.max(maxX, elUserRight + padding);
              maxY = Math.max(maxY, elUserBottom + padding);
            }
          } catch {
            // CRITICAL FIX #4: Intentionally silent error (best-effort ROI expansion)
            // WHY: Some elements may not have valid bounding rects (hidden, detached)
            // IMPACT: Skip problematic elements, continue with others
            // This is acceptable because ROI calculation is best-effort
          }
        };

        // Expand ROI for target element
        expandROIForElement(el);

        // Also expand ROI for all referenced elements (textPath refs, gradients, etc.)
        for (const refEl of referencedElements) {
          expandROIForElement(refEl);
        }

        coarseROI = {
          x: minX,
          y: minY,
          width: maxX - minX,
          height: maxY - minY
        };
      } else {
        // "clipped": restrict to visible viewBox/viewport
        coarseROI = {
          x: viewBox.x,
          y: viewBox.y,
          width: viewBox.width,
          height: viewBox.height
        };
      }

      // Derive base pixels-per-user-unit from layout (optional)
      let basePixelsPerUnit = 1;
      if (useLayoutScale && viewBox.width > 0 && viewBox.height > 0) {
        const rect = svgRoot.getBoundingClientRect();
        if (rect && rect.width > 0 && rect.height > 0) {
          const pxPerUnitX = rect.width / viewBox.width;
          const pxPerUnitY = rect.height / viewBox.height;
          basePixelsPerUnit = (pxPerUnitX + pxPerUnitY) / 2;
        }
      }

      const coarsePPU = Math.max(1, basePixelsPerUnit * coarseFactor);
      const finePPU = Math.max(4, basePixelsPerUnit * fineFactor);

      // PASS 1: whole coarseROI at coarsePPU
      if (DEBUG && typeof console !== 'undefined' && console.log) {
        console.log('[DEBUG] coarseROI:', JSON.stringify(coarseROI));
        console.log('[DEBUG] coarsePPU:', coarsePPU);
      }
      const coarseBBox = await rasterizeSvgElementToBBox(el, svgRoot, coarseROI, coarsePPU);
      if (DEBUG && typeof console !== 'undefined' && console.log) {
        console.log('[DEBUG] coarseBBox result:', coarseBBox);
      }
      if (!coarseBBox) {
        // Fully transparent / clipped; visually nothing there
        if (DEBUG && typeof console !== 'undefined' && console.log) {
          console.log('[DEBUG] No pixels found in coarse pass - returning null');
        }
        return null;
      }

      // Aggressive safety margin in user units
      let marginUser = safetyMarginUser;
      if (marginUser == null || !isFinite(marginUser)) {
        const size = Math.max(coarseBBox.width, coarseBBox.height);
        // 25% of largest dimension + 100 units as a "big" safety net
        marginUser = (size > 0 ? size * 0.25 : 0) + 100;
      }

      // Expand ROI for PASS 2
      const roiX0 = coarseBBox.x - marginUser;
      const roiY0 = coarseBBox.y - marginUser;
      const roiX1 = coarseBBox.x + coarseBBox.width + marginUser;
      const roiY1 = coarseBBox.y + coarseBBox.height + marginUser;

      const fineROI = {
        x: roiX0,
        y: roiY0,
        width: Math.max(0, roiX1 - roiX0),
        height: Math.max(0, roiY1 - roiY0)
      };

      if (fineROI.width <= 0 || fineROI.height <= 0) {
        return null;
      }

      // PASS 2: cropped fineROI at finePPU
      const fineBBox = await rasterizeSvgElementToBBox(el, svgRoot, fineROI, finePPU);
      if (!fineBBox) {
        return null;
      }

      return {
        x: fineBBox.x,
        y: fineBBox.y,
        width: fineBBox.width,
        height: fineBBox.height,
        element: el,
        svgRoot: svgRoot
      };
    } finally {
      // CRITICAL FIX #2: Release lock in finally block
      // WHY: Finally block always executes (even on error/return), ensuring lock is released
      // IMPACT: Prevents deadlock if operation throws/returns early
      resolveLock();
      elementLocks.delete(el);
    }
  }

  /**
   * Union visual bbox of multiple SVG elements within the *same* root <svg>.
   *
   * @param {(Element|string)[]} targets
   * @param {object} [options]  forwarded to getSvgElementVisualBBoxTwoPassAggressive
   *
   * @returns {Promise<{x:number,y:number,width:number,height:number,svgRoot:SVGSVGElement,bboxes:any[]}|null>}
   */
  async function getSvgElementsUnionVisualBBox(targets, options) {
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new Error(
        'Cannot compute union bounding box: Invalid targets parameter\n' +
          '\n' +
          'Expected: Non-empty array of SVG elements or element IDs\n' +
          `Received: ${Array.isArray(targets) ? 'empty array' : typeof targets}\n` +
          '\n' +
          'How to fix:\n' +
          '  • Pass an array with at least one element\n' +
          "  • Example: ['element1', 'element2'] or [el1, el2]\n" +
          '  • Ensure the array is not empty before calling this function'
      );
    }

    const bboxes = [];
    let svgRoot = null;

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (!t) continue;
      const bbox = await getSvgElementVisualBBoxTwoPassAggressive(t, options);
      if (!bbox) {
        continue;
      } // invisible element

      if (!svgRoot) {
        svgRoot = bbox.svgRoot;
      } else if (bbox.svgRoot !== svgRoot) {
        const prevId = svgRoot.id ? `id="${svgRoot.id}"` : '(no id)';
        const currId = bbox.svgRoot.id ? `id="${bbox.svgRoot.id}"` : '(no id)';
        throw new Error(
          'Cannot compute union bounding box: Elements from different SVG documents\n' +
            '\n' +
            'All elements must belong to the same <svg> root element.\n' +
            `Previous SVG: ${prevId}\n` +
            `Current SVG:  ${currId}\n` +
            '\n' +
            'How to fix:\n' +
            '  • Ensure all elements are children of the same <svg> root\n' +
            '  • If you have multiple SVGs, compute bbox for each separately\n' +
            "  • Check that elements haven't been moved between different SVG trees"
        );
      }
      bboxes.push(bbox);
    }

    if (bboxes.length === 0) {
      return null;
    }

    let xMin = Infinity,
      yMin = Infinity,
      xMax = -Infinity,
      yMax = -Infinity;

    for (let i = 0; i < bboxes.length; i++) {
      const b = bboxes[i];
      if (!b) continue;
      xMin = Math.min(xMin, b.x);
      yMin = Math.min(yMin, b.y);
      xMax = Math.max(xMax, b.x + b.width);
      yMax = Math.max(yMax, b.y + b.height);
    }

    if (!svgRoot) {
      return null;
    }

    return {
      x: xMin,
      y: yMin,
      width: xMax - xMin,
      height: yMax - yMin,
      svgRoot: svgRoot,
      bboxes: bboxes
    };
  }

  /**
   * Get both:
   *  - visible: element's visual bbox *inside the viewBox / viewport* ("clipped")
   *  - full:    element's visual bbox when the whole drawing region is considered,
   *             ignoring viewBox clipping ("unclipped").
   *
   * Useful when you want to compare what's actually visible vs. what would
   * be drawn if the viewBox wasn't cropping it.
   *
   * @param {Element|string} target
   * @param {object} [options] forwarded to underlying calls (may override mode)
   * @returns {Promise<{visible: object|null, full: object|null}>}
   */
  async function getSvgElementVisibleAndFullBBoxes(target, options) {
    options = options || {};

    // Clone options for visible/full and override mode
    /** @type {{mode?: 'clipped' | 'unclipped', coarseFactor?: number, fineFactor?: number, safetyMarginUser?: number | null, useLayoutScale?: boolean, fontTimeoutMs?: number}} */
    const optVisible = Object.assign({}, options, { mode: /** @type {'clipped'} */ ('clipped') });
    /** @type {{mode?: 'clipped' | 'unclipped', coarseFactor?: number, fineFactor?: number, safetyMarginUser?: number | null, useLayoutScale?: boolean, fontTimeoutMs?: number}} */
    const optFull = Object.assign({}, options, { mode: /** @type {'unclipped'} */ ('unclipped') });

    const visible = await getSvgElementVisualBBoxTwoPassAggressive(target, optVisible);
    const full = await getSvgElementVisualBBoxTwoPassAggressive(target, optFull);

    return { visible: visible, full: full };
  }

  /**
   * For a root <svg> with a viewBox, compute how much padding you’d need to
   * expand the viewBox so that its visible region fully covers the drawing’s
   * full visual bbox (before viewBox cropping).
   *
   * In other words, it compares:
   *  - visible = visual bbox inside the current viewBox ("clipped")
   *  - full    = visual bbox ignoring the viewBox ("unclipped")
   * and reports how much you need to expand the current viewBox on each side
   * (left, top, right, bottom) to include the full bbox.
   *
   * @param {SVGSVGElement|string} svgRootOrId  Root <svg> element or its id.
   * @param {object} [options] forwarded to getSvgElementVisibleAndFullBBoxes
   * @returns {Promise<{
   *   currentViewBox: {x:number,y:number,width:number,height:number},
   *   visibleBBox: object|null,
   *   fullBBox: object|null,
   *   padding: {left:number,top:number,right:number,bottom:number},
   *   newViewBox: {x:number,y:number,width:number,height:number}
   * }|null>}
   */
  async function getSvgRootViewBoxExpansionForFullDrawing(svgRootOrId, options) {
    options = options || {};

    const svgRoot =
      typeof svgRootOrId === 'string' ? document.getElementById(svgRootOrId) : svgRootOrId;

    if (!svgRoot || !(svgRoot instanceof SVGSVGElement)) {
      const targetDesc =
        typeof svgRootOrId === 'string' ? `id="${svgRootOrId}"` : 'provided reference';
      throw new Error(
        `Cannot compute viewBox expansion: Invalid SVG root (${targetDesc})\n` +
          '\n' +
          'Expected: Root <svg> element or its ID\n' +
          `Received: ${svgRoot ? svgRoot.tagName : 'null/undefined'}\n` +
          '\n' +
          'How to fix:\n' +
          '  • Pass the root <svg> element or its ID string\n' +
          '  • Ensure the element is actually an <svg> tag, not a child element\n' +
          '  • Check that the element exists in the DOM'
      );
    }

    const vbVal = svgRoot.viewBox && svgRoot.viewBox.baseVal;
    if (!vbVal || !vbVal.width || !vbVal.height) {
      const svgId = svgRoot.id ? `id="${svgRoot.id}"` : '(no id)';
      throw new Error(
        `Cannot compute viewBox expansion: SVG missing valid viewBox (${svgId})\n` +
          '\n' +
          'The root <svg> element must have a viewBox attribute with valid dimensions.\n' +
          `Current viewBox: ${svgRoot.getAttribute('viewBox') || '(none)'}\n` +
          '\n' +
          'How to fix:\n' +
          '  • Add a viewBox attribute to your <svg> tag\n' +
          '  • Example: <svg viewBox="0 0 800 600" ...>\n' +
          '  • Ensure viewBox has 4 numbers: x, y, width, height\n' +
          '  • Width and height must be greater than 0\n' +
          '  • Use the sbb-fix-viewbox.cjs tool to auto-generate viewBox'
      );
    }

    const currentViewBox = {
      x: vbVal.x,
      y: vbVal.y,
      width: vbVal.width,
      height: vbVal.height
    };

    const both = await getSvgElementVisibleAndFullBBoxes(svgRoot, options);
    const visible = both.visible;
    const full =
      /** @type {{x: number, y: number, width: number, height: number, svgRoot: SVGSVGElement} | null} */ (
        both.full
      );

    if (!full) {
      // Nothing is visually drawn at all
      return null;
    }

    const currRight = currentViewBox.x + currentViewBox.width;
    const currBottom = currentViewBox.y + currentViewBox.height;
    const fullRight = full.x + full.width;
    const fullBottom = full.y + full.height;

    const padLeft = Math.max(0, currentViewBox.x - full.x);
    const padTop = Math.max(0, currentViewBox.y - full.y);
    const padRight = Math.max(0, fullRight - currRight);
    const padBottom = Math.max(0, fullBottom - currBottom);

    const newViewBox = {
      x: currentViewBox.x - padLeft,
      y: currentViewBox.y - padTop,
      width: currentViewBox.width + padLeft + padRight,
      height: currentViewBox.height + padTop + padBottom
    };

    return {
      currentViewBox: currentViewBox,
      visibleBBox: visible,
      fullBBox: full,
      padding: {
        left: padLeft,
        top: padTop,
        right: padRight,
        bottom: padBottom
      },
      newViewBox: newViewBox
    };
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════════
   * showTrueBBoxBorder - Visual Debug Helper for Browser Usage
   * ═══════════════════════════════════════════════════════════════════════════════
   *
   * Displays a dotted border around any SVG element's true visual bounding box.
   * Works with all SVG types: inline, embedded, sprites, objects, dynamically generated.
   *
   * Features:
   *   - Automatic dark/light theme detection for visibility
   *   - Non-intrusive overlay (doesn't modify SVG content)
   *   - Handles all SVG embedding methods
   *   - Returns cleanup function to remove border
   *
   * @param {string|SVGElement|HTMLElement} target - SVG element selector, element, or container
   * @param {Object} [options] - Configuration options
   * @param {string} [options.theme] - Force color theme: 'light', 'dark', or 'auto' (default: 'auto')
   * @param {string} [options.borderColor] - Override theme color with custom color (default: theme-based)
   * @param {string} [options.borderWidth] - Border width (default: '2px')
   * @param {string} [options.borderStyle] - Border style (default: 'dashed')
   * @param {number} [options.padding] - Padding around border in pixels (default: 4)
   * @param {number} [options.zIndex] - Z-index for overlay (default: 999999)
   * @param {Object} [options.bboxOptions] - Options passed to getSvgElementVisualBBoxTwoPassAggressive
   *
   * @returns {Promise<Object>} Object with {bbox, overlay, remove()} where:
   *   - bbox: The computed bounding box {x, y, width, height}
   *   - overlay: The DOM element showing the border
   *   - remove(): Function to remove the border overlay
   *
   * @example
   * // Show border on an inline SVG element
   * const result = await SvgVisualBBox.showTrueBBoxBorder('#myText');
   * // Later: result.remove();
   *
   * @example
   * // Force dark theme (for light backgrounds)
   * const result = await SvgVisualBBox.showTrueBBoxBorder('#myPath', {
   *   theme: 'dark'  // Forces dark border regardless of system theme
   * });
   *
   * @example
   * // Show border with custom styling
   * const result = await SvgVisualBBox.showTrueBBoxBorder('#myPath', {
   *   borderColor: 'red',
   *   borderWidth: '3px',
   *   padding: 10
   * });
   *
   * @example
   * // Show border on dynamically created SVG
   * const svgEl = document.querySelector('svg');
   * const result = await SvgVisualBBox.showTrueBBoxBorder(svgEl);
   */
  async function showTrueBBoxBorder(target, options) {
    // Set default options
    options = options || {};
    // Resolve target to SVG element
    let svgElement = null;

    if (typeof target === 'string') {
      // Selector string
      svgElement = document.querySelector(target);
      if (!svgElement) {
        throw new Error(`SVG element not found: ${target}`);
      }
    } else if (target instanceof Element) {
      svgElement = target;
    } else {
      throw new Error('Target must be a selector string or DOM element');
    }

    // Handle different SVG embedding types
    if (
      svgElement.tagName.toLowerCase() === 'object' &&
      'contentDocument' in svgElement &&
      svgElement.contentDocument
    ) {
      // <object> element - get the SVG from contentDocument
      const contentDoc = /** @type {Document} */ (svgElement.contentDocument);
      const objectSvg = contentDoc.querySelector('svg');
      if (objectSvg) {
        svgElement = objectSvg;
      }
    } else if (
      svgElement.tagName.toLowerCase() === 'iframe' &&
      'contentDocument' in svgElement &&
      svgElement.contentDocument
    ) {
      // <iframe> element - get the SVG from contentDocument
      const contentDoc = /** @type {Document} */ (svgElement.contentDocument);
      const iframeSvg = contentDoc.querySelector('svg');
      if (iframeSvg) {
        svgElement = iframeSvg;
      }
    } else if (svgElement.tagName.toLowerCase() === 'use') {
      // <use> element - this is already an SVG element, will be handled by getBBox
    }

    // Ensure we have an SVG element
    if (
      !svgElement ||
      (!('ownerSVGElement' in svgElement) && svgElement.tagName.toLowerCase() !== 'svg')
    ) {
      throw new Error('Target is not an SVG element or does not contain SVG content');
    }

    // Determine theme: 'auto' (default), 'light', or 'dark'
    const theme = options.theme || 'auto';
    let isDarkMode = false;

    if (theme === 'auto') {
      // Auto-detect system theme
      isDarkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    } else if (theme === 'dark') {
      // Force dark theme (light border for dark backgrounds)
      isDarkMode = true;
    } else if (theme === 'light') {
      // Force light theme (dark border for light backgrounds)
      isDarkMode = false;
    }

    // Select border color based on theme
    const defaultBorderColor = isDarkMode ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.6)';

    // Parse options (borderColor overrides theme)
    const borderColor = options.borderColor || defaultBorderColor;
    const borderWidth = options.borderWidth || '2px';
    const borderStyle = options.borderStyle || 'dashed';
    const padding = options.padding !== undefined ? options.padding : 4;
    const zIndex = options.zIndex !== undefined ? options.zIndex : 999999;
    const bboxOptions = options.bboxOptions || {};

    // Compute the true visual bounding box
    const bbox = await getSvgElementVisualBBoxTwoPassAggressive(svgElement, bboxOptions);

    if (!bbox || bbox.width === 0 || bbox.height === 0) {
      console.warn('showTrueBBoxBorder: Element has zero-size bounding box', bbox);
      return {
        bbox: bbox,
        overlay: null,
        remove: () => {}
      };
    }

    // Get the root SVG element to determine coordinate system
    const rootSvg = /** @type {SVGSVGElement} */ (
      ('ownerSVGElement' in svgElement ? svgElement.ownerSVGElement : null) || svgElement
    );

    // Get the SVG's position in the viewport
    const svgRect = rootSvg.getBoundingClientRect();

    // Get the viewBox to convert SVG coordinates to viewport coordinates
    const viewBox = rootSvg.viewBox.baseVal;
    let vbX = 0,
      vbY = 0,
      vbWidth = svgRect.width,
      vbHeight = svgRect.height;

    if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
      vbX = viewBox.x;
      vbY = viewBox.y;
      vbWidth = viewBox.width;
      vbHeight = viewBox.height;
    }

    // Calculate scale factors from viewBox to screen coordinates
    const scaleX = svgRect.width / vbWidth;
    const scaleY = svgRect.height / vbHeight;

    // Convert bbox coordinates (in SVG user space) to viewport coordinates
    const screenX = svgRect.left + (bbox.x - vbX) * scaleX - padding;
    const screenY = svgRect.top + (bbox.y - vbY) * scaleY - padding;
    const screenWidth = bbox.width * scaleX + padding * 2;
    const screenHeight = bbox.height * scaleY + padding * 2;

    // Create overlay div with border
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.left = `${screenX}px`;
    overlay.style.top = `${screenY}px`;
    overlay.style.width = `${screenWidth}px`;
    overlay.style.height = `${screenHeight}px`;
    overlay.style.border = `${borderWidth} ${borderStyle} ${borderColor}`;
    overlay.style.pointerEvents = 'none'; // Don't interfere with interactions
    overlay.style.zIndex = String(zIndex);
    overlay.style.boxSizing = 'border-box';
    overlay.setAttribute('data-svg-bbox-overlay', 'true');
    overlay.setAttribute('data-target-id', svgElement.id || 'anonymous');

    // Add to document
    document.body.appendChild(overlay);

    // Function to update overlay position (for dynamic/animated SVGs)
    const updatePosition = () => {
      const currentSvgRect = rootSvg.getBoundingClientRect();
      const currentScaleX = currentSvgRect.width / vbWidth;
      const currentScaleY = currentSvgRect.height / vbHeight;

      const currentScreenX = currentSvgRect.left + (bbox.x - vbX) * currentScaleX - padding;
      const currentScreenY = currentSvgRect.top + (bbox.y - vbY) * currentScaleY - padding;
      const currentScreenWidth = bbox.width * currentScaleX + padding * 2;
      const currentScreenHeight = bbox.height * currentScaleY + padding * 2;

      overlay.style.left = `${currentScreenX}px`;
      overlay.style.top = `${currentScreenY}px`;
      overlay.style.width = `${currentScreenWidth}px`;
      overlay.style.height = `${currentScreenHeight}px`;
    };

    // Update on scroll and resize
    const scrollListener = () => updatePosition();
    const resizeListener = () => updatePosition();

    window.addEventListener('scroll', scrollListener, true); // Capture phase for all scrolls
    window.addEventListener('resize', resizeListener);

    // Cleanup function
    const remove = () => {
      if (overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
      window.removeEventListener('scroll', scrollListener, true);
      window.removeEventListener('resize', resizeListener);
    };

    return {
      bbox: bbox,
      overlay: overlay,
      remove: remove
    };
  }

  /**
   * Reframe SVG viewBox to fit specific object(s) with aspect ratio and visibility control
   *
   * @param {string|Element} target - CSS selector, DOM element, or element ID for the SVG root
   * @param {string|string[]} objectIds - Element ID(s) to frame
   * @param {Object} [options] - Configuration options
   * @param {string} [options.aspect] - 'changePosition' | 'preserveAspectRatio' | 'stretch' (default: 'stretch')
   * @param {string} [options.aspectRatioMode] - 'meet' | 'slice' (default: 'meet', only for aspect: 'preserveAspectRatio')
   * @param {string} [options.align] - SVG alignment like 'xMidYMid', 'xMinYMin', etc. (default: 'xMidYMid')
   * @param {string} [options.visibility] - 'unchanged' | 'hideAllExcept' | 'hideTargets' | 'restoreList' (default: 'unchanged')
   * @param {Object} [options.visibilityList] - Visibility state to restore (only for visibility: 'restoreList')
   * @param {number|string} [options.margin] - Margin around bbox in user units, px, or screen units (default: 0)
   * @param {boolean} [options.saveVisibilityList] - Return current visibility state (default: false)
   * @param {boolean} [options.dryRun] - Compute only, don't modify SVG (default: false)
   * @param {Object} [options.bboxOptions] - Options passed to bbox computation functions
   * @returns {Promise<Object>} Result with newViewBox, oldViewBox, bbox, visibilityList, restore function
   */
  async function setViewBoxOnObjects(target, objectIds, options) {
    // Set default options
    options = options || {};
    // Normalize options
    const opts = {
      aspect: options.aspect || 'stretch',
      aspectRatioMode: options.aspectRatioMode || 'meet',
      align: options.align || 'xMidYMid',
      visibility: options.visibility || 'unchanged',
      visibilityList: options.visibilityList || null,
      margin: options.margin || 0,
      saveVisibilityList: options.saveVisibilityList || false,
      dryRun: options.dryRun || false,
      bboxOptions: options.bboxOptions || {}
    };

    // Resolve SVG root element
    let svgRoot;
    if (typeof target === 'string') {
      const sel = target.startsWith('#') ? target : '#' + target;
      svgRoot = document.querySelector(sel);
      if (!svgRoot) {
        svgRoot = document.getElementById(target);
      }
    } else {
      svgRoot = target;
    }

    if (!svgRoot || svgRoot.tagName.toLowerCase() !== 'svg') {
      throw new Error('Target must be an SVG element');
    }

    // Normalize objectIds to array
    const ids = Array.isArray(objectIds) ? objectIds : [objectIds];
    if (ids.length === 0) {
      throw new Error('At least one object ID must be provided');
    }

    // Get elements with smart symbol resolution
    const elements = ids.map((id) => {
      let el = /** @type {Element | null} */ (document.getElementById(id));
      if (!el) {
        throw new Error(`Element with ID "${id}" not found`);
      }

      // If element is a <symbol>, find <use> elements referencing it
      if (el.tagName.toLowerCase() === 'symbol') {
        const useElements = Array.from(svgRoot.querySelectorAll('use')).filter((use) => {
          const href =
            use.getAttribute('href') || use.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
          return href === '#' + id;
        });

        if (useElements.length === 0) {
          throw new Error(`Symbol "${id}" has no <use> elements referencing it`);
        }
        if (useElements.length > 1) {
          throw new Error(
            `Symbol "${id}" is referenced by multiple <use> elements. Please specify the exact <use> element ID.`
          );
        }

        const useEl = useElements[0];
        if (!useEl) throw new Error(`Symbol "${id}" has no <use> elements referencing it`);
        el = useEl;
      }

      return el;
    });

    // Wait for fonts
    /** @type {{mode?: 'clipped' | 'unclipped', coarseFactor?: number, fineFactor?: number, safetyMarginUser?: number | null, useLayoutScale?: boolean, fontTimeoutMs?: number}} */
    const bboxOpts = opts.bboxOptions || {};
    await waitForDocumentFonts(document, bboxOpts.fontTimeoutMs || 8000);

    // Compute union bbox
    let bbox;
    if (elements.length === 1) {
      const firstEl = elements[0];
      if (!firstEl) throw new Error('No element found');
      bbox = await getSvgElementVisualBBoxTwoPassAggressive(firstEl, bboxOpts);
    } else {
      /** @type {(string | Element)[]} */
      const validElements = elements.filter((el) => el != null);
      bbox = await getSvgElementsUnionVisualBBox(validElements, bboxOpts);
    }

    if (!bbox || bbox.width <= 0 || bbox.height <= 0) {
      throw new Error('Could not compute valid bounding box for specified objects');
    }

    // Get current viewBox
    const vb = /** @type {SVGSVGElement} */ (svgRoot).viewBox.baseVal;
    const oldViewBox = {
      x: vb.x || 0,
      y: vb.y || 0,
      width: vb.width || parseFloat(svgRoot.getAttribute('width') || '0') || 0,
      height: vb.height || parseFloat(svgRoot.getAttribute('height') || '0') || 0
    };

    if (oldViewBox.width === 0 || oldViewBox.height === 0) {
      // Synthesize from bounding client rect if no viewBox/dimensions
      const rect = svgRoot.getBoundingClientRect();
      oldViewBox.width = rect.width;
      oldViewBox.height = rect.height;
    }

    // Parse margin (support user units, px, or screen units)
    let marginInUserUnits = 0;
    if (typeof opts.margin === 'string') {
      const marginMatch = opts.margin.match(/^([\d.]+)(px|%)?$/);
      if (marginMatch && marginMatch[1]) {
        const value = parseFloat(marginMatch[1]);
        const unit = marginMatch[2];

        if (unit === 'px') {
          // Convert px to user units using current scale
          const rect = svgRoot.getBoundingClientRect();
          const scaleX = rect.width / oldViewBox.width;
          marginInUserUnits = value / scaleX;
        } else if (unit === '%') {
          // Percentage of bbox diagonal
          const diagonal = Math.sqrt(bbox.width * bbox.width + bbox.height * bbox.height);
          marginInUserUnits = (value / 100) * diagonal;
        } else {
          // User units
          marginInUserUnits = value;
        }
      }
    } else {
      marginInUserUnits = opts.margin;
    }

    // Calculate new viewBox based on aspect mode
    let newViewBox;

    if (opts.aspect === 'stretch') {
      // Use exact bbox as viewBox (with margin)
      newViewBox = {
        x: bbox.x - marginInUserUnits,
        y: bbox.y - marginInUserUnits,
        width: bbox.width + marginInUserUnits * 2,
        height: bbox.height + marginInUserUnits * 2
      };
    } else if (opts.aspect === 'changePosition') {
      // Keep viewBox dimensions, only center on objects (camera pan)
      const centerX = bbox.x + bbox.width / 2;
      const centerY = bbox.y + bbox.height / 2;
      newViewBox = {
        x: centerX - oldViewBox.width / 2,
        y: centerY - oldViewBox.height / 2,
        width: oldViewBox.width,
        height: oldViewBox.height
      };
    } else if (opts.aspect === 'preserveAspectRatio') {
      // Scale viewBox uniformly to meet/slice the bbox
      const oldAspect = oldViewBox.width / oldViewBox.height;
      const bboxAspect =
        (bbox.width + marginInUserUnits * 2) / (bbox.height + marginInUserUnits * 2);

      let newWidth, newHeight;

      if (opts.aspectRatioMode === 'meet') {
        // Ensure ALL content fits inside viewBox
        // Use the dimension that requires LESS scaling
        if (oldAspect > bboxAspect) {
          // ViewBox is wider: fit height, add horizontal space
          newHeight = bbox.height + marginInUserUnits * 2;
          newWidth = newHeight * oldAspect;
        } else {
          // ViewBox is taller: fit width, add vertical space
          newWidth = bbox.width + marginInUserUnits * 2;
          newHeight = newWidth / oldAspect;
        }
      } else {
        // slice
        // Ensure viewBox is COMPLETELY FILLED by content
        // Use the dimension that requires MORE scaling
        if (oldAspect > bboxAspect) {
          // ViewBox is wider: fit width, clip height
          newWidth = bbox.width + marginInUserUnits * 2;
          newHeight = newWidth / oldAspect;
        } else {
          // ViewBox is taller: fit height, clip width
          newHeight = bbox.height + marginInUserUnits * 2;
          newWidth = newHeight * oldAspect;
        }
      }

      // Apply alignment
      const bboxCenterX = bbox.x + bbox.width / 2;
      const bboxCenterY = bbox.y + bbox.height / 2;

      // Parse alignment (xMin/xMid/xMax + YMin/YMid/YMax)
      const alignMatch = opts.align.match(/^x(Min|Mid|Max)Y(Min|Mid|Max)$/);
      const xAlign = alignMatch ? alignMatch[1] : 'Mid';
      const yAlign = alignMatch ? alignMatch[2] : 'Mid';

      let newX, newY;

      // Horizontal alignment
      if (xAlign === 'Min') {
        newX = bbox.x - marginInUserUnits;
      } else if (xAlign === 'Max') {
        newX = bbox.x + bbox.width + marginInUserUnits - newWidth;
      } else {
        // Mid
        newX = bboxCenterX - newWidth / 2;
      }

      // Vertical alignment
      if (yAlign === 'Min') {
        newY = bbox.y - marginInUserUnits;
      } else if (yAlign === 'Max') {
        newY = bbox.y + bbox.height + marginInUserUnits - newHeight;
      } else {
        // Mid
        newY = bboxCenterY - newHeight / 2;
      }

      newViewBox = { x: newX, y: newY, width: newWidth, height: newHeight };
    } else {
      throw new Error(`Unknown aspect mode: ${opts.aspect}`);
    }

    // Save current visibility state if requested
    /** @type {Record<string, {display: string, visibility: string, opacity: string}> | null} */
    let savedVisibilityList = null;
    if (opts.saveVisibilityList) {
      /** @type {Record<string, {display: string, visibility: string, opacity: string}>} */
      const visibilityMap = {};
      const allElements = svgRoot.querySelectorAll('[id]');
      allElements.forEach((el) => {
        if (el instanceof HTMLElement || el instanceof SVGElement) {
          const computedStyle = window.getComputedStyle(el);
          visibilityMap[el.id] = {
            display: el.style.display || computedStyle.display,
            visibility: el.style.visibility || computedStyle.visibility,
            opacity: el.style.opacity || computedStyle.opacity
          };
        }
      });
      savedVisibilityList = visibilityMap;
    }

    // Apply visibility changes
    /** @type {Record<string, string | {display: string, visibility: string, opacity: string}>} */
    const oldVisibilityStates = {};
    if (opts.visibility !== 'unchanged' && !opts.dryRun) {
      if (opts.visibility === 'hideAllExcept') {
        // Hide all elements except targets
        const allElements = svgRoot.querySelectorAll('[id]');
        allElements.forEach((el) => {
          if (el instanceof HTMLElement || el instanceof SVGElement) {
            oldVisibilityStates[el.id] = el.style.display;
            if (!ids.includes(el.id)) {
              el.style.display = 'none';
            }
          }
        });
      } else if (opts.visibility === 'hideTargets') {
        // Hide only target elements
        elements.forEach((el) => {
          if (
            el instanceof HTMLElement ||
            (typeof SVGElement !== 'undefined' && el instanceof SVGElement)
          ) {
            oldVisibilityStates[el.id] = el.style.display;
            el.style.display = 'none';
          }
        });
      } else if (opts.visibility === 'restoreList' && opts.visibilityList) {
        // Restore from provided visibility list
        const visList =
          /** @type {Record<string, {display?: string, visibility?: string, opacity?: string}>} */ (
            opts.visibilityList
          );
        Object.keys(visList).forEach((id) => {
          const el = document.getElementById(id);
          if (el) {
            const state = visList[id];
            if (!state) return;
            oldVisibilityStates[id] = {
              display: el.style.display,
              visibility: el.style.visibility,
              opacity: el.style.opacity
            };
            if (state.display !== undefined) {
              el.style.display = state.display;
            }
            if (state.visibility !== undefined) {
              el.style.visibility = state.visibility;
            }
            if (state.opacity !== undefined) {
              el.style.opacity = state.opacity;
            }
          }
        });
      }
    }

    // Apply viewBox change (unless dry-run)
    const oldViewBoxString = `${oldViewBox.x} ${oldViewBox.y} ${oldViewBox.width} ${oldViewBox.height}`;
    if (!opts.dryRun) {
      svgRoot.setAttribute(
        'viewBox',
        `${newViewBox.x} ${newViewBox.y} ${newViewBox.width} ${newViewBox.height}`
      );
    }

    // Create restore function
    const restore = () => {
      svgRoot.setAttribute('viewBox', oldViewBoxString);

      // Restore visibility states
      Object.keys(oldVisibilityStates).forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
          const state = oldVisibilityStates[id];
          if (!state) return;
          if (typeof state === 'string') {
            el.style.display = state;
          } else {
            if (state.display !== undefined) {
              el.style.display = state.display;
            }
            if (state.visibility !== undefined) {
              el.style.visibility = state.visibility;
            }
            if (state.opacity !== undefined) {
              el.style.opacity = state.opacity;
            }
          }
        }
      });
    };

    return {
      newViewBox: newViewBox,
      oldViewBox: oldViewBox,
      bbox: bbox,
      visibilityList: savedVisibilityList,
      restore: restore
    };
  }

  // Export public API
  return {
    waitForDocumentFonts: waitForDocumentFonts,
    getSvgElementVisualBBoxTwoPassAggressive: getSvgElementVisualBBoxTwoPassAggressive,
    getSvgElementsUnionVisualBBox: getSvgElementsUnionVisualBBox,
    getSvgElementVisibleAndFullBBoxes: getSvgElementVisibleAndFullBBoxes,
    getSvgRootViewBoxExpansionForFullDrawing: getSvgRootViewBoxExpansionForFullDrawing,
    showTrueBBoxBorder: showTrueBBoxBorder,
    setViewBoxOnObjects: setViewBoxOnObjects
  };
});
