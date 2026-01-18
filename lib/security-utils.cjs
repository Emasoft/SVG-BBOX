/**
 * Security and Validation Utilities
 *
 * Shared security functions for all SVG-BBOX CLI tools.
 * Prevents command injection, path traversal, and other vulnerabilities.
 *
 * @module security-utils
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

// ============================================================================
// EXIT CODES
// ============================================================================

/**
 * Standardized exit codes for all SVG-BBOX CLI tools.
 * Following Unix conventions: 0 = success, 1 = general error, 2+ = specific errors.
 *
 * Exit code ranges:
 * - 0: Success
 * - 1: General/unknown error
 * - 10-19: Input validation errors
 * - 20-29: File system errors
 * - 30-39: Browser/rendering errors
 * - 40-49: Processing errors
 * - 50-59: Configuration errors
 * - 60-69: Security errors
 */
const EXIT_CODES = {
  // Success
  SUCCESS: 0,

  // General errors (1-9)
  GENERAL_ERROR: 1,
  UNKNOWN_ERROR: 1,
  // WHY: FILES_DIFFER is for diff-like tools (sbb-compare) where 1 means "comparison ran but files differ"
  // This follows Unix diff convention: 0=identical, 1=differ, 2=error
  FILES_DIFFER: 1,
  // WHY: COMPARISON_ERROR is for diff-like tools where 2 means "error occurred during comparison"
  COMPARISON_ERROR: 2,

  // Input validation errors (10-19)
  INVALID_ARGUMENTS: 10,
  MISSING_REQUIRED_ARG: 11,
  INVALID_FILE_PATH: 12,
  INVALID_FILE_EXTENSION: 13,
  INVALID_SVG_FORMAT: 14,
  INVALID_JSON_FORMAT: 15,
  FILE_TOO_LARGE: 16,

  // File system errors (20-29)
  FILE_NOT_FOUND: 20,
  FILE_READ_ERROR: 21,
  FILE_WRITE_ERROR: 22,
  DIRECTORY_NOT_FOUND: 23,
  PERMISSION_DENIED: 24,

  // Browser/rendering errors (30-39)
  BROWSER_LAUNCH_FAILED: 30,
  BROWSER_TIMEOUT: 31,
  RENDERING_ERROR: 32,
  INKSCAPE_NOT_FOUND: 33,
  INKSCAPE_ERROR: 34,

  // Processing errors (40-49)
  SVG_PROCESSING_ERROR: 40,
  BBOX_CALCULATION_ERROR: 41,
  // NOTE: COMPARISON_ERROR is defined above with value 2 (Unix diff convention)
  EXTRACTION_ERROR: 43,
  CONVERSION_ERROR: 44,

  // Configuration errors (50-59)
  CONFIG_NOT_FOUND: 50,
  CONFIG_INVALID: 51,
  MISSING_DEPENDENCY: 52,

  // Security errors (60-69)
  SECURITY_VIOLATION: 60,
  PATH_TRAVERSAL: 61,
  COMMAND_INJECTION: 62
};

/**
 * Maps error codes to human-readable descriptions.
 * Used for generating helpful error messages.
 */
const EXIT_CODE_DESCRIPTIONS = {
  [EXIT_CODES.SUCCESS]: 'Operation completed successfully',
  [EXIT_CODES.GENERAL_ERROR]: 'An unexpected error occurred',
  [EXIT_CODES.INVALID_ARGUMENTS]: 'Invalid command-line arguments',
  [EXIT_CODES.MISSING_REQUIRED_ARG]: 'Missing required argument',
  [EXIT_CODES.INVALID_FILE_PATH]: 'Invalid file path',
  [EXIT_CODES.INVALID_FILE_EXTENSION]: 'Invalid file extension',
  [EXIT_CODES.INVALID_SVG_FORMAT]: 'File is not valid SVG',
  [EXIT_CODES.INVALID_JSON_FORMAT]: 'File is not valid JSON',
  [EXIT_CODES.FILE_TOO_LARGE]: 'File exceeds size limit',
  [EXIT_CODES.FILE_NOT_FOUND]: 'File not found',
  [EXIT_CODES.FILE_READ_ERROR]: 'Could not read file',
  [EXIT_CODES.FILE_WRITE_ERROR]: 'Could not write file',
  [EXIT_CODES.DIRECTORY_NOT_FOUND]: 'Directory not found',
  [EXIT_CODES.PERMISSION_DENIED]: 'Permission denied',
  [EXIT_CODES.BROWSER_LAUNCH_FAILED]: 'Could not launch browser',
  [EXIT_CODES.BROWSER_TIMEOUT]: 'Browser operation timed out',
  [EXIT_CODES.RENDERING_ERROR]: 'SVG rendering failed',
  [EXIT_CODES.INKSCAPE_NOT_FOUND]: 'Inkscape not found on system',
  [EXIT_CODES.INKSCAPE_ERROR]: 'Inkscape command failed',
  [EXIT_CODES.SVG_PROCESSING_ERROR]: 'Error processing SVG',
  [EXIT_CODES.BBOX_CALCULATION_ERROR]: 'Could not calculate bounding box',
  [EXIT_CODES.COMPARISON_ERROR]: 'SVG comparison failed',
  [EXIT_CODES.EXTRACTION_ERROR]: 'Element extraction failed',
  [EXIT_CODES.CONVERSION_ERROR]: 'File conversion failed',
  [EXIT_CODES.CONFIG_NOT_FOUND]: 'Configuration file not found',
  [EXIT_CODES.CONFIG_INVALID]: 'Invalid configuration',
  [EXIT_CODES.MISSING_DEPENDENCY]: 'Required dependency not installed',
  [EXIT_CODES.SECURITY_VIOLATION]: 'Security violation detected',
  [EXIT_CODES.PATH_TRAVERSAL]: 'Path traversal attempt blocked',
  [EXIT_CODES.COMMAND_INJECTION]: 'Command injection attempt blocked'
};

