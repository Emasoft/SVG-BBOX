/**
 * Global Setup for Vitest — Shared Chromium Browser
 *
 * Launches ONE Chromium instance for the entire test run. Every test (vitest
 * worker) and every CLI subprocess invoked by tests connects to this single
 * instance via the WebSocket endpoint exposed in $SBB_BROWSER_WS.
 *
 * WHY THIS EXISTS:
 * - Each Chromium is 300-500MB RAM and 1-3s to launch.
 * - Without this, vitest at concurrency N spawns N Chromiums + each CLI
 *   subprocess spawns ANOTHER Chromium. Peak count: 30-45 instances at
 *   concurrency 15. macOS/Linux saturates GPU/IPC and the suite flakes.
 * - With this, peak Chromium count is exactly 1. Each test gets its own
 *   isolated tab (page) inside that single Chromium. Tabs are cheap:
 *   ~50-100MB RAM, ~50ms to open.
 *
 * CROSS-PLATFORM:
 * - WebSocket binds to 127.0.0.1:<random-free-port>; localhost-only so no
 *   firewall punching is required on macOS / Linux / Windows.
 * - Env var inheritance works identically on all three OSes — child
 *   processes spawned via execFile/spawn automatically inherit
 *   $SBB_BROWSER_WS.
 * - Chromium binary location is resolved by puppeteer's findBrowser()
 *   (handles Chrome/Chromium/system Chrome on Mac/Linux/Windows).
 *
 * WHAT NOT TO DO:
 * - Don't bind to 0.0.0.0 (security: avoid exposing CDP to network)
 * - Don't reuse this for production code — production runs each CLI
 *   independently and benefits from fresh Chromium per invocation.
 * - Don't add `--remote-debugging-port=9222` (puppeteer picks a free port
 *   automatically; hardcoded port collides with user's running Chrome).
 *
 * Used by:
 * - vitest.config.js (globalSetup field)
 * - tests/helpers/browser-test.js (getBrowser() reads $SBB_BROWSER_WS)
 * - All sbb-*.cjs CLI tools (puppeteer-utils.cjs#launchOrConnect)
 */

import puppeteer from 'puppeteer';
import { ensureBrowserSync, findBrowser } from '../../lib/ensure-browser.cjs';
import { PROTOCOL_TIMEOUT_MS } from '../../config/timeouts.js';

/**
 * Cross-platform Chromium launch arguments.
 *
 * Per-platform flags are chosen to maximize compatibility:
 * - --no-sandbox / --disable-setuid-sandbox: Required in Linux containers
 *   (Docker, GitHub Actions Ubuntu runners). Harmless on macOS/Windows.
 * - --disable-dev-shm-usage: Linux containers often have undersized /dev/shm
 *   (default 64MB). Without this flag, Chromium crashes on heavy SVG
 *   rendering. Harmless on macOS/Windows where shm sizing is generous.
 * - --disable-extensions / --disable-background-networking / etc.: Reduce
 *   memory footprint and noise; safe everywhere.
 * - --mute-audio / --no-first-run / --disable-default-apps: Prevent
 *   first-run wizards and audio init that have caused flakes in CI.
 *
 * @type {string[]}
 */
const CROSS_PLATFORM_BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-translate',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-first-run'
];

/**
 * Module-level reference to the shared browser, used by teardown.
 * @type {import('puppeteer').Browser | null}
 */
let sharedBrowser = null;

/**
 * Launch the shared Chromium and expose its WebSocket endpoint via env var.
 *
 * @returns {Promise<() => Promise<void>>} Teardown function (called by vitest)
 */
export default async function globalSetup() {
  const startTime = Date.now();

  // Ensure puppeteer's bundled Chromium is downloaded (lazy-installs on first
  // run; no-op on subsequent runs). Cross-platform — works identically on
  // macOS, Linux, Windows.
  ensureBrowserSync();

  // Detect the actual browser binary path. Returns null if puppeteer's
  // bundled Chromium is available; otherwise returns system Chrome/Chromium
  // (common on Linux distros that ship Chromium but not puppeteer's).
  const detectedBrowser = findBrowser();

  /** @type {import('puppeteer').LaunchOptions} */
  const launchOptions = {
    headless: true,
    args: CROSS_PLATFORM_BROWSER_ARGS,
    // protocolTimeout governs single-CDP-call duration. 300s is a generous
    // ceiling that only triggers on real hangs (not contention), since the
    // tab-based architecture eliminates GPU/IPC saturation.
    protocolTimeout: PROTOCOL_TIMEOUT_MS,
    // Don't pipe — use WebSocket so child processes can connect.
    pipe: false
  };

  if (detectedBrowser && detectedBrowser.source !== 'puppeteer') {
    launchOptions.executablePath = detectedBrowser.path;
  }

  sharedBrowser = await puppeteer.launch(launchOptions);

  // browser.wsEndpoint() returns "ws://127.0.0.1:<port>/devtools/browser/<uuid>"
  // — a URL that any process on the same machine can connect to via
  // puppeteer.connect({ browserWSEndpoint }).
  const wsEndpoint = sharedBrowser.wsEndpoint();

  // Expose to all child processes. process.env mutations propagate to
  // execFile/spawn'd subprocesses on macOS, Linux, AND Windows.
  process.env.SBB_BROWSER_WS = wsEndpoint;

  const elapsed = Date.now() - startTime;
  console.log(
    `[global-setup] Shared Chromium launched in ${elapsed}ms — wsEndpoint: ${wsEndpoint}`
  );

  // Vitest calls this teardown function after all tests complete.
  return async () => {
    if (sharedBrowser) {
      try {
        await sharedBrowser.close();
      } catch {
        // Browser may already be closed (e.g., crash during tests)
      }
      sharedBrowser = null;
    }
    delete process.env.SBB_BROWSER_WS;
  };
}
