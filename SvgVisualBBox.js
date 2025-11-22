
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
 *      For a root <svg> with a viewBox, computes how much padding you’d
 *      need to expand the viewBox so its visible area fully covers the
 *      drawing’s full visual bbox.
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
  if (typeof define === 'function' && define.amd) {
    // AMD
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    // CommonJS / Node
    module.exports = factory();
  } else {
    // Browser global
    root.SvgVisualBBox = factory();
  }
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  // Debug flag - set to true to enable console logging
  const DEBUG = false;

  /**
   * Wait until the document's fonts are loaded (CSS Font Loading API),
   * with a timeout so we don't hang forever if the network is flaky.
   *
   * @param {Document} [doc=document]  The document whose fonts to wait for.
   * @param {number} [timeoutMs=8000]  Max time to wait (ms). If <=0, waits fully.
   * @returns {Promise<void>}
   */
  async function waitForDocumentFonts(doc, timeoutMs) {
    if (!doc) {
      doc = document;
    }
    if (typeof timeoutMs !== 'number') {
      timeoutMs = 8000;
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

    await Promise.race([
      readyPromise,
      new Promise(resolve => setTimeout(resolve, timeoutMs))
    ]);
  }

  /**
   * INTERNAL: Safely get getBBox() from an element, treating it as a hint only.
   * Returns null if getBBox() fails, returns invalid values, or returns empty box.
   *
   * @param {SVGElement} el
   * @returns {{x:number,y:number,width:number,height:number}|null}
   */
  function safeGetBBox(el) {
    try {
      const box = el.getBBox();
      if (!box) return null;
      // Extract values explicitly (SVGRect properties aren't enumerable)
      const x = box.x;
      const y = box.y;
      const width = box.width;
      const height = box.height;
      if (!isFinite(x) || !isFinite(y)) return null;
      if (!isFinite(width) || !isFinite(height)) return null;
      // If width & height are 0, treat as untrustworthy (especially for text-ish nodes)
      if (width === 0 && height === 0) return null;
      return { x, y, width, height };
    } catch {
      return null;
    }
  }

  /**
   * INTERNAL: For text-ish elements (textPath, tspan), try to get bbox from parent <text>
   * as a fallback, since getBBox() on these child elements is unreliable in headless Chrome.
   *
   * @param {SVGElement} el
   * @returns {SVGElement} - Returns the element itself, or parent <text> if appropriate
   */
  function normalizeTargetForText(el) {
    const tagName = el.tagName.toLowerCase();
    if ((tagName === 'textpath' || tagName === 'tspan') && el.closest('text')) {
      return el.closest('text');
    }
    return el;
  }

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
    if (!roi || roi.width <= 0 || roi.height <= 0) {
      return null;
    }

    const vb = roi;

    // Clone the root <svg> so we don't touch the real DOM
    const clonedSvg = svgRoot.cloneNode(true);

    if (!clonedSvg.getAttribute('xmlns')) {
      clonedSvg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    }

    // Map ROI user space → viewport
    clonedSvg.setAttribute('viewBox', vb.x + ' ' + vb.y + ' ' + vb.width + ' ' + vb.height);

    const pixelWidth  = Math.max(1, Math.round(vb.width  * pixelsPerUnit));
    const pixelHeight = Math.max(1, Math.round(vb.height * pixelsPerUnit));

    clonedSvg.setAttribute('width',  String(pixelWidth));
    clonedSvg.setAttribute('height', String(pixelHeight));

    // Map target element to cloned SVG
    const hadId = !!el.id;
    let tmpId;
    if (!hadId) {
      tmpId = '__svg_visual_bbox_tmp_' + Math.random().toString(36).slice(2);
      el.id = tmpId;
    }

    const cloneTarget = clonedSvg.getElementById(el.id);

    if (!hadId) {
      el.removeAttribute('id');
    }

    if (!cloneTarget) {
      const elementInfo = el.id ? `element with id="${el.id}"` : `element ${el.tagName}`;
      throw new Error(
        `Cannot render SVG element: ${elementInfo} not found in cloned SVG.\n` +
        `\n` +
        `This typically happens when:\n` +
        `  1. The element is the SVG root itself (not supported - query a child element instead)\n` +
        `  2. The element was removed or modified during cloning\n` +
        `\n` +
        `How to fix:\n` +
        `  • If querying the root <svg>, query a child element instead\n` +
        `  • Ensure the element has a valid 'id' attribute\n` +
        `  • Check that the element exists in the DOM before calling this function`
      );
    }

    // Keep:
    //  - target
    //  - its ancestors
    //  - its descendants
    //  - all <defs> (filters, markers, gradients, patterns, etc.)
    const allowed = new Set();
    let node = cloneTarget;
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
        addDescendants(children[i]);
      }
    })(cloneTarget);

    (function hideIrrelevant(rootNode) {
      const children = Array.prototype.slice.call(rootNode.children);
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const tag = child.tagName && child.tagName.toLowerCase();

        if (tag === 'defs') {
          // Keep all defs intact
          continue;
        }

        if (!allowed.has(child) && !child.contains(cloneTarget)) {
          child.setAttribute('display', 'none');
        } else {
          hideIrrelevant(child);
        }
      }
    })(clonedSvg);

    // Serialize SVG → Blob → Image
    const xml  = new XMLSerializer().serializeToString(clonedSvg);

    if (DEBUG && typeof console !== 'undefined' && console.log) {
      console.log('[DEBUG rasterize] Serialized SVG length:', xml.length);
      console.log('[DEBUG rasterize] SVG contains textPath:', xml.includes('textPath'));
      console.log('[DEBUG rasterize] SVG contains curve:', xml.includes('id="curve"'));
      if (xml.length < 2000) {
        console.log('[DEBUG rasterize] Full SVG:', xml);
      }
    }

    const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url  = URL.createObjectURL(blob);

    const img = new Image();
    img.decoding    = 'async';
    img.crossOrigin = 'anonymous';
    img.src         = url;

    await new Promise((resolve, reject) => {
      img.onload  = function () {
        resolve(); 
      };
      img.onerror = function (e) {
        const errorMsg = e && e.message ? e.message : 'unknown error';
        reject(new Error(
          `Failed to render SVG as image: ${errorMsg}\n` +
          `\n` +
          `This can happen when:\n` +
          `  1. The SVG contains invalid XML syntax\n` +
          `  2. Referenced resources (images, fonts) failed to load\n` +
          `  3. The SVG uses unsupported features\n` +
          `  4. Browser security policies blocked the rendering\n` +
          `\n` +
          `How to fix:\n` +
          `  • Validate your SVG with an XML validator\n` +
          `  • Check that all external resources (images, fonts) are accessible\n` +
          `  • Ensure referenced elements (gradients, patterns, etc.) exist in <defs>\n` +
          `  • Try simplifying the SVG to isolate the problematic element`
        ));
      };
    });

    const canvas = document.createElement('canvas');
    canvas.width  = pixelWidth;
    canvas.height = pixelHeight;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, pixelWidth, pixelHeight);
    ctx.drawImage(img, 0, 0, pixelWidth, pixelHeight);
    URL.revokeObjectURL(url);

    let imageData;
    try {
      imageData = ctx.getImageData(0, 0, pixelWidth, pixelHeight);
    } catch (e) {
      // Detect specific error types for better user guidance
      const isOutOfMemory = e && e.message && /out of memory/i.test(e.message);
      const isTainted = e && e.message && /tainted/i.test(e.message);

      if (isOutOfMemory) {
        throw new Error(
          `Cannot render SVG: Canvas out of memory\n` +
          `\n` +
          `The SVG coordinates or dimensions are too large for canvas rasterization.\n` +
          `Current viewBox: ${vb.x} ${vb.y} ${vb.width} ${vb.height}\n` +
          `Attempted canvas size: ${pixelWidth}×${pixelHeight} pixels\n` +
          `\n` +
          `How to fix:\n` +
          `  • Reduce the viewBox dimensions to a reasonable size (< 10,000 units)\n` +
          `  • Use smaller coordinates (avoid values > 100,000)\n` +
          `  • Decrease the pixelsPerUnit scaling factor\n` +
          `  • Split large SVG into smaller regions and process separately\n` +
          `\n` +
          `Original error: ${e.message}`
        );
      }

      if (isTainted) {
        throw new Error(
          `Cannot read SVG pixels: Canvas is tainted by cross-origin resources\n` +
          `\n` +
          `This happens when your SVG references external resources without CORS:\n` +
          `  • External images (PNG, JPG, etc.) from different domains\n` +
          `  • Web fonts from CDNs without proper CORS headers\n` +
          `  • SVG <use> elements referencing external files\n` +
          `\n` +
          `How to fix:\n` +
          `  • Host images/fonts on the same domain as your page\n` +
          `  • Configure CORS headers on external resources (Access-Control-Allow-Origin: *)\n` +
          `  • Use data URLs for images instead of external URLs\n` +
          `  • Embed fonts directly in the SVG using @font-face with data URLs\n` +
          `\n` +
          `Original error: ${e.message}`
        );
      }

      // Generic canvas error
      throw new Error(
        `Cannot read SVG pixels from canvas\n` +
        `\n` +
        `Error: ${e && e.message ? e.message : 'unknown canvas error'}\n` +
        `\n` +
        `Common causes:\n` +
        `  • Cross-origin images/fonts without CORS (canvas becomes "tainted")\n` +
        `  • Canvas size too large (out of memory)\n` +
        `  • Browser security restrictions\n` +
        `\n` +
        `How to fix:\n` +
        `  • Check browser console for specific CORS errors\n` +
        `  • Ensure all external resources are same-origin or have CORS enabled\n` +
        `  • Try reducing the SVG size or complexity`
      );
    }

    const data = imageData.data;

    if (DEBUG && typeof console !== 'undefined' && console.log) {
      // Count non-transparent pixels for debugging
      let nonZeroAlpha = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] !== 0) nonZeroAlpha++;
      }
      console.log('[DEBUG rasterize] Total pixels with alpha > 0:', nonZeroAlpha);
    }

    let xMin = pixelWidth,  xMax = -1;
    let yMin = pixelHeight, yMax = -1;

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

    const userX = vb.x + xMin / pixelsPerUnit;
    const userY = vb.y + yMin / pixelsPerUnit;
    const userW = (xMax - xMin + 1) / pixelsPerUnit;
    const userH = (yMax - yMin + 1) / pixelsPerUnit;

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
    const mode             = options.mode || 'clipped';
    const coarseFactor     = (typeof options.coarseFactor === 'number') ? options.coarseFactor : 3;
    const fineFactor       = (typeof options.fineFactor === 'number') ? options.fineFactor : 24;
    const safetyMarginUser = (typeof options.safetyMarginUser === 'number') ? options.safetyMarginUser : null;
    const useLayoutScale   = (typeof options.useLayoutScale === 'boolean') ? options.useLayoutScale : true;
    const fontTimeoutMs    = (typeof options.fontTimeoutMs === 'number') ? options.fontTimeoutMs : 8000;

    // Resolve element
    const el = (typeof target === 'string')
      ? document.getElementById(target)
      : target;

    if (!el) {
      const targetDesc = typeof target === 'string' ? `id="${target}"` : 'provided reference';
      throw new Error(
        `Cannot compute SVG bounding box: Element not found (${targetDesc})\n` +
        `\n` +
        `How to fix:\n` +
        `  • Check that the element exists in the DOM\n` +
        `  • Verify the element ID is correct (case-sensitive)\n` +
        `  • Ensure the element hasn't been removed from the DOM\n` +
        `  • If passing an element reference, make sure it's not null/undefined`
      );
    }

    const doc = el.ownerDocument || document;
    await waitForDocumentFonts(doc, fontTimeoutMs);

    const svgRoot = el.ownerSVGElement || (el instanceof SVGSVGElement ? el : null);
    if (!svgRoot) {
      const elementType = el.tagName || el.nodeName || 'unknown';
      throw new Error(
        `Cannot compute SVG bounding box: Element <${elementType}> is not inside an SVG tree\n` +
        `\n` +
        `This element is not connected to an <svg> root element.\n` +
        `\n` +
        `How to fix:\n` +
        `  • Ensure the element is inside an <svg> tag in the DOM\n` +
        `  • Check that you're not querying a detached/orphaned element\n` +
        `  • If creating elements programmatically, append them to the SVG tree first\n` +
        `  • Verify the element hasn't been removed from the document`
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

    // Try to get geometry bbox from the target element (or parent text for textPath/tspan)
    const normalizedEl = normalizeTargetForText(el);
    let geomBox = safeGetBBox(normalizedEl);

    // Decide coarse region of interest (ROI) for PASS 1
    let coarseROI;
    if (mode === 'unclipped') {
      // Whole drawing, ignoring viewBox/viewport clipping
      if (geomBox) {
        coarseROI = {
          x: geomBox.x,
          y: geomBox.y,
          width:  geomBox.width,
          height: geomBox.height
        };
      } else {
        // No geometry hint - use viewBox as fallback region
        coarseROI = viewBox;
      }
    } else {
      // "clipped": restrict to visible viewBox/viewport
      coarseROI = {
        x: viewBox.x,
        y: viewBox.y,
        width:  viewBox.width,
        height: viewBox.height
      };
    }

    // Derive base pixels-per-user-unit from layout (optional)
    let basePixelsPerUnit = 1;
    if (useLayoutScale && viewBox.width > 0 && viewBox.height > 0) {
      const rect = svgRoot.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0) {
        const pxPerUnitX = rect.width  / viewBox.width;
        const pxPerUnitY = rect.height / viewBox.height;
        basePixelsPerUnit = (pxPerUnitX + pxPerUnitY) / 2;
      }
    }

    const coarsePPU = Math.max(1, basePixelsPerUnit * coarseFactor);
    const finePPU   = Math.max(4, basePixelsPerUnit * fineFactor);

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
    const roiX1 = coarseBBox.x + coarseBBox.width  + marginUser;
    const roiY1 = coarseBBox.y + coarseBBox.height + marginUser;

    const fineROI = {
      x: roiX0,
      y: roiY0,
      width:  Math.max(0, roiX1 - roiX0),
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
      width:  fineBBox.width,
      height: fineBBox.height,
      element: el,
      svgRoot: svgRoot
    };
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
        `Cannot compute union bounding box: Invalid targets parameter\n` +
        `\n` +
        `Expected: Non-empty array of SVG elements or element IDs\n` +
        `Received: ${Array.isArray(targets) ? 'empty array' : typeof targets}\n` +
        `\n` +
        `How to fix:\n` +
        `  • Pass an array with at least one element\n` +
        `  • Example: ['element1', 'element2'] or [el1, el2]\n` +
        `  • Ensure the array is not empty before calling this function`
      );
    }

    const bboxes = [];
    let svgRoot = null;

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
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
          `Cannot compute union bounding box: Elements from different SVG documents\n` +
          `\n` +
          `All elements must belong to the same <svg> root element.\n` +
          `Previous SVG: ${prevId}\n` +
          `Current SVG:  ${currId}\n` +
          `\n` +
          `How to fix:\n` +
          `  • Ensure all elements are children of the same <svg> root\n` +
          `  • If you have multiple SVGs, compute bbox for each separately\n` +
          `  • Check that elements haven't been moved between different SVG trees`
        );
      }
      bboxes.push(bbox);
    }

    if (bboxes.length === 0) {
      return null;
    }

    let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;

    for (let i = 0; i < bboxes.length; i++) {
      const b = bboxes[i];
      xMin = Math.min(xMin, b.x);
      yMin = Math.min(yMin, b.y);
      xMax = Math.max(xMax, b.x + b.width);
      yMax = Math.max(yMax, b.y + b.height);
    }

    return {
      x: xMin,
      y: yMin,
      width:  xMax - xMin,
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
    const optVisible = Object.assign({}, options, { mode: 'clipped' });
    const optFull    = Object.assign({}, options, { mode: 'unclipped' });

    const visible = await getSvgElementVisualBBoxTwoPassAggressive(target, optVisible);
    const full    = await getSvgElementVisualBBoxTwoPassAggressive(target, optFull);

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

    const svgRoot = (typeof svgRootOrId === 'string')
      ? document.getElementById(svgRootOrId)
      : svgRootOrId;

    if (!svgRoot || !(svgRoot instanceof SVGSVGElement)) {
      const targetDesc = typeof svgRootOrId === 'string' ? `id="${svgRootOrId}"` : 'provided reference';
      throw new Error(
        `Cannot compute viewBox expansion: Invalid SVG root (${targetDesc})\n` +
        `\n` +
        `Expected: Root <svg> element or its ID\n` +
        `Received: ${svgRoot ? svgRoot.tagName : 'null/undefined'}\n` +
        `\n` +
        `How to fix:\n` +
        `  • Pass the root <svg> element or its ID string\n` +
        `  • Ensure the element is actually an <svg> tag, not a child element\n` +
        `  • Check that the element exists in the DOM`
      );
    }

    const vbVal = svgRoot.viewBox && svgRoot.viewBox.baseVal;
    if (!vbVal || !vbVal.width || !vbVal.height) {
      const svgId = svgRoot.id ? `id="${svgRoot.id}"` : '(no id)';
      throw new Error(
        `Cannot compute viewBox expansion: SVG missing valid viewBox (${svgId})\n` +
        `\n` +
        `The root <svg> element must have a viewBox attribute with valid dimensions.\n` +
        `Current viewBox: ${svgRoot.getAttribute('viewBox') || '(none)'}\n` +
        `\n` +
        `How to fix:\n` +
        `  • Add a viewBox attribute to your <svg> tag\n` +
        `  • Example: <svg viewBox="0 0 800 600" ...>\n` +
        `  • Ensure viewBox has 4 numbers: x, y, width, height\n` +
        `  • Width and height must be greater than 0\n` +
        `  • Use the fix_svg_viewbox.js tool to auto-generate viewBox`
      );
    }

    const currentViewBox = {
      x: vbVal.x,
      y: vbVal.y,
      width:  vbVal.width,
      height: vbVal.height
    };

    const both = await getSvgElementVisibleAndFullBBoxes(svgRoot, options);
    const visible = both.visible;
    const full    = both.full;

    if (!full) {
      // Nothing is visually drawn at all
      return null;
    }

    const currRight  = currentViewBox.x + currentViewBox.width;
    const currBottom = currentViewBox.y + currentViewBox.height;
    const fullRight  = full.x + full.width;
    const fullBottom = full.y + full.height;

    const padLeft   = Math.max(0, currentViewBox.x - full.x);
    const padTop    = Math.max(0, currentViewBox.y - full.y);
    const padRight  = Math.max(0, fullRight  - currRight);
    const padBottom = Math.max(0, fullBottom - currBottom);

    const newViewBox = {
      x: currentViewBox.x - padLeft,
      y: currentViewBox.y - padTop,
      width:  currentViewBox.width  + padLeft + padRight,
      height: currentViewBox.height + padTop  + padBottom
    };

    return {
      currentViewBox: currentViewBox,
      visibleBBox: visible,
      fullBBox: full,
      padding: {
        left:   padLeft,
        top:    padTop,
        right:  padRight,
        bottom: padBottom
      },
      newViewBox: newViewBox
    };
  }

  // Export public API
  return {
    waitForDocumentFonts: waitForDocumentFonts,
    getSvgElementVisualBBoxTwoPassAggressive: getSvgElementVisualBBoxTwoPassAggressive,
    getSvgElementsUnionVisualBBox: getSvgElementsUnionVisualBBox,
    getSvgElementVisibleAndFullBBoxes: getSvgElementVisibleAndFullBBoxes,
    getSvgRootViewBoxExpansionForFullDrawing: getSvgRootViewBoxExpansionForFullDrawing
  };
}));
