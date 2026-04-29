/**
 * @file Integration tests for sbb-svg2png --fbf-frame option (issue #3)
 * @description Verifies that --fbf-frame N pins PROSKENION to the requested
 * frame and renders that frame's content (not whatever frame the SMIL
 * timeline lands on). Each fixture frame paints the full viewBox a
 * distinct color, so a sampled center pixel proves which frame the
 * renderer actually rasterised.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { PNG } from 'pngjs';
import { CLI_TIMEOUT_MS } from '../../config/timeouts.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

// Same buffer factor used by sbb-svg2png.test.js — CLI tools spawn a real
// browser, which adds non-trivial overhead on top of the configured
// per-test timeout.
const CLI_EXEC_TIMEOUT = CLI_TIMEOUT_MS * 2;

const FIXTURE_PATH = path.join(projectRoot, 'tests/fixtures/fbf-three-frames.fbf.svg');

/**
 * Fixture frame colors. Must stay in sync with the rect fills in
 * tests/fixtures/fbf-three-frames.fbf.svg — if the fixture changes,
 * update these and the test will catch the drift.
 */
const FRAME_COLORS = {
  1: { r: 220, g: 30, b: 30 },
  2: { r: 30, g: 180, b: 30 },
  3: { r: 30, g: 60, b: 220 }
};

/**
 * Read a PNG file and return the parsed pngjs image object.
 * @param {string} pngPath
 */