// ============================================================================
// SIGNAL EXIT CODES
// ============================================================================

/**
 * Exit codes for signal-terminated processes.
 *
 * UNIX convention: exit code = 128 + signal number.
 * This makes it easy to identify HOW a process terminated:
 *   - Exit 0-127: Normal exit (0 = success, 1+ = error)
 *   - Exit 128+: Killed by signal (subtract 128 to get signal number)
 *
 * WHY THESE SPECIFIC VALUES:
 *   - SIGHUP (1):  128 + 1 = 129 - Terminal hung up (SSH disconnect, window close)
 *   - SIGINT (2):  128 + 2 = 130 - User pressed Ctrl+C
 *   - SIGTERM (15): 128 + 15 = 143 - Graceful termination request
 *
 * DO NOT use magic numbers like 130, 143 directly in code.
 * ALWAYS use these constants for clarity and maintainability.
 */
const EXIT_CODES_SIGNAL = {
  /** SIGHUP: Terminal disconnect, SSH timeout, window close. Exit = 128 + 1 = 129 */
  SIGHUP: 129,
  /** SIGINT: User pressed Ctrl+C. Exit = 128 + 2 = 130 */
  SIGINT: 130,
  /** SIGTERM: Graceful termination request (kill, systemd stop). Exit = 128 + 15 = 143 */
  SIGTERM: 143
};

// ============================================================================
// CONSTANTS
// ============================================================================

/** Maximum allowed SVG file size (10MB) */
const MAX_SVG_SIZE = 10 * 1024 * 1024;

/** Maximum allowed JSON file size (1MB) */
const MAX_JSON_SIZE = 1 * 1024 * 1024;

/** Valid SVG file extensions */
const VALID_SVG_EXTENSIONS = ['.svg'];

/** Valid JSON file extensions */
const VALID_JSON_EXTENSIONS = ['.json'];

