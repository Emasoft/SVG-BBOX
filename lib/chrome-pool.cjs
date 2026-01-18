#!/usr/bin/env node
/**
 * chrome-pool.cjs
 *
 * Chrome Process Pool Manager for SVG-BBOX.
 *
 * WHAT THIS SOLVES:
 * - Unlimited Chrome instances consuming all system memory
 * - Orphan Chrome processes from crashed/timed-out tests
 * - No visibility into how many Chrome instances are running
 * - CI failures due to resource exhaustion
 *
 * HOW IT WORKS:
 * - Maintains a pool of reusable browser instances
 * - Enforces configurable limit on concurrent browsers
 * - Queues requests when limit is reached
 * - Guardian process monitors and kills stale instances
 * - Automatic cleanup on process exit
 *
 * USAGE:
 *   const { acquireBrowser, releaseBrowser, getPoolStats } = require('./lib/chrome-pool.cjs');
 *
 *   const browser = await acquireBrowser();
 *   try {
 *     // ... use browser ...
 *   } finally {
 *     await releaseBrowser(browser);
 *   }
 */

const puppeteer = require('puppeteer');
const { EventEmitter } = require('events');
const { ensureBrowserSync, findBrowser } = require('./ensure-browser.cjs');

// ============================================================================
// Configuration (can be overridden via environment variables)
// ============================================================================

/**
 * Pool configuration with environment variable overrides.
 * CI environments should set lower limits to prevent resource exhaustion.
 */
const CONFIG = {
  // Maximum number of concurrent browser instances
  // WHY default 3: Balance between parallelism and memory usage
  // A single Chrome instance uses ~100-300MB RAM
  MAX_CONCURRENT_BROWSERS: parseInt(process.env.SVG_BBOX_MAX_BROWSERS || '3', 10),

  // Maximum time (ms) a browser can be idle before being closed
  // WHY 30s: Long enough to reuse between test batches, short enough to free resources
  BROWSER_IDLE_TIMEOUT_MS: parseInt(process.env.SVG_BBOX_BROWSER_IDLE_TIMEOUT || '30000', 10),

  // Maximum time (ms) to wait for browser.close() before force-killing
  // WHY 10s: Give Chrome time to clean up, but don't hang forever
  BROWSER_CLOSE_TIMEOUT_MS: parseInt(process.env.SVG_BBOX_BROWSER_CLOSE_TIMEOUT || '10000', 10),

  // Maximum time (ms) a browser can be in use before being force-reclaimed
  // WHY 5min: Prevents runaway tests from holding browsers forever
  BROWSER_MAX_USE_TIME_MS: parseInt(process.env.SVG_BBOX_BROWSER_MAX_USE_TIME || '300000', 10),

  // How often (ms) the guardian checks for stale browsers
  // WHY 5s: Frequent enough to catch issues, rare enough to not waste CPU
  GUARDIAN_INTERVAL_MS: parseInt(process.env.SVG_BBOX_GUARDIAN_INTERVAL || '5000', 10),

  // Maximum queue size before rejecting new requests
  // WHY 50: Prevents unbounded queue growth if tests are stuck
  MAX_QUEUE_SIZE: parseInt(process.env.SVG_BBOX_MAX_QUEUE_SIZE || '50', 10),

  // Whether to enable verbose logging
  VERBOSE: process.env.SVG_BBOX_POOL_VERBOSE === 'true'
};

// ============================================================================
// Pool State
// ============================================================================

/**
 * @typedef {Object} PooledBrowser
 * @property {import('puppeteer').Browser} browser - The Puppeteer browser instance
 * @property {string} id - Unique identifier for this pooled browser
 * @property {number} createdAt - Timestamp when browser was created
 * @property {number} lastUsedAt - Timestamp when browser was last used
 * @property {number|null} acquiredAt - Timestamp when browser was acquired (null if idle)
 * @property {boolean} isAcquired - Whether browser is currently in use
 * @property {number} useCount - Number of times this browser has been used
 */