async function parsePng(pngPath) {
  const buffer = await fs.readFile(pngPath);
  return new Promise((resolve, reject) => {
    const png = new PNG();
    png.parse(buffer, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

/**
 * Sample the pixel at the geometric center of the PNG.
 * Center is far enough from any edge to dodge anti-aliasing on the
 * frame's full-viewBox rectangle.
 * @param {{ width: number, height: number, data: Buffer | Uint8Array }} png
 */
function getCenterColor(png) {
  const cx = Math.floor(png.width / 2);
  const cy = Math.floor(png.height / 2);
  const offset = (cy * png.width + cx) * 4;
  return {
    r: png.data[offset],
    g: png.data[offset + 1],
    b: png.data[offset + 2],
    a: png.data[offset + 3]
  };
}

/**
 * Assert two RGB colors are within `tolerance` per channel.
 * Headless Chrome rasterisation can shift each channel by a few units
 * compared to the source RGB; a small slack keeps the test stable
 * across machines without weakening the "right frame was picked" check.
 * @param {{ r: number, g: number, b: number }} actual
 * @param {{ r: number, g: number, b: number }} expected
 * @param {number} [tolerance]
 */
function expectColorsClose(actual, expected, tolerance = 8) {
  for (const ch of /** @type {const} */ (['r', 'g', 'b'])) {
    const diff = Math.abs(actual[ch] - expected[ch]);
    if (diff > tolerance) {
      // WHY: Build a clear failure message ourselves; vitest/valid-expect
      // disallows the second arg form expect(v, "msg") in this version.
      throw new Error(
        `Color channel ${ch} out of tolerance ${tolerance}: ` +
          `actual=${actual[ch]} expected=${expected[ch]} (diff=${diff})`
      );
    }
    expect(diff).toBeLessThanOrEqual(tolerance);
  }
}

describe('sbb-svg2png --fbf-frame integration', () => {
  /** @type {string} */
  let tempDir;

  beforeEach(async () => {
    tempDir = path.join(projectRoot, `temp_sbb_svg2png_fbf_${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('renders frame 1 and the center pixel matches FRAME00001 (red)', async () => {
    /** First frame proves the default-pin path works (no off-by-one). */
    const out = path.join(tempDir, 'frame1.png');
    await execFileAsync(
      'node',
      [
        'sbb-svg2png.cjs',
        FIXTURE_PATH,
        out,
        '--fbf-frame',
        '1',
        '--allow-paths',
        path.dirname(FIXTURE_PATH) + ',' + tempDir
      ],
      { cwd: projectRoot, timeout: CLI_EXEC_TIMEOUT }
    );
    const png = await parsePng(out);
    expect(png.width).toBeGreaterThan(0);
    expect(png.height).toBeGreaterThan(0);
    expectColorsClose(getCenterColor(png), FRAME_COLORS[1]);
  });

  it('renders frame 2 and the center pixel matches FRAME00002 (green)', async () => {
    /** Middle frame proves the pin actually swaps PROSKENION's href. */
    const out = path.join(tempDir, 'frame2.png');
    await execFileAsync(
      'node',
      [
        'sbb-svg2png.cjs',
        FIXTURE_PATH,
        out,
        '--fbf-frame',
        '2',
        '--allow-paths',
        path.dirname(FIXTURE_PATH) + ',' + tempDir
      ],
      { cwd: projectRoot, timeout: CLI_EXEC_TIMEOUT }
    );
    const png = await parsePng(out);
    expect(png.width).toBeGreaterThan(0);
    expectColorsClose(getCenterColor(png), FRAME_COLORS[2]);
  });

  it('renders frame 3 and the center pixel matches FRAME00003 (blue)', async () => {
    /** Last frame proves end-of-range pinning works (no off-by-one on the high end). */
    const out = path.join(tempDir, 'frame3.png');
    await execFileAsync(
      'node',
      [
        'sbb-svg2png.cjs',
        FIXTURE_PATH,
        out,
        '--fbf-frame',
        '3',
        '--allow-paths',
        path.dirname(FIXTURE_PATH) + ',' + tempDir
      ],
      { cwd: projectRoot, timeout: CLI_EXEC_TIMEOUT }
    );
    const png = await parsePng(out);
    expect(png.width).toBeGreaterThan(0);
    expectColorsClose(getCenterColor(png), FRAME_COLORS[3]);
  });

  it('honours --scale together with --fbf-frame', async () => {
    /** Pinning must not break the rest of the rendering pipeline. */
    const out = path.join(tempDir, 'frame2-scale2.png');
    await execFileAsync(
      'node',
      [
        'sbb-svg2png.cjs',
        FIXTURE_PATH,
        out,
        '--fbf-frame',
        '2',
        '--scale',
        '2',
        '--allow-paths',
        path.dirname(FIXTURE_PATH) + ',' + tempDir
      ],
      { cwd: projectRoot, timeout: CLI_EXEC_TIMEOUT }
    );
    const png = await parsePng(out);
    // Fixture is 100x100 viewBox, --scale 2 → 200x200 PNG
    expect(png.width).toBe(200);
    expect(png.height).toBe(200);
    expectColorsClose(getCenterColor(png), FRAME_COLORS[2]);
  });

  it('fails clearly when input is not an FBF.SVG', async () => {
    /** Non-FBF input must produce an actionable error, not a silent miss. */
    const notFbf = path.join(tempDir, 'plain.svg');
    const out = path.join(tempDir, 'plain.png');
    await fs.writeFile(
      notFbf,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></svg>`,
      'utf8'
    );
    await expect(
      execFileAsync('node', ['sbb-svg2png.cjs', notFbf, out, '--fbf-frame', '1'], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      })
    ).rejects.toThrow(/FBF\.SVG|PROSKENION/);
  });

  it('fails clearly when the requested frame is out of range', async () => {
    /** Out-of-range request must list the actual range, not crash deep in render. */
    const out = path.join(tempDir, 'frame999.png');
    await expect(
      execFileAsync(
        'node',
        [
          'sbb-svg2png.cjs',
          FIXTURE_PATH,
          out,
          '--fbf-frame',
          '999',
          '--allow-paths',
          path.dirname(FIXTURE_PATH) + ',' + tempDir
        ],
        { cwd: projectRoot, timeout: CLI_EXEC_TIMEOUT }
      )
    ).rejects.toThrow(/Frame 999 not found|Available frames/);
  });

  it('rejects --fbf-frame 0 at the parser', async () => {
    /** Frame numbers are 1-based; 0 must be caught before any rendering. */
    const out = path.join(tempDir, 'zero.png');
    await expect(
      execFileAsync('node', ['sbb-svg2png.cjs', FIXTURE_PATH, out, '--fbf-frame', '0'], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      })
    ).rejects.toThrow(/positive integer/);
  });

  it('rejects --fbf-frame with a non-numeric argument', async () => {
    /** Garbage values must be rejected immediately, not parsed as NaN. */
    const out = path.join(tempDir, 'nan.png');
    await expect(
      execFileAsync('node', ['sbb-svg2png.cjs', FIXTURE_PATH, out, '--fbf-frame', 'abc'], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      })
    ).rejects.toThrow(/positive integer/);
  });

  // ===========================================================================
  // Multi-frame requests — list and range syntax (extends the single-frame API)
  // ===========================================================================

  it('renders multiple frames from a comma list with auto-derived output paths', async () => {
    /** "out.png + 1,3" must produce out-FRAME00001.png and out-FRAME00003.png. */
    const out = path.join(tempDir, 'multi.png');
    await execFileAsync(
      'node',
      [
        'sbb-svg2png.cjs',
        FIXTURE_PATH,
        out,
        '--fbf-frame',
        '1,3',
        '--allow-paths',
        path.dirname(FIXTURE_PATH) + ',' + tempDir
      ],
      { cwd: projectRoot, timeout: CLI_EXEC_TIMEOUT * 2 }
    );

    // Original output path must NOT exist — multi-frame mode replaces it
    // with per-frame paths so users don't accidentally end up with a
    // frame collision under the unmodified name.
    await expect(fs.stat(out)).rejects.toThrow();

    const f1 = path.join(tempDir, 'multi-FRAME00001.png');
    const f3 = path.join(tempDir, 'multi-FRAME00003.png');
    const png1 = await parsePng(f1);
    const png3 = await parsePng(f3);
    expect(png1.width).toBeGreaterThan(0);
    expect(png3.width).toBeGreaterThan(0);
    expectColorsClose(getCenterColor(png1), FRAME_COLORS[1]);
    expectColorsClose(getCenterColor(png3), FRAME_COLORS[3]);
  });

  it('renders an inclusive range "1-3" and produces three per-frame files', async () => {
    /** Range syntax must expand to a contiguous frame list. */
    const out = path.join(tempDir, 'range.png');
    await execFileAsync(
      'node',
      [
        'sbb-svg2png.cjs',
        FIXTURE_PATH,
        out,
        '--fbf-frame',
        '1-3',
        '--allow-paths',
        path.dirname(FIXTURE_PATH) + ',' + tempDir
      ],
      { cwd: projectRoot, timeout: CLI_EXEC_TIMEOUT * 2 }
    );
    const r1 = await parsePng(path.join(tempDir, 'range-FRAME00001.png'));
    const r2 = await parsePng(path.join(tempDir, 'range-FRAME00002.png'));
    const r3 = await parsePng(path.join(tempDir, 'range-FRAME00003.png'));
    expect(r1.width).toBeGreaterThan(0);
    expect(r2.width).toBeGreaterThan(0);
    expect(r3.width).toBeGreaterThan(0);
    expectColorsClose(getCenterColor(r1), FRAME_COLORS[1]);
    expectColorsClose(getCenterColor(r2), FRAME_COLORS[2]);
    expectColorsClose(getCenterColor(r3), FRAME_COLORS[3]);
  });

  it('honours the {frame} placeholder in the output path', async () => {
    /** Power-user form: explicit substitution token in the output path. */
    const out = path.join(tempDir, 'tag-{frame}.png');
    await execFileAsync(
      'node',
      [
        'sbb-svg2png.cjs',
        FIXTURE_PATH,
        out,
        '--fbf-frame',
        '2',
        '--allow-paths',
        path.dirname(FIXTURE_PATH) + ',' + tempDir
      ],
      { cwd: projectRoot, timeout: CLI_EXEC_TIMEOUT }
    );
    const written = path.join(tempDir, 'tag-FRAME00002.png');
    const png = await parsePng(written);
    expect(png.width).toBeGreaterThan(0);
    expectColorsClose(getCenterColor(png), FRAME_COLORS[2]);
  });

  it('honours the {n} placeholder for the bare frame number', async () => {
    /** Lighter-weight substitution form — useful for "frame-7.png" style names. */
    const out = path.join(tempDir, 'bare-{n}.png');
    await execFileAsync(
      'node',
      [
        'sbb-svg2png.cjs',
        FIXTURE_PATH,
        out,
        '--fbf-frame',
        '3',
        '--allow-paths',
        path.dirname(FIXTURE_PATH) + ',' + tempDir
      ],
      { cwd: projectRoot, timeout: CLI_EXEC_TIMEOUT }
    );
    const written = path.join(tempDir, 'bare-3.png');
    const png = await parsePng(written);
    expect(png.width).toBeGreaterThan(0);
    expectColorsClose(getCenterColor(png), FRAME_COLORS[3]);
  });

  it('deduplicates repeated frame numbers in the list', async () => {
    /** "2,2,2" must render frame 2 exactly once — no duplicate file writes. */
    const out = path.join(tempDir, 'dedup.png');
    await execFileAsync(
      'node',
      [
        'sbb-svg2png.cjs',
        FIXTURE_PATH,
        out,
        '--fbf-frame',
        '2,2,2',
        '--allow-paths',
        path.dirname(FIXTURE_PATH) + ',' + tempDir
      ],
      { cwd: projectRoot, timeout: CLI_EXEC_TIMEOUT }
    );
    // With one unique frame, the auto-derive path is NOT triggered
    // (frames.length === 1) and the output path is used verbatim.
    const png = await parsePng(out);
    expect(png.width).toBeGreaterThan(0);
    expectColorsClose(getCenterColor(png), FRAME_COLORS[2]);
  });

  it('rejects an inverted range "5-2"', async () => {
    /** Catch obvious user typos at parse time, not after burning a browser. */
    const out = path.join(tempDir, 'bad-range.png');
    await expect(
      execFileAsync('node', ['sbb-svg2png.cjs', FIXTURE_PATH, out, '--fbf-frame', '5-2'], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      })
    ).rejects.toThrow(/low.*>.*high|invalid range/);
  });

  it('rejects an empty fragment in the list "1,,3"', async () => {
    /** Malformed lists must fail at the parser, not silently dropped. */
    const out = path.join(tempDir, 'empty-frag.png');
    await expect(
      execFileAsync('node', ['sbb-svg2png.cjs', FIXTURE_PATH, out, '--fbf-frame', '1,,3'], {
        cwd: projectRoot,
        timeout: CLI_EXEC_TIMEOUT
      })
    ).rejects.toThrow(/empty fragment/);
  });

  it('rejects multi-frame requests when one of the frames is out of range', async () => {
    /** All frames are validated before any rendering — fail-fast. */
    const out = path.join(tempDir, 'partial.png');
    await expect(
      execFileAsync(
        'node',
        [
          'sbb-svg2png.cjs',
          FIXTURE_PATH,
          out,
          '--fbf-frame',
          '1,2,99',
          '--allow-paths',
          path.dirname(FIXTURE_PATH) + ',' + tempDir
        ],
        { cwd: projectRoot, timeout: CLI_EXEC_TIMEOUT * 2 }
      )
    ).rejects.toThrow(/Frame 99 not found|Available frames/);
  });
});