/** Dangerous shell metacharacters that indicate command injection attempts */
const SHELL_METACHARACTERS = /[;&|`$(){}[\]<>!\n\r]/;

/** Valid XML/SVG ID pattern (prevents injection in rename operations) */
const VALID_ID_PATTERN = /^[A-Za-z_][\w.-]*$/;

// ============================================================================
// FILE PATH VALIDATION
// ============================================================================

/**
 * Validates and sanitizes a file path to prevent path traversal and command injection.
 *
 * Security checks:
 * - No null bytes
 * - No shell metacharacters
 * - No path traversal sequences (..)
 * - Must resolve to absolute path within allowed directories
 * - Must have expected file extension
 * - TOCTOU protection via fs.realpathSync() when mustExist=true
 *
 * TOCTOU (Time-Of-Check, Time-Of-Use) RACE CONDITION FIX:
 * The original code had a race condition vulnerability:
 *   1. Check: path.resolve() normalizes path (removes ..)
 *   2. USE: fs.readFileSync() uses the normalized path
 *
 * BUT: If a symlink exists, path.resolve() doesn't follow it.
 * An attacker could create a symlink: ./safe/file.svg -> /etc/passwd
 * path.resolve() returns ./safe/file.svg (looks safe)
 * fs.readFileSync() follows the symlink and reads /etc/passwd (danger!)
 *
 * FIX: Use fs.realpathSync() which:
 *   1. Follows ALL symlinks
 *   2. Returns the ACTUAL final path
 *   3. Atomically resolves the path (no race window)
 *
 * DO NOT: Rely only on path.resolve() for security validation
 * DO: Always use fs.realpathSync() when the file must exist
 *
 * @param {string} filePath - User-provided file path
 * @param {Object} options - Validation options
 * @param {string[]|null} [options.allowedDirs=[process.cwd()]] - Allowed base directories (null to skip check)
 * @param {string[]} [options.requiredExtensions] - Required file extensions (e.g., ['.svg'])
 * @param {boolean} [options.mustExist=false] - Whether file must exist
 * @returns {string} Validated absolute file path
 * @throws {Error} If validation fails
 *
 * @example
 * const safePath = validateFilePath('../../../etc/passwd');
 * // Throws: "Path traversal detected"
 *
 * @example
 * const safePath = validateFilePath('input.svg', {
 *   requiredExtensions: ['.svg'],
 *   mustExist: true
 * });
 */
function validateFilePath(filePath, options = {}) {
  // WHY null option: allowedDirs=null means "skip directory check" (used by validateOutputPath)
  // Default is [process.cwd()] for input paths (security: prevent reading arbitrary files)
  const { allowedDirs = [process.cwd()], requiredExtensions = null, mustExist = false } = options;

  // WHY: Validate filePath is a string to prevent TypeError on .includes() call
  // Null/undefined/number/object parameters would cause runtime errors
  if (typeof filePath !== 'string') {
    throw new ValidationError('filePath must be a string');
  }

  // Check for null bytes (can cause path truncation in some languages/systems)
  if (filePath.includes('\0')) {
    throw new ValidationError('Invalid file path: null byte detected');
  }

  // Check for shell metacharacters (command injection attempt)
  // These characters could be dangerous if path is ever used in shell commands
  if (SHELL_METACHARACTERS.test(filePath)) {
    throw new ValidationError('Invalid file path: contains shell metacharacters');
  }

  // Initial resolution using path.resolve (doesn't follow symlinks)
  // This is just for initial validation - NOT the final path we return
  const resolved = path.resolve(filePath);
  const normalized = path.normalize(resolved);

  // For files that must exist, use realpathSync to:
  // 1. Verify the file actually exists
  // 2. Resolve ALL symlinks atomically (TOCTOU protection)
  // 3. Get the true canonical path
  let finalPath = normalized;
  if (mustExist) {
    try {
      // fs.realpathSync follows symlinks and returns canonical path
      // This prevents TOCTOU attacks where symlinks point outside allowed dirs
      finalPath = fs.realpathSync(normalized);
    } catch (err) {
      // File doesn't exist or is inaccessible
      // Type guard for Node.js filesystem errors with code property
      const fsErr = /** @type {NodeJS.ErrnoException} */ (err);
      if (fsErr.code === 'ENOENT') {
        throw new FileSystemError(`File not found: ${normalized}`);
      }
      // Permission denied or other error
      throw new FileSystemError(`Cannot access file: ${normalized} (${fsErr.code})`);
    }
  }

  // Check for path traversal using the REAL path (after symlink resolution)
  // This is the critical security check that prevents symlink attacks
  // WHY allowedDirs !== null check: null means "skip directory check" (for output paths)
  if (allowedDirs !== null) {
    const relativePath = path.relative(process.cwd(), finalPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      // Check if within allowed directories
      const isAllowed = allowedDirs.some((dir) => {
        // WHY: Validate each dir is a string to prevent TypeError in path.resolve() and fs operations
        // allowedDirs array may contain null/undefined/non-string values from user input
        if (typeof dir !== 'string') {
          throw new ValidationError('allowedDirs must contain only strings');
        }

        // Also resolve allowed directories to their real paths for accurate comparison
        let normalizedDir;
        try {
          // For directories that exist, get their real path too
          normalizedDir = fs.existsSync(dir)
            ? fs.realpathSync(dir)
            : path.normalize(path.resolve(dir));
        } catch {
          normalizedDir = path.normalize(path.resolve(dir));
        }
        return finalPath.startsWith(normalizedDir + path.sep) || finalPath === normalizedDir;
      });

      if (!isAllowed) {
        throw new ValidationError('File path outside allowed directories');
      }
    }
  }

  // Check file extension if required
  // Use the final path to prevent extension spoofing via symlinks
  if (requiredExtensions) {
    const ext = path.extname(finalPath).toLowerCase();
    if (!requiredExtensions.includes(ext)) {
      throw new ValidationError(
        `Invalid file extension. Expected: ${requiredExtensions.join(', ')}`
      );
    }
  }

  // Return the canonical path (with symlinks resolved if file exists)
  return finalPath;
}

/**
 * Validates an output file path for write operations.
 * More permissive than validateFilePath - allows creating new files
 * and does NOT restrict directories by default (user specifies output location).
 *
 * WHY no allowedDirs by default: Output paths are less risky than input paths.
 * - Input: could read sensitive files (security risk) → restrict to allowedDirs
 * - Output: user specifies where they want output (their choice) → no restriction
 *
 * @param {string} filePath - Output file path
 * @param {Object} options - Validation options
 * @returns {string} Validated absolute file path
 * @throws {Error} If validation fails
 */
function validateOutputPath(filePath, options = {}) {
  // WHY null: Skip allowedDirs check for output paths by default
  // User can still pass allowedDirs explicitly if they want to restrict output location
  return validateFilePath(filePath, {
    allowedDirs: null,
    ...options,
    mustExist: false
  });
}

// ============================================================================
// SVG CONTENT VALIDATION AND SANITIZATION
// ============================================================================

/**
 * Reads and validates an SVG file safely.
 *
 * Security checks:
 * - File size limit
 * - Valid SVG format
 * - File extension validation
 *
 * @param {string} filePath - Path to SVG file
 * @returns {string} SVG file contents
 * @throws {Error} If validation fails
 */
function readSVGFileSafe(filePath) {
  // Validate path
  const safePath = validateFilePath(filePath, {
    requiredExtensions: VALID_SVG_EXTENSIONS,
    mustExist: true
  });

  // Check file size
  const stats = fs.statSync(safePath);
  if (stats.size > MAX_SVG_SIZE) {
    throw new Error(`SVG file too large: ${stats.size} bytes (maximum: ${MAX_SVG_SIZE} bytes)`);
  }

  // Read content
  const content = fs.readFileSync(safePath, 'utf8');

  // Basic SVG format validation
  if (!content.trim().startsWith('<') || !content.includes('<svg')) {
    throw new Error('File does not appear to be valid SVG');
  }

  return content;
}

/**
 * Sanitizes SVG content to remove potentially dangerous elements.
 *
 * Removes:
 * - <script> elements
 * - Event handler attributes (onclick, onload, etc.)
 * - javascript: URIs in href/xlink:href
 * - data: URIs that could contain encoded scripts (data:text/html, data:image/svg+xml with scripts)
 * - <foreignObject> elements (can contain HTML/scripts)
 *
 * Note: This is a basic sanitization. For complete security,
 * use a dedicated library like DOMPurify in browser context.
 *
 * @param {string} svgContent - SVG content to sanitize
 * @returns {string} Sanitized SVG content
 */
function sanitizeSVGContent(svgContent) {
  let sanitized = svgContent;

  // WHY: ReDoS vulnerability fix - the original regex had nested quantifiers that could cause
  // catastrophic backtracking on malicious input (e.g., many unclosed < characters).
  // This simpler regex matches opening tag, captures everything until closing tag without backtracking.
  // It's safer because [\s\S]*? matches any character (including newlines) non-greedily without complex lookaheads.
  sanitized = sanitized.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

  // Remove event handler attributes (onclick, onload, etc.)
  // Match: on<eventname>="value" or on<eventname>='value' or on<eventname>=value
  sanitized = sanitized.replace(/\s+on\w+\s*=\s*"[^"]*"/gi, '');
  sanitized = sanitized.replace(/\s+on\w+\s*=\s*'[^']*'/gi, '');
  sanitized = sanitized.replace(/\s+on\w+\s*=\s*[^\s/>]+/gi, '');

  // Remove javascript: URIs
  sanitized = sanitized.replace(/href\s*=\s*["']javascript:[^"']*["']/gi, 'href=""');
  sanitized = sanitized.replace(/xlink:href\s*=\s*["']javascript:[^"']*["']/gi, 'xlink:href=""');

  // WHY: data: URIs can contain base64-encoded HTML/JavaScript that executes when rendered.
  // Examples of dangerous data URIs:
  // - data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg== (encoded <script>alert(1)</script>)
  // - data:image/svg+xml;base64,... (SVG can contain <script> tags)
  // - data:text/javascript;base64,... (direct JavaScript code)
  // We remove data: URIs with these MIME types to prevent script injection attacks.
  sanitized = sanitized.replace(
    /href\s*=\s*["']data:(?:text\/html|text\/javascript|application\/x-javascript|image\/svg\+xml)[^"']*["']/gi,
    'href=""'
  );
  sanitized = sanitized.replace(
    /xlink:href\s*=\s*["']data:(?:text\/html|text\/javascript|application\/x-javascript|image\/svg\+xml)[^"']*["']/gi,
    'xlink:href=""'
  );

  // WHY: foreignObject can embed arbitrary HTML/scripts in SVG. Same ReDoS fix as script tag.
  // Use simpler pattern: opening tag, any content, closing tag without complex lookaheads.
  sanitized = sanitized.replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject>/gi, '');

  return sanitized;
}

// ============================================================================
// JSON VALIDATION
// ============================================================================

/** @type {Set<string>} */
const DANGEROUS_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Recursively checks an object for prototype pollution attempts.
 *
 * SECURITY FIX: The previous implementation only checked top-level keys.
 * This recursive implementation catches nested attacks like:
 *   {"nested": {"__proto__": {"polluted": true}}}
 *
 * @param {unknown} obj - Object to check (can be any JSON value)
 * @param {string[]} path - Current path for error messages
 * @throws {Error} If prototype pollution is detected
 */
function checkPrototypePollution(obj, path) {
  // Only check objects and arrays (not primitives)
  if (obj === null || typeof obj !== 'object') {
    return;
  }

  // For arrays, recursively check each element
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      checkPrototypePollution(obj[i], [...path, `[${i}]`]);
    }
    return;
  }

  // For objects, check each key and recursively check values
  // Cast to Record after type guards narrow obj to non-null, non-array object
  const record = /** @type {Record<string, unknown>} */ (obj);
  for (const key of Object.keys(record)) {
    if (DANGEROUS_PROTO_KEYS.has(key)) {
      const location = path.length > 0 ? ` at ${path.join('.')}` : '';
      throw new Error(`Invalid JSON: prototype pollution detected (key "${key}"${location})`);
    }
    // Recursively check nested objects
    checkPrototypePollution(record[key], [...path, key]);
  }
}

/**
 * Reads and validates a JSON file safely.
 *
 * Security checks:
 * - File size limit
 * - Valid JSON format
 * - Prototype pollution prevention
 *
 * @param {string} filePath - Path to JSON file
 * @param {((data: unknown) => void) | null} [validator=null] - Optional validation function for parsed data
 * @returns {unknown} Parsed JSON data
 * @throws {Error} If validation fails
 */
function readJSONFileSafe(filePath, validator = null) {
  // Validate path
  const safePath = validateFilePath(filePath, {
    requiredExtensions: VALID_JSON_EXTENSIONS,
    mustExist: true
  });

  // Check file size
  const stats = fs.statSync(safePath);
  if (stats.size > MAX_JSON_SIZE) {
    throw new Error(`JSON file too large: ${stats.size} bytes (maximum: ${MAX_JSON_SIZE} bytes)`);
  }

  // Read and parse
  const content = fs.readFileSync(safePath, 'utf8');
  let parsed;

  try {
    parsed = JSON.parse(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON file: ${message}`);
  }

  // Prevent prototype pollution - RECURSIVE check for nested objects
  // This prevents attacks like: {"nested": {"__proto__": {"polluted": true}}}
  checkPrototypePollution(parsed, []);

  // Run custom validator if provided
  if (validator && typeof validator === 'function') {
    validator(parsed);
  }

  return parsed;
}

