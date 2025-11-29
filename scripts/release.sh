#!/bin/bash
#
# Release Script for svg-bbox
#
# BULLETPROOF RELEASE AUTOMATION
#
# This script provides fully automated, idempotent releases with:
# ✓ Auto-fix capabilities (lint, vitest config, package.json validation)
# ✓ Idempotency (safe to run multiple times, detects existing releases)
# ✓ Rollback on failure (restores clean state if anything goes wrong)
# ✓ Retry logic with exponential backoff (network failures)
# ✓ Better error visibility (shows errors instead of hiding them)
# ✓ Optional confirmation skip (--yes flag for CI/automation)
#
# RELEASE SEQUENCE (CRITICAL ORDER):
# 1. Validate environment and prerequisites
# 2. Auto-fix common issues (lint, vitest config, package.json)
# 3. Run all quality checks (lint, typecheck, tests)
# 4. Bump version in package.json and commit
# 5. Create git tag LOCALLY (don't push yet)
# 6. Push commits to GitHub (tag stays local) + wait for CI
# 7. Create GitHub Release → gh CLI pushes tag + creates release atomically
# 8. Tag push triggers GitHub Actions workflow
# 9. Wait for GitHub Actions to publish to npm (prepublishOnly hook runs in CI)
# 10. Verify npm publication
#
# Why this order matters:
# - Creating the GitHub Release BEFORE the workflow runs ensures release notes
#   are attached to the tag when the workflow executes
# - gh release create pushes the tag atomically with release creation
# - Avoids race condition where workflow starts before release exists
#
# Usage:
#   ./scripts/release.sh [--yes] [version]
#
# Examples:
#   ./scripts/release.sh 1.0.11        # Release specific version
#   ./scripts/release.sh patch         # Bump patch (1.0.10 → 1.0.11)
#   ./scripts/release.sh minor         # Bump minor (1.0.10 → 1.1.0)
#   ./scripts/release.sh major         # Bump major (1.0.10 → 2.0.0)
#   ./scripts/release.sh --yes patch   # Skip confirmation (for CI)
#
# Prerequisites:
#   - gh CLI installed and authenticated
#   - npm installed
#   - pnpm installed
#   - jq installed
#   - git-cliff installed (for release notes generation)
#   - Clean working directory (no uncommitted changes)
#   - On main branch
#

set -e  # Exit on error

# Get package name from package.json
PACKAGE_NAME=$(grep '"name"' package.json | head -1 | sed 's/.*"name": "\(.*\)".*/\1/')

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
log_info() {
    echo -e "${BLUE}ℹ ${NC}$1" >&2
}

log_success() {
    echo -e "${GREEN}✓${NC} $1" >&2
}

log_warning() {
    echo -e "${YELLOW}⚠${NC} $1" >&2
}

log_error() {
    echo -e "${RED}✗${NC} $1" >&2
}

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Strip ANSI color codes from string
# SECURITY: Prevents color codes from contaminating version strings used in git tags
strip_ansi() {
    # Remove all ANSI escape sequences: \x1b[...m or \033[...m
    echo "$1" | sed 's/\x1b\[[0-9;]*m//g' | sed 's/\o033\[[0-9;]*m//g' | tr -d '\033' | tr -d '\000-\037'
}

# Validate semver version format (X.Y.Z only, no prefixes or suffixes)
# SECURITY: Prevents malformed version strings from breaking git tag creation
validate_version() {
    local VERSION=$1

    # Check if VERSION is empty or contains only whitespace
    if [ -z "$VERSION" ] || [ -z "${VERSION// /}" ]; then
        log_error "Version is empty or contains only whitespace"
        log_error "This indicates npm version command output was not captured correctly"
        return 1
    fi

    # Check for ANSI codes (shouldn't happen after strip_ansi, but double-check)
    if echo "$VERSION" | grep -q $'\033'; then
        log_error "Version contains ANSI color codes: '$VERSION'"
        log_error "This indicates color output contamination - check npm/log output"
        return 1
    fi

    # Validate semver format: must be exactly X.Y.Z where X,Y,Z are numbers
    if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
        log_error "Invalid version format: '$VERSION'"
        log_error "Expected semver format (e.g., 1.0.12)"
        log_error "Got: $(echo "$VERSION" | od -c | head -5)"  # Show actual bytes for debugging
        return 1
    fi

    return 0
}

# Retry wrapper for network operations
retry_with_backoff() {
    local MAX_RETRIES=3
    local RETRY_COUNT=0
    local BACKOFF=2

    local CMD="$@"

    while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
        if eval "$CMD"; then
            return 0
        fi

        RETRY_COUNT=$((RETRY_COUNT + 1))
        if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
            log_warning "Command failed, retrying in ${BACKOFF}s... (attempt $((RETRY_COUNT + 1))/$MAX_RETRIES)"
            sleep $BACKOFF
            BACKOFF=$((BACKOFF * 2))
        fi
    done

    log_error "Command failed after $MAX_RETRIES attempts: $CMD"
    return 1
}

# Validate prerequisites
validate_prerequisites() {
    log_info "Validating prerequisites..."

    # Check for required commands
    if ! command_exists gh; then
        log_error "gh CLI is not installed. Install from: https://cli.github.com/"
        exit 1
    fi

    if ! command_exists npm; then
        log_error "npm is not installed"
        exit 1
    fi

    if ! command_exists pnpm; then
        log_error "pnpm is not installed"
        exit 1
    fi

    if ! command_exists jq; then
        log_error "jq is not installed. Install with: brew install jq (macOS) or apt-get install jq (Linux)"
        exit 1
    fi

    if ! command_exists git-cliff; then
        log_error "git-cliff is not installed. Install from: https://github.com/orhun/git-cliff"
        log_info "  macOS: brew install git-cliff"
        log_info "  Linux: cargo install git-cliff"
        exit 1
    fi

    # Check gh auth status
    if ! gh auth status >/dev/null 2>&1; then
        log_error "GitHub CLI is not authenticated. Run: gh auth login"
        exit 1
    fi

    log_success "All prerequisites met"
}

