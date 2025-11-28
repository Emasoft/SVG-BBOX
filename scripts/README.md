# Scripts Directory

This directory contains automation scripts for the svg-bbox project.

## Release Script

**`release.sh`** - Automated release script with proper sequencing

### Features

- ✅ Validates all prerequisites (gh CLI, npm, pnpm, jq)
- ✅ Runs quality checks (lint, typecheck, tests)
- ✅ Bumps version automatically
- ✅ Generates release notes from commits
- ✅ Creates GitHub Release **FIRST** (correct order!)
- ✅ Waits for GitHub Actions to publish to npm
- ✅ Verifies npm publication
- ✅ Colored output with progress indicators
- ✅ Error handling and rollback

### Usage

```bash
# Bump patch version (1.0.10 → 1.0.11)
./scripts/release.sh patch

# Bump minor version (1.0.10 → 1.1.0)
./scripts/release.sh minor

# Bump major version (1.0.10 → 2.0.0)
./scripts/release.sh major

# Release specific version
./scripts/release.sh 1.0.11
```

### Prerequisites

1. **gh CLI** - GitHub CLI installed and authenticated

   ```bash
   # Install
   brew install gh  # macOS
   # or download from https://cli.github.com/

   # Authenticate
   gh auth login
   ```

2. **jq** - JSON processor for parsing npm output

   ```bash
   brew install jq  # macOS
   sudo apt-get install jq  # Linux
   ```

3. **npm & pnpm** - Package managers

   ```bash
   npm install -g pnpm
   ```

4. **Clean working directory** - No uncommitted changes

   ```bash
   git status  # Should show clean
   ```

5. **On main branch**
   ```bash
   git checkout main
   ```

### What It Does (Step by Step)

1. **Validates prerequisites** - Checks for gh, npm, pnpm, jq, authentication
2. **Checks environment** - Ensures clean working directory, on main branch
3. **Gets current version** - Reads from package.json
4. **Determines new version** - Based on your input (patch/minor/major/specific)
5. **Asks for confirmation** - Gives you a chance to cancel
6. **Runs quality checks**:
   - Linting (ESLint + Prettier)
   - Type checking (TypeScript)
   - All tests (192 tests)
7. **Generates release notes** - From git commits since last release
8. **Commits version bump** - Updates package.json and pnpm-lock.yaml
9. **Creates git tag** - Annotated tag with version
10. **Pushes to GitHub** - Commits and tag
11. **Creates GitHub Release** - 🔑 **Critical step that triggers workflow**
12. **Waits for GitHub Actions** - Monitors "Publish to npm" workflow
13. **Verifies npm publication** - Checks that package is live

### Why This Order Matters

The script creates the GitHub Release **BEFORE** npm publish happens. This is
critical because:

- ❌ **Wrong:** Tag → npm → GitHub Release (causes sync issues, missing links)
- ✅ **Right:** Tag → GitHub Release → npm (proper linking, audit trail)

The GitHub Actions workflow publishes to npm **after** the GitHub Release is
created, ensuring:

- Release notes are attached to the tag
- npm package links to GitHub Release
- Proper version tracking across both platforms

### Output Example

```
═══════════════════════════════════════════════════════════
  SVG-BBOX Release Script
═══════════════════════════════════════════════════════════

ℹ Validating prerequisites...
✓ All prerequisites met
ℹ Checking working directory...
✓ Working directory is clean
ℹ Checking current branch...
✓ On main branch
ℹ Current version: 1.0.10
ℹ Bumping version (patch)...
✓ Version bumped to 1.0.11

ℹ Release version: 1.0.11

Do you want to release v1.0.11? [y/N] y
ℹ Running quality checks...
ℹ   → Linting...
✓   Linting passed
ℹ   → Type checking...
✓   Type checking passed
ℹ   → Running tests...
✓   Tests passed
✓ All quality checks passed
ℹ Generating release notes...
✓ Release notes generated
ℹ Committing version bump...
✓ Version bump committed
ℹ Creating git tag v1.0.11...
✓ Git tag created
ℹ Pushing to GitHub...
✓ Commits pushed
✓ Tag pushed
ℹ Creating GitHub Release...
✓ GitHub Release created: https://github.com/Emasoft/SVG-BBOX/releases/tag/v1.0.11
ℹ Waiting for GitHub Actions 'Publish to npm' workflow...
..........
✓ GitHub Actions workflow completed successfully
ℹ Verifying npm publication...
....
✓ Package svg-bbox@1.0.11 is live on npm!
✓ Install with: npm install svg-bbox@1.0.11

═══════════════════════════════════════════════════════════
✓ Release v1.0.11 completed successfully!
═══════════════════════════════════════════════════════════

ℹ GitHub Release: https://github.com/Emasoft/SVG-BBOX/releases/tag/v1.0.11
ℹ npm Package: https://www.npmjs.com/package/svg-bbox
ℹ Install: npm install svg-bbox@1.0.11
```

### Troubleshooting

**"gh CLI is not installed"**

```bash
brew install gh  # macOS
# or download from https://cli.github.com/
```

**"GitHub CLI is not authenticated"**

```bash
gh auth login
```

**"jq is not installed"**

```bash
brew install jq  # macOS
sudo apt-get install jq  # Linux
```

**"Working directory is not clean"**

```bash
git status
git add .
git commit -m "Your changes"
```

**"Must be on main branch"**

```bash
git checkout main
```

**"Tag vX.Y.Z already exists locally"**

```bash
git tag -d vX.Y.Z  # Delete local tag
# The script will recreate it
```

**"GitHub Actions workflow failed"**

```bash
# View workflow logs
gh run view --log

# Check npm trusted publishing configuration
# Visit: https://www.npmjs.com/package/svg-bbox/access
```

### Safety Features

- ✅ Validates all prerequisites before starting
- ✅ Checks for clean working directory
- ✅ Confirms version bump with user
- ✅ Runs all quality checks before release
- ✅ Automatically handles tag conflicts
- ✅ Waits for GitHub Actions completion
- ✅ Verifies npm publication
- ✅ Provides rollback instructions on failure

## Other Scripts

### `build-min.cjs`

Builds the minified browser library using Terser.

### `bump-version.cjs`

Updates version across package.json and version.cjs (used by release.sh).

### `test-selective.cjs`

Intelligent test runner that only runs tests affected by changed files. Used by
pre-commit hooks for 90% faster test execution.

## Development Scripts (scripts_dev/)

Scripts in `scripts_dev/` are development/experimental scripts not part of the
release process:

- `convert-text-to-paths.sh` - Convert text to paths using Inkscape
- `extract_with_getbbox.cjs` - Extract SVG objects using getbbox
- `scan_getbbox.sh` - Scan SVG files for bbox extraction