/**
 * Validates a rename mapping structure from JSON.
 *
 * Expected format:
 * - Array of {from, to} objects
 * - Object with "mappings" array property
 * - Object with key-value pairs
 *
 * FAIL FAST PRINCIPLE (2024-11 FIX):
 * The original code silently skipped invalid entries with `continue`.
 * This violates the fail-fast principle - invalid input should cause errors,
 * not be silently ignored. Silent skipping leads to:
 *   1. User confusion: "Why wasn't my mapping applied?"
 *   2. Hidden bugs: Typos in mapping files go unnoticed
 *   3. Debugging difficulty: No indication of what was wrong
 *
 * DO NOT: Use `continue` to skip invalid data
 * DO: Collect all errors and report them together (better UX)
 * DO: Fail loudly so users know exactly what's wrong
 *
 * @param {*} data - Parsed JSON data
 * @returns {Array<{from: string, to: string}>} Validated mappings
 * @throws {Error} If validation fails (with details about ALL invalid entries)
 */
function validateRenameMapping(data) {
  let mappings = [];

  // Handle different input formats
  if (Array.isArray(data)) {
    mappings = data;
  } else if (data && Array.isArray(data.mappings)) {
    mappings = data.mappings;
  } else if (data && typeof data === 'object') {
    mappings = Object.entries(data).map(([from, to]) => ({ from, to }));
  } else {
    throw new ValidationError(
      'Invalid rename mapping format. Expected: array of {from, to} objects, object with "mappings" array, or key-value object.'
    );
  }

  // Validate each mapping - collect ALL errors instead of failing on first
  // This is better UX: users see all problems at once, not one at a time
  const validated = [];
  const errors = [];

  for (let i = 0; i < mappings.length; i++) {
    const mapping = mappings[i];
    const index = i + 1; // 1-based for human readability

    // Check mapping structure
    if (!mapping || typeof mapping !== 'object') {
      // FAIL FAST: Don't silently skip, report the error
      errors.push(
        `Entry ${index}: Invalid structure (expected object with from/to properties, got ${typeof mapping})`
      );
      continue;
    }

    const from = typeof mapping.from === 'string' ? mapping.from.trim() : '';
    const to = typeof mapping.to === 'string' ? mapping.to.trim() : '';

    // Check for empty values
    if (!from && !to) {
      // FAIL FAST: Don't silently skip, report the error
      errors.push(`Entry ${index}: Both 'from' and 'to' are empty or missing`);
      continue;
    }
    if (!from) {
      errors.push(`Entry ${index}: Missing 'from' value (to="${to}")`);
      continue;
    }
    if (!to) {
      errors.push(`Entry ${index}: Missing 'to' value (from="${from}")`);
      continue;
    }

    // Validate ID syntax to prevent injection
    if (!VALID_ID_PATTERN.test(from)) {
      errors.push(
        `Entry ${index}: Invalid ID format (from="${from}"). IDs must start with a letter or underscore, followed by letters, digits, underscores, periods, or hyphens.`
      );
      continue;
    }

    if (!VALID_ID_PATTERN.test(to)) {
      errors.push(
        `Entry ${index}: Invalid ID format (to="${to}"). IDs must start with a letter or underscore, followed by letters, digits, underscores, periods, or hyphens.`
      );
      continue;
    }

    validated.push({ from, to });
  }

  // Report all errors at once (better UX than failing on first error)
  if (errors.length > 0) {
    const summary =
      errors.length === 1
        ? 'Invalid rename mapping:\n'
        : `Found ${errors.length} invalid rename mappings:\n`;
    throw new ValidationError(summary + errors.map((e) => `  - ${e}`).join('\n'));
  }

  if (validated.length === 0) {
    throw new ValidationError(
      'No rename mappings provided. Expected at least one {from, to} mapping.'
    );
  }

  return validated;
}

