/// <reference types="vitest/globals" />
/**
 * FBF.SVG helper test suite.
 *
 * Verifies detection, frame listing, and pin-and-render mutation for the
 * Frame-By-Frame SVG format produced by https://github.com/Emasoft/svg2fbf.
 *
 * The fixtures here are tiny hand-rolled SVGs that mirror the structural
 * contract documented in issue #3 — a real FBF rendered by svg2fbf will
 * have hundreds of frames and full SHARED_DEFINITIONS, but the helpers
 * only care about PROSKENION + FRAMEnnnnn ids, which these fixtures
 * exercise directly.
 */

// vitest exposes describe/it/expect as globals (see vitest.config.js -> globals: true).
const {
  describeFbf,
  isFbfSvg,
  pinFrame,
  formatFrameId,
  resolveFrameId,
  _internals
} = require('../../lib/fbf.cjs');

const { setHrefAttribute, stripAnimateChildren, findElementById } = _internals;

/**
 * Minimal valid FBF.SVG with three frames using 5-digit pad width.
 * @returns {string}
 */
function buildFbf5Digit() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100">
  <desc>FBF</desc>
  <g id="ANIMATION_BACKDROP">
    <g id="STAGE_BACKGROUND"><rect width="100" height="100" fill="#eee"/></g>
    <g id="ANIMATION_STAGE">
      <g id="ANIMATED_GROUP">
        <use id="PROSKENION" xlink:href="#FRAME00001" overflow="visible">
          <animate attributeName="xlink:href"
                   values="#FRAME00001;#FRAME00002;#FRAME00003"
                   begin="0s" calcMode="discrete" dur="3s"/>
        </use>
      </g>
    </g>
    <g id="STAGE_FOREGROUND"/>
  </g>
  <g id="OVERLAY_LAYER"/>
  <defs>
    <g id="SHARED_DEFINITIONS"><circle id="dot" r="1"/></g>
    <g id="FRAME00001"><rect x="10" y="10" width="20" height="20" fill="red"/></g>
    <g id="FRAME00002"><rect x="40" y="40" width="20" height="20" fill="green"/></g>
    <g id="FRAME00003"><rect x="70" y="70" width="20" height="20" fill="blue"/></g>
  </defs>
</svg>`;
}

/**
 * Minimal FBF using 4-digit ids (matches the alternative spelling shown
 * in the issue).
 * @returns {string}
 */
function buildFbf4Digit() {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">
  <use id="PROSKENION" xlink:href="#FRAME0001"><animate attributeName="xlink:href" values="#FRAME0001;#FRAME0002" calcMode="discrete" dur="2s"/></use>
  <defs>
    <g id="FRAME0001"><rect width="5" height="5"/></g>
    <g id="FRAME0002"><rect x="5" y="5" width="5" height="5"/></g>
  </defs>
</svg>`;
}

describe('lib/fbf.cjs — describeFbf', () => {
  it('detects a well-formed 5-digit FBF and lists frames in order', () => {
    /** Recognise standard svg2fbf output and enumerate every FRAMEnnnnn id. */
    const desc = describeFbf(buildFbf5Digit());
    expect(desc.isFbf).toBe(true);
    expect(desc.hasProskenion).toBe(true);
    expect(desc.frames).toHaveLength(3);
    expect(desc.frames.map((f) => f.number)).toEqual([1, 2, 3]);
    expect(desc.frames.map((f) => f.id)).toEqual(['FRAME00001', 'FRAME00002', 'FRAME00003']);
    expect(desc.padWidth).toBe(5);
    expect(desc.minFrame).toBe(1);
    expect(desc.maxFrame).toBe(3);
  });

  it('detects a 4-digit variant FBF and reports the matching pad width', () => {
    /** Tolerate the FRAME0001 pad shown in the issue example. */
    const desc = describeFbf(buildFbf4Digit());
    expect(desc.isFbf).toBe(true);
    expect(desc.padWidth).toBe(4);
    expect(desc.frames.map((f) => f.id)).toEqual(['FRAME0001', 'FRAME0002']);
  });

  it('returns isFbf=false when PROSKENION is missing even if FRAMExx ids exist', () => {
    /** Both signals are required — frames alone could be from any sprite sheet. */
    const svg = `<svg><defs><g id="FRAME00001"/></defs></svg>`;
    const desc = describeFbf(svg);
    expect(desc.isFbf).toBe(false);
    expect(desc.hasProskenion).toBe(false);
    expect(desc.frames).toHaveLength(1);
  });

  it('returns isFbf=false when PROSKENION exists but no FRAMExx defs do', () => {
    /** Likewise, a stray PROSKENION id without frames is not an FBF. */
    const svg = `<svg><use id="PROSKENION" xlink:href="#nope"/></svg>`;
    const desc = describeFbf(svg);
    expect(desc.isFbf).toBe(false);
    expect(desc.hasProskenion).toBe(true);
    expect(desc.frames).toHaveLength(0);
  });

  it('handles empty / non-string input without throwing', () => {
    /** Defensive: callers may pass undefined when reading a missing file. */
    expect(describeFbf(/** @type {any} */ (undefined)).isFbf).toBe(false);
    expect(describeFbf('').isFbf).toBe(false);
    expect(describeFbf('   ').isFbf).toBe(false);
  });

  it('deduplicates repeated frame ids across the document', () => {
    /** A frame id referenced from <use> AND defined in <defs> must count once. */
    const svg = `<svg>
      <use id="PROSKENION" xlink:href="#FRAME00002"/>
      <defs>
        <g id="FRAME00001"/><g id="FRAME00002"/><g id="FRAME00002"/>
      </defs>
    </svg>`;
    const desc = describeFbf(svg);
    expect(desc.frames.map((f) => f.id)).toEqual(['FRAME00001', 'FRAME00002']);
  });
});

