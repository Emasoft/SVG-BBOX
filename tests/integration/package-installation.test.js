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
    console.log('  Creating package tarball...');
    const packResult = spawnSync('npm', ['pack'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    if (packResult.status !== 0) {
      throw new Error(`npm pack failed: ${packResult.stderr}`);
    }

    // Extract tarball filename from output (last line)
    packageTarball = packResult.stdout.trim().split('\n').pop();
    const tarballPath = path.join(process.cwd(), packageTarball);

    console.log(`  Tarball created: ${packageTarball}`);

    // Install the tarball in temp directory
    console.log('  Installing package from tarball...');
    const installResult = spawnSync('npm', ['install', '--no-save', tarballPath], {
      cwd: tempDir,
      encoding: 'utf8',
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

    // This will throw if module can't be loaded or has missing dependencies
    const cliUtils = require(cliUtilsPath);

    // Verify it's an object with expected structure
    expect(typeof cliUtils).toBe('object');
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
  const cliTools = [
    'sbb-getbbox.cjs',
    'sbb-extract.cjs',
    'sbb-render.cjs',
    'sbb-fix-viewbox.cjs',
    'sbb-comparer.cjs',
    'sbb-test.cjs',
    'sbb-chrome-extract.cjs',
    'sbb-chrome-getbbox.cjs',
    'sbb-inkscape-extract.cjs',
    'sbb-inkscape-getbbox.cjs',
    'sbb-inkscape-svg2png.cjs',
    'sbb-inkscape-text2path.cjs',
    'svg-bbox.cjs',
  ];

  cliTools.forEach((tool) => {
    it(`should be able to require ${tool} without errors`, () => {
      const toolPath = path.join(installedPackagePath, tool);

      expect(fs.existsSync(toolPath)).toBe(true);

      // Try to require the tool - this will fail with MODULE_NOT_FOUND if dependencies are missing
      // We can't execute it because it might require command-line args, but we can test require()
      expect(() => {
        // Use dynamic import path to avoid caching issues
        delete require.cache[toolPath];
        require(toolPath);
      }).not.toThrow();
    });
  });

  it('should be able to run sbb-getbbox --help without errors', () => {
    const toolPath = path.join(installedPackagePath, 'sbb-getbbox.cjs');

    // Run the tool with --help flag - using spawnSync for safety
    const result = spawnSync('node', [toolPath, '--help'], {
      cwd: tempDir,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('sbb-getbbox');
    expect(result.stdout.toLowerCase()).toContain('usage');
  });

  it('should be able to run svg-bbox --help without errors', () => {
    const toolPath = path.join(installedPackagePath, 'svg-bbox.cjs');

    const result = spawnSync('node', [toolPath, '--help'], {
      cwd: tempDir,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('svg-bbox');
    expect(result.stdout.toLowerCase()).toContain('usage');
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
});