// ============================================================================
// TEMPORARY FILE MANAGEMENT
// ============================================================================

/**
 * Registry of temp directories that need cleanup on process exit.
 *
 * WHY A REGISTRY PATTERN:
 * The original code added new signal handlers for EACH call to createSecureTempDir().
 * This caused a memory leak: if called 100 times, 300 handlers would accumulate.
 * The registry pattern:
 *   1. Adds signal handlers ONCE (on first temp dir creation)
 *   2. Tracks all temp dirs in a Set
 *   3. Cleans up ALL temp dirs when any signal fires
 *
 * DO NOT: Add process.on() handlers inside createSecureTempDir()
 * DO: Add temp dirs to this registry and let the global handlers clean them up
 *
 * @type {Set<string>}
 */
const _tempDirRegistry = new Set();

/**
 * Flag to track if signal handlers have been registered.
 * We only want to register them ONCE, no matter how many temp dirs are created.
 *
 * @type {boolean}
 */
let _signalHandlersRegistered = false;

/**
 * Cleans up all registered temp directories.
 * Called by signal handlers and process exit.
 *
 * ERROR HANDLING STRATEGY:
 * - ENOENT (file not found): Silent skip - directory already deleted, no problem
 * - Other errors: Write to stderr (not console.error) for CI visibility
 *
 * WHY STDERR INSTEAD OF CONSOLE.ERROR:
 * - console.error can be suppressed in some test frameworks
 * - process.stderr.write guarantees output even in CI environments
 * - Cleanup errors should never be silently ignored
 */
function _cleanupAllTempDirs() {
  for (const tempDir of _tempDirRegistry) {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
      // Remove from registry after successful cleanup
      _tempDirRegistry.delete(tempDir);
    } catch (err) {
      // ENOENT means directory already deleted - not an error
      // This can happen if cleanup runs multiple times or user deleted manually
      // Type guard for Node.js filesystem errors with code property
      const fsErr = /** @type {NodeJS.ErrnoException} */ (err);
      if (fsErr.code !== 'ENOENT') {
        // Use process.stderr.write for guaranteed visibility in CI
        // console.error can be suppressed by test frameworks
        const message = fsErr.message || String(err);
        process.stderr.write(
          `[svg-bbox] Warning: Failed to cleanup temp directory ${tempDir}: ${message}\n`
        );
      }
      // Remove from registry even on error to prevent infinite retry loops
      _tempDirRegistry.delete(tempDir);
    }
  }
}

