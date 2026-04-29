/**
 * In-Process CLI Runner — Phase 3 of TRDD-882dea1b
 *
 * Calls a `sbb-*.cjs` CLI tool's exported main() function directly inside
 * the vitest process instead of spawning it as a subprocess. This is the
 * single biggest test-suite speedup available because each subprocess
 * spawn pays:
 *
 *   1. node startup           ~100-300ms
 *   2. require(puppeteer)     ~300-800ms
 *   3. require(sharp)         ~100-300ms
 *   4. puppeteer.launch()     ~1-3s   (avoided here — shared Chromium)
 *
 * Total per CLI invocation: 1.5-4s of pure overhead. Multiplied by 250+
 * subprocess test calls = 8-20 minutes wasted. This helper eliminates
 * that overhead entirely; each in-process call is just a function
 * invocation (~ms) + page acquire from shared Chromium (~50ms).
 *
 * BEHAVIORAL FIDELITY:
 *
 * To match subprocess execution semantics, the helper:
 * - Sets process.argv to ['node', cliPath, ...args]
 * - Captures process.stdout.write() and process.stderr.write() output
 *   (this includes console.log/console.error which both call .write())
 * - Intercepts process.exit() — converts it to a thrown ExitError so the
 *   test process doesn't actually terminate. The error carries the exit
 *   code, mirroring subprocess exit-code behavior.
 * - Saves and restores process.cwd, process.env mutations
 * - Honors a timeout option (default unlimited) via Promise.race
 *
 * STATE LEAKAGE:
 *
 * CLI tools have module-level state (MODULE_QUIET_MODE, MODULE_ALLOWED_DIRS,
 * etc.) that persists across require() calls because Node's require cache
 * is per-thread. Vitest's pool=threads + isolate=true gives each test FILE
 * its own thread, so state IS isolated between files. WITHIN a file, tests
 * sharing the same CLI module share that state — callers must reset it
 * between tests if they care (most don't, since each test passes fresh
 * argv).
 *
 * WHEN TO USE THIS vs execFileAsync:
 *
 * - Use runCliInProcess() for any test that doesn't depend on subprocess-
 *   specific behavior (signal handling, exit-code propagation to shell,
 *   process isolation).
 * - Keep execFileAsync() for the ~10 "true black-box smoke tests" that
 *   verify the CLI works as a real subprocess (--help printing, exit
 *   code 0/1/2 propagation, stdin handling, etc.).
 *
 * Used by: tests/integration/*.test.js (gradual migration from subprocess)
 *
 * @module tests/helpers/in-process-cli
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// ESM-compatible require for loading CommonJS CLI tools.
// WHY createRequire vs dynamic import: the CLI tools are CommonJS and
// rely on require's synchronous semantics for things like ./version.cjs
// resolution. dynamic import() would force them async and break shared
// state between calls.
const requireCjs = createRequire(import.meta.url);

/**
 * Get current cwd safely. process.cwd() can throw in worker threads if the
 * underlying directory was deleted; default to PROJECT_ROOT in that case.
 * @returns {string}
 */
function safeCwd() {
  try {
    return process.cwd();
  } catch {
    return PROJECT_ROOT;
  }
}

/**
 * Custom error class thrown by the intercepted process.exit().
 * Carries the exit code so callers can inspect it in their catch block.
 */
class ExitError extends Error {
  /**
   * @param {number} code - Exit code passed to process.exit()
   */
  constructor(code) {
    super(`process.exit(${code}) called`);
    this.name = 'ExitError';
    this.exitCode = code;
  }
}

/**
 * Result of an in-process CLI invocation. Mirrors execFileAsync's resolved
 * value (stdout, stderr) plus an explicit exit code.
 *
 * @typedef {Object} CliResult
 * @property {string} stdout - All bytes written to process.stdout / console.log
 * @property {string} stderr - All bytes written to process.stderr / console.error
 * @property {number} exitCode - Exit code (0 = success, non-zero = error). 0 if main() returned normally.
 */

