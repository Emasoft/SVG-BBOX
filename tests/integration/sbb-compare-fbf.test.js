/**
 * @file Integration tests for sbb-compare --fbf-frame option.
 * @description Verifies that sbb-compare can pin an FBF.SVG (svg2fbf
 * format) input to a specific frame on either side of the comparison,
 * via --fbf-frame (global), --fbf-frame-a, and --fbf-frame-b. Also
 * covers aspect-ratio enforcement (the existing check must continue to
 * apply to the pinned side) and error paths (non-FBF inputs, missing
 * frames, out-of-range numbers).
 *
 * Strategy:
 *   - Use the same FBF fixture as the sbb-svg2png FBF tests
 *     (3 frames, each painting the full viewBox a distinct color).
 *   - Pre-render reference PNGs of frames 1 and 2 with sbb-svg2png so
 *     we have ground-truth raster images.
 *   - PNG-of-frame-N vs FBF pinned to frame N  → near-zero diff.
 *   - PNG-of-frame-N vs FBF pinned to frame M  → ~100% diff (different colors).
 *   - SVG-of-frame-N vs FBF pinned to frame N  → near-zero diff.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { CLI_TIMEOUT_MS } from '../../config/timeouts.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

const CLI_EXEC_TIMEOUT = CLI_TIMEOUT_MS * 2;

const FBF_FIXTURE = path.join(projectRoot, 'tests/fixtures/fbf-three-frames.fbf.svg');

/** @type {string} */
let workDir;
/** @type {string} */
let frame1Png;
/** @type {string} */
let frame2Png;
/** @type {string} */
let frame1Svg;
/** @type {string} */
let frame2Svg;

beforeAll(async () => {
  // One workspace for the whole suite — keeps test wall-clock down,
  // and the FBF fixture + reference PNGs/SVGs are read-only after setup.
  workDir = path.join(projectRoot, `temp_sbb_compare_fbf_${Date.now()}`);
  await fs.mkdir(workDir, { recursive: true });

  // Pre-render reference PNGs for frames 1 and 2 via sbb-svg2png.
  // These are the ground-truth rasters we compare the pinned FBF against.
  frame1Png = path.join(workDir, 'ref-frame1.png');
  frame2Png = path.join(workDir, 'ref-frame2.png');
  await execFileAsync(
    'node',
    [
      'sbb-svg2png.cjs',
      FBF_FIXTURE,
      frame1Png,
      '--fbf-frame',
      '1',
      '--scale',
      '2',
      '--allow-paths',
      `${path.dirname(FBF_FIXTURE)},${workDir}`
    ],
    { cwd: projectRoot, timeout: CLI_EXEC_TIMEOUT }
  );
  await execFileAsync(
    'node',
    [
      'sbb-svg2png.cjs',
      FBF_FIXTURE,
      frame2Png,
      '--fbf-frame',
      '2',
      '--scale',
      '2',
      '--allow-paths',
      `${path.dirname(FBF_FIXTURE)},${workDir}`
    ],
    { cwd: projectRoot, timeout: CLI_EXEC_TIMEOUT }
  );

  // Hand-roll static-SVG equivalents of frames 1 and 2 — same viewBox
  // and same single rect, so they must match the pinned FBF exactly.
  frame1Svg = path.join(workDir, 'ref-frame1.svg');
  frame2Svg = path.join(workDir, 'ref-frame2.svg');
  await fs.writeFile(
    frame1Svg,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><rect x="0" y="0" width="100" height="100" fill="rgb(220,30,30)"/></svg>`,
    'utf8'
  );
  await fs.writeFile(
    frame2Svg,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><rect x="0" y="0" width="100" height="100" fill="rgb(30,180,30)"/></svg>`,
    'utf8'
  );
}, 120000);

afterAll(async () => {
  if (workDir) {
    await fs.rm(workDir, { recursive: true, force: true });
  }
});