/**
 * Registers global signal handlers for temp directory cleanup.
 * Called ONCE on first temp dir creation.
 *
 * SIGNALS HANDLED:
 * - SIGINT (Ctrl+C): User wants to stop immediately
 * - SIGTERM: Graceful shutdown request (systemd, docker, kill)
 * - SIGHUP: Terminal disconnect (SSH timeout, window close)
 * - exit: Normal process exit
 *
 * WHY SIGHUP IS CRITICAL:
 * Without SIGHUP handler, if user closes terminal window or SSH disconnects,
 * the process dies WITHOUT running any cleanup, leaving orphaned temp dirs.
 *
 * EXIT CODES:
 * Uses EXIT_CODES_SIGNAL constants (128 + signal number) per Unix convention.
 * This allows parent processes to know HOW the child terminated.
 */
function _registerSignalHandlers() {
  if (_signalHandlersRegistered) {
    return; // Already registered, don't add duplicate handlers
  }
  _signalHandlersRegistered = true;

  // Use 'once' for exit - it only fires once anyway, but makes intent clear
  process.once('exit', _cleanupAllTempDirs);

  // For signals, we need to cleanup AND re-raise the signal
  // This ensures parent processes see the correct exit code
  process.once('SIGINT', () => {
    _cleanupAllTempDirs();
    // Use signal exit code constant, not magic number
    process.exit(EXIT_CODES_SIGNAL.SIGINT);
  });

  process.once('SIGTERM', () => {
    _cleanupAllTempDirs();
    // Use signal exit code constant, not magic number
    process.exit(EXIT_CODES_SIGNAL.SIGTERM);
  });

  // CRITICAL: SIGHUP handler for terminal disconnect
  // Without this, SSH disconnects and terminal closes leave orphaned temp dirs
  process.once('SIGHUP', () => {
    _cleanupAllTempDirs();
    // Use signal exit code constant, not magic number
    process.exit(EXIT_CODES_SIGNAL.SIGHUP);
  });
}

/**
 * Creates a secure temporary directory with random name and restricted permissions.
 *
 * Security features:
 * - Random suffix (32 hex chars) prevents prediction attacks
 * - Created in OS temp directory (os.tmpdir())
 * - Restricted permissions (0700 - owner only on Unix)
 * - Automatic cleanup on process exit, SIGINT, SIGTERM, SIGHUP
 *
 * MEMORY LEAK FIX (2024-11):
 * The original implementation added 3 signal handlers per call, causing
 * memory leaks when called multiple times. Now uses a registry pattern:
 * signal handlers are registered ONCE, and all temp dirs are tracked in a Set.
 *
 * @param {string} [prefix='svg-bbox'] - Directory name prefix
 * @returns {string} Path to created temporary directory
 *
 * @example
 * const tempDir = createSecureTempDir('sbb-extract');
 * // Use tempDir for temporary files...
 * // Automatic cleanup on process exit or signals
 */
function createSecureTempDir(prefix = 'svg-bbox') {
  // Generate cryptographically random suffix to prevent prediction
  const randomSuffix = crypto.randomBytes(16).toString('hex');
  const tempDir = path.join(os.tmpdir(), `${prefix}-${randomSuffix}`);

  // Create with restricted permissions (700 = rwx------)
  // On Windows, mode is ignored but directory is still created
  fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });

  // Register this temp dir for cleanup
  // The registry pattern prevents memory leaks from multiple signal handlers
  _tempDirRegistry.add(tempDir);

  // Register global signal handlers (only once, no matter how many temp dirs)
  _registerSignalHandlers();

  return tempDir;
}

/**
 * Creates a secure temporary file path.
 *
 * @param {string} [extension=''] - File extension (e.g., '.svg')
 * @param {string} [prefix='tmp'] - Filename prefix
 * @returns {string} Path to temporary file
 */
function createSecureTempFile(extension = '', prefix = 'tmp') {
  const randomName = crypto.randomBytes(16).toString('hex');
  const filename = `${prefix}-${randomName}${extension}`;
  return path.join(os.tmpdir(), filename);
}

// ============================================================================
// SAFE DIRECTORY OPERATIONS
// ============================================================================

/**
 * Ensures a directory exists, creating it if necessary.
 * Handles race conditions properly.
 *
 * @param {string} dirPath - Directory path
 * @throws {Error} If directory cannot be created
 */
function ensureDirectoryExists(dirPath) {
  // WHY: Validate dirPath is a string to prevent TypeError in fs.mkdirSync() and error messages
  // Null/undefined/non-string parameters would cause runtime errors or incorrect error reporting
  if (typeof dirPath !== 'string') {
    throw new ValidationError('dirPath must be a string');
  }

  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (err) {
    // Ignore EEXIST errors (directory already exists)
    // Type guard for Node.js filesystem errors with code property
    const fsErr = /** @type {NodeJS.ErrnoException} */ (err);
    if (fsErr.code !== 'EEXIST') {
      const message = fsErr.message || String(err);
      throw new Error(`Failed to create directory ${dirPath}: ${message}`);
    }
  }
}

/**
 * @typedef {Object} WriteFileSafeOptions
 * @property {boolean} [backup=false] - Create .bak backup before overwriting
 * @property {BufferEncoding} [encoding] - File encoding
 * @property {number} [mode] - File mode (permission bits)
 * @property {string} [flag] - File system flag (default 'w')
 */

/**
 * Safely writes content to a file, ensuring the directory exists.
 * Optionally creates a backup of the original file before overwriting.
 *
 * @param {string} filePath - Output file path
 * @param {string|Buffer} content - Content to write
 * @param {WriteFileSafeOptions|BufferEncoding} [options={}] - Write options or encoding string
 * @throws {Error} If write fails
 */
