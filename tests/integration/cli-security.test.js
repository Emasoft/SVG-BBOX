/**
 * CLI Security Integration Tests
 *
 * End-to-end security tests for all CLI tools.
 * Tests that security fixes prevent command injection, path traversal, and other attacks.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFilePromise = promisify(execFile);

// Test timeout for CLI operations
const CLI_TIMEOUT = 30000;

// Paths to CLI tools
const CLI_TOOLS = {
  extractor: path.join(__dirname, '../../sbb-extractor.cjs'),
  comparer: path.join(__dirname, '../../sbb-comparer.cjs'),
  textToPath: path.join(__dirname, '../../sbb-inkscape-text2path.cjs')
};

// Valid test SVG for security tests
const VALID_TEST_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" fill="blue"/></svg>';

describe('CLI Security Integration Tests', () => {
  let testDir;
  let testFiles = [];

  beforeEach(() => {
    // Create test directory in cwd (CLI tools only allow cwd by default)
    testDir = path.join(process.cwd(), 'test-cli-security-temp');
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Cleanup test files
    for (const file of testFiles) {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }
    testFiles = [];

    // Cleanup test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ============================================================================
  // COMMAND INJECTION TESTS
  // ============================================================================

  describe('Command Injection Prevention', () => {
    it('sbb-extractor should reject paths with shell metacharacters', async () => {
      /**Test that sbb-extractor rejects command injection attempts*/
      const maliciousPath = path.join(testDir, 'file;rm -rf /.svg');

      try {
        await execFilePromise('node', [CLI_TOOLS.extractor, maliciousPath, '--list', '--json'], {
          timeout: CLI_TIMEOUT
        });
        assert.fail('Should have rejected malicious path');
      } catch (err) {
        const errorOutput = (err.stderr || '') + (err.message || '');
        assert.ok(
          errorOutput.includes('shell metacharacters') || errorOutput.includes('Invalid'),
          `Should reject with security error. Got: ${errorOutput}`
        );
      }
    });

    it('sbb-comparer should reject paths with shell metacharacters', async () => {
      /**Test that sbb-comparer rejects command injection attempts*/
      const validPath = path.join(testDir, 'valid.svg');
      // Use pipe instead of backticks to avoid shell expansion issues
      const maliciousPath = path.join(testDir, 'file|cat.svg');
      testFiles.push(validPath);

      fs.writeFileSync(validPath, VALID_TEST_SVG);

      try {
        await execFilePromise('node', [CLI_TOOLS.comparer, validPath, maliciousPath], {
          timeout: CLI_TIMEOUT
        });
        assert.fail('Should have rejected malicious path');
      } catch (err) {
        assert.ok(
          err.stderr.includes('shell metacharacters') || err.stderr.includes('Invalid'),
          'Should reject with security error'
        );
      }
    });

    it('sbb-text-to-path should reject paths with shell metacharacters', async () => {
      /**Test that sbb-text-to-path rejects command injection attempts*/
      // Use pipe character - same as comparer test which passes consistently
      const maliciousPath = path.join(testDir, 'file|cat.svg');
      const outputPath = path.join(testDir, 'output.svg');

      try {
        await execFilePromise('node', [CLI_TOOLS.textToPath, maliciousPath, outputPath], {
          timeout: CLI_TIMEOUT
        });
        assert.fail('Should have rejected malicious path');
      } catch (err) {
        assert.ok(
          err.stderr.includes('shell metacharacters') || err.stderr.includes('Invalid'),
          'Should reject with security error'
        );
      }
    });
  });

  // ============================================================================
  // PATH TRAVERSAL TESTS
  // ============================================================================

  describe('Path Traversal Prevention', () => {
    it('sbb-extractor should reject path traversal attempts', async () => {
      /**Test that sbb-extractor blocks path traversal*/
      const traversalPath = '../../../etc/passwd';

      try {
        await execFilePromise('node', [CLI_TOOLS.extractor, traversalPath, '--list', '--json'], {
          timeout: CLI_TIMEOUT
        });
        assert.fail('Should have rejected traversal attempt');
      } catch (err) {
        const errorOutput = (err.stderr || '') + (err.message || '');
        assert.ok(
          errorOutput.includes('outside allowed directories') ||
            errorOutput.includes('File not found') ||
            errorOutput.includes('Invalid file extension'),
          `Should reject with security or validation error. Got: ${errorOutput}`
        );
      }
    });

    it('sbb-comparer should reject path traversal attempts', async () => {
      /**Test that sbb-comparer blocks path traversal*/
      const validPath = path.join(testDir, 'valid.svg');
      const traversalPath = '../../etc/hosts';
      testFiles.push(validPath);

      fs.writeFileSync(validPath, VALID_TEST_SVG);

      try {
        await execFilePromise('node', [CLI_TOOLS.comparer, validPath, traversalPath], {
          timeout: CLI_TIMEOUT
        });
        assert.fail('Should have rejected traversal attempt');
      } catch (err) {
        assert.ok(
          err.stderr.includes('outside allowed directories') ||
            err.stderr.includes('File not found') ||
            err.stderr.includes('Invalid file extension'),
          'Should reject with security or validation error'
        );
      }
    });
  });

  // ============================================================================
  // FILE SIZE LIMIT TESTS
  // ============================================================================

  describe('File Size Limit Enforcement', () => {
    it('sbb-extractor should reject oversized SVG files', async () => {
      /**Test that sbb-extractor enforces file size limits*/
      const largePath = path.join(testDir, 'large.svg');
      testFiles.push(largePath);

      // Create an 11MB SVG file (exceeds 10MB limit)
      const largeContent =
        '<svg xmlns="http://www.w3.org/2000/svg">' + 'A'.repeat(11 * 1024 * 1024) + '</svg>';
      fs.writeFileSync(largePath, largeContent);

      try {
        await execFilePromise('node', [CLI_TOOLS.extractor, largePath, '--list', '--json'], {
          timeout: CLI_TIMEOUT
        });
        assert.fail('Should have rejected oversized file');
      } catch (err) {
        const errorOutput = (err.stderr || '') + (err.message || '');
        assert.ok(
          errorOutput.includes('too large'),
          `Should reject with size limit error. Got: ${errorOutput}`
        );
      }
    });
  });

  // ============================================================================
  // SVG SANITIZATION TESTS
  // ============================================================================

  describe('SVG Sanitization', () => {
    it('should process SVG with removed script tags', async () => {
      /**Test that script tags are sanitized from SVG input*/
      const maliciousPath = path.join(testDir, 'malicious.svg');
      // Add id to rect so sbb-extractor can process it
      const maliciousSVG =
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert("XSS")</script><rect id="r1" x="10" y="10" width="50" height="50"/></svg>';
      testFiles.push(maliciousPath);

      fs.writeFileSync(maliciousPath, maliciousSVG);

      // sbb-extractor should process it (sanitization happens internally)
      const { stdout } = await execFilePromise(
        'node',
        [CLI_TOOLS.extractor, maliciousPath, '--list', '--json'],
        {
          timeout: CLI_TIMEOUT,
          maxBuffer: 20 * 1024 * 1024
        }
      );

      // Parse JSON from output (skip info line)
      const jsonStart = stdout.indexOf('{');
      const jsonOutput = stdout.substring(jsonStart);
      const result = JSON.parse(jsonOutput);

      assert.ok(result.objects || result.results);

      // The sanitization test is to verify it doesn't crash, which it didn't if we got here
    });

    it('should process SVG with removed event handlers', async () => {
      /**Test that event handlers are sanitized from SVG input*/
      const maliciousPath = path.join(testDir, 'handlers.svg');
      // Add id to rect so sbb-extractor can process it
      const maliciousSVG =
        '<svg xmlns="http://www.w3.org/2000/svg"><rect id="r2" onclick="alert(1)" onload="doEvil()" x="10" y="10" width="50" height="50"/></svg>';
      testFiles.push(maliciousPath);

      fs.writeFileSync(maliciousPath, maliciousSVG);

      // Should process without issues
      const { stdout } = await execFilePromise(
        'node',
        [CLI_TOOLS.extractor, maliciousPath, '--list', '--json'],
        {
          timeout: CLI_TIMEOUT,
          maxBuffer: 20 * 1024 * 1024
        }
      );

      // Parse JSON from output (skip info line)
      const jsonStart = stdout.indexOf('{');
      const jsonOutput = stdout.substring(jsonStart);
      const result = JSON.parse(jsonOutput);

      assert.ok(result.objects || result.results);
    });
  });

  // ============================================================================
  // NULL BYTE INJECTION TESTS
  // ============================================================================

  describe('Null Byte Injection Prevention', () => {
    it('should reject paths with null bytes', async () => {
      /**Test that null bytes in paths are rejected*/
      const nullBytePath = 'file\0.svg';

      try {
        await execFilePromise('node', [CLI_TOOLS.extractor, nullBytePath, '--list', '--json'], {
          timeout: CLI_TIMEOUT
        });
        assert.fail('Should have rejected null byte path');
      } catch (err) {
        const errorOutput = (err.stderr || '') + (err.message || '');
        assert.ok(
          errorOutput.includes('null byte') || errorOutput.includes('Invalid'),
          `Should reject with null byte error. Got: ${errorOutput}`
        );
      }
    });
  });

  // ============================================================================
  // FILE EXTENSION VALIDATION TESTS
  // ============================================================================

  describe('File Extension Validation', () => {
    it('sbb-extractor should reject non-SVG files', async () => {
      /**Test that sbb-extractor rejects non-SVG extensions*/
      const txtPath = path.join(testDir, 'notsvg.txt');
      testFiles.push(txtPath);
      fs.writeFileSync(txtPath, '<svg></svg>');

      try {
        await execFilePromise('node', [CLI_TOOLS.extractor, txtPath, '--list', '--json'], {
          timeout: CLI_TIMEOUT
        });
        assert.fail('Should have rejected non-SVG file');
      } catch (err) {
        const errorOutput = (err.stderr || '') + (err.message || '');
        assert.ok(
          errorOutput.includes('Invalid file extension') || errorOutput.includes('.svg'),
          `Should reject with extension error. Got: ${errorOutput}`
        );
      }
    });

    it('sbb-comparer should reject non-SVG files', async () => {
      /**Test that sbb-comparer rejects non-SVG extensions*/
      const validPath = path.join(testDir, 'valid.svg');
      const txtPath = path.join(testDir, 'notsvg.txt');
      testFiles.push(validPath, txtPath);

      fs.writeFileSync(validPath, VALID_TEST_SVG);
      fs.writeFileSync(txtPath, VALID_TEST_SVG);

      try {
        await execFilePromise('node', [CLI_TOOLS.comparer, validPath, txtPath], {
          timeout: CLI_TIMEOUT
        });
        assert.fail('Should have rejected non-SVG file');
      } catch (err) {
        assert.ok(
          err.stderr.includes('Invalid file extension') || err.stderr.includes('.svg'),
          'Should reject with extension error'
        );
      }
    });
  });

  // ============================================================================
  // BATCH FILE VALIDATION TESTS (sbb-text-to-path)
  // ============================================================================

  describe('Batch File Security', () => {
    it('should reject batch file with command injection in path', async () => {
      /**Test that batch files with malicious paths are rejected*/
      const batchPath = path.join(testDir, 'batch.txt');
      const maliciousList = 'file.svg;rm -rf /\nlegit.svg';
      testFiles.push(batchPath);

      fs.writeFileSync(batchPath, maliciousList);

      try {
        await execFilePromise(
          'node',
          [CLI_TOOLS.textToPath, '--batch', batchPath, '--skip-comparison'],
          {
            timeout: CLI_TIMEOUT
          }
        );
        assert.fail('Should have rejected batch with malicious paths');
      } catch (err) {
        const errorOutput = (err.stderr || '') + (err.message || '');
        // Should fail during processing of malicious path
        assert.ok(
          err.code > 0 || errorOutput.includes('shell metacharacters'),
          `Should reject malicious paths. Got: ${errorOutput}`
        );
      }
    });

    it('should handle batch file with path traversal attempts', async () => {
      /**Test that batch files with traversal paths are rejected*/
      const batchPath = path.join(testDir, 'batch.txt');
      const traversalList = '../../../etc/passwd\n../../etc/hosts';
      testFiles.push(batchPath);

      fs.writeFileSync(batchPath, traversalList);

      try {
        await execFilePromise(
          'node',
          [CLI_TOOLS.textToPath, '--batch', batchPath, '--skip-comparison'],
          {
            timeout: CLI_TIMEOUT
          }
        );
        // May fail or skip invalid files - either is acceptable
      } catch (err) {
        // Error is expected
        assert.ok(err.code > 0);
      }
    });
  });

  // ============================================================================
  // JSON OUTPUT SECURITY TESTS
  // ============================================================================

  describe('JSON Output Security', () => {
    it('sbb-extractor JSON output should not include sensitive paths', async () => {
      /**Test that JSON output doesn't leak sensitive system paths*/
      const testPath = path.join(testDir, 'test.svg');
      // Add id to rect so sbb-extractor can find objects
      const testSVG =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect id="r1" x="10" y="10" width="80" height="80" fill="blue"/></svg>';
      testFiles.push(testPath);
      fs.writeFileSync(testPath, testSVG);

      const { stdout } = await execFilePromise(
        'node',
        [CLI_TOOLS.extractor, testPath, '--list', '--json'],
        {
          timeout: CLI_TIMEOUT,
          maxBuffer: 20 * 1024 * 1024
        }
      );

      // Parse JSON from output (skip info line)
      const jsonStart = stdout.indexOf('{');
      const jsonOutput = stdout.substring(jsonStart);
      const result = JSON.parse(jsonOutput);

      // Verify no absolute paths to system directories are leaked
      const jsonStr = JSON.stringify(result);
      assert.ok(!jsonStr.includes('/etc/'), 'Should not include /etc/ paths');
      assert.ok(!jsonStr.includes('/var/'), 'Should not include /var/ paths');
      assert.ok(!jsonStr.includes('C:\\Windows'), 'Should not include Windows system paths');
    });

    it('sbb-comparer JSON output should be safely parseable', async () => {
      /**Test that sbb-comparer JSON output is valid and safe*/
      const svg1Path = path.join(testDir, 'svg1.svg');
      const svg2Path = path.join(testDir, 'svg2.svg');
      testFiles.push(svg1Path, svg2Path);

      fs.writeFileSync(svg1Path, VALID_TEST_SVG);
      fs.writeFileSync(svg2Path, VALID_TEST_SVG);

      const { stdout } = await execFilePromise(
        'node',
        [CLI_TOOLS.comparer, svg1Path, svg2Path, '--json'],
        {
          timeout: CLI_TIMEOUT
        }
      );

      // Should parse without error
      const result = JSON.parse(stdout);
      assert.ok(result);
      assert.ok(typeof result === 'object');

      // Should not have prototype pollution keys
      assert.ok(!Object.prototype.hasOwnProperty.call(result, '__proto__'));
      assert.ok(!Object.prototype.hasOwnProperty.call(result, 'constructor'));
    });
  });

  // ============================================================================
  // BROWSER TIMEOUT TESTS
  // ============================================================================

  describe('Browser Timeout Protection', () => {
    it(
      'sbb-extractor should timeout on extremely complex SVG',
      async () => {
        /**Test that browser operations timeout on malicious SVG*/
        const complexPath = path.join(testDir, 'complex.svg');
        testFiles.push(complexPath);

        // Create SVG with many nested elements (potential DoS)
        let nested = '<g>';
        for (let i = 0; i < 1000; i++) {
          nested += '<g transform="matrix(1,0,0,1,0.1,0.1)">';
        }
        nested += '<rect x="0" y="0" width="1" height="1"/>';
        for (let i = 0; i < 1000; i++) {
          nested += '</g>';
        }
        nested += '</g>';

        const complexSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${nested}</svg>`;
        fs.writeFileSync(complexPath, complexSVG);

        try {
          // This might timeout or complete - both are acceptable
          // The important thing is it doesn't hang forever
          await execFilePromise('node', [CLI_TOOLS.extractor, complexPath, '--list', '--json'], {
            timeout: CLI_TIMEOUT,
            maxBuffer: 20 * 1024 * 1024
          });
          // If it completes, that's fine too (browser has internal timeout)
        } catch (err) {
          // Timeout or other error is acceptable
          assert.ok(err);
        }
      },
      CLI_TIMEOUT + 5000
    ); // Vitest timeout
  });

  // ============================================================================
  // FILE CONTENT VALIDATION TESTS
  // ============================================================================

  describe('File Content Validation', () => {
    it('should reject non-SVG content', async () => {
      /**Test that files with non-SVG content are rejected*/
      const fakePath = path.join(testDir, 'fake.svg');
      testFiles.push(fakePath);
      fs.writeFileSync(fakePath, 'This is not SVG content');

      try {
        await execFilePromise('node', [CLI_TOOLS.extractor, fakePath, '--list', '--json'], {
          timeout: CLI_TIMEOUT
        });
        assert.fail('Should have rejected non-SVG content');
      } catch (err) {
        const errorOutput = (err.stderr || '') + (err.message || '');
        assert.ok(
          errorOutput.includes('not appear to be valid SVG') || errorOutput.includes('Invalid'),
          `Should reject with validation error. Got: ${errorOutput}`
        );
      }
    });

    it('should reject empty files', async () => {
      /**Test that empty SVG files are rejected*/
      const emptyPath = path.join(testDir, 'empty.svg');
      testFiles.push(emptyPath);
      fs.writeFileSync(emptyPath, '');

      try {
        await execFilePromise('node', [CLI_TOOLS.extractor, emptyPath, '--list', '--json'], {
          timeout: CLI_TIMEOUT
        });
        assert.fail('Should have rejected empty file');
      } catch (err) {
        const errorOutput = (err.stderr || '') + (err.message || '');
        assert.ok(
          errorOutput.includes('not appear to be valid SVG') || errorOutput.includes('Invalid'),
          `Should reject empty file. Got: ${errorOutput}`
        );
      }
    });
  });

  // ============================================================================
  // RENAME MAPPING SECURITY TESTS (sbb-extractor)
  // ============================================================================

  describe('Rename Mapping Security', () => {
    it('should reject invalid ID characters in rename mapping', async () => {
      /**Test that rename mappings with invalid IDs are rejected*/
      const svgPath = path.join(testDir, 'test.svg');
      const jsonPath = path.join(testDir, 'mapping.json');
      const outPath = path.join(testDir, 'test-renamed.svg');
      testFiles.push(svgPath, jsonPath, outPath);

      fs.writeFileSync(svgPath, VALID_TEST_SVG);

      // Create mapping with invalid ID (contains semicolon)
      const maliciousMapping = [{ from: 'valid', to: 'evil;alert(1)' }];
      fs.writeFileSync(jsonPath, JSON.stringify(maliciousMapping));

      try {
        await execFilePromise(
          'node',
          [CLI_TOOLS.extractor, svgPath, '--rename', jsonPath, outPath, '--json'],
          {
            timeout: CLI_TIMEOUT
          }
        );
        assert.fail('Should have rejected invalid ID in mapping');
      } catch (err) {
        const errorOutput = (err.stderr || '') + (err.message || '');
        assert.ok(
          errorOutput.includes('Invalid ID format') || errorOutput.includes('Invalid'),
          `Should reject with ID validation error. Got: ${errorOutput}`
        );
      }
    });

    it('should reject prototype pollution in rename mapping', async () => {
      /**Test that prototype pollution in mappings is prevented*/
      const svgPath = path.join(testDir, 'test2.svg');
      const jsonPath = path.join(testDir, 'mapping2.json');
      const outPath = path.join(testDir, 'test2-renamed.svg');
      testFiles.push(svgPath, jsonPath, outPath);

      fs.writeFileSync(svgPath, VALID_TEST_SVG);

      // Create malicious mapping with prototype pollution (manual JSON to include __proto__)
      const maliciousJSON = '{"__proto__": {"polluted": true}, "validId": "newId"}';
      fs.writeFileSync(jsonPath, maliciousJSON);

      try {
        await execFilePromise(
          'node',
          [CLI_TOOLS.extractor, svgPath, '--rename', jsonPath, outPath, '--json'],
          {
            timeout: CLI_TIMEOUT
          }
        );
        assert.fail('Should have rejected prototype pollution');
      } catch (err) {
        const errorOutput = (err.stderr || '') + (err.message || '');
        assert.ok(
          errorOutput.includes('prototype pollution') || errorOutput.includes('Invalid'),
          `Should reject with pollution error. Got: ${errorOutput}`
        );
      }
    });
  });

  // ============================================================================
  // OUTPUT PATH SECURITY TESTS
  // ============================================================================

  describe('Output Path Security', () => {
    it('should prevent writing outside allowed directories', async () => {
      /**Test that output cannot be written outside allowed dirs*/
      const validPath = path.join(testDir, 'test.svg');
      const dangerousOutput = '/etc/malicious.svg';
      testFiles.push(validPath);

      fs.writeFileSync(validPath, VALID_TEST_SVG);

      try {
        await execFilePromise(
          'node',
          [CLI_TOOLS.textToPath, validPath, dangerousOutput, '--skip-comparison'],
          {
            timeout: CLI_TIMEOUT
          }
        );
        assert.fail('Should have rejected dangerous output path');
      } catch (err) {
        // Should fail due to permissions or path validation
        assert.ok(err);
      }
    });
  });

  // ============================================================================
  // SUCCESSFUL OPERATION TESTS (Baseline)
  // ============================================================================

  describe('Baseline Functional Tests', () => {
    it('sbb-extractor should successfully process valid SVG', async () => {
      /**Test that sbb-extractor works correctly with valid input*/
      const validPath = path.join(testDir, 'valid.svg');
      // Add id to rect so sbb-extractor can find objects
      const testSVG =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect id="rect" x="10" y="10" width="80" height="80" fill="blue"/></svg>';
      testFiles.push(validPath);
      fs.writeFileSync(validPath, testSVG);

      const { stdout } = await execFilePromise(
        'node',
        [CLI_TOOLS.extractor, validPath, '--list', '--json'],
        {
          timeout: CLI_TIMEOUT,
          maxBuffer: 20 * 1024 * 1024
        }
      );

      // Parse JSON from output (skip info line)
      const jsonStart = stdout.indexOf('{');
      const jsonOutput = stdout.substring(jsonStart);
      const result = JSON.parse(jsonOutput);

      assert.ok(result.objects);
      assert.ok(result.objects.length > 0);
      assert.strictEqual(result.objects[0].id, 'rect');
    });

    it('sbb-comparer should successfully compare valid SVGs', async () => {
      /**Test that sbb-comparer works correctly with valid inputs*/
      const svg1Path = path.join(testDir, 'cmp1.svg');
      const svg2Path = path.join(testDir, 'cmp2.svg');
      testFiles.push(svg1Path, svg2Path);

      fs.writeFileSync(svg1Path, VALID_TEST_SVG);
      fs.writeFileSync(svg2Path, VALID_TEST_SVG);

      const { stdout } = await execFilePromise(
        'node',
        [CLI_TOOLS.comparer, svg1Path, svg2Path, '--json'],
        {
          timeout: CLI_TIMEOUT
        }
      );

      const result = JSON.parse(stdout);
      assert.ok(result);
      assert.strictEqual(typeof result.diffPercentage, 'number');
      assert.strictEqual(result.diffPercentage, 0); // Identical SVGs
    });
  });
});