describe('lib/fbf.cjs — isFbfSvg', () => {
  it('returns true for FBF and false otherwise', () => {
    /** Boolean wrapper over describeFbf for callers that only need yes/no. */
    expect(isFbfSvg(buildFbf5Digit())).toBe(true);
    expect(isFbfSvg('<svg/>')).toBe(false);
  });
});

describe('lib/fbf.cjs — formatFrameId', () => {
  it('formats numbers with the requested zero pad', () => {
    /** Common case: pad to 5 digits. */
    expect(formatFrameId(1, 5)).toBe('FRAME00001');
    expect(formatFrameId(42, 5)).toBe('FRAME00042');
    expect(formatFrameId(7, 4)).toBe('FRAME0007');
  });

  it('does not truncate numbers that already exceed the pad width', () => {
    /** Frame numbers wider than the pad width must round-trip intact. */
    expect(formatFrameId(123456, 4)).toBe('FRAME123456');
  });

  it('rejects non-positive or non-integer input', () => {
    /** Frames are 1-based positive integers per the FBF spec. */
    expect(() => formatFrameId(0, 5)).toThrow(/positive integer/);
    expect(() => formatFrameId(-1, 5)).toThrow(/positive integer/);
    expect(() => formatFrameId(1.5, 5)).toThrow(/positive integer/);
    expect(() => formatFrameId(1, 0)).toThrow(/Pad width/);
  });
});

describe('lib/fbf.cjs — resolveFrameId', () => {
  it('returns the actual id used in the file regardless of pad width', () => {
    /** Pin requests are by 1-based number; resolver returns the literal id present. */
    const desc = describeFbf(buildFbf4Digit());
    expect(resolveFrameId(desc, 1)).toBe('FRAME0001');
    expect(resolveFrameId(desc, 2)).toBe('FRAME0002');
  });

  it('returns null when the requested frame is missing', () => {
    /** Callers must distinguish "no such frame" from any other failure. */
    const desc = describeFbf(buildFbf5Digit());
    expect(resolveFrameId(desc, 999)).toBeNull();
  });
});