/** @type {PooledBrowser[]} */
const pool = [];

/** @type {Array<{resolve: Function, reject: Function, timeoutId: NodeJS.Timeout}>} */
const waitQueue = [];

/** @type {NodeJS.Timeout|null} */
let guardianInterval = null;

/** @type {boolean} */
let isShuttingDown = false;

/** @type {number} */
let browserIdCounter = 0;

/** @type {EventEmitter} */
const poolEvents = new EventEmitter();

// ============================================================================
// Logging
// ============================================================================

/**
 * Log a message if verbose mode is enabled.
 * @param {string} message
 * @param {Object} [data]
 */
function log(message, data = {}) {
  if (CONFIG.VERBOSE) {
    const timestamp = new Date().toISOString();
    const stats = getPoolStats();
    console.log(`[chrome-pool ${timestamp}] ${message}`, {
      ...data,
      poolSize: stats.total,
      acquired: stats.acquired,
      idle: stats.idle,
      queued: stats.queued
    });
  }
}

// ============================================================================
// Browser Launch Configuration
// ============================================================================

/**
 * Get Puppeteer launch options with security defaults.
 * @returns {import('puppeteer').LaunchOptions}
 */
function getLaunchOptions() {
  ensureBrowserSync();
  const detectedBrowser = findBrowser();

  // WHY executablePath: undefined - TypeScript needs this property in the initial object
  // so we can assign it later if detectedBrowser.source !== 'puppeteer'
  const options = {
    headless: true,
    executablePath: /** @type {string|undefined} */ (undefined),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      // Memory optimization for pooled browsers
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run'
    ],
    timeout: 30000
  };

  // Use system Chrome/Chromium if available
  if (detectedBrowser && detectedBrowser.source !== 'puppeteer') {
    options.executablePath = detectedBrowser.path;
  }

  return options;
}

// ============================================================================
// Pool Management
// ============================================================================

/**
 * Create a new pooled browser instance.
 * @returns {Promise<PooledBrowser>}
 */
async function createBrowser() {
  const browser = await puppeteer.launch(getLaunchOptions());
  const now = Date.now();

  const pooledBrowser = {
    browser,
    id: `browser-${++browserIdCounter}`,
    createdAt: now,
    lastUsedAt: now,
    acquiredAt: null,
    isAcquired: false,
    useCount: 0
  };

  pool.push(pooledBrowser);
  log(`Created new browser`, { id: pooledBrowser.id });

  return pooledBrowser;
}

/**
 * Close and remove a pooled browser.
 * @param {PooledBrowser} pooledBrowser
 * @param {string} [reason='unknown']
 */
async function destroyBrowser(pooledBrowser, reason = 'unknown') {
  // Remove from pool first to prevent double-destroy
  const index = pool.indexOf(pooledBrowser);
  if (index !== -1) {
    pool.splice(index, 1);
  }

  log(`Destroying browser`, { id: pooledBrowser.id, reason });

  try {
    // Race between graceful close and timeout
    await Promise.race([
      pooledBrowser.browser.close(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Close timeout')), CONFIG.BROWSER_CLOSE_TIMEOUT_MS)
      )
    ]);
  } catch {
    // Force kill if close fails or times out
    try {
      const proc = pooledBrowser.browser.process();
      if (proc && !proc.killed) {
        proc.kill('SIGKILL');
        log(`Force-killed browser`, { id: pooledBrowser.id });
      }
    } catch {
      // WHY suppressed: process.kill() throws if process already exited (ESRCH) or
      // if we lack permission (EPERM). Both are acceptable during cleanup - the goal
      // is to ensure the process is dead, and both errors indicate it either already
      // is dead or we can't kill it anyway.
    }
  }
}

/**
 * Find an idle browser in the pool.
 * @returns {PooledBrowser|null}
 */
function findIdleBrowser() {
  return pool.find((b) => !b.isAcquired) || null;
}

