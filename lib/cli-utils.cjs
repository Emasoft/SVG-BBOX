/**
 * CLI Utilities
 *
 * Shared utilities for all SVG-BBOX command-line tools.
 * Provides consistent argument parsing, error handling, and output formatting.
 *
 * @module cli-utils
 */

const { SVGBBoxError } = require('./security-utils.cjs');

// ============================================================================
// ERROR HANDLING
// ============================================================================

/**
 * Sets up global error handlers for unhandled promise rejections and uncaught exceptions.
 * Ensures clean process exit with proper error messages.
 */
function setupErrorHandlers() {
  process.on('unhandledRejection', (reason, _promise) => {
    console.error('Unhandled Promise Rejection:');
    console.error(reason);
    if (reason && reason.stack) {
      console.error(reason.stack);
    }
    process.exit(1);
  });

  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:');
    console.error(error);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  });
}

/**
 * Wraps an async main function with proper error handling.
 *
 * @param {Function} mainFn - Async function to execute
 * @returns {Promise<void>}
 *
 * @example
 * runCLI(async () => {
 *   const args = parseArgs(process.argv);
 *   await processFile(args.input);
 * });
 */
async function runCLI(mainFn) {
  setupErrorHandlers();

  try {
    await mainFn();
  } catch (err) {
    if (err instanceof SVGBBoxError) {
      // Custom error - show user-friendly message
      console.error(`Error: ${err.message}`);
      if (err.details && Object.keys(err.details).length > 0) {
        console.error('Details:', err.details);
      }
    } else {
      // Unexpected error - show full details
      console.error('Unexpected error:');
      console.error(err.message || err);
      if (err.stack) {
        console.error(err.stack);
      }
    }
    process.exit(1);
  }
}

// ============================================================================
// ARGUMENT PARSING
// ============================================================================

/**
 * Creates a command-line argument parser with consistent behavior.
 *
 * @param {Object} config - Parser configuration
 * @param {string} config.name - Command name
 * @param {string} config.description - Command description
 * @param {string} config.usage - Usage string
 * @param {Array<Object>} config.flags - Flag definitions
 * @param {number} [config.minPositional=0] - Minimum positional arguments
 * @param {number} [config.maxPositional=Infinity] - Maximum positional arguments
 * @returns {Function} Parser function
 *
 * @example
 * const parser = createArgParser({
 *   name: 'svg-tool',
 *   description: 'Process SVG files',
 *   usage: 'svg-tool [options] <input.svg> [output.svg]',
 *   flags: [
 *     { name: 'json', alias: 'j', description: 'Output as JSON', type: 'boolean' },
 *     { name: 'output', alias: 'o', description: 'Output file', type: 'string' }
 *   ],
 *   minPositional: 1,
 *   maxPositional: 2
 * });
 *
 * const args = parser(process.argv);
 * // { flags: { json: true, output: 'out.json' }, positional: ['input.svg'] }
 */
function createArgParser(config) {
  const {
    name,
    description,
    usage,
    flags = [],
    minPositional = 0,
    maxPositional = Infinity
  } = config;

  // Build flag lookup maps
  const flagsByName = new Map();
  const flagsByAlias = new Map();

  for (const flag of flags) {
    flagsByName.set(`--${flag.name}`, flag);
    if (flag.alias) {
      flagsByAlias.set(`-${flag.alias}`, flag);
    }
  }

  /**
   * Prints help message and exits.
   */
  function printHelp() {
    console.log(`${name} - ${description}\n`);
    console.log(`Usage: ${usage}\n`);

    if (flags.length > 0) {
      console.log('Options:');
      for (const flag of flags) {
        const aliases = flag.alias ? `-${flag.alias}, ` : '    ';
        const nameStr = `--${flag.name}`;
        const typeStr = flag.type === 'string' ? ' <value>' : '';
        console.log(`  ${aliases}${nameStr}${typeStr}`);
        console.log(`      ${flag.description}`);
      }
    }

    console.log('\nCommon options:');
    console.log('  -h, --help       Show this help message');
    console.log('  -v, --version    Show version information');
  }

  /**
   * Prints version information and exits.
   */
  function printVersion() {
    // Try to read version from package.json
    try {
      const pkg = require('../package.json');
      console.log(`${name} version ${pkg.version}`);
    } catch (_err) {
      console.log(`${name} (version unknown)`);
    }
  }

  /**
   * Parses command-line arguments.
   *
   * @param {string[]} argv - Process argv array
   * @returns {Object} Parsed arguments
   */
  function parse(argv) {
    // Skip node and script name
    const args = argv.slice(2);

    const result = {
      flags: {},
      positional: []
    };

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      // Handle help
      if (arg === '--help' || arg === '-h') {
        printHelp();
        process.exit(0);
      }

      // Handle version
      if (arg === '--version' || arg === '-v') {
        printVersion();
        process.exit(0);
      }

      // Handle flags
      const flag = flagsByName.get(arg) || flagsByAlias.get(arg);

      if (flag) {
        if (flag.type === 'boolean') {
          result.flags[flag.name] = true;
        } else if (flag.type === 'string') {
          // Next argument is the value
          if (i + 1 >= args.length) {
            throw new Error(`Missing value for flag: ${arg}`);
          }
          i++;
          result.flags[flag.name] = args[i];
        }
      } else if (arg.startsWith('-')) {
        // Unknown flag
        throw new Error(`Unknown flag: ${arg}\nUse --help for usage information.`);
      } else {
        // Positional argument
        result.positional.push(arg);
      }
    }

    // Validate positional argument count
    if (result.positional.length < minPositional) {
      throw new Error(
        `Too few arguments (got ${result.positional.length}, need at least ${minPositional})\n` +
        'Use --help for usage information.'
      );
    }

    if (result.positional.length > maxPositional) {
      throw new Error(
        `Too many arguments (got ${result.positional.length}, maximum ${maxPositional})\n` +
        'Use --help for usage information.'
      );
    }

    return result;
  }

  return parse;
}

