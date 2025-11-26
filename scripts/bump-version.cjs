#!/usr/bin/env node

/**
 * bump-version.cjs - Semantic version bumping for SVG-BBOX
 *
 * Usage:
 *   node scripts/bump-version.cjs <patch|minor|major|<version>>
 *
 * Examples:
 *   node scripts/bump-version.cjs patch     # 1.0.0 -> 1.0.1
 *   node scripts/bump-version.cjs minor     # 1.0.0 -> 1.1.0
 *   node scripts/bump-version.cjs major     # 1.0.0 -> 2.0.0
 *   node scripts/bump-version.cjs 1.2.3     # Set to specific version
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Parse semantic version string
 * @param {string} version - Version string (e.g., "1.2.3")
 * @returns {object} Parsed version {major, minor, patch}
 */
function parseVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Invalid version format: ${version}`);
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10)
  };
}

/**
 * Bump version according to type
 * @param {string} currentVersion - Current version string
 * @param {string} bumpType - Type of bump (patch|minor|major)
 * @returns {string} New version string
 */
function bumpVersion(currentVersion, bumpType) {
  const { major, minor, patch } = parseVersion(currentVersion);

  switch (bumpType) {
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'major':
      return `${major + 1}.0.0`;
    default:
      // Assume it's a specific version
      parseVersion(bumpType); // Validate format
      return bumpType;
  }
}

/**
 * Update version in package.json
 * @param {string} newVersion - New version string
 */
function updatePackageJson(newVersion) {
  const packagePath = path.join(__dirname, '..', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const oldVersion = packageJson.version;

  packageJson.version = newVersion;

  fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
  console.log(`✓ Updated package.json: ${oldVersion} → ${newVersion}`);

  return oldVersion;
}

/**
 * Update version in CHANGELOG.md
 * @param {string} newVersion - New version string
 */
function updateChangelog(newVersion) {
  const changelogPath = path.join(__dirname, '..', 'CHANGELOG.md');

  if (!fs.existsSync(changelogPath)) {
    console.log('⚠️  CHANGELOG.md not found, skipping');
    return;
  }

  let content = fs.readFileSync(changelogPath, 'utf8');
  const date = new Date().toISOString().split('T')[0];

  // Replace [Unreleased] with new version
  content = content.replace(/## \[Unreleased\]/, `## [Unreleased]\n\n## [${newVersion}] - ${date}`);

  // Update comparison links at bottom
  const lines = content.split('\n');
  const lastLinkIndex = lines.findIndex((line) => line.match(/^\[Unreleased\]:/));

  if (lastLinkIndex !== -1) {
    lines[lastLinkIndex] =
      `[Unreleased]: https://github.com/Emasoft/SVG-BBOX/compare/v${newVersion}...HEAD`;
    lines.splice(
      lastLinkIndex + 1,
      0,
      `[${newVersion}]: https://github.com/Emasoft/SVG-BBOX/releases/tag/v${newVersion}`
    );
    content = lines.join('\n');
  }

  fs.writeFileSync(changelogPath, content);
  console.log(`✓ Updated CHANGELOG.md with version ${newVersion}`);
}

/**
 * Create git tag for version
 * @param {string} newVersion - New version string
 * @param {boolean} dryRun - If true, don't actually create tag
 */
function createGitTag(newVersion, dryRun = false) {
  const tagName = `v${newVersion}`;

  if (dryRun) {
    console.log(`Would create git tag: ${tagName}`);
    return;
  }

  try {
    // Check if tag already exists
    try {
      execSync(`git rev-parse ${tagName}`, { stdio: 'ignore' });
      console.log(`⚠️  Tag ${tagName} already exists, skipping`);
      return;
    } catch {
      // Tag doesn't exist, proceed
    }

    // Create annotated tag - NO USER INPUT, SAFE
    execSync(`git tag -a ${tagName} -m "Release ${newVersion}"`, {
      stdio: 'inherit'
    });
    console.log(`✓ Created git tag: ${tagName}`);
    console.log('  Push with: git push origin main --tags');
  } catch (error) {
    console.error(`✗ Failed to create git tag: ${error.message}`);
  }
}

/**
 * Main function
 */
function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
╔════════════════════════════════════════════════════════════════════════════╗
║ bump-version.cjs - Semantic Version Bumping                               ║
╚════════════════════════════════════════════════════════════════════════════╝

USAGE:
  node scripts/bump-version.cjs <patch|minor|major|<version>> [options]

BUMP TYPES:
  patch      Increment patch version (1.0.0 -> 1.0.1)
             Use for bug fixes and minor changes

  minor      Increment minor version (1.0.0 -> 1.1.0)
             Use for new features (backwards compatible)

  major      Increment major version (1.0.0 -> 2.0.0)
             Use for breaking changes

  <version>  Set specific version (e.g., 1.2.3)
             Must be valid semantic version (X.Y.Z)

OPTIONS:
  --dry-run  Show what would be changed without making changes
  --tag      Create git tag after bumping (default: true)
  --no-tag   Don't create git tag
  --help     Show this help message

EXAMPLES:
  node scripts/bump-version.cjs patch
  node scripts/bump-version.cjs minor --dry-run
  node scripts/bump-version.cjs 2.0.0 --no-tag
`);
    process.exit(0);
  }

  const bumpType = args[0];
  const dryRun = args.includes('--dry-run');
  const createTag = !args.includes('--no-tag');

  try {
    const packagePath = path.join(__dirname, '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const currentVersion = packageJson.version;
    const newVersion = bumpVersion(currentVersion, bumpType);

    console.log('\n📦 SVG-BBOX Version Bump\n');
    console.log(`Current version: ${currentVersion}`);
    console.log(`New version:     ${newVersion}`);

    if (!dryRun) {
      updatePackageJson(newVersion);
      updateChangelog(newVersion);
      if (createTag) {
        createGitTag(newVersion, dryRun);
      }
      console.log('\n✅ Version bump complete!\n');
    } else {
      console.log('\n🔍 DRY RUN - No changes made\n');
    }
  } catch (error) {
    console.error(`\n✗ Error: ${error.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseVersion, bumpVersion, updatePackageJson, updateChangelog, createGitTag };