/**
 * Process the wait queue - try to satisfy waiting requests.
 */
async function processQueue() {
  while (waitQueue.length > 0) {
    const idleBrowser = findIdleBrowser();

    if (idleBrowser) {
      // Satisfy request with existing idle browser
      const request = waitQueue.shift();
      if (request) {
        clearTimeout(request.timeoutId);
        idleBrowser.isAcquired = true;
        idleBrowser.acquiredAt = Date.now();
        idleBrowser.useCount++;
        idleBrowser.lastUsedAt = Date.now();
        log(`Assigned idle browser to queued request`, { id: idleBrowser.id });
        request.resolve(idleBrowser.browser);
      }
    } else if (pool.length < CONFIG.MAX_CONCURRENT_BROWSERS) {
      // Create new browser for request
      const request = waitQueue.shift();
      if (request) {
        clearTimeout(request.timeoutId);
        try {
          const pooledBrowser = await createBrowser();
          pooledBrowser.isAcquired = true;
          pooledBrowser.acquiredAt = Date.now();
          pooledBrowser.useCount++;
          request.resolve(pooledBrowser.browser);
        } catch (err) {
          request.reject(err);
        }
      }
    } else {
      // At capacity and no idle browsers - stop processing
      break;
    }
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Acquire a browser from the pool.
 *
 * If an idle browser is available, it's returned immediately.
 * If at capacity, the request is queued until a browser becomes available.
 *
 * @param {number} [timeoutMs=60000] - Maximum time to wait for a browser
 * @returns {Promise<import('puppeteer').Browser>}
 * @throws {Error} If pool is shutting down, queue is full, or timeout expires
 *
 * @example
 * const browser = await acquireBrowser();
 * try {
 *   const page = await browser.newPage();
 *   // ... use page ...
 * } finally {
 *   await releaseBrowser(browser);
 * }
 */
async function acquireBrowser(timeoutMs = 60000) {
  if (isShuttingDown) {
    throw new Error('Chrome pool is shutting down');
  }

  // Check queue size limit
  if (waitQueue.length >= CONFIG.MAX_QUEUE_SIZE) {
    throw new Error(
      `Chrome pool queue is full (${CONFIG.MAX_QUEUE_SIZE} requests waiting). ` +
        'This may indicate a resource leak - ensure all browsers are released.'
    );
  }

  // Try to find an idle browser
  const idleBrowser = findIdleBrowser();
  if (idleBrowser) {
    idleBrowser.isAcquired = true;
    idleBrowser.acquiredAt = Date.now();
    idleBrowser.useCount++;
    idleBrowser.lastUsedAt = Date.now();
    log(`Acquired idle browser`, { id: idleBrowser.id });
    return idleBrowser.browser;
  }

  // Try to create a new browser if under limit
  if (pool.length < CONFIG.MAX_CONCURRENT_BROWSERS) {
    const pooledBrowser = await createBrowser();
    pooledBrowser.isAcquired = true;
    pooledBrowser.acquiredAt = Date.now();
    pooledBrowser.useCount++;
    log(`Acquired new browser`, { id: pooledBrowser.id });
    return pooledBrowser.browser;
  }

  // At capacity - queue the request
  log(`Queuing browser request`, { queueSize: waitQueue.length + 1 });

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      // Remove from queue on timeout
      const index = waitQueue.findIndex((r) => r.timeoutId === timeoutId);
      if (index !== -1) {
        waitQueue.splice(index, 1);
      }
      reject(
        new Error(
          `Timeout waiting for browser (${timeoutMs}ms). ` +
            `Pool stats: ${pool.length} browsers, ${pool.filter((b) => b.isAcquired).length} acquired`
        )
      );
    }, timeoutMs);

    waitQueue.push({ resolve, reject, timeoutId });
  });
}

