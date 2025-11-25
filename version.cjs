#!/usr/bin/env node

/**
 * version.cjs - Centralized version management for SVG-BBOX toolkit
 *
 * All CLI tools are strictly interdependent and share the same version.
 * This module provides version information from package.json.
 */

const fs = require('fs');
const path = require('path');

/**
 * Get the current version from package.json
 * @returns {string} Version string (e.g., "1.0.0")
 */
function getVersion() {
  try {
    const packagePath = path.join(__dirname, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    return packageJson.version || '0.0.0';
  } catch (error) {
    console.error('Error reading version from package.json:', error.message);
    return '0.0.0';
  }
}

/**
 * Get full version info including package name
 * @returns {object} Version info object
 */
function getVersionInfo() {
  try {
    const packagePath = path.join(__dirname, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    return {
      name: packageJson.name || 'svg-bbox',
      version: packageJson.version || '0.0.0',
      description: packageJson.description || ''
    };
  } catch (error) {
    console.error('Error reading package.json:', error.message);
    return {
      name: 'svg-bbox',
      version: '0.0.0',
      description: ''
    };
  }
}

/**
 * Print version information to console
 * @param {string} toolName - Name of the CLI tool
 */
function printVersion(toolName) {
  const info = getVersionInfo();
  console.log(`${toolName || info.name} v${info.version}`);
}

/**
 * Print version banner for CLI tools
 * @param {string} toolName - Name of the CLI tool
 */
function printVersionBanner(toolName) {
  const info = getVersionInfo();
  console.log(`${toolName} v${info.version} | ${info.name}`);
}

/**
 * Check if --version or -v flag is present in arguments
 * @param {string[]} args - Command line arguments
 * @returns {boolean} True if version flag found
 */
function hasVersionFlag(args) {
  return args.includes('--version') || args.includes('-v');
}

module.exports = {
  getVersion,
  getVersionInfo,
  printVersion,
  printVersionBanner,
  hasVersionFlag
};

// If run directly, print version
if (require.main === module) {
  printVersion();
}