function writeFileSafe(filePath, content, options = {}) {
  const dir = path.dirname(filePath);
  ensureDirectoryExists(dir);

  // WHY: Handle both string encoding (e.g., 'utf-8') and options object
  // fs.writeFileSync accepts both, so we need to extract backup flag properly
  let backup = false;
  /** @type {import('fs').WriteFileOptions | undefined} */
  let writeOptions;

  if (typeof options === 'string') {
    // WHY: String options are encoding strings like 'utf-8'
    writeOptions = options;
  } else if (typeof options === 'object' && options !== null) {
    // WHY: Cast to WriteFileSafeOptions to access backup property
    const opts = /** @type {WriteFileSafeOptions} */ (options);
    backup = opts.backup === true;
    // WHY: Remove backup from options passed to fs.writeFileSync (it doesn't recognize it)
    // Destructure to get fs-compatible options
    const { backup: _backup, ...fsOptions } = opts;
    writeOptions = Object.keys(fsOptions).length > 0 ? fsOptions : undefined;
  }

  // WHY: Create backup BEFORE writing to preserve original content
  // Only backup if file exists and backup option is enabled
  if (backup && fs.existsSync(filePath)) {
    const backupPath = filePath + '.bak';
    try {
      fs.copyFileSync(filePath, backupPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to create backup ${backupPath}: ${message}`);
    }
  }

  try {
    fs.writeFileSync(filePath, content, writeOptions);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to write file ${filePath}: ${message}`);
  }
}

// ============================================================================
// ESCAPE FUNCTIONS FOR SHELL COMMANDS
// ============================================================================
// SECURITY WARNING: Shell escaping is inherently error-prone and context-dependent.
// These functions are DEPRECATED and should not be used for security-critical code.
// SAFE ALTERNATIVE: Use child_process.spawn() or child_process.execFile() with
// array arguments instead of shell escaping. Example:
//   spawn('cmd', ['/c', 'program.exe', filePath])  // Windows
//   spawn('program', [filePath])                    // Unix
// This avoids shell interpretation entirely and is the only reliable approach.
// ============================================================================

/**
 * Escapes a file path for safe use in Windows cmd.exe.
 *
 * @deprecated SECURITY WARNING: This function uses CSV-style double-quote escaping
 * which is INCORRECT for cmd.exe. Windows shell escaping is highly context-dependent
 * and this implementation may allow command injection attacks.
 *
 * VULNERABILITY: Uses `""` escaping (CSV-style) instead of proper cmd.exe escaping.
 * Exploit example: `test".exe` becomes `"test"".exe"` which cmd.exe misinterprets.
 *
 * SAFE ALTERNATIVE: Use child_process.spawn() or execFile() with array arguments:
 *   spawn('cmd', ['/c', 'program.exe', filePath])
 * This bypasses shell interpretation entirely.
 *
 * @param {string} filePath - File path to escape
 * @returns {string} Escaped file path (UNSAFE - see deprecation warning)
 */
function escapeWindowsPath(filePath) {
  // DEPRECATED: This escaping method is incorrect for cmd.exe
  console.warn(
    'DEPRECATED: escapeWindowsPath() is unsafe. Use child_process.spawn() with array arguments instead.'
  );
  // Wrap in quotes and escape embedded quotes (CSV-style, NOT safe for cmd.exe)
  return `"${filePath.replace(/"/g, '""')}"`;
}

/**
 * Escapes a file path for safe use in Unix shell commands.
 *
 * @deprecated SECURITY WARNING: This function is INCOMPLETE and does not escape
 * all dangerous shell metacharacters. Missing characters include: * ? & ; | < > ( ) { } # ~
 *
 * VULNERABILITY: Glob patterns like `file*.txt` or command injection like `file;rm -rf /`
 * will NOT be properly escaped, potentially allowing arbitrary command execution.
 *
 * SAFE ALTERNATIVE: Use child_process.spawn() or execFile() with array arguments:
 *   spawn('program', [filePath])
 * This bypasses shell interpretation entirely.
 *
 * @param {string} filePath - File path to escape
 * @returns {string} Escaped file path (UNSAFE - see deprecation warning)
 */
function escapeUnixPath(filePath) {
  // DEPRECATED: This escaping is incomplete - missing: * ? & ; | < > ( ) { } # ~
  console.warn(
    'DEPRECATED: escapeUnixPath() is unsafe. Use child_process.spawn() with array arguments instead.'
  );
  // Escape only some special characters (INCOMPLETE - not safe for security-critical use)
  return filePath.replace(/(["\s'$`\\!])/g, '\\$1');
}

// ============================================================================
// ERROR CLASSES
// ============================================================================

/**
 * Base error class for SVG-BBOX errors.
 */
class SVGBBoxError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} [code='UNKNOWN'] - Error code
   * @param {Record<string, unknown>} [details={}] - Additional error details
   */
  constructor(message, code = 'UNKNOWN', details = {}) {
    super(message);
    this.name = 'SVGBBoxError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Validation error - invalid input data.
 */
class ValidationError extends SVGBBoxError {
  /**
   * @param {string} message - Error message
   * @param {Record<string, unknown>} [details={}] - Additional error details
   */
  constructor(message, details = {}) {
    super(message, 'VALIDATION_ERROR', details);
    this.name = 'ValidationError';
  }
}

/**
 * File system error - file operations failed.
 */
class FileSystemError extends SVGBBoxError {
  /**
   * @param {string} message - Error message
   * @param {Record<string, unknown>} [details={}] - Additional error details
   */
  constructor(message, details = {}) {
    super(message, 'FILESYSTEM_ERROR', details);
    this.name = 'FileSystemError';
  }
}

/**
 * Security error - security violation detected.
 */
class SecurityError extends SVGBBoxError {
  /**
   * @param {string} message - Error message
   * @param {Record<string, unknown>} [details={}] - Additional error details
   */
  constructor(message, details = {}) {
    super(message, 'SECURITY_ERROR', details);
    this.name = 'SecurityError';
  }
}

/**
 * @typedef {Object} BrowserErrorDetails
 * @property {string} [browser] - Browser that failed (e.g., 'chrome', 'inkscape')
 * @property {string} [operation] - Operation that failed (launch, navigate, etc.)
 */

/**
 * Browser error - browser launch or operation failed.
 * Includes guidance messages for common issues.
 */
class BrowserError extends SVGBBoxError {
  /**
   * @param {string} message - Error message
   * @param {BrowserErrorDetails} [details={}] - Additional error details
   */
  constructor(message, details = {}) {
    super(message, 'BROWSER_ERROR', details);
    this.name = 'BrowserError';
    this.exitCode = EXIT_CODES.BROWSER_LAUNCH_FAILED;

    // Add guidance based on the error type
    this.guidance = BrowserError.getGuidance(message, details);
  }

  /**
   * Get helpful guidance message based on error context.
   * @param {string} message - Error message
   * @param {BrowserErrorDetails} details - Error details
   * @returns {string|null} Guidance message or null
   */
  static getGuidance(message, details) {
    const lowerMsg = message.toLowerCase();

    if (lowerMsg.includes('no usable browser') || lowerMsg.includes('could not find')) {
      return 'Try running: bun run install-browsers';
    }
    if (lowerMsg.includes('timeout')) {
      return 'The browser operation timed out. Try increasing the timeout or check system resources.';
    }
    if (lowerMsg.includes('crash') || lowerMsg.includes('gpu')) {
      return 'Browser crashed. Try running with --disable-gpu flag or check available memory.';
    }
    if (details.browser === 'inkscape' && lowerMsg.includes('not found')) {
      return 'Inkscape is required for this operation. Install it from: https://inkscape.org/';
    }

    return null;
  }
}

/**
 * @typedef {Object} ConfigErrorDetails
 * @property {string} [configPath] - Path to config file
 * @property {string} [setting] - Specific setting that's invalid
 */

/**
 * Configuration error - configuration file or settings issue.
 */
class ConfigError extends SVGBBoxError {
  /**
   * @param {string} message - Error message
   * @param {ConfigErrorDetails} [details={}] - Additional error details
   */
  constructor(message, details = {}) {
    super(message, 'CONFIG_ERROR', details);
    this.name = 'ConfigError';
    this.exitCode = EXIT_CODES.CONFIG_INVALID;

    // Add guidance based on the error type
    this.guidance = ConfigError.getGuidance(message, details);
  }

  /**
   * Get helpful guidance message based on error context.
   * @param {string} _message - Error message (unused but kept for consistent API)
   * @param {ConfigErrorDetails} details - Error details
   * @returns {string} Guidance message
   */
  static getGuidance(_message, details) {
    if (details.configPath) {
      return `Check the configuration file at: ${details.configPath}`;
    }
    if (details.setting) {
      return `The setting "${details.setting}" has an invalid value. Check the documentation.`;
    }

    return 'Check the configuration file format and values.';
  }
}

/**
 * @typedef {Object} ProcessingErrorDetails
 * @property {string} [operation] - Operation that failed
 * @property {string} [file] - File being processed
 */

/**
 * Processing error - SVG processing or bbox calculation failed.
 */
class ProcessingError extends SVGBBoxError {
  /**
   * @param {string} message - Error message
   * @param {ProcessingErrorDetails} [details={}] - Additional error details
   */
  constructor(message, details = {}) {
    super(message, 'PROCESSING_ERROR', details);
    this.name = 'ProcessingError';
    this.exitCode = EXIT_CODES.SVG_PROCESSING_ERROR;

    // Add guidance based on the error type
    this.guidance = ProcessingError.getGuidance(message, details);
  }

  /**
   * Get helpful guidance message based on error context.
   * @param {string} message - Error message
   * @param {ProcessingErrorDetails} details - Error details
   * @returns {string|null} Guidance message or null
   */
  static getGuidance(message, details) {
    const lowerMsg = message.toLowerCase();

    if (lowerMsg.includes('viewbox')) {
      return 'The SVG may be missing a viewBox. Try: sbb-fix-viewbox <file.svg>';
    }
    if (lowerMsg.includes('empty') || lowerMsg.includes('no elements')) {
      return 'The SVG appears to have no visible content. Check the file structure.';
    }
    if (details.file) {
      return `Error occurred while processing: ${details.file}`;
    }

    return null;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Exit codes
  EXIT_CODES,
  EXIT_CODE_DESCRIPTIONS,
  EXIT_CODES_SIGNAL,

  // Constants
  MAX_SVG_SIZE,
  MAX_JSON_SIZE,
  VALID_SVG_EXTENSIONS,
  VALID_JSON_EXTENSIONS,
  SHELL_METACHARACTERS,
  VALID_ID_PATTERN,

  // Path validation
  validateFilePath,
  validateOutputPath,

  // SVG operations
  readSVGFileSafe,
  sanitizeSVGContent,

  // JSON operations
  readJSONFileSafe,
  validateRenameMapping,

  // Temporary files
  createSecureTempDir,
  createSecureTempFile,

  // Directory operations
  ensureDirectoryExists,
  writeFileSafe,

  // Shell escaping
  escapeWindowsPath,
  escapeUnixPath,

  // Error classes
  SVGBBoxError,
  ValidationError,
  FileSystemError,
  SecurityError,
  BrowserError,
  ConfigError,
  ProcessingError
};