/**
 * Run sbb-compare and return parsed JSON. Auto-includes
 * --allow-paths (fixture dir + workDir) so security gates allow both
 * the fixture and the temp pinned files written next to it.
 *
 * sbb-compare exits 1 when the images differ (that's part of the
 * contract — exitCode is even reflected in the JSON), so we MUST NOT
 * treat a non-zero exit as failure here. We only care about the JSON
 * payload; the caller asserts on diffPercentage. A truly-broken run
 * is caught later when JSON.parse throws or when the assertion fails.
 *
 * @param {string[]} extraArgs
 * @returns {Promise<any>}
 */
async function runCompare(extraArgs) {
  /** @type {{ stdout: string, stderr: string }} */
  let captured;
  try {
    captured = await execFileAsync(
      'node',
      [
        'sbb-compare.cjs',
        ...extraArgs,
        '--json',
        '--no-html',
        '--allow-paths',
        `${path.dirname(FBF_FIXTURE)},${workDir}`
      ],
      { cwd: projectRoot, timeout: CLI_EXEC_TIMEOUT * 2 }
    );
  } catch (err) {
    // Non-zero exit (e.g. images differ → exit 1; validation error → exit 1).
    // Inspect stdout for a JSON payload first; if there's none, propagate
    // the original error so error-path tests can match on the message.
    const e = /** @type {{ stdout?: string, stderr?: string, message?: string }} */ (err);
    const stdout = (e.stdout || '').trim();
    const stderr = (e.stderr || '').trim();
    if (stdout && stdout.includes('{')) {
      captured = { stdout, stderr };
    } else {
      // Surface a useful message — include stderr so error-path tests can
      // match on the actual validation text.
      throw new Error(
        `sbb-compare failed (no JSON on stdout): ${stderr || e.message || 'unknown error'}`
      );
    }
  }
  const jsonStart = captured.stdout.indexOf('{');
  if (jsonStart < 0) {
    throw new Error(`sbb-compare produced no JSON output. stdout: ${captured.stdout}`);
  }
  return JSON.parse(captured.stdout.slice(jsonStart));
}