/**
 * Release a browser back to the pool.
 *
 * The browser is marked as idle and can be reused by other requests.
 * If the browser is unhealthy, it's destroyed instead.
 *
 * @param {import('puppeteer').Browser} browser - Browser to release
 * @returns {Promise<void>}
 *
 * @example
 * const browser = await acquireBrowser();
 * try {
 *   // ... use browser ...
 * } finally {
 *   await releaseBrowser(browser);
 * }
 */
async function releaseBrowser(browser) {
  const pooledBrowser = pool.find((b) => b.browser === browser);

  if (!pooledBrowser) {
    // Browser not in pool - might be from direct puppeteer.launch()
    // Try to close it anyway to prevent leaks
    log(`Releasing unknown browser - closing directly`);
    try {
      await browser.close();
    } catch {
      try {
        const proc = browser.process();
        if (proc && !proc.killed) {
          proc.kill('SIGKILL');
        }
      } catch {
        // WHY suppressed: best-effort cleanup of unknown browser. The process may
        // already be dead, or browser.process() may return null for remote browsers.
        // Since this is a fallback for browsers not in our pool, we can't do better.
      }
    }
    return;
  }

  log(`Releasing browser`, { id: pooledBrowser.id });

  // Check if browser is still healthy
  let isHealthy = true;
  try {
    // Quick health check - try to get pages
    await browser.pages();
  } catch {
    isHealthy = false;
  }

  if (!isHealthy) {
    // Browser is unhealthy - destroy it
    await destroyBrowser(pooledBrowser, 'unhealthy');
  } else {
    // Close all pages except the blank one to reset state
    try {
      const pages = await browser.pages();
      for (const page of pages) {
        const url = page.url();
        if (url !== 'about:blank') {
          await page.close();
        }
      }
    } catch {
      // WHY suppressed: page.close() can fail if the browser crashed or page context
      // was already destroyed. We catch here to trigger destroyBrowser() which handles
      // both graceful close and force-kill. The error is effectively "handled" by the
      // destroy operation.
      await destroyBrowser(pooledBrowser, 'reset-failed');
      await processQueue();
      return;
    }

    // Mark as idle
    pooledBrowser.isAcquired = false;
    pooledBrowser.acquiredAt = null;
    pooledBrowser.lastUsedAt = Date.now();
  }

  // Process any waiting requests
  await processQueue();
}

/**
 * Get current pool statistics.
 *
 * @returns {{
 *   total: number,
 *   acquired: number,
 *   idle: number,
 *   queued: number,
 *   config: Object
 * }}
 */
function getPoolStats() {
  const acquired = pool.filter((b) => b.isAcquired).length;
  return {
    total: pool.length,
    acquired,
    idle: pool.length - acquired,
    queued: waitQueue.length,
    config: { ...CONFIG }
  };
}

/**
 * Shutdown the pool and close all browsers.
 *
 * @param {number} [timeoutMs=30000] - Maximum time to wait for graceful shutdown
 * @returns {Promise<void>}
 */
async function shutdown(timeoutMs = 30000) {
  if (isShuttingDown) {
    return;
  }

  log(`Shutting down chrome pool`);
  isShuttingDown = true;

  // Stop the guardian
  if (guardianInterval) {
    clearInterval(guardianInterval);
    guardianInterval = null;
  }

  // Reject all queued requests
  while (waitQueue.length > 0) {
    const request = waitQueue.shift();
    if (request) {
      clearTimeout(request.timeoutId);
      request.reject(new Error('Chrome pool is shutting down'));
    }
  }

  // Close all browsers with timeout
  const closePromises = pool.map((b) => destroyBrowser(b, 'shutdown'));

  try {
    await Promise.race([
      Promise.all(closePromises),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Shutdown timeout')), timeoutMs))
    ]);
  } catch {
    // Force kill any remaining browsers
    for (const pooledBrowser of [...pool]) {
      try {
        const proc = pooledBrowser.browser.process();
        if (proc && !proc.killed) {
          proc.kill('SIGKILL');
        }
      } catch {
        // WHY suppressed: during shutdown force-kill, process may already be dead
        // (ESRCH), we may lack permission (EPERM), or browser.process() may return
        // null. All are acceptable - shutdown must complete regardless of individual
        // kill failures. The pool.length=0 below clears all references anyway.
      }
    }
    pool.length = 0;
  }

  log(`Chrome pool shutdown complete`);
  poolEvents.emit('shutdown');
}

