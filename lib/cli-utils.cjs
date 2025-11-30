/**
 * CLI Utilities
 *
 * Shared utilities for all SVG-BBOX command-line tools.
 * Provides consistent argument parsing, error handling, and output formatting.
 *
 * @module cli-utils
 */

const { SVGBBoxError, EXIT_CODES } = require('./security-utils.cjs');

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
    // Type guard to check if reason is an Error object with a stack property
    if (reason && typeof reason === 'object' && 'stack' in reason) {
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
      // Custom error - show user-friendly message with proper formatting
      printError(err.message);
      if (err.details && Object.keys(err.details).length > 0) {
        console.error('Details:', err.details);
      }
    } else {
      // Unexpected error - show full details
      printError('Unexpected error');
      console.error(err.message || err);
      if (err.stack) {
        console.error(err.stack);
      }
    }

    // Show guidance hint if available
    const guidance = getGuidance(err);
    if (guidance) {
      printHint(guidance);
    }

    // Use appropriate exit code based on error type
    const exitCode = getExitCode(err);
    process.exit(exitCode);
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
    } catch {
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

/**
 * Formats a hint message with lightbulb indicator.
 *
 * @param {string} message - Hint message
 * @returns {string} Formatted message
 */
function formatHint(message) {
  return `💡 ${message}`;
}

/**
 * Prints a hint/guidance message to stderr.
 * Used to provide helpful suggestions when errors occur.
 *
 * @param {string} message - Hint message
 */
function printHint(message) {
  console.error(formatHint(message));
}

/**
 * Wraps an error with additional context.
 * Useful for adding information about what operation was being performed.
 *
 * @param {Error} originalError - The original error
 * @param {string} context - Additional context about what was happening
 * @returns {Error} New error with context prepended
 *
 * @example
 * try {
 *   await processFile(file);
 * } catch (err) {
 *   throw wrapError(err, `While processing ${file}`);
 * }
 */
function wrapError(originalError, context) {
  const wrappedMessage = `${context}: ${originalError.message}`;
  const wrapped = new Error(wrappedMessage);
  wrapped.cause = originalError;

  // Preserve error code and other properties from SVGBBoxError
  if (originalError instanceof SVGBBoxError) {
    // @ts-ignore - Dynamic properties for error wrapping
    wrapped.code = originalError.code;
    // @ts-ignore - Dynamic properties for error wrapping
    wrapped.details = originalError.details;
    // @ts-ignore - Dynamic properties for error wrapping
    wrapped.exitCode = originalError.exitCode;
    // @ts-ignore - Dynamic properties for error wrapping
    wrapped.guidance = originalError.guidance;
  }

  return wrapped;
}

/**
 * Gets the appropriate exit code for an error.
 *
 * @param {Error} error - The error
 * @returns {number} Exit code
 */
function getExitCode(error) {
  // Check for explicit exitCode on error
  // @ts-ignore - Dynamic exitCode property from SVGBBoxError or wrapped errors
  if (error && typeof error.exitCode === 'number') {
    // @ts-ignore - Dynamic exitCode property
    return error.exitCode;
  }

  // Check for SVGBBoxError code mapping
  if (error instanceof SVGBBoxError) {
    const code = error.code;

    // Map error codes to exit codes
    if (code === 'VALIDATION_ERROR') return EXIT_CODES.INVALID_ARGUMENTS;
    if (code === 'FILESYSTEM_ERROR') return EXIT_CODES.FILE_NOT_FOUND;
    if (code === 'SECURITY_ERROR') return EXIT_CODES.SECURITY_VIOLATION;
    if (code === 'BROWSER_ERROR') return EXIT_CODES.BROWSER_LAUNCH_FAILED;
    if (code === 'CONFIG_ERROR') return EXIT_CODES.CONFIG_INVALID;
    if (code === 'PROCESSING_ERROR') return EXIT_CODES.SVG_PROCESSING_ERROR;
  }

  // Check for common Node.js error codes
  // @ts-ignore - Node.js errors have code property but not typed on base Error
  if (error && error.code) {
    // @ts-ignore - Dynamic code property from Node.js errors
    if (error.code === 'ENOENT') return EXIT_CODES.FILE_NOT_FOUND;
    // @ts-ignore - Dynamic code property from Node.js errors
    if (error.code === 'EACCES') return EXIT_CODES.PERMISSION_DENIED;
    // @ts-ignore - Dynamic code property from Node.js errors
    if (error.code === 'ETIMEDOUT') return EXIT_CODES.BROWSER_TIMEOUT;
  }

  // Default to general error
  return EXIT_CODES.GENERAL_ERROR;
}

/**
 * Gets a guidance message for an error if available.
 *
 * @param {Error} error - The error
 * @returns {string|null} Guidance message or null
 */
function getGuidance(error) {
  // Check for explicit guidance on error
  // @ts-ignore - Dynamic guidance property from SVGBBoxError
  if (error && error.guidance) {
    // @ts-ignore - Dynamic guidance property
    return error.guidance;
  }

  // Generate guidance based on error message
  const msg = error && error.message ? error.message.toLowerCase() : '';

  if (
    msg.includes('no usable browser') ||
    (msg.includes('could not find') && msg.includes('browser'))
  ) {
    return 'Try running: pnpm run install-browsers';
  }
  if (msg.includes('enoent') || msg.includes('no such file')) {
    return 'Check that the file path is correct and the file exists.';
  }
  if (msg.includes('permission denied') || msg.includes('eacces')) {
    return 'Check file permissions or try running with elevated privileges.';
  }
  if (msg.includes('timeout')) {
    return 'The operation timed out. Try again or increase timeout settings.';
  }
  if (msg.includes('inkscape')) {
    return 'Inkscape is required for this operation. Install from: https://inkscape.org/';
  }

  return null;
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
  wrapError,
  getExitCode,
  getGuidance,

  // Argument parsing
  createArgParser,

  // Output formatting
  formatSuccess,
  formatError,
  formatInfo,
  formatWarning,
  formatHint,
  printSuccess,
  printError,
  printInfo,
  printWarning,
  printHint,

  // Progress
  createProgress
};
