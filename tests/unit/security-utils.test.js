/**
 * Security Utils Test Suite
 *
 * Comprehensive security tests for lib/security-utils.cjs
 * Tests path validation, SVG sanitization, JSON validation, and other security features.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const securityUtils = require('../../lib/security-utils.cjs');

describe('Security Utils', () => {
  // ============================================================================
  // PATH VALIDATION TESTS
  // ============================================================================

  describe('validateFilePath', () => {
    // eslint-disable-next-line vitest/expect-expect
    it('should accept valid file path in current directory', () => {
      /**Test that valid paths in current directory are accepted*/
      const validPath = 'test.svg';
      const result = securityUtils.validateFilePath(validPath);
      assert.strictEqual(typeof result, 'string');
      assert.ok(result.endsWith('test.svg'));
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should reject null bytes in file path', () => {
      /**Test that paths with null bytes are rejected*/
      assert.throws(() => securityUtils.validateFilePath('file\0.svg'), /null byte detected/);
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should reject shell metacharacters (command injection)', () => {
      /**Test that paths with shell metacharacters are rejected*/
      const dangerousPaths = [
        'file;rm -rf /.svg',
        'file|cat /etc/passwd.svg',
        'file`whoami`.svg',
        'file$(whoami).svg',
        'file&background.svg',
        'file<redirect.svg',
        'file>redirect.svg',
        'file!bang.svg'
      ];

      for (const dangerous of dangerousPaths) {
        assert.throws(
          () => securityUtils.validateFilePath(dangerous),
          /shell metacharacters/,
          `Should reject: ${dangerous}`
        );
      }
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should reject path traversal attempts', () => {
      /**Test that path traversal attempts are rejected*/
      const traversalPaths = ['../../../etc/passwd', '../../etc/shadow', './../../../etc/hosts'];

      for (const traversal of traversalPaths) {
        assert.throws(
          () => securityUtils.validateFilePath(traversal),
          /outside allowed directories/,
          `Should reject: ${traversal}`
        );
      }
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should enforce required file extensions', () => {
      /**Test that file extension validation works*/
      assert.throws(
        () =>
          securityUtils.validateFilePath('file.txt', {
            requiredExtensions: ['.svg']
          }),
        /Invalid file extension/
      );

      // Should accept valid extension
      const result = securityUtils.validateFilePath('file.svg', {
        requiredExtensions: ['.svg']
      });
      assert.ok(result.endsWith('.svg'));
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should enforce mustExist option', () => {
      /**Test that mustExist validation works*/
      const nonExistent = path.join(process.cwd(), 'nonexistent-file-xyz-123.svg');

      assert.throws(
        () =>
          securityUtils.validateFilePath(nonExistent, {
            mustExist: true
          }),
        /File not found/
      );
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should allow absolute paths within allowed directories', () => {
      /**Test that absolute paths within allowed dirs are accepted*/
      const allowed = process.cwd();
      const absolutePath = path.join(allowed, 'test.svg');

      const result = securityUtils.validateFilePath(absolutePath, {
        allowedDirs: [allowed]
      });

      assert.strictEqual(result, absolutePath);
    });
  });

  describe('validateOutputPath', () => {
    // eslint-disable-next-line vitest/expect-expect
    it('should accept output paths for non-existent files', () => {
      /**Test that output paths for new files are accepted*/
      const outputPath = path.join(process.cwd(), 'new-output.svg');
      const result = securityUtils.validateOutputPath(outputPath);
      assert.strictEqual(result, outputPath);
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should still reject dangerous paths', () => {
      /**Test that output validation still blocks dangerous paths*/
      assert.throws(
        () => securityUtils.validateOutputPath('file;rm -rf /.svg'),
        /shell metacharacters/
      );
    });
  });

  // ============================================================================
  // SVG VALIDATION AND SANITIZATION TESTS
  // ============================================================================

  describe('readSVGFileSafe', () => {
    let testFiles = [];

    afterEach(() => {
      // Cleanup test files in cwd
      for (const file of testFiles) {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      }
      testFiles = [];
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should read valid SVG file', () => {
      /**Test that valid SVG files are read successfully*/
      const validSVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
      const testPath = path.join(process.cwd(), 'test-security-valid.svg');
      testFiles.push(testPath);

      fs.writeFileSync(testPath, validSVG);

      const content = securityUtils.readSVGFileSafe(testPath);
      assert.strictEqual(content, validSVG);
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should reject non-SVG files', () => {
      /**Test that non-SVG files are rejected*/
      const testPath = path.join(process.cwd(), 'test-security-invalid.svg');
      testFiles.push(testPath);

      fs.writeFileSync(testPath, 'This is not SVG content');

      assert.throws(() => securityUtils.readSVGFileSafe(testPath), /not appear to be valid SVG/);
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should reject files exceeding size limit', () => {
      /**Test that oversized SVG files are rejected*/
      const testPath = path.join(process.cwd(), 'test-security-large.svg');
      testFiles.push(testPath);

      // Create an 11MB file (exceeds 10MB limit)
      const largeContent =
        '<svg xmlns="http://www.w3.org/2000/svg">' + 'A'.repeat(11 * 1024 * 1024) + '</svg>';
      fs.writeFileSync(testPath, largeContent);

      assert.throws(() => securityUtils.readSVGFileSafe(testPath), /SVG file too large/);
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should reject non-existent files', () => {
      /**Test that missing files are rejected*/
      const nonExistent = path.join(process.cwd(), 'nonexistent-test-security.svg');

      assert.throws(() => securityUtils.readSVGFileSafe(nonExistent), /File not found/);
    });
  });

  describe('sanitizeSVGContent', () => {
    // eslint-disable-next-line vitest/expect-expect
    it('should remove script tags', () => {
      /**Test that script tags are removed from SVG*/
      const malicious = '<svg><script>alert("XSS")</script><rect/></svg>';
      const sanitized = securityUtils.sanitizeSVGContent(malicious);

      assert.ok(!sanitized.includes('<script'));
      assert.ok(!sanitized.includes('alert'));
      assert.ok(sanitized.includes('<rect'));
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should remove event handler attributes', () => {
      /**Test that event handlers are removed from SVG*/
      const malicious = '<svg><rect onclick="alert(1)" onload="doEvil()"/></svg>';
      const sanitized = securityUtils.sanitizeSVGContent(malicious);

      assert.ok(!sanitized.includes('onclick'));
      assert.ok(!sanitized.includes('onload'));
      assert.ok(!sanitized.includes('alert'));
      assert.ok(sanitized.includes('<rect'));
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should remove javascript: URIs', () => {
      /**Test that javascript: URIs are removed from SVG*/
      const malicious = '<svg><a href="javascript:alert(1)">Link</a></svg>';
      const sanitized = securityUtils.sanitizeSVGContent(malicious);

      assert.ok(!sanitized.includes('javascript:'));
      assert.ok(sanitized.includes('href=""'));
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should remove foreignObject elements', () => {
      /**Test that foreignObject elements are removed from SVG*/
      const malicious =
        '<svg><foreignObject><html><script>evil()</script></html></foreignObject><rect/></svg>';
      const sanitized = securityUtils.sanitizeSVGContent(malicious);

      assert.ok(!sanitized.includes('foreignObject'));
      assert.ok(!sanitized.includes('<html>'));
      assert.ok(sanitized.includes('<rect'));
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should preserve clean SVG content', () => {
      /**Test that clean SVG content is preserved*/
      const clean =
        '<svg xmlns="http://www.w3.org/2000/svg"><rect id="r1" x="0" y="0" width="100" height="100" fill="red"/></svg>';
      const sanitized = securityUtils.sanitizeSVGContent(clean);

      assert.strictEqual(sanitized, clean);
    });
  });

  // ============================================================================
  // JSON VALIDATION TESTS
  // ============================================================================

  describe('readJSONFileSafe', () => {
    let testFiles = [];

    afterEach(() => {
      // Cleanup test files in cwd
      for (const file of testFiles) {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      }
      testFiles = [];
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should read valid JSON file', () => {
      /**Test that valid JSON files are read successfully*/
      const validJSON = { key: 'value', num: 42 };
      const testPath = path.join(process.cwd(), 'test-security-valid.json');
      testFiles.push(testPath);

      fs.writeFileSync(testPath, JSON.stringify(validJSON));

      const result = securityUtils.readJSONFileSafe(testPath);
      assert.deepStrictEqual(result, validJSON);
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should reject invalid JSON', () => {
      /**Test that invalid JSON is rejected*/
      const testPath = path.join(process.cwd(), 'test-security-invalid.json');
      testFiles.push(testPath);

      fs.writeFileSync(testPath, '{ invalid json }');

      assert.throws(() => securityUtils.readJSONFileSafe(testPath), /Invalid JSON file/);
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should reject prototype pollution attempts', () => {
      /**Test that prototype pollution is prevented*/
      const testPath = path.join(process.cwd(), 'test-security-pollution.json');
      testFiles.push(testPath);

      // Manually craft JSON with __proto__ (JSON.stringify skips it)
      const maliciousJSON = '{"__proto__": {"polluted": true}, "data": "value"}';
      fs.writeFileSync(testPath, maliciousJSON);

      assert.throws(() => securityUtils.readJSONFileSafe(testPath), /prototype pollution detected/);
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should reject files exceeding size limit', () => {
      /**Test that oversized JSON files are rejected*/
      const testPath = path.join(process.cwd(), 'test-security-large.json');
      testFiles.push(testPath);

      // Create a 2MB file (exceeds 1MB limit)
      const largeContent = JSON.stringify({
        data: 'A'.repeat(2 * 1024 * 1024)
      });
      fs.writeFileSync(testPath, largeContent);

      assert.throws(() => securityUtils.readJSONFileSafe(testPath), /JSON file too large/);
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should use custom validator if provided', () => {
      /**Test that custom validators are applied*/
      const testPath1 = path.join(process.cwd(), 'test-security-validator1.json');
      const testPath2 = path.join(process.cwd(), 'test-security-validator2.json');
      testFiles.push(testPath1, testPath2);

      const validJSON = { requiredField: 'value' };
      fs.writeFileSync(testPath1, JSON.stringify(validJSON));

      const validator = (data) => {
        if (!data.requiredField) {
          throw new Error('Missing required field');
        }
      };

      // Should pass validation
      assert.doesNotThrow(() => {
        securityUtils.readJSONFileSafe(testPath1, validator);
      });

      // Should fail validation
      fs.writeFileSync(testPath2, JSON.stringify({ wrongField: 'value' }));
      assert.throws(
        () => securityUtils.readJSONFileSafe(testPath2, validator),
        /Missing required field/
      );
    });
  });

  describe('validateRenameMapping', () => {
    // eslint-disable-next-line vitest/expect-expect
    it('should accept array format', () => {
      /**Test that array format rename mappings are accepted*/
      const mappings = [
        { from: 'oldId1', to: 'newId1' },
        { from: 'oldId2', to: 'newId2' }
      ];

      const result = securityUtils.validateRenameMapping(mappings);
      assert.deepStrictEqual(result, mappings);
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should accept object with mappings property', () => {
      /**Test that {mappings: [...]} format is accepted*/
      const data = {
        mappings: [{ from: 'oldId', to: 'newId' }]
      };

      const result = securityUtils.validateRenameMapping(data);
      assert.deepStrictEqual(result, data.mappings);
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should accept key-value object format', () => {
      /**Test that {old: new} format is accepted*/
      const data = {
        oldId1: 'newId1',
        oldId2: 'newId2'
      };

      const result = securityUtils.validateRenameMapping(data);
      assert.strictEqual(result.length, 2);
      assert.deepStrictEqual(result[0], { from: 'oldId1', to: 'newId1' });
      assert.deepStrictEqual(result[1], { from: 'oldId2', to: 'newId2' });
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should reject invalid ID formats', () => {
      /**Test that invalid ID formats are rejected*/
      const invalidMappings = [
        [{ from: '123invalid', to: 'valid' }], // Can't start with number
        [{ from: 'valid', to: 'has spaces' }], // No spaces allowed
        [{ from: 'has;semicolon', to: 'valid' }], // No semicolons
        [{ from: 'valid', to: 'has|pipe' }] // No pipes
      ];

      for (const mapping of invalidMappings) {
        assert.throws(
          () => securityUtils.validateRenameMapping(mapping),
          /Invalid ID format/,
          `Should reject: ${JSON.stringify(mapping)}`
        );
      }
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should accept valid ID characters', () => {
      /**Test that valid ID formats with allowed characters are accepted*/
      const validMappings = [
        { from: 'valid_id', to: 'new_id' },
        { from: '_underscore', to: 'with-dash' },
        { from: 'with.dot', to: 'mixed_-.' }
      ];

      const result = securityUtils.validateRenameMapping(validMappings);
      assert.strictEqual(result.length, 3);
    });

    // eslint-disable-next-line vitest/expect-expect
    // eslint-disable-next-line vitest/expect-expect
    it('should throw on any invalid entries (fail-fast behavior)', () => {
      /**Test that invalid mappings trigger immediate error (fail-fast for security)*/
      const mixedMappings = [
        { from: 'valid1', to: 'new1' },
        { from: '', to: 'new2' }, // Empty from - INVALID
        { from: 'valid3' }, // Missing to - INVALID
        { from: 'valid4', to: 'new4' }
      ];

      // New behavior: throws immediately on any invalid entries (security audit fix)
      // Previously: silently skipped invalid entries (security risk)
      assert.throws(
        () => securityUtils.validateRenameMapping(mixedMappings),
        /invalid rename mapping/i
      );
    });

    it('should return only valid entries when all inputs are valid', () => {
      /**Test that valid mappings pass through correctly*/
      const validMappings = [
        { from: 'valid1', to: 'new1' },
        { from: 'valid2', to: 'new2' }
      ];

      const result = securityUtils.validateRenameMapping(validMappings);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].from, 'valid1');
      assert.strictEqual(result[1].from, 'valid2');
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should throw if no valid mappings found', () => {
      /**Test that error is thrown when all mappings are invalid*/
      const invalidMappings = [{ from: '', to: '' }, { from: 'only-from' }];

      // New behavior: throws detailed error listing all invalid mappings
      // Format: "Found N invalid rename mappings:\n  - Entry 1: ...\n  - Entry 2: ..."
      assert.throws(
        () => securityUtils.validateRenameMapping(invalidMappings),
        /invalid rename mapping/i
      );
    });
  });

  // ============================================================================
  // TEMPORARY FILE MANAGEMENT TESTS
  // ============================================================================

  describe('createSecureTempDir', () => {
    // eslint-disable-next-line vitest/expect-expect
    it('should create temporary directory with random name', () => {
      /**Test that secure temp directories are created*/
      const tempDir1 = securityUtils.createSecureTempDir('test-prefix');
      const tempDir2 = securityUtils.createSecureTempDir('test-prefix');

      try {
        // Should exist
        assert.ok(fs.existsSync(tempDir1));
        assert.ok(fs.existsSync(tempDir2));

        // Should be in OS temp directory
        assert.ok(tempDir1.startsWith(os.tmpdir()));
        assert.ok(tempDir2.startsWith(os.tmpdir()));

        // Should have unique names
        assert.notStrictEqual(tempDir1, tempDir2);

        // Should contain prefix
        assert.ok(path.basename(tempDir1).startsWith('test-prefix-'));
      } finally {
        // Cleanup (don't rely on automatic cleanup for tests)
        if (fs.existsSync(tempDir1)) {
          fs.rmSync(tempDir1, { recursive: true });
        }
        if (fs.existsSync(tempDir2)) {
          fs.rmSync(tempDir2, { recursive: true });
        }
      }
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should use default prefix if none provided', () => {
      /**Test that default prefix is used when not specified*/
      const tempDir = securityUtils.createSecureTempDir();

      try {
        assert.ok(fs.existsSync(tempDir));
        assert.ok(path.basename(tempDir).startsWith('svg-bbox-'));
      } finally {
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true });
        }
      }
    });
  });

  describe('createSecureTempFile', () => {
    // eslint-disable-next-line vitest/expect-expect
    it('should create unique temporary file paths', () => {
      /**Test that unique temp file paths are generated*/
      const tempFile1 = securityUtils.createSecureTempFile('.svg', 'test');
      const tempFile2 = securityUtils.createSecureTempFile('.svg', 'test');

      // Should be unique
      assert.notStrictEqual(tempFile1, tempFile2);

      // Should have correct extension
      assert.ok(tempFile1.endsWith('.svg'));
      assert.ok(tempFile2.endsWith('.svg'));

      // Should contain prefix
      assert.ok(path.basename(tempFile1).startsWith('test-'));
    });
  });

  // ============================================================================
  // DIRECTORY OPERATIONS TESTS
  // ============================================================================

  describe('ensureDirectoryExists', () => {
    let tempDir;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svg-bbox-test-'));
    });

    afterEach(() => {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should create directory if it does not exist', () => {
      /**Test that directories are created when missing*/
      const newDir = path.join(tempDir, 'new', 'nested', 'directory');

      securityUtils.ensureDirectoryExists(newDir);
      assert.ok(fs.existsSync(newDir));
      assert.ok(fs.statSync(newDir).isDirectory());
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should not throw if directory already exists', () => {
      /**Test that existing directories don't cause errors*/
      assert.doesNotThrow(() => {
        securityUtils.ensureDirectoryExists(tempDir);
        securityUtils.ensureDirectoryExists(tempDir); // Second call
      });
    });
  });

  describe('writeFileSafe', () => {
    let tempDir;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svg-bbox-test-'));
    });

    afterEach(() => {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should write file and create parent directories', () => {
      /**Test that files are written with auto-created parent dirs*/
      const filePath = path.join(tempDir, 'new', 'nested', 'file.txt');
      const content = 'test content';

      securityUtils.writeFileSafe(filePath, content);

      assert.ok(fs.existsSync(filePath));
      assert.strictEqual(fs.readFileSync(filePath, 'utf8'), content);
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should overwrite existing files', () => {
      /**Test that existing files are overwritten*/
      const filePath = path.join(tempDir, 'file.txt');

      securityUtils.writeFileSafe(filePath, 'original');
      securityUtils.writeFileSafe(filePath, 'updated');

      assert.strictEqual(fs.readFileSync(filePath, 'utf8'), 'updated');
    });
  });

  // ============================================================================
  // SHELL ESCAPING TESTS
  // ============================================================================

  describe('escapeWindowsPath', () => {
    // eslint-disable-next-line vitest/expect-expect
    it('should wrap path in quotes', () => {
      /**Test that Windows paths are wrapped in quotes*/
      const result = securityUtils.escapeWindowsPath('C:\\Users\\test\\file.svg');
      assert.ok(result.startsWith('"'));
      assert.ok(result.endsWith('"'));
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should escape embedded quotes', () => {
      /**Test that embedded quotes are escaped for Windows*/
      const result = securityUtils.escapeWindowsPath('path with "quotes".svg');
      assert.strictEqual(result, '"path with ""quotes"".svg"');
    });
  });

  describe('escapeUnixPath', () => {
    // eslint-disable-next-line vitest/expect-expect
    it('should escape spaces', () => {
      /**Test that spaces are escaped for Unix shells*/
      const result = securityUtils.escapeUnixPath('path with spaces.svg');
      assert.strictEqual(result, 'path\\ with\\ spaces.svg');
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should escape special shell characters', () => {
      /**Test that special characters are escaped for Unix shells*/
      const dangerous = 'file $var `cmd` "quote" \'quote\' !bang \\slash.svg';
      const result = securityUtils.escapeUnixPath(dangerous);

      assert.ok(result.includes('\\$'));
      assert.ok(result.includes('\\`'));
      assert.ok(result.includes('\\"'));
      assert.ok(result.includes("\\'"));
      assert.ok(result.includes('\\!'));
      assert.ok(result.includes('\\\\'));
    });
  });

  // ============================================================================
  // ERROR CLASS TESTS
  // ============================================================================

  describe('Error Classes', () => {
    // eslint-disable-next-line vitest/expect-expect
    it('should create SVGBBoxError with code and details', () => {
      /**Test that SVGBBoxError includes code and details*/
      const err = new securityUtils.SVGBBoxError('test message', 'TEST_CODE', { detail: 'info' });

      assert.strictEqual(err.name, 'SVGBBoxError');
      assert.strictEqual(err.message, 'test message');
      assert.strictEqual(err.code, 'TEST_CODE');
      assert.deepStrictEqual(err.details, { detail: 'info' });
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should create ValidationError', () => {
      /**Test that ValidationError is properly constructed*/
      const err = new securityUtils.ValidationError('validation failed');

      assert.strictEqual(err.name, 'ValidationError');
      assert.strictEqual(err.code, 'VALIDATION_ERROR');
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should create FileSystemError', () => {
      /**Test that FileSystemError is properly constructed*/
      const err = new securityUtils.FileSystemError('fs operation failed');

      assert.strictEqual(err.name, 'FileSystemError');
      assert.strictEqual(err.code, 'FILESYSTEM_ERROR');
    });

    // eslint-disable-next-line vitest/expect-expect
    it('should create SecurityError', () => {
      /**Test that SecurityError is properly constructed*/
      const err = new securityUtils.SecurityError('security violation');

      assert.strictEqual(err.name, 'SecurityError');
      assert.strictEqual(err.code, 'SECURITY_ERROR');
    });
  });

  // ============================================================================
  // CONSTANTS TESTS
  // ============================================================================

  describe('Constants', () => {
    // eslint-disable-next-line vitest/expect-expect
    it('should export correct constants', () => {
      /**Test that security constants are properly exported*/
      assert.strictEqual(securityUtils.MAX_SVG_SIZE, 10 * 1024 * 1024);
      assert.strictEqual(securityUtils.MAX_JSON_SIZE, 1 * 1024 * 1024);
      assert.deepStrictEqual(securityUtils.VALID_SVG_EXTENSIONS, ['.svg']);
      assert.deepStrictEqual(securityUtils.VALID_JSON_EXTENSIONS, ['.json']);
      assert.ok(securityUtils.SHELL_METACHARACTERS instanceof RegExp);
      assert.ok(securityUtils.VALID_ID_PATTERN instanceof RegExp);
    });
  });
});