/**
 * Force kill all Chrome processes (emergency cleanup).
 *
 * Use this when normal shutdown fails or processes are stuck.
 */
function forceKillAll() {
  log(`Force killing all browsers`);

  for (const pooledBrowser of [...pool]) {
    try {
      const proc = pooledBrowser.browser.process();
      if (proc && !proc.killed) {
        proc.kill('SIGKILL');
      }
    } catch {
      // Ignore
    }
  }

  pool.length = 0;
  waitQueue.length = 0;
}

// ============================================================================
// Guardian Process
// ============================================================================

/**
 * Guardian that monitors pool health and cleans up stale browsers.
 */
function runGuardian() {
  if (isShuttingDown) {
    return;
  }

  const now = Date.now();

  for (const pooledBrowser of [...pool]) {
    // Check for browsers that have been acquired too long
    if (pooledBrowser.isAcquired && pooledBrowser.acquiredAt) {
      const useTime = now - pooledBrowser.acquiredAt;
      if (useTime > CONFIG.BROWSER_MAX_USE_TIME_MS) {
        log(`Browser exceeded max use time`, {
          id: pooledBrowser.id,
          useTime,
          maxUseTime: CONFIG.BROWSER_MAX_USE_TIME_MS
        });
        // Force release and destroy
        pooledBrowser.isAcquired = false;
        destroyBrowser(pooledBrowser, 'max-use-time-exceeded').then(() => processQueue());
      }
    }

    // Check for idle browsers that have timed out
    if (!pooledBrowser.isAcquired) {
      const idleTime = now - pooledBrowser.lastUsedAt;
      if (idleTime > CONFIG.BROWSER_IDLE_TIMEOUT_MS && pool.length > 1) {
        // Keep at least one browser warm
        log(`Browser idle timeout`, {
          id: pooledBrowser.id,
          idleTime,
          idleTimeout: CONFIG.BROWSER_IDLE_TIMEOUT_MS
        });
        destroyBrowser(pooledBrowser, 'idle-timeout');
      }
    }
  }
}

/**
 * Start the guardian process.
 */
function startGuardian() {
  if (guardianInterval) {
    return; // Already running
  }

  guardianInterval = setInterval(runGuardian, CONFIG.GUARDIAN_INTERVAL_MS);
  log(`Guardian started`, { interval: CONFIG.GUARDIAN_INTERVAL_MS });
}

/**
 * Stop the guardian process.
 */
function stopGuardian() {
  if (guardianInterval) {
    clearInterval(guardianInterval);
    guardianInterval = null;
    log(`Guardian stopped`);
  }
}

// ============================================================================
// Process Exit Handlers
// ============================================================================

// Ensure cleanup on process exit
const exitHandler = async () => {
  await shutdown(5000); // Quick shutdown on exit
};

process.on('SIGTERM', exitHandler);
process.on('SIGINT', exitHandler);
process.on('beforeExit', exitHandler);

// Handle uncaught exceptions - try to clean up
process.on('uncaughtException', (err) => {
  console.error('[chrome-pool] Uncaught exception, forcing cleanup:', err);
  forceKillAll();
});

// Start guardian by default
startGuardian();

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  // Core API
  acquireBrowser,
  releaseBrowser,

  // Pool management
  getPoolStats,
  shutdown,
  forceKillAll,

  // Guardian control
  startGuardian,
  stopGuardian,

  // Configuration (read-only)
  CONFIG: Object.freeze({ ...CONFIG }),

  // Events
  poolEvents
};
