/**
 * FBF.SVG (Frame-By-Frame SVG) helpers.
 *
 * FBF.SVG is the format produced by https://github.com/Emasoft/svg2fbf.
 * Every animation frame is a complete static scene stored in <defs> as
 * <g id="FRAME00001">…</g>, and a single <use id="PROSKENION"> with a
 * discrete-mode <animate> swaps its xlink:href across the frame ids.
 *
 * These helpers operate purely on the SVG markup string. They detect the
 * format, list the available frames, and produce a "pinned" SVG where
 * PROSKENION points at a chosen frame and the <animate> child is removed —
 * which lets a normal SVG renderer (e.g. sbb-svg2png) snapshot exactly
 * that frame without timeline manipulation.
 */

'use strict';

// WHY: A FRAME id is FRAME followed by 1+ decimal digits. The spec uses
// 5-digit zero padding (FRAME00001), but the example in issue #3 also
// shows 4-digit ids (FRAME0001), so we accept any width and normalise on
// output to whatever width the file already uses.

/**
 * @typedef {Object} FrameInfo
 * @property {string} id - Full id, e.g. "FRAME00001"
 * @property {number} number - Decoded 1-based frame number
 * @property {number} padWidth - Number of digits used by the id
 */

/**
 * @typedef {Object} FbfDescriptor
 * @property {boolean} isFbf - Whether the SVG looks like an FBF.SVG
 * @property {FrameInfo[]} frames - Sorted unique frame infos
 * @property {number} padWidth - Digit width used by the file (0 if none)
 * @property {number} minFrame - Lowest frame number found (0 if none)
 * @property {number} maxFrame - Highest frame number found (0 if none)
 * @property {boolean} hasProskenion - Whether a <use id="PROSKENION"> exists
 */

/**
 * Find the start/end indices of the named element in the SVG string.
 *
 * Handles self-closing tags (<tag .../>) and paired tags (<tag>...</tag>)
 * with arbitrary nesting of the same element. Returns null if not found.
 *
 * @param {string} svg - SVG markup
 * @param {string} tagName - Element name, e.g. "use"
 * @param {string} idValue - Required id attribute value, e.g. "PROSKENION"
 * @returns {{ openStart: number, openEnd: number, closeStart: number, closeEnd: number, selfClosing: boolean } | null}
 */
function findElementById(svg, tagName, idValue) {
  // WHY: Build a tolerant regex that matches the opening tag with any
  // attribute order. We only need to find the START — the end is located
  // by manual brace-matching to handle nested same-name elements.
  const idAttr = new RegExp(
    `<${tagName}\\b[^>]*?\\bid\\s*=\\s*["']${escapeRegex(idValue)}["'][^>]*?>`,
    'i'
  );
  const m = idAttr.exec(svg);
  if (!m) return null;

  const openStart = m.index;
  const openEnd = openStart + m[0].length;
  const selfClosing = m[0].endsWith('/>');

  if (selfClosing) {
    return { openStart, openEnd, closeStart: openEnd, closeEnd: openEnd, selfClosing: true };
  }

  // WHY: Walk forward counting same-name nested opens so we land on the
  // matching </tagName>. A naive regex would match the first close tag
  // even when nested elements of the same kind appear inside.
  const openRe = new RegExp(`<${tagName}\\b[^>]*?>`, 'gi');
  const closeRe = new RegExp(`</${tagName}\\s*>`, 'gi');
  openRe.lastIndex = openEnd;
  closeRe.lastIndex = openEnd;

  let depth = 1;
  while (depth > 0) {
    const nextOpen = openRe.exec(svg);
    const nextClose = closeRe.exec(svg);
    if (!nextClose) return null;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++;
      // WHY: Self-closing nested tags don't increase depth.
      if (nextOpen[0].endsWith('/>')) depth--;
      closeRe.lastIndex = nextOpen.index + nextOpen[0].length;
    } else {
      depth--;
      openRe.lastIndex = nextClose.index + nextClose[0].length;
      if (depth === 0) {
        return {
          openStart,
          openEnd,
          closeStart: nextClose.index,
          closeEnd: nextClose.index + nextClose[0].length,
          selfClosing: false
        };
      }
    }
  }
  return null;
}

