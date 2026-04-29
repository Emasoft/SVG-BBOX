# TRDD-882dea1b — Fast Test Architecture Redesign

**TRDD ID:** `882dea1b-a518-4755-a267-0aedaae886c4` **Filename:**
`design/tasks/TRDD-882dea1b-a518-4755-a267-0aedaae886c4-fast-test-architecture.md`
**Tracked in:** this repo (design/tasks/ is git-tracked) **Status:** Not started
**Created:** 2026-04-29 **Goal:** Redesign test suite to support vitest
concurrency 15 and complete in <2 minutes

---

## 1. Problem Statement

The current test suite cannot survive vitest concurrency >2 without flake. Even
at concurrency 1 (sequential), the full suite takes ~30 minutes and still
produces hook timeouts. Root cause is architectural, not environmental.

The user's directive: **concurrency 15, fast tests, redesign.**

## 2. Current Architecture — Inventory

| Metric                                                | Value                           |
| ----------------------------------------------------- | ------------------------------- |
| Total test cases                                      | 579                             |
| Test files                                            | 33 (25 integration + 8 unit)    |
| Files using subprocess CLI invocations                | 19 / 25                         |
| Subprocess invocations in `sbb-extract.test.js` alone | 50                              |
| Subprocess invocations in `sbb-svg2png.test.js` alone | 47                              |
| Total subprocess invocations across suite             | ~250+                           |
| Browser launch sites in production code               | 17                              |
| Wall-clock for full suite (sequential, post-fix)      | ~30 min                         |
| Wall-clock per CLI invocation                         | 5-30s (mostly Chromium startup) |

## 3. Why The Current Architecture Cannot Scale

### 3.1 Subprocess Tax

Most "integration" tests are actually **subprocess tests**. Each `it()` block
does roughly:

```
1. fs.writeFile(svg)                      // 5ms
2. execFileAsync('node', ['sbb-X.cjs'])   // spawn = 50ms
   ├── node startup                        // 100-300ms
   ├── require puppeteer                   // 300-800ms
   ├── puppeteer.launch()                  // 1-3s (Chromium boot)
   ├── render / extract / compare          // 100-2000ms
   └── browser.close()                     // 100-500ms
3. parse stdout / read PNG                 // 5-50ms
```

Per test: **2-7 seconds**, of which ≥80% is fixed Chromium boot cost. Multiply
by 250 invocations = **8-30 minutes of pure Chromium startup**, before any
actual work happens.

### 3.2 No Browser Pool Across Workers

Each CLI subprocess launches its own Chromium. There is no IPC, no shared
browser pool, no warm-cache reuse. At vitest concurrency N, peak Chromium count
is ≥N (vitest workers) + N×k (CLI subprocesses, k=1-2 per active test).

At concurrency 15: peak Chromium = 30-45 instances. macOS has a hard limit
around ~10 concurrent Chromium instances before GPU/IPC saturates and
`Runtime.callFunctionOn` calls start blocking past the protocolTimeout.

### 3.3 CLI Tools Are Already Importable But Not Imported

Verified: `sbb-extract.cjs`, `sbb-getbbox.cjs`, `sbb-compare.cjs` all export
`module.exports = { main, ... }`. Tests COULD call `main(args)` directly
in-process instead of `execFileAsync('node', [...])`. They don't.

This is the single biggest missed opportunity. Calling `main()` directly:

- 0ms node startup (already in vitest's process)
- 0ms require (cached)
- Reuses pooled browser (if pool exists)
- Saves ~1-3s per test × 250 tests = **4-12 minutes**

### 3.4 Shared Browser State Leaks Across Test Files

`tests/helpers/browser-test.js` exposes `getBrowser()` which returns a
module-level `sharedBrowser` singleton. With vitest's `pool: 'threads'` +
`isolate: true`, each test file gets its own thread → its own module instance →
its own browser. Looks isolated, but in practice:

- Browser launch per test file = expensive (1-3s)
- The shared browser is only shared **within** a test file, not **across**
- 33 test files × 1 browser launch each = 33 × 2s = **~1 minute of pure browser
  launching**

### 3.5 Hook Timeout Spiral

When the system is under contention (many parallel Chromiums), individual CDP
calls slow down. `beforeAll` hooks that call `getBrowser()` + `newPage()` +
`evaluate()` see each step take 10-30× longer. We've been bumping `hookTimeout`
from 60s → 180s → 600s, which masks the symptom but doesn't fix the cause.

## 4. Proposed New Architecture — Three Tiers

### Tier 1: PURE UNIT TESTS (no browser, vitest concurrency 15)

**What:** Test pure functions in `lib/` and CLI argument parsers.

**Files (estimated):**

- `lib/fbf.cjs` (frame parsing, regex matching)
- `lib/security-utils.cjs` (path validation)
- `lib/cli-utils.cjs` (arg parsing, JSON output formatting)
- CLI argument parsers (extract `parseArgs()` from each `sbb-*.cjs`)
- `parseFbfFrameList()`, `expandFbfFrameOutputs()`, etc.

**Test count:** ~200 tests (we'd convert many "integration" tests to unit tests)
**Wall-clock per test:** <50ms **Total wall-clock at concurrency 15:** ~1-2s for
the entire tier

**Migration:** Add `tests/unit/parsers/`, `tests/unit/lib/` directories. Move
parsing/validation tests out of integration tests where they don't actually
exercise Puppeteer.

### Tier 2: LIBRARY-IN-BROWSER TESTS (pooled browser, vitest concurrency 8)

**What:** Test `SvgVisualBBox.js` browser library functions (the actual
product).

**Architecture:**

- One persistent browser pool (4 Chromium instances, pre-warmed at suite
  startup)
- Pool exposes `acquirePage()` / `releasePage()` API
- Pool lifetime = entire vitest run (not per file)
- Implementation: `tests/helpers/browser-pool.js` using a worker file +
  `vitest.globalSetup` so the pool starts ONCE before all tests, dies AFTER all
  tests.

**Test count:** ~150 tests (current unit tests + library-focused integration
tests) **Wall-clock per test:** 50-200ms (page acquire from pool, evaluate,
release) **Total wall-clock at concurrency 8:** ~30s for the entire tier

**Migration:**

1. Build `tests/helpers/browser-pool.js` (single source of truth)
2. Convert `tests/helpers/browser-test.js#getBrowser()` to use the pool
3. Replace `beforeAll → getBrowser → newPage` pattern with
   `beforeEach → pool.acquirePage` (cheaper, fully isolated)

### Tier 3: CLI SMOKE TESTS (in-process imports, vitest concurrency 15)

**What:** Test CLI tools by importing `main()` directly. NOT subprocess spawn.

```js
// OLD (subprocess, ~3s):
const { stdout } = await execFileAsync('node', [
  'sbb-extract.cjs',
  svgPath,
  '--list'
]);

// NEW (in-process, ~200ms with pooled browser):
const { main } = require('../../sbb-extract.cjs');
const stdout = await captureStdout(() =>
  main(['sbb-extract.cjs', svgPath, '--list'])
);
```

**Architecture:**

- CLI tools' `main()` already exported
- Need a `captureStdout()` helper (process.stdout interception)
- Need to pass the pooled browser to `main()` — either via env var or by
  refactoring `puppeteer.launch()` calls to accept an injected browser

**Test count:** ~150 tests (current integration tests, simplified) **Wall-clock
per test:** 100-500ms **Total wall-clock at concurrency 15:** ~30s for the
entire tier

**Migration:**

1. Each `sbb-*.cjs` adds
   `if (process.env.SBB_INJECTED_BROWSER) { use it } else { puppeteer.launch() }`
2. Test files import `main` directly, pass injected browser
3. Subprocess tests reduced to 1-2 per CLI tool (just verify CLI invocation
   works)

### Tier 4: CLI BLACK-BOX SMOKE (subprocess, kept minimal)

**What:** Verify each CLI binary actually starts as a subprocess (can't be faked
by in-process imports). Just `--help` and one happy-path call.

**Test count:** 13 (one per CLI binary) **Wall-clock per test:** 2-3s **Total
wall-clock at concurrency 4:** ~10s

This is the only tier where we still pay the subprocess tax, and we minimize it
to ~13 tests instead of 250.

## 5. Total Speedup Estimate

| Architecture                                  | Total tests | Wall-clock      |
| --------------------------------------------- | ----------- | --------------- |
| **Current** (concurrency 1, post-flake-fixes) | 579         | ~30 min         |
| **Current** (concurrency 5, with retries)     | 579         | ~5 min + flakes |
| **Proposed** (concurrency 15)                 | 513         | **~1.5 min**    |

20× faster, deterministic, no flake. Concurrency 15 is sustainable because the
only place we still spawn ≥1 Chromium per worker is Tier 4 (13 tests total) —
not 250.

## 6. Migration Plan (Phased)

### Phase 1 — Prove the pool works (1 day)

- [ ] Build `tests/helpers/browser-pool.js` with N=4 prewarmed browsers
- [ ] Wire it via `vitest.globalSetup`
- [ ] Convert `getBrowser()` to use it
- [ ] Verify existing tests still pass (no behavioral change yet)
- [ ] Measure: full suite at concurrency 5 should drop from 5min → ~3min

### Phase 2 — Convert library tests to use pool (1 day)

- [ ] Identify all tests that use `getBrowser()` or `puppeteer.launch()`
      directly
- [ ] Convert to `pool.acquirePage()` / `releasePage()` pattern
- [ ] Verify each test still passes
- [ ] Measure: should drop another 1-2 min

### Phase 3 — In-process CLI tests (2-3 days, BIGGEST WIN)

- [ ] Refactor `sbb-extract.cjs main()` to accept `{ injectedBrowser }` option
- [ ] Same for `sbb-getbbox.cjs`, `sbb-svg2png.cjs`, `sbb-compare.cjs`,
      `sbb-fix-viewbox.cjs`, `sbb-test.cjs`
- [ ] Build `tests/helpers/in-process-cli.js` with `runCli(name, args)` that:
  - Acquires a page from pool
  - Calls `main()` with injected page
  - Captures stdout/stderr via process.stdout interception
- [ ] Convert ~80% of integration tests from subprocess → in-process
- [ ] Keep 1-2 subprocess tests per CLI for Tier 4 smoke
- [ ] Measure: should drop from ~3min → ~1.5min at concurrency 15

### Phase 4 — Move pure-function tests to Tier 1 (0.5 day)

- [ ] Audit each integration test: does it actually need a browser?
- [ ] If no, move to `tests/unit/`
- [ ] Verify Tier 1 runs in <2s at concurrency 15

## 7. Risks & Decisions Required

| Risk                                                                                  | Mitigation                                                                            |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| In-process CLI tests share global state (`process.argv`, `process.env`)               | Use `withMockedProcess()` helper that snapshot/restores. Already a known pattern.     |
| Stdout interception breaks if CLI uses raw `process.stdout.write` vs `console.log`    | Audit which form each CLI uses; intercept both.                                       |
| Pool browser dies mid-test → cascade failure                                          | Pool detects dead browsers, replaces them. 1 retry per test.                          |
| Some tests genuinely need subprocess (signal handling, exit codes from process death) | Keep these as Tier 4. Estimate <20 such tests.                                        |
| Refactoring CLI `main()` to accept injected browser breaks production use             | Default to current behavior; only use injected when `SBB_TEST_BROWSER_WS` env is set. |

## 8. Decision Required Before Implementation

The user must decide:

**Option A: Full migration (Phases 1-4, ~5 days work).** Best long-term, but
delays current v1.2.1 release significantly.

**Option B: Phase 1 + 2 only (browser pool, ~2 days).** Cuts test time roughly
in half, lets concurrency safely go to 8-10. Doesn't reach concurrency 15.

**Option C: Phase 3 only (in-process CLI, ~3 days).** Biggest single win; allows
concurrency 15 because subprocess count drops from 250 to ~20.

**Option D: Phases 1+3 (pool + in-process, ~4 days).** Reaches the full ~1.5min
goal. Recommended.

## 9. Decision For Current v1.2.1 Release

This redesign is a multi-day effort. v1.2.1 is blocked by flake, not by absent
features. Recommendation:

- **Ship v1.2.1 now** with `concurrency: 3` and the protocolTimeout fixes
  already committed. Accept 1-in-5 release retries until the redesign lands.
- **Open a v1.3.0 milestone** for this TRDD with phased PRs.

Alternatively, if user prefers to defer v1.2.1 until the test suite is fast:

- Implement Phase 3 first (biggest win)
- Then ship v1.2.1 with concurrency 15 + new tests

## 10. Why We Got Here

The current architecture is the result of "test the CLI like a user would" —
which is correct for E2E smoke, but wrong for unit/integration. Each `it()`
block treating the CLI as an opaque subprocess maximizes realism but multiplies
Chromium boot costs by 250×. The fix is to test at the right layer: pure
functions as pure functions, library logic in a pooled browser, CLI as imported
`main()`, and only true black-box behavior via subprocess.

Production code does not change (the CLIs still launch their own browsers when
run by a user). Only the test layer changes.