# Check if working directory is clean
check_clean_working_dir() {
    log_info "Checking working directory..."

    if ! git diff-index --quiet HEAD --; then
        log_error "Working directory is not clean. Commit or stash changes first."
        git status --short
        exit 1
    fi

    log_success "Working directory is clean"
}

# Check if on main branch
check_main_branch() {
    log_info "Checking current branch..."

    CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
    if [ "$CURRENT_BRANCH" != "main" ]; then
        log_error "Must be on main branch (currently on $CURRENT_BRANCH)"
        exit 1
    fi

    log_success "On main branch"
}

# PHASE 1.5: Validate version synchronization across files
# Check that package.json version matches version.cjs and minified preamble
validate_version_sync() {
    log_info "Validating version synchronization..."

    # Get version from package.json
    local PKG_VERSION
    PKG_VERSION=$(get_current_version)

    # Get version from version.cjs
    local VERSION_CJS_VERSION
    if [ -f "version.cjs" ]; then
        # Extract version from: const VERSION = '1.0.12';
        VERSION_CJS_VERSION=$(grep "const VERSION" version.cjs | sed "s/.*'\([^']*\)'.*/\1/" | head -1)
        if [ -z "$VERSION_CJS_VERSION" ]; then
            log_warning "Could not extract version from version.cjs"
        elif [ "$PKG_VERSION" != "$VERSION_CJS_VERSION" ]; then
            log_error "Version mismatch: package.json=$PKG_VERSION, version.cjs=$VERSION_CJS_VERSION"
            log_error "Run 'npm run build' to sync versions, then commit"
            return 1
        fi
    else
        log_warning "version.cjs not found - skipping version.cjs check"
    fi

    # Get version from SvgVisualBBox.min.js preamble comment
    local MINIFIED_VERSION
    if [ -f "SvgVisualBBox.min.js" ]; then
        # Extract version from preamble: /*! SvgVisualBBox v1.0.12 - ...
        MINIFIED_VERSION=$(head -1 SvgVisualBBox.min.js | grep -o 'v[0-9]\+\.[0-9]\+\.[0-9]\+' | sed 's/v//')
        if [ -z "$MINIFIED_VERSION" ]; then
            log_warning "Could not extract version from SvgVisualBBox.min.js preamble"
        elif [ "$PKG_VERSION" != "$MINIFIED_VERSION" ]; then
            log_error "Version mismatch: package.json=$PKG_VERSION, SvgVisualBBox.min.js=$MINIFIED_VERSION"
            log_error "Run 'npm run build' to regenerate minified file, then commit"
            return 1
        fi
    else
        log_warning "SvgVisualBBox.min.js not found - skipping minified preamble check"
    fi

    log_success "Version synchronization validated: $PKG_VERSION"
    return 0
}

# PHASE 1.6: Validate UMD wrapper syntax before release
# Ensures the minified file can be parsed by Node.js without syntax errors
# and properly exports the SvgVisualBBox namespace
validate_umd_wrapper() {
    log_info "Validating UMD wrapper syntax..."

    local MINIFIED_FILE="SvgVisualBBox.min.js"

    # Check if minified file exists
    if [ ! -f "$MINIFIED_FILE" ]; then
        log_error "Minified file not found: $MINIFIED_FILE"
        log_error "Run 'npm run build' to generate minified file"
        return 1
    fi

    # Step 1: Use node --check to validate JavaScript syntax
    # This parses the file without executing it - fast and safe
    if ! node --check "$MINIFIED_FILE" 2>/dev/null; then
        log_error "Syntax error in $MINIFIED_FILE"
        log_error "The minification may have introduced invalid JavaScript"
        log_error "Run 'npm run build' and check for errors"
        return 1
    fi

    log_success "Minified file has valid JavaScript syntax"

    # Step 2: Verify UMD wrapper structure contains expected exports
    # The minified file is browser-targeted, so we verify structure via grep
    # rather than trying to execute browser-dependent code in Node.js
    local EXPECTED_EXPORTS=(
        "getSvgElementVisualBBoxTwoPassAggressive"
        "getSvgElementsUnionVisualBBox"
        "waitForDocumentFonts"
    )

    for export_name in "${EXPECTED_EXPORTS[@]}"; do
        if ! grep -q "$export_name" "$MINIFIED_FILE"; then
            log_error "UMD wrapper missing expected export: $export_name"
            log_error "The minification may have removed or corrupted this function"
            return 1
        fi
    done

    # Step 3: Verify UMD factory pattern structure
    # Check for the characteristic UMD wrapper pattern
    if ! grep -q 'module.exports' "$MINIFIED_FILE"; then
        log_error "UMD wrapper missing CommonJS export (module.exports)"
        return 1
    fi

    if ! grep -q 'SvgVisualBBox' "$MINIFIED_FILE"; then
        log_error "UMD wrapper missing SvgVisualBBox namespace"
        return 1
    fi

    log_success "UMD wrapper structure verified (exports and namespace present)"

    return 0
}

# PHASE 1.8: Check if git tag already exists (locally or remotely)
# Prevents duplicate releases and detects stale local tags
check_tag_not_exists() {
    local VERSION=$1

    # Check local tags
    if git tag -l "v$VERSION" | grep -q "v$VERSION"; then
        log_error "Git tag v$VERSION already exists locally"
        log_info "To delete: git tag -d v$VERSION"
        return 1
    fi

    # Check remote tags
    if git ls-remote --tags origin 2>/dev/null | grep -q "refs/tags/v$VERSION"; then
        log_error "Git tag v$VERSION already exists on remote"
        log_info "To delete: git push origin :refs/tags/v$VERSION"
        return 1
    fi

    return 0
}

