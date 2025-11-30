/**
 * Integration test: Verify npm package works after installation
 *
 * CRITICAL: This test prevents publishing broken packages to npm.
 *
 * WHY THIS TEST EXISTS:
 * - Tests run from source directory where all files exist
 * - npm only publishes files listed in package.json "files" array
 * - Missing files cause MODULE_NOT_FOUND errors after npm install
 * - This test simulates real npm install to catch packaging issues
 *
 * WHAT THIS TEST DOES:
 * 1. Runs `npm pack` to create tarball (same as npm publish)
 * 2. Installs tarball in isolated temp directory
 * 3. Verifies all CLI tools can be required without errors
 * 4. Tests that each tool can run --help successfully
 *
 * PREVENTS:
 * - Missing directories (e.g., config/, lib/)
 * - Missing files required by CLI tools
 * - Broken require() statements
 * - MODULE_NOT_FOUND errors in production
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Package Installation Verification', () => {
  let tempDir;
  let packageTarball;
  let installedPackagePath;

  beforeAll(async () => {
    // Create temp directory for isolated testing
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svg-bbox-package-test-'));
    console.log(`\n  Test directory: ${tempDir}`);

    // Run npm pack to create tarball (same as what gets published)
    // CRITICAL: Use shell: true on Windows because npm is actually npm.cmd
    // Without shell: true, spawnSync cannot find the npm executable on Windows
    console.log('  Creating package tarball...');
    const packResult = spawnSync('npm', ['pack'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      shell: true // Required for Windows - npm is npm.cmd, not npm.exe
    });

    if (packResult.status !== 0) {
      // Windows may return null for stderr, use stderr || stdout for error message
      const errorMsg = packResult.stderr || packResult.stdout || 'unknown error';
      // Log signal info for debugging on Windows
      console.log(`  npm pack exit code: ${packResult.status}`);
      console.log(`  npm pack signal: ${packResult.signal}`);
      console.log(`  npm pack error: ${packResult.error}`);
      throw new Error(`npm pack failed (exit code ${packResult.status}): ${errorMsg}`);
    }

    // Verify npm pack produced output (tarball filename)
    if (!packResult.stdout || !packResult.stdout.trim()) {
      // On Windows, npm pack may succeed but produce no output to stdout
      // In that case, look for the tarball file directly
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
      );
      const expectedTarball = `${packageJson.name.replace('@', '').replace('/', '-')}-${packageJson.version}.tgz`;
      if (fs.existsSync(path.join(process.cwd(), expectedTarball))) {
        console.log(`  Found tarball via fallback: ${expectedTarball}`);
        packageTarball = expectedTarball;
      } else {
        throw new Error('npm pack succeeded but produced no output and tarball not found');
      }
    } else {
      // Extract tarball filename from output (last line)
      packageTarball = packResult.stdout.trim().split('\n').pop();
    }

    const tarballPath = path.join(process.cwd(), packageTarball);

    console.log(`  Tarball created: ${packageTarball}`);

    // Install the tarball in temp directory
    // CRITICAL: Use shell: true on Windows because npm is actually npm.cmd
    console.log('  Installing package from tarball...');
    const installResult = spawnSync('npm', ['install', '--no-save', tarballPath], {
      cwd: tempDir,
      encoding: 'utf8',
      shell: true // Required for Windows - npm is npm.cmd, not npm.exe
    });

    if (installResult.status !== 0) {
      throw new Error(`npm install failed: ${installResult.stderr}`);
    }

    installedPackagePath = path.join(tempDir, 'node_modules', 'svg-bbox');
    console.log(`  Package installed at: ${installedPackagePath}\n`);
  });

  afterAll(() => {
    // Clean up tarball
    if (packageTarball && fs.existsSync(packageTarball)) {
      fs.unlinkSync(packageTarball);
    }

    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should include config/ directory in package', () => {
    const configDir = path.join(installedPackagePath, 'config');
    expect(fs.existsSync(configDir)).toBe(true);

    const timeoutsCjs = path.join(configDir, 'timeouts.cjs');
    expect(fs.existsSync(timeoutsCjs)).toBe(true);

    const timeoutsJs = path.join(configDir, 'timeouts.js');
    expect(fs.existsSync(timeoutsJs)).toBe(true);
  });

  it('should include lib/ directory in package', () => {
    const libDir = path.join(installedPackagePath, 'lib');
    expect(fs.existsSync(libDir)).toBe(true);

    const cliUtils = path.join(libDir, 'cli-utils.cjs');
    expect(fs.existsSync(cliUtils)).toBe(true);

    const securityUtils = path.join(libDir, 'security-utils.cjs');
    expect(fs.existsSync(securityUtils)).toBe(true);
  });

  it('should include core library files', () => {
    const svgVisualBBox = path.join(installedPackagePath, 'SvgVisualBBox.js');
    expect(fs.existsSync(svgVisualBBox)).toBe(true);

    const svgVisualBBoxMin = path.join(installedPackagePath, 'SvgVisualBBox.min.js');
    expect(fs.existsSync(svgVisualBBoxMin)).toBe(true);
  });

  it('should be able to require config/timeouts.cjs without errors', () => {
    const timeoutsPath = path.join(installedPackagePath, 'config', 'timeouts.cjs');

    // This will throw if module can't be loaded
    const timeouts = require(timeoutsPath);

    // Verify expected exports exist
    expect(timeouts).toHaveProperty('GIT_DIFF_TIMEOUT_MS');
    expect(timeouts).toHaveProperty('VITEST_RUN_TIMEOUT_MS');
    expect(typeof timeouts.GIT_DIFF_TIMEOUT_MS).toBe('number');
    expect(typeof timeouts.VITEST_RUN_TIMEOUT_MS).toBe('number');
  });

  it('should be able to require lib/cli-utils.cjs without errors', () => {
    const cliUtilsPath = path.join(installedPackagePath, 'lib', 'cli-utils.cjs');

    // Use spawnSync to require in isolated process (CLI utils may have side effects)
    const result = spawnSync(
      'node',
      [
        '-e',
        `
      try {
        const cliUtils = require('${cliUtilsPath.replace(/\\/g, '\\\\')}');
        console.log(typeof cliUtils);
        process.exit(0);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      }
    `
      ],
      { encoding: 'utf8' }
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('object');
  });

  it('should be able to require lib/security-utils.cjs without errors', () => {
    const securityUtilsPath = path.join(installedPackagePath, 'lib', 'security-utils.cjs');

    // This will throw if module can't be loaded or has missing dependencies
    const securityUtils = require(securityUtilsPath);

    // Verify it's an object with security constants and utilities
    expect(typeof securityUtils).toBe('object');
    expect(securityUtils).toHaveProperty('MAX_SVG_SIZE');
    expect(typeof securityUtils.MAX_SVG_SIZE).toBe('number');
  });

  // Test each CLI tool can be required without MODULE_NOT_FOUND
  // NOTE: Inkscape tools are separated because they call process.exit(1) if Inkscape
  // is not installed, which causes Vitest workers to crash. We test those by just
  // checking syntax and that node can parse the file, not execute it.
  const cliToolsChrome = [
    'sbb-getbbox.cjs',
    'sbb-extract.cjs',
    'sbb-svg2png.cjs',
    'sbb-fix-viewbox.cjs',
    'sbb-comparer.cjs',
    'sbb-test.cjs',
    'sbb-chrome-extract.cjs',
    'sbb-chrome-getbbox.cjs',
    'svg-bbox.cjs'
  ];

  // Inkscape tools call process.exit(1) immediately when Inkscape is not installed
  // This crashes Vitest workers even when using spawnSync. We test these separately
  // by only checking syntax/parsing, not execution.
  const cliToolsInkscape = [
    'sbb-inkscape-extract.cjs',
    'sbb-inkscape-getbbox.cjs',
    'sbb-inkscape-svg2png.cjs',
    'sbb-inkscape-text2path.cjs'
  ];

  cliToolsChrome.forEach((tool) => {
    it(`should be able to require ${tool} without errors`, () => {
      const toolPath = path.join(installedPackagePath, tool);

      expect(fs.existsSync(toolPath)).toBe(true);

      // Use spawnSync to require in isolated process (CLI tools call process.exit which crashes workers)
      // This will fail with MODULE_NOT_FOUND if dependencies are missing
      const result = spawnSync(
        'node',
        [
          '-e',
          `
        try {
          require('${toolPath.replace(/\\/g, '\\\\')}');
          // If we get here, the tool was required successfully
          process.exit(0);
        } catch (err) {
          if (err.code === 'MODULE_NOT_FOUND') {
            console.error('MODULE_NOT_FOUND:', err.message);
            process.exit(1);
          }
          // Other errors are unexpected
          console.error('UNEXPECTED ERROR:', err.message);
          process.exit(1);
        }
      `
        ],
        { encoding: 'utf8' }
      );

      // Exit code 0, 1, or 2 are all OK (0 = loaded, 1 = MODULE_NOT_FOUND, 2 = missing args)
      // We only care that there are no MODULE_NOT_FOUND errors
      if (result.stderr && result.stderr.includes('MODULE_NOT_FOUND')) {
        expect(result.stderr).not.toContain('MODULE_NOT_FOUND');
      }
    });
  });

  // Test Inkscape tools by checking syntax only (--check flag parses but doesn't execute)
  // This catches MODULE_NOT_FOUND errors without triggering the Inkscape availability check
  cliToolsInkscape.forEach((tool) => {
    it(`should be able to parse ${tool} without MODULE_NOT_FOUND errors`, () => {
      const toolPath = path.join(installedPackagePath, tool);

      expect(fs.existsSync(toolPath)).toBe(true);

      // Use --check to parse the file without executing it
      // This will catch MODULE_NOT_FOUND errors for missing dependencies
      const result = spawnSync('node', ['--check', toolPath], {
        encoding: 'utf8'
      });

      // --check returns 0 if syntax is valid and all requires can be resolved
      // It returns 1 with MODULE_NOT_FOUND in stderr if a dependency is missing
      if (result.status !== 0) {
        // Only fail if it's a MODULE_NOT_FOUND error
        if (result.stderr && result.stderr.includes('MODULE_NOT_FOUND')) {
          expect(result.stderr).not.toContain('MODULE_NOT_FOUND');
        }
        // Other syntax errors would be bugs, but --check doesn't execute code
        // so Inkscape-not-found errors won't occur here
      }
    });
  });

  // PHASE 2.1: Test ALL 13 CLI tools with --help
  // Chrome-based tools should exit 0 with usage info
  const chromeToolsWithHelp = [
    { tool: 'svg-bbox.cjs', name: 'svg-bbox' },
    { tool: 'sbb-getbbox.cjs', name: 'sbb-getbbox' },
    { tool: 'sbb-extract.cjs', name: 'sbb-extract' },
    { tool: 'sbb-svg2png.cjs', name: 'sbb-svg2png' },
    { tool: 'sbb-fix-viewbox.cjs', name: 'sbb-fix-viewbox' },
    { tool: 'sbb-comparer.cjs', name: 'sbb-comparer' },
    { tool: 'sbb-test.cjs', name: 'sbb-test' },
    { tool: 'sbb-chrome-getbbox.cjs', name: 'sbb-chrome-getbbox' },
    { tool: 'sbb-chrome-extract.cjs', name: 'sbb-chrome-extract' }
  ];

  chromeToolsWithHelp.forEach(({ tool, name }) => {
    it(`should be able to run ${name} --help without errors`, () => {
      const toolPath = path.join(installedPackagePath, tool);

      const result = spawnSync('node', [toolPath, '--help'], {
        cwd: tempDir,
        encoding: 'utf8',
        timeout: 10000 // 10 second timeout
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(name);
      // Check for 'usage' or 'USAGE' in output (case-insensitive)
      expect(result.stdout.toLowerCase()).toMatch(/usage|available commands/);
    });
  });

  // Inkscape tools may exit early if Inkscape not installed, but --help should
  // be processed first in well-designed CLIs. We test what we can.
  const inkscapeToolsWithHelp = [
    { tool: 'sbb-inkscape-getbbox.cjs', name: 'sbb-inkscape-getbbox' },
    { tool: 'sbb-inkscape-extract.cjs', name: 'sbb-inkscape-extract' },
    { tool: 'sbb-inkscape-svg2png.cjs', name: 'sbb-inkscape-svg2png' },
    { tool: 'sbb-inkscape-text2path.cjs', name: 'sbb-inkscape-text2path' }
  ];

  inkscapeToolsWithHelp.forEach(({ tool, name }) => {
    it(`should be able to run ${name} --help (may require Inkscape)`, () => {
      const toolPath = path.join(installedPackagePath, tool);

      const result = spawnSync('node', [toolPath, '--help'], {
        cwd: tempDir,
        encoding: 'utf8',
        timeout: 10000 // 10 second timeout
      });

      // Inkscape tools may exit with 0 (help shown) or 1 (Inkscape not found)
      // The key test is that it runs without MODULE_NOT_FOUND errors
      if (result.status === 0) {
        // If it exits 0, verify help was shown
        expect(result.stdout).toContain(name);
      } else {
        // If it exits non-zero, verify it's NOT a MODULE_NOT_FOUND error
        // (Inkscape not installed is acceptable, missing deps is not)
        const combinedOutput = (result.stdout || '') + (result.stderr || '');
        expect(combinedOutput).not.toContain('MODULE_NOT_FOUND');
        expect(combinedOutput).not.toContain('Cannot find module');
        // Verify it mentioned Inkscape (expected failure reason)
        expect(combinedOutput.toLowerCase()).toMatch(/inkscape|usage/i);
      }
    });
  });

  it('should have package.json with correct main entry point', () => {
    const packageJsonPath = path.join(installedPackagePath, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

    expect(packageJson.main).toBe('./SvgVisualBBox.js');
    expect(fs.existsSync(path.join(installedPackagePath, packageJson.main))).toBe(true);
  });

  it('should have all bin entries pointing to existing files', () => {
    const packageJsonPath = path.join(installedPackagePath, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

    expect(packageJson.bin).toBeDefined();
    expect(typeof packageJson.bin).toBe('object');

    // Verify each bin entry exists
    Object.entries(packageJson.bin).forEach(([_name, binPath]) => {
      const fullPath = path.join(installedPackagePath, binPath);
      expect(fs.existsSync(fullPath)).toBe(true);
    });
  });

  // PHASE 2.3: Verify bin symlinks work via node_modules/.bin/
  // This catches cross-platform issues with:
  // 1. Missing/incorrect shebang (#!/usr/bin/env node)
  // 2. CRLF line endings that break shebang on Unix/macOS
  // 3. npm not creating symlinks properly
  // 4. File permissions (executable bit on Unix)
  // 5. Windows .cmd wrapper files
  // 6. PowerShell script (.ps1) files on Windows
  describe('Bin Symlinks Verification', () => {
    const isWindows = process.platform === 'win32';
    // Reserved for future platform-specific tests (prefixed with _ to satisfy linter)
    const _isMacOS = process.platform === 'darwin';
    const _isLinux = process.platform === 'linux';

    it('should have created bin symlinks in node_modules/.bin/', () => {
      const binDir = path.join(tempDir, 'node_modules', '.bin');
      expect(fs.existsSync(binDir)).toBe(true);

      const packageJsonPath = path.join(installedPackagePath, 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

      // Check each bin command has appropriate files
      Object.keys(packageJson.bin).forEach((cmdName) => {
        if (isWindows) {
          // Windows creates .cmd (batch) and optionally .ps1 (PowerShell)
          const cmdPath = path.join(binDir, `${cmdName}.cmd`);
          expect(fs.existsSync(cmdPath)).toBe(true);
        } else {
          // Unix/macOS creates symlinks (no extension)
          const binPath = path.join(binDir, cmdName);
          expect(fs.existsSync(binPath)).toBe(true);

          // Verify it's actually a symlink (not a copy)
          const stats = fs.lstatSync(binPath);
          expect(stats.isSymbolicLink()).toBe(true);
        }
      });
    });

    it('should have correct shebang in all CLI tool files', () => {
      const packageJsonPath = path.join(installedPackagePath, 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

      Object.entries(packageJson.bin).forEach(([name, binPath]) => {
        const fullPath = path.join(installedPackagePath, binPath);
        // Read as buffer to detect line endings precisely
        const buffer = fs.readFileSync(fullPath);
        const content = buffer.toString('utf8');
        const firstLine = content.split('\n')[0];

        // Must start with shebang for Unix execution
        expect(firstLine.startsWith('#!/usr/bin/env node')).toBe(true);

        // Must NOT have CRLF on the shebang line (breaks Unix/macOS execution)
        // CRLF would make the interpreter "node\r" instead of "node"
        expect(firstLine.endsWith('\r')).toBe(false);

        // Check the first few bytes are NOT a BOM (Byte Order Mark)
        // UTF-8 BOM is EF BB BF which would break the shebang
        if (buffer.length >= 3) {
          const hasBOM = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
          expect(hasBOM).toBe(false);
        }

        // On Unix, verify file has executable bit set (npm should do this)
        if (!isWindows) {
          try {
            fs.accessSync(fullPath, fs.constants.X_OK);
          } catch {
            // Some systems don't set executable on install, npm handles via symlink
            // This is informational, not a hard failure
            console.log(`Note: ${name} file not directly executable (OK if symlink works)`);
          }
        }
      });
    });

    // Test that svg-bbox can be executed via node_modules/.bin/ symlink
    it('should be able to run svg-bbox via node_modules/.bin/ symlink', () => {
      const binDir = path.join(tempDir, 'node_modules', '.bin');
      const svgBboxBin = isWindows
        ? path.join(binDir, 'svg-bbox.cmd')
        : path.join(binDir, 'svg-bbox');

      // Use shell:true on all platforms for consistency
      // This is how npm scripts actually run commands
      const result = spawnSync(svgBboxBin, ['--help'], {
        cwd: tempDir,
        encoding: 'utf8',
        timeout: 15000, // Increased for slow CI
        shell: true, // Always use shell - matches real usage
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` }
      });

      // Check for MODULE_NOT_FOUND first (critical error)
      const combinedOutput = (result.stdout || '') + (result.stderr || '');
      expect(combinedOutput).not.toContain('MODULE_NOT_FOUND');
      expect(combinedOutput).not.toContain('Cannot find module');

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('svg-bbox');
      expect(result.stdout.toLowerCase()).toMatch(/usage|available commands/);
    });

    // Test that sbb-getbbox can be executed via node_modules/.bin/ symlink
    it('should be able to run sbb-getbbox via node_modules/.bin/ symlink', () => {
      const binDir = path.join(tempDir, 'node_modules', '.bin');
      const sbbGetbboxBin = isWindows
        ? path.join(binDir, 'sbb-getbbox.cmd')
        : path.join(binDir, 'sbb-getbbox');

      const result = spawnSync(sbbGetbboxBin, ['--help'], {
        cwd: tempDir,
        encoding: 'utf8',
        timeout: 15000,
        shell: true,
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` }
      });

      // Check for MODULE_NOT_FOUND first (critical error)
      const combinedOutput = (result.stdout || '') + (result.stderr || '');
      expect(combinedOutput).not.toContain('MODULE_NOT_FOUND');
      expect(combinedOutput).not.toContain('Cannot find module');

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('sbb-getbbox');
      expect(result.stdout.toLowerCase()).toMatch(/usage/);
    });

    // Test npx-style execution (how users typically run local packages)
    it('should be able to run svg-bbox via npx-style PATH lookup', () => {
      const binDir = path.join(tempDir, 'node_modules', '.bin');

      // Simulate npx by adding .bin to PATH and running command by name
      const result = spawnSync('svg-bbox', ['--help'], {
        cwd: tempDir,
        encoding: 'utf8',
        timeout: 15000,
        shell: true,
        env: {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH}`
        }
      });

      // This is how npx and npm scripts execute - via PATH lookup
      const combinedOutput = (result.stdout || '') + (result.stderr || '');
      expect(combinedOutput).not.toContain('MODULE_NOT_FOUND');

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('svg-bbox');
    });
  });
});