/**
 * Run a sbb-*.cjs CLI tool's main() function in-process.
 *
 * Resolves with `{ stdout, stderr, exitCode }`. Does NOT throw on non-zero
 * exit code — callers should check exitCode if they care. (This mirrors
 * the behavior of execFile with `reject: false`; for parity with
 * execFileAsync's default-rejecting behavior, wrap with throwOnNonZero().)
 *
 * @param {string} cliName - Bare CLI filename, e.g. 'sbb-extract.cjs'.
 *   Resolved relative to project root.
 * @param {string[]} args - CLI arguments (argv[2:] equivalent — do NOT
 *   include 'node' or the script path)
 * @param {Object} [options]
 * @param {string} [options.cwd] - Working directory override. Restored after.
 * @param {Object<string,string>} [options.env] - Env var overrides. Restored after.
 * @param {number} [options.timeout] - Max wall-clock ms before rejection.
 *   Default: no timeout. Useful when migrating tests that previously had
 *   `timeout: CLI_EXEC_TIMEOUT` on execFileAsync.
 * @returns {Promise<CliResult>}
 *
 * @example
 * // Old (subprocess, ~3s):
 * const { stdout } = await execFileAsync('node', ['sbb-extract.cjs', svgPath, '--list']);
 *
 * // New (in-process, ~50ms):
 * const { stdout } = await runCliInProcess('sbb-extract.cjs', [svgPath, '--list']);
 */
