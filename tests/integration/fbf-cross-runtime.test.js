/**
 * FBF.SVG cross-runtime regression test
 *
 * The `extractFbfFrame()` helper exists in three places:
 *   1. `lib/fbf.cjs` — single source of truth used by every CLI tool and
 *      by the Node CJS shim (`SvgVisualBBox.cjs`)
 *   2. `SvgVisualBBox.js` — inlined into the UMD because the browser
 *      bundle cannot `require()`
 *   3. `SvgVisualBBox.cjs` — Node shim that re-exports from `lib/fbf.cjs`
 *
 * #1 and #3 are the *same* implementation (one re-exports the other), so
 * they cannot drift. #2 is a hand-maintained copy that lives inside the
 * UMD factory closure. This test pins the same fixture through all three
 * paths and asserts byte-equal output, so any drift between #1/#3 and #2
 * fails CI loudly.
 *
 * Also verifies the package's `exports` map: both `require('svg-bbox')`
 * (CJS) and `import 'svg-bbox'` (ESM) must resolve to a working
 * `extractFbfFrame()` in plain Node — this previously crashed because the
 * `import` condition pointed at the UMD source which crashes in Node ESM.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const puppeteer = require('puppeteer');

const execFilePromise = promisify(execFile);

const REPO_ROOT = path.resolve(__dirname, '../..');
const FBF_FIXTURE = path.join(REPO_ROOT, 'tests/fixtures/fbf-three-frames.fbf.svg');
const LIB_FBF = path.join(REPO_ROOT, 'lib/fbf.cjs');
const NODE_SHIM = path.join(REPO_ROOT, 'SvgVisualBBox.cjs');
const UMD_SOURCE = path.join(REPO_ROOT, 'SvgVisualBBox.js');

describe('FBF.SVG cross-runtime parity', () => {
  /** @type {string} */
  let fixtureContent;

  beforeAll(() => {
    fixtureContent = fs.readFileSync(FBF_FIXTURE, 'utf8');
  });

  describe('Single source of truth — Node CJS', () => {
    test('lib/fbf.cjs and SvgVisualBBox.cjs return byte-equal output', () => {
      const fromLibFbf = require(LIB_FBF).extractFbfFrame(fixtureContent, 2);
      const fromShim = require(NODE_SHIM).extractFbfFrame(fixtureContent, 2);

      assert.strictEqual(fromLibFbf.svg, fromShim.svg, 'pinned SVG must match byte-for-byte');
      assert.strictEqual(fromLibFbf.frameId, fromShim.frameId);
      assert.strictEqual(fromLibFbf.frameNumber, fromShim.frameNumber);
      assert.strictEqual(fromLibFbf.totalFrames, fromShim.totalFrames);
    });

    test('the shim does not introduce any new function — keys are a superset of lib/fbf.cjs FBF helpers', () => {
      const libKeys = new Set(Object.keys(require(LIB_FBF)));
      const shimKeys = new Set(Object.keys(require(NODE_SHIM)));
      // The shim re-exports the FBF helpers and adds DOM-bound stubs;
      // it intentionally drops `_internals` (which is a tests-only
      // export) but every other FBF function must be present.
      for (const k of [
        'extractFbfFrame',
        'describeFbf',
        'isFbfSvg',
        'pinFrame',
        'formatFrameId',
        'resolveFrameId'
      ]) {
        assert.ok(libKeys.has(k), `lib/fbf.cjs must export ${k}`);
        assert.ok(shimKeys.has(k), `SvgVisualBBox.cjs must re-export ${k}`);
      }
    });
  });

  describe('UMD inlined copy parity (SvgVisualBBox.js in real browser)', () => {
    /** @type {import('puppeteer').Browser | null} */
    let browser = null;

    beforeAll(async () => {
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
    }, 30000);

    afterAll(async () => {
      if (browser) await browser.close();
    });

    test('UMD extractFbfFrame returns byte-equal output to lib/fbf.cjs', async () => {
      assert.ok(browser, 'browser must be launched');
      const page = await browser.newPage();
      try {
        await page.setContent('<!DOCTYPE html><html><body></body></html>');
        await page.addScriptTag({ path: UMD_SOURCE });
        const fromUmd = await page.evaluate((markup) => {
          const lib = /** @type {any} */ (window).SvgVisualBBox;
          return lib.extractFbfFrame(markup, 2);
        }, fixtureContent);
        const fromLibFbf = require(LIB_FBF).extractFbfFrame(fixtureContent, 2);

        assert.strictEqual(
          fromUmd.svg,
          fromLibFbf.svg,
          'UMD and lib/fbf.cjs must produce byte-equal pinned SVG'
        );
        assert.strictEqual(fromUmd.frameId, fromLibFbf.frameId);
        assert.strictEqual(fromUmd.frameNumber, fromLibFbf.frameNumber);
        assert.strictEqual(fromUmd.totalFrames, fromLibFbf.totalFrames);
      } finally {
        await page.close();
      }
    }, 60000);

    test('UMD describeFbf agrees with lib/fbf.cjs', async () => {
      assert.ok(browser, 'browser must be launched');
      const page = await browser.newPage();
      try {
        await page.setContent('<!DOCTYPE html><html><body></body></html>');
        await page.addScriptTag({ path: UMD_SOURCE });
        const umd = await page.evaluate((markup) => {
          const lib = /** @type {any} */ (window).SvgVisualBBox;
          return lib.describeFbf(markup);
        }, fixtureContent);
        const lib = require(LIB_FBF).describeFbf(fixtureContent);
        assert.strictEqual(umd.isFbf, lib.isFbf);
        assert.strictEqual(umd.minFrame, lib.minFrame);
        assert.strictEqual(umd.maxFrame, lib.maxFrame);
        assert.strictEqual(umd.frames.length, lib.frames.length);
      } finally {
        await page.close();
      }
    }, 60000);
  });

  describe('Validation messages match across implementations', () => {
    test('non-FBF input gives same actionable error', () => {
      const lib = require(LIB_FBF);
      const shim = require(NODE_SHIM);
      const notFbf = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';

      let libErr, shimErr;
      try {
        lib.extractFbfFrame(notFbf, 1);
      } catch (e) {
        libErr = e.message;
      }
      try {
        shim.extractFbfFrame(notFbf, 1);
      } catch (e) {
        shimErr = e.message;
      }

      assert.strictEqual(libErr, shimErr, 'error messages must match between lib and shim');
      assert.ok(libErr.includes('svg2fbf'), 'error must name the producing tool');
    });

    test('out-of-range frame gives same actionable error', () => {
      const lib = require(LIB_FBF);
      const shim = require(NODE_SHIM);

      let libErr, shimErr;
      try {
        lib.extractFbfFrame(fixtureContent, 99);
      } catch (e) {
        libErr = e.message;
      }
      try {
        shim.extractFbfFrame(fixtureContent, 99);
      } catch (e) {
        shimErr = e.message;
      }

      assert.strictEqual(libErr, shimErr);
      assert.ok(libErr.includes('Available frames'), 'error must list available range');
    });
  });

  describe('Package exports map (real package-name resolution)', () => {
    /** @type {string} */
    let testDir;

    beforeAll(() => {
      // Build an isolated directory with `node_modules/svg-bbox` symlinked
      // to the local repo, so `require('svg-bbox')` and `import 'svg-bbox'`
      // exercise the real exports map (not relative paths).
      testDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'svg-bbox-exports-test-'));
      fs.mkdirSync(path.join(testDir, 'node_modules'), { recursive: true });
      fs.symlinkSync(REPO_ROOT, path.join(testDir, 'node_modules', 'svg-bbox'), 'dir');
    });

    afterAll(() => {
      // Best-effort cleanup; the OS will reap the tmpdir on reboot regardless.
      try {
        fs.unlinkSync(path.join(testDir, 'node_modules', 'svg-bbox'));
        fs.rmdirSync(path.join(testDir, 'node_modules'));
        for (const f of fs.readdirSync(testDir)) {
          fs.unlinkSync(path.join(testDir, f));
        }
        fs.rmdirSync(testDir);
      } catch {
        /* swallow — best-effort */
      }
    });

    test("Node CJS require('svg-bbox') resolves and exposes extractFbfFrame", async () => {
      fs.writeFileSync(path.join(testDir, 'package.json'), '{}');
      const { stdout } = await execFilePromise(
        process.execPath,
        ['-e', "console.log(typeof require('svg-bbox').extractFbfFrame);"],
        { cwd: testDir, timeout: 30000 }
      );
      assert.strictEqual(stdout.trim(), 'function');
    }, 60000);

    test("Node ESM import 'svg-bbox' resolves and exposes extractFbfFrame (named)", async () => {
      fs.writeFileSync(path.join(testDir, 'package.json'), '{"type":"module"}');
      fs.writeFileSync(
        path.join(testDir, 'esm-named.mjs'),
        "import { extractFbfFrame } from 'svg-bbox'; console.log(typeof extractFbfFrame);"
      );
      const { stdout } = await execFilePromise(
        process.execPath,
        [path.join(testDir, 'esm-named.mjs')],
        { cwd: testDir, timeout: 30000 }
      );
      assert.strictEqual(stdout.trim(), 'function');
    }, 60000);

    test("Node ESM default import 'svg-bbox' resolves with .extractFbfFrame on default", async () => {
      fs.writeFileSync(path.join(testDir, 'package.json'), '{"type":"module"}');
      fs.writeFileSync(
        path.join(testDir, 'esm-default.mjs'),
        "import lib from 'svg-bbox'; console.log(typeof lib.extractFbfFrame);"
      );
      const { stdout } = await execFilePromise(
        process.execPath,
        [path.join(testDir, 'esm-default.mjs')],
        { cwd: testDir, timeout: 30000 }
      );
      assert.strictEqual(stdout.trim(), 'function');
    }, 60000);

    test("Node CJS require('svg-bbox/fbf') subpath also works", async () => {
      fs.writeFileSync(path.join(testDir, 'package.json'), '{}');
      const { stdout } = await execFilePromise(
        process.execPath,
        ['-e', "console.log(typeof require('svg-bbox/fbf').extractFbfFrame);"],
        { cwd: testDir, timeout: 30000 }
      );
      assert.strictEqual(stdout.trim(), 'function');
    }, 60000);

    test('DOM-bound function in Node CJS throws actionable error (not a silent no-op)', async () => {
      fs.writeFileSync(path.join(testDir, 'package.json'), '{}');
      const { stdout } = await execFilePromise(
        process.execPath,
        [
          '-e',
          "try { require('svg-bbox').getSvgElementVisualBBoxTwoPassAggressive(); } catch (e) { console.log(e.message.includes('DOM') && e.message.includes('Puppeteer')); }"
        ],
        { cwd: testDir, timeout: 30000 }
      );
      assert.strictEqual(
        stdout.trim(),
        'true',
        'DOM-bound stub must throw an error mentioning DOM and Puppeteer'
      );
    }, 60000);
  });
});