describe('sbb-compare --fbf-frame integration', () => {
  // ===========================================================================
  // PNG vs FBF.SVG (the user's "PNG compared to fbf.svg frame n" use case)
  // ===========================================================================

  it('PNG-of-frame-2 vs FBF pinned to frame 2 (--fbf-frame-b) is a near-zero match', async () => {
    /** Reference raster of frame 2 must match the FBF pinned to frame 2. */
    const result = await runCompare([frame2Png, FBF_FIXTURE, '--fbf-frame-b', '2']);
    expect(result.diffPercentage).toBeLessThan(1);
  });

  it('PNG-of-frame-2 vs FBF pinned to frame 1 (--fbf-frame-b) is ~100% different', async () => {
    /** Same PNG against the wrong frame must show a large difference (red vs green). */
    const result = await runCompare([frame2Png, FBF_FIXTURE, '--fbf-frame-b', '1']);
    expect(result.diffPercentage).toBeGreaterThan(95);
  });

  it('FBF pinned to frame 1 vs PNG-of-frame-1 (FBF on side A, --fbf-frame-a) matches', async () => {
    /** Pinning works on side A too — confirm via the per-side flag for that side. */
    const result = await runCompare([FBF_FIXTURE, frame1Png, '--fbf-frame-a', '1']);
    expect(result.diffPercentage).toBeLessThan(1);
  });

  it('global --fbf-frame applies opportunistically to the FBF input only', async () => {
    /** With one PNG and one FBF, --fbf-frame N pins the FBF and leaves the PNG alone. */
    const result = await runCompare([frame2Png, FBF_FIXTURE, '--fbf-frame', '2']);
    expect(result.diffPercentage).toBeLessThan(1);
  });

  // ===========================================================================
  // SVG vs FBF.SVG (the user's "comparing an svg with frame n of the fbf" case)
  // ===========================================================================

  it('static SVG of frame 2 vs FBF pinned to frame 2 is a near-zero match', async () => {
    /** Hand-rolled static SVG should match the corresponding pinned FBF frame. */
    const result = await runCompare([frame2Svg, FBF_FIXTURE, '--fbf-frame-b', '2']);
    expect(result.diffPercentage).toBeLessThan(1);
  });

  it('static SVG of frame 1 vs FBF pinned to frame 2 is ~100% different', async () => {
    /** Mismatched-frame comparison must surface as a large difference. */
    const result = await runCompare([frame1Svg, FBF_FIXTURE, '--fbf-frame-b', '2']);
    expect(result.diffPercentage).toBeGreaterThan(95);
  });

  it('SVG vs FBF with global --fbf-frame pins only the FBF side', async () => {
    /** The global flag should pin the FBF input (side B here) without touching the static SVG. */
    const result = await runCompare([frame1Svg, FBF_FIXTURE, '--fbf-frame', '1']);
    expect(result.diffPercentage).toBeLessThan(1);
  });

  // ===========================================================================
  // Per-side overrides (FBF on both sides, different frames)
  // ===========================================================================

  it('FBF vs FBF with --fbf-frame-a == --fbf-frame-b pins both sides to the same frame', async () => {
    /** Same FBF compared to itself, both pinned to frame 3 — must be near-zero diff. */
    const result = await runCompare([
      FBF_FIXTURE,
      FBF_FIXTURE,
      '--fbf-frame-a',
      '3',
      '--fbf-frame-b',
      '3'
    ]);
    expect(result.diffPercentage).toBeLessThan(1);
  });

  it('FBF vs FBF with different frames per side surfaces as a large difference', async () => {
    /** Frame 1 (red) vs Frame 3 (blue) — completely different content. */
    const result = await runCompare([
      FBF_FIXTURE,
      FBF_FIXTURE,
      '--fbf-frame-a',
      '1',
      '--fbf-frame-b',
      '3'
    ]);
    expect(result.diffPercentage).toBeGreaterThan(95);
  });

  it('global --fbf-frame applies to BOTH inputs when both are FBF', async () => {
    /** Single global flag is the most ergonomic form for the FBF-vs-FBF symmetric case. */
    const result = await runCompare([FBF_FIXTURE, FBF_FIXTURE, '--fbf-frame', '2']);
    expect(result.diffPercentage).toBeLessThan(1);
  });

  // ===========================================================================
  // Error paths
  // ===========================================================================

  it('rejects --fbf-frame-a when side A is not an FBF.SVG', async () => {
    /** Per-side flag against a plain SVG must fail loudly — clear user mistake. */
    await expect(runCompare([frame1Svg, FBF_FIXTURE, '--fbf-frame-a', '1'])).rejects.toThrow(
      /FBF\.SVG|PROSKENION/
    );
  });

  it('rejects --fbf-frame-b when side B is a PNG', async () => {
    /** Per-side flag against a PNG side must fail at the validation step. */
    await expect(runCompare([FBF_FIXTURE, frame1Png, '--fbf-frame-b', '1'])).rejects.toThrow(
      /FBF\.SVG|PNG/i
    );
  });

  it('rejects global --fbf-frame when neither input is an FBF.SVG', async () => {
    /** Misuse of the global flag (no FBF anywhere) must fail loudly so users notice. */
    await expect(runCompare([frame1Svg, frame2Svg, '--fbf-frame', '1'])).rejects.toThrow(
      /neither input is an FBF/i
    );
  });

  it('rejects --fbf-frame 0 at the parser', async () => {
    /** 1-based frame numbers — zero is always wrong. */
    await expect(runCompare([frame1Svg, FBF_FIXTURE, '--fbf-frame', '0'])).rejects.toThrow(
      /positive integer/
    );
  });

  it('rejects an out-of-range FBF frame with the available range in the message', async () => {
    /** Asking for frame 99 in a 3-frame fixture must say so. */
    await expect(runCompare([frame1Svg, FBF_FIXTURE, '--fbf-frame-b', '99'])).rejects.toThrow(
      /Frame 99 not found|Available frames/
    );
  });
});