export async function runCliInProcess(cliName, args, options = {}) {
  const cliPath = path.join(PROJECT_ROOT, cliName);
  const stdoutChunks = [];
  const stderrChunks = [];
  let exitCode = 0;

  // Snapshot state we'll restore in finally.
  // WHY skip cwd in worker threads: vitest uses worker threads (pool='threads'),
  // and Node.js disallows process.chdir() inside workers. Tests that need a
  // specific cwd should pass absolute paths instead. We snapshot cwd only when
  // the caller explicitly requested an override AND we're on the main thread.
  const origArgv = process.argv;
  const cwdChangeable = typeof options.cwd === 'string' && typeof process.chdir === 'function';
  const origCwd = cwdChangeable ? safeCwd() : null;
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  // WHY override console methods too: Node's global `console` was constructed
  // ONCE at startup with a reference to process.stdout/stderr. Replacing
  // process.stdout.write at runtime does NOT affect existing console.log calls
  // because console captured the original stream reference. We must intercept
  // console methods directly to catch CLI output that uses console.log/error.
  const origConsoleLog = console.log;
  const origConsoleError = console.error;
  const origConsoleInfo = console.info;
  const origConsoleWarn = console.warn;
  const origExit = process.exit;
  const envSnapshot = options.env ? { ...process.env } : null;

  // Apply overrides
  process.argv = ['node', cliPath, ...args];
  if (cwdChangeable) {
    try {
      process.chdir(/** @type {string} */ (options.cwd));
    } catch {
      // Worker threads throw ERR_WORKER_UNSUPPORTED_OPERATION; ignore and
      // hope the CLI under test uses absolute paths (most do).
    }
  }
  if (options.env) Object.assign(process.env, options.env);

  // Intercept process.stdout/stderr for CLIs that call .write() directly.
  /** @param {Uint8Array | string} chunk */
  process.stdout.write = (chunk) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  /** @param {Uint8Array | string} chunk */
  process.stderr.write = (chunk) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };

  // Intercept console methods. Node's util.format() handles printf-style
  // formatting (%s, %d, %j, etc.) and joining multiple args with spaces.
  // We append a newline because console.log/error always do.
  /**
   * @param {unknown[]} args
   * @returns {string}
   */
  const formatArgs = (args) =>
    // Lightweight alternative to util.format — handles the common cases
    // (string, number, object). For full fidelity, callers can use
    // util.format directly, but this avoids the require cost.
    args
      .map((/** @type {unknown} */ a) => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || a.message;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');
  console.log = (...args) => {
    stdoutChunks.push(formatArgs(args) + '\n');
  };
  console.info = (...args) => {
    stdoutChunks.push(formatArgs(args) + '\n');
  };
  console.error = (...args) => {
    stderrChunks.push(formatArgs(args) + '\n');
  };
  console.warn = (...args) => {
    stderrChunks.push(formatArgs(args) + '\n');
  };

  // Intercept process.exit — throw ExitError so we can catch it without
  // killing the test process. main() typically calls process.exit(0) on
  // success and process.exit(N) on error.
  /** @param {number} [code] */
  // @ts-ignore - process.exit signature mismatch is intentional (we throw instead)
  process.exit = (code) => {
    exitCode = typeof code === 'number' ? code : 0;
    throw new ExitError(exitCode);
  };

  try {
    // Lazy require so the import cost is paid once per thread (cached
    // across multiple runCliInProcess calls in the same test file).
    const cliModule = requireCjs(cliPath);

    // Most CLIs export { main }. Some export differently — fail loudly
    // so callers know to fix the export rather than silently no-op.
    if (typeof cliModule.main !== 'function') {
      throw new Error(
        `${cliName} does not export a 'main' function. ` +
          'Add `module.exports = { main, ... }` to make it in-process testable.'
      );
    }

    if (options.timeout) {
      await Promise.race([
        cliModule.main(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`runCliInProcess timeout after ${options.timeout}ms`)),
            options.timeout
          )
        )
      ]);
    } else {
      await cliModule.main();
    }
    // main() returned without calling process.exit() — treat as exit 0
  } catch (err) {
    if (err instanceof ExitError) {
      // ExitError already set exitCode; fall through to finally
    } else {
      // A real error from the CLI (e.g., SVGBBoxError for bad path,
      // FILESYSTEM_ERROR for missing file, generic Error for unexpected).
      // Mirror runCLI's behavior: print to stderr, set non-zero exit.
      // WHY in-helper handling instead of re-throw: subprocess execution
      // would print to stderr and exit non-zero — we replicate that so
      // tests see the same { stdout, stderr, exitCode } shape they would
      // from execFileAsync.
      const error = err instanceof Error ? err : new Error(String(err));
      const errorMsg = error.message || String(error);
      stderrChunks.push(`✗ ${errorMsg}\n`);
      // Map common error codes to exit codes (matches lib/cli-utils#getExitCode).
      // SVGBBoxError uses .code; generic errors get exit 1.
      const errorCode = /** @type {any} */ (error).code;
      if (errorCode === 'VALIDATION_ERROR' || errorCode === 'INVALID_INPUT') {
        exitCode = 2;
      } else if (errorCode === 'FILESYSTEM_ERROR' || errorCode === 'NOT_FOUND') {
        exitCode = 3;
      } else {
        exitCode = 1;
      }
    }
  } finally {
    process.argv = origArgv;
    if (cwdChangeable && origCwd) {
      try {
        process.chdir(origCwd);
      } catch {
        // Worker thread / chdir unavailable — silently skip
      }
    }
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    console.log = origConsoleLog;
    console.error = origConsoleError;
    console.info = origConsoleInfo;
    console.warn = origConsoleWarn;
    process.exit = origExit;
    if (envSnapshot) {
      // Restore env: remove keys we added, restore values we changed
      for (const key of Object.keys(process.env)) {
        if (!(key in envSnapshot)) delete process.env[key];
      }
      for (const [key, val] of Object.entries(envSnapshot)) {
        process.env[key] = val;
      }
    }
  }

  return {
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    exitCode
  };
}

/**
 * Wrapper that throws on non-zero exit code, mirroring execFileAsync's
 * default behavior. Use when migrating a test that previously did:
 *
 *   const { stdout } = await execFileAsync('node', [...]);  // throws on non-0
 *
 * @param {string} cliName
 * @param {string[]} args
 * @param {Object} [options] - Same as runCliInProcess()
 * @returns {Promise<CliResult>}
 */
export async function runCliInProcessOrThrow(cliName, args, options = {}) {
  const result = await runCliInProcess(cliName, args, options);
  if (result.exitCode !== 0) {
    /** @type {Error & { stdout?: string, stderr?: string, exitCode?: number }} */
    const err = new Error(`Command failed: node ${cliName} ${args.join(' ')}\n${result.stderr}`);
    err.stdout = result.stdout;
    err.stderr = result.stderr;
    err.exitCode = result.exitCode;
    throw err;
  }
  return result;
}

export { ExitError };
