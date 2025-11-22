
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
      if (!isFinite(box.x) || !isFinite(box.y)) return null;
      if (!isFinite(box.width) || !isFinite(box.height)) return null;
      // If width & height are 0, treat as untrustworthy (especially for text-ish nodes)
      if (box.width === 0 && box.height === 0) return null;
      return { x: box.x, y: box.y, width: box.width, height: box.height };
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
      throw new Error('rasterizeSvgElementToBBox: cannot find target in cloned SVG');
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
        reject(new Error('Failed loading serialized SVG: ' + (e && e.message ? e.message : 'image error')));
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
      // Tainted canvas: cross-origin images/fonts without CORS headers
      throw new Error(
        'rasterizeSvgElementToBBox: cannot read pixels (canvas is tainted). ' +
        'Ensure SVG + referenced images/fonts are same-origin or CORS-enabled. ' +
        (e && e.message ? e.message : '')
      );
    }

    const data = imageData.data;
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

    if (xMax < xMin || yMax < yMin) {
      // No visible pixels (fully clipped / transparent)
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
      throw new Error('getSvgElementVisualBBoxTwoPassAggressive: element not found');
    }

    const doc = el.ownerDocument || document;
    await waitForDocumentFonts(doc, fontTimeoutMs);

    const svgRoot = el.ownerSVGElement || (el instanceof SVGSVGElement ? el : null);
    if (!svgRoot) {
      throw new Error('getSvgElementVisualBBoxTwoPassAggressive: element is not inside an <svg>');
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
    const coarseBBox = await rasterizeSvgElementToBBox(el, svgRoot, coarseROI, coarsePPU);
    if (!coarseBBox) {
      // Fully transparent / clipped; visually nothing there
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
      throw new Error('getSvgElementsUnionVisualBBox: targets must be a non-empty array');
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
        throw new Error(
          'getSvgElementsUnionVisualBBox: all elements must live in the same <svg> root'
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
      throw new Error('getSvgRootViewBoxExpansionForFullDrawing: target must be a root <svg> element or its id');
    }

    const vbVal = svgRoot.viewBox && svgRoot.viewBox.baseVal;
    if (!vbVal || !vbVal.width || !vbVal.height) {
      throw new Error('getSvgRootViewBoxExpansionForFullDrawing: root <svg> must have a viewBox');
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
