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
 *
 * @param {string} filePath - User-provided file path
 * @param {Object} options - Validation options
 * @param {string[]} [options.allowedDirs=[process.cwd()]] - Allowed base directories
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
  const {
    allowedDirs = [process.cwd()],
    requiredExtensions = null,
    mustExist = false
  } = options;

  // Check for null bytes
  if (filePath.includes('\0')) {
    throw new Error('Invalid file path: null byte detected');
  }

  // Check for shell metacharacters (command injection attempt)
  if (SHELL_METACHARACTERS.test(filePath)) {
    throw new Error('Invalid file path: contains shell metacharacters');
  }

  // Resolve to absolute path
  const resolved = path.resolve(filePath);
  const normalized = path.normalize(resolved);

  // Check for path traversal
  const relativePath = path.relative(process.cwd(), normalized);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    // Check if within allowed directories
    const isAllowed = allowedDirs.some(dir => {
      const normalizedDir = path.normalize(path.resolve(dir));
      return normalized.startsWith(normalizedDir + path.sep) ||
             normalized === normalizedDir;
    });

    if (!isAllowed) {
      throw new Error('File path outside allowed directories');
    }
  }

  // Check file extension if required
  if (requiredExtensions) {
    const ext = path.extname(normalized).toLowerCase();
    if (!requiredExtensions.includes(ext)) {
      throw new Error(`Invalid file extension. Expected: ${requiredExtensions.join(', ')}`);
    }
  }

  // Check if file exists if required
  if (mustExist && !fs.existsSync(normalized)) {
    throw new Error(`File not found: ${normalized}`);
  }

  return normalized;
}

/**
 * Validates an output file path for write operations.
 * More permissive than validateFilePath - allows creating new files.
 *
 * @param {string} filePath - Output file path
 * @param {Object} options - Validation options
 * @returns {string} Validated absolute file path
 * @throws {Error} If validation fails
 */
function validateOutputPath(filePath, options = {}) {
  return validateFilePath(filePath, {
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
    throw new Error(
      `SVG file too large: ${stats.size} bytes (maximum: ${MAX_SVG_SIZE} bytes)`
    );
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

  // Remove <script> tags and their content
  sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

  // Remove event handler attributes
  sanitized = sanitized.replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '');
  sanitized = sanitized.replace(/\son\w+\s*=\s*[^\s>]+/gi, '');

  // Remove javascript: URIs
  sanitized = sanitized.replace(/href\s*=\s*["']javascript:[^"']*["']/gi, 'href=""');
  sanitized = sanitized.replace(/xlink:href\s*=\s*["']javascript:[^"']*["']/gi, 'xlink:href=""');

  // Remove <foreignObject> elements (can contain HTML)
  sanitized = sanitized.replace(/<foreignObject\b[^<]*(?:(?!<\/foreignObject>)<[^<]*)*<\/foreignObject>/gi, '');

  return sanitized;
}

// ============================================================================
// JSON VALIDATION
// ============================================================================

/**
 * Reads and validates a JSON file safely.
 *
 * Security checks:
 * - File size limit
 * - Valid JSON format
 * - Prototype pollution prevention
 *
 * @param {string} filePath - Path to JSON file
 * @param {Function} [validator] - Optional validation function for parsed data
 * @returns {*} Parsed JSON data
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
    throw new Error(
      `JSON file too large: ${stats.size} bytes (maximum: ${MAX_JSON_SIZE} bytes)`
    );
  }

  // Read and parse
  const content = fs.readFileSync(safePath, 'utf8');
  let parsed;

  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Invalid JSON file: ${err.message}`);
  }

  // Prevent prototype pollution
  if (parsed && typeof parsed === 'object') {
    if (parsed.hasOwnProperty('__proto__') ||
        parsed.hasOwnProperty('constructor') ||
        parsed.hasOwnProperty('prototype')) {
      throw new Error('Invalid JSON: prototype pollution detected');
    }
  }

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
 * @param {*} data - Parsed JSON data
 * @returns {Array<{from: string, to: string}>} Validated mappings
 * @throws {Error} If validation fails
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
    throw new Error('Invalid rename mapping format');
  }

  // Validate each mapping
  const validated = [];

  for (const mapping of mappings) {
    if (!mapping || typeof mapping !== 'object') {
      continue;  // Skip invalid entries
    }

    const from = typeof mapping.from === 'string' ? mapping.from.trim() : '';
    const to = typeof mapping.to === 'string' ? mapping.to.trim() : '';

    if (!from || !to) {
      continue;  // Skip empty mappings
    }

    // Validate ID syntax to prevent injection
    if (!VALID_ID_PATTERN.test(from)) {
      throw new Error(`Invalid ID format (from): "${from}". IDs must start with a letter or underscore, followed by letters, digits, underscores, periods, or hyphens.`);
    }

    if (!VALID_ID_PATTERN.test(to)) {
      throw new Error(`Invalid ID format (to): "${to}". IDs must start with a letter or underscore, followed by letters, digits, underscores, periods, or hyphens.`);
    }

    validated.push({ from, to });
  }

  if (validated.length === 0) {
    throw new Error('No valid rename mappings found');
  }

  return validated;
}

// ============================================================================
// TEMPORARY FILE MANAGEMENT
// ============================================================================

/**
 * Creates a secure temporary directory with random name and restricted permissions.
 *
 * Security features:
 * - Random suffix prevents prediction
 * - Created in OS temp directory
 * - Restricted permissions (0700 - owner only)
 * - Automatic cleanup on process exit
 *
 * @param {string} [prefix='svg-bbox'] - Directory name prefix
 * @returns {string} Path to created temporary directory
 */
function createSecureTempDir(prefix = 'svg-bbox') {
  const randomSuffix = crypto.randomBytes(16).toString('hex');
  const tempDir = path.join(os.tmpdir(), `${prefix}-${randomSuffix}`);

  // Create with restricted permissions (700 = rwx------)
  fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });

  // Register cleanup handler
  const cleanup = () => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (err) {
      // Ignore cleanup errors (best effort)
      console.error(`Warning: Failed to cleanup temp directory: ${err.message}`);
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });

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
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (err) {
    // Ignore EEXIST errors (directory already exists)
    if (err.code !== 'EEXIST') {
      throw new Error(`Failed to create directory ${dirPath}: ${err.message}`);
    }
  }
}