describe('lib/fbf.cjs — pinFrame', () => {
  it('rewrites xlink:href on PROSKENION and removes the <animate> child', () => {
    /** The core contract: pin a frame and strip the animation. */
    const result = pinFrame(buildFbf5Digit(), 2);
    expect(result.frameId).toBe('FRAME00002');
    expect(result.frameNumber).toBe(2);
    expect(result.totalFrames).toBe(3);
    expect(result.svg).toMatch(/<use[^>]*\bxlink:href="#FRAME00002"/);
    expect(result.svg).not.toMatch(/<animate\b/);
  });

  it('preserves other PROSKENION attributes (id, overflow) verbatim', () => {
    /** Only href changes — siblings on the same tag must survive untouched. */
    const result = pinFrame(buildFbf5Digit(), 3);
    expect(result.svg).toMatch(/<use[^>]*\bid="PROSKENION"/);
    expect(result.svg).toMatch(/<use[^>]*\boverflow="visible"/);
  });

  it('preserves all FRAMExxxxx defs and other layers', () => {
    /** Pinning must not mutate STAGE_FOREGROUND, OVERLAY_LAYER, or any defs. */
    const result = pinFrame(buildFbf5Digit(), 1);
    expect(result.svg).toContain('id="STAGE_FOREGROUND"');
    expect(result.svg).toContain('id="OVERLAY_LAYER"');
    expect(result.svg).toContain('id="SHARED_DEFINITIONS"');
    expect(result.svg).toContain('id="FRAME00001"');
    expect(result.svg).toContain('id="FRAME00002"');
    expect(result.svg).toContain('id="FRAME00003"');
  });

  it('handles 4-digit frame ids the same way', () => {
    /** Confirms the regex tolerance described in describeFbf. */
    const result = pinFrame(buildFbf4Digit(), 2);
    expect(result.frameId).toBe('FRAME0002');
    expect(result.svg).toMatch(/<use[^>]*\bxlink:href="#FRAME0002"/);
    expect(result.svg).not.toMatch(/<animate\b/);
  });

  it('throws a clear error when input is not FBF (no PROSKENION)', () => {
    /** Caller-facing error must spell out the missing element. */
    expect(() => pinFrame('<svg/>', 1)).toThrow(/PROSKENION/);
  });

  it('throws a clear error when input has PROSKENION but no FRAMExx defs', () => {
    /** Caller-facing error must spell out the missing defs. */
    const svg = `<svg><use id="PROSKENION"/></svg>`;
    expect(() => pinFrame(svg, 1)).toThrow(/FRAMEnnnnn/);
  });

  it('throws listing the available range when frame is out of bounds', () => {
    /** Help the user pick a valid frame instead of guessing. */
    expect(() => pinFrame(buildFbf5Digit(), 10)).toThrow(/Available frames: 1\.\.3 \(3 frames\)/);
  });

  it('handles an FBF that uses plain href= instead of xlink:href=', () => {
    /** SVG2 plain href is valid; the helper must rewrite it too. */
    const svg = `<svg>
      <use id="PROSKENION" href="#FRAME00001"><animate attributeName="href" values="#FRAME00001;#FRAME00002"/></use>
      <defs><g id="FRAME00001"/><g id="FRAME00002"/></defs>
    </svg>`;
    const result = pinFrame(svg, 2);
    expect(result.svg).toMatch(/<use[^>]*\bhref="#FRAME00002"/);
    expect(result.svg).not.toMatch(/<animate\b/);
  });

  it('handles a self-closing PROSKENION (degenerate FBF, no animate)', () => {
    /** Some generators may emit <use .../> directly. Pin must still rewrite href. */
    const svg = `<svg>
      <use id="PROSKENION" xlink:href="#FRAME00001"/>
      <defs><g id="FRAME00001"/><g id="FRAME00002"/></defs>
    </svg>`;
    const result = pinFrame(svg, 2);
    expect(result.svg).toMatch(/<use[^>]*\bxlink:href="#FRAME00002"[^>]*\/>/);
  });
});

describe('lib/fbf.cjs — internal helpers', () => {
  it('findElementById locates a paired element with same-name nesting', () => {
    /** Brace-matching path: the inner <use> must not fool the depth counter. */
    const svg = `<svg><use id="PROSKENION" xlink:href="#a"><use id="inner"/></use></svg>`;
    const found = findElementById(svg, 'use', 'PROSKENION');
    expect(found).not.toBeNull();
    expect(svg.slice(found.openStart, found.closeEnd)).toContain('id="inner"');
  });

  it('findElementById detects self-closing forms', () => {
    /** Self-closing element should have closeStart == openEnd. */
    const svg = `<svg><use id="X"/></svg>`;
    const found = findElementById(svg, 'use', 'X');
    expect(found).not.toBeNull();
    expect(found.selfClosing).toBe(true);
    expect(found.openEnd).toBe(found.closeStart);
  });

  it('setHrefAttribute updates xlink:href and href independently', () => {
    /** Both attributes must end up pointing at the new target after pinning. */
    expect(setHrefAttribute('<use xlink:href="#a">', '#b')).toBe('<use xlink:href="#b">');
    expect(setHrefAttribute('<use href="#a">', '#b')).toBe('<use href="#b">');
    const both = setHrefAttribute('<use xlink:href="#a" href="#a">', '#b');
    expect(both).toMatch(/xlink:href="#b"/);
    expect(both).toMatch(/(?<!:)href="#b"/);
  });

  it('setHrefAttribute injects xlink:href when absent on a paired tag', () => {
    /** Defensive: an FBF with PROSKENION but no href should still pin cleanly. */
    expect(setHrefAttribute('<use id="PROSKENION">', '#FRAME00001')).toBe(
      '<use id="PROSKENION" xlink:href="#FRAME00001">'
    );
  });

  it('setHrefAttribute injects xlink:href when absent on a self-closing tag', () => {
    /** Same as above but for the self-closing form. */
    expect(setHrefAttribute('<use id="PROSKENION"/>', '#FRAME00001')).toBe(
      '<use id="PROSKENION" xlink:href="#FRAME00001"/>'
    );
  });

  it('stripAnimateChildren removes self-closing and paired animate elements', () => {
    /** Both forms appear in the wild; both must go after pinning. */
    expect(stripAnimateChildren('<animate attributeName="x"/>')).toBe('');
    expect(stripAnimateChildren('<animate attributeName="x">stuff</animate>')).toBe('');
    expect(stripAnimateChildren('keep<animate/>this')).toBe('keepthis');
  });

  it('stripAnimateChildren leaves non-animate elements alone', () => {
    /** Sibling elements inside <use> must not be collateral damage. */
    expect(stripAnimateChildren('<set attributeName="x"/><animate/>')).toBe(
      '<set attributeName="x"/>'
    );
  });
});