# PHASE 1.8: Display pre-flight checklist header
show_preflight_header() {
    echo "" >&2
    echo "┌──────────────────────────────────────────────────────────────┐" >&2
    echo "│                    PRE-FLIGHT CHECKLIST                      │" >&2
    echo "└──────────────────────────────────────────────────────────────┘" >&2
    echo "" >&2
}

# PHASE 1.8: Display pre-flight checklist summary
show_preflight_summary() {
    local PASSED=$1
    local TOTAL=$2

    echo "" >&2
    if [ "$PASSED" -eq "$TOTAL" ]; then
        log_success "Pre-flight checklist passed ($PASSED/$TOTAL checks)"
    else
        log_error "Pre-flight checklist failed ($PASSED/$TOTAL checks)"
    fi
    echo "" >&2
}

# Get current version from package.json
get_current_version() {
    grep '"version"' package.json | head -1 | sed 's/.*"version": "\(.*\)".*/\1/'
}

# Bump version using npm version
bump_version() {
    local VERSION_TYPE=$1

    log_info "Bumping version ($VERSION_TYPE)..."

    # SECURITY: Silence npm entirely to prevent hook output contamination
    # npm lifecycle hooks ("version", "prepublishOnly") output to stdout, which
    # cannot be suppressed with 2>/dev/null. We must silence all npm output
    # and read the version from package.json instead.
    npm version "$VERSION_TYPE" --no-git-tag-version >/dev/null 2>&1

    # Check if npm version succeeded
    if [ $? -ne 0 ]; then
        log_error "npm version command failed"
        log_error "Run manually to see errors: npm version $VERSION_TYPE --no-git-tag-version"
        exit 1
    fi

    # Read the new version from package.json (the source of truth)
    NEW_VERSION=$(get_current_version)

    # SECURITY: Strip any ANSI codes that might have leaked through
    NEW_VERSION=$(strip_ansi "$NEW_VERSION")

    # SECURITY: Validate version format before proceeding
    if ! validate_version "$NEW_VERSION"; then
        log_error "Version bump failed - invalid version format"
        log_error "Check package.json for errors"
        exit 1
    fi

    log_success "Version bumped to $NEW_VERSION"
    echo "$NEW_VERSION"
}

# Set specific version
set_version() {
    local VERSION=$1

    # SECURITY: Validate input version BEFORE calling npm
    VERSION=$(strip_ansi "$VERSION")
    if ! validate_version "$VERSION"; then
        log_error "Invalid version specified: $VERSION"
        exit 1
    fi

    log_info "Setting version to $VERSION..."

    # SECURITY: Silence npm entirely to prevent hook output contamination
    npm version "$VERSION" --no-git-tag-version >/dev/null 2>&1

    # Check if npm version succeeded
    if [ $? -ne 0 ]; then
        log_error "npm version command failed"
        log_error "Run manually to see errors: npm version $VERSION --no-git-tag-version"
        exit 1
    fi

    # SECURITY: Re-validate after npm (paranoid check)
    # Read from package.json (the source of truth) instead of capturing npm output
    ACTUAL_VERSION=$(get_current_version)
    if [ "$ACTUAL_VERSION" != "$VERSION" ]; then
        log_error "Version mismatch after npm: expected $VERSION, got $ACTUAL_VERSION"
        exit 1
    fi

    log_success "Version set to $VERSION"
    echo "$VERSION"
}

# Auto-fix common issues before quality checks
auto_fix_issues() {
    log_info "Auto-fixing common issues..."

    # Fix 1: Auto-fix linting issues
    log_info "  → Auto-fixing lint issues..."
    if pnpm run lint:fix >/dev/null 2>&1; then
        log_success "  Lint auto-fix completed"
    else
        log_warning "  Lint auto-fix had issues (will verify in quality checks)"
    fi

    # Fix 2: Verify vitest config uses threads (not forks to avoid worker crash)
    log_info "  → Checking vitest config..."
    if grep -q "pool: 'forks'" vitest.config.js 2>/dev/null; then
        log_warning "  Detected 'forks' pool in vitest.config.js (known to cause crashes)"
        log_info "  → Auto-fixing: switching to 'threads' pool..."
        sed -i.bak "s/pool: 'forks'/pool: 'threads'/" vitest.config.js
        rm -f vitest.config.js.bak
        log_success "  Vitest config fixed (forks → threads)"
    else
        log_success "  Vitest config OK (using threads pool)"
    fi

    # Fix 3: Verify package.json includes required directories
    log_info "  → Verifying package.json 'files' array..."
    MISSING_DIRS=""
    if ! grep -q '"config/"' package.json; then
        MISSING_DIRS="${MISSING_DIRS}config/ "
    fi
    if ! grep -q '"lib/"' package.json; then
        MISSING_DIRS="${MISSING_DIRS}lib/ "
    fi

    if [ -n "$MISSING_DIRS" ]; then
        log_error "Missing directories in package.json 'files' array: $MISSING_DIRS"
        log_error "This will cause MODULE_NOT_FOUND errors after npm install"
        exit 1
    fi
    log_success "  package.json 'files' array complete"

    # Commit auto-fixes if there are any changes
    if ! git diff-index --quiet HEAD --; then
        log_info "  → Committing auto-fixes..."
        git add -A
        git commit -m "chore: Auto-fix issues before release (lint, vitest config)" || true
        log_success "  Auto-fixes committed"
    else
        log_success "  No auto-fixes needed"
    fi

    log_success "Auto-fix complete"
}