/**
 * Escape a string so it can be embedded literally inside a RegExp.
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Inspect an SVG string and report whether it is an FBF.SVG and what
 * frames it contains.
 *
 * @param {string} svg - Full SVG markup
 * @returns {FbfDescriptor}
 */
function describeFbf(svg) {
  if (typeof svg !== 'string' || svg.length === 0) {
    return {
      isFbf: false,
      frames: [],
      padWidth: 0,
      minFrame: 0,
      maxFrame: 0,
      hasProskenion: false
    };
  }

  // WHY: Look for any element (g, symbol, etc.) whose id is FRAMEnnnn.
  // The spec mandates <g id="FRAMExxxxx"> inside <defs>, but tolerating
  // other element types keeps the helper future-proof.
  const idRe = /\bid\s*=\s*["']FRAME(\d+)["']/g;
  /** @type {Map<string, FrameInfo>} */
  const seen = new Map();
  let match;
  while ((match = idRe.exec(svg)) !== null) {
    const digits = match[1];
    if (!digits) continue;
    const id = `FRAME${digits}`;
    if (seen.has(id)) continue;
    seen.set(id, {
      id,
      number: parseInt(digits, 10),
      padWidth: digits.length
    });
  }

  const frames = Array.from(seen.values()).sort((a, b) => a.number - b.number);
  const hasProskenion = /\bid\s*=\s*["']PROSKENION["']/.test(svg);

  // WHY: Pick the dominant pad width from the actual frame ids in the
  // file. If the file mixes widths (5-digit defs, 4-digit references —
  // see issue #3), use the widest one for normalised id construction.
  let padWidth = 0;
  for (const f of frames) if (f.padWidth > padWidth) padWidth = f.padWidth;

  const isFbf = hasProskenion && frames.length > 0;
  return {
    isFbf,
    frames,
    padWidth,
    minFrame: frames.length > 0 ? /** @type {FrameInfo} */ (frames[0]).number : 0,
    maxFrame: frames.length > 0 ? /** @type {FrameInfo} */ (frames[frames.length - 1]).number : 0,
    hasProskenion
  };
}

/**
 * Quick boolean form of {@link describeFbf} for callers that only need a
 * yes/no answer.
 * @param {string} svg
 * @returns {boolean}
 */
function isFbfSvg(svg) {
  return describeFbf(svg).isFbf;
}

/**
 * Format a frame number as a frame id using the file's pad width (or a
 * supplied width). Throws on non-positive integers.
 *
 * @param {number} frameNumber - 1-based frame number
 * @param {number} padWidth - Digit width to zero-pad to (>= 1)
 * @returns {string}
 */
function formatFrameId(frameNumber, padWidth) {
  if (!Number.isInteger(frameNumber) || frameNumber < 1) {
    throw new Error(`Frame number must be a positive integer, got: ${frameNumber}`);
  }
  if (!Number.isInteger(padWidth) || padWidth < 1) {
    throw new Error(`Pad width must be a positive integer, got: ${padWidth}`);
  }
  const s = String(frameNumber);
  return `FRAME${s.length >= padWidth ? s : s.padStart(padWidth, '0')}`;
}

/**
 * Resolve a 1-based frame number to the actual frame id present in the
 * SVG, tolerating mixed pad widths. Returns null when no frame matches.
 *
 * @param {FbfDescriptor} desc
 * @param {number} frameNumber
 * @returns {string | null}
 */
function resolveFrameId(desc, frameNumber) {
  for (const f of desc.frames) {
    if (f.number === frameNumber) return f.id;
  }
  return null;
}

/**
 * Produce a new SVG string with PROSKENION pinned to the chosen frame and
 * its child <animate> removed. The rest of the document — including
 * STAGE_BACKGROUND, STAGE_FOREGROUND, OVERLAY_LAYER and SHARED_DEFINITIONS —
 * is left untouched, so a normal SVG renderer will snapshot the frame
 * exactly as it appears in the running animation.
 *
 * Throws when the input is not FBF.SVG or when the requested frame
 * doesn't exist; the error message lists what is available.
 *
 * @param {string} svg
 * @param {number} frameNumber - 1-based frame number to pin
 * @returns {{ svg: string, frameId: string, frameNumber: number, totalFrames: number }}
 */
function pinFrame(svg, frameNumber) {
  const desc = describeFbf(svg);
  if (!desc.isFbf) {
    if (!desc.hasProskenion) {
      throw new Error(
        'Input does not look like an FBF.SVG: no <use id="PROSKENION"> element found.'
      );
    }
    throw new Error(
      'Input does not look like an FBF.SVG: no <g id="FRAMEnnnnn"> definitions found.'
    );
  }

  const targetId = resolveFrameId(desc, frameNumber);
  if (!targetId) {
    const available = `${desc.minFrame}..${desc.maxFrame} (${desc.frames.length} frames)`;
    throw new Error(`Frame ${frameNumber} not found in FBF.SVG. Available frames: ${available}.`);
  }

  const useElement = findElementById(svg, 'use', 'PROSKENION');
  if (!useElement) {
    // WHY: describeFbf already verified PROSKENION exists, but the parser
    // may not have located it (e.g. unusual namespace prefix). Fail loud
    // rather than silently produce an unmodified SVG.
    throw new Error('Could not locate the <use id="PROSKENION"> element for in-place pinning.');
  }

  const openTag = svg.slice(useElement.openStart, useElement.openEnd);
  const newOpenTag = setHrefAttribute(openTag, `#${targetId}`);

  /** @type {string} */
  let newUseBlock;
  if (useElement.selfClosing) {
    newUseBlock = newOpenTag;
  } else {
    const inner = svg.slice(useElement.openEnd, useElement.closeStart);
    const closeTag = svg.slice(useElement.closeStart, useElement.closeEnd);
    const innerStripped = stripAnimateChildren(inner);
    newUseBlock = newOpenTag + innerStripped + closeTag;
  }

  const next = svg.slice(0, useElement.openStart) + newUseBlock + svg.slice(useElement.closeEnd);

  return {
    svg: next,
    frameId: targetId,
    frameNumber,
    totalFrames: desc.frames.length
  };
}

/**
 * Replace (or add) xlink:href / href attributes on an element open tag
 * with a new value.
 *
 * @param {string} openTag - Full opening tag, e.g. '<use id="PROSKENION" xlink:href="#FRAME00001">'
 * @param {string} newHref - New href value, e.g. "#FRAME00007"
 * @returns {string}
 */
function setHrefAttribute(openTag, newHref) {
  let result = openTag;
  let replacedAny = false;

  // WHY: Replace BOTH xlink:href and the SVG2 plain href, because some
  // FBF generators emit either or both. Leaving the wrong one untouched
  // would let the original frame leak through after pinning.
  result = result.replace(/\bxlink:href\s*=\s*["'][^"']*["']/i, () => {
    replacedAny = true;
    return `xlink:href="${newHref}"`;
  });
  result = result.replace(/(?<!:)\bhref\s*=\s*["'][^"']*["']/i, () => {
    replacedAny = true;
    return `href="${newHref}"`;
  });

  if (!replacedAny) {
    // WHY: Element had no href at all — inject one before the closing
    // bracket so the renderer has something to resolve.
    if (result.endsWith('/>')) {
      result = `${result.slice(0, -2)} xlink:href="${newHref}"/>`;
    } else {
      result = `${result.slice(0, -1)} xlink:href="${newHref}">`;
    }
  }
  return result;
}

/**
 * Remove every <animate ... /> or <animate>...</animate> child from a
 * fragment. Used to drop PROSKENION's frame-swap animation after pinning.
 *
 * @param {string} fragment
 * @returns {string}
 */
function stripAnimateChildren(fragment) {
  // WHY: <animate> is always a leaf in valid SVG, so a non-greedy scan
  // covers both self-closing and paired forms without depth tracking.
  return fragment
    .replace(/<animate\b[^>]*\/>/gi, '')
    .replace(/<animate\b[^>]*?>[\s\S]*?<\/animate\s*>/gi, '');
}

module.exports = {
  describeFbf,
  isFbfSvg,
  pinFrame,
  formatFrameId,
  resolveFrameId,
  // exported for tests / advanced callers
  _internals: {
    findElementById,
    setHrefAttribute,
    stripAnimateChildren
  }
};