// ============================================================================
// OUTPUT FORMATTING
// ============================================================================

/**
 * Formats a success message with optional emoji.
 *
 * @param {string} message - Success message
 * @returns {string} Formatted message
 */
function formatSuccess(message) {
  return `✓ ${message}`;
}

/**
 * Formats an error message with optional emoji.
 *
 * @param {string} message - Error message
 * @returns {string} Formatted message
 */
function formatError(message) {
  return `✗ ${message}`;
}

/**
 * Formats an info message with optional emoji.
 *
 * @param {string} message - Info message
 * @returns {string} Formatted message
 */
function formatInfo(message) {
  return `ℹ ${message}`;
}

/**
 * Formats a warning message with optional emoji.
 *
 * @param {string} message - Warning message
 * @returns {string} Formatted message
 */
function formatWarning(message) {
  return `⚠ ${message}`;
}

/**
 * Prints a success message to stdout.
 *
 * @param {string} message - Success message
 */
function printSuccess(message) {
  console.log(formatSuccess(message));
}

/**
 * Prints an error message to stderr.
 *
 * @param {string} message - Error message
 */
function printError(message) {
  console.error(formatError(message));
}

/**
 * Prints an info message to stdout.
 *
 * @param {string} message - Info message
 */
function printInfo(message) {
  console.log(formatInfo(message));
}

/**
 * Prints a warning message to stderr.
 *
 * @param {string} message - Warning message
 */
function printWarning(message) {
  console.error(formatWarning(message));
}

// ============================================================================
// PROGRESS INDICATORS
// ============================================================================

/**
 * Simple progress indicator for long-running operations.
 *
 * @param {string} message - Operation description
 * @returns {Object} Progress indicator object with update() and done() methods
 *
 * @example
 * const progress = createProgress('Processing files');
 * for (let i = 0; i < 100; i++) {
 *   progress.update(`${i + 1}/100`);
 *   await processFile(files[i]);
 * }
 * progress.done('All files processed');
 */
function createProgress(message) {
  let lastLine = '';

  return {
    /**
     * Updates the progress message.
     *
     * @param {string} status - Current status
     */
    update(status) {
      // Clear previous line
      if (lastLine) {
        process.stdout.write('\r' + ' '.repeat(lastLine.length) + '\r');
      }

      // Write new line
      const line = `${message}... ${status}`;
      process.stdout.write(line);
      lastLine = line;
    },

    /**
     * Marks progress as complete.
     *
     * @param {string} [finalMessage] - Final success message
     */
    done(finalMessage) {
      // Clear progress line
      if (lastLine) {
        process.stdout.write('\r' + ' '.repeat(lastLine.length) + '\r');
      }

      // Print final message
      if (finalMessage) {
        printSuccess(finalMessage);
      }
    }
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Error handling
  setupErrorHandlers,
  runCLI,

  // Argument parsing
  createArgParser,

  // Output formatting
  formatSuccess,
  formatError,
  formatInfo,
  formatWarning,
  printSuccess,
  printError,
  printInfo,
  printWarning,

  // Progress
  createProgress
};