/**
 * Safely writes content to a file, ensuring the directory exists.
 *
 * @param {string} filePath - Output file path
 * @param {string|Buffer} content - Content to write
 * @param {Object} [options={}] - fs.writeFileSync options
 * @throws {Error} If write fails
 */
function writeFileSafe(filePath, content, options = {}) {
  const dir = path.dirname(filePath);
  ensureDirectoryExists(dir);

  try {
    fs.writeFileSync(filePath, content, options);
  } catch (err) {
    throw new Error(`Failed to write file ${filePath}: ${err.message}`);
  }
}

// ============================================================================
// ESCAPE FUNCTIONS FOR SHELL COMMANDS
// ============================================================================

/**
 * Escapes a file path for safe use in Windows cmd.exe.
 *
 * @param {string} filePath - File path to escape
 * @returns {string} Escaped file path
 */
function escapeWindowsPath(filePath) {
  // Wrap in quotes and escape embedded quotes
  return `"${filePath.replace(/"/g, '""')}"`;
}

/**
 * Escapes a file path for safe use in Unix shell commands.
 *
 * @param {string} filePath - File path to escape
 * @returns {string} Escaped file path
 */
function escapeUnixPath(filePath) {
  // Escape special characters
  return filePath.replace(/(["\s'$`\\!])/g, '\\$1');
}

// ============================================================================
// ERROR CLASSES
// ============================================================================

/**
 * Base error class for SVG-BBOX errors.
 */
class SVGBBoxError extends Error {
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
  constructor(message, details = {}) {
    super(message, 'VALIDATION_ERROR', details);
    this.name = 'ValidationError';
  }
}

/**
 * File system error - file operations failed.
 */
class FileSystemError extends SVGBBoxError {
  constructor(message, details = {}) {
    super(message, 'FILESYSTEM_ERROR', details);
    this.name = 'FileSystemError';
  }
}

/**
 * Security error - security violation detected.
 */
class SecurityError extends SVGBBoxError {
  constructor(message, details = {}) {
    super(message, 'SECURITY_ERROR', details);
    this.name = 'SecurityError';
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
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
  SecurityError
};