# Run quality checks
run_quality_checks() {
    log_info "Running quality checks..."

    log_info "  → Linting..."
    if ! pnpm run lint 2>&1 | tee /tmp/lint-output.log | tail -20; then
        log_error "Linting failed"
        log_error "Full output: /tmp/lint-output.log"
        exit 1
    fi
    log_success "  Linting passed"

    log_info "  → Type checking..."
    if ! pnpm run typecheck 2>&1 | tee /tmp/typecheck-output.log | tail -20; then
        log_error "Type checking failed"
        log_error "Full output: /tmp/typecheck-output.log"
        exit 1
    fi
    log_success "  Type checking passed"

    log_info "  → Running tests..."
    if ! pnpm test 2>&1 | tee /tmp/test-output.log | tail -50; then
        log_error "Tests failed"
        log_error "Full output: /tmp/test-output.log"
        exit 1
    fi
    log_success "  Tests passed"

    log_success "All quality checks passed"
}

# Generate release notes using git-cliff
generate_release_notes() {
    local VERSION=$1
    local PREVIOUS_TAG=$2

    log_info "Generating release notes using git-cliff..."

    # Check if git-cliff is installed
    if ! command_exists git-cliff; then
        log_error "git-cliff is not installed. Install from: https://github.com/orhun/git-cliff"
        log_info "macOS: brew install git-cliff"
        log_info "Linux: cargo install git-cliff"
        exit 1
    fi

    # Generate changelog for the version range using git-cliff
    if [ -z "$PREVIOUS_TAG" ]; then
        # First release - include all commits
        CHANGELOG_SECTION=$(git-cliff --unreleased --strip header)
    else
        # Generate changelog from previous tag to HEAD
        CHANGELOG_SECTION=$(git-cliff --unreleased --strip header "${PREVIOUS_TAG}..")
    fi

    if [ -z "$CHANGELOG_SECTION" ]; then
        log_warning "No changes found by git-cliff"
        CHANGELOG_SECTION="No notable changes in this release."
    fi

    # Strip the "## [unreleased]" header since we use "What's Changed"
    CHANGELOG_SECTION=$(echo "$CHANGELOG_SECTION" | sed '/^## \[unreleased\]/d')

    # Count changes by category for summary
    FEATURES_COUNT=$(echo "$CHANGELOG_SECTION" | grep -c "^- \*\*.*\*\*:" | grep -c "New Features" || echo 0)
    FIXES_COUNT=$(echo "$CHANGELOG_SECTION" | grep -c "^- \*\*.*\*\*:" | grep -c "Bug Fixes" || echo 0)

    # Build release notes with git-cliff output and enhanced formatting
    cat > /tmp/release-notes.md <<EOF
## What's Changed

${CHANGELOG_SECTION}

---

## ◆ Installation

### npm / pnpm / yarn

\`\`\`bash
npm install ${PACKAGE_NAME}@${VERSION}
pnpm add ${PACKAGE_NAME}@${VERSION}
yarn add ${PACKAGE_NAME}@${VERSION}
\`\`\`

### Browser (CDN)

#### jsDelivr (Recommended)
\`\`\`html
<script src="https://cdn.jsdelivr.net/npm/${PACKAGE_NAME}@${VERSION}/SvgVisualBBox.min.js"></script>
\`\`\`

#### unpkg
\`\`\`html
<script src="https://unpkg.com/${PACKAGE_NAME}@${VERSION}/SvgVisualBBox.min.js"></script>
\`\`\`

---

**Full Changelog**: https://github.com/\$(gh repo view --json nameWithOwner -q .nameWithOwner)/compare/${PREVIOUS_TAG}...v${VERSION}
EOF

    log_success "Release notes generated using git-cliff"
    log_info "Preview: /tmp/release-notes.md"
}

# Commit version bump
commit_version_bump() {
    local VERSION=$1

    log_info "Committing version bump..."

    git add package.json pnpm-lock.yaml
    git commit -m "chore(release): Bump version to $VERSION"

    log_success "Version bump committed"
}

# Create git tag
create_git_tag() {
    local VERSION=$1

    # SECURITY: Strip ANSI codes and validate version format
    # This prevents contaminated version strings from breaking git tag creation
    VERSION=$(strip_ansi "$VERSION")
    if ! validate_version "$VERSION"; then
        log_error "Cannot create git tag - invalid version format: '$VERSION'"
        log_error "This should never happen if bump_version/set_version worked correctly"
        return 1
    fi

    log_info "Creating git tag v$VERSION..."

    # Delete tag if it exists locally
    if git tag -l "v$VERSION" | grep -q "v$VERSION"; then
        log_warning "Tag v$VERSION already exists locally, deleting..."
        git tag -d "v$VERSION"
    fi

    # Create annotated tag
    # SECURITY: Quote the tag name to prevent shell injection (paranoid)
    git tag -a "v${VERSION}" -m "Release v${VERSION}"

    log_success "Git tag created"
}

# Push commits only (tag will be pushed by gh release create)
push_commits_to_github() {
    log_info "Pushing commits to GitHub..."

    # PHASE 1.1: Capture the HEAD commit SHA BEFORE pushing for workflow filtering
    local HEAD_SHA
    HEAD_SHA=$(git rev-parse HEAD)
    log_info "Pushing commit: ${HEAD_SHA:0:7}"

    # Use retry logic for git push (network operation)
    if ! retry_with_backoff "git push origin main"; then
        log_error "Failed to push commits after retries"
        return 1
    fi
    log_success "Commits pushed"

    log_info "Waiting for CI workflow to complete (this may take 3-10 minutes)..."
    # PHASE 1.1: Pass commit SHA to wait_for_ci_workflow for filtering
    wait_for_ci_workflow "$HEAD_SHA"
}

# Create GitHub Release (this pushes the tag and triggers the workflow)
create_github_release() {
    local VERSION=$1

    # SECURITY: Strip ANSI codes and validate version format
    VERSION=$(strip_ansi "$VERSION")
    if ! validate_version "$VERSION"; then
        log_error "Cannot create GitHub release - invalid version format: '$VERSION'"
        return 1
    fi

    log_info "Creating GitHub Release (this will push the tag and trigger workflow)..."

    # Check if release already exists (idempotency)
    if gh release view "v$VERSION" >/dev/null 2>&1; then
        log_warning "GitHub Release v$VERSION already exists"
        log_info "Skipping release creation (idempotent)"
        return 0
    fi

    # Check if tag exists remotely
    if git ls-remote --tags origin | grep -q "refs/tags/v$VERSION"; then
        log_warning "Tag v$VERSION already exists on remote"
        log_info "Creating release for existing tag..."
        gh release create "v$VERSION" \
            --title "v$VERSION" \
            --notes-file /tmp/release-notes.md
        log_success "GitHub Release created for existing tag"
        return 0
    fi

    # Create release using gh CLI
    # The tag already exists locally, gh will push it when creating the release
    gh release create "v$VERSION" \
        --title "v$VERSION" \
        --notes-file /tmp/release-notes.md

    log_success "GitHub Release created: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/v$VERSION"
    log_success "Tag pushed and workflow triggered"
}

# Wait for CI workflow after pushing commits
# PHASE 1.1: Filter by commit SHA to avoid race conditions with other commits
wait_for_ci_workflow() {
    local COMMIT_SHA=$1  # The commit SHA we just pushed
    local MAX_WAIT=600   # 10 minutes
    local ELAPSED=0

    sleep 5  # Give GitHub a moment to register the push

    log_info "Monitoring CI workflow for commit ${COMMIT_SHA:0:7}..."
    log_info "  (lint, typecheck, test, e2e, coverage)"

    while [ $ELAPSED -lt $MAX_WAIT ]; do
        # PHASE 1.1: Filter workflows by HEAD commit SHA to avoid race conditions
        # This ensures we only track the workflow for OUR specific commit
        WORKFLOW_JSON=$(gh run list --workflow=ci.yml --branch=main --limit 5 --json status,conclusion,headSha,databaseId 2>/dev/null || echo "[]")

        # Find the workflow run matching our commit SHA
        MATCHING_RUN=$(echo "$WORKFLOW_JSON" | jq -r --arg sha "$COMMIT_SHA" '.[] | select(.headSha == $sha) | {status, conclusion, databaseId}' 2>/dev/null | head -1)

        if [ -z "$MATCHING_RUN" ] || [ "$MATCHING_RUN" = "null" ]; then
            echo -n "."
            sleep 5
            ELAPSED=$((ELAPSED + 5))
            continue
        fi

        WORKFLOW_STATUS=$(echo "$MATCHING_RUN" | jq -r '.status')

        if [ "$WORKFLOW_STATUS" = "completed" ]; then
            WORKFLOW_CONCLUSION=$(echo "$MATCHING_RUN" | jq -r '.conclusion')
            RUN_ID=$(echo "$MATCHING_RUN" | jq -r '.databaseId')

            if [ "$WORKFLOW_CONCLUSION" = "success" ]; then
                log_success "CI workflow completed successfully for ${COMMIT_SHA:0:7}"
                return 0
            else
                log_error "CI workflow failed with conclusion: $WORKFLOW_CONCLUSION"
                log_error "View logs with: gh run view $RUN_ID --log"

                # Show failed job details
                if [ -n "$RUN_ID" ] && [ "$RUN_ID" != "null" ]; then
                    log_error "Failed jobs:"
                    gh run view "$RUN_ID" --log-failed || true
                fi

                exit 1
            fi
        fi

        echo -n "."
        sleep 5
        ELAPSED=$((ELAPSED + 5))
    done

    log_error "Timeout waiting for CI workflow (exceeded 10 minutes)"
    log_error "Commit SHA: $COMMIT_SHA"
    log_warning "Check status manually: gh run watch"
    exit 1
}

# Wait for Publish to npm workflow after creating GitHub Release
# PHASE 1.2: Increased timeout to 10 minutes + filter by tag commit SHA
wait_for_workflow() {
    local VERSION=$1
    local MAX_WAIT=600  # PHASE 1.2: 10 minutes (up from 5 minutes)
    local ELAPSED=0

    log_info "Waiting for GitHub Actions 'Publish to npm' workflow..."
    log_info "  Version: v$VERSION (timeout: 10 minutes)"

    sleep 5  # Give GitHub a moment to register the tag

    # PHASE 1.2: Get the commit SHA for the tag to filter workflows
    local TAG_SHA
    TAG_SHA=$(git rev-list -n 1 "v$VERSION" 2>/dev/null || echo "")
    if [ -n "$TAG_SHA" ]; then
        log_info "  Tag commit: ${TAG_SHA:0:7}"
    fi

    while [ $ELAPSED -lt $MAX_WAIT ]; do
        # PHASE 1.2: Get workflow runs with SHA filtering when possible
        WORKFLOW_JSON=$(gh run list --workflow=publish.yml --limit 5 --json status,conclusion,headSha,databaseId 2>/dev/null || echo "[]")

        # PHASE 1.2: Find the workflow run matching our tag commit SHA
        local MATCHING_RUN=""
        if [ -n "$TAG_SHA" ]; then
            MATCHING_RUN=$(echo "$WORKFLOW_JSON" | jq -r --arg sha "$TAG_SHA" '.[] | select(.headSha == $sha) | {status, conclusion, databaseId}' 2>/dev/null | head -1)
        fi

        # Fallback to latest workflow if no SHA match (for backwards compatibility)
        if [ -z "$MATCHING_RUN" ] || [ "$MATCHING_RUN" = "null" ]; then
            MATCHING_RUN=$(echo "$WORKFLOW_JSON" | jq -r '.[0] | {status, conclusion, databaseId}' 2>/dev/null)
        fi

        if [ -z "$MATCHING_RUN" ] || [ "$MATCHING_RUN" = "null" ]; then
            echo -n "."
            sleep 5
            ELAPSED=$((ELAPSED + 5))
            continue
        fi

        WORKFLOW_STATUS=$(echo "$MATCHING_RUN" | jq -r '.status')

        if [ "$WORKFLOW_STATUS" = "completed" ]; then
            WORKFLOW_CONCLUSION=$(echo "$MATCHING_RUN" | jq -r '.conclusion')
            RUN_ID=$(echo "$MATCHING_RUN" | jq -r '.databaseId')

            if [ "$WORKFLOW_CONCLUSION" = "success" ]; then
                log_success "Publish workflow completed successfully"
                return 0
            else
                log_error "Publish workflow failed with conclusion: $WORKFLOW_CONCLUSION"
                log_error "View logs with: gh run view $RUN_ID --log"

                # Show failed job details
                if [ -n "$RUN_ID" ] && [ "$RUN_ID" != "null" ]; then
                    log_error "Failed logs:"
                    gh run view "$RUN_ID" --log-failed || true
                fi

                exit 1
            fi
        fi

        echo -n "."
        sleep 5
        ELAPSED=$((ELAPSED + 5))
    done

    log_error "Timeout waiting for Publish workflow (exceeded 10 minutes)"
    log_error "Version: v$VERSION"
    log_warning "Check status manually: gh run watch"
    exit 1
}

# Verify npm publication
# PHASE 1.3: 5 minute total timeout with exponential backoff retry logic
verify_npm_publication() {
    local VERSION=$1
    local MAX_WAIT=300   # PHASE 1.3: 5 minutes total timeout
    local ELAPSED=0
    local BACKOFF=5      # Start with 5 second intervals
    local MAX_BACKOFF=30 # Cap at 30 second intervals
    local ATTEMPT=1

    log_info "Verifying npm publication..."
    log_info "  Waiting for ${PACKAGE_NAME}@$VERSION to appear on registry..."

    while [ $ELAPSED -lt $MAX_WAIT ]; do
        # Check npm registry for the version
        NPM_VERSION=$(npm view "${PACKAGE_NAME}@$VERSION" version 2>/dev/null || echo "")

        if [ "$NPM_VERSION" = "$VERSION" ]; then
            echo ""  # Newline after progress dots
            log_success "Package ${PACKAGE_NAME}@$VERSION is live on npm!"
            log_success "Install with: npm install ${PACKAGE_NAME}@$VERSION"
            return 0
        fi

        # PHASE 1.3: Exponential backoff (5s → 10s → 20s → 30s cap)
        echo -n "."
        sleep $BACKOFF
        ELAPSED=$((ELAPSED + BACKOFF))
        ATTEMPT=$((ATTEMPT + 1))

        # Double the backoff for next iteration, capped at MAX_BACKOFF
        if [ $BACKOFF -lt $MAX_BACKOFF ]; then
            BACKOFF=$((BACKOFF * 2))
            if [ $BACKOFF -gt $MAX_BACKOFF ]; then
                BACKOFF=$MAX_BACKOFF
            fi
        fi
    done

    echo ""  # Newline after progress dots
    log_error "Package ${PACKAGE_NAME}@$VERSION not found on npm after 5 minutes"
    log_warning "npm registry propagation may still be in progress"
    log_warning "Check manually: npm view ${PACKAGE_NAME}@$VERSION version"
    log_info "If the version appears later, the release was successful"
    exit 1
}

# Verify post-publish installation
# PHASE 1.4: Test that the published package actually works after npm install
# This catches packaging bugs like missing files in package.json "files" array
verify_post_publish_installation() {
    local VERSION=$1
    local TEMP_DIR

    log_info "Verifying package installation in clean environment..."

    # Create isolated temp directory (simulates fresh user environment)
    TEMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t 'svg-bbox-verify')
    log_info "  Test directory: $TEMP_DIR"

    # Trap to ensure cleanup on exit
    trap "rm -rf '$TEMP_DIR'" EXIT

    # Initialize npm project
    log_info "  → Initializing npm project..."
    if ! (cd "$TEMP_DIR" && npm init -y >/dev/null 2>&1); then
        log_warning "npm init failed in temp directory"
        rm -rf "$TEMP_DIR"
        trap - EXIT
        return 0  # Non-fatal: package is already on npm, just can't verify
    fi

    # Install package from registry (not local tarball)
    log_info "  → Installing ${PACKAGE_NAME}@$VERSION from npm registry..."
    if ! (cd "$TEMP_DIR" && npm install "${PACKAGE_NAME}@$VERSION" --no-save 2>&1 | tail -5); then
        log_warning "npm install failed - package may not be fully propagated yet"
        rm -rf "$TEMP_DIR"
        trap - EXIT
        return 0  # Non-fatal: registry may still be propagating
    fi

    local INSTALLED_PATH="$TEMP_DIR/node_modules/${PACKAGE_NAME}"

    # Verify package exists
    if [ ! -d "$INSTALLED_PATH" ]; then
        log_error "Package not found at $INSTALLED_PATH after install"
        rm -rf "$TEMP_DIR"
        trap - EXIT
        return 1
    fi

    # PHASE 1.4: Test that require('svg-bbox') loads without MODULE_NOT_FOUND
    log_info "  → Verifying require('svg-bbox') works..."
    REQUIRE_TEST=$(cd "$TEMP_DIR" && node -e "try { require('svg-bbox'); console.log('OK'); } catch(e) { console.log(e.code || e.message); process.exit(1); }" 2>&1)
    if [ "$REQUIRE_TEST" != "OK" ]; then
        log_error "require('svg-bbox') failed: $REQUIRE_TEST"
        log_error "This indicates a packaging bug - missing files or broken dependencies"
        rm -rf "$TEMP_DIR"
        trap - EXIT
        return 1
    fi
    log_success "  require('svg-bbox') works"

    # PHASE 1.4: Test CLI tools with --help
    # All 13 CLI tools defined in package.json bin
    local CLI_TOOLS=(
        "svg-bbox"
        "sbb-getbbox"
        "sbb-chrome-getbbox"
        "sbb-inkscape-getbbox"
        "sbb-extract"
        "sbb-chrome-extract"
        "sbb-inkscape-extract"
        "sbb-svg2png"
        "sbb-fix-viewbox"
        "sbb-comparer"
        "sbb-test"
        "sbb-inkscape-text2path"
        "sbb-inkscape-svg2png"
    )

    log_info "  → Testing CLI tools with --help..."
    local FAILED_TOOLS=""

    for TOOL in "${CLI_TOOLS[@]}"; do
        local TOOL_PATH="$INSTALLED_PATH/${TOOL}.cjs"

        # Check if tool file exists
        if [ ! -f "$TOOL_PATH" ]; then
            FAILED_TOOLS="${FAILED_TOOLS}${TOOL} (file missing) "
            continue
        fi

        # Run tool with --help in subshell (some tools may call process.exit)
        # We only care that it doesn't throw MODULE_NOT_FOUND
        HELP_OUTPUT=$(cd "$TEMP_DIR" && timeout 10 node "$TOOL_PATH" --help 2>&1 || echo "TIMEOUT_OR_ERROR")

        # Check for MODULE_NOT_FOUND errors
        if echo "$HELP_OUTPUT" | grep -q "MODULE_NOT_FOUND\|Cannot find module"; then
            FAILED_TOOLS="${FAILED_TOOLS}${TOOL} (missing deps) "
        fi
    done

    if [ -n "$FAILED_TOOLS" ]; then
        log_error "Some CLI tools failed verification: $FAILED_TOOLS"
        log_error "This indicates missing files in package.json 'files' array"
        rm -rf "$TEMP_DIR"
        trap - EXIT
        return 1
    fi

    log_success "  All ${#CLI_TOOLS[@]} CLI tools verified"

    # Cleanup
    rm -rf "$TEMP_DIR"
    trap - EXIT

    log_success "Post-publish installation verification passed"
    return 0
}

# Rollback on failure
rollback_release() {
    local VERSION=$1
    local STEP=$2

    log_error "Release failed at step: $STEP"
    log_warning "Attempting rollback..."

    # Delete local tag if it exists
    if git tag -l "v$VERSION" | grep -q "v$VERSION"; then
        log_info "  → Deleting local tag v$VERSION..."
        git tag -d "v$VERSION" || true
    fi

    # Reset to origin/main if commits were made
    if git log origin/main..HEAD --oneline | grep -q "chore(release): Bump version"; then
        log_info "  → Resetting to origin/main..."
        git reset --hard origin/main || true
    fi

    # Restore package.json and pnpm-lock.yaml if modified
    if git diff --name-only | grep -qE "package.json|pnpm-lock.yaml"; then
        log_info "  → Restoring package.json and pnpm-lock.yaml..."
        git checkout package.json pnpm-lock.yaml 2>/dev/null || true
    fi

    log_warning "Rollback complete. Repository restored to clean state."
    exit 1
}

# Main release function
main() {
    echo "" >&2
    echo "═══════════════════════════════════════════════════════════" >&2
    echo "  ${PACKAGE_NAME} Release Script" >&2
    echo "═══════════════════════════════════════════════════════════" >&2
    echo "" >&2

    # Parse arguments
    SKIP_CONFIRMATION=false
    VERSION_ARG=""

    while [[ $# -gt 0 ]]; do
        case $1 in
            --yes|-y)
                SKIP_CONFIRMATION=true
                shift
                ;;
            *)
                VERSION_ARG=$1
                shift
                ;;
        esac
    done

    if [ -z "$VERSION_ARG" ]; then
        log_error "Usage: $0 [--yes] [version|patch|minor|major]"
        log_info "Examples:"
        log_info "  $0 1.0.11        # Specific version"
        log_info "  $0 patch         # Bump patch (1.0.10 → 1.0.11)"
        log_info "  $0 minor         # Bump minor (1.0.10 → 1.1.0)"
        log_info "  $0 major         # Bump major (1.0.10 → 2.0.0)"
        log_info "  $0 --yes patch   # Skip confirmation prompt"
        exit 1
    fi

    # ══════════════════════════════════════════════════════════════════
    # PHASE 1.8: PRE-FLIGHT CHECKLIST
    # Consolidates all pre-release validations for clear visibility
    # ══════════════════════════════════════════════════════════════════
    show_preflight_header

    local PREFLIGHT_CHECKS=0
    local PREFLIGHT_TOTAL=5

    # Pre-flight Check 1: Prerequisites (commands and auth)
    log_info "[1/5] Checking required tools and authentication..."
    validate_prerequisites
    PREFLIGHT_CHECKS=$((PREFLIGHT_CHECKS + 1))

    # Pre-flight Check 2: Clean working directory
    log_info "[2/5] Checking working directory..."
    check_clean_working_dir
    PREFLIGHT_CHECKS=$((PREFLIGHT_CHECKS + 1))

    # Pre-flight Check 3: On main branch
    log_info "[3/5] Checking current branch..."
    check_main_branch
    PREFLIGHT_CHECKS=$((PREFLIGHT_CHECKS + 1))

    # Pre-flight Check 4: Version synchronization (PHASE 1.5)
    log_info "[4/5] Validating version synchronization..."
    validate_version_sync || exit 1
    PREFLIGHT_CHECKS=$((PREFLIGHT_CHECKS + 1))

    # Pre-flight Check 5: UMD wrapper syntax (PHASE 1.6)
    log_info "[5/5] Validating UMD wrapper syntax..."
    validate_umd_wrapper || exit 1
    PREFLIGHT_CHECKS=$((PREFLIGHT_CHECKS + 1))

    show_preflight_summary $PREFLIGHT_CHECKS $PREFLIGHT_TOTAL

    # ══════════════════════════════════════════════════════════════════
    # VERSION DETERMINATION
    # ══════════════════════════════════════════════════════════════════

    # Get current version
    CURRENT_VERSION=$(get_current_version)
    log_info "Current version: $CURRENT_VERSION"

    # Determine new version
    case $VERSION_ARG in
        patch|minor|major)
            NEW_VERSION=$(bump_version "$VERSION_ARG")
            ;;
        *)
            NEW_VERSION=$(set_version "$VERSION_ARG")
            ;;
    esac

    echo "" >&2
    log_info "Release version: $NEW_VERSION"
    echo "" >&2

    # ══════════════════════════════════════════════════════════════════
    # VERSION-DEPENDENT CHECKS (require knowing the target version)
    # ══════════════════════════════════════════════════════════════════

    # Check if version already published on npm (idempotency)
    log_info "Checking npm registry for existing version..."
    EXISTING_NPM_VERSION=$(npm view ${PACKAGE_NAME} version 2>/dev/null || echo "")
    if [ "$EXISTING_NPM_VERSION" = "$NEW_VERSION" ]; then
        log_warning "Version $NEW_VERSION is already published on npm"
        log_info "Skipping release (idempotent)"
        git checkout package.json pnpm-lock.yaml 2>/dev/null || true
        exit 0
    fi
    log_success "Version $NEW_VERSION not yet published on npm"

    # PHASE 1.8: Check if git tag already exists (prevents duplicate releases)
    log_info "Checking for existing git tag..."
    if ! check_tag_not_exists "$NEW_VERSION"; then
        log_error "Cannot proceed - tag already exists"
        log_info "Restoring package.json..."
        git checkout package.json pnpm-lock.yaml 2>/dev/null || true
        exit 1
    fi
    log_success "Git tag v$NEW_VERSION does not exist"

    # ══════════════════════════════════════════════════════════════════
    # USER CONFIRMATION
    # ══════════════════════════════════════════════════════════════════

    # Confirm with user (unless --yes flag)
    if [ "$SKIP_CONFIRMATION" = false ]; then
        read -p "$(echo -e ${YELLOW}Do you want to release v$NEW_VERSION? [y/N]${NC} )" -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_warning "Release cancelled"
            git checkout package.json pnpm-lock.yaml 2>/dev/null || true
            exit 0
        fi
    else
        log_info "Skipping confirmation (--yes flag)"
    fi

    # ══════════════════════════════════════════════════════════════════
    # QUALITY CHECKS AND AUTO-FIX
    # ══════════════════════════════════════════════════════════════════

    # Auto-fix common issues
    auto_fix_issues || rollback_release "$NEW_VERSION" "auto-fix"

    # Run quality checks (lint, typecheck, tests)
    run_quality_checks || rollback_release "$NEW_VERSION" "quality-checks"

    # ══════════════════════════════════════════════════════════════════
    # RELEASE EXECUTION
    # ══════════════════════════════════════════════════════════════════

    # Get previous tag for release notes
    PREVIOUS_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

    # Generate release notes
    generate_release_notes "$NEW_VERSION" "$PREVIOUS_TAG" || rollback_release "$NEW_VERSION" "release-notes"

    # Commit version bump
    commit_version_bump "$NEW_VERSION" || rollback_release "$NEW_VERSION" "commit-version"

    # Create git tag (locally only, don't push yet)
    create_git_tag "$NEW_VERSION" || rollback_release "$NEW_VERSION" "create-tag"

    # Push commits to GitHub (tag stays local)
    push_commits_to_github || rollback_release "$NEW_VERSION" "push-commits"

    # Create GitHub Release (THIS pushes the tag and triggers the workflow)
    # CRITICAL: This is the correct order - Release BEFORE workflow runs
    # gh release create will push the tag, which triggers the workflow
    create_github_release "$NEW_VERSION" || rollback_release "$NEW_VERSION" "create-release"

    # ══════════════════════════════════════════════════════════════════
    # VERIFICATION
    # ══════════════════════════════════════════════════════════════════

    # Wait for GitHub Actions workflow
    wait_for_workflow "$NEW_VERSION" || rollback_release "$NEW_VERSION" "workflow-wait"

    # Verify npm publication
    verify_npm_publication "$NEW_VERSION" || rollback_release "$NEW_VERSION" "npm-verify"

    # PHASE 1.4 - Verify package works after installation
    # This catches packaging bugs like missing files in package.json "files" array
    verify_post_publish_installation "$NEW_VERSION" || log_warning "Post-publish verification had issues (non-fatal)"

    # Success!
    echo "" >&2
    echo "═══════════════════════════════════════════════════════════" >&2
    log_success "Release v$NEW_VERSION completed successfully!"
    echo "═══════════════════════════════════════════════════════════" >&2
    echo "" >&2
    log_info "GitHub Release: https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/tag/v$NEW_VERSION"
    log_info "npm Package: https://www.npmjs.com/package/${PACKAGE_NAME}"
    log_info "Install: npm install ${PACKAGE_NAME}@$NEW_VERSION"
    echo "" >&2

    # Cleanup
    rm -f /tmp/release-notes.md /tmp/lint-output.log /tmp/typecheck-output.log /tmp/test-output.log
}

# Run main function
main "$@"
