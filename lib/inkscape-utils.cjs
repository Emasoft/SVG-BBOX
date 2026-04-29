/**
 * inkscape-utils.cjs — shared helpers for the four sbb-inkscape-*.cjs tools.
 *
 * Exposes:
 *   - `applyStartupJitter(maxMs?)` — random sleep at tool start to stagger
 *     parallel inkscape launches.
 *   - `INKSCAPE_DETECT_TIMEOUT_MS` / `INKSCAPE_QUERY_TIMEOUT_MS` /
 *     `INKSCAPE_EXPORT_TIMEOUT_MS` — generous per-call timeouts that the
 *     tools should use when invoking the inkscape binary. They are sized
 *     for systems with very large font directories (e.g. macOS workstations
 *     with 10 000+ fonts where the first launch can take 60+ seconds to
 *     build the font cache).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Why startup jitter exists
 * ─────────────────────────────────────────────────────────────────────────
 * Inkscape does aggressive lazy initialization on launch — font cache,
 * GTK/Aqua bridges, extension registry. On systems with thousands of
 * fonts the first launch can take a minute or more. When N tests fire
 * `execFile()` against the inkscape binary at the same wall-clock
 * instant, all N launches contend for the same init resources (file
 * locks on the shared font cache, in particular) and several of them
 * trip the per-tool timeout — producing the well-known
 * "Inkscape not found" / "Inkscape process timed out" parallel-execution
 * flake. Run the same tests serially and they all pass.
 *
 * The fix is the cheapest possible thing that breaks the simultaneity: a
 * uniformly distributed random sleep of 0–`maxJitterMs` milliseconds at
 * the very top of each tool process, before it makes its first inkscape
 * call. Four parallel tool invocations then end up spread over several
 * seconds instead of firing at the same instant — enough headroom for
 * Inkscape's font-cache build and the rest of its startup to proceed
 * sequentially without lock contention.
 *
 * The default cap is **5 000 ms** (5 seconds) so on a 4–8-way vitest
 * pool the actual inkscape launches are spaced ~600 ms–2 s apart — well
 * within the slow-launch window of a font-heavy system. The jitter is
 * gated on environment variables so interactive CLI users never pay for
 * it:
 *   - `VITEST=true`               — vitest sets this automatically.
 *   - `CI=true`                   — every major CI sets this.
 *   - `SBB_INKSCAPE_JITTER_MS=N`  — override / force-enable; setting to 0
 *                                   disables the jitter entirely. Useful
 *                                   for reproducing the flake (set to 0)
 *                                   or for very-large font directories
 *                                   (set to 10000 or higher).
 */

'use strict';

/**
 * Generous per-call timeouts for the inkscape binary. Tuned for
 * font-heavy macOS workstations where the first cold launch (after a
 * font install or system update) can take 60+ seconds. Override per-tool
 * with `SBB_INKSCAPE_*_TIMEOUT_MS` env vars if you need to tune for an
 * even slower environment.
 */
const INKSCAPE_DETECT_TIMEOUT_MS = parseTimeoutEnv(
  'SBB_INKSCAPE_DETECT_TIMEOUT_MS',
  120000 // 2 min — first-launch font cache build can take this long
);
const INKSCAPE_QUERY_TIMEOUT_MS = parseTimeoutEnv(
  'SBB_INKSCAPE_QUERY_TIMEOUT_MS',
  120000 // 2 min — query commands re-trigger the font cache on cold runs
);
const INKSCAPE_EXPORT_TIMEOUT_MS = parseTimeoutEnv(
  'SBB_INKSCAPE_EXPORT_TIMEOUT_MS',
  180000 // 3 min — text→path / PNG export does the most work
);

/**
 * Parse a positive-integer env var into milliseconds, falling back to a
 * default when unset, empty, or invalid.
 * @param {string} name
 * @param {number} fallbackMs
 * @returns {number}
 */
function parseTimeoutEnv(name, fallbackMs) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallbackMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

/**
 * Apply a uniformly distributed random 0..maxJitterMs sleep at process
 * start, so parallel tool invocations launch their inkscape processes at
 * different instants. No-op when no test/CI env var is set, unless the
 * caller explicitly forces a value via SBB_INKSCAPE_JITTER_MS.
 *
 * @param {number} [maxJitterMs] - Max jitter in ms. Default 5000 (5s).
 * @returns {Promise<void>}
 */
async function applyStartupJitter(maxJitterMs = 5000) {
  // Explicit override always wins. Setting it to 0 disables jitter even
  // under VITEST/CI; setting it to a positive number force-enables the
  // jitter even outside test contexts (useful for reproducing the flake).
  const explicit = process.env.SBB_INKSCAPE_JITTER_MS;
  if (explicit !== undefined && explicit !== '') {
    const parsed = Number(explicit);
    if (!Number.isFinite(parsed) || parsed < 0) {
      // Invalid override — fall back to default behaviour.
    } else {
      maxJitterMs = parsed;
    }
  } else if (!process.env.VITEST && !process.env.CI) {
    // Interactive CLI use — never pay the jitter cost.
    return;
  }

  if (maxJitterMs <= 0) return;

  const ms = Math.floor(Math.random() * (maxJitterMs + 1));
  if (ms === 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  applyStartupJitter,
  INKSCAPE_DETECT_TIMEOUT_MS,
  INKSCAPE_QUERY_TIMEOUT_MS,
  INKSCAPE_EXPORT_TIMEOUT_MS
};
